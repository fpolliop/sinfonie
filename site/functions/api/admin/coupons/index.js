/**
 * Admin: coupon codes. Authorised like the other admin endpoints (Cloudflare Access or ADMIN_TOKEN).
 *   GET  /api/admin/coupons   list codes with their redemptions (who, when)
 *   POST /api/admin/coupons   {code?, prefix?, plan?, maxUses?, durationDays?, expiresAt?, note?}
 *        creates one; code is generated when omitted (BETA-7K3Q-M2XA); plan defaults to team;
 *        maxUses null = unlimited redemptions; durationDays null = access for good.
 * Editing and disabling live in ./coupons/[code].js.
 */
import { authorize, json } from '../../../_auth.js'

export function generate(prefix = 'BETA') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const a = new Uint8Array(8)
  crypto.getRandomValues(a)
  const s = [...a].map((b) => alphabet[b % alphabet.length]).join('')
  return `${String(prefix || 'BETA').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'BETA'}-${s.slice(0, 4)}-${s.slice(4)}`
}
export const CODE_RE = /^[A-Z0-9-]{4,40}$/

/** Turn the request body's fields into column values; undefined means "leave as is". */
export function couponFields(b) {
  const out = {}
  if (b.plan !== undefined) out.plan = ['pro', 'team'].includes(b.plan) ? b.plan : 'team'
  if (b.maxUses !== undefined) out.max_uses = b.maxUses === null || b.maxUses === '' ? null : Math.max(1, Math.round(Number(b.maxUses)) || 1)
  if (b.durationDays !== undefined) out.duration_days = b.durationDays === null || b.durationDays === '' ? null : Math.max(1, Math.round(Number(b.durationDays)) || 1)
  if (b.expiresAt !== undefined) out.expires_at = b.expiresAt ? new Date(b.expiresAt).toISOString() : null
  if (b.note !== undefined) out.note = b.note ? String(b.note).slice(0, 200) : null
  if (b.disabled !== undefined) out.disabled = b.disabled ? 1 : 0
  return out
}

export async function listCoupons(env) {
  const { results } = await env.DB.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all()
  const { results: reds } = await env.DB.prepare('SELECT r.code, r.redeemed_at, u.login, u.name FROM coupon_redemptions r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.redeemed_at DESC').all()
  const byCode = {}
  for (const r of reds) (byCode[r.code] = byCode[r.code] || []).push({ login: r.login, name: r.name, at: r.redeemed_at })
  return results.map((c) => ({
    code: c.code,
    plan: c.plan,
    maxUses: c.max_uses,
    uses: c.uses,
    durationDays: c.duration_days,
    expiresAt: c.expires_at,
    note: c.note,
    disabled: Boolean(c.disabled),
    createdAt: c.created_at,
    redemptions: byCode[c.code] || [],
    url: `https://sinfonie.dev/redeem/${c.code}`
  }))
}

export async function onRequestGet({ request, env }) {
  if (!(await authorize(request, env))) return json({ error: 'unauthorized' }, 401)
  return json({ coupons: await listCoupons(env) })
}

export async function onRequestPost({ request, env }) {
  if (!(await authorize(request, env))) return json({ error: 'unauthorized' }, 401)
  const b = await request.json().catch(() => ({}))
  const code = String(b.code || generate(b.prefix)).trim().toUpperCase().replace(/\s+/g, '')
  if (!CODE_RE.test(code)) return json({ error: 'invalid_code', error_description: 'Letters, digits and dashes, 4 to 40 characters.' }, 400)
  const f = { plan: 'team', max_uses: 1, duration_days: null, expires_at: null, note: null, ...couponFields(b) }
  try {
    await env.DB.prepare('INSERT INTO coupons (code, plan, max_uses, duration_days, expires_at, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(code, f.plan, f.max_uses, f.duration_days, f.expires_at, f.note).run()
  } catch (e) {
    if (/UNIQUE/.test(String(e))) return json({ error: 'exists', error_description: 'That code already exists.' }, 409)
    throw e
  }
  return json({ code, url: `https://sinfonie.dev/redeem/${code}`, coupons: await listCoupons(env) })
}
