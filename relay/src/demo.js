/**
 * The demo Mac: a scripted desktop that lives inside the relay for one fixed room, so the phone
 * app can be tried (App Review, screenshots, the website) without a real Mac. It speaks the same
 * encrypted protocol as the desktop, using the demo pairing key from the DEMO_KEY secret. The
 * pairing link is https://sinfonie.dev/m/#k=<DEMO_KEY>&relay=https://relay.sinfonie.dev
 */
const enc = new TextEncoder()
const dec = new TextDecoder()
const b64u = {
  encode: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0))
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)))

/** Room id and auth token the demo key derives to; null when no demo key is configured. */
export async function demoIds(env) {
  if (!env.DEMO_KEY) return null
  return { roomId: (await sha256('room:' + env.DEMO_KEY)).slice(0, 32), auth: await sha256('auth:' + env.DEMO_KEY) }
}

const SPACES = { store: { name: 'Storefront', color: '#7c9cff' }, platform: { name: 'Platform', color: '#4ade80' }, mobile: { name: 'Mobile', color: '#f472b6' } }
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString()
const workspacesNow = () => [
  { id: 'ws-checkout', name: 'Checkout redesign', space: SPACES.store, stage: 'in-progress', status: 'ready', busy: false, needsInput: true, lastMessageAt: ago(3), lastText: 'Tests are green locally. I would like to run the integration suite before opening the PR.' },
  { id: 'ws-rate', name: 'Rate limiting for the public API', space: SPACES.platform, stage: 'in-progress', status: 'ready', busy: true, needsInput: false, lastMessageAt: ago(1), lastText: 'Adding the sliding-window counter in Redis and wiring it into the gateway middleware…' },
  { id: 'ws-push', name: 'Push notifications', space: SPACES.mobile, stage: 'in-review', status: 'ready', busy: false, needsInput: false, lastMessageAt: ago(42), lastText: 'PR #218 is up with the notification categories and the deep links. Two reviewers requested.' },
  { id: 'ws-search', name: 'Search index migration', space: SPACES.platform, stage: 'in-progress', status: 'ready', busy: false, needsInput: false, lastMessageAt: ago(95), lastText: 'Backfill finished for 2.1M documents. The dual-write flag is on in staging.' },
  { id: 'ws-onboard', name: 'Onboarding flow copy', space: SPACES.store, stage: 'todo', status: 'ready', busy: false, needsInput: false, lastMessageAt: ago(260), lastText: 'Drafted three variants of the welcome screen copy; the shortest one tests best in the preview.' },
  { id: 'ws-flaky', name: 'Fix flaky payment tests', space: SPACES.platform, stage: 'done', status: 'ready', busy: false, needsInput: false, lastMessageAt: ago(1440), lastText: 'The race was in the webhook fixture. Fixed, 40 consecutive green runs.' }
]
const item = (id, role, blocks, minutesAgo) => ({ id, role, blocks, createdAt: ago(minutesAgo) })
const text = (t) => ({ type: 'text', text: t })
const tool = (id, name, input, result, done = true) => ({ type: 'tool', toolUseId: id, name, input, result, done })
const transcriptsNow = () => ({
  'ws-checkout': [
    item('c1', 'user', [text('Redesign the checkout page per the Figma file in the ticket: single column, order summary sticky on desktop, Apple Pay button above the card form.')], 48),
    item('c2', 'assistant', [text('I read the ticket and the current `CheckoutPage` component. Plan:\n\n1. Split the form into `ShippingStep` and `PaymentStep`\n2. Make `OrderSummary` sticky above `lg`\n3. Add the Apple Pay button through the existing `PaymentRequestButton`\n\nStarting with the layout.'), tool('t1', 'Read', { file_path: 'apps/web/src/checkout/CheckoutPage.tsx' }, '312 lines'), tool('t2', 'Edit', { file_path: 'apps/web/src/checkout/CheckoutPage.tsx' }, 'Applied 4 edits')], 44),
    item('c3', 'assistant', [text('Layout is done and the unit tests pass:'), tool('t3', 'Bash', { command: 'pnpm --filter web test checkout', description: 'Run checkout unit tests' }, 'Test Files  6 passed (6)\nTests  41 passed (41)'), text('Tests are green locally. I would like to run the integration suite before opening the PR.')], 3)
  ],
  'ws-rate': [
    item('r1', 'user', [text('Add rate limiting to the public API: 600 requests per minute per key, 429 with Retry-After, and a Prometheus counter for rejections.')], 12),
    item('r2', 'assistant', [text('Looking at how the gateway middleware chain is built first.'), tool('t4', 'Grep', { pattern: 'app.use\\(', path: 'services/gateway/src' }, '14 matches'), tool('t5', 'Read', { file_path: 'services/gateway/src/middleware/auth.ts' }, '88 lines'), text('Adding the sliding-window counter in Redis and wiring it into the gateway middleware…'), tool('t6', 'Write', { file_path: 'services/gateway/src/middleware/rateLimit.ts' }, undefined, false)], 1)
  ],
  'ws-push': [
    item('p1', 'user', [text('Implement push notifications for order updates on iOS and Android, with deep links into the order screen.')], 130),
    item('p2', 'assistant', [text('Done. PR #218 is up with the notification categories and the deep links. Two reviewers requested.\n\n- `expo-notifications` with an `order` category\n- `sinfonie://orders/:id` handled in the root navigator\n- Server side: the `OrderUpdated` event now fans out to the push worker')], 42)
  ],
  'ws-search': [item('s1', 'user', [text('Migrate the search index to the new mapping and backfill without downtime.')], 400), item('s2', 'assistant', [text('Backfill finished for 2.1M documents. The dual-write flag is on in staging; I suggest a 24h soak before flipping reads.')], 95)],
  'ws-onboard': [item('o1', 'user', [text('Write copy for the three onboarding screens. Warm, short, no exclamation marks.')], 300), item('o2', 'assistant', [text('Drafted three variants of the welcome screen copy; the shortest one tests best in the preview:\n\n> **Welcome to Lumen.** Your photos, sorted the moment they land.')], 260)],
  'ws-flaky': [item('f1', 'user', [text('The payment tests fail one run in five on CI. Find out why.')], 1500), item('f2', 'assistant', [text('The race was in the webhook fixture: it resolved before the listener subscribed. Fixed by awaiting the subscription, 40 consecutive green runs.')], 1440)]
})
const PROMPT = { kind: 'permission', request: { requestId: 'demo-perm-1', workspaceId: 'ws-checkout', toolName: 'Bash', input: { command: 'pnpm --filter web test:integration', description: 'Run the checkout integration suite' }, canAlwaysAllow: true } }
const QUESTION = { kind: 'question', request: { requestId: 'demo-q-1', workspaceId: 'ws-onboard', questions: [{ header: 'Tone', question: 'Which variant should I use for the welcome screen?', multiSelect: false, options: [{ label: 'Short and warm', description: 'One line, no product jargon' }, { label: 'Feature-led', description: 'Lists the three things the app does' }, { label: 'Playful', description: 'A light joke about messy camera rolls' }] }] } }

