/**
 * Linear through Linear's hosted MCP server: OAuth with dynamic client registration (so nothing to
 * register by hand), tokens encrypted in the store, issue search and lookup through the MCP tools,
 * and the MCP URL + bearer token for agent sessions. One connection per space, or the app default.
 */
import { safeStorage } from 'electron'
import { presentAuthLink } from './auth-link'
import { createServer, type Server } from 'http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { getStore } from '../store'
import type { LinearIssue, LinearSettings } from '@shared/types'

const MCP_URL = 'https://mcp.linear.app/mcp'
const CALLBACK_PORT = 52918
const REDIRECT_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`
export { MCP_URL as LINEAR_MCP_URL }

// ---------- secrets ----------
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

// ---------- settings ----------
const EMPTY: LinearSettings = { connected: false, defaultQuery: '' }
export function linearSettings(connId: string): LinearSettings {
  const { settings, spaces } = getStore().get()
  if (!connId) return settings.linear ?? EMPTY
  return spaces.find((x) => x.id === connId)?.linear ?? EMPTY
}
export function updateLinearSettings(connId: string, patch: Partial<LinearSettings>): void {
  getStore().update((d) => {
    if (!connId) {
      d.settings.linear = { ...(d.settings.linear ?? EMPTY), ...patch }
      return
    }
    const sp = d.spaces.find((x) => x.id === connId)
    if (!sp) throw new Error('Unknown space')
    sp.linear = { ...(sp.linear ?? EMPTY), ...patch }
  })
}
/** The space's own connection when it has one, else the app default (''). */
export function connectionForSpace(spaceId: string | undefined): string {
  return spaceId && linearSettings(spaceId).connected ? spaceId : ''
}

// ---------- OAuth provider ----------
export class LinearReauthRequired extends Error {
  constructor(public readonly connId: string) {
    super('Linear login expired or was revoked. Reconnect it in Settings, Integrations, Linear.')
  }
}
class StoreOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined
  constructor(
    private readonly connId: string,
    private readonly interactive = false
  ) {}
  private k(name: string): string {
    return `linear:${this.connId || 'default'}:${name}`
  }
  get redirectUrl(): string {
    return REDIRECT_URL
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'Sinfonie', redirect_uris: [REDIRECT_URL], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'read write' }
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return readSecret<OAuthClientInformationMixed>(this.k('client'))
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    writeSecret(this.k('client'), info)
  }
  tokens(): OAuthTokens | undefined {
    return readSecret<OAuthTokens>(this.k('tokens'))
  }
  saveTokens(tokens: OAuthTokens): void {
    writeSecret(this.k('tokens'), tokens)
  }
  redirectToAuthorization(url: URL): void {
    if (!this.interactive) throw new LinearReauthRequired(this.connId)
    presentAuthLink('linear', this.connId, url.toString())
  }
  saveCodeVerifier(v: string): void {
    this.verifier = v
    writeSecret(this.k('verifier'), v)
  }
  codeVerifier(): string {
    const v = this.verifier ?? readSecret<string>(this.k('verifier'))
    if (!v) throw new Error('Missing PKCE verifier; start the Linear login again')
    return v
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') writeSecret(this.k('tokens'), undefined)
    if (scope === 'all' || scope === 'client') writeSecret(this.k('client'), undefined)
    if (scope === 'all' || scope === 'verifier') writeSecret(this.k('verifier'), undefined)
  }
}

// ---------- MCP client ----------
interface Conn {
  client: Client
  tools: Map<string, Record<string, unknown>>
}
const conns = new Map<string, Conn>()
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    )
  })
}
async function connect(connId: string): Promise<Conn> {
  const existing = conns.get(connId)
  if (existing) return existing
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: new StoreOAuthProvider(connId) })
  const c = new Client({ name: 'sinfonie', version: '0.1.0' })
  await withTimeout(c.connect(transport), 12_000, 'Connecting to the Linear MCP')
  const tools = await withTimeout(c.listTools(), 12_000, 'Listing Linear MCP tools')
  const conn: Conn = { client: c, tools: new Map(tools.tools.map((t) => [t.name, (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}])) }
  conns.set(connId, conn)
  return conn
}
function dropClient(connId: string): void {
  const c = conns.get(connId)
  if (c) void c.client.close().catch(() => undefined)
  conns.delete(connId)
}
async function callTool<T = unknown>(connId: string, name: string, args: Record<string, unknown>): Promise<T> {
  const { client: c } = await connect(connId)
  const res = await c.callTool({ name, arguments: args })
  const content = (res.content ?? []) as { type: string; text?: string }[]
  const text = content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n')
  if (res.isError) throw new Error(`Linear tool ${name} failed: ${text.slice(0, 300)}`)
  if (res.structuredContent) return res.structuredContent as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}
function toolNamed(conn: Conn, ...candidates: string[]): string | null {
  for (const n of candidates) if (conn.tools.has(n)) return n
  return null
}
/** Only pass arguments the tool actually declares; Linear's tool schemas are strict. */
function argsFor(conn: Conn, tool: string, wanted: Record<string, unknown>): Record<string, unknown> {
  const props = conn.tools.get(tool) ?? {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(wanted)) if (k in props && v !== undefined) out[k] = v
  return out
}

// ---------- public API ----------
let pendingCallback: { server: Server } | null = null

/** Opens the browser for approval and resolves once tokens are stored. */
export async function authenticate(connId: string): Promise<void> {
  dropClient(connId)
  if (pendingCallback) {
    pendingCallback.server.close()
    pendingCallback = null
  }
  const provider = new StoreOAuthProvider(connId, true)
  provider.invalidateCredentials('tokens')
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const err = url.searchParams.get('error')
      const c = url.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<!doctype html><meta charset=utf-8><body style="font-family:-apple-system,system-ui;background:#0f1115;color:#e6e8ec;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${err ? 'Linear login failed' : 'Sinfonie is connected to Linear'}</h2><p style="color:#8b93a1">${err ? `${err}: ${url.searchParams.get('error_description') ?? ''}` : 'You can close this window and go back to the app.'}</p></div>`)
      server.close()
      pendingCallback = null
      if (err || !c) reject(new Error(url.searchParams.get('error_description') || err || 'No authorization code returned'))
      else resolve(c)
    })
    server.on('error', (e) => reject(new Error(`Could not listen on port ${CALLBACK_PORT} for the Linear callback: ${e.message}`)))
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      pendingCallback = { server }
      const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider })
      const probe = new Client({ name: 'sinfonie', version: '0.1.0' })
      probe
        .connect(transport)
        .then(() => {
          server.close()
          pendingCallback = null
          void probe.close()
          resolve('')
        })
        .catch((e: unknown) => {
          if (!(e instanceof UnauthorizedError)) {
            server.close()
            pendingCallback = null
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        })
      setTimeout(() => {
        if (pendingCallback?.server === server) {
          server.close()
          pendingCallback = null
          reject(new Error('Linear login timed out after 5 minutes'))
        }
      }, 5 * 60 * 1000).unref()
    })
  })
  if (code) {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider })
    await transport.finishAuth(code)
  }
  updateLinearSettings(connId, { connected: true, connectedAt: new Date().toISOString() })
  // Learn who we are, for the settings page; not fatal when a tool is missing.
  try {
    const conn = await connect(connId)
    const me = toolNamed(conn, 'get_user', 'get_viewer', 'me')
    if (me) {
      const r = await callTool<Record<string, unknown>>(connId, me, argsFor(conn, me, { query: 'me', id: 'me' }))
      const name = (r?.name ?? r?.displayName ?? (r as { user?: { name?: string } })?.user?.name) as string | undefined
      const org = ((r as { organization?: { name?: string } })?.organization?.name ?? (r as { organizationName?: string })?.organizationName) as string | undefined
      updateLinearSettings(connId, { userName: name, orgName: org })
    }
  } catch (err) {
    console.warn('[linear] identity lookup failed', err)
  }
}

