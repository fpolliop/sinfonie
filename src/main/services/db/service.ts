/**
 * Database connections for a space: Postgres, MySQL, SQLite, MongoDB and BigQuery through a common
 * driver contract (see drivers/). Passwords live in the keychain. Statements run read-only by
 * default (classification plus the engine's read-only mode), with a timeout, a row cap, and a
 * cancel path. Also: schema introspection with foreign keys, per-connection history, row updates
 * by primary key, CSV import and result export.
 */
import { app, dialog, safeStorage } from 'electron'
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import { getStore } from '../../store'
import * as gcp from '../gcp'
import { classifySql, singleTableOf, type Classification, type Driver, type UpdateRequest } from './common'
import { postgres } from './drivers/postgres'
import { mysqlDriver } from './drivers/mysql'
import { sqlite } from './drivers/sqlite'
import { mongodb } from './drivers/mongodb'
import { bigquery } from './drivers/bigquery'
import type { DbConnection, DbHistoryEntry, DbKind, DbQueryResult, DbSchema, DbSecrets } from '@shared/types'

export { classifySql, singleTableOf }
export type { UpdateRequest }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DRIVERS: Record<DbKind, Driver<any>> = { postgres, mysql: mysqlDriver, sqlite, mongodb, bigquery }
const driverOf = (kind: DbKind): Driver<unknown> => {
  const d = DRIVERS[kind]
  if (!d) throw new Error(`Unsupported database kind ${kind}`)
  return d
}

// ---------- secrets (same scheme as slack.ts) ----------
function encrypt(text: string): string {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64')
  return 'plain:' + Buffer.from(text, 'utf8').toString('base64')
}
function decrypt(stored: string): string {
  if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
  return stored
}
function readSecret(id: string): DbSecrets {
  const raw = getStore().get().secrets?.[`db:${id}`]
  if (!raw) return {}
  try {
    return JSON.parse(decrypt(raw)) as DbSecrets
  } catch {
    return {}
  }
}
function writeSecret(id: string, value: DbSecrets | undefined): void {
  getStore().update((d) => {
    d.secrets = d.secrets ?? {}
    if (!value || !Object.values(value).some(Boolean)) delete d.secrets[`db:${id}`]
    else d.secrets[`db:${id}`] = encrypt(JSON.stringify(value))
  })
}

// ---------- registry ----------
export function list(spaceId: string): DbConnection[] {
  const space = getStore().get().spaces.find((s) => s.id === spaceId)
  return (space?.databases ?? []).map((c) => {
    const s = readSecret(c.id)
    return { ...c, hasPassword: Boolean(s.password || s.uri) }
  })
}
export function get(spaceId: string, id: string): DbConnection {
  const c = list(spaceId).find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase())
  if (!c) throw new Error(`No database connection "${id}" in this space.`)
  return c
}
export function save(spaceId: string, conn: DbConnection, secrets?: DbSecrets): DbConnection {
  const clean: DbConnection = { ...conn, id: conn.id || nanoid(8), name: conn.name.trim() || conn.database || conn.path || conn.projectId || conn.kind, createdAt: conn.createdAt || new Date().toISOString() }
  delete (clean as { hasPassword?: boolean }).hasPassword
  getStore().update((d) => {
    const s = d.spaces.find((x) => x.id === spaceId)
    if (!s) throw new Error('Unknown space')
    s.databases = s.databases ?? []
    const i = s.databases.findIndex((x) => x.id === clean.id)
    if (i >= 0) s.databases[i] = clean
    else s.databases.push(clean)
  })
  if (secrets) {
    const prev = readSecret(clean.id)
    writeSecret(clean.id, { ...prev, ...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== undefined && v !== '')) })
  }
  void closeLive(clean.id)
  schemaCache.delete(clean.id)
  return get(spaceId, clean.id)
}
export function remove(spaceId: string, id: string): void {
  void closeLive(id)
  getStore().update((d) => {
    const s = d.spaces.find((x) => x.id === spaceId)
    if (s?.databases) s.databases = s.databases.filter((x) => x.id !== id)
  })
  writeSecret(id, undefined)
  schemaCache.delete(id)
}

// ---------- live sessions ----------
interface Live {
  conn: DbConnection
  driver: Driver<unknown>
  live: unknown
  cleanup: (() => void)[]
  busy: boolean
  idle?: NodeJS.Timeout
}
const live = new Map<string, Live>()
const IDLE_MS = 10 * 60_000

