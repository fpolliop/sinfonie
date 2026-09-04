/**
 * Resource governor: measures what Sinfonie's process tree costs the Mac, attributes it to
 * workspaces, and enforces the limits the user set. Deterministic and cheap (one `ps` every
 * few seconds), so it reacts before a swap storm rather than after.
 */
import { execFile } from 'child_process'
import os from 'os'
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getStore } from '../store'
import type { PressureLevel, ResourceSettings, ResourceSnapshot, ResourceTask, ResourceSession } from '@shared/types'

export const DEFAULT_RESOURCES: Required<ResourceSettings> = { governor: 'enforce', maxSubagentsPerSession: 4, maxActiveSessions: 6, memoryBudgetPct: 60, stopSubagentsOnCritical: true }

export function resourceSettings(): Required<ResourceSettings> {
  return { ...DEFAULT_RESOURCES, ...(getStore().get().settings.resources ?? {}) }
}

export type ProcKind = 'agent' | 'terminal' | 'tool'
interface Proc {
  pid: number
  kind: ProcKind
  workspaceId?: string
  label?: string
}

const procs = new Map<number, Proc>()
const tasks = new Map<string, Map<string, ResourceTask>>()
/** Messages waiting for a free session slot, in arrival order. */
const parked: { workspaceId: string; text: string }[] = []

function workspaceForCwd(cwd?: string): string | undefined {
  if (!cwd) return undefined
  const ws = getStore().get().workspaces.find((w) => w.rootPath && (cwd === w.rootPath || cwd.startsWith(w.rootPath + '/')))
  return ws?.id
}

/** Track a process Sinfonie spawned. Its whole subtree (MCP servers, test runners…) is charged to the workspace. */
export function registerProcess(pid: number | undefined, info: { kind: ProcKind; workspaceId?: string; cwd?: string; label?: string }): void {
  if (!pid) return
  procs.set(pid, { pid, kind: info.kind, workspaceId: info.workspaceId ?? workspaceForCwd(info.cwd), label: info.label })
}
export function unregisterProcess(pid: number | undefined): void {
  if (pid) procs.delete(pid)
}

export function taskStarted(workspaceId: string, t: ResourceTask): void {
  let m = tasks.get(workspaceId)
  if (!m) tasks.set(workspaceId, (m = new Map()))
  m.set(t.taskId, t)
}
export function taskEnded(workspaceId: string, taskId: string): void {
  tasks.get(workspaceId)?.delete(taskId)
}
export function clearWorkspace(workspaceId: string): void {
  tasks.delete(workspaceId)
  for (const p of Array.from(procs.values())) if (p.workspaceId === workspaceId && p.kind === 'agent') procs.delete(p.pid)
}
export function runningTasks(workspaceId: string): ResourceTask[] {
  return Array.from(tasks.get(workspaceId)?.values() ?? [])
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/**
 * Why a new subagent must not start right now, or null when it may. The reason is written for
 * the model: it lands in the tool result so the orchestrator can adapt instead of retrying.
 */
export function delegationVeto(workspaceId: string): string | null {
  const s = resourceSettings()
  if (s.governor === 'off') return null
  const running = runningTasks(workspaceId).length
  if (running >= s.maxSubagentsPerSession) return `${running} subagent${running === 1 ? ' is' : 's are'} already running in this session (limit ${s.maxSubagentsPerSession}). Wait for one to finish before delegating again, or do the work yourself.`
  if (s.governor === 'enforce' && snapshot.level !== 'normal') return `the Mac is under memory pressure (Sinfonie is using ${gb(snapshot.appRss)} of its ${gb(snapshot.budget)} budget; macOS reports ${snapshot.osPressure}). Do the work yourself or wait for running subagents to finish; no new subagents start until pressure eases.`
  return null
}

// ---------- sampling ----------

let snapshot: ResourceSnapshot = { at: new Date().toISOString(), level: 'normal', osPressure: 'normal', totalMem: os.totalmem(), budget: 0, appRss: 0, swapUsed: 0, sessions: [], terminalsRss: 0, otherRss: 0, waiting: [] }
export function current(): ResourceSnapshot {
  return snapshot
}

interface Hooks {
  emit: (s: ResourceSnapshot) => void
  notice: (workspaceId: string, level: 'info' | 'warn' | 'error', text: string) => void
  stopTask: (workspaceId: string, taskId: string) => Promise<void>
  send: (workspaceId: string, text: string) => Promise<void>
  busyCount: () => number
  isBusy: (workspaceId: string) => boolean
}
let hooks: Hooks | null = null
let timer: NodeJS.Timeout | null = null
let lastLogAt = 0
let warnedLevel: PressureLevel = 'normal'

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 4000 }, (err, out) => resolve(err ? '' : String(out))))
}

