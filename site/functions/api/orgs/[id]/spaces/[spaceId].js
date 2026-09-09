/**
 * One shared space. PUT {name?, definition, version}: replace the definition; `version` must be the
 * one the client last saw, else 409 with the current row so the client can merge. DELETE: admins, or
 * the member who created it.
 */
import { currentUser, json, error } from '../../../../_session.js'
import { membership } from '../index.js'
import { spaceView } from './index.js'

export async function onRequestPut({ request, env, params }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const org = await membership(env, params.id, user.id)
  if (!org) return error('not_found', 'No such organisation.', 404)
  const row = await env.DB.prepare('SELECT * FROM org_spaces WHERE id = ?1 AND org_id = ?2').bind(params.spaceId, org.id).first()
  if (!row) return error('not_found', 'No such shared space.', 404)
  const b = await request.json().catch(() => ({}))
  if (!b.definition || typeof b.definition !== 'object') return error('invalid_request', 'A definition is needed.')
  if (Number(b.version) !== row.version) return json({ error: 'stale', error_description: 'Someone updated this space since you last synced.', current: spaceView(row) }, 409)
  const name = String(b.name || b.definition.name || row.name).trim().slice(0, 80)
  const def = JSON.stringify({ ...b.definition, name, orgId: org.id })
  await env.DB.prepare("UPDATE org_spaces SET name = ?2, definition = ?3, version = version + 1, updated_by = ?4, updated_at = datetime('now') WHERE id = ?1").bind(row.id, name, def, user.id).run()
  const fresh = await env.DB.prepare('SELECT * FROM org_spaces WHERE id = ?1').bind(row.id).first()
  return json(spaceView(fresh))
}

export async function onRequestDelete({ request, env, params }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const org = await membership(env, params.id, user.id)
  if (!org) return error('not_found', 'No such organisation.', 404)
  const row = await env.DB.prepare('SELECT * FROM org_spaces WHERE id = ?1 AND org_id = ?2').bind(params.spaceId, org.id).first()
  if (!row) return error('not_found', 'No such shared space.', 404)
  if (org.role !== 'admin' && row.updated_by !== user.id) return error('forbidden', 'Only admins can remove a shared space.', 403)
  await env.DB.prepare('DELETE FROM org_spaces WHERE id = ?1').bind(row.id).run()
  return json({ ok: true })
}
