/** The desktop app polls this with its own state until the callback has parked the code. One-shot: the row is deleted on delivery. */
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
export async function onRequestGet({ request, env }) {
  const state = new URL(request.url).searchParams.get('state') || ''
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(state)) return json({ error: 'bad_state' }, 400)
  await env.DB.prepare("DELETE FROM oauth_codes WHERE created_at < datetime('now', '-10 minutes')").run().catch(() => undefined)
  const row = await env.DB.prepare('SELECT code FROM oauth_codes WHERE state = ?1').bind(state).first()
  if (!row) return json({ pending: true })
  await env.DB.prepare('DELETE FROM oauth_codes WHERE state = ?1').bind(state).run()
  return json({ code: row.code })
}
