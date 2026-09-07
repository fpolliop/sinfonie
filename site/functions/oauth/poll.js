/** The desktop app polls this with its state until a sign-in callback (GitHub or Google) has parked a session token. One-shot. */
import { json, error, STATE_RE } from '../_session.js'

export async function onRequestGet({ request, env }) {
  const state = new URL(request.url).searchParams.get('state') || ''
  if (!STATE_RE.test(state)) return error('bad_state', 'Malformed state.')
  await env.DB.prepare("DELETE FROM oauth_codes WHERE created_at < datetime('now', '-10 minutes')").run().catch(() => undefined)
  const row = await env.DB.prepare('SELECT code FROM oauth_codes WHERE state = ?1').bind(`session:${state}`).first()
  if (!row) return json({ pending: true })
  await env.DB.prepare('DELETE FROM oauth_codes WHERE state = ?1').bind(`session:${state}`).run()
  return json({ token: row.code })
}
