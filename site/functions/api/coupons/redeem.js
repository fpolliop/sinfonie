/**
 * POST /api/coupons/redeem {code}: grants the coupon's plan to the signed-in user by setting
 * plan_override (and plan_override_until when the coupon has a duration). A code counts once per user;
 * a higher plan already granted is never lowered.
 */
import { currentUser, accountFor, json, error } from '../../_session.js'

const RANK = { free: 0, pro: 1, team: 2 }

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  const b = await request.json().catch(() => ({}))
  const code = String(b.code || '').trim().toUpperCase().replace(/\s+/g, '')
  if (!/^[A-Z0-9-]{4,40}$/.test(code)) return error('invalid_code', 'That does not look like a code.')
  const c = await env.DB.prepare('SELECT * FROM coupons WHERE code = ?1').bind(code).first()
  if (!c) return error('unknown_code', 'This code does not exist.', 404)
  if (c.expires_at && Date.parse(c.expires_at) < Date.now()) return error('expired', 'This code has expired.', 410)
  const already = await env.DB.prepare('SELECT 1 FROM coupon_redemptions WHERE code = ?1 AND user_id = ?2').bind(code, user.id).first()
  if (already) return error('already_used', 'You already used this code.', 409)
  if (c.max_uses !== null && c.uses >= c.max_uses) return error('exhausted', 'This code has been used up.', 410)
  const until = c.duration_days ? new Date(Date.now() + c.duration_days * 86400_000).toISOString() : null
  // Keep a higher existing grant; extend an equal one to the later date (a grant with no end stays that way).
  const currentLive = user.plan_override && (!user.plan_override_until || Date.parse(user.plan_override_until) > Date.now())
  const keepExisting = currentLive && RANK[user.plan_override] > RANK[c.plan]
  let newUntil = until
  if (currentLive && user.plan_override === c.plan) {
    const existing = user.plan_override_until
    newUntil = !until || !existing ? null : Date.parse(existing) > Date.parse(until) ? existing : until
  }
  await env.DB.batch([
    env.DB.prepare('INSERT INTO coupon_redemptions (code, user_id) VALUES (?1, ?2)').bind(code, user.id),
    env.DB.prepare('UPDATE coupons SET uses = uses + 1 WHERE code = ?1').bind(code),
    ...(keepExisting ? [] : [env.DB.prepare('UPDATE users SET plan_override = ?2, plan_override_until = ?3 WHERE id = ?1').bind(user.id, c.plan, newUntil)])
  ])
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(user.id).first()
  return json(await accountFor(fresh, env))
}
