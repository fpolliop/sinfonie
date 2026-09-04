import { safeStorage, shell } from 'electron'
import { createServer, type Server } from 'http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { JiraIssue, JiraSettings } from '@shared/types'
import { getStore } from '../store'

/**
 * Jira access with two backends:
 *  - OAuth through Atlassian's hosted MCP server (the same flow Claude Code
 *    uses): "Authenticate with Jira" opens the browser, the user approves,
 *    tokens come back to a localhost callback. No API token, no app setup.
 *  - A personal API token against the REST API, as a fallback.
 */

const MCP_URL = 'https://mcp.atlassian.com/v1/mcp'
const CALLBACK_PORT = 52917
const REDIRECT_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`

// ---------- secret storage ----------

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

/** Where a connection's settings live: the global Settings for '', else the space. */
export function jiraSettings(connId: string): JiraSettings {
  const { settings, spaces } = getStore().get()
  if (!connId) return settings.jira
  const sp = spaces.find((x) => x.id === connId)
  return sp?.jira ?? { connected: false, siteUrl: '', email: '', hasToken: false, defaultJql: settings.jira.defaultJql }
}

export function updateJiraSettings(connId: string, patch: Partial<JiraSettings>): void {
  getStore().update((d) => {
    if (!connId) {
      Object.assign(d.settings.jira, patch)
      return
    }
    const sp = d.spaces.find((x) => x.id === connId)
    if (!sp) throw new Error('Unknown space')
    sp.jira = { ...(sp.jira ?? { connected: false, siteUrl: '', email: '', hasToken: false, defaultJql: d.settings.jira.defaultJql }), ...patch }
  })
}

/** Which connection a workspace should use: its space's own, when that space has one set up. */
export function connectionForSpace(spaceId: string | undefined): string {
  if (!spaceId) return ''
  const j = jiraSettings(spaceId)
  return j.connected || (j.siteUrl && j.email && j.hasToken) ? spaceId : ''
}

// ---------- OAuth provider backed by the store ----------

class StoreOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined
  constructor(private readonly connId: string) {}
  private k(name: string): string {
    return `jira:${this.connId || 'default'}:${name}`
  }
  get redirectUrl(): string {
    return REDIRECT_URL
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Sinfonie',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
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
    void shell.openExternal(url.toString())
  }
  saveCodeVerifier(v: string): void {
    this.verifier = v
    writeSecret(this.k('verifier'), v)
  }
  codeVerifier(): string {
    const v = this.verifier ?? readSecret<string>(this.k('verifier'))
    if (!v) throw new Error('Missing PKCE verifier; start the Jira login again')
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
  cloudId: string | null
}
const conns = new Map<string, Conn>()

async function connect(connId: string): Promise<Conn> {
  const existing = conns.get(connId)
  if (existing) return existing
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: new StoreOAuthProvider(connId) })
  const c = new Client({ name: 'sinfonie', version: '0.1.0' })
  await c.connect(transport)
  const tools = await c.listTools()
  const conn: Conn = { client: c, tools: new Map(tools.tools.map((t) => [t.name, (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}])), cloudId: null }
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
  if (res.isError) throw new Error(`Jira tool ${name} failed: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

/** Which tool exposes what: Atlassian names its tools by verb; look them up so a rename upstream fails loudly instead of silently. */
function toolNamed(conn: Conn, ...candidates: string[]): string {
  for (const n of candidates) if (conn.tools.has(n)) return n
  throw new Error(`Atlassian MCP has no tool named ${candidates.join(' or ')}. Available: ${Array.from(conn.tools.keys()).join(', ')}`)
}

async function ensureCloudId(connId: string): Promise<string> {
  const conn = await connect(connId)
  if (conn.cloudId) return conn.cloudId
  const raw = await callTool<unknown>(connId, toolNamed(conn, 'getAccessibleAtlassianResources'), {})
  const list = (Array.isArray(raw) ? raw : (raw as { resources?: unknown[] })?.resources ?? []) as { id: string; url?: string; name?: string }[]
  if (list.length === 0) throw new Error('Your Atlassian account has no Jira sites.')
  const want = jiraSettings(connId).siteUrl.replace(/\/+$/, '')
  const pick = (want && list.find((r) => r.url?.replace(/\/+$/, '') === want)) || list[0]
  conn.cloudId = pick.id
  updateJiraSettings(connId, { siteUrl: pick.url ?? jiraSettings(connId).siteUrl, siteName: pick.name ?? jiraSettings(connId).siteName })
  return conn.cloudId
}

