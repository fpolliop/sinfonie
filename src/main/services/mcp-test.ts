/**
 * "Test" for an MCP server in Settings: connect the way a session would, list its tools, and hang up. A failure
 * comes back in words that say what to check (the command, the address, the key), not only the transport error.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { PLAIN_ERROR_MARK, type McpServerSpec } from '@shared/types'
import { whichSync } from './shell-path'

const TIMEOUT_MS = 30_000

function transportFor(spec: McpServerSpec): Transport {
  if (spec.transport === 'stdio') {
    const command = spec.command?.trim() ?? ''
    if (!command) throw new Error(`${PLAIN_ERROR_MARK}Enter the command that starts the server.`)
    if (!command.includes('/') && !whichSync(command)) throw new Error(`${PLAIN_ERROR_MARK}“${command}” is not installed on this Mac (or not on the PATH your login shell uses).`)
    return new StdioClientTransport({ command, args: spec.args ?? [], env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) }, stderr: 'ignore' })
  }
  let url: URL
  try {
    url = new URL(spec.url ?? '')
  } catch {
    throw new Error(`${PLAIN_ERROR_MARK}That address is not a valid URL. It should look like https://mcp.example.com/mcp.`)
  }
  const requestInit: RequestInit = { headers: spec.headers ?? {} }
  return spec.transport === 'sse' ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit })
}

export async function testServer(spec: McpServerSpec): Promise<string[]> {
  const transport = transportFor(spec)
  const client = new Client({ name: 'sinfonie-test', version: '0.1.0' })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${PLAIN_ERROR_MARK}The server did not answer within ${TIMEOUT_MS / 1000} seconds.`)), TIMEOUT_MS)
  })
  try {
    await Promise.race([client.connect(transport), timeout])
    const { tools } = await Promise.race([client.listTools(), timeout])
    return tools.map((t) => t.name)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith(PLAIN_ERROR_MARK)) throw err
    if (/401|403|unauthori[sz]ed|forbidden/i.test(msg)) throw new Error(`${PLAIN_ERROR_MARK}The server refused the connection (not signed in or a wrong key). Check the Authorization header. (${msg})`)
    if (/ECONNREFUSED|ENOTFOUND|fetch failed|EAI_AGAIN/i.test(msg)) throw new Error(`${PLAIN_ERROR_MARK}Nothing answered at that address. Check the URL and that the server is running. (${msg})`)
    if (/ENOENT|spawn/i.test(msg)) throw new Error(`${PLAIN_ERROR_MARK}The command could not start. Check the command and its arguments. (${msg})`)
    throw err
  } finally {
    clearTimeout(timer)
    void client.close().catch(() => undefined)
  }
}
