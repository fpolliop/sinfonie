/**
 * The on-call agent: a deterministic watcher over Slack channels that groups messages into
 * incidents, and an LLM triage pass per incident that returns a structured report. Nothing is
 * posted to Slack without the user approving a proposal.
 */
import { claudeExecutableOption } from '../claude-cli'
import * as usage from '../usage'
import { defaultAccountId } from '../accounts'
import { app, BrowserWindow, Notification } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { nanoid } from 'nanoid'
import { query, type Options, type SDKMessage, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { getStore } from '../../store'
import * as slack from '../slack'
import { accountEnv } from '../accounts'
import * as resources from '../resources'
import { logError } from '../telemetry'
import type { Incident, IncidentStatus, OnCallSettings, OnCallState, Proposal, Severity, TriageReport } from '@shared/types'

/** One watcher: a space (or '' for the application config), its settings, and which Slack login serves it. */
interface Config {
  spaceId: string
  s: OnCallSettings
  connId: string
}

export const DEFAULT_ONCALL: OnCallSettings = { enabled: false, channels: [], pollSeconds: 60, maxTriagesPerHour: 12, context: '' }

interface Persisted {
  incidents: Incident[]
  cursors: Record<string, string>
}
let data: Persisted = { incidents: [], cursors: {} }
let loaded = false
let timer: NodeJS.Timeout | null = null
let polling = false
let lastPollAt: string | undefined
let lastError: string | undefined
const triageTimes: number[] = []
const triageQueue: string[] = []
let triaging: string | null = null
let emit: ((s: OnCallState) => void) | null = null
let openIncident: ((id: string) => void) | null = null

function file(): string {
  return join(app.getPath('userData'), 'oncall.json')
}
function load(): void {
  if (loaded) return
  loaded = true
  try {
    if (existsSync(file())) data = JSON.parse(readFileSync(file(), 'utf8')) as Persisted
  } catch (err) {
    logError('oncall:load', err)
  }
}
let saveTimer: NodeJS.Timeout | null = null
function save(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      writeFileSync(file(), JSON.stringify(data, null, 1))
    } catch (err) {
      logError('oncall:save', err)
    }
  }, 300)
}
/** Application defaults; per-space configs inherit the poll interval and the triage cap from here. */
export function settings(): OnCallSettings {
  return { ...DEFAULT_ONCALL, ...(getStore().get().settings.oncall ?? {}) }
}
function settingsFor(spaceId: string): OnCallSettings {
  const app = settings()
  if (!spaceId) return app
  const sp = getStore().get().spaces.find((x) => x.id === spaceId)
  return { ...DEFAULT_ONCALL, pollSeconds: app.pollSeconds, maxTriagesPerHour: app.maxTriagesPerHour, ...(sp?.oncall ?? {}) }
}
/** Every enabled config with a working Slack login and at least one channel. */
function configs(): Config[] {
  const { spaces } = getStore().get()
  const out: Config[] = []
  const app = settings()
  if (app.enabled && app.channels.length && slack.connection('').connected) out.push({ spaceId: '', s: app, connId: '' })
  for (const sp of spaces) {
    const s = settingsFor(sp.id)
    const connId = slack.connectionForSpace(sp.id)
    if (s.enabled && s.channels.length && slack.connection(connId).connected) out.push({ spaceId: sp.id, s, connId })
  }
  return out
}
let active: string[] = []
export function state(): OnCallState {
  load()
  const hourAgo = Date.now() - 3600_000
  return { running: Boolean(timer), activeSpaces: active, lastPollAt, lastError, incidents: data.incidents, triagesThisHour: triageTimes.filter((t) => t > hourAgo).length, triaging }
}
function publish(): void {
  save()
  emit?.(state())
}
export function setEmitters(onState: (s: OnCallState) => void, onOpen: (id: string) => void): void {
  emit = onState
  openIncident = onOpen
}

// ---------- lifecycle ----------

