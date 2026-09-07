/**
 * Sinfonie relay: pairs a Mac with its phones. One Durable Object per room; the room id and the
 * auth token are both derived from a key only the two ends hold, and every conversation message is
 * encrypted end to end with that key before it gets here. The relay forwards opaque envelopes,
 * queues phone → desktop messages while the Mac is offline, and sends Web Push on request.
 *
 *   GET  /room/:id/ws?role=desktop|phone&auth=…   WebSocket
 *   POST /room/:id/send?auth=…                    one envelope for the desktop (from the service worker)
 *   POST /room/:id/push?auth=…                    register a PushSubscription
 *   GET  /vapid                                   the public key phones subscribe with
 */
import { sendPush } from './webpush.js'

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } })
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
    if (url.pathname === '/vapid') return json({ publicKey: env.VAPID_PUBLIC_KEY || null })
    const m = /^\/room\/([a-f0-9]{32})\/(ws|send|push)$/.exec(url.pathname)
    if (!m) return json({ error: 'not_found' }, 404)
    const auth = url.searchParams.get('auth') || ''
    if (!/^[a-f0-9]{64}$/.test(auth)) return json({ error: 'bad_auth' }, 400)
    const room = env.ROOMS.get(env.ROOMS.idFromName(m[1]))
    return room.fetch(request)
  }
}

const QUEUE_MAX = 200
const timingSafeEqual = (a, b) => {
  if (a.length !== b.length) return false
  let out = 0
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return out === 0
}

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async authorized(auth, role) {
    const stored = await this.ctx.storage.get('auth')
    if (!stored) {
      // The first desktop to arrive claims the room. Phones cannot create rooms.
      if (role !== 'desktop') return false
      await this.ctx.storage.put('auth', auth)
      return true
    }
    return timingSafeEqual(stored, auth)
  }

  async fetch(request) {
    const url = new URL(request.url)
    const action = url.pathname.split('/').pop()
    const auth = url.searchParams.get('auth') || ''
    const role = url.searchParams.get('role') === 'desktop' ? 'desktop' : 'phone'
    if (!(await this.authorized(auth, role))) return json({ error: 'unauthorized' }, 401)

    if (action === 'ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426)
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1], [role])
      if (role === 'desktop') await this.flushQueue(pair[1])
      else this.broadcast('desktop', JSON.stringify({ ctl: 'presence', phones: this.sockets('phone').length }))
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    if (action === 'send' && request.method === 'POST') {
      const text = (await request.text()).slice(0, 64_000)
      await this.toDesktop(text)
      return json({ ok: true })
    }
    if (action === 'push' && request.method === 'POST') {
      const sub = await request.json().catch(() => null)
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json({ error: 'bad_subscription' }, 400)
      const subs = (await this.ctx.storage.get('pushSubs')) || {}
      subs[sub.endpoint] = { endpoint: sub.endpoint, keys: sub.keys, addedAt: Date.now() }
      await this.ctx.storage.put('pushSubs', subs)
      return json({ ok: true, count: Object.keys(subs).length })
    }
    return json({ error: 'not_found' }, 404)
  }

  sockets(role) {
    return this.ctx.getWebSockets(role)
  }
  broadcast(role, text) {
    for (const ws of this.sockets(role)) {
      try {
        ws.send(text)
      } catch {
        /* closing */
      }
    }
  }
  async toDesktop(text) {
    const desktops = this.sockets('desktop')
    if (desktops.length) return this.broadcast('desktop', text)
    const q = (await this.ctx.storage.get('queue')) || []
    q.push(text)
    while (q.length > QUEUE_MAX) q.shift()
    await this.ctx.storage.put('queue', q)
  }
  async flushQueue(ws) {
    const q = (await this.ctx.storage.get('queue')) || []
    if (!q.length) return
    await this.ctx.storage.delete('queue')
    for (const t of q) ws.send(t)
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 512_000) return
    const [role] = this.ctx.getTags(ws)
    // Control messages are the only plaintext the relay reads.
    if (message.startsWith('{"ctl"')) {
      let ctl
      try {
        ctl = JSON.parse(message)
      } catch {
        return
      }
      if (role === 'desktop' && ctl.ctl === 'notify') return this.notify(ctl)
      if (role === 'desktop' && ctl.ctl === 'presence?') return ws.send(JSON.stringify({ ctl: 'presence', phones: this.sockets('phone').length }))
      if (role === 'desktop' && ctl.ctl === 'reset') {
        // Unpairing: forget subscriptions and the queue; the auth token is rotated by the next desktop connect.
        await this.ctx.storage.deleteAll()
        for (const p of this.sockets('phone')) p.close(4001, 'unpaired')
        return
      }
      if (role === 'phone' && ctl.ctl === 'push-subscribe' && ctl.subscription?.endpoint) {
        const subs = (await this.ctx.storage.get('pushSubs')) || {}
        subs[ctl.subscription.endpoint] = { endpoint: ctl.subscription.endpoint, keys: ctl.subscription.keys, addedAt: Date.now() }
        await this.ctx.storage.put('pushSubs', subs)
        return ws.send(JSON.stringify({ ctl: 'push-ok', count: Object.keys(subs).length }))
      }
      return
    }
    if (role === 'desktop') this.broadcast('phone', message)
    else await this.toDesktop(message)
  }

  async webSocketClose(ws) {
    const [role] = this.ctx.getTags(ws)
    if (role === 'phone') this.broadcast('desktop', JSON.stringify({ ctl: 'presence', phones: Math.max(0, this.sockets('phone').length - 1) }))
  }
  async webSocketError(ws) {
    try {
      ws.close(1011, 'error')
    } catch {
      /* already closed */
    }
  }

  /** Sends the desktop's notification to every subscribed phone; drops subscriptions the push service says are gone. */
  async notify(ctl) {
    if (!this.env.VAPID_PRIVATE_KEY) return
    const subs = (await this.ctx.storage.get('pushSubs')) || {}
    const payload = { title: String(ctl.title || 'Sinfonie').slice(0, 120), body: String(ctl.body || '').slice(0, 240), tag: String(ctl.tag || '').slice(0, 80), data: ctl.data || {} }
    let changed = false
    await Promise.all(
      Object.values(subs).map(async (s) => {
        try {
          const r = await sendPush(s, payload, this.env)
          if (r.gone) {
            delete subs[s.endpoint]
            changed = true
          }
        } catch (e) {
          console.error('push failed', e)
        }
      })
    )
    if (changed) await this.ctx.storage.put('pushSubs', subs)
  }
}
