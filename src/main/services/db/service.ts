/**
 * Database connections for a space: Postgres and MySQL, direct, through an SSH tunnel, or through
 * the Cloud SQL connector (authenticated with the space's gcloud account). Passwords live in the
 * keychain. Queries run read-only by default (statement classification plus a read-only
 * transaction), with a timeout, a row cap, and a cancel path through a second connection. Schema
 * introspection and per-connection history feed the Data tab and the agent tools.
 */
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { nanoid } from 'nanoid'
import pg from 'pg'
import mysql from 'mysql2/promise'
import { Client as SshClient } from 'ssh2'
import { Connector, IpAddressTypes, AuthTypes } from '@google-cloud/cloud-sql-connector'
import { OAuth2Client } from 'google-auth-library'
import { getStore } from '../../store'
import * as gcp from '../gcp'
import type { DbColumn, DbConnection, DbHistoryEntry, DbQueryResult, DbSchema, DbSecrets, DbTable } from '@shared/types'

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
  return (space?.databases ?? []).map((c) => ({ ...c, hasPassword: Boolean(readSecret(c.id).password) }))
}
export function get(spaceId: string, id: string): DbConnection {
  const c = list(spaceId).find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase())
  if (!c) throw new Error(`No database connection "${id}" in this space.`)
  return c
}
export function save(spaceId: string, conn: DbConnection, secrets?: DbSecrets): DbConnection {
  const clean: DbConnection = { ...conn, id: conn.id || nanoid(8), name: conn.name.trim() || conn.database, createdAt: conn.createdAt || new Date().toISOString() }
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
    // Empty fields keep what is stored; only explicit values replace.
    const prev = readSecret(clean.id)
    writeSecret(clean.id, { ...prev, ...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== undefined && v !== '')) })
  }
  closeLive(clean.id)
  return get(spaceId, clean.id)
}
export function remove(spaceId: string, id: string): void {
  closeLive(id)
  getStore().update((d) => {
    const s = d.spaces.find((x) => x.id === spaceId)
    if (s?.databases) s.databases = s.databases.filter((x) => x.id !== id)
  })
  writeSecret(id, undefined)
}

// ---------- gcloud-backed auth for the Cloud SQL connector ----------
class GcloudAuth extends OAuth2Client {
  constructor(private readonly account?: string) {
    super()
  }
  private async token(): Promise<string> {
    return gcp.accessToken(this.account)
  }
  override async getAccessToken(): Promise<{ token?: string | null; res?: null }> {
    return { token: await this.token(), res: null }
  }
  override async getRequestHeaders(): Promise<Headers> {
    return new Headers({ Authorization: `Bearer ${await this.token()}` })
  }
  protected override async getRequestMetadataAsync(): Promise<{ headers: Headers; res?: null }> {
    return { headers: await this.getRequestHeaders(), res: null }
  }
}

