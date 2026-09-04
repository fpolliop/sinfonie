/**
 * The browser tools over MCP streamable HTTP on localhost, for agents that run as separate
 * processes (Codex, Gemini CLI, Grok Build). One unguessable URL per workspace; stateless
 * transport, a fresh server object per request.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { nanoid } from 'nanoid'
import { toolDefs, runForMcp } from './tools'

let server: Server | null = null
let port = 0
const tokens = new Map<string, string>()

async function start(): Promise<void> {
  if (server) return
  server = createServer((req, res) => void handle(req, res).catch((err) => {
    console.warn('[browser mcp]', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
}

/** The URL an ACP agent should connect its "browser" MCP server to for this workspace. */
export async function urlFor(workspaceId: string): Promise<string> {
  await start()
  let token = tokens.get(workspaceId)
  if (!token) tokens.set(workspaceId, (token = nanoid(24)))
  return `http://127.0.0.1:${port}/browser/${workspaceId}/${token}`
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const m = /^\/browser\/([^/]+)\/([^/?]+)/.exec(req.url ?? '')
  if (!m || tokens.get(m[1]) !== m[2]) {
    res.writeHead(404)
    res.end()
    return
  }
  const workspaceId = m[1]
  let body: unknown
  if (req.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
    } catch {
      body = undefined
    }
  }
  const mcp = new McpServer({ name: 'sinfonie-browser', version: '1.0.0' })
  for (const d of toolDefs()) {
    mcp.registerTool(d.name, { description: d.description, inputSchema: d.shape }, (async (args: Record<string, unknown>) => runForMcp(workspaceId, d, args)) as never)
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void mcp.close()
  })
  await mcp.connect(transport)
  await transport.handleRequest(req, res, body)
}

export function stop(): void {
  server?.close()
  server = null
}
