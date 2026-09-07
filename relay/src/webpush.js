/**
 * Web Push from a Worker with WebCrypto only: RFC 8291 message encryption (aes128gcm) and RFC 8292
 * VAPID. The payload we hand a browser is already what the desktop asked us to show, so the relay
 * sees notification titles; conversation content never comes through here.
 */
const enc = new TextEncoder()
export const b64u = {
  encode: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0))
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let o = 0
  for (const p of parts) {
    out.set(new Uint8Array(p), o)
    o += p.byteLength
  }
  return out
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8))
}

/** Encrypts `plaintext` for a PushSubscription (p256dh, auth) per RFC 8291. Returns the aes128gcm body. */
export async function encryptPayload(subscription, plaintext) {
  const uaPublic = b64u.decode(subscription.keys.p256dh)
  const authSecret = b64u.decode(subscription.keys.auth)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256))
  // IKM = HKDF(auth, ecdh, "WebPush: info" || ua_public || as_public, 32)
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // One record: plaintext || 0x02 delimiter (last record).
  const padded = concat(enc.encode(plaintext), new Uint8Array([2]))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, padded))
  const rs = 4096
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, asPublic.length]), asPublic)
  return concat(header, ct)
}

/** VAPID JWT (ES256) for the push service's origin. */
export async function vapidHeaders(endpoint, env) {
  const aud = new URL(endpoint).origin
  const header = b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u.encode(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:hello@sinfonie.dev' })))
  const pub = b64u.decode(env.VAPID_PUBLIC_KEY)
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)))
  return { Authorization: `vapid t=${header}.${claims}.${b64u.encode(sig)}, k=${env.VAPID_PUBLIC_KEY}` }
}

/** Sends one push. Returns { ok, status, gone } where gone means the subscription should be dropped. */
export async function sendPush(subscription, payload, env, ttl = 600) {
  const body = await encryptPayload(subscription, JSON.stringify(payload))
  const headers = { ...(await vapidHeaders(subscription.endpoint, env)), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: 'high' }
  const r = await fetch(subscription.endpoint, { method: 'POST', headers, body })
  return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410 }
}
