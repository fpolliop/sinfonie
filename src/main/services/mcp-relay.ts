/**
 * A local relay in front of the OAuth MCP servers Sinfonie signs in to (Atlassian, Linear).
 *
 * Agent sessions (the SDK, the CLI, ACP agents, native workers) used to get the remote URL plus a
 * static bearer, which they cannot refresh: an hour later every Jira call failed until the session
 * was rebuilt. They now get http://127.0.0.1:<port>/relay/<secret>/<service>/<connection>, and the
 * relay adds a fresh token to each request, refreshing and retrying once on a 401. Bodies and
 * event streams pass through untouched.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, timingSafeEqual } from 'crypto'
import { Readable } from 'stream'
import * as jira from './jira'
import * as linear from './linear'

type Service = 'jira' | 'linear'
const UPSTREAM: Record<Service, { url: string; token: (connId: string, force: boolean, stale?: string) => Promise<string>; label: string }> = {
  jira: { url: jira.JIRA_MCP_URL, token: jira.tokenFor, label: 'Jira' },
  linear: { url: linear.LINEAR_MCP_URL, token: linear.tokenFor, label: 'Linear' }
}

const secret = randomBytes(18).toString('hex')
let server: Server | null = null
let starting: Promise<number> | null = null

const PASS_REQUEST = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']
const PASS_RESPONSE = ['content-type', 'mcp-session-id', 'cache-control', 'retry-after']

function sameSecret(s: string): boolean {
  const a = Buffer.from(s)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

/** A JSON-RPC error the MCP client shows as the tool's failure, instead of a bare HTTP status. */
function fail(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) return void res.end()
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: text } }))
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const m = /^\/relay\/([^/]+)\/(jira|linear)\/([^/?]*)/.exec(req.url ?? '')
  if (!m || !sameSecret(m[1])) return fail(res, 404, 'Not found')
  const service = m[2] as Service
  const connId = decodeURIComponent(m[3]) === 'default' ? '' : decodeURIComponent(m[3])
  const up = UPSTREAM[service]
  const body = req.method === 'POST' ? await readBody(req) : undefined
  const headers: Record<string, string> = {}
  for (const h of PASS_REQUEST) {
    const v = req.headers[h]
    if (typeof v === 'string') headers[h] = v
  }
  const abort = new AbortController()
  res.on('close', () => abort.abort())
  const send = (tok: string) => fetch(up.url, { method: req.method, headers: { ...headers, Authorization: `Bearer ${tok}` }, body, signal: abort.signal })

  let upstream: Response
  try {
    let tok = await up.token(connId, false)
    upstream = await send(tok)
    if (upstream.status === 401) {
      tok = await up.token(connId, true, tok)
      upstream = await send(tok)
    }
  } catch (err) {
    if (abort.signal.aborted) return
    const reauth = err instanceof jira.JiraReauthRequired || err instanceof linear.LinearReauthRequired
    // Not a 401: that would make the client start its own OAuth sign-in against this relay.
    return fail(res, reauth ? 403 : 502, reauth ? `${up.label} login expired. Reconnect ${up.label} in Sinfonie's Settings, Integrations.` : `${up.label} is unreachable right now (${err instanceof Error ? err.message : String(err)}). Try again in a moment.`)
  }
  const out: Record<string, string> = {}
  for (const h of PASS_RESPONSE) {
    const v = upstream.headers.get(h)
    if (v) out[h] = v
  }
  // Still refused with a fresh token: the account lost access. Say so rather than inviting a sign-in here.
  if (upstream.status === 401) return fail(res, 403, `${up.label} refused Sinfonie's login. Reconnect ${up.label} in Sinfonie's Settings, Integrations.`)
  res.writeHead(upstream.status, out)
  if (!upstream.body) return void res.end()
  Readable.fromWeb(upstream.body as import('stream/web').ReadableStream).on('error', () => res.end()).pipe(res)
}

async function port(): Promise<number> {
  if (server) return (server.address() as AddressInfo).port
  starting ??= new Promise<number>((resolve, reject) => {
    const s = createServer((req, res) => {
      void handle(req, res).catch((err) => fail(res, 500, String(err)))
    })
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      server = s
      resolve((s.address() as AddressInfo).port)
    })
  })
  return starting
}

/** The local URL an agent session uses for this service's MCP, for one connection. */
export async function relayUrl(service: Service, connId: string): Promise<string> {
  return `http://127.0.0.1:${await port()}/relay/${secret}/${service}/${encodeURIComponent(connId || 'default')}`
}

export function stop(): void {
  server?.close()
  server = null
  starting = null
}
