/**
 * Slack for the on-call agent. Sign-in is OAuth against Slack's hosted MCP server with a user-scoped
 * token. Slack has no dynamic client registration, so by default the flow uses Sinfonie's own
 * registered OAuth client: the app holds only the client id, and sinfonie.dev exchanges the code
 * for tokens with the secret. Advanced users can plug in their own client id/secret instead.
 * Polling and posting use the Web API; agent sessions get the MCP URL with the bearer token.
 */
import { shell, safeStorage } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { getStore } from '../store'
import type { SlackConnection } from '@shared/types'

export const SLACK_MCP_URL = 'https://mcp.slack.com/mcp'
export const REDIRECT_URL = 'https://sinfonie.dev/oauth/slack/callback'
const TOKEN_URL = 'https://slack.com/api/oauth.v2.user.access'
const TOKEN_PROXY = 'https://sinfonie.dev/oauth/slack/token'
/** Sinfonie's registered Slack OAuth client. Empty until the vendor registers one; the secret never ships. */
export const SINFONIE_SLACK_CLIENT_ID = process.env.SINFONIE_SLACK_CLIENT_ID ?? ''
const SCOPES = ['channels:history', 'channels:read', 'groups:history', 'groups:read', 'chat:write', 'search:read.public', 'users:read']

// ---------- secrets (same scheme as jira.ts) ----------
function encrypt(text: string): string {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64')
  return 'plain:' + Buffer.from(text, 'utf8').toString('base64')
}
function decrypt(stored: string): string {
  if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
  return stored
}
function readSecret<T>(key: string): T | undefined {
  const raw = getStore().get().secrets?.[key]
  if (!raw) return undefined
  try {
    return JSON.parse(decrypt(raw)) as T
  } catch {
    return undefined
  }
}
function writeSecret(key: string, value: unknown): void {
  getStore().update((d) => {
    d.secrets = d.secrets ?? {}
    if (value === undefined) delete d.secrets[key]
    else d.secrets[key] = encrypt(JSON.stringify(value))
  })
}
const k = (name: string): string => `slack:${name}`

interface Tokens {
  access_token: string
  refresh_token?: string
  expires_at?: number
  scope?: string
}
interface OwnClient {
  client_id: string
  client_secret: string
}

export function connection(): SlackConnection {
  const own = readSecret<OwnClient>(k('client'))
  const s = getStore().get().settings.slack
  return { connected: false, ...(s ?? {}), hasClient: Boolean(own), clientId: own?.client_id, vendorClient: Boolean(SINFONIE_SLACK_CLIENT_ID) }
}
function patchConnection(patch: Partial<SlackConnection>): SlackConnection {
  getStore().update((d) => {
    d.settings.slack = { ...connection(), ...patch }
  })
  return connection()
}
function clientId(): string {
  return readSecret<OwnClient>(k('client'))?.client_id || SINFONIE_SLACK_CLIENT_ID
}

// ---------- OAuth ----------

export function setClient(id: string, secret: string): SlackConnection {
  writeSecret(k('client'), { client_id: id.trim(), client_secret: secret.trim() })
  return connection()
}
export function clearClient(): SlackConnection {
  writeSecret(k('client'), undefined)
  return connection()
}

/** Opens the browser for approval. The code comes back through sinfonie://oauth/slack or is pasted by the user. */
export async function startAuth(): Promise<void> {
  const id = clientId()
  if (!id) throw new Error('This build of Sinfonie has no Slack client registered yet. Under Advanced you can use your own Slack OAuth client.')
  writeSecret(k('tokens'), undefined)
  const verifier = randomBytes(48).toString('base64url')
  writeSecret(k('verifier'), verifier)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const url = new URL('https://slack.com/oauth/v2_user/authorize')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', id)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('redirect_uri', REDIRECT_URL)
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('resource', 'https://mcp.slack.com/')
  url.searchParams.set('state', randomBytes(12).toString('base64url'))
  await shell.openExternal(url.toString())
}

/** Exchange a code or refresh token: directly when the user brought their own client, else through sinfonie.dev. */
async function exchange(params: Record<string, string>): Promise<Tokens> {
  const own = readSecret<OwnClient>(k('client'))
  let json: Record<string, unknown>
  if (own) {
    const body = new URLSearchParams({ ...params, client_id: own.client_id, client_secret: own.client_secret })
    json = (await (await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).json()) as Record<string, unknown>
  } else {
    const res = await fetch(TOKEN_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) })
    json = (await res.json().catch(() => ({ error: `sinfonie.dev answered ${res.status}` }))) as Record<string, unknown>
  }
  return parseTokens(json)
}
function parseTokens(j: Record<string, unknown>): Tokens {
  const user = (j.authed_user ?? {}) as Record<string, unknown>
  const access = (j.access_token ?? user.access_token) as string | undefined
  if (!access) throw new Error(`Slack sign-in failed: ${String(j.error_description ?? j.error ?? 'no access token returned')}`)
  const expires = (j.expires_in ?? user.expires_in) as number | undefined
  return { access_token: access, refresh_token: (j.refresh_token ?? user.refresh_token) as string | undefined, expires_at: expires ? Date.now() + Number(expires) * 1000 : undefined, scope: (j.scope ?? user.scope) as string | undefined }
}

