/**
 * Sinfonie accounts: desktop sessions and the plan a user is entitled to.
 *
 * A session is a random bearer token the desktop app keeps; only its SHA-256 is stored. The plan
 * is computed on every request from the user's own Paddle subscription, any team they belong to,
 * and manual overrides (founders, beta testers). Configure on Pages:
 *   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET   the GitHub OAuth app (callback /oauth/github/callback)
 *   PADDLE_API_KEY, PADDLE_ENV (sandbox|live), PADDLE_WEBHOOK_SECRET
 *   PADDLE_PRICE_PRO_MONTH, PADDLE_PRICE_PRO_YEAR, PADDLE_PRICE_TEAM_MONTH, PADDLE_PRICE_TEAM_YEAR
 *   PLANS_ENFORCED = "true" once checkout works; until then the app never locks anything.
 */
export const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
export const error = (code, description, status = 400) => json({ error: code, error_description: description }, status)

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
export function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const newId = () => randomToken(9)

export function bearer(request) {
  return (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
}

/** The user behind the request's bearer token, or null. Touches last_used_at at most once a day. */
export async function currentUser(request, env) {
  const token = bearer(request)
  if (!token || token.length < 32) return null
  const hash = await sha256(token)
  const row = await env.DB.prepare('SELECT u.*, s.last_used_at AS session_used FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1').bind(hash).first()
  if (!row) return null
  const today = new Date().toISOString().slice(0, 10)
  if ((row.session_used || '').slice(0, 10) !== today) {
    await env.DB.batch([env.DB.prepare("UPDATE sessions SET last_used_at = datetime('now') WHERE token_hash = ?1").bind(hash), env.DB.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?1").bind(row.id)]).catch(() => undefined)
  }
  return row
}

const LIVE = new Set(['active', 'trialing', 'past_due'])
/** A subscription row counts while Paddle still bills it, and for the paid period after a cancellation. */
export function subscriptionLive(row) {
  if (!row.subscription_status) return false
  if (LIVE.has(row.subscription_status)) return true
  if (row.subscription_status === 'canceled' && row.subscription_ends_at && Date.parse(row.subscription_ends_at) > Date.now()) return true
  return false
}
const RANK = { free: 0, pro: 1, team: 2 }
const best = (a, b) => (RANK[b] > RANK[a] ? b : a)

/** What the desktop app needs to know: identity, teams and the effective plan. */
export async function accountFor(user, env) {
  const { results: memberships } = await env.DB.prepare('SELECT o.*, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ?1 ORDER BY o.created_at').bind(user.id).all()
  let plan = 'free'
  if (user.plan_override && RANK[user.plan_override] !== undefined) plan = best(plan, user.plan_override)
  if (subscriptionLive(user)) plan = best(plan, 'pro')
  const orgs = memberships.map((o) => {
    const orgPlan = o.plan_override === 'team' || subscriptionLive(o) ? 'team' : 'free'
    if (orgPlan === 'team') plan = best(plan, 'team')
    return { id: o.id, name: o.name, role: o.role, plan: orgPlan, seats: o.seats }
  })
  const subscription = user.paddle_subscription_id
    ? { status: user.subscription_status, period: user.subscription_period || undefined, renewsAt: user.subscription_renews_at || undefined, endsAt: user.subscription_ends_at || undefined }
    : undefined
  return {
    user: { id: user.id, login: user.login, name: user.name || undefined, email: user.email || undefined, avatarUrl: user.avatar_url || undefined },
    orgs,
    plan,
    subscription,
    enforce: String(env.PLANS_ENFORCED || '').toLowerCase() === 'true',
    billing: Boolean(env.PADDLE_API_KEY && env.PADDLE_PRICE_PRO_MONTH)
  }
}
