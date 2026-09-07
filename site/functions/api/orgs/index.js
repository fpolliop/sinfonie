/** GET /api/orgs: the teams the user belongs to, with members and (for admins) open invites. */
import { currentUser, subscriptionLive, json, error } from '../../_session.js'

export async function orgView(env, org, role) {
  const { results: members } = await env.DB.prepare('SELECT u.id, u.login, u.name, u.avatar_url, m.role, m.created_at FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?1 ORDER BY m.created_at').bind(org.id).all()
  const out = {
    id: org.id,
    name: org.name,
    role,
    plan: org.plan_override === 'team' || subscriptionLive(org) ? 'team' : 'free',
    seats: org.seats,
    subscription: org.paddle_subscription_id ? { status: org.subscription_status, period: org.subscription_period || undefined, renewsAt: org.subscription_renews_at || undefined, endsAt: org.subscription_ends_at || undefined } : undefined,
    members: members.map((m) => ({ id: m.id, login: m.login, name: m.name || undefined, avatarUrl: m.avatar_url || undefined, role: m.role, since: m.created_at })),
    invites: []
  }
  if (role === 'admin') {
    const { results: invites } = await env.DB.prepare('SELECT token, email, role, created_at FROM org_invites WHERE org_id = ?1 AND accepted_at IS NULL ORDER BY created_at').bind(org.id).all()
    out.invites = invites.map((i) => ({ token: i.token, email: i.email || undefined, role: i.role, createdAt: i.created_at, url: `https://sinfonie.dev/join/${i.token}` }))
  }
  return out
}

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const { results } = await env.DB.prepare('SELECT o.*, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ?1 ORDER BY o.created_at').bind(user.id).all()
  const orgs = []
  for (const o of results) orgs.push(await orgView(env, o, o.role))
  return json({ orgs })
}
