/** Shared shapes for the database drivers. */
import type { DbConnection, DbQueryResult, DbSecrets, DbTable } from '@shared/types'

export interface QueryOpts {
  maxRows: number
  timeoutMs: number
  /** Enforce read-only (transaction / mode) for this statement. */
  readOnly: boolean
}
export type QueryOut = Pick<DbQueryResult, 'columns' | 'rows' | 'rowCount' | 'truncated'> & Partial<Pick<DbQueryResult, 'affected' | 'command'>>

export interface UpdateRequest {
  table: { schema: string; name: string }
  /** Primary key values identifying exactly one row. */
  pk: Record<string, unknown>
  /** Columns to change. */
  set: Record<string, unknown>
}

export interface Classification {
  statements: number
  readOnly: boolean
  first: string
}

export interface Driver<L> {
  open(conn: DbConnection, secrets: DbSecrets, spaceId: string): Promise<{ live: L; cleanup: (() => void)[] }>
  close(live: L): Promise<void>
  version(live: L): Promise<string>
  classify(text: string): Classification
  query(live: L, text: string, opts: QueryOpts): Promise<QueryOut>
  schema(live: L, conn: DbConnection): Promise<DbTable[]>
  /** Stop the running statement through a side channel; resolves with a note. */
  cancel?(live: L): Promise<string>
  explain?(live: L, text: string): Promise<string>
  /** UPDATE one row by primary key; returns affected rows. */
  update?(live: L, req: UpdateRequest, opts: { timeoutMs: number }): Promise<number>
  /** Bulk insert rows (columns in order); returns inserted count. */
  insertRows?(live: L, table: { schema: string; name: string }, columns: string[], rows: unknown[][]): Promise<number>
  /** Identifier quoting for generated SQL shown to the user. */
  quote(ident: string): string
}

export const clipCell = (v: unknown): unknown => {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString()
  if (Buffer.isBuffer(v)) return `\\x${v.toString('hex').slice(0, 2000)}`
  if (typeof v === 'bigint') return v.toString()
  return v
}

// ---------- SQL read-only classification (shared by the SQL engines) ----------
const READ_FIRST = new Set(['select', 'with', 'explain', 'show', 'describe', 'desc', 'values', 'table', 'pragma'])
const WRITE_WORDS = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|call|copy|vacuum|lock|refresh|reindex|cluster|comment|set\s+role|load|replace|rename|optimize|repair|flush|kill|shutdown|do|attach|detach)\b/i
export function stripSqlNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`[^`]*`/g, '``')
}
export function classifySql(sql: string): Classification {
  const body = stripSqlNoise(sql)
  const parts = body
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  let readOnly = parts.length > 0
  let first = ''
  for (const p of parts) {
    const word = (p.match(/^[a-z]+/i)?.[0] ?? '').toLowerCase()
    if (!first) first = word
    // PRAGMA is read-only unless it assigns.
    if (word === 'pragma' && /=/.test(p)) readOnly = false
    else if (!READ_FIRST.has(word) || WRITE_WORDS.test(p)) readOnly = false
  }
  return { statements: parts.length, readOnly, first }
}

/** `SELECT … FROM <one table>` detection, so a result grid can offer row editing. */
export function singleTableOf(sql: string): { schema?: string; name: string } | null {
  const body = stripSqlNoise(sql).trim().replace(/;\s*$/, '')
  if (!/^select\b/i.test(body) || /\b(join|union|intersect|except|group\s+by|distinct)\b/i.test(body)) return null
  const m = body.match(/\bfrom\s+((?:[`"\w.]+))/i)
  if (!m) return null
  const parts = m[1].split('.').map((p) => p.replace(/^[`"]|[`"]$/g, ''))
  return parts.length === 2 ? { schema: parts[0], name: parts[1] } : parts.length === 1 ? { name: parts[0] } : null
}
