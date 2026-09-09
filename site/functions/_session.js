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

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
/** The small page the browser lands on after an OAuth round trip. */
export function oauthPage(title, bodyHtml) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sinfonie · ${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ec;font:15px/1.5 -apple-system,system-ui,sans-serif}main{max-width:460px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#8b93a1;margin:0 0 16px}</style>
<main><h1>${esc(title)}</h1><p>${bodyHtml}</p></main></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  )
}
export { esc }

export const STATE_RE = /^[A-Za-z0-9_-]{16,64}$/

/** Admin-editable settings with their defaults. Values are strings in D1. */
export const SETTING_DEFAULTS = { trial_enabled: 'true', trial_days: '14', trial_plan: 'pro' }
export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM app_settings').all().catch(() => ({ results: [] }))
  const out = { ...SETTING_DEFAULTS }
  for (const r of results) if (r.key in out) out[r.key] = r.value
  return { trialEnabled: out.trial_enabled === 'true', trialDays: Math.max(0, Number(out.trial_days) || 0), trialPlan: out.trial_plan === 'team' ? 'team' : 'pro' }
}

/**
 * Finishes a sign-in from any provider: finds the user by provider id, else by verified email (so a
 * GitHub and a Google login with the same address are one account), else creates them; then mints a
 * desktop session and parks it under the app's state for /oauth/poll.
 */
export async function completeSignIn(env, request, state, identity) {
  const { provider, providerId, login, name, email, avatarUrl } = identity
  const col = provider === 'google' ? 'google_id' : 'github_id'
  let row = await env.DB.prepare(`SELECT id FROM users WHERE ${col} = ?1`).bind(providerId).first()
  // "Add an email": the app registered this state for a signed-in user, so the identity attaches to that account.
  const link = await env.DB.prepare('SELECT code FROM oauth_codes WHERE state = ?1').bind(`link:${state}`).first()
  if (link) {
    await env.DB.prepare('DELETE FROM oauth_codes WHERE state = ?1').bind(`link:${state}`).run()
    if (row && row.id !== link.code) throw new Error('That login already belongs to another Sinfonie account.')
    row = { id: link.code }
  }
  if (!row && email) row = await env.DB.prepare('SELECT user_id AS id FROM user_emails WHERE email = lower(?1)').bind(email).first()
  if (!row && email) row = await env.DB.prepare('SELECT id FROM users WHERE lower(email) = lower(?1)').bind(email).first()
  const userId = row?.id || newId()
  if (row) {
    await env.DB.prepare(`UPDATE users SET ${col} = ?2, login = COALESCE(login, ?3), name = COALESCE(?4, name), email = COALESCE(?5, email), avatar_url = COALESCE(?6, avatar_url), last_seen_at = datetime('now') WHERE id = ?1`)
      .bind(userId, providerId, login, name || null, email || null, avatarUrl || null)
      .run()
  } else {
    // A new account: the cardless trial, when the admin has it on.
    const st = await getSettings(env)
    const trialUntil = st.trialEnabled && st.trialDays > 0 ? new Date(Date.now() + st.trialDays * 86400_000).toISOString() : null
    await env.DB.prepare(`INSERT INTO users (id, ${col}, login, name, email, avatar_url, last_seen_at, trial_plan, trial_until) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), ?7, ?8)`)
      .bind(userId, providerId, login, name || null, email || null, avatarUrl || null, trialUntil ? st.trialPlan : null, trialUntil)
      .run()
  }
  if (email) await env.DB.prepare('INSERT OR IGNORE INTO user_emails (email, user_id, provider) VALUES (lower(?1), ?2, ?3)').bind(email, userId, provider).run()
  const token = randomToken(32)
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, user_agent) VALUES (?1, ?2, ?3)').bind(await sha256(token), userId, (request.headers.get('User-Agent') || '').slice(0, 200)),
    env.DB.prepare('INSERT OR REPLACE INTO oauth_codes (state, code) VALUES (?1, ?2)').bind(`session:${state}`, token)
  ])
  return userId
}

/** All verified emails of a user (backfilling the primary one for accounts from before the table existed). */
export async function emailsOf(env, user) {
  let { results } = await env.DB.prepare('SELECT email, provider FROM user_emails WHERE user_id = ?1 ORDER BY created_at').bind(user.id).all()
  if (!results.length && user.email) {
    await env.DB.prepare('INSERT OR IGNORE INTO user_emails (email, user_id, provider) VALUES (lower(?1), ?2, NULL)').bind(user.email, user.id).run()
    results = [{ email: user.email.toLowerCase(), provider: null }]
  }
  return results.map((r) => ({ email: r.email, provider: r.provider || undefined, primary: user.email ? r.email === user.email.toLowerCase() : false }))
}

/** A URL-safe unique slug for an organisation. */
export async function uniqueSlug(env, name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org'
  for (let i = 0; i < 20; i++) {
    const slug = i ? `${base}-${i + 1}` : base
    const hit = await env.DB.prepare('SELECT 1 FROM orgs WHERE slug = ?1').bind(slug).first()
    if (!hit) return slug
  }
  return `${base}-${randomToken(3).toLowerCase()}`
}

/** Free organisations may share one space; paying ones any number. */
export const FREE_ORG_SPACES = 1

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
  const overrideLive = user.plan_override && RANK[user.plan_override] !== undefined && (!user.plan_override_until || Date.parse(user.plan_override_until) > Date.now())
  if (overrideLive) plan = best(plan, user.plan_override)
  const trialLive = user.trial_plan && RANK[user.trial_plan] !== undefined && user.trial_until && Date.parse(user.trial_until) > Date.now()
  if (trialLive) plan = best(plan, user.trial_plan)
  if (subscriptionLive(user)) plan = best(plan, 'pro')
  const orgs = memberships.map((o) => {
    const orgPlan = o.plan_override === 'team' || subscriptionLive(o) ? 'team' : 'free'
    if (orgPlan === 'team') plan = best(plan, 'team')
    return { id: o.id, name: o.name, slug: o.slug || undefined, role: o.role, plan: orgPlan, seats: o.seats }
  })
  const emails = await emailsOf(env, user)
  const subscription = user.paddle_subscription_id
    ? { status: user.subscription_status, period: user.subscription_period || undefined, renewsAt: user.subscription_renews_at || undefined, endsAt: user.subscription_ends_at || undefined }
    : undefined
  return {
    user: { id: user.id, login: user.login, name: user.name || undefined, email: user.email || undefined, avatarUrl: user.avatar_url || undefined },
    emails,
    orgs,
    plan,
    subscription,
    // What gives the plan when it is not a subscription: a coupon/manual grant beats a trial of the same rank.
    grant: overrideLive && (!trialLive || RANK[user.plan_override] >= RANK[user.trial_plan]) ? { kind: user.plan_override_until ? 'coupon' : 'manual', plan: user.plan_override, until: user.plan_override_until || undefined } : trialLive ? { kind: 'trial', plan: user.trial_plan, until: user.trial_until } : undefined,
    enforce: String(env.PLANS_ENFORCED || '').toLowerCase() === 'true',
    billing: Boolean(env.PADDLE_API_KEY && env.PADDLE_PRICE_PRO_MONTH)
  }
}
