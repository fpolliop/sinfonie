/**
 * GET /api/orgs/discover: organisations that verified a domain of one of the user's emails and
 * that the user is not in yet, with how joining works for each (open, approval, off) and whether a
 * request is already pending.
 */
import { currentUser, emailsOf, json, error } from '../../_session.js'

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const emails = await emailsOf(env, user)
  const domains = [...new Set(emails.map((e) => e.email.split('@')[1]).filter(Boolean))]
  if (!domains.length) return json({ orgs: [] })
  const marks = domains.map((_, i) => `?${i + 1}`).join(', ')
  const { results } = await env.DB.prepare(`SELECT o.id, o.name, o.slug, o.domain_join, d.domain FROM org_domains d JOIN orgs o ON o.id = d.org_id WHERE d.verified_at IS NOT NULL AND d.domain IN (${marks})`).bind(...domains).all()
  const out = []
  for (const r of results) {
    if (out.some((x) => x.id === r.id)) continue
    const member = await env.DB.prepare('SELECT 1 FROM org_members WHERE org_id = ?1 AND user_id = ?2').bind(r.id, user.id).first()
    if (member) continue
    const req = await env.DB.prepare('SELECT status FROM org_join_requests WHERE org_id = ?1 AND user_id = ?2').bind(r.id, user.id).first()
    out.push({ id: r.id, name: r.name, slug: r.slug || undefined, domain: r.domain, domainJoin: r.domain_join || 'approval', requested: req?.status === 'pending', denied: req?.status === 'denied' })
  }
  return json({ orgs: out })
}