// ---------- public API ----------

let pendingCallback: { server: Server; resolve: (code: string) => void; reject: (e: Error) => void } | null = null

/** Opens the browser for approval and resolves once tokens are stored. */
export async function authenticate(connId: string): Promise<void> {
  dropClient(connId)
  if (pendingCallback) {
    pendingCallback.server.close()
    pendingCallback = null
  }
  const provider = new StoreOAuthProvider(connId)
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
      res.end(
        `<!doctype html><meta charset=utf-8><body style="font-family:-apple-system,system-ui;background:#0f1115;color:#e6e8ec;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${err ? 'Jira login failed' : 'Sinfonie is connected to Jira'}</h2><p style="color:#8b93a1">${err ? `${err}: ${url.searchParams.get('error_description') ?? ''}` : 'You can close this window and go back to the app.'}</p></div>`
      )
      server.close()
      pendingCallback = null
      if (err || !c) reject(new Error(url.searchParams.get('error_description') || err || 'No authorization code returned'))
      else resolve(c)
    })
    server.on('error', (e) => reject(new Error(`Could not listen on port ${CALLBACK_PORT} for the Jira callback: ${e.message}`)))
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      pendingCallback = { server, resolve, reject }
      // Kicks off discovery + registration + PKCE, then opens the browser and throws UnauthorizedError.
      const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider })
      const probe = new Client({ name: 'sinfonie', version: '0.1.0' })
      probe
        .connect(transport)
        .then(() => {
          // Already authorised (valid refresh token): nothing to approve.
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
          reject(new Error('Jira login timed out after 5 minutes'))
        }
      }, 5 * 60 * 1000).unref()
    })
  })

  if (code) {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider })
    await transport.finishAuth(code)
  }
  updateJiraSettings(connId, { connected: true, connectedAt: new Date().toISOString() })
  await ensureCloudId(connId)
}

/** A currently valid Atlassian access token for this connection (connecting refreshes it when needed). */
export async function accessToken(connId: string): Promise<string | null> {
  if (!jiraSettings(connId).connected) return null
  try {
    await connect(connId)
  } catch (err) {
    console.warn('Jira MCP connect for token failed', err)
    return null
  }
  return new StoreOAuthProvider(connId).tokens()?.access_token ?? null
}

export { MCP_URL as JIRA_MCP_URL }

export function disconnect(connId: string): void {
  dropClient(connId)
  new StoreOAuthProvider(connId).invalidateCredentials('all')
  updateJiraSettings(connId, { connected: false, connectedAt: undefined, siteName: undefined })
}

export function saveToken(connId: string, token: string): void {
  const key = `jira:${connId || 'default'}:apitoken`
  if (token.trim()) {
    writeSecret(key, token.trim())
    updateJiraSettings(connId, { hasToken: true })
  } else {
    writeSecret(key, undefined)
    updateJiraSettings(connId, { hasToken: false })
  }
}

const FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'updated']

function buildJql(connId: string, query: string): string {
  const q = query.trim()
  if (!q) return jiraSettings(connId).defaultJql || getStore().get().settings.jira.defaultJql
  if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(q)) return `key = "${q.toUpperCase()}"`
  return `text ~ "${q.replace(/"/g, '\\"')}*" AND statusCategory != Done ORDER BY updated DESC`
}

function useOAuth(connId: string): boolean {
  return jiraSettings(connId).connected
}

