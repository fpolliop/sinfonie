/** PATCH /api/orgs/:id/members/:userId {role}: change a role (admin). DELETE: remove a member (admin). */
import { currentUser, json, error } from '../../../../_session.js'
import { orgView } from '../../index.js'
import { membership } from '../index.js'

async function admin(request, env, params) {
  const user = await currentUser(request, env)
  if (!user) return { res: error('unauthorized', 'Sign in again.', 401) }
  const org = await membership(env, params.id, user.id)
  if (!org) return { res: error('not_found', 'No such team.', 404) }
  if (org.role !== 'admin') return { res: error('forbidden', 'Only admins can manage members.', 403) }
  return { user, org }
}
async function adminCount(env, orgId) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?1 AND role = 'admin'").bind(orgId).first()
  return Number(r?.n || 0)
}

export async function onRequestPatch({ request, env, params }) {
  const { res, org } = await admin(request, env, params)
  if (res) return res
  const b = await request.json().catch(() => ({}))
  const role = b.role === 'admin' ? 'admin' : 'member'
  const target = await env.DB.prepare('SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2').bind(org.id, params.userId).first()
  if (!target) return error('not_found', 'Not a member.', 404)
  if (target.role === 'admin' && role === 'member' && (await adminCount(env, org.id)) <= 1) return error('last_admin', 'A team needs at least one admin.', 409)
  await env.DB.prepare('UPDATE org_members SET role = ?3 WHERE org_id = ?1 AND user_id = ?2').bind(org.id, params.userId, role).run()
  return json(await orgView(env, org, org.role))
}

export async function onRequestDelete({ request, env, params }) {
  const { res, org } = await admin(request, env, params)
  if (res) return res
  const target = await env.DB.prepare('SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2').bind(org.id, params.userId).first()
  if (!target) return error('not_found', 'Not a member.', 404)
  if (target.role === 'admin' && (await adminCount(env, org.id)) <= 1) return error('last_admin', 'A team needs at least one admin.', 409)
  await env.DB.prepare('DELETE FROM org_members WHERE org_id = ?1 AND user_id = ?2').bind(org.id, params.userId).run()
  return json(await orgView(env, org, org.role))
}
