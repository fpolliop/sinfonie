import { safeStorage, shell } from 'electron'
import { createServer, type Server } from 'http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { JiraIssue, Settings, StoreData } from '@shared/types'
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
type SecretKey = keyof NonNullable<StoreData['secrets']>
function readSecret<T>(key: SecretKey): T | undefined {
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
    const s = d.secrets as Record<string, string | undefined>
    if (value === undefined) delete s[key]
    else s[key] = encrypt(JSON.stringify(value))
  })
}

// ---------- OAuth provider backed by the store ----------

class StoreOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined
  get redirectUrl(): string {
    return REDIRECT_URL
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Orchestra',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return readSecret<OAuthClientInformationMixed>('jiraOAuthClient')
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    writeSecret('jiraOAuthClient', info)
  }
  tokens(): OAuthTokens | undefined {
    return readSecret<OAuthTokens>('jiraOAuthTokens')
  }
  saveTokens(tokens: OAuthTokens): void {
    writeSecret('jiraOAuthTokens', tokens)
  }
  redirectToAuthorization(url: URL): void {
    void shell.openExternal(url.toString())
  }
  saveCodeVerifier(v: string): void {
    this.verifier = v
    writeSecret('jiraOAuthVerifier', v)
  }
  codeVerifier(): string {
    const v = this.verifier ?? readSecret<string>('jiraOAuthVerifier')
    if (!v) throw new Error('Missing PKCE verifier; start the Jira login again')
    return v
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') writeSecret('jiraOAuthTokens', undefined)
    if (scope === 'all' || scope === 'client') writeSecret('jiraOAuthClient', undefined)
    if (scope === 'all' || scope === 'verifier') writeSecret('jiraOAuthVerifier', undefined)
  }
}

// ---------- MCP client ----------

let client: Client | null = null
let toolSchemas: Map<string, Record<string, unknown>> | null = null
let cloudId: string | null = null

async function connect(): Promise<Client> {
  if (client) return client
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: new StoreOAuthProvider() })
  const c = new Client({ name: 'orchestra', version: '0.1.0' })
  await c.connect(transport)
  const tools = await c.listTools()
  toolSchemas = new Map(tools.tools.map((t) => [t.name, (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}]))
  client = c
  return c
}

function dropClient(): void {
  void client?.close().catch(() => undefined)
  client = null
  toolSchemas = null
  cloudId = null
}

async function callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const c = await connect()
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
function toolNamed(...candidates: string[]): string {
  for (const n of candidates) if (toolSchemas?.has(n)) return n
  throw new Error(`Atlassian MCP has no tool named ${candidates.join(' or ')}. Available: ${Array.from(toolSchemas?.keys() ?? []).join(', ')}`)
}

async function ensureCloudId(): Promise<string> {
  if (cloudId) return cloudId
  await connect()
  const raw = await callTool<unknown>(toolNamed('getAccessibleAtlassianResources'), {})
  const list = (Array.isArray(raw) ? raw : (raw as { resources?: unknown[] })?.resources ?? []) as { id: string; url?: string; name?: string }[]
  if (list.length === 0) throw new Error('Your Atlassian account has no Jira sites.')
  const { settings } = getStore().get()
  const want = settings.jira.siteUrl.replace(/\/+$/, '')
  const pick = (want && list.find((r) => r.url?.replace(/\/+$/, '') === want)) || list[0]
  cloudId = pick.id
  getStore().update((d) => {
    d.settings.jira.siteUrl = pick.url ?? d.settings.jira.siteUrl
    d.settings.jira.siteName = pick.name ?? d.settings.jira.siteName
  })
  return cloudId
}

// ---------- public API ----------

let pendingCallback: { server: Server; resolve: (code: string) => void; reject: (e: Error) => void } | null = null

