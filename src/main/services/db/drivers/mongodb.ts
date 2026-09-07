import { MongoClient, ObjectId, type Db } from 'mongodb'
import { EJSON } from 'bson'
import { clipCell, type Classification, type Driver, type QueryOut } from '../common'
import { sshLocalPort } from '../transport'
import type { DbTable } from '@shared/types'

export interface MongoLive {
  client: MongoClient
  db: Db
}
type Cmd = Record<string, unknown> & { collection?: string }
const READ_OPS = ['find', 'aggregate', 'count', 'distinct', 'findOne'] as const
const WRITE_OPS = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany'] as const

/** Commands are relaxed Extended JSON: {"collection":"users","find":{...},"projection":{},"sort":{},"limit":50} or {"collection":"orders","aggregate":[...]}. */
export function parseCommand(text: string): { cmd: Cmd; op: string } {
  let cmd: Cmd
  try {
    cmd = EJSON.parse(text, { relaxed: true }) as Cmd
  } catch (err) {
    throw new Error(`Not a MongoDB command: ${err instanceof Error ? err.message : String(err)}. Write JSON like {"collection": "users", "find": {"email": "a@b.com"}, "limit": 20}.`)
  }
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) throw new Error('The command must be a JSON object with a "collection" and one operation.')
  const op = [...READ_OPS, ...WRITE_OPS].find((k) => k in cmd)
  if (!op) throw new Error(`No operation found. Use one of: ${[...READ_OPS, ...WRITE_OPS].join(', ')}.`)
  if (!cmd.collection) throw new Error('Missing "collection".')
  return { cmd, op }
}
function classifyMongo(text: string): Classification {
  try {
    const { cmd, op } = parseCommand(text)
    let readOnly = (READ_OPS as readonly string[]).includes(op)
    if (op === 'aggregate' && Array.isArray(cmd.aggregate) && (cmd.aggregate as Record<string, unknown>[]).some((st) => st && ('$out' in st || '$merge' in st))) readOnly = false
    return { statements: 1, readOnly, first: op }
  } catch {
    return { statements: 1, readOnly: true, first: '' }
  }
}
const show = (v: unknown): unknown => {
  if (v instanceof ObjectId) return v.toHexString()
  if (v instanceof Date) return v.toISOString()
  if (v && typeof v === 'object' && '_bsontype' in (v as object)) return EJSON.serialize(v, { relaxed: true })
  return clipCell(v)
}