/** Empty query lists the configured default JQL; an issue key looks it up; anything else is a text search. */
export async function search(connId: string, query: string): Promise<JiraIssue[]> {
  const jql = buildJql(connId, query)
  if (useOAuth(connId)) {
    const id = await ensureCloudId(connId)
    const conn = await connect(connId)
    const raw = await callTool<{ issues?: RawIssue[] }>(connId, toolNamed(conn, 'searchJiraIssuesUsingJql'), { cloudId: id, jql, fields: FIELDS, maxResults: 30 })
    const base = jiraSettings(connId).siteUrl.replace(/\/+$/, '')
    return (raw.issues ?? []).map((r) => toIssue(base, r))
  }
  const { base } = restClient(connId)
  const data = await restGet<{ issues: RawIssue[] }>(connId, `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${FIELDS.join(',')}&maxResults=30`)
  return (data.issues ?? []).map((r) => toIssue(base, r))
}

export async function issue(connId: string, key: string): Promise<JiraIssue> {
  if (useOAuth(connId)) {
    const id = await ensureCloudId(connId)
    const conn = await connect(connId)
    const r = await callTool<RawIssue>(connId, toolNamed(conn, 'getJiraIssue'), { cloudId: id, issueIdOrKey: key, fields: [...FIELDS, 'description'] })
    const base = jiraSettings(connId).siteUrl.replace(/\/+$/, '')
    return { ...toIssue(base, r), description: adfToText(r.fields?.description) }
  }
  const { base } = restClient(connId)
  const r = await restGet<RawIssue>(connId, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(',')},description`)
  return { ...toIssue(base, r), description: adfToText(r.fields?.description) }
}

// ---------- REST fallback (API token) ----------

function restClient(connId: string): { base: string; headers: Record<string, string> } {
  const { siteUrl, email } = jiraSettings(connId)
  const token = readSecret<string>(`jira:${connId || 'default'}:apitoken`)
  if (!siteUrl || !email || !token) throw new Error('Jira is not connected. Use "Authenticate with Jira" in Settings or the space settings, or add a site URL, email and API token.')
  const base = siteUrl.replace(/\/+$/, '')
  const auth = Buffer.from(`${email}:${token}`, 'utf8').toString('base64')
  return { base, headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
}

async function restGet<T>(connId: string, path: string): Promise<T> {
  const { base, headers } = restClient(connId)
  const res = await fetch(`${base}${path}`, { headers })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Jira ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
  return (await res.json()) as T
}

// ---------- shared shapes ----------

interface RawIssue {
  key: string
  fields?: {
    summary?: string
    status?: { name?: string }
    issuetype?: { name?: string }
    priority?: { name?: string }
    assignee?: { displayName?: string } | null
    updated?: string
    description?: unknown
  }
}

function toIssue(base: string, r: RawIssue): JiraIssue {
  const f = r.fields ?? {}
  return {
    key: r.key,
    summary: f.summary ?? '',
    status: f.status?.name ?? '',
    type: f.issuetype?.name ?? '',
    priority: f.priority?.name,
    assignee: f.assignee?.displayName ?? undefined,
    updated: f.updated,
    url: `${base}/browse/${r.key}`
  }
}

/** Atlassian Document Format -> readable plain text. Good enough for a prompt. Markdown strings pass through. */
export function adfToText(node: unknown, depth = 0): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> }
  if (n.type === 'text') return n.text ?? ''
  if (n.type === 'hardBreak') return '\n'
  if (n.type === 'mention') return `@${String(n.attrs?.text ?? '')}`
  if (n.type === 'inlineCard') return String(n.attrs?.url ?? '')
  const children = (n.content ?? []).map((c) => adfToText(c, depth + 1))
  switch (n.type) {
    case 'paragraph':
      return children.join('') + '\n'
    case 'heading':
      return `\n${'#'.repeat(Number(n.attrs?.level ?? 1))} ${children.join('')}\n`
    case 'bulletList':
    case 'orderedList':
      return children.join('')
    case 'listItem':
      return `- ${children.join('').trim()}\n`
    case 'codeBlock':
      return `\n\`\`\`\n${children.join('')}\n\`\`\`\n`
    case 'blockquote':
      return children.map((c) => `> ${c}`).join('')
    case 'rule':
      return '\n---\n'
    default:
      return children.join('')
  }
}
