import * as gcp from '../../gcp'
import { classifySql, type Driver, type QueryOut } from '../common'
import type { DbTable } from '@shared/types'

/** BigQuery over its REST API with the space's gcloud token; stateless, one job per query. */
export interface BqLive {
  projectId: string
  location?: string
  account?: string
  jobId?: string
}
const q = (s: string): string => `\`${s.replace(/`/g, '\\`')}\``
type Json = Record<string, unknown>

async function api(l: BqLive, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Json> {
  const token = await gcp.accessToken(l.account)
  const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const j = (await res.json().catch(() => ({}))) as Json & { error?: { message?: string } }
  if (!res.ok) throw new Error(j.error?.message ?? `BigQuery ${res.status}`)
  return j
}
function convert(v: unknown, type: string): unknown {
  if (v === null || v === undefined) return null
  switch (type) {
    case 'INTEGER':
    case 'INT64':
    case 'FLOAT':
    case 'FLOAT64':
    case 'NUMERIC':
    case 'BIGNUMERIC':
      return Number.isSafeInteger(Number(v)) || type.startsWith('FLOAT') ? Number(v) : String(v)
    case 'BOOLEAN':
    case 'BOOL':
      return v === 'true' || v === true
    case 'TIMESTAMP':
      return new Date(Number(v) * 1000).toISOString()
    default:
      return v
  }
}
function rowsOf(schema: { fields?: { name: string; type: string; mode?: string; fields?: unknown[] }[] } | undefined, rows: { f: { v: unknown }[] }[] | undefined): { columns: { name: string; type?: string }[]; rows: unknown[][] } {
  const fields = schema?.fields ?? []
  const cell = (f: { name: string; type: string; mode?: string; fields?: unknown[] }, cellV: unknown): unknown => {
    if (f.mode === 'REPEATED') return ((cellV as { v: unknown }[]) ?? []).map((x) => (f.type === 'RECORD' ? recordOf(f, x.v) : convert(x.v, f.type)))
    if (f.type === 'RECORD' || f.type === 'STRUCT') return recordOf(f, cellV)
    return convert(cellV, f.type)
  }
  const recordOf = (f: { fields?: unknown[] }, v: unknown): unknown => {
    const inner = (f.fields ?? []) as { name: string; type: string; mode?: string; fields?: unknown[] }[]
    const vals = ((v as { f?: { v: unknown }[] })?.f ?? []) as { v: unknown }[]
    return Object.fromEntries(inner.map((g, i) => [g.name, cell(g, vals[i]?.v)]))
  }
  return { columns: fields.map((f) => ({ name: f.name, type: `${f.type.toLowerCase()}${f.mode === 'REPEATED' ? '[]' : ''}` })), rows: (rows ?? []).map((r) => fields.map((f, i) => cell(f, r.f[i]?.v))) }
}

export const bigquery: Driver<BqLive> = {
  quote: q,
  classify: classifySql,
  async open(conn, _secrets, spaceId) {
    const projectId = conn.projectId || gcp.gcpFor(spaceId)?.projectId
    if (!projectId) throw new Error('BigQuery connection needs a project id.')
    const l: BqLive = { projectId, location: conn.location || undefined, account: conn.account || gcp.gcpFor(spaceId)?.account }
    await api(l, 'GET', `projects/${projectId}/datasets?maxResults=1`)
    return { live: l, cleanup: [] }
  },
  async close() {
    /* stateless */
  },
  async version(l) {
    return `BigQuery project ${l.projectId}${l.location ? ` (${l.location})` : ''}`
  },
  async query(l, text, o) {
    const body: Json = { query: text, useLegacySql: false, maxResults: Math.min(o.maxRows + 1, 10_000), timeoutMs: Math.min(o.timeoutMs, 180_000), ...(l.location ? { location: l.location } : {}) }
    let j = await api(l, 'POST', `projects/${l.projectId}/queries`, body)
    const ref = j.jobReference as { jobId: string; location?: string } | undefined
    l.jobId = ref?.jobId
    const deadline = Date.now() + o.timeoutMs
    while (!j.jobComplete && ref && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000))
      j = await api(l, 'GET', `projects/${l.projectId}/queries/${ref.jobId}?maxResults=${Math.min(o.maxRows + 1, 10_000)}${ref.location ? `&location=${ref.location}` : ''}&timeoutMs=10000`)
    }
    l.jobId = undefined
    if (!j.jobComplete) throw new Error('BigQuery job did not finish in time; cancel or narrow the query.')
    const total = Number(j.totalRows ?? 0)
    const { columns, rows } = rowsOf(j.schema as never, j.rows as never)
    const affected = j.numDmlAffectedRows !== undefined ? Number(j.numDmlAffectedRows) : undefined
    const out: QueryOut = { columns, rows: rows.slice(0, o.maxRows), rowCount: total || rows.length, truncated: total > o.maxRows || rows.length > o.maxRows, command: `${(Number(j.totalBytesProcessed ?? 0) / 1_048_576).toFixed(1)} MB processed${j.cacheHit ? ' (cache)' : ''}` }
    if (affected !== undefined) out.affected = affected
    return out
  },
  async schema(l) {
    const ds = (await api(l, 'GET', `projects/${l.projectId}/datasets?maxResults=200`)).datasets as { datasetReference: { datasetId: string; projectId: string }; location?: string }[] | undefined
    const out: DbTable[] = []
    for (const d of (ds ?? []).slice(0, 40)) {
      const id = d.datasetReference.datasetId
      try {
        const j = await api(l, 'POST', `projects/${l.projectId}/queries`, { query: `SELECT table_name, column_name, data_type, is_nullable FROM ${q(l.projectId)}.${q(id)}.INFORMATION_SCHEMA.COLUMNS ORDER BY table_name, ordinal_position`, useLegacySql: false, maxResults: 10_000, timeoutMs: 60_000, ...(d.location ? { location: d.location } : {}) })
        const byTable = new Map<string, DbTable>()
        for (const r of (j.rows as { f: { v: string }[] }[] | undefined) ?? []) {
          const [tname, col, type, nullable] = r.f.map((x) => x.v)
          let t = byTable.get(tname)
          if (!t) {
            t = { schema: id, name: tname, kind: 'table', columns: [] }
            byTable.set(tname, t)
          }
          t.columns!.push({ name: col, type: type.toLowerCase(), nullable: nullable === 'YES' })
        }
        out.push(...byTable.values())
      } catch {
        out.push({ schema: id, name: '(no access)', kind: 'view', columns: [], readable: false })
      }
    }
    return out
  },
  async cancel(l) {
    if (!l.jobId) return 'No job running.'
    await api(l, 'POST', `projects/${l.projectId}/jobs/${l.jobId}/cancel${l.location ? `?location=${l.location}` : ''}`, {})
    return `Cancel requested for job ${l.jobId}.`
  },
  async explain(l, text) {
    const j = await api(l, 'POST', `projects/${l.projectId}/queries`, { query: text, useLegacySql: false, dryRun: true, ...(l.location ? { location: l.location } : {}) })
    const bytes = Number(j.totalBytesProcessed ?? 0)
    return `Dry run: ${(bytes / 1_073_741_824).toFixed(3)} GB would be processed (about $${((bytes / 1_099_511_627_776) * 6.25).toFixed(4)} on-demand). ${j.cacheHit ? 'Would hit the cache.' : ''}`
  },
  async update(l, req) {
    const params: { name: string; parameterType: { type: string }; parameterValue: { value: string } }[] = []
    const p = (v: unknown): string => {
      const name = `p${params.length}`
      params.push({ name, parameterType: { type: typeof v === 'number' ? (Number.isInteger(v) ? 'INT64' : 'FLOAT64') : typeof v === 'boolean' ? 'BOOL' : 'STRING' }, parameterValue: { value: String(v) } })
      return `@${name}`
    }
    const sets = Object.entries(req.set).map(([k, v]) => `${q(k)} = ${v === null ? 'NULL' : p(v)}`)
    const where = Object.entries(req.pk).map(([k, v]) => (v === null ? `${q(k)} IS NULL` : `${q(k)} = ${p(v)}`))
    const j = await api(l, 'POST', `projects/${l.projectId}/queries`, { query: `UPDATE ${q(l.projectId)}.${q(req.table.schema)}.${q(req.table.name)} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`, useLegacySql: false, parameterMode: 'NAMED', queryParameters: params, timeoutMs: 120_000, ...(l.location ? { location: l.location } : {}) })
    return Number(j.numDmlAffectedRows ?? 0)
  },
  async insertRows(l, table, columns, rows) {
    let n = 0
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      const j = await api(l, 'POST', `projects/${l.projectId}/datasets/${table.schema}/tables/${table.name}/insertAll`, { rows: chunk.map((r) => ({ json: Object.fromEntries(columns.map((c, k) => [c, r[k] ?? null])) })) })
      const errs = j.insertErrors as { index: number; errors: { message: string }[] }[] | undefined
      if (errs?.length) throw new Error(`Row ${i + errs[0].index + 1}: ${errs[0].errors[0]?.message ?? 'insert error'}`)
      n += chunk.length
    }
    return n
  }
}
