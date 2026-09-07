/* Sinfonie phone client: a list of workspaces, a conversation view, prompt cards, and push. */
;(async function () {
  const S = window.SinfonieShared
  const $ = (id) => document.getElementById(id)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const md = (text) => {
    try {
      return window.marked ? window.marked.parse(text, { breaks: true, gfm: true }) : `<p>${esc(text)}</p>`
    } catch {
      return `<p>${esc(text)}</p>`
    }
  }

  // ---------- state ----------
  let pairing = null
  let ws = null
  let connected = false
  let backoff = 1000
  let workspaces = []
  const prompts = new Map() // requestId -> RemotePrompt
  let current = null // workspaceId
  let items = [] // ChatItem[] of the current workspace
  let busy = false
  let host = ''

  // ---------- pairing from the QR link ----------
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''))
  let handoff = null // the same pairing, for the native app if it is installed
  if (hash.get('k')) {
    await S.savePairing(hash.get('k'), hash.get('relay') || undefined)
    handoff = 'sinfonie://pair#' + location.hash.replace(/^#/, '')
    history.replaceState(null, '', location.pathname)
  }
  const openWs = hash.get('ws')
  pairing = await S.pairing()
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/m/sw.js').catch(() => undefined)
  navigator.serviceWorker?.addEventListener('message', (e) => e.data?.open && openWorkspace(e.data.open))

  if (!pairing) {
    $('unpaired').classList.remove('hidden')
    return
  }

  // ---------- connection ----------
  function connect() {
    if (ws || !pairing) return
    const sock = new WebSocket(S.wsUrl(pairing))
    ws = sock
    sock.onopen = () => {
      connected = true
      backoff = 1000
      $('conn').classList.add('on')
      send({ type: 'sync' })
      if (current) send({ type: 'subscribe', workspaceId: current })
    }
    sock.onmessage = async (m) => {
      const text = String(m.data)
      if (text.startsWith('{"ctl"')) {
        try {
          const ctl = JSON.parse(text)
          if (ctl.ctl === 'push-ok') pushState('on')
        } catch {
          /* ignore */
        }
        return
      }
      try {
        handle(await S.unseal(pairing, text))
      } catch {
        /* wrong key or garbage */
      }
    }
    sock.onclose = (e) => {
      if (ws !== sock) return
      ws = null
      connected = false
      $('conn').classList.remove('on')
      if (e.code === 4001) {
        S.kvSet('pairing', null)
        location.reload()
        return
      }
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 15000)
    }
    sock.onerror = () => undefined
  }
  async function send(msg) {
    if (!ws || ws.readyState !== 1) return
    ws.send(await S.seal(pairing, msg))
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!ws) connect()
      else send({ type: 'sync' })
    }
  })
  setInterval(() => ws && ws.readyState === 1 && ws.send('ping'), 25000)

  // ---------- incoming ----------
  function handle(msg) {
    switch (msg.type) {
      case 'hello':
        host = msg.host
        renderHeader()
        break
      case 'workspaces':
        workspaces = msg.items
        renderList()
        renderHeader()
        break
      case 'prompts':
        prompts.clear()
        for (const p of msg.items) prompts.set(p.request.requestId, p)
        renderPrompts()
        break
      case 'prompt':
        prompts.set(msg.prompt.request.requestId, msg.prompt)
        renderPrompts()
        if (navigator.vibrate) navigator.vibrate(30)
        break
      case 'prompt:resolved':
        prompts.delete(msg.requestId)
        renderPrompts()
        break
      case 'transcript':
        if (msg.workspaceId !== current) return
        items = msg.items
        renderMessages(true)
        break
      case 'item': {
        if (msg.workspaceId !== current) return
        // The desktop's own copy of a message we sent replaces the optimistic one.
        if (msg.item.role === 'user') items = items.filter((x) => !String(x.id).startsWith('local-'))
        const i = items.findIndex((x) => x.id === msg.item.id)
        if (i >= 0) items[i] = msg.item
        else items.push(msg.item)
        renderMessages(false)
        break
      }
      case 'busy':
        if (msg.workspaceId !== current) return
        busy = msg.busy
        renderHeader()
        break
      case 'error':
        toast(msg.message)
        break
    }
  }

  // ---------- views ----------
  function renderHeader() {
    const w = workspaces.find((x) => x.id === current)
    if (current) {
      $('back').classList.remove('hidden')
      $('logo').classList.add('hidden')
      $('title').innerHTML = `${esc(w ? w.name : 'Workspace')}<span class="sub">${w?.space ? esc(w.space.name) + ' · ' : ''}${busy ? 'working…' : 'idle'}</span>`
      $('stop').style.display = busy ? '' : 'none'
      $('typing').classList.toggle('hidden', !busy)
    } else {
      $('back').classList.add('hidden')
      $('logo').classList.remove('hidden')
      $('title').innerHTML = `Sinfonie<span class="sub">${host ? esc(host) : connected ? 'connected' : 'connecting…'}</span>`
      $('stop').style.display = 'none'
    }
  }
  function renderList() {
    const el = $('workspaces')
    if (!workspaces.length) {
      el.innerHTML = '<div class="empty"><h2>No workspaces</h2><p>Create one in Sinfonie on the Mac and it appears here.</p></div>'
      return
    }
    el.innerHTML = workspaces
      .map(
        (w) => `<div class="ws" data-id="${esc(w.id)}">
        <span class="dot ${w.needsInput ? 'need' : w.busy ? 'busy' : ''}" style="margin-top:7px"></span>
        <div class="body">
          <div class="name">${esc(w.name)} ${w.space ? `<span class="sp" style="color:${esc(w.space.color)}">${esc(w.space.name)}</span>` : ''}
            ${w.needsInput ? '<span class="badge warn">needs you</span>' : w.busy ? '<span class="badge acc">running</span>' : ''}</div>
          <div class="last">${esc(w.lastText || (w.status === 'creating' ? 'Creating…' : 'No messages yet'))}</div>
        </div></div>`
      )
      .join('')
    el.querySelectorAll('.ws').forEach((row) => row.addEventListener('click', () => openWorkspace(row.dataset.id)))
  }
  function promptCard(p) {
    const r = p.request
    if (p.kind === 'permission') {
      const input = typeof r.input === 'object' ? JSON.stringify(r.input, null, 2) : String(r.input)
      return `<div class="card" data-req="${esc(r.requestId)}">
        <h3><span class="dot need"></span> ${esc(r.toolName)} <span class="badge">${esc(nameOf(r.workspaceId))}</span></h3>
        <pre>${esc(input.slice(0, 2000))}</pre>
        <div class="row">
          <button class="btn ok" data-act="allow">Allow</button>
          ${r.canAlwaysAllow ? '<button class="btn" data-act="always">Always allow</button>' : ''}
          <button class="btn danger" data-act="deny">Deny</button>
        </div></div>`
    }
    const q = r.questions[0]
    return `<div class="card" data-req="${esc(r.requestId)}">
      <h3><span class="dot need"></span> ${esc(q?.header || 'Question')} <span class="badge">${esc(nameOf(r.workspaceId))}</span></h3>
      <div>${esc(q?.question || '')}</div>
      ${(q?.options || []).map((o, i) => `<button class="btn opt" data-opt="${i}">${esc(o.label)}<small>${esc(o.description || '')}</small></button>`).join('')}
      <div class="row"><input class="free" placeholder="Or answer in your own words" style="flex:1;border:1px solid var(--border);background:var(--panel);color:var(--text);font:inherit;padding:8px 10px;border-radius:10px">
        <button class="btn primary" data-act="answer">Send</button></div></div>`
  }
  const nameOf = (id) => workspaces.find((w) => w.id === id)?.name || 'Workspace'
  function renderPrompts() {
    const all = [...prompts.values()]
    $('listPrompts').innerHTML = all.map(promptCard).join('')
    const mine = all.filter((p) => p.request.workspaceId === current)
    $('chatPrompts').innerHTML = mine.map(promptCard).join('')
    document.querySelectorAll('.card').forEach(wireCard)
    if (current && mine.length) $('main').scrollTop = $('main').scrollHeight
    // Keep the list's status dots in sync without waiting for the desktop.
    for (const w of workspaces) w.needsInput = all.some((p) => p.request.workspaceId === w.id)
    if (!current) renderList()
  }
  function wireCard(card) {
    const requestId = card.dataset.req
    const p = prompts.get(requestId)
    if (!p) return
    card.querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const act = b.dataset.act
        if (p.kind === 'permission') {
          send({ type: 'permission', requestId, decision: act })
        } else {
          const q = p.request.questions[0]
          const chosen = [...card.querySelectorAll('.opt.sel')].map((o) => q.options[Number(o.dataset.opt)].label)
          const free = card.querySelector('.free').value.trim()
          const answers = {}
          if (chosen.length) answers[q.question] = chosen.join(', ')
          else if (free) answers[q.question] = free
          send({ type: 'question', requestId, answers, response: chosen.length ? undefined : free || undefined })
        }
        prompts.delete(requestId)
        renderPrompts()
      })
    )
    card.querySelectorAll('.opt').forEach((o) =>
      o.addEventListener('click', () => {
        const q = p.request.questions[0]
        if (!q.multiSelect) {
          send({ type: 'question', requestId, answers: { [q.question]: q.options[Number(o.dataset.opt)].label } })
          prompts.delete(requestId)
          renderPrompts()
        } else o.classList.toggle('sel')
      })
    )
  }
  function blockHtml(b) {
    if (b.type === 'text') return `<div class="md">${md(b.text)}</div>`
    if (b.type === 'thinking') return b.text.trim() ? `<div class="thinking">Thinking…</div>` : ''
    if (b.type === 'image') return `<div class="muted small">[image: ${esc(b.image.name)}]</div>`
    if (b.type === 'tool') {
      const hl = headline(b)
      const result = b.result ? `<pre class="${b.isError ? 'err' : ''}">${esc(String(b.result).slice(0, 4000))}</pre>` : ''
      const input = b.input !== undefined ? `<pre>${esc(JSON.stringify(b.input, null, 2).slice(0, 3000))}</pre>` : ''
      return `<details class="tool"><summary><b>${esc(b.name)}</b><span class="hl">${esc(hl)}</span>${b.done ? '' : '<span class="dot busy"></span>'}</summary>${input}${result}</details>`
    }
    return ''
  }
  function headline(b) {
    const i = b.input
    if (!i || typeof i !== 'object') return ''
    return String(i.command || i.description || i.file_path || i.path || i.pattern || i.query || i.url || i.prompt || Object.values(i)[0] || '').slice(0, 120)
  }
  let lastCount = 0
  function renderMessages(reset) {
    const el = $('msgs')
    const atBottom = reset || el.scrollHeight - $('main').scrollTop - $('main').clientHeight < 120
    el.innerHTML = items
      .map((it) => {
        const role = it.role === 'user' ? 'user' : it.role === 'assistant' ? 'assistant' : 'system'
        const inner = role === 'user' ? esc(it.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')) : it.blocks.map(blockHtml).join('')
        return inner ? `<div class="msg ${role}">${inner}</div>` : ''
      })
      .join('')
    if (atBottom || items.length !== lastCount) $('main').scrollTop = $('main').scrollHeight
    lastCount = items.length
  }
  function openWorkspace(id) {
    if (current) send({ type: 'unsubscribe', workspaceId: current })
    current = id
    items = []
    busy = Boolean(workspaces.find((w) => w.id === id)?.busy)
    $('list').classList.add('hidden')
    $('chat').classList.remove('hidden')
    $('composer').classList.remove('hidden')
    $('msgs').innerHTML = '<div class="msg system">Loading…</div>'
    renderHeader()
    renderPrompts()
    send({ type: 'subscribe', workspaceId: id })
  }
  function backToList() {
    if (current) send({ type: 'unsubscribe', workspaceId: current })
    current = null
    $('chat').classList.add('hidden')
    $('composer').classList.add('hidden')
    $('list').classList.remove('hidden')
    renderHeader()
    renderPrompts()
    send({ type: 'sync' })
  }
  $('back').addEventListener('click', backToList)
  $('stop').addEventListener('click', () => current && send({ type: 'interrupt', workspaceId: current }))
  const input = $('input')
  const doSend = () => {
    const text = input.value.trim()
    if (!text || !current) return
    send({ type: 'send', workspaceId: current, text })
    // Show it right away; the desktop's own user_message item replaces it on the next update.
    items.push({ id: 'local-' + Date.now(), role: 'user', blocks: [{ type: 'text', text }], createdAt: new Date().toISOString() })
    renderMessages(true)
    input.value = ''
    input.style.height = ''
  }
  $('send').addEventListener('click', doSend)
  input.addEventListener('input', () => {
    input.style.height = ''
    input.style.height = Math.min(120, input.scrollHeight) + 'px'
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doSend()
  })
  function toast(text) {
    const t = document.createElement('div')
    t.className = 'banner'
    t.style.cssText = 'position:fixed;left:14px;right:14px;bottom:80px;z-index:9;border-color:rgba(248,113,113,.5)'
    t.textContent = text
    document.body.appendChild(t)
    setTimeout(() => t.remove(), 4000)
  }

  // ---------- push ----------
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
  async function pushState(state) {
    const b = $('pushBanner')
    if (state === 'on') {
      await S.kvSet('pushEnabled', true)
      b.classList.add('hidden')
      return
    }
    if (!('PushManager' in window) || !('Notification' in window)) {
      if (isIOS && !standalone) b.innerHTML = 'To get notified when an agent needs you, add this page to your home screen (Share → Add to Home Screen) and open it from there.'
      else b.innerHTML = 'This browser cannot receive push notifications.'
      b.classList.remove('hidden')
      return
    }
    if (Notification.permission === 'denied') {
      b.innerHTML = 'Notifications are blocked for this app in the phone settings.'
      b.classList.remove('hidden')
      return
    }
    b.innerHTML = 'Get a push when an agent waits for you. <button class="btn primary sm" id="enablePush">Enable notifications</button>'
    b.classList.remove('hidden')
    $('enablePush').addEventListener('click', enablePush)
  }
  async function enablePush() {
    try {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') return pushState('off')
      const reg = await navigator.serviceWorker.ready
      const { publicKey } = await (await fetch(`${pairing.relay}/vapid`)).json()
      if (!publicKey) return toast('The relay has no push key configured.')
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: S.b64u.decode(publicKey) })
      ws?.send(JSON.stringify({ ctl: 'push-subscribe', subscription: sub.toJSON() }))
    } catch (err) {
      toast('Could not enable notifications: ' + (err.message || err))
    }
  }
  async function resubscribe() {
    // Browsers rotate subscriptions; register the current one on every launch.
    if (!(await S.kvGet('pushEnabled')) || !('serviceWorker' in navigator)) return
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) ws?.send(JSON.stringify({ ctl: 'push-subscribe', subscription: sub.toJSON() }))
    else pushState('off')
  }

  // ---------- go ----------
  if (handoff) {
    const b = document.createElement('div')
    b.className = 'banner'
    b.innerHTML = '<span style="flex:1">Have the Sinfonie app installed? It gets real notifications.</span><a class="btn primary sm" href="' + esc(handoff) + '">Open in the app</a>'
    $('list').insertBefore(b, $('list').firstChild)
  }
  $('list').classList.remove('hidden')
  renderHeader()
  connect()
  const wasEnabled = await S.kvGet('pushEnabled')
  if (wasEnabled) setTimeout(resubscribe, 1500)
  else pushState('off')
  if (openWs) setTimeout(() => openWorkspace(openWs), 300)
})()
