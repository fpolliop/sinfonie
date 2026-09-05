/**
 * Usage ledger and subscription-limit tracking. Every agent turn is appended to usage.jsonl;
 * Claude Code's rate-limit events are kept per account with a short history, so the app can show
 * how full each window is, project when it runs out, and warn before a task starts on fumes.
 */
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getStore } from '../store'
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { LimitType, UsageAccount, UsageDay, UsageLimit, UsageSnapshot, UsageTurn } from '@shared/types'

interface LimitRec extends UsageLimit {
  samples: [number, number][] // [epoch ms, utilization]
}
interface State {
  limits: Record<string, Partial<Record<LimitType, LimitRec>>>
  contextTokens: Record<string, number>
  /** "accountId|type|resetsAt" the user chose to proceed past. */
  acks: string[]
}
let state: State = { limits: {}, contextTokens: {}, acks: [] }
let turns: UsageTurn[] = []
let loaded = false
let emit: ((s: UsageSnapshot) => void) | null = null
let saveTimer: NodeJS.Timeout | null = null

const dir = (): string => app.getPath('userData')
const ledgerPath = (): string => join(dir(), 'usage.jsonl')
const statePath = (): string => join(dir(), 'usage-state.json')

function load(): void {
  if (loaded) return
  loaded = true
  try {
    if (existsSync(statePath())) state = { ...state, ...(JSON.parse(readFileSync(statePath(), 'utf8')) as State) }
  } catch {
    /* start clean */
  }
  try {
    if (existsSync(ledgerPath())) {
      const cutoff = Date.now() - 45 * 86400_000
      turns = readFileSync(ledgerPath(), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as UsageTurn
          } catch {
            return null
          }
        })
        .filter((t): t is UsageTurn => Boolean(t) && new Date(t!.at).getTime() > cutoff)
    }
  } catch {
    turns = []
  }
}
function save(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      if (!existsSync(dir())) mkdirSync(dir(), { recursive: true })
      writeFileSync(statePath(), JSON.stringify(state))
    } catch {
      /* not fatal */
    }
  }, 500)
}
function publish(): void {
  save()
  emit?.(snapshot())
}
export function setEmitter(fn: (s: UsageSnapshot) => void): void {
  emit = fn
}
export function settings(): { warnAtPct: number; contextWarnTokens: number } {
  const u = getStore().get().settings.usage
  return { warnAtPct: u?.warnAtPct ?? 85, contextWarnTokens: u?.contextWarnTokens ?? 120_000 }
}

// ---------- turns ----------

export function recordTurn(t: UsageTurn): void {
  load()
  turns.push(t)
  try {
    appendFileSync(ledgerPath(), JSON.stringify(t) + '\n')
  } catch {
    /* not fatal */
  }
  publish()
}

