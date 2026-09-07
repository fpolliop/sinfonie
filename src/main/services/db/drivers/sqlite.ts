import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { classifySql, clipCell, type Driver, type QueryOut } from '../common'
import type { DbColumn, DbTable } from '@shared/types'

export interface SqliteLive {
  db: DatabaseSync
  path: string
}
const q = (s: string): string => `"${s.replace(/"/g, '""')}"`
const expandHome = (p: string): string => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

/** SQLite through Node's built-in module (no native rebuild). Read-only connections open the file read-only. */
export const sqlite: Driver<SqliteLive> = {
  quote: q,
  classify: classifySql,
  async open(conn) {
    const path = expandHome(conn.path || conn.database)
    if (!existsSync(path) && !conn.allowWrites) throw new Error(`${path} does not exist. Turn on "Allow writes" to create a new database file.`)
    const db = new DatabaseSync(path, { readOnly: !conn.allowWrites, timeout: 5000 })
    return { live: { db, path }, cleanup: [] }
  },
  async close(l) {
    l.db.close()
  },
  async version(l) {
    const r = l.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    return `SQLite ${r.v} (${l.path})`
  },
  async query(l, text, o) {
    const cls = classifySql(text)
    if (cls.statements > 1) {
      if (cls.readOnly) throw new Error('Run one statement at a time on SQLite.')
      l.db.exec(text)
      return { columns: [], rows: [], rowCount: 0, truncated: false, command: 'OK' }
    }
    const stmt = l.db.prepare(text.trim().replace(/;\s*$/, ''))
    if (!cls.readOnly) {
      const r = stmt.run()
      return { columns: [], rows: [], rowCount: 0, truncated: false, affected: Number(r.changes), command: `${r.changes} row(s) affected` }
    }
    const cols = stmt.columns().map((c) => ({ name: c.name, type: c.type ?? (c.column ? '' : 'expr') }))
    const rows: unknown[][] = []
    let count = 0
    for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
      count++
      if (rows.length < o.maxRows) rows.push(cols.map((c) => clipCell(row[c.name])))
      if (count > o.maxRows + 1_000_000) break
    }
    const out: QueryOut = { columns: cols, rows, rowCount: count, truncated: count > o.maxRows }
    return out
  },
  async schema(l) {
    const tables: DbTable[] = []
    const list = l.db.prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string; type: string }[]
    for (const t of list) {
      const cols = l.db.prepare(`PRAGMA table_info(${q(t.name)})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[]
      const columns: DbColumn[] = cols.map((c) => ({ name: c.name, type: c.type || 'any', nullable: !c.notnull, default: c.dflt_value ?? undefined, pk: c.pk > 0 }))
      try {
        const fks = l.db.prepare(`PRAGMA foreign_key_list(${q(t.name)})`).all() as { table: string; from: string; to: string }[]
        for (const f of fks) {
          const col = columns.find((c) => c.name === f.from)
          if (col) col.fk = { table: `main.${f.table}`, column: f.to }
        }
      } catch {
        /* optional */
      }
      let rows: number | undefined
      if (t.type === 'table' && list.length <= 200) {
        try {
          rows = Number((l.db.prepare(`SELECT count(*) AS n FROM ${q(t.name)}`).get() as { n: number }).n)
        } catch {
          /* virtual tables etc. */
        }
      }
      tables.push({ schema: 'main', name: t.name, kind: t.type === 'view' ? 'view' : 'table', columns, rows })
    }
    return tables
  },
  async explain(l, text) {
    const rows = l.db.prepare(`EXPLAIN QUERY PLAN ${text.trim().replace(/;\s*$/, '')}`).all() as { detail: string; parent: number; id: number }[]
    return rows.map((r) => `${' '.repeat(r.parent ? 2 : 0)}${r.detail}`).join('\n')
  },
  async update(l, req) {
    const setCols = Object.keys(req.set)
    const pkCols = Object.keys(req.pk)
    if (!setCols.length || !pkCols.length) throw new Error('Nothing to update.')
    const params: unknown[] = []
    const sets = setCols.map((k) => (params.push(req.set[k]), `${q(k)} = ?`))
    const where = pkCols.map((k) => (req.pk[k] === null ? `${q(k)} IS NULL` : (params.push(req.pk[k]), `${q(k)} = ?`)))
    const r = l.db.prepare(`UPDATE ${q(req.table.name)} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`).run(...(params as never[]))
    return Number(r.changes)
  },
  async insertRows(l, table, columns, rows) {
    const stmt = l.db.prepare(`INSERT INTO ${q(table.name)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    l.db.exec('BEGIN')
    try {
      let n = 0
      for (const r of rows) {
        stmt.run(...(columns.map((_, j) => (r[j] === undefined ? null : r[j])) as never[]))
        n++
      }
      l.db.exec('COMMIT')
      return n
    } catch (err) {
      l.db.exec('ROLLBACK')
      throw err
    }
  }
}
