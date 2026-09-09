/** POST /api/orgs/:id/requests {userId, action: 'approve' | 'deny'}: decide a domain join request (admin). */
import { currentUser, subscriptionLive, json, error } from '../../../_session.js'
import { orgView } from '../index.js'
import { membership } from './index.js'

export async function onRequestPost({ request, env, params }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const org = await membership(env, params.id, user.id)
  if (!org) return error('not_found', 'No such organisation.', 404)
  if (org.role !== 'admin') return error('forbidden', 'Only admins decide join requests.', 403)
  const b = await request.json().catch(() => ({}))
  const target = String(b.userId || '')
  const req = await env.DB.prepare("SELECT 1 FROM org_join_requests WHERE org_id = ?1 AND user_id = ?2 AND status = 'pending'").bind(org.id, target).first()
  if (!req) return error('not_found', 'No pending request from that person.', 404)
  if (b.action === 'approve') {
    const paying = org.plan_override === 'team' || subscriptionLive(org)
    if (paying && org.seats > 0) {
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?1').bind(org.id).first()
      if (Number(n?.n || 0) >= org.seats) return error('no_seats', 'No free seats. Add seats from the billing portal first.', 409)
    }
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?1, ?2, 'member')").bind(org.id, target),
      env.DB.prepare("UPDATE org_join_requests SET status = 'approved', decided_by = ?3, decided_at = datetime('now') WHERE org_id = ?1 AND user_id = ?2").bind(org.id, target, user.id)
    ])
  } else {
    await env.DB.prepare("UPDATE org_join_requests SET status = 'denied', decided_by = ?3, decided_at = datetime('now') WHERE org_id = ?1 AND user_id = ?2").bind(org.id, target, user.id).run()
  }
  return json(await orgView(env, org, org.role))
}
