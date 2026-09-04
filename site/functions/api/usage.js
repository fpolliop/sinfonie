/**
 * Anonymous daily usage ping from the app. One row per install per UTC day (upsert).
 * Payload: { installId, appVersion, os, engines: string[], workspaces, messages, firstSeen }
 */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } })
export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }) }
export async function onRequestPost({ request, env }) {
  let b
  try { b = await request.json() } catch { return json({ error: 'invalid json' }, 400) }
  const id = String(b.installId ?? '').slice(0, 64)
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return json({ error: 'bad install id' }, 400)
  const day = new Date().toISOString().slice(0, 10)
  await env.DB.prepare(
    `INSERT INTO usage (day, install_id, app_version, os, engines, workspaces, messages, first_seen)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT(day, install_id) DO UPDATE SET app_version=excluded.app_version, os=excluded.os, engines=excluded.engines,
       workspaces=MAX(usage.workspaces, excluded.workspaces), messages=usage.messages+excluded.messages, updated_at=CURRENT_TIMESTAMP`
  ).bind(day, id, String(b.appVersion ?? '').slice(0, 32), String(b.os ?? '').slice(0, 64), Array.isArray(b.engines) ? b.engines.join(',').slice(0, 64) : null, Number(b.workspaces) || 0, Number(b.messages) || 0, b.firstSeen ? String(b.firstSeen).slice(0, 32) : null).run()
  return json({ ok: true })
}