export async function accessToken(connId: string): Promise<string | null> {
  if (!linearSettings(connId).connected) return null
  try {
    await withTimeout(connect(connId), 10_000, 'Linear token refresh')
  } catch (err) {
    dropClient(connId)
    if (err instanceof LinearReauthRequired || err instanceof UnauthorizedError) {
      updateLinearSettings(connId, { connected: false, connectedAt: undefined })
      throw new LinearReauthRequired(connId)
    }
    console.warn('Linear MCP connect for token failed', err)
    return null
  }
  return new StoreOAuthProvider(connId).tokens()?.access_token ?? null
}

export function disconnect(connId: string): void {
  dropClient(connId)
  new StoreOAuthProvider(connId).invalidateCredentials('all')
  updateLinearSettings(connId, { connected: false, connectedAt: undefined, userName: undefined, orgName: undefined })
}

// ---------- issues ----------
type Raw = Record<string, unknown>
function str(v: unknown): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object' && v && 'name' in v) return String((v as { name: unknown }).name ?? '')
  return undefined
}
function toIssue(r: Raw): LinearIssue | null {
  const identifier = str(r.identifier) ?? str(r.key)
  if (!identifier) return null
  const priority = r.priorityLabel ?? r.priority
  return {
    id: str(r.id) ?? identifier,
    identifier,
    title: str(r.title) ?? '',
    state: str(r.state) ?? str(r.status) ?? '',
    priority: typeof priority === 'number' ? ['none', 'urgent', 'high', 'medium', 'low'][priority] : str(priority),
    assignee: str(r.assignee),
    updated: str(r.updatedAt),
    url: str(r.url) ?? '',
    ...(typeof r.description === 'string' ? { description: r.description } : {})
  }
}
function listFrom(raw: unknown): Raw[] {
  if (Array.isArray(raw)) return raw as Raw[]
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    for (const k of ['issues', 'nodes', 'results', 'data', 'items']) if (Array.isArray(o[k])) return o[k] as Raw[]
    if (o.identifier) return [o]
  }
  if (typeof raw === 'string') {
    // Some tools answer with prose; pull "ENG-123: title" lines out of it as a last resort.
    return Array.from(raw.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b[:\s-]+([^\n]+)/g)).map((m) => ({ identifier: m[1], title: m[2].trim() }))
  }
  return []
}

