/**
 * Slack for the on-call agent: OAuth against Slack's hosted MCP server (user-scoped token), the
 * Web API for deterministic polling and posting, and the MCP URL + bearer token for agent sessions.
 * Slack has no dynamic client registration, so the user supplies a client id/secret from a Slack app.
 */
import { shell, safeStorage } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { getStore } from '../store'
import type { SlackConnection } from '@shared/types'

export const SLACK_MCP_URL = 'https://mcp.slack.com/mcp'
export const REDIRECT_URL = 'https://sinfonie.dev/oauth/slack/callback'
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

export function connection(): SlackConnection {
  const s = getStore().get().settings.slack
  return { connected: false, hasClient: Boolean(readSecret(k('client'))), ...(s ?? {}) }
}
function patchConnection(patch: Partial<SlackConnection>): SlackConnection {
  getStore().update((d) => {
    d.settings.slack = { ...connection(), ...patch }
  })
  return connection()
}
const k = (name: string): string => `slack:${name}`

class SlackOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined
  constructor(private readonly interactive: boolean) {}
  get redirectUrl(): string {
    return REDIRECT_URL
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'Sinfonie', redirect_uris: [REDIRECT_URL], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post', scope: SCOPES.join(' ') }
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return readSecret<OAuthClientInformationMixed>(k('client'))
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    writeSecret(k('client'), info)
  }
  tokens(): OAuthTokens | undefined {
    return readSecret<OAuthTokens>(k('tokens'))
  }
  saveTokens(tokens: OAuthTokens): void {
    writeSecret(k('tokens'), tokens)
  }
  redirectToAuthorization(url: URL): void {
    if (!this.interactive) throw new Error('Slack login expired or was revoked. Reconnect it in Settings → On call.')
    void shell.openExternal(url.toString())
  }
  saveCodeVerifier(v: string): void {
    this.verifier = v
    writeSecret(k('verifier'), v)
  }
  codeVerifier(): string {
    const v = this.verifier ?? readSecret<string>(k('verifier'))
    if (!v) throw new Error('Missing PKCE verifier; start the Slack login again')
    return v
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') writeSecret(k('tokens'), undefined)
    if (scope === 'all' || scope === 'verifier') writeSecret(k('verifier'), undefined)
    // The client id/secret came from the user; never drop them on a token problem.
  }
}

// ---------- OAuth ----------

export function setClient(clientId: string, clientSecret: string): SlackConnection {
  writeSecret(k('client'), { client_id: clientId.trim(), client_secret: clientSecret.trim() })
  return patchConnection({ hasClient: true, clientId: clientId.trim() })
}

/**
 * Opens the browser for approval. The code comes back through sinfonie://oauth/slack or is pasted by the user.
 * The URL is built here rather than by the MCP SDK, which would request every scope Slack advertises (30 of them,
 * write scopes included) and fail unless the user's app listed them all.
 */
export async function startAuth(): Promise<void> {
  const client = readSecret<{ client_id: string }>(k('client'))
  if (!client) throw new Error('Enter the Slack app client id and secret first.')
  const provider = new SlackOAuthProvider(true)
  provider.invalidateCredentials('tokens')
  dropClient()
  const verifier = randomBytes(48).toString('base64url')
  provider.saveCodeVerifier(verifier)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const url = new URL('https://slack.com/oauth/v2_user/authorize')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', client.client_id)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('redirect_uri', REDIRECT_URL)
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('resource', 'https://mcp.slack.com/')
  url.searchParams.set('state', randomBytes(12).toString('base64url'))
  await shell.openExternal(url.toString())
}

export async function finishAuth(code: string): Promise<SlackConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(SLACK_MCP_URL), { authProvider: new SlackOAuthProvider(true) })
  await transport.finishAuth(code.trim())
  return afterAuth()
}

async function afterAuth(): Promise<SlackConnection> {
  const me = await api<{ team: string; user: string; user_id: string; team_id: string }>('auth.test', {})
  return patchConnection({ connected: true, connectedAt: new Date().toISOString(), teamName: me.team, userName: me.user, userId: me.user_id })
}

export function disconnect(): SlackConnection {
  new SlackOAuthProvider(false).invalidateCredentials('tokens')
  dropClient()
  return patchConnection({ connected: false, teamName: undefined, userName: undefined, userId: undefined })
}

// ---------- tokens ----------

let client: Client | null = null
function dropClient(): void {
  if (client) void client.close().catch(() => undefined)
  client = null
}
/** A valid access token; connecting to the MCP server refreshes it when needed. */
export async function accessToken(): Promise<string> {
  const provider = new SlackOAuthProvider(false)
  const t = provider.tokens()
  if (!t) throw new Error('Slack is not connected. Connect it in Settings → On call.')
  if (!client) {
    const transport = new StreamableHTTPClientTransport(new URL(SLACK_MCP_URL), { authProvider: provider })
    const c = new Client({ name: 'sinfonie', version: '0.1.0' })
    try {
      await c.connect(transport)
      client = c
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        patchConnection({ connected: false })
        throw new Error('Slack login expired or was revoked. Reconnect it in Settings → On call.')
      }
      // The MCP handshake failed for another reason; the stored token may still be fine for the Web API.
      console.warn('[slack] mcp connect failed', err)
    }
  }
  return provider.tokens()?.access_token ?? t.access_token
}

/** For agent sessions: Slack's MCP server with the user's bearer token. */
export async function mcpServerConfig(): Promise<{ type: 'http'; url: string; headers: Record<string, string> }> {
  return { type: 'http', url: SLACK_MCP_URL, headers: { Authorization: `Bearer ${await accessToken()}` } }
}

// ---------- Web API ----------

export async function api<T>(method: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
  const token = await accessToken()
  const body = new URLSearchParams()
  for (const [key, v] of Object.entries(params)) if (v !== undefined) body.set(key, String(v))
  const res = await fetch(`https://slack.com/api/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  const json = (await res.json()) as { ok: boolean; error?: string } & T
  if (!json.ok) {
    if (json.error === 'token_revoked' || json.error === 'invalid_auth' || json.error === 'token_expired') {
      dropClient()
      if (json.error !== 'token_expired') patchConnection({ connected: false })
    }
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
