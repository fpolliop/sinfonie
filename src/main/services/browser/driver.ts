/**
 * One embedded browser tab: a WebContentsView driven through the Chrome DevTools Protocol.
 * Everything the agent can do goes through here; the service decides which tab and when.
 */
import { WebContentsView, type WebContents } from 'electron'

export interface ConsoleEntry {
  level: string
  text: string
  at: string
}
export interface NetworkEntry {
  method: string
  url: string
  status?: number
  type?: string
  failed?: string
  at: string
}
export interface Shot {
  data: string
  mimeType: string
  width: number
  height: number
}

const LEVELS = ['verbose', 'info', 'warning', 'error']
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'option', 'listbox', 'treeitem', 'gridcell', 'cell', 'row'])
const LANDMARKS = new Set(['heading', 'img', 'image', 'list', 'listitem', 'table', 'dialog', 'alertdialog', 'alert', 'navigation', 'main', 'form', 'region', 'article', 'banner', 'contentinfo', 'complementary', 'search', 'status', 'tabpanel', 'tablist', 'menu', 'menubar', 'tree', 'grid', 'group', 'figure', 'code', 'paragraph'])
const SKIP = new Set(['none', 'presentation', 'generic', 'InlineTextBox', 'LineBreak', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell', 'Ignored', 'RootWebArea'])
const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Space: { code: 'Space', vk: 32, text: ' ' }
}

export function normalizeUrl(input: string): string {
  const u = input.trim()
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/.test(u)) return `http://${u}`
  // Any real scheme (https:, data:, about:, file:) passes through; "host:port" is not a scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[\w.-]+:\d+(\/|$)/.test(u)) return u
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(u)) return `https://${u}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(u)}`
}

export class BrowserTab {
  readonly view: WebContentsView
  readonly wc: WebContents
  readonly console: ConsoleEntry[] = []
  readonly network: NetworkEntry[] = []
  onChange: (() => void) | null = null
  private refs = new Map<string, number>()
  private inflight = new Set<string>()
  private lastNet = Date.now()
  private attached = false