/** Empty query lists the default filter (your open issues); an identifier looks it up; anything else is a text search. */
export async function search(connId: string, query: string): Promise<LinearIssue[]> {
  const q = query.trim() || linearSettings(connId).defaultQuery.trim()
  const conn = await connect(connId)
  if (/^[A-Z][A-Z0-9]*-\d+$/i.test(q)) return [await issue(connId, q.toUpperCase())]
  if (!q) {
    const mine = toolNamed(conn, 'list_my_issues')
    if (mine) return listFrom(await callTool(connId, mine, argsFor(conn, mine, { limit: 30, includeCompleted: false }))).map(toIssue).filter((x): x is LinearIssue => Boolean(x))
  }
  const list = toolNamed(conn, 'list_issues', 'search_issues')
  if (!list) throw new Error(`Linear MCP has no issue list tool. Available: ${Array.from(conn.tools.keys()).join(', ')}`)
  const raw = await callTool(connId, list, argsFor(conn, list, { query: q || undefined, assignee: q ? undefined : 'me', assigneeId: q ? undefined : 'me', limit: 30, includeArchived: false, orderBy: 'updatedAt' }))
  return listFrom(raw).map(toIssue).filter((x): x is LinearIssue => Boolean(x))
}

export async function issue(connId: string, identifier: string): Promise<LinearIssue> {
  const conn = await connect(connId)
  const get = toolNamed(conn, 'get_issue')
  if (!get) throw new Error('Linear MCP has no get_issue tool.')
  const raw = await callTool<Raw>(connId, get, argsFor(conn, get, { id: identifier, identifier, issueId: identifier, includeRelations: false }))
  const found = toIssue(raw) ?? toIssue((raw as { issue?: Raw }).issue ?? {})
  if (!found) throw new Error(`Linear returned no issue for ${identifier}`)
  return found
}