// ---------- read-only classification ----------
const READ_FIRST = new Set(['select', 'with', 'explain', 'show', 'describe', 'desc', 'values', 'table'])
const WRITE_WORDS = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|call|copy|vacuum|lock|refresh|reindex|cluster|comment|set\s+role|load|replace|rename|optimize|repair|flush|kill|shutdown|do)\b/i
function stripSqlNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`[^`]*`/g, '``')
}
export function classifySql(sql: string): { statements: number; readOnly: boolean; first: string } {
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
    if (!READ_FIRST.has(word) || WRITE_WORDS.test(p)) readOnly = false
  }
  return { statements: parts.length, readOnly, first }
}

// ---------- live sessions ----------
type PgLive = { kind: 'postgres'; client: pg.Client; config: pg.ClientConfig }
type MyLive = { kind: 'mysql'; client: mysql.Connection; config: mysql.ConnectionOptions }
interface Live {
  conn: DbConnection
  driver: PgLive | MyLive
  cleanup: (() => void)[]
  busy: boolean
  lastUsed: number
  idle?: NodeJS.Timeout
}
const live = new Map<string, Live>()
const IDLE_MS = 10 * 60_000

function closeLive(id: string): void {
  const l = live.get(id)
  if (!l) return
  live.delete(id)
  if (l.idle) clearTimeout(l.idle)
  void (l.driver.kind === 'postgres' ? l.driver.client.end() : l.driver.client.end()).catch(() => undefined)
  for (const c of l.cleanup) c()
}
function touch(l: Live): void {
  l.lastUsed = Date.now()
  if (l.idle) clearTimeout(l.idle)
  l.idle = setTimeout(() => closeLive(l.conn.id), IDLE_MS)
  l.idle.unref()
}

const expandHome = (p: string): string => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

/** A transport for the driver: an SSH-forwarded stream, Cloud SQL connector options, or plain host/port. */
async function transport(conn: DbConnection, secrets: DbSecrets, spaceId: string): Promise<{ opts: Record<string, unknown>; cleanup: (() => void)[]; user?: string }> {
  const t = conn.tunnel ?? { kind: 'none' }
  const cleanup: (() => void)[] = []
  if (t.kind === 'cloudsql') {
    if (!t.instance) throw new Error('Cloud SQL connection without an instance (project:region:instance).')
    const account = t.account ?? gcp.gcpFor(spaceId)?.account
    const connector = new Connector({ auth: new GcloudAuth(account) })
    cleanup.push(() => connector.close())
    let opts: Record<string, unknown>
    try {
      const ipType = t.ipType === 'PRIVATE' ? IpAddressTypes.PRIVATE : t.ipType === 'PSC' ? IpAddressTypes.PSC : IpAddressTypes.PUBLIC
      opts = (await connector.getOptions({ instanceConnectionName: t.instance, ipType, authType: t.iamAuth ? AuthTypes.IAM : AuthTypes.PASSWORD })) as unknown as Record<string, unknown>
    } catch (err) {
      connector.close()
      const m = err instanceof Error ? err.message : String(err)
      throw new Error(`Cloud SQL connector: ${m}. Check that ${account ?? 'the active gcloud account'} can access ${t.instance} (roles/cloudsql.client) and that the Cloud SQL Admin API is enabled.`)
    }
    return { opts, cleanup, user: t.iamAuth && !conn.user ? account : undefined }
  }
  if (t.kind === 'ssh') {
    if (!t.sshHost) throw new Error('SSH tunnel without a host.')
    const ssh = new SshClient()
    const stream = await new Promise<import('stream').Duplex>((resolve, reject) => {
      ssh
        .on('ready', () => {
          ssh.forwardOut('127.0.0.1', 0, conn.host || '127.0.0.1', conn.port || (conn.kind === 'postgres' ? 5432 : 3306), (err, s) => (err ? reject(err) : resolve(s)))
        })
        .on('error', reject)
        .connect({
          host: t.sshHost,
          port: t.sshPort || 22,
          username: t.sshUser || process.env.USER,
          ...(t.sshKeyPath ? { privateKey: readFileSync(expandHome(t.sshKeyPath)) } : {}),
          ...(secrets.sshPassphrase ? { passphrase: secrets.sshPassphrase } : {}),
          ...(secrets.sshPassword ? { password: secrets.sshPassword } : {}),
          readyTimeout: 20_000
        })
    })
    cleanup.push(() => ssh.end())
    return { opts: { stream }, cleanup }
  }
  return { opts: { host: conn.host || '127.0.0.1', port: conn.port || (conn.kind === 'postgres' ? 5432 : 3306), ...(conn.ssl ? { ssl: { rejectUnauthorized: false } } : {}) }, cleanup }
}

async function open(spaceId: string, conn: DbConnection, secrets = readSecret(conn.id)): Promise<Live> {
  const tr = await transport(conn, secrets, spaceId)
  const user = conn.user || tr.user
  try {
    if (conn.kind === 'postgres') {
      const config: pg.ClientConfig = { ...(tr.opts as pg.ClientConfig), user, password: secrets.password, database: conn.database, connectionTimeoutMillis: 20_000, application_name: 'sinfonie' }
      const client = new pg.Client(config)
      await client.connect()
      client.on('error', () => closeLive(conn.id))
      return { conn, driver: { kind: 'postgres', client, config }, cleanup: tr.cleanup, busy: false, lastUsed: Date.now() }
    }
    const config: mysql.ConnectionOptions = { ...(tr.opts as mysql.ConnectionOptions), user, password: secrets.password, database: conn.database, connectTimeout: 20_000, rowsAsArray: true, dateStrings: false, supportBigNumbers: true, bigNumberStrings: true }
    const client = await mysql.createConnection(config)
    client.on('error', () => closeLive(conn.id))
    return { conn, driver: { kind: 'mysql', client, config }, cleanup: tr.cleanup, busy: false, lastUsed: Date.now() }
  } catch (err) {
    for (const c of tr.cleanup) c()
    throw err
  }
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

// ---------- queries ----------
const PG_TYPES: Record<number, string> = { 16: 'bool', 17: 'bytea', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 114: 'json', 700: 'float4', 701: 'float8', 1043: 'varchar', 1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb', 1007: 'int4[]', 1009: 'text[]', 1015: 'varchar[]' }
const MY_TYPES: Record<number, string> = { 0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 7: 'timestamp', 8: 'bigint', 9: 'mediumint', 10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 15: 'varchar', 16: 'bit', 245: 'json', 246: 'decimal', 252: 'blob/text', 253: 'varchar', 254: 'char' }

function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString()
  if (Buffer.isBuffer(v)) return `\\x${v.toString('hex').slice(0, 2000)}`
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'object') return v
  return v
}

export interface QueryOptions {
  maxRows?: number
  timeoutMs?: number
  /** Where the query came from, for the history. */
  source?: 'user' | 'agent'
  /** Allow a write (already confirmed by whoever calls). */
  allowWrite?: boolean
}

export async function runQuery(spaceId: string, id: string, sql: string, opts: QueryOptions = {}): Promise<DbQueryResult> {
  const conn = get(spaceId, id)
  const cls = classifySql(sql)
  if (!cls.statements) throw new Error('Empty query.')
  const readOnly = cls.readOnly
  if (!readOnly && !(conn.allowWrites && opts.allowWrite)) throw new Error(conn.allowWrites ? 'This statement writes; confirm the write first.' : `This statement writes (${cls.first || 'unknown'}) and the connection "${conn.name}" is read-only. Turn on "Allow writes" for it under Settings → Databases if that is intended.`)
  const maxRows = Math.min(Math.max(1, opts.maxRows ?? 500), 5000)
  const timeoutMs = Math.min(Math.max(1000, opts.timeoutMs ?? 60_000), 10 * 60_000)
  const l = await session(spaceId, id)
  if (l.busy) throw new Error('A query is already running on this connection; cancel it or wait.')
  l.busy = true
  const started = Date.now()
  const result: DbQueryResult = { id: nanoid(8), connectionId: conn.id, sql, columns: [], rows: [], rowCount: 0, truncated: false, ms: 0, readOnly }
  try {
    if (l.driver.kind === 'postgres') {
      const c = l.driver.client
      await c.query(`SET statement_timeout = ${Math.round(timeoutMs)}`)
      if (readOnly) await c.query('BEGIN READ ONLY')
      try {
        const raw = (await c.query({ text: sql, rowMode: 'array' })) as pg.QueryArrayResult | pg.QueryArrayResult[]
        const results = Array.isArray(raw) ? raw : [raw]
        const last = [...results].reverse().find((r) => r.fields?.length) ?? results[results.length - 1]
        result.columns = (last.fields ?? []).map((f) => ({ name: f.name, type: PG_TYPES[f.dataTypeID] ?? `oid ${f.dataTypeID}` }))
        const rows = (last.rows ?? []) as unknown[][]
        result.truncated = rows.length > maxRows
        result.rows = rows.slice(0, maxRows).map((r) => r.map(plain))
        result.rowCount = rows.length
        result.affected = results.reduce((n, r) => n + (/^(INSERT|UPDATE|DELETE|MERGE)/.test(r.command ?? '') ? (r.rowCount ?? 0) : 0), 0) || undefined
        result.command = last.command
      } finally {
        if (readOnly) await c.query('ROLLBACK').catch(() => undefined)
      }
    } else {
      const c = l.driver.client
      await c.query(`SET SESSION max_execution_time = ${Math.round(timeoutMs)}`).catch(() => undefined)
      if (readOnly) {
        await c.query('SET SESSION TRANSACTION READ ONLY')
        await c.query('START TRANSACTION')
      }
      try {
        const [rows, fields] = (await c.query({ sql, rowsAsArray: true })) as unknown as [unknown, mysql.FieldPacket[] | undefined]
        if (Array.isArray(rows)) {
          result.columns = (fields ?? []).map((f) => ({ name: f.name, type: MY_TYPES[(f as unknown as { columnType?: number }).columnType ?? -1] ?? '' }))
          const list = rows as unknown[][]
          result.truncated = list.length > maxRows
          result.rows = list.slice(0, maxRows).map((r) => r.map(plain))
          result.rowCount = list.length
        } else {
          const h = rows as { affectedRows?: number; info?: string }
          result.affected = h.affectedRows
          result.command = h.info || `${h.affectedRows ?? 0} row(s) affected`
        }
      } finally {
        if (readOnly) await c.query('ROLLBACK').catch(() => undefined)
        else await c.query('SET SESSION TRANSACTION READ WRITE').catch(() => undefined)
      }
    }
    result.ms = Date.now() - started
    addHistory(conn.id, { at: new Date().toISOString(), sql, ms: result.ms, rowCount: result.rowCount, source: opts.source ?? 'user' })
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    addHistory(conn.id, { at: new Date().toISOString(), sql, ms: Date.now() - started, error: message.slice(0, 300), source: opts.source ?? 'user' })
    // A broken socket (timeout kill, tunnel drop) must not poison the next query.
    if (/terminat|closed|ECONNRESET|EPIPE|Connection lost|PROTOCOL_CONNECTION_LOST/i.test(message)) closeLive(conn.id)
    throw new Error(message)
  } finally {
    l.busy = false
    touch(l)
  }
}

/** Cancel the statement running on a connection, through a second short-lived connection. */
export async function cancel(spaceId: string, id: string): Promise<string> {
  const l = live.get(get(spaceId, id).id)
  if (!l || !l.busy) return 'Nothing is running.'
  if (l.driver.kind === 'postgres') {
    const pid = (l.driver.client as unknown as { processID?: number }).processID
    if (!pid) throw new Error('No backend pid yet.')
    const side = new pg.Client(l.driver.config)
    await side.connect()
    try {
      await side.query('SELECT pg_cancel_backend($1)', [pid])
    } finally {
      await side.end().catch(() => undefined)
    }
    return `Cancel sent to backend ${pid}.`
  }
  const tid = (l.driver.client as unknown as { threadId?: number }).threadId
  if (!tid) throw new Error('No thread id yet.')
  const side = await mysql.createConnection(l.driver.config)
  try {
    await side.query(`KILL QUERY ${Number(tid)}`)
  } finally {
    await side.end().catch(() => undefined)
  }
  return `KILL QUERY sent to thread ${tid}.`
}

// ---------- schema ----------
const schemaCache = new Map<string, DbSchema>()
export async function schema(spaceId: string, id: string, refresh = false): Promise<DbSchema> {
  const conn = get(spaceId, id)
  const hit = schemaCache.get(conn.id)
  if (hit && !refresh && Date.now() - Date.parse(hit.fetchedAt) < 10 * 60_000) return hit
  const l = await session(spaceId, id)
  const tables = new Map<string, DbTable>()
  const add = (schemaName: string, table: string, kind: string, col: DbColumn): void => {
    const key = `${schemaName}.${table}`
    let t = tables.get(key)
    if (!t) {
      t = { schema: schemaName, name: table, kind: /view/i.test(kind) ? 'view' : 'table', columns: [] }
      tables.set(key, t)
    }
    t.columns!.push(col)
  }
  if (l.driver.kind === 'postgres') {
    const c = l.driver.client
    // pg_catalog rather than information_schema: it lists every table, not only the ones this user may read.
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
      add(row.s, row.t, row.k === 'v' || row.k === 'm' ? 'view' : 'table', { name: row.col, type: row.ty, nullable: row.nullable, default: row.def ?? undefined, pk: row.pk })
      const t = tables.get(`${row.s}.${row.t}`)!
      t.readable = row.readable
      if (Number(row.est) >= 0) t.rows = Number(row.est)
    }
  } else {
    const c = l.driver.client
    const [rows] = (await c.query({ sql: `
      SELECT c.TABLE_SCHEMA AS s, c.TABLE_NAME AS t, tb.TABLE_TYPE AS k, c.COLUMN_NAME AS col, c.COLUMN_TYPE AS ty, c.IS_NULLABLE AS n, c.COLUMN_DEFAULT AS d, (c.COLUMN_KEY = 'PRI') AS pk, tb.TABLE_ROWS AS est
      FROM information_schema.COLUMNS c JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = DATABASE() ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`, rowsAsArray: false })) as unknown as [{ s: string; t: string; k: string; col: string; ty: string; n: string; d: string | null; pk: number; est: number | null }[]]
    for (const row of rows) {
      add(row.s, row.t, row.k, { name: row.col, type: row.ty, nullable: row.n === 'YES', default: row.d ?? undefined, pk: Boolean(row.pk) })
      const t = tables.get(`${row.s}.${row.t}`)
      if (t && row.est != null) t.rows = Number(row.est)
    }
  }
  touch(l)
  const out: DbSchema = { tables: Array.from(tables.values()), fetchedAt: new Date().toISOString() }
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
    let version = ''
    if (l.driver.kind === 'postgres') version = String((await l.driver.client.query('SELECT version()')).rows[0]?.version ?? '').split(' on ')[0]
    else version = `MySQL ${String(((await l.driver.client.query({ sql: 'SELECT VERSION() AS v', rowsAsArray: false })) as unknown as [{ v: string }[]])[0][0]?.v ?? '')}`
    return { ok: true, message: `Connected: ${version}`, ms: Date.now() - started }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err), ms: Date.now() - started }
  } finally {
    if (l) {
      void (l.driver.kind === 'postgres' ? l.driver.client.end() : l.driver.client.end()).catch(() => undefined)
      for (const c of l.cleanup) c()
    }
  }
}

// ---------- history ----------
let history: Record<string, DbHistoryEntry[]> | null = null
function historyFile(): string {
  return join(app.getPath('userData'), 'db-history.json')
}
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

export function closeAll(): void {
  for (const id of Array.from(live.keys())) closeLive(id)
}
