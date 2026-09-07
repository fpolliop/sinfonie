/** GET: who am I and what plan am I on. DELETE: sign this session out. */
import { currentUser, accountFor, bearer, sha256, json, error } from '../_session.js'

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  return json(await accountFor(user, env))
}
export async function onRequestDelete({ request, env }) {
  const token = bearer(request)
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256(token)).run().catch(() => undefined)
  return json({ ok: true })
}
