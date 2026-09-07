import mysql from 'mysql2/promise'
import { classifySql, clipCell, type Driver, type QueryOut } from '../common'
import { cloudSqlOptions, sshStream } from '../transport'
import type { DbColumn, DbTable } from '@shared/types'

export interface MyLive {
  client: mysql.Connection
  config: mysql.ConnectionOptions
}
const MY_TYPES: Record<number, string> = { 0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 7: 'timestamp', 8: 'bigint', 9: 'mediumint', 10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 15: 'varchar', 16: 'bit', 245: 'json', 246: 'decimal', 252: 'blob/text', 253: 'varchar', 254: 'char' }
const q = (s: string): string => `\`${s.replace(/`/g, '``')}\``

export const mysqlDriver: Driver<MyLive> = {
  quote: q,
  classify: classifySql,
  async open(conn, secrets, spaceId) {
    const cleanup: (() => void)[] = []
    let opts: Record<string, unknown> = { host: conn.host || '127.0.0.1', port: conn.port || 3306, ...(conn.ssl ? { ssl: { rejectUnauthorized: false } } : {}) }
    let user = conn.user
    if (conn.tunnel?.kind === 'cloudsql') {
      const c = await cloudSqlOptions(conn, spaceId)
      opts = c.opts
      cleanup.push(c.cleanup)
      user = user || (c.iamUser ? c.iamUser.split('@')[0] : undefined)
    } else if (conn.tunnel?.kind === 'ssh') {
      const s = await sshStream(conn, secrets, 3306)
      opts = { stream: s.stream }
      cleanup.push(s.cleanup)
    }
    const config: mysql.ConnectionOptions = { ...(opts as mysql.ConnectionOptions), user, password: secrets.password, database: conn.database, connectTimeout: 20_000, rowsAsArray: true, supportBigNumbers: true, bigNumberStrings: true }
    try {
      const client = await mysql.createConnection(config)
      return { live: { client, config }, cleanup }
    } catch (err) {
      for (const c of cleanup) c()
      throw err
    }
  },
  async close(l) {
    await l.client.end().catch(() => undefined)
  },
  async version(l) {
    const [rows] = (await l.client.query({ sql: 'SELECT VERSION() AS v', rowsAsArray: false })) as unknown as [{ v: string }[]]
    return `MySQL ${rows[0]?.v ?? ''}`
  },
  async query(l, text, o) {
    const c = l.client
    await c.query(`SET SESSION max_execution_time = ${Math.round(o.timeoutMs)}`).catch(() => undefined)
    if (o.readOnly) {
      await c.query('SET SESSION TRANSACTION READ ONLY')
      await c.query('START TRANSACTION')
    }
    try {
      const [rows, fields] = (await c.query({ sql: text, rowsAsArray: true })) as unknown as [unknown, mysql.FieldPacket[] | undefined]
      if (Array.isArray(rows)) {
        const list = rows as unknown[][]
        return { columns: (fields ?? []).map((f) => ({ name: f.name, type: MY_TYPES[(f as unknown as { columnType?: number }).columnType ?? -1] ?? '' })), rows: list.slice(0, o.maxRows).map((r) => r.map(clipCell)), rowCount: list.length, truncated: list.length > o.maxRows }
      }
      const h = rows as { affectedRows?: number; info?: string }
      return { columns: [], rows: [], rowCount: 0, truncated: false, affected: h.affectedRows, command: h.info || `${h.affectedRows ?? 0} row(s) affected` }
    } finally {
      if (o.readOnly) await c.query('ROLLBACK').catch(() => undefined)
      else await c.query('SET SESSION TRANSACTION READ WRITE').catch(() => undefined)
    }
  },
  async schema(l) {
    const c = l.client
    const tables = new Map<string, DbTable>()
    const [rows] = (await c.query({
      sql: `SELECT c.TABLE_SCHEMA AS s, c.TABLE_NAME AS t, tb.TABLE_TYPE AS k, c.COLUMN_NAME AS col, c.COLUMN_TYPE AS ty, c.IS_NULLABLE AS n, c.COLUMN_DEFAULT AS d, (c.COLUMN_KEY = 'PRI') AS pk, tb.TABLE_ROWS AS est
            FROM information_schema.COLUMNS c JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME
            WHERE c.TABLE_SCHEMA = DATABASE() ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
      rowsAsArray: false
    })) as unknown as [{ s: string; t: string; k: string; col: string; ty: string; n: string; d: string | null; pk: number; est: number | null }[]]
    for (const row of rows) {
      const key = `${row.s}.${row.t}`
      let t = tables.get(key)
      if (!t) {
        t = { schema: row.s, name: row.t, kind: /view/i.test(row.k) ? 'view' : 'table', columns: [], rows: row.est == null ? undefined : Number(row.est) }
        tables.set(key, t)
      }
      t.columns!.push({ name: row.col, type: row.ty, nullable: row.n === 'YES', default: row.d ?? undefined, pk: Boolean(row.pk) })
    }
    try {
      const [fks] = (await c.query({ sql: `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS col, REFERENCED_TABLE_SCHEMA AS fs, REFERENCED_TABLE_NAME AS ft, REFERENCED_COLUMN_NAME AS fcol FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`, rowsAsArray: false })) as unknown as [{ s: string; t: string; col: string; fs: string; ft: string; fcol: string }[]]
      for (const f of fks) {
        const col = tables.get(`${f.s}.${f.t}`)?.columns?.find((x) => x.name === f.col) as DbColumn | undefined
        if (col) col.fk = { table: `${f.fs}.${f.ft}`, column: f.fcol }
      }
    } catch {
      /* optional */
    }
    return Array.from(tables.values())
  },
  async cancel(l) {
    const tid = (l.client as unknown as { threadId?: number }).threadId
    if (!tid) throw new Error('No thread id yet.')
    const side = await mysql.createConnection(l.config)
    try {
      await side.query(`KILL QUERY ${Number(tid)}`)
    } finally {
      await side.end().catch(() => undefined)
    }
    return `KILL QUERY sent to thread ${tid}.`
  },
  async explain(l, text) {
    const [rows, fields] = (await l.client.query({ sql: `EXPLAIN ${text.trim().replace(/;\s*$/, '')}`, rowsAsArray: true })) as unknown as [unknown[][], mysql.FieldPacket[]]
    return [fields.map((f) => f.name).join('\t'), ...rows.map((r) => r.map((v) => (v == null ? 'NULL' : String(v))).join('\t'))].join('\n')
  },
  async update(l, req, o) {
    const setCols = Object.keys(req.set)
    const pkCols = Object.keys(req.pk)
    if (!setCols.length || !pkCols.length) throw new Error('Nothing to update.')
    const params: unknown[] = []
    const sets = setCols.map((k) => (params.push(req.set[k]), `${q(k)} = ?`))
    const where = pkCols.map((k) => (req.pk[k] === null ? `${q(k)} IS NULL` : (params.push(req.pk[k]), `${q(k)} = ?`)))
    await l.client.query(`SET SESSION max_execution_time = ${Math.round(o.timeoutMs)}`).catch(() => undefined)
    const [r] = (await l.client.query(`UPDATE ${q(req.table.schema)}.${q(req.table.name)} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`, params)) as unknown as [{ affectedRows?: number }]
    return r.affectedRows ?? 0
  },
  async insertRows(l, table, columns, rows) {
    const c = l.client
    await c.query('START TRANSACTION')
    try {
      let n = 0
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500)
        const [r] = (await c.query(`INSERT INTO ${q(table.schema)}.${q(table.name)} (${columns.map(q).join(', ')}) VALUES ?`, [chunk.map((row) => columns.map((_, j) => row[j] ?? null))])) as unknown as [{ affectedRows?: number }]
        n += r.affectedRows ?? chunk.length
      }
      await c.query('COMMIT')
      return n
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined)
      throw err
    }
  }
}
