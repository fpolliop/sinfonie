/** POST /api/orgs/:id/invites {email?, role?}: create an invite link (admin). DELETE ?token=: revoke one. */
import { currentUser, randomToken, json, error } from '../../../_session.js'
import { orgView } from '../index.js'
import { membership } from './index.js'

export async function onRequestPost({ request, env, params }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const org = await membership(env, params.id, user.id)
  if (!org) return error('not_found', 'No such team.', 404)
  if (org.role !== 'admin') return error('forbidden', 'Only admins can invite.', 403)
  const b = await request.json().catch(() => ({}))
  const role = b.role === 'admin' ? 'admin' : 'member'
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200) || null
  const token = randomToken(18)
  await env.DB.prepare('INSERT INTO org_invites (token, org_id, email, role, created_by) VALUES (?1, ?2, ?3, ?4, ?5)').bind(token, org.id, email, role, user.id).run()
  return json(await orgView(env, org, org.role))
}

export async function onRequestDelete({ request, env, params }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const org = await membership(env, params.id, user.id)
  if (!org) return error('not_found', 'No such team.', 404)
  if (org.role !== 'admin') return error('forbidden', 'Only admins can revoke invites.', 403)
  const token = new URL(request.url).searchParams.get('token') || ''
  await env.DB.prepare('DELETE FROM org_invites WHERE org_id = ?1 AND token = ?2 AND accepted_at IS NULL').bind(org.id, token).run()
  return json(await orgView(env, org, org.role))
}
