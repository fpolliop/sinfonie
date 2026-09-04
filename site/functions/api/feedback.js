/**
 * Feedback, feature requests and error reports, from the site form and the app.
 *   POST /api/feedback   { kind, message, email?, appVersion?, os?, context?, source }
 *   GET  /api/feedback?token=ADMIN_TOKEN[&kind=bug][&limit=200]   → JSON, newest first
 */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
const KINDS = new Set(['feedback', 'feature', 'bug', 'crash'])
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } })

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function onRequestPost({ request, env }) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid json' }, 400) }
  const kind = KINDS.has(body.kind) ? body.kind : 'feedback'
  const message = String(body.message ?? '').trim().slice(0, 8000)
  if (!message) return json({ error: 'message required' }, 400)
  const email = body.email ? String(body.email).trim().slice(0, 200) : null
  const context = body.context ? JSON.stringify(body.context).slice(0, 20000) : null
  const source = body.source === 'app' ? 'app' : 'site'
  // Same crash text within a day from the same version is stored once with a counter.
  if (kind === 'crash') {
    const dup = await env.DB.prepare(
      "SELECT id, count FROM feedback WHERE kind='crash' AND message=?1 AND app_version IS ?2 AND created_at > datetime('now','-1 day') LIMIT 1"
    ).bind(message, body.appVersion ?? null).first()
    if (dup) {
      await env.DB.prepare('UPDATE feedback SET count = count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?1').bind(dup.id).run()
      return json({ ok: true, id: dup.id, deduped: true })
    }
  }
  const r = await env.DB.prepare(
    'INSERT INTO feedback (kind, message, email, app_version, os, context, source, ip_country) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)'
  ).bind(kind, message, email, body.appVersion ?? null, body.os ?? null, context, source, request.cf?.country ?? null).run()
  return json({ ok: true, id: r.meta.last_row_id })
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url)
  if (!env.ADMIN_TOKEN || url.searchParams.get('token') !== env.ADMIN_TOKEN) return json({ error: 'unauthorized' }, 401)
  const kind = url.searchParams.get('kind')
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1000)
  const stmt = kind
    ? env.DB.prepare('SELECT * FROM feedback WHERE kind=?1 ORDER BY id DESC LIMIT ?2').bind(kind, limit)
    : env.DB.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT ?1').bind(limit)
  const { results } = await stmt.all()
  return json(results.map((r) => ({ ...r, context: r.context ? JSON.parse(r.context) : null })))
}
