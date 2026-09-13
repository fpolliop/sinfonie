import { BrowserWindow, Notification } from 'electron'
import type { AgentSpec } from '@shared/types'
import { agentOwner } from '@shared/types'
import * as agents from '../agents'
import * as remote from '../remote'
import * as runs from './runs'

/**
 * Runs scheduled agents while the app is open: every N minutes, or once a day at a local time.
 * A run that finishes with a report notifies on the Mac and, when a phone is paired and the
 * user is away, on the phone. Nothing runs twice at once.
 */

let timer: NodeJS.Timeout | null = null
const inFlight = new Set<string>()

function todayAt(hhmm: string): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const d = new Date()
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  return d
}

/** When the next run is due, or null when the schedule is off or malformed. */
export function nextRunAt(spec: AgentSpec): Date | null {
  const s = spec.schedule
  if (!s?.enabled || !spec.enabled) return null
  const last = runs.lastRun(spec.id, 'schedule')
  const lastAt = last ? new Date(last.startedAt).getTime() : 0
  if (s.kind === 'interval') {
    const every = Math.max(5, s.everyMinutes ?? 60) * 60_000
    return new Date(lastAt ? lastAt + every : Date.now())
  }
  const at = todayAt(s.at ?? '09:00')
  if (!at) return null
  // Today's slot if it has not run since it; otherwise tomorrow's.
  if (lastAt >= at.getTime()) at.setDate(at.getDate() + 1)
  return at
}

function due(spec: AgentSpec, now: number): boolean {
  const next = nextRunAt(spec)
  if (!next) return false
  // A daily slot missed by more than a day (app closed) runs once, not for every missed day.
  return next.getTime() <= now
}

async function fire(spec: AgentSpec): Promise<void> {
  if (inFlight.has(spec.id)) return
  inFlight.add(spec.id)
  try {
    await runs.scheduled(spec.id, 'schedule')
    const last = runs.lastRun(spec.id, 'schedule')
    if (last?.report) notify(spec, firstLine(last.report))
    else if (last?.error) notify(spec, `Failed: ${last.error}`)
  } catch (err) {
    console.warn(`[scheduler] ${spec.name}`, err)
  } finally {
    inFlight.delete(spec.id)
  }
}

function firstLine(text: string): string {
  return text
    .replace(/[#*_`>]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
    .slice(0, 180)
}

function notify(spec: AgentSpec, body: string): void {
  const title = `${spec.icon ? `${spec.icon} ` : ''}${spec.name} finished`
  if (Notification.isSupported()) {
    const n = new Notification({ title, body })
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('ui:openAgent', { agentId: spec.id })
    })
    n.show()
  }
  remote.notifyFromCli(agentOwner(spec.id), 'finished', title, body)
}

function tick(): void {
  const now = Date.now()
  for (const spec of agents.list()) if (spec.schedule?.enabled && spec.enabled && due(spec, now)) void fire(spec)
}

export function start(): void {
  if (timer) return
  timer = setInterval(tick, 30_000)
  // A short grace period after launch so sign-ins and MCP probes settle first.
  setTimeout(tick, 20_000)
}

export function stop(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** "Run now": the standing task, outside the schedule. */
export async function runNow(agentId: string): Promise<void> {
  const spec = agents.get(agentId)
  if (!spec) throw new Error(`No agent ${agentId}`)
  if (inFlight.has(spec.id)) throw new Error('The agent is already running.')
  inFlight.add(spec.id)
  try {
    await runs.scheduled(spec.id, 'manual')
  } finally {
    inFlight.delete(spec.id)
  }
}
