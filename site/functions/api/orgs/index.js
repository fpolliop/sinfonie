/**
 * GET /api/orgs: the organisations the user belongs to, with members, domains, shared spaces and
 * (for admins) open invites and join requests. POST {name}: create one; the creator is its admin.
 * An organisation without a Team subscription is free and may share one space.
 */
import { currentUser, subscriptionLive, json, error, newId, uniqueSlug, FREE_ORG_SPACES } from '../../_session.js'

export async function orgView(env, org, role) {
  const [{ results: members }, { results: domains }, spaces] = await Promise.all([
    env.DB.prepare('SELECT u.id, u.login, u.name, u.avatar_url, m.role, m.created_at FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?1 ORDER BY m.created_at').bind(org.id).all(),
    env.DB.prepare('SELECT domain, verified_at, token FROM org_domains WHERE org_id = ?1 ORDER BY created_at').bind(org.id).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM org_spaces WHERE org_id = ?1').bind(org.id).first()
  ])
  const plan = org.plan_override === 'team' || subscriptionLive(org) ? 'team' : 'free'
  const out = {
    id: org.id,
    name: org.name,
    slug: org.slug || undefined,
    role,
    plan,
    seats: org.seats,
    domainJoin: org.domain_join || 'approval',
    defaultMode: org.default_mode === 'guided' ? 'guided' : 'expert',
    domains: domains.map((d) => ({ domain: d.domain, verified: Boolean(d.verified_at), ...(role === 'admin' && !d.verified_at ? { token: d.token } : {}) })),
    sharedSpaces: Number(spaces?.n || 0),
    sharedSpaceLimit: plan === 'team' ? null : FREE_ORG_SPACES,
    subscription: org.paddle_subscription_id ? { status: org.subscription_status, period: org.subscription_period || undefined, renewsAt: org.subscription_renews_at || undefined, endsAt: org.subscription_ends_at || undefined } : undefined,
    members: members.map((m) => ({ id: m.id, login: m.login, name: m.name || undefined, avatarUrl: m.avatar_url || undefined, role: m.role, since: m.created_at })),
    invites: [],
    requests: []
  }
  if (role === 'admin') {
    const [{ results: invites }, { results: requests }] = await Promise.all([
      env.DB.prepare('SELECT token, email, role, created_at FROM org_invites WHERE org_id = ?1 AND accepted_at IS NULL ORDER BY created_at').bind(org.id).all(),
      env.DB.prepare("SELECT r.user_id, r.created_at, u.login, u.name, u.email, u.avatar_url FROM org_join_requests r JOIN users u ON u.id = r.user_id WHERE r.org_id = ?1 AND r.status = 'pending' ORDER BY r.created_at").bind(org.id).all()
    ])
    out.invites = invites.map((i) => ({ token: i.token, email: i.email || undefined, role: i.role, createdAt: i.created_at, url: `https://sinfonie.dev/join/${i.token}` }))
    out.requests = requests.map((r) => ({ userId: r.user_id, login: r.login, name: r.name || undefined, email: r.email || undefined, avatarUrl: r.avatar_url || undefined, at: r.created_at }))
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

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const b = await request.json().catch(() => ({}))
  const name = String(b.name || '').trim().slice(0, 80)
  if (!name) return error('invalid_request', 'Give the organisation a name.')
  const id = newId()
  const slug = await uniqueSlug(env, name)
  await env.DB.batch([
    env.DB.prepare('INSERT INTO orgs (id, name, slug, owner_user_id, seats) VALUES (?1, ?2, ?3, ?4, 0)').bind(id, name, slug, user.id),
    env.DB.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?1, ?2, 'admin')").bind(id, user.id)
  ])
  const org = await env.DB.prepare('SELECT * FROM orgs WHERE id = ?1').bind(id).first()
  return json(await orgView(env, org, 'admin'))
}
