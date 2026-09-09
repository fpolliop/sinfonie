/**
 * POST /api/me/link {state}: the signed-in user is about to sign in with another provider to add
 * that email to this account. The callback finds `link:<state>` and attaches the identity here
 * instead of creating a second account. DELETE /api/me/link?email= removes a non-primary email.
 */
import { currentUser, json, error, STATE_RE } from '../../_session.js'

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const b = await request.json().catch(() => ({}))
  const state = String(b.state || '')
  if (!STATE_RE.test(state)) return error('bad_state', 'Malformed state.')
  await env.DB.prepare('INSERT OR REPLACE INTO oauth_codes (state, code) VALUES (?1, ?2)').bind(`link:${state}`, user.id).run()
  return json({ ok: true })
}

export async function onRequestDelete({ request, env }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const email = (new URL(request.url).searchParams.get('email') || '').toLowerCase()
  if (user.email && email === user.email.toLowerCase()) return error('primary', 'The primary email stays; sign in with another one and make it primary first.', 409)
  await env.DB.prepare('DELETE FROM user_emails WHERE email = ?1 AND user_id = ?2').bind(email, user.id).run()
  return json({ ok: true })
}
