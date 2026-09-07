/**
 * Admin: one coupon. PATCH edits any of plan, maxUses (null = unlimited), durationDays (null = for
 * good), expiresAt, note, disabled. DELETE removes a code nobody redeemed; a redeemed one can only be disabled.
 */
import { authorize, json } from '../../../_auth.js'
import { couponFields, listCoupons, CODE_RE } from './index.js'

export async function onRequestPatch({ request, env, params }) {
  if (!(await authorize(request, env))) return json({ error: 'unauthorized' }, 401)
  const code = String(params.code || '').toUpperCase()
  if (!CODE_RE.test(code)) return json({ error: 'invalid_code' }, 400)
  const f = couponFields(await request.json().catch(() => ({})))
  const keys = Object.keys(f)
  if (!keys.length) return json({ error: 'invalid_request', error_description: 'Nothing to change.' }, 400)
  const res = await env.DB.prepare(`UPDATE coupons SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(', ')} WHERE code = ?1`).bind(code, ...keys.map((k) => f[k])).run()
  if (!res.meta?.changes) return json({ error: 'not_found' }, 404)
  return json({ coupons: await listCoupons(env) })
}

export async function onRequestDelete({ request, env, params }) {
  if (!(await authorize(request, env))) return json({ error: 'unauthorized' }, 401)
  const code = String(params.code || '').toUpperCase()
  const used = await env.DB.prepare('SELECT 1 FROM coupon_redemptions WHERE code = ?1 LIMIT 1').bind(code).first()
  if (used) return json({ error: 'redeemed', error_description: 'People redeemed this code; disable it instead so their access is traceable.' }, 409)
  await env.DB.prepare('DELETE FROM coupons WHERE code = ?1').bind(code).run()
  return json({ coupons: await listCoupons(env) })
}
