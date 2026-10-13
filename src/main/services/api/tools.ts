/**
 * API explorer, phase 3: the workspace's endpoints as agent tools, and telling the agent when its
 * edits changed them.
 *
 * - `api_endpoints` lists what discovery found (the same list as the API pane).
 * - `api_request` calls the workspace's running app through the same runner as the pane: local
 *   only, auth from Request settings, and recorded in the pane's history marked as the agent's.
 * - After a turn that edited a route-like file, discovery reruns and the difference is shown in the
 *   chat and handed to the agent with the next message.
 */
import { z } from 'zod'
import { createSdkMcpServer, tool as sdkTool, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { ApiDiscovery, ApiEndpoint } from '@shared/types'
import { discover } from './discover'
import * as requests from './requests'

const LIST_MAX = 150
const BODY_MAX = 20_000

function line(e: ApiEndpoint): string {
  const where = [e.repoName, e.service].filter(Boolean).join('/')
  const at = e.file ? ` · ${e.file.split('/').slice(-2).join('/')}${e.line ? `:${e.line}` : ''}` : ''
  return `${e.method} ${e.path}${e.summary ? ` — ${e.summary}` : ''} (${where}${at})`
}

async function listText(workspaceId: string, filter?: string, repo?: string, refresh?: boolean): Promise<string> {
  const d = await discover(workspaceId, Boolean(refresh))
  remember(workspaceId, d)
  const needle = filter?.trim().toLowerCase()
  const rows = d.endpoints.filter((e) => (!repo || e.repoName === repo) && (!needle || `${e.method} ${e.path} ${e.summary ?? ''} ${e.group ?? ''} ${e.service}`.toLowerCase().includes(needle)))
  if (!rows.length) return d.endpoints.length ? `No endpoints match${filter ? ` "${filter}"` : ''}${repo ? ` in ${repo}` : ''}. ${d.endpoints.length} endpoints in total.` : 'No HTTP endpoints were found in this workspace (OpenAPI files, the running app, NestJS, Next.js, FastAPI and Express routes were checked).'
  const head = `${rows.length} endpoint${rows.length === 1 ? '' : 's'}${rows.length > LIST_MAX ? `, first ${LIST_MAX} shown; narrow with filter or repo` : ''}. The running app is http://localhost:${d.port}.`
  return [head, ...rows.slice(0, LIST_MAX).map(line)].join('\n')
}

async function requestText(workspaceId: string, a: { method: string; path: string; body?: string; headers?: unknown; env?: 'workspace' | 'local' }): Promise<string> {
  const headers = a.headers && typeof a.headers === 'object' ? Object.entries(a.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)] as [string, string]) : []
  const res = await requests.send(workspaceId, { method: a.method.toUpperCase(), path: a.path, headers, body: a.body, env: a.env ?? 'workspace' }, 'agent')
  const ct = res.headers.find(([k]) => k === 'content-type')?.[1] ?? ''
  const body = res.body.length > BODY_MAX ? res.body.slice(0, BODY_MAX) + `\n… (${res.body.length - BODY_MAX} more characters)` : res.body
  return `${res.status} ${res.statusText} in ${res.ms} ms${ct ? ` (${ct})` : ''}${res.truncated ? ', body cut at 2 MB' : ''}\n${body}`
}

const listDesc = "List this workspace's HTTP endpoints (from OpenAPI files, the running app's spec, and NestJS, Next.js, FastAPI and Express routes): method, path, summary, repository/service and the file that defines it. Use it before calling or changing an API instead of searching the code."
const requestDesc =
  "Send an HTTP request to this workspace's running app (http://localhost:<workspace port>) or the Local base URL the user set, with the auth from the API pane's Request settings. Only addresses on this Mac. Use it to check an endpoint you wrote or changed. path includes the query, e.g. /v1/orders/12?expand=items; body is the raw JSON text."