async function closeLive(id: string): Promise<void> {
  const l = live.get(id)
  if (!l) return
  live.delete(id)
  if (l.idle) clearTimeout(l.idle)
  await l.driver.close(l.live).catch(() => undefined)
  for (const c of l.cleanup) c()
}
function touch(l: Live): void {
  if (l.idle) clearTimeout(l.idle)
  l.idle = setTimeout(() => void closeLive(l.conn.id), IDLE_MS)
  l.idle.unref()
}
async function open(spaceId: string, conn: DbConnection, secrets = readSecret(conn.id)): Promise<Live> {
  const driver = driverOf(conn.kind)
  const { live: inner, cleanup } = await driver.open(conn, secrets, spaceId)
  return { conn, driver, live: inner, cleanup, busy: false }
}
async function session(spaceId: string, id: string): Promise<Live> {
  const conn = get(spaceId, id)
  const existing = live.get(conn.id)
  if (existing) return existing
  const l = await open(spaceId, conn)
  live.set(conn.id, l)
  touch(l)
  return l
}
async function withSession<T>(spaceId: string, id: string, fn: (l: Live) => Promise<T>): Promise<T> {
  const l = await session(spaceId, id)
  if (l.busy) throw new Error('A statement is already running on this connection; cancel it or wait.')
  l.busy = true
  try {
    return await fn(l)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/terminat|closed|ECONNRESET|EPIPE|Connection lost|PROTOCOL_CONNECTION_LOST|topology was destroyed|MongoNotConnected/i.test(message)) await closeLive(l.conn.id)
    throw err
  } finally {
    l.busy = false
    touch(l)
  }
}

export function classify(spaceId: string, id: string, text: string): Classification {
  return driverOf(get(spaceId, id).kind).classify(text)
}

// ---------- queries ----------
export interface QueryOptions {
  maxRows?: number
  timeoutMs?: number
  source?: 'user' | 'agent'
  /** The write was confirmed by whoever calls. */
  allowWrite?: boolean
}
export async function runQuery(spaceId: string, id: string, text: string, opts: QueryOptions = {}): Promise<DbQueryResult> {
  const conn = get(spaceId, id)
  const driver = driverOf(conn.kind)
  const cls = driver.classify(text)
  if (!cls.statements || !text.trim()) throw new Error('Empty statement.')
  const readOnly = cls.readOnly
  if (!readOnly && !(conn.allowWrites && opts.allowWrite)) throw new Error(conn.allowWrites ? 'This statement writes; confirm the write first.' : `This statement writes (${cls.first || 'unknown'}) and the connection "${conn.name}" is read-only. Turn on "Allow writes" for it under Settings → Databases if that is intended.`)
  const maxRows = Math.min(Math.max(1, opts.maxRows ?? 500), 5000)
  const timeoutMs = Math.min(Math.max(1000, opts.timeoutMs ?? 60_000), 10 * 60_000)
  const started = Date.now()
  try {
    const out = await withSession(spaceId, conn.id, (l) => driver.query(l.live, text, { maxRows, timeoutMs, readOnly }))
    const result: DbQueryResult = { id: nanoid(8), connectionId: conn.id, sql: text, ...out, ms: Date.now() - started, readOnly }
    addHistory(conn.id, { at: new Date().toISOString(), sql: text, ms: result.ms, rowCount: result.rowCount, source: opts.source ?? 'user' })
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    addHistory(conn.id, { at: new Date().toISOString(), sql: text, ms: Date.now() - started, error: message.slice(0, 300), source: opts.source ?? 'user' })
    throw new Error(message)
  }
}

export async function cancel(spaceId: string, id: string): Promise<string> {
  const l = live.get(get(spaceId, id).id)
  if (!l || !l.busy) return 'Nothing is running.'
  if (!l.driver.cancel) return `${l.conn.kind} cannot cancel a running statement; it stops at its timeout.`
  return l.driver.cancel(l.live)
}

export async function explain(spaceId: string, id: string, text: string): Promise<string> {
  const conn = get(spaceId, id)
  const driver = driverOf(conn.kind)
  if (!driver.explain) throw new Error(`${conn.kind} has no explain here.`)
  if (!driver.classify(text).readOnly) throw new Error('Only read-only statements are explained.')
  return withSession(spaceId, conn.id, (l) => driver.explain!(l.live, text))
}

