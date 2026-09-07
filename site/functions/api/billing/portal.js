/** POST /api/billing/portal: a Paddle customer-portal link (invoices, payment method, cancel, seats). */
import { currentUser, json, error } from '../../_session.js'
import { paddle, paddleConfigured } from '../../_paddle.js'

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  if (!paddleConfigured(env)) return error('not_configured', 'Billing is not open yet.', 503)
  let customerId = user.paddle_customer_id
  if (!customerId) {
    const org = await env.DB.prepare("SELECT o.paddle_customer_id FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ?1 AND m.role = 'admin' AND o.paddle_customer_id IS NOT NULL LIMIT 1").bind(user.id).first()
    customerId = org?.paddle_customer_id
  }
  if (!customerId) return error('no_customer', 'There is no subscription to manage yet.', 404)
  const session = await paddle(env, 'POST', `/customers/${customerId}/portal-sessions`, {})
  return json({ url: session.urls?.general?.overview })
}
