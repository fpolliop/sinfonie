import pg from 'pg'
import { classifySql, clipCell, type Driver, type QueryOut } from '../common'
import { cloudSqlOptions, sshStream } from '../transport'
import type { DbColumn, DbTable } from '@shared/types'

export interface PgLive {
  client: pg.Client
  config: pg.ClientConfig
}
const PG_TYPES: Record<number, string> = { 16: 'bool', 17: 'bytea', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 114: 'json', 700: 'float4', 701: 'float8', 1043: 'varchar', 1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb', 1007: 'int4[]', 1009: 'text[]', 1015: 'varchar[]' }
const q = (s: string): string => `"${s.replace(/"/g, '""')}"`

export const postgres: Driver<PgLive> = {
  quote: q,
  classify: classifySql,
  async open(conn, secrets, spaceId) {
    const cleanup: (() => void)[] = []
    let opts: Record<string, unknown> = { host: conn.host || '127.0.0.1', port: conn.port || 5432, ...(conn.ssl ? { ssl: { rejectUnauthorized: false } } : {}) }
    let user = conn.user
    if (conn.tunnel?.kind === 'cloudsql') {
      const c = await cloudSqlOptions(conn, spaceId)
      opts = c.opts
      cleanup.push(c.cleanup)
      user = user || c.iamUser
    } else if (conn.tunnel?.kind === 'ssh') {
      const s = await sshStream(conn, secrets, 5432)
      opts = { stream: s.stream, ...(conn.ssl ? { ssl: { rejectUnauthorized: false } } : {}) }
      cleanup.push(s.cleanup)
    }
    const config: pg.ClientConfig = { ...(opts as pg.ClientConfig), user, password: secrets.password, database: conn.database, connectionTimeoutMillis: 20_000, application_name: 'sinfonie' }
    const client = new pg.Client(config)
    try {
      await client.connect()
    } catch (err) {
      for (const c of cleanup) c()
      throw err
    }
    return { live: { client, config }, cleanup }
  },
  async close(l) {
    await l.client.end().catch(() => undefined)
  },
  async version(l) {
    return String((await l.client.query('SELECT version()')).rows[0]?.version ?? '').split(' on ')[0]
  },
  async query(l, text, o) {
    const c = l.client
    await c.query(`SET statement_timeout = ${Math.round(o.timeoutMs)}`)
    if (o.readOnly) await c.query('BEGIN READ ONLY')
    try {
      const raw = (await c.query({ text, rowMode: 'array' })) as pg.QueryArrayResult | pg.QueryArrayResult[]
      const results = Array.isArray(raw) ? raw : [raw]
      const last = [...results].reverse().find((r) => r.fields?.length) ?? results[results.length - 1]
      const rows = (last.rows ?? []) as unknown[][]
      const out: QueryOut = {
        columns: (last.fields ?? []).map((f) => ({ name: f.name, type: PG_TYPES[f.dataTypeID] ?? `oid ${f.dataTypeID}` })),
        rows: rows.slice(0, o.maxRows).map((r) => r.map(clipCell)),
        rowCount: rows.length,
        truncated: rows.length > o.maxRows,
        command: last.command
      }
      const affected = results.reduce((n, r) => n + (/^(INSERT|UPDATE|DELETE|MERGE)/.test(r.command ?? '') ? (r.rowCount ?? 0) : 0), 0)
      if (affected) out.affected = affected
      return out
    } finally {
      if (o.readOnly) await c.query('ROLLBACK').catch(() => undefined)
    }
  },
  async schema(l) {
    const c = l.client
    const tables = new Map<string, DbTable>()
    const r = await c.query(`
      SELECT n.nspname AS s, c.relname AS t, c.relkind AS k, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS ty, NOT a.attnotnull AS nullable,
             pg_get_expr(d.adbin, d.adrelid) AS def,
             COALESCE((SELECT TRUE FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)), FALSE) AS pk,
             has_table_privilege(c.oid, 'SELECT') AS readable, c.reltuples::bigint AS est
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
      ORDER BY n.nspname, c.relname, a.attnum`)
    for (const row of r.rows as { s: string; t: string; k: string; col: string; ty: string; nullable: boolean; def: string | null; pk: boolean; readable: boolean; est: string | number }[]) {
      const key = `${row.s}.${row.t}`
      let t = tables.get(key)
      if (!t) {
        t = { schema: row.s, name: row.t, kind: row.k === 'v' || row.k === 'm' ? 'view' : 'table', columns: [], readable: row.readable, rows: Number(row.est) >= 0 ? Number(row.est) : undefined }
        tables.set(key, t)
      }
      t.columns!.push({ name: row.col, type: row.ty, nullable: row.nullable, default: row.def ?? undefined, pk: row.pk })
    }
    // Foreign keys: single-column ones map straight onto columns; composite ones mark each column.
    try {
      const fk = await c.query(`
        SELECT n.nspname AS s, c.relname AS t, a.attname AS col, fn.nspname AS fs, fc.relname AS ft, fa.attname AS fcol
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
        JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, ord) ON TRUE
        JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = ck.ord
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ck.attnum
        JOIN pg_attribute fa ON fa.attrelid = fc.oid AND fa.attnum = fk.attnum
        WHERE con.contype = 'f'`)
      for (const f of fk.rows as { s: string; t: string; col: string; fs: string; ft: string; fcol: string }[]) {
        const col = tables.get(`${f.s}.${f.t}`)?.columns?.find((x) => x.name === f.col) as DbColumn | undefined
        if (col) col.fk = { table: `${f.fs}.${f.ft}`, column: f.fcol }
      }
    } catch {
      /* foreign keys are optional */
    }
    return Array.from(tables.values())
  },
  async cancel(l) {
    const pid = (l.client as unknown as { processID?: number }).processID
    if (!pid) throw new Error('No backend pid yet.')
    const side = new pg.Client(l.config)
    await side.connect()
    try {
      await side.query('SELECT pg_cancel_backend($1)', [pid])
    } finally {
      await side.end().catch(() => undefined)
    }
    return `Cancel sent to backend ${pid}.`
  },
  async explain(l, text) {
    const r = await l.client.query(`EXPLAIN (FORMAT TEXT) ${text.trim().replace(/;\s*$/, '')}`)
    return r.rows.map((x) => String(Object.values(x as Record<string, unknown>)[0])).join('\n')
  },
  async update(l, req, o) {
    const setCols = Object.keys(req.set)
    const pkCols = Object.keys(req.pk)
    if (!setCols.length || !pkCols.length) throw new Error('Nothing to update.')
    const params: unknown[] = []
    const sets = setCols.map((k) => `${q(k)} = $${params.push(req.set[k])}`)
    const where = pkCols.map((k) => (req.pk[k] === null ? `${q(k)} IS NULL` : `${q(k)} = $${params.push(req.pk[k])}`))
    await l.client.query(`SET statement_timeout = ${Math.round(o.timeoutMs)}`)
    const r = await l.client.query(`UPDATE ${q(req.table.schema)}.${q(req.table.name)} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`, params)
    return r.rowCount ?? 0
  },
  async insertRows(l, table, columns, rows) {
    const c = l.client
    await c.query('BEGIN')
    try {
      let n = 0
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500)
        const params: unknown[] = []
        const values = chunk.map((r) => `(${columns.map((_, j) => `$${params.push(r[j] ?? null)}`).join(', ')})`).join(', ')
        const res = await c.query(`INSERT INTO ${q(table.schema)}.${q(table.name)} (${columns.map(q).join(', ')}) VALUES ${values}`, params)
        n += res.rowCount ?? chunk.length
      }
      await c.query('COMMIT')
      return n
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined)
      throw err
    }
  }
}
