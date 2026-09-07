/** Paddle Billing, the merchant of record: API calls and webhook signature checks. */
export const paddleBase = (env) => (env.PADDLE_ENV === 'live' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com')
export const paddleConfigured = (env) => Boolean(env.PADDLE_API_KEY && env.PADDLE_PRICE_PRO_MONTH)

export async function paddle(env, method, path, body) {
  const r = await fetch(`${paddleBase(env)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.PADDLE_API_KEY}`, 'Content-Type': 'application/json', 'Paddle-Version': '1' },
    body: body ? JSON.stringify(body) : undefined
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error?.detail || j.error?.code || `Paddle answered ${r.status}`)
  return j.data
}

/** price id for a plan and period, from the Pages environment. */
export function priceFor(env, plan, period) {
  const key = `PADDLE_PRICE_${plan.toUpperCase()}_${period.toUpperCase()}`
  return env[key] || null
}
/** The reverse: which plan and period a Paddle price id stands for. */
export function planForPrice(env, priceId) {
  for (const plan of ['pro', 'team']) for (const period of ['month', 'year']) if (env[`PADDLE_PRICE_${plan.toUpperCase()}_${period.toUpperCase()}`] === priceId) return { plan, period }
  return null
}

/** Verifies Paddle-Signature (ts=…;h1=…) over `${ts}:${rawBody}` with the webhook secret; five-minute replay window. */
export async function verifySignature(header, rawBody, secret) {
  if (!header || !secret) return false
  const parts = Object.fromEntries(header.split(';').map((kv) => kv.split('=').map((s) => s.trim())))
  const ts = Number(parts.ts)
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.ts}:${rawBody}`))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const given = header
    .split(';')
    .filter((kv) => kv.trim().startsWith('h1='))
    .map((kv) => kv.trim().slice(3))
  return given.some((h) => h.length === hex.length && timingSafeEqual(h, hex))
}
function timingSafeEqual(a, b) {
  let out = 0
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return out === 0
}
