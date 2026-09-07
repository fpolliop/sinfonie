/**
 * Paddle notifications. Point Paddle at https://sinfonie.dev/api/billing/webhook with the
 * subscription.* events and put the endpoint's secret in PADDLE_WEBHOOK_SECRET. Every accepted event
 * is logged in billing_events (idempotent on event id) and applied to the user or org named in the
 * subscription's custom_data, or found by subscription id.
 */
import { json, error } from '../../_session.js'
import { verifySignature, planForPrice, fromPaddle } from '../../_paddle.js'

export async function onRequestPost({ request, env }) {
  // Defence in depth: Paddle's published source addresses, then the signature (which is what actually authenticates).
  if ((await fromPaddle(request, env)) === false) return error('forbidden', 'Not a Paddle address.', 403)
  const raw = await request.text()
  if (!(await verifySignature(request.headers.get('Paddle-Signature'), raw, env.PADDLE_WEBHOOK_SECRET))) return error('bad_signature', 'Signature check failed.', 401)
  let evt
  try {
    evt = JSON.parse(raw)
  } catch {
    return error('invalid_json', 'Body is not JSON.')
  }
  const type = String(evt.event_type || '')
  const data = evt.data || {}
  if (!type.startsWith('subscription.')) return json({ ignored: type })
  const dup = await env.DB.prepare('SELECT 1 FROM billing_events WHERE id = ?1').bind(evt.event_id).first()
  if (dup) return json({ duplicate: true })
  await env.DB.prepare('INSERT INTO billing_events (id, type, subscription_id, payload) VALUES (?1, ?2, ?3, ?4)').bind(evt.event_id, type, data.id || null, raw.slice(0, 60_000)).run()

  const item = (data.items || [])[0] || {}
  const mapped = planForPrice(env, item.price?.id)
  const period = mapped?.period || (data.billing_cycle?.interval === 'year' ? 'year' : 'month')
  const status = data.status || null
  const renewsAt = data.current_billing_period?.ends_at || data.next_billed_at || null
  const cancelScheduled = data.scheduled_change?.action === 'cancel' ? data.scheduled_change.effective_at : null
  // On cancellation Paddle keeps access until the period end; we record that as ends_at.
  const endsAt = status === 'canceled' ? data.current_billing_period?.ends_at || data.canceled_at || null : cancelScheduled
  const custom = data.custom_data || {}
  const fields = { customer: data.customer_id || null, sub: data.id, status, period, renewsAt, endsAt }

  const orgId = custom.org_id || (await env.DB.prepare('SELECT id FROM orgs WHERE paddle_subscription_id = ?1').bind(data.id).first())?.id
  if (orgId) {
    const seats = Number(item.quantity || 0) || 0
    await env.DB.prepare('UPDATE orgs SET paddle_customer_id = COALESCE(?2, paddle_customer_id), paddle_subscription_id = ?3, subscription_status = ?4, subscription_period = ?5, subscription_renews_at = ?6, subscription_ends_at = ?7, seats = ?8 WHERE id = ?1')
      .bind(orgId, fields.customer, fields.sub, fields.status, fields.period, fields.renewsAt, fields.endsAt, seats)
      .run()
    return json({ ok: true, org: orgId })
  }
  const userId = custom.user_id || (await env.DB.prepare('SELECT id FROM users WHERE paddle_subscription_id = ?1').bind(data.id).first())?.id
  if (userId) {
    await env.DB.prepare('UPDATE users SET paddle_customer_id = COALESCE(?2, paddle_customer_id), paddle_subscription_id = ?3, subscription_status = ?4, subscription_period = ?5, subscription_renews_at = ?6, subscription_ends_at = ?7 WHERE id = ?1')
      .bind(userId, fields.customer, fields.sub, fields.status, fields.period, fields.renewsAt, fields.endsAt)
      .run()
    return json({ ok: true, user: userId })
  }
  console.error('webhook: no owner for subscription', data.id, custom)
  return json({ ok: true, unmatched: true })
}
