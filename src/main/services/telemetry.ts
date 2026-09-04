import { app, BrowserWindow } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
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
    const message = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err)
    appendFileSync(file, `${new Date().toISOString()} [${where}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}\n`)
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

export function anyWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}
