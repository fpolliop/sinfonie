/**
 * API explorer, phase 2: send requests to the workspace's app from main (no CORS, no browser).
 *
 * Only this Mac for now: the workspace's own port, or another local base URL. Main refuses any other
 * host, so nothing leaves the Mac and nothing needs confirming (staging and production come with their
 * own confirm step in phase 4). Settings and history live in userData/api/<workspace>.json; the auth
 * secret is encrypted in the store's secrets and never reaches the renderer.
 */
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import { getStore } from '../../store'
import { getWorkspace } from '../workspaces'
import type { ApiEnv, ApiHistoryEntry, ApiRequest, ApiResponse, ApiSettings, ApiState } from '@shared/types'

const MAX_BODY = 2 * 1024 * 1024
const TIMEOUT_MS = 30_000
const HISTORY = 50

// ---------- storage ----------

interface Saved {
  settings: ApiSettings
  history: ApiHistoryEntry[]
}
const DEFAULTS: ApiSettings = { env: 'workspace', auth: { kind: 'none' } }

function fileOf(workspaceId: string): string {
  const dir = join(app.getPath('userData'), 'api')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${workspaceId.replace(/[^\w-]/g, '_')}.json`)
}
function load(workspaceId: string): Saved {
  const f = fileOf(workspaceId)
  if (!existsSync(f)) return { settings: { ...DEFAULTS }, history: [] }
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<Saved>
    return { settings: { ...DEFAULTS, ...raw.settings }, history: raw.history ?? [] }
  } catch {
    return { settings: { ...DEFAULTS }, history: [] }
  }
}
function save(workspaceId: string, s: Saved): void {
  writeFileSync(fileOf(workspaceId), JSON.stringify(s))
}

const secretKey = (workspaceId: string) => `api:${workspaceId}:auth`
function readSecret(workspaceId: string): string | undefined {
  const raw = getStore().get().secrets?.[secretKey(workspaceId)]
  if (!raw) return undefined
  try {
    if (raw.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'))
    if (raw.startsWith('plain:')) return Buffer.from(raw.slice(6), 'base64').toString('utf8')
  } catch {
    /* unreadable: treat as missing */
  }
  return undefined
}
function writeSecret(workspaceId: string, value: string | undefined): void {
  getStore().update((d) => {
    d.secrets = d.secrets ?? {}
    if (value === undefined) delete d.secrets[secretKey(workspaceId)]
    else d.secrets[secretKey(workspaceId)] = safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(value).toString('base64') : 'plain:' + Buffer.from(value, 'utf8').toString('base64')
  })
}

// ---------- environments ----------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
function isLocal(u: URL): boolean {
  return (u.protocol === 'http:' || u.protocol === 'https:') && (LOOPBACK.has(u.hostname) || u.hostname.endsWith('.localhost'))
}

function basesOf(workspaceId: string, settings: ApiSettings): Record<ApiEnv, string | null> {
  const ws = getWorkspace(workspaceId)
  return { workspace: ws.port ? `http://localhost:${ws.port}` : null, local: settings.localBase?.trim() || null }
}

export function state(workspaceId: string): ApiState {
  const s = load(workspaceId)
  return { settings: { ...s.settings, hasSecret: Boolean(readSecret(workspaceId)) }, history: s.history, bases: basesOf(workspaceId, s.settings) }
}

export function setSettings(workspaceId: string, settings: ApiSettings, secret?: string | null): ApiState {
  if (settings.localBase?.trim()) {
    let u: URL
    try {
      u = new URL(settings.localBase.trim())
    } catch {
      throw new Error('The local base URL is not a URL. Use something like http://localhost:3001.')
    }
    if (!isLocal(u)) throw new Error('Only addresses on this Mac (localhost, 127.0.0.1) can be used for now. Staging and production come later, with a confirm step.')
  }
  const s = load(workspaceId)
  const { hasSecret: _ignored, ...clean } = settings
  void _ignored
  s.settings = { ...DEFAULTS, ...clean, localBase: clean.localBase?.trim().replace(/\/+$/, '') || undefined }
  save(workspaceId, s)
  if (secret === null || settings.auth.kind === 'none') writeSecret(workspaceId, undefined)
  else if (typeof secret === 'string' && secret) writeSecret(workspaceId, secret)
  return state(workspaceId)
}

export function clearHistory(workspaceId: string): void {
  const s = load(workspaceId)
  s.history = []
  save(workspaceId, s)
}

// ---------- requests ----------