export class DemoDesktop {
  constructor(env, ctx) {
    this.env = env
    this.ctx = ctx
    this.key = null
    this.prompts = new Map([[PROMPT.request.requestId, PROMPT]])
    this.workspaces = workspacesNow()
    this.transcripts = transcriptsNow()
  }
  async k() {
    if (!this.key) this.key = await crypto.subtle.importKey('raw', b64u.decode(this.env.DEMO_KEY), 'AES-GCM', false, ['encrypt', 'decrypt'])
    return this.key
  }
  async seal(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.k(), enc.encode(JSON.stringify(obj)))
    return JSON.stringify({ iv: b64u.encode(iv), ct: b64u.encode(ct) })
  }
  async unseal(t) {
    const { iv, ct } = JSON.parse(t)
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.decode(iv) }, await this.k(), b64u.decode(ct))))
  }
  async send(ws, msg) {
    try {
      ws.send(await this.seal(msg))
    } catch {
      /* gone */
    }
  }
  list() {
    return this.workspaces.map((w) => ({ ...w, needsInput: [...this.prompts.values()].some((p) => p.request.workspaceId === w.id) }))
  }
  async sync(ws) {
    await this.send(ws, { type: 'hello', host: 'Demo MacBook Pro', version: 'demo' })
    await this.send(ws, { type: 'spaces', items: Object.entries(SPACES).map(([id, sp]) => ({ id, name: sp.name, color: sp.color, repoCount: id === 'platform' ? 3 : 2 })) })
    await this.send(ws, { type: 'workspaces', items: this.list() })
    await this.send(ws, { type: 'prompts', items: [...this.prompts.values()] })
  }
  async message(ws, raw) {
    let msg
    try {
      msg = await this.unseal(raw)
    } catch {
      return
    }
    switch (msg.type) {
      case 'sync':
        return this.sync(ws)
      case 'subscribe':
        await this.send(ws, { type: 'transcript', workspaceId: msg.workspaceId, items: this.transcripts[msg.workspaceId] ?? [], hasMore: false })
        return this.send(ws, { type: 'busy', workspaceId: msg.workspaceId, busy: Boolean(this.workspaces.find((w) => w.id === msg.workspaceId)?.busy) })
      case 'history':
        return this.send(ws, { type: 'history', workspaceId: msg.workspaceId, items: [], hasMore: false })
      case 'reviews':
        return this.send(ws, { type: 'reviews', items: [] })
      case 'oncall':
        return this.send(ws, { type: 'oncall', items: [], running: false })
      case 'create': {
        const id = 'ws-new-' + Date.now()
        const space = Object.values(SPACES).find((sp) => sp.name.toLowerCase() === String(msg.spaceId || '').toLowerCase()) ?? SPACES.store
        this.workspaces.unshift({ id, name: msg.name || msg.text.slice(0, 40), space, stage: 'in-progress', status: 'ready', busy: false, needsInput: false, lastMessageAt: new Date().toISOString(), lastText: msg.text.slice(0, 140) })
        this.transcripts[id] = []
        await this.send(ws, { type: 'workspaces', items: this.list() })
        await this.send(ws, { type: 'created', workspaceId: id })
        return this.reply(ws, id, msg.text)
      }
      case 'send':
        return this.reply(ws, msg.workspaceId, msg.text)
      case 'interrupt':
        return this.setBusy(ws, msg.workspaceId, false)
      case 'permission':
      case 'question':
        return this.resolve(ws, msg)
    }
  }
  setWorkspace(id, patch) {
    this.workspaces = this.workspaces.map((w) => (w.id === id ? { ...w, ...patch } : w))
  }
  async setBusy(ws, id, busy) {
    this.setWorkspace(id, { busy })
    await this.send(ws, { type: 'busy', workspaceId: id, busy })
    await this.send(ws, { type: 'workspaces', items: this.list() })
  }
  /** Echo the message, then "stream" a canned answer in a few chunks. */
  async reply(ws, id, userText) {
    const items = (this.transcripts[id] = this.transcripts[id] ?? [])
    const uid = 'u' + Date.now()
    items.push({ id: uid, role: 'user', blocks: [text(userText)], createdAt: new Date().toISOString() })
    await this.send(ws, { type: 'item', workspaceId: id, item: items[items.length - 1] })
    await this.setBusy(ws, id, true)
    const full = `Understood. Here is what I will do:\n\n1. Check the current state of the branch\n2. Apply the change you asked for\n3. Run the affected tests and report back\n\nI will ask before running anything that touches the network or deletes files.`
    const aid = 'a' + Date.now()
    const a = { id: aid, role: 'assistant', blocks: [text('')], createdAt: new Date().toISOString() }
    items.push(a)
    for (let i = 1; i <= 4; i++) {
      await new Promise((r) => setTimeout(r, 450))
      a.blocks = [text(full.slice(0, Math.ceil((full.length * i) / 4)))]
      await this.send(ws, { type: 'item', workspaceId: id, item: a })
    }
    this.setWorkspace(id, { lastText: full.slice(0, 140), lastMessageAt: new Date().toISOString() })
    await this.setBusy(ws, id, false)
  }
  /** A prompt was answered: drop it, continue the story, and queue the next prompt a little later. */
  async resolve(ws, msg) {
    const p = this.prompts.get(msg.requestId)
    if (!p) return
    this.prompts.delete(msg.requestId)
    await this.send(ws, { type: 'prompt:resolved', requestId: msg.requestId })
    const id = p.request.workspaceId
    const items = (this.transcripts[id] = this.transcripts[id] ?? [])
    if (p.kind === 'permission') {
      const allowed = msg.decision !== 'deny'
      const last = items[items.length - 1]
      if (allowed) {
        await this.setBusy(ws, id, true)
        const t = tool('t-int', 'Bash', PROMPT.request.input, undefined, false)
        const a = { id: 'a-int-' + Date.now(), role: 'assistant', blocks: [t], createdAt: new Date().toISOString() }
        items.push(a)
        await this.send(ws, { type: 'item', workspaceId: id, item: a })
        await new Promise((r) => setTimeout(r, 1800))
        a.blocks = [{ ...t, done: true, result: 'Test Files  9 passed (9)\nTests  73 passed (73)\nDuration  48.2s' }, text('Integration suite is green too. Opening the PR now: **feat(checkout): single-column redesign with Apple Pay**.')]
        await this.send(ws, { type: 'item', workspaceId: id, item: a })
        this.setWorkspace(id, { lastText: 'Integration suite is green too. Opening the PR now.', lastMessageAt: new Date().toISOString() })
        await this.setBusy(ws, id, false)
      } else {
        const a = { id: 'a-den-' + Date.now(), role: 'assistant', blocks: [text('Understood, I will not run the integration suite. The unit tests are green; tell me when you want the PR opened.')], createdAt: new Date().toISOString() }
        items.push(a)
        await this.send(ws, { type: 'item', workspaceId: id, item: a })
        void last
      }
    } else {
      const choice = Object.values(msg.answers ?? {})[0] || msg.response || 'your suggestion'
      const a = { id: 'a-q-' + Date.now(), role: 'assistant', blocks: [text(`Going with **${choice}**. I will update the three screens and open a PR with before/after screenshots.`)], createdAt: new Date().toISOString() }
      items.push(a)
      await this.send(ws, { type: 'item', workspaceId: id, item: a })
    }
    await this.send(ws, { type: 'workspaces', items: this.list() })
    // Keep the demo alive: a fresh prompt arrives after a while so there is always something to answer.
    setTimeout(async () => {
      const next = this.prompts.size ? null : p.kind === 'permission' ? QUESTION : PROMPT
      if (!next) return
      const fresh = { ...next, request: { ...next.request, requestId: next.request.requestId.replace(/-\d+$/, '') + '-' + Date.now() } }
      this.prompts.set(fresh.request.requestId, fresh)
      await this.send(ws, { type: 'prompt', prompt: fresh })
      await this.send(ws, { type: 'workspaces', items: this.list() })
    }, 25_000)
  }
}
