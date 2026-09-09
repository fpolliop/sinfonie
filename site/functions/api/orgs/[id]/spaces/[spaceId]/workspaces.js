/**
 * What members are working on in a shared space.
 *   PUT {workspaces: [{workspaceId, name, slug, stage, status, repos: [{name, branch}], ticket?, lastActivityAt}]}
 *       replaces the caller's rows for this space (an empty list clears them)
 *   GET  everyone else's rows, with who they belong to
 * Only names, branches, stages and times travel; never chat content.
 */
import { currentUser, json, error } from '../../../../../_session.js'
import { membership } from '../../index.js'

export async function onRequestPut({ request, env, params }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const org = await membership(env, params.id, user.id)
  if (!org) return error('not_found', 'No such organisation.', 404)
  const space = await env.DB.prepare('SELECT id FROM org_spaces WHERE id = ?1 AND org_id = ?2').bind(params.spaceId, org.id).first()
  if (!space) return error('not_found', 'No such shared space.', 404)
  const b = await request.json().catch(() => ({}))
  const list = Array.isArray(b.workspaces) ? b.workspaces.slice(0, 200) : []
  const stmts = [env.DB.prepare('DELETE FROM org_workspaces WHERE org_space_id = ?1 AND user_id = ?2').bind(space.id, user.id)]
  for (const w of list) {
    if (!w || typeof w.workspaceId !== 'string' || typeof w.name !== 'string') continue
    stmts.push(
      env.DB.prepare("INSERT INTO org_workspaces (id, org_id, org_space_id, user_id, workspace_id, name, slug, stage, status, repos, ticket, last_activity_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, datetime('now'))").bind(
        `${user.id}:${w.workspaceId}`,
        org.id,
        space.id,
        user.id,
        w.workspaceId,
        String(w.name).slice(0, 120),
        String(w.slug || w.name).slice(0, 120),
        w.stage ? String(w.stage) : null,
        w.status ? String(w.status) : null,
        JSON.stringify(Array.isArray(w.repos) ? w.repos.slice(0, 20).map((r) => ({ name: String(r.name || '').slice(0, 80), branch: String(r.branch || '').slice(0, 200) })) : []),
        w.ticket ? String(w.ticket).slice(0, 60) : null,
        w.lastActivityAt ? String(w.lastActivityAt) : null
      )
    )
  }
  await env.DB.batch(stmts)
  return json({ ok: true, count: list.length })
}

export async function onRequestGet({ request, env, params }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const org = await membership(env, params.id, user.id)
  if (!org) return error('not_found', 'No such organisation.', 404)
  const { results } = await env.DB.prepare('SELECT w.*, u.login, u.name AS user_name, u.avatar_url FROM org_workspaces w JOIN users u ON u.id = w.user_id WHERE w.org_space_id = ?1 AND w.user_id != ?2 ORDER BY w.last_activity_at DESC, w.updated_at DESC')
    .bind(params.spaceId, user.id)
    .all()
  return json({
    workspaces: results.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      user: { id: r.user_id, login: r.login, name: r.user_name || undefined, avatarUrl: r.avatar_url || undefined },
      name: r.name,
      slug: r.slug,
      stage: r.stage || undefined,
      status: r.status || undefined,
      repos: JSON.parse(r.repos || '[]'),
      ticket: r.ticket || undefined,
      lastActivityAt: r.last_activity_at || undefined,
      updatedAt: r.updated_at
    }))
  })
}