export function sdkServer(workspaceId: string): NonNullable<Options['mcpServers']>[string] {
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
  const fail = (err: unknown) => ({ content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true })
  return createSdkMcpServer({
    name: 'api',
    tools: [
      sdkTool('api_endpoints', listDesc, { filter: z.string().optional().describe('Text to match in method, path, summary or controller, e.g. "POST /orders" or "login"'), repo: z.string().optional().describe('Only this repository'), refresh: z.boolean().optional().describe('Rescan the code first (after you changed routes)') }, async (a) => listText(workspaceId, a.filter, a.repo, a.refresh).then(text, fail)),
      sdkTool(
        'api_request',
        requestDesc,
        {
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
          path: z.string().describe('Path and query, starting with /'),
          body: z.string().optional().describe('Raw request body, usually JSON'),
          // z.record breaks SDK MCP tool schemas; an object of header name to value.
          headers: z.any().optional().describe('Extra headers as an object of name to value; auth is added from the settings unless you set it'),
          env: z.enum(['workspace', 'local']).optional().describe('workspace (default): this workspace app; local: the Local base URL')
        },
        async (a) => requestText(workspaceId, a).then(text, fail)
      )
    ]
  })
}
/** Listing needs no prompt; requests go through the session's permission mode like any other tool. */
export const SDK_ALLOWED = ['mcp__api__api_endpoints']

export function promptFor(): string {
  return "API: mcp__api__api_endpoints lists this workspace's HTTP endpoints with the file that defines each, and mcp__api__api_request calls the running app on this Mac with the user's saved auth. Prefer them to grepping for routes or hand-written curl."
}

// ---------- route changes ----------

/** The last endpoint list seen per workspace, to diff against after an edit. */
const baseline = new Map<string, ApiEndpoint[]>()
const pendingNotes = new Map<string, string>()

function remember(workspaceId: string, d: ApiDiscovery): void {
  baseline.set(workspaceId, d.endpoints)
}

const ROUTE_LIKE = /\.controller\.(ts|js)$|\/route\.(ts|js|tsx|jsx)$|\/pages\/api\/|\/routes?\/|router|\/(main|app|server|index)\.(ts|js|mjs)$|openapi|swagger|\/(routers?|api|endpoints|views)\/[^/]+\.py$|\/main\.py$/i

/** Whether an edit to this file may change the endpoint list. */
export function isRouteFile(workspaceId: string, file: string): boolean {
  return ROUTE_LIKE.test(file) || Boolean(baseline.get(workspaceId)?.some((e) => e.file === file))
}

/** Before the first route edit: make sure there is a list to compare with afterwards. */
export async function ensureBaseline(workspaceId: string): Promise<void> {
  if (baseline.has(workspaceId)) return
  remember(workspaceId, await discover(workspaceId))
}

const keyOf = (e: ApiEndpoint) => `${e.repoName}|${e.service}|${e.method}|${e.path}`

/** Rescan after a turn that edited route files; returns a one-line summary for the chat, or null if nothing changed. */
export async function afterRouteEdits(workspaceId: string): Promise<string | null> {
  const before = baseline.get(workspaceId)
  const d = await discover(workspaceId, true)
  remember(workspaceId, d)
  if (!before) return null
  const was = new Map(before.map((e) => [keyOf(e), e]))
  const now = new Map(d.endpoints.map((e) => [keyOf(e), e]))
  const added = d.endpoints.filter((e) => !was.has(keyOf(e)))
  const removed = before.filter((e) => !now.has(keyOf(e)))
  if (!added.length && !removed.length) return null
  const fmt = (list: ApiEndpoint[], sign: string) => list.slice(0, 12).map((e) => `${sign} ${e.method} ${e.path}${e.service ? ` (${e.repoName}/${e.service})` : ` (${e.repoName})`}`)
  const lines = [...fmt(added, '+'), ...fmt(removed, '−')]
  const more = added.length + removed.length - lines.length
  pendingNotes.set(workspaceId, `Your last changes changed this workspace's HTTP endpoints:\n${lines.join('\n')}${more > 0 ? `\n…and ${more} more` : ''}\nUpdate the callers (frontend fetches, API clients, tests, OpenAPI docs) if they are affected.`)
  return `Endpoints changed: ${[added.length ? `${added.length} added` : '', removed.length ? `${removed.length} removed` : ''].filter(Boolean).join(', ')}.\n\n${lines.join('\n')}${more > 0 ? `\n…and ${more} more` : ''}`
}

/** The change note for the agent's next message, once. */
export function takeNote(workspaceId: string): string | undefined {
  const n = pendingNotes.get(workspaceId)
  pendingNotes.delete(workspaceId)
  return n
}
