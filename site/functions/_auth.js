/**
 * Admin authorization. Preferred: a Cloudflare Access identity (the Cf-Access-Jwt-Assertion
 * header Access adds to protected requests) whose email is ADMIN_EMAIL, with the JWT signature
 * verified against the team's public keys. Fallback while Access is not configured: the
 * ADMIN_TOKEN secret, passed as a bearer header or ?token=.
 */
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0))
const decodeSeg = (s) => JSON.parse(new TextDecoder().decode(b64url(s)))

let jwksCache = { at: 0, keys: [] }
async function jwks(teamDomain) {
  if (Date.now() - jwksCache.at < 10 * 60 * 1000 && jwksCache.keys.length) return jwksCache.keys
  const r = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!r.ok) throw new Error('jwks fetch failed')
  const j = await r.json()
  jwksCache = { at: Date.now(), keys: j.keys || [] }
  return jwksCache.keys
}

export async function verifyAccessJwt(token, env) {
  const [h, p, s] = token.split('.')
  if (!h || !p || !s) return null
  const header = decodeSeg(h), payload = decodeSeg(p)
  if (payload.exp && payload.exp * 1000 < Date.now()) return null
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!auds.includes(env.ACCESS_AUD)) return null
  const keys = await jwks(env.ACCESS_TEAM_DOMAIN)
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) return null
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`))
  return ok ? payload : null
}

/** Returns { email } when authorized, else null. */
export async function authorize(request, env) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion')
  if (jwt && env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN) {
    const payload = await verifyAccessJwt(jwt, env).catch(() => null)
    if (payload && env.ADMIN_EMAIL && String(payload.email).toLowerCase() === env.ADMIN_EMAIL.toLowerCase()) return { email: payload.email, via: 'access' }
    return null
  }
  const url = new URL(request.url)
  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  const token = bearer || url.searchParams.get('token')
  if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) return { email: env.ADMIN_EMAIL || 'token', via: 'token' }
  return null
}

export const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
