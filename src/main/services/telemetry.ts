import { app, BrowserWindow } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { nanoid } from 'nanoid'
import type { ErrorEntry } from '@shared/types'
import { join } from 'path'
import { release } from 'os'
import { getStore } from '../store'

const ENDPOINT = 'https://sinfonie.dev/api/feedback'
const MAX_LOG = 2 * 1024 * 1024

export function logsDir(): string {
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Append one line to errors.log, rotating at 2 MB so it never grows unbounded. */
export function logError(where: string, err: unknown, extra?: Record<string, unknown>): void {
  try {
    const file = join(logsDir(), 'errors.log')
    if (existsSync(file) && statSync(file).size > MAX_LOG) renameSync(file, join(logsDir(), 'errors.1.log'))
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    const stack = err instanceof Error ? (err.stack ?? '') : ''
    const entry: ErrorEntry = { id: nanoid(8), ts: new Date().toISOString(), where, message, ...(stack ? { stack } : {}), ...(extra ? { extra: JSON.stringify(extra) } : {}) }
    // One JSON object per line: easy to parse back for the Errors view, still readable in a text editor.
    appendFileSync(file, JSON.stringify(entry) + '\n')
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('errors:new', entry)
  } catch {
    /* never throw from the logger */
  }
}

function osLabel(): string {
  return `macOS ${release()} ${process.arch}`
}

export interface FeedbackPayload {
  kind: 'feedback' | 'feature' | 'bug' | 'crash'
  message: string
  email?: string
  context?: Record<string, unknown>
  /** Screenshots, base64 without the data: prefix. */
  attachments?: { name: string; mime: string; data: string }[]
}

/** Send to the feedback API. Crash reports respect the "send crash reports" setting. */
export async function sendFeedback(p: FeedbackPayload): Promise<{ ok: boolean; error?: string }> {
  if (p.kind === 'crash' && getStore().get().settings.crashReports === false) return { ok: false, error: 'crash reports disabled' }
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...p, source: 'app', appVersion: app.getVersion(), os: osLabel() })
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const recent = new Map<string, number>()

/** Log locally, and report once per distinct error per hour. Never includes chat content. */
export function reportCrash(where: string, err: unknown, extra?: Record<string, unknown>): void {
  logError(where, err, extra)
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  const key = `${where}:${message}`
  const now = Date.now()
  if ((recent.get(key) ?? 0) > now - 60 * 60 * 1000) return
  recent.set(key, now)
  const stack = err instanceof Error ? (err.stack ?? '').split('\n').slice(0, 12).join('\n') : undefined
  void sendFeedback({ kind: 'crash', message: `[${where}] ${message}`, context: { stack, ...extra } })
}

/** Wire process-level handlers and renderer crash hooks. Call once at startup. */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (err) => reportCrash('main:uncaughtException', err))
  process.on('unhandledRejection', (reason) => reportCrash('main:unhandledRejection', reason))
  app.on('render-process-gone', (_e, _wc, details) => reportCrash('renderer:process-gone', new Error(details.reason), { exitCode: details.exitCode }))
  app.on('child-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit' && details.reason !== 'killed') logError('child-process-gone', new Error(`${details.type}: ${details.reason}`), { name: details.name })
  })
}

/** Renderer console errors are forwarded here from the window's console-message event. */
export function rendererConsoleError(message: string, sourceId: string, line: number): void {
  // Ignore noise from devtools / extensions; keep real uncaught errors.
  if (!/Uncaught|TypeError|ReferenceError|RangeError|Error:/.test(message)) return
  reportCrash('renderer:console', new Error(message), { source: `${sourceId}:${line}` })
}

export function listErrors(): ErrorEntry[] {
  const file = join(logsDir(), 'errors.log')
  if (!existsSync(file)) return []
  const out: ErrorEntry[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as ErrorEntry)
    } catch {
      // A line from the older plain-text format.
      const m = /^(\S+) \[([^\]]+)\] ([\s\S]*)$/.exec(line)
      out.push({ id: nanoid(8), ts: m?.[1] ?? '', where: m?.[2] ?? 'log', message: (m?.[3] ?? line).slice(0, 2000) })
    }
  }
  return out.reverse().slice(0, 500)
}

export function clearErrors(): void {
  try {
    writeFileSync(join(logsDir(), 'errors.log'), '')
  } catch {
    /* ignore */
  }
}

export function anyWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}


// ---------- anonymous daily usage ping ----------

const USAGE_ENDPOINT = 'https://sinfonie.dev/api/usage'
let messagesSinceLastPing = 0
const enginesUsed = new Set<string>()

/** Called by the chat when the user sends a message; feeds the daily counts. */
export function noteMessage(engine: string): void {
  messagesSinceLastPing++
  enginesUsed.add(engine)
}

function installId(): string {
  const { settings } = getStore().get()
  if (settings.installId) return settings.installId
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
  getStore().update((d) => {
    d.settings.installId = id
    d.settings.installFirstSeen = new Date().toISOString()
  })
  return id
}

export async function sendUsagePing(): Promise<void> {
  const { settings, workspaces } = getStore().get()
  if (settings.usageStats === false) return
  try {
    const body = {
      installId: installId(),
      appVersion: app.getVersion(),
      os: osLabel(),
      engines: Array.from(enginesUsed),
      workspaces: workspaces.filter((w) => w.status !== 'archived').length,
      messages: messagesSinceLastPing,
      firstSeen: getStore().get().settings.installFirstSeen
    }
    const res = await fetch(USAGE_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (res.ok) {
      messagesSinceLastPing = 0
      enginesUsed.clear()
    }
  } catch {
    /* offline: counts carry over to the next ping */
  }
}

/** One ping shortly after launch, then every 6 hours (the server keeps one row per day). */
export function startUsagePings(): void {
  if (!app.isPackaged && process.env.SINFONIE_USAGE_PING !== '1') return
  setTimeout(() => void sendUsagePing(), 15_000)
  setInterval(() => void sendUsagePing(), 6 * 60 * 60 * 1000).unref()
  app.on('before-quit', () => void sendUsagePing())
}