/** Opens the browser for approval and resolves once tokens are stored. */
export async function authenticate(): Promise<Settings> {
  dropClient()
  if (pendingCallback) {
    pendingCallback.server.close()
    pendingCallback = null
  }
  const provider = new StoreOAuthProvider()
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
        `<!doctype html><meta charset=utf-8><body style="font-family:-apple-system,system-ui;background:#0f1115;color:#e6e8ec;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${err ? 'Jira login failed' : 'Orchestra is connected to Jira'}</h2><p style="color:#8b93a1">${err ? `${err}: ${url.searchParams.get('error_description') ?? ''}` : 'You can close this window and go back to the app.'}</p></div>`
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
      const probe = new Client({ name: 'orchestra', version: '0.1.0' })
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
  await ensureCloudId()
  return getStore().update((d) => {
    d.settings.jira.connected = true
    d.settings.jira.connectedAt = new Date().toISOString()
  }).settings
}

export function disconnect(): Settings {
  dropClient()
  new StoreOAuthProvider().invalidateCredentials('all')
  return getStore().update((d) => {
    d.settings.jira.connected = false
    delete d.settings.jira.connectedAt
    delete d.settings.jira.siteName
  }).settings
}

export function saveToken(token: string): Settings {
  return getStore().update((d) => {
    d.secrets = d.secrets ?? {}
    if (token.trim()) {
      d.secrets.jiraToken = encrypt(token.trim())
      d.settings.jira.hasToken = true
    } else {
      delete d.secrets.jiraToken
      d.settings.jira.hasToken = false
    }
  }).settings
}

const FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'updated']

function buildJql(query: string): string {
  const q = query.trim()
  const { settings } = getStore().get()
  if (!q) return settings.jira.defaultJql
  if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(q)) return `key = "${q.toUpperCase()}"`
  return `text ~ "${q.replace(/"/g, '\\"')}*" AND statusCategory != Done ORDER BY updated DESC`
}

function useOAuth(): boolean {
  return getStore().get().settings.jira.connected
}

/** Empty query lists the configured default JQL; an issue key looks it up; anything else is a text search. */
export async function search(query: string): Promise<JiraIssue[]> {
  const jql = buildJql(query)
  if (useOAuth()) {
    const id = await ensureCloudId()
    const raw = await callTool<{ issues?: RawIssue[] }>(toolNamed('searchJiraIssuesUsingJql'), { cloudId: id, jql, fields: FIELDS, maxResults: 30 })
    const base = getStore().get().settings.jira.siteUrl.replace(/\/+$/, '')
    return (raw.issues ?? []).map((r) => toIssue(base, r))
  }
  const { base } = restClient()
  const data = await restGet<{ issues: RawIssue[] }>(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${FIELDS.join(',')}&maxResults=30`)
  return (data.issues ?? []).map((r) => toIssue(base, r))
}

export async function issue(key: string): Promise<JiraIssue> {
  if (useOAuth()) {
    const id = await ensureCloudId()
    const r = await callTool<RawIssue>(toolNamed('getJiraIssue'), { cloudId: id, issueIdOrKey: key, fields: [...FIELDS, 'description'] })
    const base = getStore().get().settings.jira.siteUrl.replace(/\/+$/, '')
    return { ...toIssue(base, r), description: adfToText(r.fields?.description) }
  }
  const { base } = restClient()
  const r = await restGet<RawIssue>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(',')},description`)
  return { ...toIssue(base, r), description: adfToText(r.fields?.description) }
}

// ---------- REST fallback (API token) ----------

function restClient(): { base: string; headers: Record<string, string> } {
  const { settings, secrets } = getStore().get()
  const { siteUrl, email } = settings.jira
  if (!siteUrl || !email || !secrets?.jiraToken) throw new Error('Jira is not connected. Use "Authenticate with Jira" in Settings, or add a site URL, email and API token.')
  const base = siteUrl.replace(/\/+$/, '')
  const auth = Buffer.from(`${email}:${decrypt(secrets.jiraToken)}`, 'utf8').toString('base64')
  return { base, headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
}

async function restGet<T>(path: string): Promise<T> {
  const { base, headers } = restClient()
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