/** Start or stop according to settings; safe to call after every settings change. */
export function reconcile(): void {
  load()
  const cfgs = configs()
  active = cfgs.map((c) => c.spaceId)
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (cfgs.length) {
    const every = Math.max(15, Math.min(...cfgs.map((c) => c.s.pollSeconds)))
    timer = setInterval(() => void pollOnce(), every * 1000)
    void pollOnce()
  }
  publish()
}
export function stop(): void {
  if (timer) clearInterval(timer)
  timer = null
}

// ---------- polling ----------

const NOISE_SUBTYPES = new Set(['channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'bot_add', 'pinned_item'])
const titleOf = (text: string): string =>
  text
    .replace(/<[^>]+>/g, (m) => m.replace(/^<[@#!]?[^|>]*\|?/, '').replace(/>$/, ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || '(no text)'

export async function pollOnce(): Promise<void> {
  if (polling) return
  polling = true
  load()
  try {
    for (const cfg of configs()) {
      const { spaceId, s, connId } = cfg
      const me = slack.connection(connId).userId
      for (const ch of s.channels) {
        const ck = `${spaceId}|${ch.id}`
        const cursor = data.cursors[ck]
        if (!cursor) {
          // First run: remember where we are; do not backfill history into incidents.
          const recent = await slack.history(connId, ch.id)
          data.cursors[ck] = recent[recent.length - 1]?.ts ?? String(Date.now() / 1000)
          continue
        }
        const msgs = await slack.history(connId, ch.id, cursor)
        for (const m of msgs) {
          data.cursors[ck] = m.ts
          if (m.subtype && NOISE_SUBTYPES.has(m.subtype)) continue
          if (m.thread_ts && m.thread_ts !== m.ts) continue // replies are picked up per incident below
          if (ch.kind === 'support' && m.user && m.user === me) continue // the user's own posts are not tickets
          if (ch.kind === 'alerts' && /(resolved|recovered|closed|\bok\b)/i.test(m.text) && resolveAlert(ch.id, m.text)) continue
          const inc: Incident = {
            id: nanoid(10),
            spaceId,
            source: 'slack',
            channelId: ch.id,
            channelName: ch.name,
            kind: ch.kind,
            threadTs: m.ts,
            permalink: await slack.permalink(connId, ch.id, m.ts),
            title: titleOf(m.text),
            messages: [{ ts: m.ts, user: m.user ?? m.bot_id ?? 'unknown', userName: m.username ?? (await slack.userName(connId, m.user)), text: m.text }],
            status: 'new',
            severity: ch.kind === 'alerts' ? (/critical|sev1|p1|down|outage/i.test(m.text) ? 'critical' : /error|fail|high|sev2|p2/i.test(m.text) ? 'high' : 'medium') : undefined,
            proposals: [],
            notes: [],
            costUsd: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
          data.incidents.unshift(inc)
          notify(`New in #${ch.name}`, inc.title, inc.id)
          enqueueTriage(inc.id)
        }
      }
    }
    // Follow threads of incidents that are still live.
    for (const inc of data.incidents.filter((i) => i.status !== 'resolved' && i.status !== 'dismissed').slice(0, 40)) {
      const connId = slack.connectionForSpace(inc.spaceId)
      const me = slack.connection(connId).userId
      const last = inc.messages[inc.messages.length - 1]?.ts ?? inc.threadTs
      const news = await slack.replies(connId, inc.channelId, inc.threadTs, last).catch(() => [] as slack.SlackMessage[])
      if (!news.length) continue
      for (const m of news) inc.messages.push({ ts: m.ts, user: m.user ?? m.bot_id ?? 'unknown', userName: m.username ?? (await slack.userName(connId, m.user)), text: m.text })
      inc.updatedAt = new Date().toISOString()
      if (news.some((m) => m.user !== me)) {
        if (inc.status === 'waiting') inc.status = 'open'
        inc.notes.push({ at: new Date().toISOString(), role: 'system', text: `${news.length} new repl${news.length === 1 ? 'y' : 'ies'} in the thread.` })
        if (inc.kind === 'support') notify(`Reply in #${inc.channelName}`, news[news.length - 1].text.slice(0, 120), inc.id)
      }
    }
    if (data.incidents.length > 500) data.incidents.length = 500
    lastPollAt = new Date().toISOString()
    lastError = undefined
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    logError('oncall:poll', err)
  } finally {
    polling = false
    publish()
  }
}

/** An alert "resolved" message closes the newest open alert incident with a similar title. */
function resolveAlert(channelId: string, text: string): boolean {
  const norm = (t: string): string =>
    t
      .replace(/(firing|resolved|recovered|closed|alert|\bok\b)/gi, '')
      .replace(/[^a-z0-9]+/gi, ' ')
      .trim()
      .toLowerCase()
  const key = norm(titleOf(text)).split(' ').filter(Boolean).slice(0, 3).join(' ')
  if (!key) return false
  const inc = data.incidents.find((i) => i.channelId === channelId && i.kind === 'alerts' && i.status !== 'resolved' && i.status !== 'dismissed' && norm(i.title).includes(key))
  if (!inc) return false
  inc.status = 'resolved'
  inc.updatedAt = new Date().toISOString()
  inc.notes.push({ at: new Date().toISOString(), role: 'system', text: `Resolved by alert message: ${titleOf(text)}` })
  return true
}

function notify(title: string, body: string, incidentId: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: `Sinfonie on call: ${title}`, body: body.slice(0, 200) })
  n.on('click', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    openIncident?.(incidentId)
  })
  n.show()
}

// ---------- triage ----------

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'severity', 'category', 'likelyCause', 'evidence', 'nextSteps', 'needsHuman', 'confidence'],
  properties: {
    summary: { type: 'string', description: 'One or two sentences: what is going on, for the on-call engineer.' },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    category: { type: 'string', enum: ['customer', 'bug', 'infra', 'question', 'noise'] },
    likelyCause: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'Facts you verified: file paths, log lines, thread quotes.' },
    nextSteps: { type: 'array', items: { type: 'string' } },
    customerReply: { type: 'string', description: 'A short reply to post in the thread, only when a reply is appropriate. Plain Slack text.' },
    needsHuman: { type: 'boolean' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
  }
}

export function enqueueTriage(id: string): void {
  if (!triageQueue.includes(id)) triageQueue.push(id)
  void drain()
}
async function drain(): Promise<void> {
  if (triaging) return
  const s = settings()
  while (triageQueue.length) {
    const hourAgo = Date.now() - 3600_000
    if (triageTimes.filter((t) => t > hourAgo).length >= s.maxTriagesPerHour) {
      lastError = `Triage paused: ${s.maxTriagesPerHour} runs in the last hour (limit under Application, On call).`
      publish()
      setTimeout(() => void drain(), 5 * 60_000)
      return
    }
    const id = triageQueue.shift()!
    const inc = data.incidents.find((i) => i.id === id)
    if (!inc) continue
    triaging = id
    inc.status = 'triaging'
    publish()
    triageTimes.push(Date.now())
    try {
      await triage(inc)
    } catch (err) {
      inc.error = err instanceof Error ? err.message : String(err)
      inc.status = 'open'
      logError('oncall:triage', err, { incident: inc.id })
    } finally {
      triaging = null
      inc.updatedAt = new Date().toISOString()
      publish()
    }
  }
}

function contextDirs(spaceId: string): string[] {
  const { spaces, repos } = getStore().get()
  const s = settingsFor(spaceId)
  const space = spaces.find((x) => x.id === (spaceId || s.spaceId))
  return repos.filter((r) => (space ? r.spaceId === space.id : true)).map((r) => r.path)
}
function workDir(): string {
  const d = join(app.getPath('userData'), 'oncall-work')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function threadText(inc: Incident): string {
  return inc.messages.map((m) => `[${new Date(Number(m.ts) * 1000).toISOString()}] ${m.userName ?? m.user}: ${m.text}`).join('\n')
}

async function runAgent(spaceId: string, prompt: string, opts: { schema?: Record<string, unknown>; maxTurns: number }): Promise<{ text: string; structured?: unknown; costUsd: number }> {
  const s = settingsFor(spaceId)
  const dirs = contextDirs(spaceId)
  let mcpServers: Options['mcpServers'] = {}
  try {
    mcpServers = { slack: await slack.mcpServerConfig(slack.connectionForSpace(spaceId)) }
  } catch (err) {
    console.warn('[oncall] slack mcp unavailable', err)
  }
  const options: Options = {
    ...claudeExecutableOption(),
    cwd: workDir(),
    additionalDirectories: dirs,
    permissionMode: 'plan',
    maxTurns: opts.maxTurns,
    ...(s.model ? { model: s.model } : {}),
    ...(opts.schema ? { outputFormat: { type: 'json_schema', schema: opts.schema } } : {}),
    allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'mcp__slack__*'],
    disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent', 'Task'],
    mcpServers,
    strictMcpConfig: true,
    settingSources: [],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: [
        'You are the on-call engineer assistant inside Sinfonie. You investigate, you do not change anything: no file edits, no commands, no Slack posts. Suggested replies go in the customerReply field and a human sends them.',
        dirs.length ? `Source code of the services is available read-only at: ${dirs.join(', ')}. Use it to trace stack traces, find owners of a feature, and check recent behaviour.` : 'No source code is attached; reason from the thread and Slack history.',
        'The Slack MCP server lets you read more of the channel and search other threads for similar issues; use it when the thread alone is not enough.',
        s.context ? `Team context from the user:\n${s.context}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    },
    env: { ...process.env, ...accountEnv(s.claudeAccountId) },
    spawnClaudeCodeProcess: (o) => {
      const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal })
      resources.registerProcess(child.pid, { kind: 'agent', label: 'On call' })
      child.once('exit', () => resources.unregisterProcess(child.pid))
      child.stderr?.on('data', (d: Buffer) => console.error('[oncall agent]', d.toString().trimEnd()))
      return child as unknown as SpawnedProcess
    }
  }
  let text = ''
  let structured: unknown
  let costUsd = 0
  for await (const msg of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
    if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'text') text = b.text
    if (msg.type === 'result') {
      costUsd = msg.total_cost_usd
      try {
        usage.recordTurn(usage.fromResult(msg, { workspaceId: '', spaceId, accountId: s.claudeAccountId ?? defaultAccountId('anthropic') ?? 'default', kind: 'oncall' }))
      } catch {
        /* ledger must never break triage */
      }
      structured = (msg as { structured_output?: unknown }).structured_output
      if (msg.subtype !== 'success') throw new Error(`Triage run ended with ${msg.subtype.replace(/_/g, ' ')}${'errors' in msg && Array.isArray(msg.errors) ? `: ${(msg.errors as string[]).join('; ')}` : ''}`)
    }
  }
  return { text, structured, costUsd }
}

async function triage(inc: Incident): Promise<void> {
  const prompt = [
    `Triage this ${inc.kind === 'alerts' ? 'alert' : 'support request'} from Slack #${inc.channelName}${inc.permalink ? ` (${inc.permalink})` : ''}.`,
    '',
    'Thread so far:',
    threadText(inc),
    '',
    'Decide severity and category, find the likely cause (check the code when a feature or error is named), list evidence you actually verified, and propose next steps for the on-call engineer.',
    inc.kind === 'support' ? 'If a reply to the requester is appropriate now, draft it in customerReply: short, friendly, factual, no promises about timelines. Leave it empty when a human should answer first.' : 'For alerts, customerReply stays empty.',
    'Return the structured result.'
  ].join('\n')
  const r = await runAgent(inc.spaceId, prompt, { schema: TRIAGE_SCHEMA, maxTurns: 30 })
  const report = (r.structured ?? tryParse(r.text)) as TriageReport | undefined
  inc.costUsd += r.costUsd
  inc.triagedAt = new Date().toISOString()
  if (!report || typeof report.summary !== 'string') {
    inc.status = 'open'
    inc.notes.push({ at: new Date().toISOString(), role: 'agent', text: r.text || 'The triage run returned no report.' })
    return
  }
  inc.report = report
  inc.severity = report.severity
  inc.error = undefined
  if (report.customerReply && report.customerReply.trim() && inc.kind === 'support') {
    inc.proposals.push({ id: nanoid(8), kind: 'slack_reply', channelId: inc.channelId, threadTs: inc.threadTs, text: report.customerReply.trim(), status: 'proposed', createdAt: new Date().toISOString() })
  }
  inc.status = report.category === 'noise' ? 'dismissed' : 'open'
  if (report.severity === 'high' || report.severity === 'critical') notify(`${report.severity} in #${inc.channelName}`, report.summary, inc.id)
}
function tryParse(text: string): unknown {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return undefined
  try {
    return JSON.parse(m[0])
  } catch {
    return undefined
  }
}

// ---------- user actions ----------

function find(id: string): Incident {
  load()
  const inc = data.incidents.find((i) => i.id === id)
  if (!inc) throw new Error('Incident not found')
  return inc
}
export function setStatus(id: string, status: IncidentStatus): Incident {
  const inc = find(id)
  inc.status = status
  inc.updatedAt = new Date().toISOString()
  publish()
  return inc
}
export function setSeverity(id: string, severity: Severity): Incident {
  const inc = find(id)
  inc.severity = severity
  publish()
  return inc
}
export async function approve(id: string, proposalId: string, text?: string): Promise<Incident> {
  const inc = find(id)
  const p = inc.proposals.find((x) => x.id === proposalId)
  if (!p) throw new Error('Proposal not found')
  const body = (text ?? p.text).trim()
  if (!body) throw new Error('Nothing to send')
  p.text = body
  const connId = slack.connectionForSpace(inc.spaceId)
  await slack.post(connId, p.channelId, body, p.threadTs)
  p.status = 'sent'
  p.sentAt = new Date().toISOString()
  inc.messages.push({ ts: String(Date.now() / 1000), user: slack.connection(connId).userId ?? 'me', userName: slack.connection(connId).userName ?? 'you', text: body })
  if (inc.status === 'open' || inc.status === 'new') inc.status = 'waiting'
  inc.updatedAt = new Date().toISOString()
  publish()
  return inc
}
export function dismissProposal(id: string, proposalId: string): Incident {
  const inc = find(id)
  const p = inc.proposals.find((x) => x.id === proposalId)
  if (p) p.status = 'dismissed'
  publish()
  return inc
}
/** A follow-up question about an incident, answered with the same read-only setup. */
export async function ask(id: string, question: string): Promise<Incident> {
  const inc = find(id)
  inc.notes.push({ at: new Date().toISOString(), role: 'user', text: question })
  publish()
  const prompt = [
    `Incident from Slack #${inc.channelName}: ${inc.title}`,
    '',
    'Thread:',
    threadText(inc),
    '',
    inc.report ? `Your earlier triage: ${JSON.stringify(inc.report)}` : '',
    '',
    `The on-call engineer asks: ${question}`,
    'Answer concisely in markdown. If you propose a Slack reply, put it in a fenced block labelled reply.'
  ].join('\n')
  try {
    const r = await runAgent(inc.spaceId, prompt, { maxTurns: 25 })
    inc.costUsd += r.costUsd
    inc.notes.push({ at: new Date().toISOString(), role: 'agent', text: r.text || '(no answer)' })
    const reply = /```reply\n([\s\S]*?)```/.exec(r.text)?.[1]?.trim()
    if (reply && inc.kind === 'support') inc.proposals.push({ id: nanoid(8), kind: 'slack_reply', channelId: inc.channelId, threadTs: inc.threadTs, text: reply, status: 'proposed', createdAt: new Date().toISOString() })
  } catch (err) {
    inc.notes.push({ at: new Date().toISOString(), role: 'system', text: `The question failed: ${err instanceof Error ? err.message : String(err)}` })
  }
  inc.updatedAt = new Date().toISOString()
  publish()
  return inc
}
export function addProposal(id: string, text: string): Incident {
  const inc = find(id)
  const p: Proposal = { id: nanoid(8), kind: 'slack_reply', channelId: inc.channelId, threadTs: inc.threadTs, text, status: 'proposed', createdAt: new Date().toISOString() }
  inc.proposals.push(p)
  publish()
  return inc
}
export function remove(id: string): void {
  load()
  data.incidents = data.incidents.filter((i) => i.id !== id)
  publish()
}
