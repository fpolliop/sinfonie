/**
 * Spaces shared inside an organisation. GET lists them (members). POST {id?, name, definition}
 * creates one (members); a free organisation may have FREE_ORG_SPACES of them.
 */
import { currentUser, subscriptionLive, json, error, newId, FREE_ORG_SPACES } from '../../../../_session.js'
import { membership } from '../index.js'

export const spaceView = (r) => ({ id: r.id, orgId: r.org_id, name: r.name, definition: JSON.parse(r.definition), version: r.version, updatedBy: r.updated_by || undefined, updatedAt: r.updated_at })

export async function onRequestGet({ request, env, params }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const org = await membership(env, params.id, user.id)
  if (!org) return error('not_found', 'No such organisation.', 404)
  const { results } = await env.DB.prepare('SELECT s.*, u.login AS updated_login FROM org_spaces s LEFT JOIN users u ON u.id = s.updated_by WHERE s.org_id = ?1 ORDER BY s.created_at').bind(org.id).all()
  return json({ spaces: results.map((r) => ({ ...spaceView(r), updatedBy: r.updated_login || undefined })) })
}

export async function onRequestPost({ request, env, params }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const org = await membership(env, params.id, user.id)
  if (!org) return error('not_found', 'No such organisation.', 404)
  const b = await request.json().catch(() => ({}))
  const name = String(b.name || b.definition?.name || '').trim().slice(0, 80)
  if (!name || !b.definition || typeof b.definition !== 'object') return error('invalid_request', 'A name and a definition are needed.')
  const paying = org.plan_override === 'team' || subscriptionLive(org)
  if (!paying) {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM org_spaces WHERE org_id = ?1').bind(org.id).first()
    if (Number(n?.n || 0) >= FREE_ORG_SPACES) return error('plan_limit', `A free organisation shares ${FREE_ORG_SPACES} space. The Team plan lifts the limit.`, 402)
  }
  const id = /^[A-Za-z0-9_-]{4,32}$/.test(String(b.id || '')) ? b.id : newId()
  const def = JSON.stringify({ ...b.definition, name, orgId: org.id })
  await env.DB.prepare('INSERT INTO org_spaces (id, org_id, name, definition, version, updated_by) VALUES (?1, ?2, ?3, ?4, 1, ?5)').bind(id, org.id, name, def, user.id).run()
  const row = await env.DB.prepare('SELECT * FROM org_spaces WHERE id = ?1').bind(id).first()
  return json({ ...spaceView(row), updatedBy: user.login })
}
