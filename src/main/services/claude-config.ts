/**
 * The MCP servers in the user's own Claude Code setup (`~/.claude.json`, user scope).
 *
 * A Claude account added in Sinfonie runs with its own CLAUDE_CONFIG_DIR, so Claude Code reads that
 * folder's `.claude.json` instead and the servers from the main setup (`claude mcp add -s user`) never
 * load: on 2026-10-13 a workspace on a second account had no Jira and no Garmin while the main setup
 * had both. Sessions on such an account get the main setup's servers passed in explicitly.
 */
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

type McpConfig = NonNullable<Options['mcpServers']>[string]

function userServers(file: string): Record<string, Record<string, unknown>> {
  if (!existsSync(file)) return {}
  try {
    const d = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> }
    return d.mcpServers ?? {}
  } catch {
    return {}
  }
}

function toConfig(raw: Record<string, unknown>): McpConfig | null {
  const type = (raw.type as string | undefined) ?? (raw.url ? 'http' : 'stdio')
  if ((type === 'http' || type === 'sse') && typeof raw.url === 'string') return { type, url: raw.url, ...(raw.headers ? { headers: raw.headers as Record<string, string> } : {}) }
  if (type === 'stdio' && typeof raw.command === 'string') return { type: 'stdio', command: raw.command, args: (raw.args as string[] | undefined) ?? [], ...(raw.env ? { env: raw.env as Record<string, string> } : {}) }
  return null
}

/**
 * The main setup's user-scope servers that a session using `configDir` would otherwise miss: none when
 * the session already uses the main setup, or when that account's own config defines the same name.
 */
export function mainSetupServersFor(configDir: string | undefined): Record<string, McpConfig> {
  const main = join(homedir(), '.claude')
  if (!configDir || configDir === main) return {}
  const own = userServers(join(configDir, '.claude.json'))
  const out: Record<string, McpConfig> = {}
  for (const [name, raw] of Object.entries(userServers(join(homedir(), '.claude.json')))) {
    if (own[name]) continue
    const cfg = toConfig(raw)
    if (cfg) out[name] = cfg
  }
  return out
}

/** How to sign an MCP server in again for the account a session runs as. */
export function signInHint(configDir: string | undefined): string {
  const main = join(homedir(), '.claude')
  return configDir && configDir !== main ? `in a terminal run \`CLAUDE_CONFIG_DIR=${configDir} claude\`, then /mcp` : 'in a terminal run `claude`, then /mcp'
}