export async function finishAuth(code: string): Promise<SlackConnection> {
  const verifier = readSecret<string>(k('verifier'))
  if (!verifier) throw new Error('Start the Slack sign-in again; the browser round trip did not begin from this app.')
  const t = await exchange({ grant_type: 'authorization_code', code: code.trim(), code_verifier: verifier, redirect_uri: REDIRECT_URL })
  writeSecret(k('tokens'), t)
  writeSecret(k('verifier'), undefined)
  return afterAuth()
}
async function afterAuth(): Promise<SlackConnection> {
  const me = await api<{ team: string; user: string; user_id: string }>('auth.test', {})
  return patchConnection({ connected: true, connectedAt: new Date().toISOString(), teamName: me.team, userName: me.user, userId: me.user_id })
}
export function disconnect(): SlackConnection {
  writeSecret(k('tokens'), undefined)
  return patchConnection({ connected: false, teamName: undefined, userName: undefined, userId: undefined })
}

// ---------- tokens ----------

/** A valid access token, refreshed when it is about to expire. */
export async function accessToken(force = false): Promise<string> {
  const t = readSecret<Tokens>(k('tokens'))
  if (!t) throw new Error('Slack is not connected. Connect it in Settings, On call.')
  if (force || (t.expires_at && t.expires_at - Date.now() < 60_000)) {
    if (!t.refresh_token) {
      patchConnection({ connected: false })
      throw new Error('Slack login expired. Reconnect it in Settings, On call.')
    }
    try {
      const n = await exchange({ grant_type: 'refresh_token', refresh_token: t.refresh_token })
      const merged = { ...t, ...n, refresh_token: n.refresh_token ?? t.refresh_token }
      writeSecret(k('tokens'), merged)
      return merged.access_token
    } catch (err) {
      patchConnection({ connected: false })
      throw new Error(`Slack login could not be refreshed (${err instanceof Error ? err.message : String(err)}). Reconnect it in Settings, On call.`)
    }
  }
  return t.access_token
}

/** For agent sessions: Slack's MCP server with the user's bearer token. */
export async function mcpServerConfig(): Promise<{ type: 'http'; url: string; headers: Record<string, string> }> {
  return { type: 'http', url: SLACK_MCP_URL, headers: { Authorization: `Bearer ${await accessToken()}` } }
}

// ---------- Web API ----------

export async function api<T>(method: string, params: Record<string, string | number | boolean | undefined>, retried = false): Promise<T> {
  const token = await accessToken()
  const body = new URLSearchParams()
  for (const [key, v] of Object.entries(params)) if (v !== undefined) body.set(key, String(v))
  const res = await fetch(`https://slack.com/api/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  const json = (await res.json()) as { ok: boolean; error?: string } & T
  if (!json.ok) {
    if (json.error === 'token_expired' && !retried) {
      await accessToken(true)
      return api<T>(method, params, true)
    }
    if (json.error === 'token_revoked' || json.error === 'invalid_auth' || json.error === 'account_inactive') patchConnection({ connected: false })
    throw new Error(`Slack ${method}: ${json.error ?? 'failed'}`)
  }
  return json
}

export interface SlackMessage {
  ts: string
  user?: string
  bot_id?: string
  username?: string
  subtype?: string
  text: string
  thread_ts?: string
  reply_count?: number
}
export interface SlackChannel {
  id: string
  name: string
  is_private: boolean
  is_member: boolean
}

export async function listChannels(query = ''): Promise<SlackChannel[]> {
  const out: SlackChannel[] = []
  let cursor: string | undefined
  for (let i = 0; i < 10; i++) {
    const page = await api<{ channels: SlackChannel[]; response_metadata?: { next_cursor?: string } }>('conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, cursor })
    out.push(...page.channels)
    cursor = page.response_metadata?.next_cursor || undefined
    if (!cursor) break
  }
  const q = query.trim().toLowerCase().replace(/^#/, '')
  return out.filter((c) => !q || c.name.toLowerCase().includes(q)).sort((a, b) => Number(b.is_member) - Number(a.is_member) || a.name.localeCompare(b.name))
}
export async function history(channel: string, oldest?: string): Promise<SlackMessage[]> {
  const r = await api<{ messages: SlackMessage[] }>('conversations.history', { channel, oldest, limit: 200, inclusive: false })
  return r.messages.slice().reverse()
}
export async function replies(channel: string, ts: string, oldest?: string): Promise<SlackMessage[]> {
  const r = await api<{ messages: SlackMessage[] }>('conversations.replies', { channel, ts, oldest, limit: 200, inclusive: false })
  return r.messages.filter((m) => m.ts !== ts)
}
export async function permalink(channel: string, ts: string): Promise<string | undefined> {
  try {
    return (await api<{ permalink: string }>('chat.getPermalink', { channel, message_ts: ts })).permalink
  } catch {
    return undefined
  }
}
export async function post(channel: string, text: string, thread_ts?: string): Promise<string> {
  return (await api<{ ts: string }>('chat.postMessage', { channel, text, thread_ts })).ts
}
const names = new Map<string, string>()
export async function userName(id: string | undefined): Promise<string | undefined> {
  if (!id) return undefined
  const hit = names.get(id)
  if (hit) return hit
  try {
    const r = await api<{ user: { real_name?: string; name: string } }>('users.info', { user: id })
    const n = r.user.real_name || r.user.name
    names.set(id, n)
    return n
  } catch {
    return id
  }
}