/** The URL and headers a request goes out with, auth included. */
function prepare(workspaceId: string, req: ApiRequest): { url: URL; headers: Headers } {
  const { settings } = load(workspaceId)
  const base = basesOf(workspaceId, settings)[req.env]
  if (!base) throw new Error(req.env === 'workspace' ? 'This workspace has no port yet. Start its app from the Run tab, or pick Local.' : 'Set the Local base URL first (Request settings).')
  const path = req.path.startsWith('/') ? req.path : `/${req.path}`
  const url = new URL(base.replace(/\/+$/, '') + path)
  if (!isLocal(url)) throw new Error('Only addresses on this Mac can be called for now.')
  const headers = new Headers()
  for (const [k, v] of req.headers) if (k.trim()) headers.set(k.trim(), v)
  const secret = readSecret(workspaceId)
  const auth = settings.auth
  if (secret && auth.kind === 'bearer' && !headers.has('authorization')) headers.set('Authorization', `Bearer ${secret}`)
  if (secret && auth.kind === 'basic' && !headers.has('authorization')) headers.set('Authorization', `Basic ${Buffer.from(`${auth.name ?? ''}:${secret}`).toString('base64')}`)
  if (secret && auth.kind === 'header' && auth.name && !headers.has(auth.name)) headers.set(auth.name, secret)
  if (req.body && !headers.has('content-type')) headers.set('Content-Type', 'application/json')
  return { url, headers }
}

const hasBody = (method: string) => !['GET', 'HEAD'].includes(method.toUpperCase())

/** The history keeps what was sent, minus any auth the user typed into the headers. */
function scrub(req: ApiRequest): ApiRequest {
  return { ...req, headers: req.headers.map(([k, v]) => [k, /^(authorization|cookie|x-api-key|api-key)$/i.test(k.trim()) ? '••••' : v] as [string, string]) }
}

function record(workspaceId: string, entry: ApiHistoryEntry): void {
  const s = load(workspaceId)
  s.history = [entry, ...s.history].slice(0, HISTORY)
  save(workspaceId, s)
}

async function readCapped(res: Response): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { text: '', bytes: 0, truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_BODY) {
      truncated = true
      chunks.push(value.subarray(0, value.byteLength - (bytes - MAX_BODY)))
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated }
}

export async function send(workspaceId: string, req: ApiRequest): Promise<ApiResponse> {
  const method = req.method.toUpperCase()
  const { url, headers } = prepare(workspaceId, req)
  const started = Date.now()
  const entry: ApiHistoryEntry = { id: nanoid(8), at: new Date().toISOString(), request: scrub({ ...req, method }), url: url.toString() }
  try {
    const res = await fetch(url, { method, headers, body: hasBody(method) && req.body ? req.body : undefined, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
    const { text, bytes, truncated } = await readCapped(res)
    const ms = Date.now() - started
    record(workspaceId, { ...entry, status: res.status, ms })
    return { url: res.url || url.toString(), status: res.status, statusText: res.statusText, headers: Array.from(res.headers.entries()), body: text, truncated, bytes, ms }
  } catch (err) {
    // fetch wraps the socket error: "fetch failed", with the code (ECONNREFUSED) on its cause, sometimes an AggregateError with an empty message.
    const cause = err instanceof Error ? (err.cause as (Error & { code?: string; errors?: (Error & { code?: string })[] }) | undefined) : undefined
    const raw = [err instanceof Error ? err.message : String(err), cause?.code, cause?.message, ...(cause?.errors ?? []).map((e) => e.code ?? e.message)].filter(Boolean).join(' ')
    const why = /ECONNREFUSED/.test(raw) ? `Nothing is answering at ${url.host}. Is the app running?` : /timeout|aborted/i.test(raw) ? `No answer after ${TIMEOUT_MS / 1000} seconds.` : raw
    record(workspaceId, { ...entry, ms: Date.now() - started, error: why })
    throw new Error(why)
  }
}

const sh = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`

/** The request as curl, auth included (it is the user's own local token). */
export function curl(workspaceId: string, req: ApiRequest): string {
  const method = req.method.toUpperCase()
  const { url, headers } = prepare(workspaceId, req)
  const parts = [`curl -X ${method} ${sh(url.toString())}`]
  headers.forEach((v, k) => parts.push(`-H ${sh(`${k}: ${v}`)}`))
  if (hasBody(method) && req.body) parts.push(`--data-raw ${sh(req.body)}`)
  return parts.join(' \\\n  ')
}