async function sample(): Promise<void> {
  const [ps, pressure, swap] = await Promise.all([sh('ps', ['-axo', 'pid=,ppid=,rss=']), sh('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']), sh('sysctl', ['-n', 'vm.swapusage'])])
  const rss = new Map<number, number>()
  const children = new Map<number, number[]>()
  for (const line of ps.split('\n')) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number)
    if (!pid) continue
    rss.set(pid, (kb || 0) * 1024)
    const list = children.get(ppid)
    if (list) list.push(pid)
    else children.set(ppid, [pid])
  }
  const subtree = (pid: number): { bytes: number; count: number } => {
    let bytes = 0
    let count = 0
    const stack = [pid]
    while (stack.length) {
      const p = stack.pop()!
      if (!rss.has(p)) continue
      bytes += rss.get(p)!
      count++
      for (const c of children.get(p) ?? []) stack.push(c)
    }
    return { bytes, count }
  }
  for (const p of Array.from(procs.values())) if (!rss.has(p.pid)) procs.delete(p.pid)

  const app = subtree(process.pid)
  const s = resourceSettings()
  const totalMem = os.totalmem()
  const budget = (totalMem * s.memoryBudgetPct) / 100
  const osLevel: PressureLevel = pressure.trim() === '4' ? 'critical' : pressure.trim() === '2' ? 'warn' : 'normal'
  const swapUsed = (() => {
    const m = /used = ([\d.]+)([MG])/.exec(swap)
    return m ? Number(m[1]) * (m[2] === 'G' ? 1024 ** 3 : 1024 ** 2) : 0
  })()
  const level: PressureLevel = osLevel === 'critical' || app.bytes > budget ? 'critical' : osLevel === 'warn' || app.bytes > budget * 0.8 ? 'warn' : 'normal'

  const byWs = new Map<string, ResourceSession>()
  let terminalsRss = 0
  let attributed = 0
  for (const p of procs.values()) {
    const t = subtree(p.pid)
    attributed += t.bytes
    if (p.kind === 'terminal' && !p.workspaceId) {
      terminalsRss += t.bytes
      continue
    }
    const id = p.workspaceId ?? ''
    if (!id) continue
    const row = byWs.get(id) ?? { workspaceId: id, rss: 0, procs: 0, terminalsRss: 0, tasks: [], busy: false }
    if (p.kind === 'terminal') row.terminalsRss += t.bytes
    else row.rss += t.bytes
    row.procs += t.count
    byWs.set(id, row)
  }
  for (const [id, list] of tasks) {
    if (list.size === 0) continue
    const row = byWs.get(id) ?? { workspaceId: id, rss: 0, procs: 0, terminalsRss: 0, tasks: [], busy: false }
    row.tasks = Array.from(list.values())
    byWs.set(id, row)
  }
  for (const row of byWs.values()) row.busy = hooks?.isBusy(row.workspaceId) ?? false

  snapshot = {
    at: new Date().toISOString(),
    level,
    osPressure: osLevel,
    totalMem,
    budget,
    appRss: app.bytes,
    swapUsed,
    sessions: Array.from(byWs.values()).sort((a, b) => b.rss - a.rss),
    terminalsRss,
    otherRss: Math.max(0, app.bytes - attributed),
    waiting: parked.map((p) => p.workspaceId)
  }
  hooks?.emit(snapshot)
  govern(level)
  const now = Date.now()
  if (now - lastLogAt > 30_000 || level !== warnedLevel) {
    lastLogAt = now
    log()
  }
}