/** Build a ledger entry from an SDK result. `previous` lets streaming sessions record per-turn deltas of the cumulative totals. */
export function fromResult(msg: SDKResultMessage, ctx: { workspaceId: string; spaceId: string; accountId: string; kind: UsageTurn['kind']; engine?: string }, previous?: Record<string, { costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>): UsageTurn {
  const byModel: UsageTurn['byModel'] = []
  for (const [model, u] of Object.entries(msg.modelUsage ?? {})) {
    const p = previous?.[model]
    const cur = { costUsd: u.costUSD, inputTokens: u.inputTokens + u.cacheCreationInputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadInputTokens }
    const d = p ? { costUsd: Math.max(0, cur.costUsd - p.costUsd), inputTokens: Math.max(0, cur.inputTokens - p.inputTokens), outputTokens: Math.max(0, cur.outputTokens - p.outputTokens), cacheReadTokens: Math.max(0, cur.cacheReadTokens - p.cacheReadTokens) } : cur
    if (previous) previous[model] = cur
    if (d.costUsd > 0 || d.outputTokens > 0 || d.inputTokens > 0) byModel.push({ model, ...d })
  }
  return {
    at: new Date().toISOString(),
    workspaceId: ctx.workspaceId,
    spaceId: ctx.spaceId,
    accountId: ctx.accountId,
    engine: ctx.engine ?? 'claude-code',
    kind: ctx.kind,
    costUsd: byModel.reduce((n, m) => n + m.costUsd, 0),
    inputTokens: byModel.reduce((n, m) => n + m.inputTokens, 0),
    outputTokens: byModel.reduce((n, m) => n + m.outputTokens, 0),
    cacheReadTokens: byModel.reduce((n, m) => n + m.cacheReadTokens, 0),
    durationMs: msg.duration_ms,
    byModel
  }
}

// ---------- limits ----------

export function recordLimit(accountId: string, info: { rateLimitType?: LimitType; utilization?: number; status: UsageLimit['status']; resetsAt?: number }): void {
  load()
  const type = info.rateLimitType ?? 'five_hour'
  if (info.utilization == null && info.status !== 'rejected') return
  const now = Date.now()
  const acct = (state.limits[accountId] ??= {})
  const prev = acct[type]
  const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : prev?.resetsAt
  // A new window resets the sample history.
  const samples = prev && prev.resetsAt === resetsAt ? prev.samples.filter(([t]) => now - t < 4 * 3600_000) : []
  const utilization = info.status === 'rejected' ? 1 : (info.utilization ?? prev?.utilization ?? 0)
  samples.push([now, utilization])
  acct[type] = { type, utilization, status: info.status, resetsAt, at: new Date(now).toISOString(), samples: samples.slice(-200), projectedExhaustAt: project(samples, utilization, resetsAt) }
  publish()
}
/** Linear projection over the last two hours of samples; undefined when flat or already past the reset. */
function project(samples: [number, number][], utilization: number, resetsAt?: string): string | undefined {
  const recent = samples.filter(([t]) => Date.now() - t < 2 * 3600_000)
  if (recent.length < 2 || utilization >= 1) return utilization >= 1 ? new Date().toISOString() : undefined
  const [t0, u0] = recent[0]
  const [t1, u1] = recent[recent.length - 1]
  if (t1 <= t0 || u1 <= u0) return undefined
  const slope = (u1 - u0) / (t1 - t0) // per ms
  const eta = t1 + (1 - u1) / slope
  if (resetsAt && eta > new Date(resetsAt).getTime()) return undefined
  return new Date(eta).toISOString()
}
export function recordContext(workspaceId: string, tokens: number): void {
  load()
  state.contextTokens[workspaceId] = tokens
  publish()
}
export function ack(accountId: string, type: LimitType, resetsAt?: string): void {
  load()
  state.acks.push(`${accountId}|${type}|${resetsAt ?? ''}`)
  state.acks = state.acks.slice(-50)
  save()
}

/** The fullest still-current window of an account, when it is over the warning threshold and not yet acknowledged. */
export function riskyLimit(accountId: string): UsageLimit | null {
  load()
  const { warnAtPct } = settings()
  const now = Date.now()
  const limits = Object.values(state.limits[accountId] ?? {}).filter((l): l is LimitRec => Boolean(l))
  const live = limits.filter((l) => now - new Date(l.at).getTime() < 6 * 3600_000 && (!l.resetsAt || new Date(l.resetsAt).getTime() > now))
  const worst = live.sort((a, b) => b.utilization - a.utilization)[0]
  if (!worst || worst.utilization * 100 < warnAtPct) return null
  if (state.acks.includes(`${accountId}|${worst.type}|${worst.resetsAt ?? ''}`)) return null
  const { samples: _s, ...pub } = worst
  void _s
  return pub
}

// ---------- snapshot ----------

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}
export function snapshot(): UsageSnapshot {
  load()
  const { settings: s } = getStore().get()
  const accounts: UsageAccount[] = s.claudeAccounts
    .filter((a) => (a.vendor ?? 'anthropic') === 'anthropic')
    .map((a) => ({
      accountId: a.id,
      name: a.name,
      limits: Object.values(state.limits[a.id] ?? {})
        .filter((l): l is LimitRec => Boolean(l))
        .map(({ samples: _x, ...pub }) => (void _x, pub))
        .sort((x, y) => y.utilization - x.utilization)
    }))
  const days = new Map<string, UsageDay>()
  const cutoff = Date.now() - 30 * 86400_000
  for (const t of turns) {
    if (new Date(t.at).getTime() < cutoff) continue
    const k = dayKey(t.at)
    const d = days.get(k) ?? { day: k, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, byModel: {}, bySpace: {}, byWorkspace: {}, byKind: {} }
    d.costUsd += t.costUsd
    d.inputTokens += t.inputTokens
    d.outputTokens += t.outputTokens
    d.turns++
    for (const m of t.byModel) d.byModel[m.model] = (d.byModel[m.model] ?? 0) + m.costUsd
    d.bySpace[t.spaceId] = (d.bySpace[t.spaceId] ?? 0) + t.costUsd
    d.byWorkspace[t.workspaceId] = (d.byWorkspace[t.workspaceId] ?? 0) + t.costUsd
    d.byKind[t.kind] = (d.byKind[t.kind] ?? 0) + t.costUsd
    days.set(k, d)
  }
  const todayKey = dayKey(new Date().toISOString())
  const today = days.get(todayKey) ?? { day: todayKey, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, byModel: {}, bySpace: {}, byWorkspace: {}, byKind: {} }
  const top = Object.entries(today.byWorkspace)
    .map(([workspaceId, costUsd]) => ({ workspaceId, costUsd, turns: turns.filter((t) => t.workspaceId === workspaceId && dayKey(t.at) === todayKey).length }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 8)
  return { accounts, days: Array.from(days.values()).sort((a, b) => a.day.localeCompare(b.day)), today, topWorkspaces: top, contextTokens: state.contextTokens, warnAtPct: settings().warnAtPct, contextWarnTokens: settings().contextWarnTokens }
}