/** UPDATE one row by primary key. The caller confirmed it; the connection must allow writes. */
export async function updateRow(spaceId: string, id: string, req: UpdateRequest): Promise<{ affected: number; preview: string }> {
  const conn = get(spaceId, id)
  if (!conn.allowWrites) throw new Error(`"${conn.name}" is read-only. Turn on "Allow writes" for it under Settings → Databases to edit rows.`)
  const driver = driverOf(conn.kind)
  if (!driver.update) throw new Error(`${conn.kind} does not support row editing here.`)
  const preview = updatePreview(conn, req)
  const started = Date.now()
  const affected = await withSession(spaceId, conn.id, (l) => driver.update!(l.live, req, { timeoutMs: 60_000 }))
  addHistory(conn.id, { at: new Date().toISOString(), sql: preview, ms: Date.now() - started, rowCount: affected, source: 'user' })
  return { affected, preview }
}
export function updatePreview(conn: DbConnection, req: UpdateRequest): string {
  const d = driverOf(conn.kind)
  const lit = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : `'${String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/'/g, "''")}'`)
  if (conn.kind === 'mongodb') return `db.${req.table.name}.updateOne(${JSON.stringify(req.pk)}, { $set: ${JSON.stringify(req.set)} })`
  const table = conn.kind === 'sqlite' ? d.quote(req.table.name) : conn.kind === 'bigquery' ? `${d.quote(conn.projectId ?? '')}.${d.quote(req.table.schema)}.${d.quote(req.table.name)}` : `${d.quote(req.table.schema)}.${d.quote(req.table.name)}`
  return `UPDATE ${table} SET ${Object.entries(req.set)
    .map(([k, v]) => `${d.quote(k)} = ${lit(v)}`)
    .join(', ')} WHERE ${Object.entries(req.pk)
    .map(([k, v]) => (v === null ? `${d.quote(k)} IS NULL` : `${d.quote(k)} = ${lit(v)}`))
    .join(' AND ')}`
}

// ---------- schema ----------
const schemaCache = new Map<string, DbSchema>()
export async function schema(spaceId: string, id: string, refresh = false): Promise<DbSchema> {
  const conn = get(spaceId, id)
  const hit = schemaCache.get(conn.id)
  if (hit && !refresh && Date.now() - Date.parse(hit.fetchedAt) < 10 * 60_000) return hit
  const tables = await withSession(spaceId, conn.id, (l) => l.driver.schema(l.live, conn))
  const out: DbSchema = { tables, fetchedAt: new Date().toISOString() }
  schemaCache.set(conn.id, out)
  return out
}

/** Open, run a trivial statement, close. Works on a draft connection that is not saved yet. */
export async function test(spaceId: string, conn: DbConnection, secrets?: DbSecrets): Promise<{ ok: boolean; message: string; ms: number }> {
  const started = Date.now()
  const merged: DbSecrets = { ...readSecret(conn.id || ''), ...Object.fromEntries(Object.entries(secrets ?? {}).filter(([, v]) => v)) }
  let l: Live | null = null
  try {
    l = await open(spaceId, { ...conn, id: conn.id || 'draft' }, merged)
    return { ok: true, message: `Connected: ${await l.driver.version(l.live)}`, ms: Date.now() - started }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err), ms: Date.now() - started }
  } finally {
    if (l) {
      await l.driver.close(l.live).catch(() => undefined)
      for (const c of l.cleanup) c()
    }
  }
}

