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

let ipCache = { at: 0, base: '', cidrs: [] }
/**
 * Is this request from one of Paddle's published webhook addresses? Fetched from /ips (the source of
 * truth, which can change) and cached for an hour. Returns null when the list cannot be fetched, so the
 * caller can fall back to the signature alone rather than dropping real events.
 */
export async function fromPaddle(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || ''
  if (!ip) return null
  const base = paddleBase(env)
  if (Date.now() - ipCache.at > 3600_000 || ipCache.base !== base) {
    try {
      const r = await fetch(`${base}/ips`)
      const j = await r.json()
      if (Array.isArray(j.data?.ipv4_cidrs) && j.data.ipv4_cidrs.length) ipCache = { at: Date.now(), base, cidrs: j.data.ipv4_cidrs }
    } catch {
      /* keep the previous list, if any */
    }
  }
  if (!ipCache.cidrs.length) return null
  return ipCache.cidrs.some((c) => inCidr(ip, c))
}
function inCidr(ip, cidr) {
  const [net, bitsStr] = cidr.split('/')
  const bits = Number(bitsStr ?? 32)
  const toInt = (a) => a.split('.').reduce((n, o) => ((n << 8) + Number(o)) >>> 0, 0)
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(net)) return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return ((toInt(ip) & mask) >>> 0) === ((toInt(net) & mask) >>> 0)
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
