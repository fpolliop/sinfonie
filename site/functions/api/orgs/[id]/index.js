/** PATCH /api/orgs/:id {name?, domainJoin?}: rename or set the domain-join policy (admin). DELETE: leave the team (any member; the last admin cannot leave). */
import { currentUser, json, error } from '../../../_session.js'
import { orgView } from '../index.js'

export async function membership(env, orgId, userId) {
  const org = await env.DB.prepare('SELECT o.*, m.role FROM orgs o JOIN org_members m ON m.org_id = o.id AND m.user_id = ?2 WHERE o.id = ?1').bind(orgId, userId).first()
  return org || null
}

export async function onRequestPatch({ request, env, params }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const org = await membership(env, params.id, user.id)
  if (!org) return error('not_found', 'No such team.', 404)
  if (org.role !== 'admin') return error('forbidden', 'Only admins can rename the team.', 403)
  const b = await request.json().catch(() => ({}))
  const patch = { ...org }
  if (b.name !== undefined) {
    const name = String(b.name || '').trim().slice(0, 80)
    if (!name) return error('invalid_request', 'Name is required.')
    await env.DB.prepare('UPDATE orgs SET name = ?2 WHERE id = ?1').bind(org.id, name).run()
    patch.name = name
  }
  if (['open', 'approval', 'off'].includes(b.domainJoin)) {
    await env.DB.prepare('UPDATE orgs SET domain_join = ?2 WHERE id = ?1').bind(org.id, b.domainJoin).run()
    patch.domain_join = b.domainJoin
  }
  return json(await orgView(env, patch, org.role))
}

export async function onRequestDelete({ request, env, params }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const org = await membership(env, params.id, user.id)
  if (!org) return error('not_found', 'No such team.', 404)
  if (org.role === 'admin') {
    const admins = await env.DB.prepare("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?1 AND role = 'admin'").bind(org.id).first()
    if (Number(admins?.n) <= 1) return error('last_admin', 'You are the only admin. Make someone else admin first.', 409)
  }
  await env.DB.prepare('DELETE FROM org_members WHERE org_id = ?1 AND user_id = ?2').bind(org.id, user.id).run()
  return json({ ok: true })
}