  constructor(
    readonly id: string,
    partition: string,
    onNewTab: (url: string) => void
  ) {
    this.view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    this.wc = this.view.webContents
    this.wc.setWindowOpenHandler(({ url }) => {
      onNewTab(url)
      return { action: 'deny' }
    })
    this.wc.on('console-message', (e) => {
      const { level, message } = e as unknown as { level: number | string; message: string }
      this.console.push({ level: typeof level === 'number' ? (LEVELS[level] ?? String(level)) : String(level), text: String(message ?? '').slice(0, 2000), at: new Date().toISOString() })
      if (this.console.length > 300) this.console.splice(0, this.console.length - 300)
    })
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-fail-load'] as const) {
      this.wc.on(ev as 'did-navigate', () => this.onChange?.())
    }
    this.wc.on('destroyed', () => (this.attached = false))
  }

  // ---------- CDP plumbing ----------

  private attach(): void {
    if (this.attached || this.wc.isDestroyed()) return
    try {
      this.wc.debugger.attach('1.3')
    } catch (err) {
      throw new Error(`Cannot control this tab (${err instanceof Error ? err.message : String(err)}). Close DevTools on it if open.`)
    }
    this.attached = true
    this.wc.debugger.on('detach', () => (this.attached = false))
    this.wc.debugger.on('message', (_e, method, params: Record<string, unknown>) => this.onCdp(method, params))
    for (const m of ['Network.enable', 'Page.enable', 'DOM.enable', 'Accessibility.enable']) void this.wc.debugger.sendCommand(m).catch(() => undefined)
  }
  private cdp<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.attach()
    return this.wc.debugger.sendCommand(method, params) as Promise<T>
  }
  private onCdp(method: string, p: Record<string, unknown>): void {
    const id = p.requestId as string
    if (method === 'Network.requestWillBeSent') {
      this.inflight.add(id)
      this.lastNet = Date.now()
      const req = p.request as { method: string; url: string }
      if (!req.url.startsWith('data:')) this.network.push({ method: req.method, url: req.url.slice(0, 500), type: p.type as string, at: new Date().toISOString() })
      if (this.network.length > 300) this.network.splice(0, this.network.length - 300)
    } else if (method === 'Network.responseReceived') {
      const res = p.response as { url: string; status: number }
      const e = [...this.network].reverse().find((n) => n.url === res.url.slice(0, 500) && n.status == null)
      if (e) e.status = res.status
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      this.inflight.delete(id)
      this.lastNet = Date.now()
      if (method === 'Network.loadingFailed') {
        const e = this.network[this.network.length - 1]
        if (e && e.status == null) e.failed = String(p.errorText ?? 'failed')
      }
    }
  }

  // ---------- navigation ----------

  url(): string {
    return this.wc.isDestroyed() ? '' : this.wc.getURL()
  }
  title(): string {
    return this.wc.isDestroyed() ? '' : this.wc.getTitle()
  }
  async navigate(url: string): Promise<void> {
    const target = normalizeUrl(url)
    this.attach()
    try {
      await this.wc.loadURL(target)
    } catch (err) {
      const code = (err as { errno?: number; code?: string }).code ?? ''
      if (code !== 'ERR_ABORTED') throw new Error(`Could not load ${target}: ${err instanceof Error ? err.message : String(err)}`)
    }
    await this.settle(1500)
  }
  /** Wait until the network has been quiet for a moment, bounded. */
  async settle(maxMs = 3000, quietMs = 400): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      if (!this.wc.isLoading() && this.inflight.size === 0 && Date.now() - this.lastNet > quietMs) return
      await sleep(100)
    }
  }

  // ---------- reading ----------

  async snapshot(maxChars = 30_000): Promise<string> {
    const { nodes } = await this.cdp<{ nodes: AXNode[] }>('Accessibility.getFullAXTree')
    const byId = new Map(nodes.map((n) => [n.nodeId, n]))
    this.refs.clear()
    let counter = 0
    const lines: string[] = []
    let total = 0
    let truncated = false
    const walk = (id: string, depth: number, parentName: string): void => {
      if (truncated) return
      const n = byId.get(id)
      if (!n) return
      const role = n.role?.value ?? ''
      const name = String(n.name?.value ?? '').trim()
      const value = n.value?.value
      let nextDepth = depth
      let ownName = parentName
      if (!n.ignored && !SKIP.has(role)) {
        let line: string | null = null
        if (role === 'StaticText') {
          if (name && name !== parentName) line = `${'  '.repeat(depth)}- text "${name.slice(0, 300)}"`
        } else if (name || INTERACTIVE.has(role) || LANDMARKS.has(role)) {
          line = `${'  '.repeat(depth)}- ${role}`
          if (name) line += ` "${name.slice(0, 150)}"`
          if (value != null && value !== '' && !/password/i.test(name)) line += ` value="${String(value).slice(0, 100)}"`
          for (const p of n.properties ?? []) {
            if (['checked', 'expanded', 'selected', 'disabled', 'pressed', 'level', 'required', 'invalid', 'focused'].includes(p.name) && p.value?.value !== false && p.value?.value != null) line += ` ${p.name}=${String(p.value.value)}`
          }
          if (n.backendDOMNodeId && (INTERACTIVE.has(role) || role === 'heading' || role === 'img' || role === 'image')) {
            const ref = `e${++counter}`
            this.refs.set(ref, n.backendDOMNodeId)
            line += ` [ref=${ref}]`
          }
          ownName = name
        }
        if (line) {
          if (total + line.length > maxChars) {
            truncated = true
            return
          }
          lines.push(line)
          total += line.length + 1
          nextDepth = depth + 1
        }
      }
      for (const c of n.childIds ?? []) walk(c, nextDepth, ownName)
    }
    if (nodes[0]) walk(nodes[0].nodeId, 0, '')
    const head = `Page: ${this.title()}\nURL: ${this.url()}\n`
    return head + (lines.length ? lines.join('\n') : '(empty page)') + (truncated ? '\n… truncated. Scroll, or use browser_get_text for the full text.' : '')
  }
  async screenshot(): Promise<Shot> {
    const img = await this.wc.capturePage()
    const size = img.getSize()
    if (size.width === 0 || size.height === 0) throw new Error('The browser pane is not on screen, so there is nothing to capture. The Browser tab of this workspace must be visible for screenshots; snapshots work regardless.')
    const scaled = size.width > 1280 ? img.resize({ width: 1280 }) : img
    const s = scaled.getSize()
    return { data: scaled.toJPEG(72).toString('base64'), mimeType: 'image/jpeg', width: s.width, height: s.height }
  }
  async text(maxChars = 40_000): Promise<string> {
    const t = (await this.wc.executeJavaScript('document.body ? document.body.innerText : ""', true)) as string
    return t.length > maxChars ? t.slice(0, maxChars) + '\n… truncated' : t
  }
  async evaluate(expression: string): Promise<string> {
    const r = await this.wc.executeJavaScript(expression, true)
    return typeof r === 'string' ? r : JSON.stringify(r, null, 1)?.slice(0, 20_000) ?? String(r)
  }
  async waitFor(o: { text?: string; selector?: string; urlContains?: string; networkIdle?: boolean; timeoutMs?: number }): Promise<string> {
    const start = Date.now()
    const timeout = Math.min(o.timeoutMs ?? 10_000, 60_000)
    while (Date.now() - start < timeout) {
      let ok = true
      if (o.urlContains && !this.url().includes(o.urlContains)) ok = false
      if (ok && o.selector) ok = Boolean(await this.wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(o.selector)})`, true).catch(() => false))
      if (ok && o.text) ok = Boolean(await this.wc.executeJavaScript(`document.body && document.body.innerText.includes(${JSON.stringify(o.text)})`, true).catch(() => false))
      if (ok && o.networkIdle) ok = !this.wc.isLoading() && this.inflight.size === 0 && Date.now() - this.lastNet > 500
      if (ok) return `Ready after ${Date.now() - start} ms. Page: ${this.title()} ${this.url()}`
      await sleep(200)
    }
    throw new Error(`Timed out after ${timeout} ms waiting for ${JSON.stringify(o)}. Page: ${this.title()} ${this.url()}`)
  }

  // ---------- acting ----------

  private async center(ref: string): Promise<{ x: number; y: number }> {
    const backendNodeId = this.refs.get(ref)
    if (!backendNodeId) throw new Error(`Unknown ref "${ref}". Refs come from the latest browser_snapshot and change when the page changes; take a new snapshot.`)
    // The DOM domain only resolves backend node ids after the document has been requested once.
    await this.cdp('DOM.getDocument', { depth: 0 }).catch(() => undefined)
    await this.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined)
    const { model } = await this.cdp<{ model: { content: number[]; border: number[] } }>('DOM.getBoxModel', { backendNodeId }).catch(() => {
      throw new Error(`Element ${ref} is not visible any more. Take a new snapshot.`)
    })
    const q = model.content.some((v, i) => i % 2 === 0 && v !== model.content[0]) ? model.content : model.border
    return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 }
  }
  async click(ref: string, opts: { double?: boolean; button?: 'left' | 'right' | 'middle' } = {}): Promise<void> {
    const { x, y } = await this.center(ref)
    const button = opts.button ?? 'left'
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    for (let i = 1; i <= (opts.double ? 2 : 1); i++) {
      await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i })
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i })
    }
    await this.settle(2000)
  }
  async type(ref: string, text: string, opts: { submit?: boolean; replace?: boolean } = {}): Promise<void> {
    const { x, y } = await this.center(ref)
    await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    if (opts.replace !== false) {
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, commands: ['selectAll'] })
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
    }
    await this.cdp('Input.insertText', { text })
    if (opts.submit) await this.press('Enter')
    await this.settle(1500)
  }
  async press(combo: string): Promise<void> {
    const parts = combo.split('+').map((s) => s.trim())
    const key = parts.pop() ?? ''
    let modifiers = 0
    for (const m of parts) {
      const l = m.toLowerCase()
      if (l === 'alt' || l === 'option') modifiers |= 1
      else if (l === 'ctrl' || l === 'control') modifiers |= 2
      else if (l === 'meta' || l === 'cmd' || l === 'command') modifiers |= 4
      else if (l === 'shift') modifiers |= 8
    }
    const known = KEYS[key]
    const single = key.length === 1
    const code = known?.code ?? (single ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : '') : key)
    const vk = known?.vk ?? (single ? key.toUpperCase().charCodeAt(0) : 0)
    const text = modifiers & ~8 ? undefined : (known?.text ?? (single ? key : undefined))
    await this.cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text ? { text, unmodifiedText: text } : {}) })
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers })
    await this.settle(1500)
  }
  async scroll(direction: 'up' | 'down', amount = 600, ref?: string): Promise<void> {
    let x = 0
    let y = 0
    if (ref) ({ x, y } = await this.center(ref))
    else {
      const b = this.view.getBounds()
      x = Math.max(1, b.width / 2)
      y = Math.max(1, b.height / 2)
    }
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: direction === 'down' ? amount : -amount })
    await sleep(300)
  }
  async select(ref: string, values: string[]): Promise<string> {
    const backendNodeId = this.refs.get(ref)
    if (!backendNodeId) throw new Error(`Unknown ref "${ref}". Take a new snapshot.`)
    await this.cdp('DOM.getDocument', { depth: 0 }).catch(() => undefined)
    const { object } = await this.cdp<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId })
    const r = await this.cdp<{ result: { value: string } }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      arguments: [{ value: values }],
      returnByValue: true,
      functionDeclaration: `function(vals){
        const el = this.tagName === 'SELECT' ? this : this.querySelector('select') || this.closest('select');
        if (!el) return 'not a select element';
        let hit = 0;
        for (const o of el.options) { const on = vals.includes(o.value) || vals.includes(o.textContent.trim()); o.selected = on; if (on) hit++; if (on && !el.multiple) break; }
        el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}));
        return hit ? 'selected ' + hit : 'no option matched ' + JSON.stringify(vals) + '; options: ' + Array.from(el.options).map(o => o.textContent.trim()).slice(0,50).join(' | ');
      }`
    })
    await this.settle(1500)
    return r.result.value
  }

  destroy(): void {
    if (!this.wc.isDestroyed()) this.wc.close()
  }
}

interface AXNode {
  nodeId: string
  ignored: boolean
  role?: { value: string }
  name?: { value: unknown }
  value?: { value: unknown }
  properties?: { name: string; value: { value: unknown } }[]
  childIds?: string[]
  backendDOMNodeId?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
