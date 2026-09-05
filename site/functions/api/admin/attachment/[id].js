import { authorize } from '../../../_auth.js'

/** GET /api/admin/attachment/:id — the screenshot bytes; authorised like the rest of the admin (header or ?token=). */
export async function onRequestGet({ request, env, params }) {
  const who = await authorize(request, env)
  if (!who) return new Response('unauthorized', { status: 401 })
  const row = await env.DB.prepare('SELECT mime, data FROM attachments WHERE id = ?1').bind(Number(params.id)).first()
  if (!row) return new Response('not found', { status: 404 })
  const bytes = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0))
  return new Response(bytes, { headers: { 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=3600' } })
}
