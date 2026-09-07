/**
 * Admin: coupon codes. Authorised like the other admin endpoints (Cloudflare Access or ADMIN_TOKEN).
 *   GET  /api/admin/coupons                       list codes with use counts
 *   POST /api/admin/coupons {code?, plan?, maxUses?, durationDays?, expiresAt?, note?}
 *        creates one; code is generated when omitted (e.g. BETA-7K3Q-M2XA); plan defaults to team.
 */
import { authorize, json } from '../../_auth.js'

function generate(prefix = 'BETA') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const a = new Uint8Array(8)
  crypto.getRandomValues(a)
  const s = [...a].map((b) => alphabet[b % alphabet.length]).join('')
  return `${prefix}-${s.slice(0, 4)}-${s.slice(4)}`
}

export async function onRequestGet({ request, env }) {
  if (!(await authorize(request, env))) return json({ error: 'unauthorized' }, 401)
  const { results } = await env.DB.prepare('SELECT c.*, (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.code = c.code) AS redemptions FROM coupons c ORDER BY created_at DESC').all()
  return json({ coupons: results })
}

export async function onRequestPost({ request, env }) {
  if (!(await authorize(request, env))) return json({ error: 'unauthorized' }, 401)
  const b = await request.json().catch(() => ({}))
  const plan = ['pro', 'team'].includes(b.plan) ? b.plan : 'team'
  const code = String(b.code || generate(b.prefix)).trim().toUpperCase().replace(/\s+/g, '')
  if (!/^[A-Z0-9-]{4,40}$/.test(code)) return json({ error: 'invalid_code', error_description: 'Letters, digits and dashes, 4 to 40 characters.' }, 400)
  const maxUses = b.maxUses === undefined || b.maxUses === null ? null : Math.max(1, Number(b.maxUses) || 1)
  const durationDays = b.durationDays ? Math.max(1, Number(b.durationDays) || 0) || null : null
  const expiresAt = b.expiresAt ? new Date(b.expiresAt).toISOString() : null
  try {
    await env.DB.prepare('INSERT INTO coupons (code, plan, max_uses, duration_days, expires_at, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(code, plan, maxUses, durationDays, expiresAt, b.note ? String(b.note).slice(0, 200) : null).run()
  } catch (e) {
    if (/UNIQUE/.test(String(e))) return json({ error: 'exists', error_description: 'That code already exists.' }, 409)
    throw e
  }
  return json({ code, plan, maxUses, durationDays, expiresAt, redeemUrl: `https://sinfonie.dev/redeem/${code}` })
}