// ---------- CSV import / result export ----------
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell.length || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
}
export interface CsvPreview {
  path: string
  delimiter: string
  headers: string[]
  sample: string[][]
  rowCount: number
}
/** Pick a CSV (or use the given path) and return headers plus a sample; the whole file is parsed for the count. */
export async function csvPreview(path?: string): Promise<CsvPreview | null> {
  let file = path
  if (!file) {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], title: 'CSV file to import', filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }] })
    if (r.canceled || !r.filePaths.length) return null
    file = r.filePaths[0]
  }
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = firstLine.split('\t').length > firstLine.split(',').length ? '\t' : firstLine.split(';').length > firstLine.split(',').length ? ';' : ','
  const rows = parseCsv(text, delimiter)
  const headers = rows[0] ?? []
  return { path: file, delimiter, headers, sample: rows.slice(1, 6), rowCount: Math.max(0, rows.length - 1) }
}
const coerce = (s: string): unknown => {
  if (s === '' || s.toUpperCase() === 'NULL') return null
  if (/^-?\d+$/.test(s) && Math.abs(Number(s)) < Number.MAX_SAFE_INTEGER) return Number(s)
  if (/^-?\d*\.\d+(e-?\d+)?$/i.test(s)) return Number(s)
  if (s === 'true' || s === 'false') return s === 'true'
  return s
}
/** Insert a CSV into a table; mapping maps CSV headers to table columns (missing = skipped). Requires allowWrites; the UI confirmed. */
export async function importCsv(spaceId: string, id: string, req: { path: string; delimiter: string; table: { schema: string; name: string }; mapping: Record<string, string>; coerceTypes?: boolean }): Promise<{ inserted: number; ms: number }> {
  const conn = get(spaceId, id)
  if (!conn.allowWrites) throw new Error(`"${conn.name}" is read-only. Turn on "Allow writes" to import.`)
  const driver = driverOf(conn.kind)
  if (!driver.insertRows) throw new Error(`${conn.kind} does not support imports here.`)
  const rows = parseCsv(readFileSync(req.path, 'utf8').replace(/^﻿/, ''), req.delimiter)
  const headers = rows[0] ?? []
  const pairs = headers.map((h, i) => [i, req.mapping[h]] as const).filter(([, col]) => Boolean(col))
  if (!pairs.length) throw new Error('No CSV column is mapped to a table column.')
  const columns = pairs.map(([, col]) => col)
  const data = rows.slice(1).map((r) => pairs.map(([i]) => (req.coerceTypes === false ? (r[i] === '' ? null : r[i]) : coerce(r[i] ?? ''))))
  const started = Date.now()
  const inserted = await withSession(spaceId, conn.id, (l) => driver.insertRows!(l.live, req.table, columns, data))
  addHistory(conn.id, { at: new Date().toISOString(), sql: `-- import ${req.path.split('/').pop()} → ${req.table.schema}.${req.table.name} (${inserted} rows)`, ms: Date.now() - started, rowCount: inserted, source: 'user' })
  schemaCache.delete(conn.id)
  return { inserted, ms: Date.now() - started }
}
/** Re-run a read-only statement without the grid cap (up to 200k rows) and save it as CSV or JSON. */
export async function exportResult(spaceId: string, id: string, text: string, format: 'csv' | 'json'): Promise<{ path: string; rows: number } | null> {
  const conn = get(spaceId, id)
  if (!driverOf(conn.kind).classify(text).readOnly) throw new Error('Only read-only statements are exported.')
  const r = await dialog.showSaveDialog({ title: 'Export result', defaultPath: join(app.getPath('downloads'), `${conn.name.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${format}`) })
  if (r.canceled || !r.filePath) return null
  const res = await withSession(spaceId, conn.id, (l) => l.driver.query(l.live, text, { maxRows: 200_000, timeoutMs: 10 * 60_000, readOnly: true }))
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const out = createWriteStream(r.filePath)
  if (format === 'csv') {
    out.write(res.columns.map((c) => esc(c.name)).join(',') + '\n')
    for (const row of res.rows) out.write(row.map(esc).join(',') + '\n')
  } else {
    out.write('[\n')
    res.rows.forEach((row, i) => out.write((i ? ',\n' : '') + JSON.stringify(Object.fromEntries(res.columns.map((c, j) => [c.name, row[j]])))))
    out.write('\n]\n')
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
  return { path: r.filePath, rows: res.rows.length }
}

// ---------- history ----------
let history: Record<string, DbHistoryEntry[]> | null = null
const historyFile = (): string => join(app.getPath('userData'), 'db-history.json')
function loadHistory(): Record<string, DbHistoryEntry[]> {
  if (history) return history
  try {
    history = existsSync(historyFile()) ? (JSON.parse(readFileSync(historyFile(), 'utf8')) as Record<string, DbHistoryEntry[]>) : {}
  } catch {
    history = {}
  }
  return history
}
let onHistory: ((connectionId: string) => void) | null = null
export function setHistoryEmitter(fn: (connectionId: string) => void): void {
  onHistory = fn
}
function addHistory(connectionId: string, e: DbHistoryEntry): void {
  const h = loadHistory()
  h[connectionId] = [e, ...(h[connectionId] ?? [])].slice(0, 200)
  try {
    writeFileSync(historyFile(), JSON.stringify(h))
  } catch {
    /* best effort */
  }
  onHistory?.(connectionId)
}
export function getHistory(connectionId: string): DbHistoryEntry[] {
  return loadHistory()[connectionId] ?? []
}

/** Cloud SQL instances the space's gcloud account can see, for the connection form. */
export async function cloudSqlInstances(spaceId: string): Promise<{ connectionName: string; name: string; engine: string; region: string }[]> {
  const cfg = gcp.gcpFor(spaceId)
  const raw = await gcp.gcloudJson(['sql', 'instances', 'list'], { project: cfg?.projectId, account: cfg?.account })
  return (JSON.parse(raw || '[]') as { connectionName: string; name: string; databaseVersion: string; region: string }[]).map((i) => ({ connectionName: i.connectionName, name: i.name, engine: i.databaseVersion, region: i.region }))
}
/** A file picker for SQLite databases. */
export async function pickSqliteFile(): Promise<string | null> {
  const r = await dialog.showOpenDialog({ properties: ['openFile'], title: 'SQLite database file', filters: [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }, { name: 'All files', extensions: ['*'] }] })
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
}
export function closeAll(): void {
  for (const id of Array.from(live.keys())) void closeLive(id)
}
