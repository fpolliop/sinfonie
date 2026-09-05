import { authorize, json } from '../../_auth.js'

/** GET /api/admin/feedback?kind=&status=&q=&limit= — the queue, newest first, plus counts. */
export async function onRequestGet({ request, env }) {
  const who = await authorize(request, env)
  if (!who) return json({ error: 'unauthorized' }, 401)
  const url = new URL(request.url)
  const kind = url.searchParams.get('kind')
  const status = url.searchParams.get('status')
  const q = url.searchParams.get('q')
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 300), 1000)
  const where = [], binds = []
  if (kind) { where.push('kind = ?'); binds.push(kind) }
  if (status) { where.push('status = ?'); binds.push(status) }
  if (q) { where.push('(message LIKE ? OR email LIKE ? OR app_version LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  const sql = `SELECT * FROM feedback ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
  const { results } = await env.DB.prepare(sql).bind(...binds, limit).all()
  const ids = results.map((r) => r.id)
  const atts = ids.length ? (await env.DB.prepare(`SELECT id, feedback_id, mime, name FROM attachments WHERE feedback_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results : []
  const byFeedback = {}
  for (const a of atts) (byFeedback[a.feedback_id] ||= []).push({ id: a.id, mime: a.mime, name: a.name })
  const counts = await env.DB.prepare("SELECT kind, status, COUNT(*) AS n, SUM(count) AS hits, SUM(CASE WHEN created_at > datetime('now','-7 day') THEN 1 ELSE 0 END) AS week FROM feedback GROUP BY kind, status").all()
  return json({ who: who.email, via: who.via, items: results.map((r) => ({ ...r, context: safeJson(r.context), attachments: byFeedback[r.id] ?? [] })), counts: counts.results })
}

function safeJson(s) { try { return s ? JSON.parse(s) : null } catch { return s } }
