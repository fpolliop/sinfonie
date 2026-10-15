/**
 * API explorer: send requests to the workspace's app from main (no CORS, no browser).
 *
 * Local environments (the workspace's own port, another local base URL) send straight away. Staging and
 * production are the space's, shared with its team; a request to them leaves the Mac, so main refuses it
 * unless the person confirmed the full request first (`confirmed`). Settings and history live in
 * userData/api/<workspace>.json; auth secrets are encrypted in the store's secrets, per person, and never
 * reach the renderer.
 */
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import { getStore } from '../../store'
import { getWorkspace } from '../workspaces'
import { savedOf } from './collections'
import { API_REMOTE_ENVS, type ApiAuth, type ApiEnv, type ApiEnvDef, type ApiHistoryEntry, type ApiPreview, type ApiRemoteEnv, type ApiRequest, type ApiResponse, type ApiSettings, type ApiState } from '@shared/types'

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
/** Staging/production secrets are per person and per space: the definition is shared, the token never is. */
const envSecretKey = (spaceId: string | undefined, env: ApiRemoteEnv) => `api:env:${spaceId || 'default'}:${env}`
function readSecret(key: string): string | undefined {
  const raw = getStore().get().secrets?.[key]
  if (!raw) return undefined
  try {
    if (raw.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'))
    if (raw.startsWith('plain:')) return Buffer.from(raw.slice(6), 'base64').toString('utf8')
  } catch {
    /* unreadable: treat as missing */
  }
  return undefined
}
function writeSecret(key: string, value: string | undefined): void {
  getStore().update((d) => {
    d.secrets = d.secrets ?? {}
    if (value === undefined) delete d.secrets[key]
    else d.secrets[key] = safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(value).toString('base64') : 'plain:' + Buffer.from(value, 'utf8').toString('base64')
  })
}

// ---------- environments ----------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
function isLocal(u: URL): boolean {
  return (u.protocol === 'http:' || u.protocol === 'https:') && (LOOPBACK.has(u.hostname) || u.hostname.endsWith('.localhost'))
}

export function isRemote(env: ApiEnv): env is ApiRemoteEnv {
  return (API_REMOTE_ENVS as string[]).includes(env)
}

/** The space's staging/production definitions, or the app's own for a workspace outside a space. */
function remoteEnvs(workspaceId: string): Partial<Record<ApiRemoteEnv, ApiEnvDef>> {
  const ws = getWorkspace(workspaceId)
  const { spaces, settings } = getStore().get()
  const space = spaces.find((x) => x.id === ws.spaceId)
  return (space ? space.apiEnvironments : settings.apiEnvironments) ?? {}
}

function basesOf(workspaceId: string, settings: ApiSettings): Record<ApiEnv, string | null> {
  const ws = getWorkspace(workspaceId)
  const remote = remoteEnvs(workspaceId)
  return { workspace: ws.port ? `http://localhost:${ws.port}` : null, local: settings.localBase?.trim() || null, staging: remote.staging?.baseUrl || null, production: remote.production?.baseUrl || null }
}

export function state(workspaceId: string): ApiState {
  const s = load(workspaceId)
  const ws = getWorkspace(workspaceId)
  const envs: ApiState['envs'] = {}
  for (const [env, def] of Object.entries(remoteEnvs(workspaceId)) as [ApiRemoteEnv, ApiEnvDef][]) envs[env] = { ...def, hasSecret: Boolean(readSecret(envSecretKey(ws.spaceId, env))) }
  return { settings: { ...s.settings, hasSecret: Boolean(readSecret(secretKey(workspaceId))) }, history: s.history, bases: basesOf(workspaceId, s.settings), envs, saved: savedOf(workspaceId) }
}

export function setSettings(workspaceId: string, settings: ApiSettings, secret?: string | null): ApiState {
  if (settings.localBase?.trim()) {
    let u: URL
    try {
      u = new URL(settings.localBase.trim())
    } catch {
      throw new Error('The local base URL is not a URL. Use something like http://localhost:3001.')
    }
    if (!isLocal(u)) throw new Error('Local is for addresses on this Mac (localhost, 127.0.0.1). Add other servers as Staging or Production.')
  }
  const s = load(workspaceId)
  const { hasSecret: _ignored, ...clean } = settings
  void _ignored
  s.settings = { ...DEFAULTS, ...clean, localBase: clean.localBase?.trim().replace(/\/+$/, '') || undefined }
  save(workspaceId, s)
  if (secret === null || settings.auth.kind === 'none') writeSecret(secretKey(workspaceId), undefined)
  else if (typeof secret === 'string' && secret) writeSecret(secretKey(workspaceId), secret)
  return state(workspaceId)
}

/** Define (or remove, with null) the space's staging or production API. The secret is this person's only. */
export function setEnvironment(workspaceId: string, env: ApiRemoteEnv, def: ApiEnvDef | null, secret?: string | null): ApiState {
  if (!isRemote(env)) throw new Error(`Unknown environment ${env}.`)
  const ws = getWorkspace(workspaceId)
  let clean: ApiEnvDef | null = null
  if (def) {
    let u: URL
    try {
      u = new URL(def.baseUrl.trim())
    } catch {
      throw new Error(`The ${env} base URL is not a URL. Use something like https://api.staging.example.com.`)
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Use an http or https URL.')
    clean = { baseUrl: u.toString().replace(/\/+$/, ''), auth: { kind: def.auth.kind, ...(def.auth.name?.trim() ? { name: def.auth.name.trim() } : {}) } }
  }
  getStore().update((d) => {
    const space = d.spaces.find((x) => x.id === ws.spaceId)
    const target = space ?? d.settings
    const next = { ...(target.apiEnvironments ?? {}) }
    if (clean) next[env] = clean
    else delete next[env]
    target.apiEnvironments = Object.keys(next).length ? next : undefined
  })
  const key = envSecretKey(ws.spaceId, env)
  if (!clean || secret === null || clean.auth.kind === 'none') writeSecret(key, undefined)
  else if (typeof secret === 'string' && secret) writeSecret(key, secret)
  return state(workspaceId)
}

export function clearHistory(workspaceId: string): void {
  const s = load(workspaceId)
  s.history = []
  save(workspaceId, s)
}

// ---------- requests ----------

/** The URL and headers a request goes out with, auth included. */
function prepare(workspaceId: string, req: ApiRequest): { url: URL; headers: Headers; remote: boolean; authHeader?: string } {
  const { settings } = load(workspaceId)
  const base = basesOf(workspaceId, settings)[req.env]
  if (!base) throw new Error(req.env === 'workspace' ? 'This workspace has no port yet. Start its app from the Run tab, or pick Local.' : req.env === 'local' ? 'Set the Local base URL first (Request settings).' : `Set the ${req.env} base URL first (Request settings).`)
  const path = req.path.startsWith('/') ? req.path : `/${req.path}`
  const url = new URL(base.replace(/\/+$/, '') + path)
  const remote = isRemote(req.env)
  // A path like "@evil.com/x" must not move a request to another host.
  if (!remote && !isLocal(url)) throw new Error('Only addresses on this Mac can be called from Local or This workspace.')
  if (remote && url.origin !== new URL(base).origin) throw new Error(`The path must stay on the ${req.env} server.`)
  const headers = new Headers()
  for (const [k, v] of req.headers) if (k.trim()) headers.set(k.trim(), v)
  const ws = getWorkspace(workspaceId)
  const auth: ApiAuth = remote ? (remoteEnvs(workspaceId)[req.env as ApiRemoteEnv]?.auth ?? { kind: 'none' }) : settings.auth
  const secret = readSecret(remote ? envSecretKey(ws.spaceId, req.env as ApiRemoteEnv) : secretKey(workspaceId))
  if (secret && auth.kind === 'bearer' && !headers.has('authorization')) headers.set('Authorization', `Bearer ${secret}`)
  if (secret && auth.kind === 'basic' && !headers.has('authorization')) headers.set('Authorization', `Basic ${Buffer.from(`${auth.name ?? ''}:${secret}`).toString('base64')}`)
  if (secret && auth.kind === 'header' && auth.name && !headers.has(auth.name)) headers.set(auth.name, secret)
  if (req.body && !headers.has('content-type')) headers.set('Content-Type', 'application/json')
  return { url, headers, remote, authHeader: auth.kind === 'header' ? auth.name : auth.kind === 'none' ? undefined : 'authorization' }
}

const hasBody = (method: string) => !['GET', 'HEAD'].includes(method.toUpperCase())
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i

/** The history keeps what was sent, minus any auth the user typed into the headers. */
function scrub(req: ApiRequest): ApiRequest {
  return { ...req, headers: req.headers.map(([k, v]) => [k, SECRET_HEADER.test(k.trim()) ? '••••' : v] as [string, string]) }
}

/** Exactly what the request will send, auth masked: the confirm step shows this before anything leaves the Mac. */
export function preview(workspaceId: string, req: ApiRequest): ApiPreview {
  const method = req.method.toUpperCase()
  const { url, headers, remote, authHeader } = prepare(workspaceId, req)
  const list: [string, string][] = []
  headers.forEach((v, k) => {
    const secret = SECRET_HEADER.test(k) || (authHeader && k.toLowerCase() === authHeader.toLowerCase())
    // Keep the scheme ("Bearer ••••") so the person sees which kind of auth goes out.
    list.push([k, secret ? (/^(Bearer|Basic) /.test(v) ? `${v.split(' ')[0]} ••••` : '••••') : v])
  })
  return { method, url: url.toString(), headers: list, body: hasBody(method) && req.body ? req.body : undefined, remote }
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

export async function send(workspaceId: string, req: ApiRequest, by?: 'agent'): Promise<ApiResponse> {
  const method = req.method.toUpperCase()
  // The agent stays on this Mac: staging and production need a person's confirmation in the pane.
  if (by === 'agent' && isRemote(req.env)) throw new Error(`The agent can only call this workspace's app or Local. Requests to ${req.env} are sent by a person from the API pane, after confirming them.`)
  const { url, headers, remote } = prepare(workspaceId, req)
  if (remote && (!req.confirmed || by === 'agent')) throw new Error(`This request goes to ${req.env} (${url.host}), off this Mac. Confirm it in the API pane first.`)
  const started = Date.now()
  const { confirmed: _confirmed, ...plain } = req
  void _confirmed
  const entry: ApiHistoryEntry = { id: nanoid(8), at: new Date().toISOString(), request: scrub({ ...plain, method }), url: url.toString(), ...(by ? { by } : {}) }
  try {
    // No silent hop to another host: a redirect off the confirmed server is reported, not followed.
    const res = await fetch(url, { method, headers, body: hasBody(method) && req.body ? req.body : undefined, redirect: remote ? 'manual' : 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
    const { text, bytes, truncated } = await readCapped(res)
    const ms = Date.now() - started
    record(workspaceId, { ...entry, status: res.status, ms })
    return { url: res.url || url.toString(), status: res.status, statusText: res.statusText, headers: Array.from(res.headers.entries()), body: text, truncated, bytes, ms }
  } catch (err) {
    // fetch wraps the socket error: "fetch failed", with the code (ECONNREFUSED) on its cause, sometimes an AggregateError with an empty message.
    const cause = err instanceof Error ? (err.cause as (Error & { code?: string; errors?: (Error & { code?: string })[] }) | undefined) : undefined
    const raw = [err instanceof Error ? err.message : String(err), cause?.code, cause?.message, ...(cause?.errors ?? []).map((e) => e.code ?? e.message)].filter(Boolean).join(' ')
    const why = /ECONNREFUSED/.test(raw) ? `Nothing is answering at ${url.host}. Is the app running?` : /ENOTFOUND|EAI_AGAIN/.test(raw) ? `${url.host} could not be found. Check the ${req.env} base URL.` : /timeout|aborted/i.test(raw) ? `No answer after ${TIMEOUT_MS / 1000} seconds.` : raw
    record(workspaceId, { ...entry, ms: Date.now() - started, error: why })
    throw new Error(why)
  }
}

const sh = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`

/** The request as curl, auth included (it is the person's own token). */
export function curl(workspaceId: string, req: ApiRequest): string {
  const method = req.method.toUpperCase()
  const { url, headers } = prepare(workspaceId, req)
  const parts = [`curl -X ${method} ${sh(url.toString())}`]
  headers.forEach((v, k) => parts.push(`-H ${sh(`${k}: ${v}`)}`))
  if (hasBody(method) && req.body) parts.push(`--data-raw ${sh(req.body)}`)
  return parts.join(' \\\n  ')
}
