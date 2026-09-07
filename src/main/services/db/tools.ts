/**
 * Database tools for agents: list connections, read the schema, run read-only queries, explain.
 * Writes are only possible on connections that allow them, and only after the user confirms the
 * exact statement through the permission card; the on-call agent never writes.
 */
import { z } from 'zod'
import { createSdkMcpServer, tool as sdkTool, type Options } from '@anthropic-ai/claude-agent-sdk'
import { tool as aiTool, type ToolSet } from 'ai'
import * as db from './service'
import { askPermission } from '../interaction'
import type { DbQueryResult } from '@shared/types'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const cell = (v: unknown): string => {
  const s = v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}
export function renderResult(r: DbQueryResult, maxRows = 100): string {
  if (!r.columns.length) return `${r.command ?? 'OK'}${r.affected !== undefined ? ` (${r.affected} row(s) affected)` : ''} in ${r.ms} ms`
  const rows = r.rows.slice(0, maxRows)
  const head = `${r.rowCount} row(s)${r.truncated ? ` (showing first ${rows.length})` : rows.length < r.rowCount ? ` (showing ${rows.length})` : ''} in ${r.ms} ms\n`
  const lines = [r.columns.map((c) => c.name).join('\t'), ...rows.map((row) => row.map(cell).join('\t'))]
  return head + lines.join('\n')
}

interface Def {
  name: string
  description: string
  shape: z.ZodRawShape
  run: (spaceId: string, workspaceId: string | undefined, args: Record<string, unknown>) => Promise<string>
}

const DEFS: Def[] = [
  {
    name: 'db_connections',
    description: 'Database connections configured for this space: name, engine, database, whether writes are allowed. Use a name as the `connection` argument of the other db tools.',
    shape: {},
    run: async (spaceId) => {
      const list = db.list(spaceId)
      return list.length ? list.map((c) => `${c.name}: ${c.kind} ${c.database}${c.tunnel?.kind === 'cloudsql' ? ` (Cloud SQL ${c.tunnel.instance})` : c.host ? ` @ ${c.host}` : ''}${c.allowWrites ? ' [writes allowed with confirmation]' : ' [read-only]'}`).join('\n') : 'No database connections in this space. The user adds them under Settings → the space → Databases.'
    }
  },
  {
    name: 'db_schema',
    description: 'Tables and views of a connection (schema.name, kind, estimated rows), or the columns of one table (name, type, nullable, default, primary key). Call before writing queries.',
    shape: { connection: z.string(), table: z.string().optional().describe('schema.table or table to get columns for') },
    run: async (spaceId, _ws, i) => {
      const s = await db.schema(spaceId, String(i.connection))
      if (i.table) {
        const want = String(i.table).toLowerCase()
        const t = s.tables.find((x) => `${x.schema}.${x.name}`.toLowerCase() === want) ?? s.tables.find((x) => x.name.toLowerCase() === want)
        if (!t) return `No table ${String(i.table)}. Tables: ${s.tables.map((x) => `${x.schema}.${x.name}`).slice(0, 80).join(', ')}`
        return `${t.schema}.${t.name} (${t.kind}${t.rows !== undefined ? `, ~${t.rows} rows` : ''})\n` + (t.columns ?? []).map((c) => `${c.pk ? '* ' : '  '}${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default ? ` default ${c.default}` : ''}`).join('\n')
      }
      return s.tables.map((t) => `${t.schema}.${t.name} (${t.kind}${t.rows !== undefined ? `, ~${t.rows}` : ''}, ${t.columns?.length ?? 0} cols)`).join('\n') || 'No tables.'
    }
  },
  {
    name: 'db_query',
    description: 'Run a statement on a connection. SQL engines (postgres, mysql, sqlite, bigquery): read-only statements run in a read-only mode with a timeout; add LIMIT yourself. MongoDB: send relaxed Extended JSON such as {"collection":"users","find":{"email":"a@b.com"},"projection":{},"sort":{"_id":-1},"limit":20} or {"collection":"orders","aggregate":[...]}, also count / distinct. Writes are refused unless the connection allows them and the user confirms the exact statement. Returns tab-separated rows (first 100).',
    shape: { connection: z.string(), sql: z.string(), maxRows: z.number().int().min(1).max(1000).optional().describe('Default 100') },
    run: async (spaceId, workspaceId, i) => {
      const sql = String(i.sql)
      const conn = db.get(spaceId, String(i.connection))
      const cls = db.classify(spaceId, conn.id, sql)
      let allowWrite = false
      if (!cls.readOnly) {
        if (!conn.allowWrites) throw new Error(`"${conn.name}" is read-only; this statement (${cls.first}) would write. Ask the user to allow writes on the connection if that is intended.`)
        if (!workspaceId) throw new Error('Writes are not available from this agent. Propose the statement to the user instead.')
        const decision = await askPermission({ workspaceId, toolName: 'db_query', input: { connection: conn.name, database: conn.database, sql }, canAlwaysAllow: false })
        if (decision.decision === 'deny') throw new Error(decision.message || 'The user declined the write.')
        allowWrite = true
      }
      const r = await db.runQuery(spaceId, conn.id, sql, { maxRows: Number(i.maxRows ?? 100), source: 'agent', allowWrite })
      return renderResult(r, Number(i.maxRows ?? 100))
    }
  },
  {
    name: 'db_explain',
    description: 'Explain a read-only statement: the plan (Postgres, MySQL, SQLite, MongoDB) or a BigQuery dry run with bytes processed. Nothing runs.',
    shape: { connection: z.string(), sql: z.string() },
    run: async (spaceId, _ws, i) => {
      return db.explain(spaceId, String(i.connection), String(i.sql))
    }
  }
]

export const SDK_ALLOWED = DEFS.map((d) => `mcp__db__${d.name}`)

export function promptFor(spaceId: string): string {
  const list = db.list(spaceId)
  if (!list.length) return ''
  return `\nDatabases: this space has ${list.length} connection(s): ${list.map((c) => `${c.name} (${c.kind}, ${c.database}${c.allowWrites ? ', writes with confirmation' : ', read-only'})`).join('; ')}. Use db_schema before querying, keep queries bounded with LIMIT, and never guess data you can look up.`
}

async function runForMcp(spaceId: string, workspaceId: string | undefined, d: Def, args: Record<string, unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    return { content: [{ type: 'text', text: await d.run(spaceId, workspaceId, args) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${errText(err)}` }], isError: true }
  }
}

/** workspaceId enables confirmed writes (permission card); omit it for agents that must stay read-only. */
export function sdkServer(spaceId: string, workspaceId?: string): NonNullable<Options['mcpServers']>[string] {
  return createSdkMcpServer({ name: 'db', tools: DEFS.map((d) => sdkTool(d.name, d.description, d.shape, (args) => runForMcp(spaceId, workspaceId, d, args as Record<string, unknown>))) })
}

export function aiTools(spaceId: string, workspaceId?: string): ToolSet {
  return Object.fromEntries(
    DEFS.map((d) => [
      d.name,
      aiTool<Record<string, unknown>, string, Record<string, never>>({
        description: d.description,
        inputSchema: z.object(d.shape) as unknown as z.ZodType<Record<string, unknown>>,
        execute: async (input) => {
          try {
            return await d.run(spaceId, workspaceId, input)
          } catch (err) {
            return `Error: ${errText(err)}`
          }
        }
      })
    ])
  )
}
