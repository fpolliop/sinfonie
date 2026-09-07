/* Shared by the page and the service worker (classic script): pairing storage, key derivation, envelopes. */
;(function (root) {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const b64u = {
    encode: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    decode: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0))
  }
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)))

  // ---- pairing in IndexedDB (the service worker cannot use localStorage) ----
  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('sinfonie-m', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  async function kvGet(key) {
    const d = await db()
    return new Promise((resolve, reject) => {
      const r = d.transaction('kv').objectStore('kv').get(key)
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  }
  async function kvSet(key, value) {
    const d = await db()
    return new Promise((resolve, reject) => {
      const tx = d.transaction('kv', 'readwrite')
      tx.objectStore('kv').put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  /** { k, relay, roomId, auth, key } for the stored pairing, or null. */
  async function pairing() {
    const p = await kvGet('pairing')
    if (!p || !p.k) return null
    return derive(p.k, p.relay)
  }
  async function derive(k, relay) {
    const roomId = (await sha256('room:' + k)).slice(0, 32)
    const auth = await sha256('auth:' + k)
    const key = await crypto.subtle.importKey('raw', b64u.decode(k), 'AES-GCM', false, ['encrypt', 'decrypt'])
    return { k, relay: relay || 'https://relay.sinfonie.dev', roomId, auth, key }
  }
  async function savePairing(k, relay) {
    await kvSet('pairing', { k, relay })
  }
  async function seal(p, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, p.key, enc.encode(JSON.stringify(obj)))
    return JSON.stringify({ iv: b64u.encode(iv), ct: b64u.encode(ct) })
  }
  async function unseal(p, text) {
    const { iv, ct } = JSON.parse(text)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.decode(iv) }, p.key, b64u.decode(ct))
    return JSON.parse(dec.decode(pt))
  }
  const wsUrl = (p) => `${p.relay.replace(/^http/, 'ws')}/room/${p.roomId}/ws?role=phone&auth=${p.auth}`
  const sendUrl = (p) => `${p.relay}/room/${p.roomId}/send?auth=${p.auth}`

  root.SinfonieShared = { b64u, sha256, kvGet, kvSet, pairing, derive, savePairing, seal, unseal, wsUrl, sendUrl }
})(typeof self !== 'undefined' ? self : window)
