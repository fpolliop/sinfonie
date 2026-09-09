/**
 * POST /api/orgs/:id/join: join through a verified domain. With policy "open" the user becomes a
 * member at once (while a seat is free); with "approval" a request is filed for an admin; "off" refuses.
 */
import { currentUser, emailsOf, subscriptionLive, json, error } from '../../../_session.js'

export async function onRequestPost({ request, env, params }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const org = await env.DB.prepare('SELECT * FROM orgs WHERE id = ?1').bind(params.id).first()
  if (!org) return error('not_found', 'No such organisation.', 404)
  const member = await env.DB.prepare('SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2').bind(org.id, user.id).first()
  if (member) return json({ joined: true })
  const emails = await emailsOf(env, user)
  const domains = emails.map((e) => e.email.split('@')[1])
  const { results: verified } = await env.DB.prepare('SELECT domain FROM org_domains WHERE org_id = ?1 AND verified_at IS NOT NULL').bind(org.id).all()
  if (!verified.some((d) => domains.includes(d.domain))) return error('no_domain', 'None of your emails is on a domain this organisation verified.', 403)
  const policy = org.domain_join || 'approval'
  if (policy === 'off') return error('closed', 'This organisation does not accept domain joins. Ask an admin for an invite link.', 403)
  if (policy === 'approval') {
    await env.DB.prepare("INSERT INTO org_join_requests (org_id, user_id, status) VALUES (?1, ?2, 'pending') ON CONFLICT(org_id, user_id) DO UPDATE SET status = 'pending', created_at = datetime('now'), decided_by = NULL, decided_at = NULL").bind(org.id, user.id).run()
    return json({ joined: false, requested: true })
  }
  const paying = org.plan_override === 'team' || subscriptionLive(org)
  if (paying && org.seats > 0) {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?1').bind(org.id).first()
    if (Number(n?.n || 0) >= org.seats) return error('no_seats', `${org.name} has no free seats. Ask an admin to add seats.`, 409)
  }
  await env.DB.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?1, ?2, 'member')").bind(org.id, user.id).run()
  return json({ joined: true })
}
