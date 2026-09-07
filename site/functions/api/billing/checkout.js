/**
 * POST /api/billing/checkout?plan=pro|team&period=month|year&seats=N&org=Name
 * Creates the Paddle transaction server-side (price ids never ship in the app) and returns the URL
 * to open. Team checkouts create the org first, with the buyer as admin; the webhook fills in the rest.
 */
import { currentUser, subscriptionLive, newId, json, error } from '../../_session.js'
import { paddle, paddleConfigured, priceFor } from '../../_paddle.js'

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env)
  if (!user) return error('unauthorized', 'Sign in again.', 401)
  if (!paddleConfigured(env)) return error('not_configured', 'Checkout is not open yet.', 503)
  const q = new URL(request.url).searchParams
  const plan = q.get('plan')
  const period = q.get('period') || 'year'
  const seats = Math.min(500, Math.max(1, Number(q.get('seats') || 1) || 1))
  if (!['pro', 'team'].includes(plan) || !['month', 'year'].includes(period)) return error('invalid_request', 'Unknown plan or period.')
  const priceId = priceFor(env, plan, period)
  if (!priceId) return error('not_configured', `No price configured for ${plan}/${period}.`, 503)

  const custom = { user_id: user.id, plan }
  let quantity = 1
  if (plan === 'pro') {
    if (subscriptionLive(user)) return error('already_subscribed', 'You already have a Pro subscription. Manage it from the billing portal.', 409)
  } else {
    quantity = seats
    // Reuse an org the user administers that is not paying yet; otherwise make one.
    let org = await env.DB.prepare("SELECT o.* FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ?1 AND m.role = 'admin' ORDER BY o.created_at LIMIT 1").bind(user.id).first()
    if (org && subscriptionLive(org)) return error('already_subscribed', `${org.name} already has a Team subscription. Change seats from the billing portal.`, 409)
    if (!org) {
      const id = newId()
      const name = (q.get('org') || '').trim().slice(0, 80) || `${user.name || user.login}'s team`
      await env.DB.batch([
        env.DB.prepare('INSERT INTO orgs (id, name, owner_user_id, seats) VALUES (?1, ?2, ?3, 0)').bind(id, name, user.id),
        env.DB.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?1, ?2, 'admin')").bind(id, user.id)
      ])
      org = { id, name }
    }
    custom.org_id = org.id
  }
  const customerId = plan === 'pro' ? user.paddle_customer_id : null
  const body = {
    items: [{ price_id: priceId, quantity }],
    custom_data: custom,
    ...(customerId ? { customer_id: customerId } : {})
  }
  const txn = await paddle(env, 'POST', '/transactions', body)
  // Paddle fills checkout.url when the account has a default payment link; our /checkout page is the fallback.
  const url = txn.checkout?.url || `https://sinfonie.dev/checkout?_ptxn=${encodeURIComponent(txn.id)}`
  return json({ url, transactionId: txn.id })
}
