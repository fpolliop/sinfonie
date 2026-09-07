/**
 * GET /api/invites/:token: what the invite is for (no sign-in needed; the join page shows it).
 * POST: accept it as the signed-in user. Needs a free seat unless the team has no subscription yet.
 */
import { currentUser, subscriptionLive, json, error } from '../../_session.js'
import { orgView } from '../orgs/index.js'

async function lookup(env, token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null
  return env.DB.prepare('SELECT i.*, o.name AS org_name, o.seats, o.subscription_status, o.subscription_ends_at, o.plan_override FROM org_invites i JOIN orgs o ON o.id = i.org_id WHERE i.token = ?1').bind(token).first()
}

export async function onRequestGet({ env, params }) {
  const inv = await lookup(env, params.token)
  if (!inv) return error('not_found', 'This invite does not exist.', 404)
  if (inv.accepted_at) return error('used', 'This invite was already used.', 410)
  return json({ org: { id: inv.org_id, name: inv.org_name }, role: inv.role, email: inv.email || undefined })
}

export async function onRequestPost({ request, env, params }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const inv = await lookup(env, params.token)
  if (!inv) return error('not_found', 'This invite does not exist.', 404)
  if (inv.accepted_at) return error('used', 'This invite was already used.', 410)
  const already = await env.DB.prepare('SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2').bind(inv.org_id, user.id).first()
  if (!already) {
    const paying = inv.plan_override === 'team' || subscriptionLive(inv)
    if (paying && inv.seats > 0) {
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?1').bind(inv.org_id).first()
      if (Number(n?.n || 0) >= inv.seats) return error('no_seats', `${inv.org_name} has no free seats. Ask an admin to add seats from the billing portal.`, 409)
    }
    await env.DB.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?1, ?2, ?3)').bind(inv.org_id, user.id, inv.role).run()
  }
  await env.DB.prepare("UPDATE org_invites SET accepted_by = ?2, accepted_at = datetime('now') WHERE token = ?1").bind(inv.token, user.id).run()
  const org = await env.DB.prepare('SELECT * FROM orgs WHERE id = ?1').bind(inv.org_id).first()
  return json(await orgView(env, org, already?.role || inv.role))
}