export const mongodb: Driver<MongoLive> = {
  quote: (s) => s,
  classify: classifyMongo,
  async open(conn, secrets) {
    const cleanup: (() => void)[] = []
    let host = conn.host || '127.0.0.1'
    let port = conn.port || 27017
    if (conn.tunnel?.kind === 'ssh') {
      const lp = await sshLocalPort(conn, secrets, 27017)
      host = '127.0.0.1'
      port = lp.port
      cleanup.push(lp.cleanup)
    }
    const auth = conn.user ? `${encodeURIComponent(conn.user)}:${encodeURIComponent(secrets.password ?? '')}@` : ''
    const srv = conn.ssl && !conn.port && conn.tunnel?.kind !== 'ssh' && /\./.test(host) && !/^\d+\.\d+/.test(host) && conn.host?.includes('mongodb.net')
    const uri = secrets.uri || `${srv ? 'mongodb+srv' : 'mongodb'}://${auth}${host}${srv ? '' : `:${port}`}/${encodeURIComponent(conn.database)}?${conn.ssl && !srv ? 'tls=true&' : ''}authSource=${encodeURIComponent(conn.authSource || 'admin')}${conn.tunnel?.kind === 'ssh' ? '&directConnection=true' : ''}`
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000, connectTimeoutMS: 15_000, appName: 'sinfonie' })
    try {
      await client.connect()
      const db = client.db(conn.database || undefined)
      await db.command({ ping: 1 })
      return { live: { client, db }, cleanup }
    } catch (err) {
      for (const c of cleanup) c()
      await client.close().catch(() => undefined)
      throw err
    }
  },
  async close(l) {
    await l.client.close().catch(() => undefined)
  },
  async version(l) {
    const info = (await l.db.admin().serverInfo().catch(() => ({ version: '?' }))) as { version?: string }
    return `MongoDB ${info.version ?? '?'} (${l.db.databaseName})`
  },
  async query(l, text, o) {
    const { cmd, op } = parseCommand(text)
    const col = l.db.collection(String(cmd.collection))
    const limit = Math.min(Number(cmd.limit ?? o.maxRows) || o.maxRows, o.maxRows + 1)
    const maxTimeMS = o.timeoutMs
    const docsOut = (docs: Record<string, unknown>[]): QueryOut => {
      const keys: string[] = []
      for (const d of docs) for (const k of Object.keys(d)) if (!keys.includes(k)) keys.push(k)
      keys.sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0))
      const rows = docs.slice(0, o.maxRows).map((d) => keys.map((k) => show(d[k])))
      return { columns: keys.map((k) => ({ name: k })), rows, rowCount: docs.length, truncated: docs.length > o.maxRows }
    }
    switch (op) {
      case 'find':
      case 'findOne': {
        const cursor = col.find((cmd[op] as Record<string, unknown>) ?? {}, { projection: cmd.projection as Record<string, number> | undefined, sort: cmd.sort as Record<string, 1 | -1> | undefined, skip: Number(cmd.skip ?? 0) || 0, limit: op === 'findOne' ? 1 : limit, maxTimeMS })
        return docsOut((await cursor.toArray()) as Record<string, unknown>[])
      }
      case 'aggregate': {
        const pipeline = (cmd.aggregate as Record<string, unknown>[]) ?? []
        const docs = (await col.aggregate([...pipeline, { $limit: limit }], { maxTimeMS }).toArray()) as Record<string, unknown>[]
        return docsOut(docs)
      }
      case 'count': {
        const n = await col.countDocuments((cmd.count as Record<string, unknown>) ?? {}, { maxTimeMS })
        return { columns: [{ name: 'count', type: 'number' }], rows: [[n]], rowCount: 1, truncated: false }
      }
      case 'distinct': {
        const vals = await col.distinct(String(cmd.distinct), (cmd.filter as Record<string, unknown>) ?? {}, { maxTimeMS })
        return { columns: [{ name: String(cmd.distinct) }], rows: vals.slice(0, o.maxRows).map((v) => [show(v)]), rowCount: vals.length, truncated: vals.length > o.maxRows }
      }
      case 'insertOne': {
        const r = await col.insertOne(cmd.insertOne as Record<string, unknown>)
        return { columns: [{ name: 'insertedId' }], rows: [[show(r.insertedId)]], rowCount: 1, truncated: false, affected: 1, command: 'insertOne' }
      }
      case 'insertMany': {
        const r = await col.insertMany(cmd.insertMany as Record<string, unknown>[])
        return { columns: [], rows: [], rowCount: 0, truncated: false, affected: r.insertedCount, command: `insertMany: ${r.insertedCount} inserted` }
      }
      case 'updateOne':
      case 'updateMany':
      case 'replaceOne': {
        const spec = cmd[op] as { filter?: Record<string, unknown>; update?: Record<string, unknown>; replacement?: Record<string, unknown>; upsert?: boolean }
        if (!spec?.filter) throw new Error(`${op} needs {"filter": {...}, "${op === 'replaceOne' ? 'replacement' : 'update'}": {...}}`)
        const r = op === 'replaceOne' ? await col.replaceOne(spec.filter, spec.replacement ?? {}, { upsert: spec.upsert }) : op === 'updateOne' ? await col.updateOne(spec.filter, spec.update ?? {}, { upsert: spec.upsert }) : await col.updateMany(spec.filter, spec.update ?? {}, { upsert: spec.upsert })
        return { columns: [], rows: [], rowCount: 0, truncated: false, affected: r.modifiedCount, command: `${op}: matched ${r.matchedCount}, modified ${r.modifiedCount}${r.upsertedCount ? `, upserted ${r.upsertedCount}` : ''}` }
      }
      case 'deleteOne':
      case 'deleteMany': {
        const spec = cmd[op] as { filter?: Record<string, unknown> } | Record<string, unknown>
        const filter = (spec && 'filter' in spec ? (spec as { filter: Record<string, unknown> }).filter : spec) ?? {}
        if (op === 'deleteMany' && Object.keys(filter).length === 0) throw new Error('deleteMany with an empty filter would wipe the collection; give a filter.')
        const r = op === 'deleteOne' ? await col.deleteOne(filter) : await col.deleteMany(filter)
        return { columns: [], rows: [], rowCount: 0, truncated: false, affected: r.deletedCount, command: `${op}: ${r.deletedCount} deleted` }
      }
    }
    throw new Error(`Unsupported operation ${op}`)
  },
  async schema(l) {
    const cols = await l.db.listCollections({}, { nameOnly: false }).toArray()
    const out: DbTable[] = []
    for (const c of cols.slice(0, 300)) {
      if (c.name.startsWith('system.')) continue
      const collection = l.db.collection(c.name)
      const fields = new Map<string, string>()
      let rows: number | undefined
      try {
        rows = await collection.estimatedDocumentCount({ maxTimeMS: 5000 })
        const sample = (await collection.find({}, { limit: 20, sort: { _id: -1 }, maxTimeMS: 5000 }).toArray()) as Record<string, unknown>[]
        for (const d of sample) for (const [k, v] of Object.entries(d)) if (!fields.has(k) && v !== null && v !== undefined) fields.set(k, v instanceof ObjectId ? 'ObjectId' : v instanceof Date ? 'Date' : Array.isArray(v) ? 'array' : typeof v)
        if (!fields.has('_id')) fields.set('_id', 'ObjectId')
      } catch {
        /* unreadable collection */
      }
      out.push({ schema: l.db.databaseName, name: c.name, kind: c.type === 'view' ? 'view' : 'table', rows, columns: Array.from(fields.entries()).map(([name, type]) => ({ name, type, nullable: true, pk: name === '_id' })) })
    }
    return out
  },
  async explain(l, text) {
    const { cmd, op } = parseCommand(text)
    const col = l.db.collection(String(cmd.collection))
    if (op === 'find' || op === 'findOne') return JSON.stringify(await col.find((cmd[op] as Record<string, unknown>) ?? {}, { sort: cmd.sort as Record<string, 1 | -1> | undefined }).explain('queryPlanner'), null, 1).slice(0, 20_000)
    if (op === 'aggregate') return JSON.stringify(await col.aggregate(cmd.aggregate as Record<string, unknown>[]).explain('queryPlanner'), null, 1).slice(0, 20_000)
    throw new Error('Explain works for find and aggregate.')
  },
  async update(l, req) {
    const id = req.pk._id
    if (id === undefined) throw new Error('Documents are updated by _id.')
    const _id = typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : id
    const r = await l.db.collection(req.table.name).updateOne({ _id: _id as never }, { $set: req.set })
    return r.modifiedCount
  },
  async insertRows(l, table, columns, rows) {
    const docs = rows.map((r) => Object.fromEntries(columns.map((c, j) => [c, r[j] ?? null])))
    const r = await l.db.collection(table.name).insertMany(docs)
    return r.insertedCount
  }
}
