/* Sinfonie phone: shows pushes from the relay and answers permission prompts straight from the notification. */
importScripts('/m/shared.js')
const S = self.SinfonieShared

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let p = {}
  try {
    p = e.data ? e.data.json() : {}
  } catch {
    p = { title: 'Sinfonie', body: e.data ? e.data.text() : '' }
  }
  const kind = p.data && p.data.kind
  const actions = kind === 'permission' ? [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }] : []
  e.waitUntil(
    self.registration.showNotification(p.title || 'Sinfonie', {
      body: p.body || '',
      tag: p.tag || undefined,
      renotify: Boolean(p.tag),
      data: p.data || {},
      icon: '/assets/icon-512.png',
      badge: '/assets/favicon-64.png',
      actions
    })
  )
})

self.addEventListener('notificationclick', (e) => {
  const d = e.notification.data || {}
  e.notification.close()
  if ((e.action === 'allow' || e.action === 'deny') && d.requestId) {
    e.waitUntil(
      (async () => {
        const p = await S.pairing()
        if (!p) return
        const body = await S.seal(p, { type: 'permission', requestId: d.requestId, decision: e.action })
        await fetch(S.sendUrl(p), { method: 'POST', body })
      })()
    )
    return
  }
  const target = '/m/' + (d.workspaceId ? '#ws=' + encodeURIComponent(d.workspaceId) : '')
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const win = list[0]
      if (win) {
        win.postMessage({ open: d.workspaceId })
        return win.focus()
      }
      return self.clients.openWindow(target)
    })
  )
})