/** React to a level change: warn the busy sessions, and under critical pressure stop the newest subagent. */
function govern(level: PressureLevel): void {
  if (!hooks) return
  const s = resourceSettings()
  const busySessions = snapshot.sessions.filter((r) => r.busy)
  if (level !== warnedLevel) {
    if (s.governor !== 'off') {
      if (level === 'normal') {
        for (const r of busySessions) hooks.notice(r.workspaceId, 'info', 'Memory pressure eased; subagents may start again.')
      } else {
        const what = s.governor === 'enforce' ? 'New subagents are refused until it eases.' : 'The governor is in warn-only mode, so nothing is stopped.'
        for (const r of busySessions) hooks.notice(r.workspaceId, level === 'critical' ? 'error' : 'warn', `Memory is ${level === 'critical' ? 'critically low' : 'under pressure'}: Sinfonie is using ${gb(snapshot.appRss)} of its ${gb(snapshot.budget)} budget and macOS reports ${snapshot.osPressure}. ${what}`)
      }
    }
    warnedLevel = level
  }
  if (level === 'critical' && s.governor === 'enforce' && s.stopSubagentsOnCritical) {
    // One per tick: the youngest task across all sessions is the cheapest to lose.
    const all = snapshot.sessions.flatMap((r) => r.tasks.map((t) => ({ ...t, workspaceId: r.workspaceId })))
    const victim = all.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
    if (victim) {
      hooks.notice(victim.workspaceId, 'error', `Stopped the subagent "${victim.description}" to relieve critical memory pressure.`)
      void hooks.stopTask(victim.workspaceId, victim.taskId).catch(() => undefined)
      taskEnded(victim.workspaceId, victim.taskId)
    }
  }
}

function log(): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const brief = { at: snapshot.at, level: snapshot.level, os: snapshot.osPressure, appMb: Math.round(snapshot.appRss / 1048576), swapMb: Math.round(snapshot.swapUsed / 1048576), sessions: snapshot.sessions.map((r) => ({ ws: r.workspaceId, mb: Math.round(r.rss / 1048576), procs: r.procs, tasks: r.tasks.length })) }
    appendFileSync(join(dir, 'resources.jsonl'), JSON.stringify(brief) + '\n')
  } catch {
    /* never break sampling */
  }
}

// ---------- admission control ----------

/** Send now if a slot is free (or the session is already live), else wait for one. */
export async function submit(workspaceId: string, text: string): Promise<void> {
  if (!hooks) throw new Error('resources not started')
  const s = resourceSettings()
  if (s.governor === 'off' || hooks.isBusy(workspaceId) || hooks.busyCount() < s.maxActiveSessions) return hooks.send(workspaceId, text)
  parked.push({ workspaceId, text })
  hooks.notice(workspaceId, 'info', `Waiting for a free slot: ${hooks.busyCount()} sessions are running (limit ${s.maxActiveSessions}). Your message starts as soon as one finishes; cancel it from the queue below.`)
}
/** Called whenever a session goes idle: start as many waiting messages as the limit allows. */
export async function release(): Promise<void> {
  if (!hooks) return
  const s = resourceSettings()
  while (parked.length && (s.governor === 'off' || hooks.busyCount() < s.maxActiveSessions)) {
    const next = parked.shift()!
    await hooks.send(next.workspaceId, next.text).catch(() => undefined)
  }
}
export function cancelWaiting(workspaceId: string): void {
  for (let i = parked.length - 1; i >= 0; i--) if (parked[i].workspaceId === workspaceId) parked.splice(i, 1)
}
export function waitingText(workspaceId: string): string | null {
  return parked.find((p) => p.workspaceId === workspaceId)?.text ?? null
}

export function start(h: Hooks): void {
  hooks = h
  if (timer) return
  void sample()
  timer = setInterval(() => void sample(), 2500)
}
export function stop(): void {
  if (timer) clearInterval(timer)
  timer = null
}
