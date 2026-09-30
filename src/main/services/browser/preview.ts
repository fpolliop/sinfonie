/**
 * The builder's preview (guided task screen, docs/design/README.md "My product is the canvas"): pictures of the
 * preview for thumbnails and before/after change cards, "Point at something" element picking, and the quick visual
 * checks Send for review runs. Everything goes through the workspace's existing browser tab; nothing here opens one.
 *
 * Scripts run in an isolated world (the page's own scripts cannot see or tamper with them), and everything they
 * return is treated as untrusted page data: checked, clamped, and fenced as data before Maestro reads it.
 */
import { app, BrowserWindow } from 'electron'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { getStore } from '../../store'
import { isShown, peekTab } from './service'
import type { BrowserTab } from './driver'
import type { GuidedPictures, PickedElement, VisualCheck } from '@shared/types'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const guided = (): boolean => getStore().get().settings.mode === 'guided'
const thumbDir = (): string => join(app.getPath('userData'), 'previews')
const safeId = (id: string): string => id.replace(/[^\w-]/g, '_')
const thumbFile = (id: string): string => join(thumbDir(), `${safeId(id)}.jpg`)
/** The isolated world Sinfonie's page scripts run in. */
const WORLD = 1999

/** Run `code` in Sinfonie's isolated world, bounded by `ms` (0: no bound). */
function inWorld<T>(tab: BrowserTab, code: string, ms = 5000): Promise<T> {
  const run = tab.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], true) as Promise<T>
  if (!ms) return run
  return Promise.race([run, sleep(ms).then((): T => { throw new Error('The page did not answer in time.') })])
}

/** A tab that shows a page (not blank, not a failed load). */
function livePage(workspaceId: string): BrowserTab | null {
  const tab = peekTab(workspaceId)
  if (!tab || tab.wc.isDestroyed()) return null
  const url = tab.url()
  if (!url || url === 'about:blank' || tab.loadFailed) return null
  return tab
}

/** Page text as data: control characters and runs of space folded, backticks removed (they would end a fence), clamped. */
function pageText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/`+/g, "'").replace(/\s+/g, ' ').trim().slice(0, max)
}
const finite = (v: unknown, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0)

// ---------- pictures ----------

/** The preview as it is now, when it is open and on screen: a large picture and a small one (the task's thumbnail, also saved). */
export async function capture(workspaceId: string): Promise<{ shot: string; thumb: string } | null> {
  const tab = livePage(workspaceId)
  if (!tab || !isShown(workspaceId)) return null
  const shot = await tab.capture({ maxWidth: 960 }).catch(() => null)
  const thumb = shot ? await tab.capture({ maxWidth: 480, quality: 70 }).catch(() => null) : null
  if (!shot || !thumb) return null
  void mkdir(thumbDir(), { recursive: true })
    .then(() => writeFile(thumbFile(workspaceId), Buffer.from(thumb.slice(thumb.indexOf(',') + 1), 'base64')))
    .catch(() => undefined)
  return { shot, thumb }
}

export async function thumbnail(workspaceId: string): Promise<string | null> {
  return (await capture(workspaceId))?.thumb ?? null
}

export async function thumbnails(workspaceIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    workspaceIds.slice(0, 200).map(async (id) => {
      const buf = await readFile(thumbFile(id)).catch(() => null)
      if (buf) out[id] = `data:image/jpeg;base64,${buf.toString('base64')}`
    })
  )
  return out
}

/** "Before" pictures, taken when a guided turn starts, waiting for that turn's change. */
const before = new Map<string, string>()
/** When each workspace's last turn ended, to spot a queued message delivered straight after it. */
const ended = new Map<string, number>()
/** Workspaces whose last change gets no pictures: a queued turn started at once, so an "after" would mix both turns. */
const skip = new Set<string>()

export function turnEnded(workspaceId: string): void {
  ended.set(workspaceId, Date.now())
  // A skip is only ever for the turn before this one (its change is saved just after the next turn starts). If that
  // turn changed nothing, no pictures() call consumed it: drop it so it cannot swallow this turn's pictures.
  skip.delete(workspaceId)
}

/** A guided turn is starting: remember what the preview looks like now. Cheap, and silent when there is no preview. */
export function beforeTurn(workspaceId: string): void {
  if (!guided()) return
  const e = ended.get(workspaceId)
  if (e && Date.now() - e < 2000) skip.add(workspaceId)
  before.delete(workspaceId)
  void capture(workspaceId)
    .then((c) => {
      if (c) before.set(workspaceId, c.shot)
    })
    .catch(() => undefined)
}

/**
 * Pictures for a change a guided turn just saved: the "before" from the turn's start and an "after" once the preview
 * shows the new version. Both or neither, and only when the preview is on screen (it is never reloaded out of sight).
 */
export async function pictures(workspaceId: string, changeId: string): Promise<GuidedPictures | null> {
  if (skip.delete(workspaceId)) return null
  const was = before.get(workspaceId)
  before.delete(workspaceId)
  const tab = livePage(workspaceId)
  if (!was || !tab || !isShown(workspaceId)) return null
  try {
    // Dev servers usually hot-reload on their own; a reload makes sure the picture is of the new version.
    await sleep(800)
    if (!isShown(workspaceId) || tab.wc.isDestroyed()) return null
    tab.wc.reload()
    await sleep(300)
    await tab.settle(6000, 500)
    await sleep(250)
    const after = await capture(workspaceId)
    return after ? { workspaceId, changeId, before: was, after: after.shot, thumb: after.thumb } : null
  } catch {
    return null
  }
}

/** A task was deleted: drop its thumbnail and anything held for it. */
export function forget(workspaceId: string): void {
  before.delete(workspaceId)
  ended.delete(workspaceId)
  skip.delete(workspaceId)
  checkRuns.delete(workspaceId)
  void unlink(thumbFile(workspaceId)).catch(() => undefined)
}

// ---------- point at something ----------

const PICK_ATTR = 'data-sinfonie-picked'

/** Injected into the page: highlight what is under the pointer (or focused with Tab), resolve on click or Enter, null on Esc. */
const pickerScript = (token: string, attr: string): string => `(() => new Promise((resolve) => {
  if (window.__sinfoniePick) window.__sinfoniePick.cancel();
  const ACCENT = '#3b57d4';
  const layer = (css) => { const d = document.createElement('div'); d.setAttribute('data-sinfonie-overlay', ''); d.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' + css; return d; };
  const box = layer('display:none;outline:2px solid ' + ACCENT + ';outline-offset:2px;border-radius:6px;background:rgba(59,87,212,.08);');
  const tag = layer('display:none;background:' + ACCENT + ';color:#fff;font:600 12px -apple-system,system-ui,sans-serif;padding:4px 8px;border-radius:6px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;');
  const hint = layer('top:10px;left:50%;transform:translateX(-50%);background:rgba(27,28,32,.92);color:#fff;font:500 13px -apple-system,system-ui,sans-serif;padding:7px 12px;border-radius:99px;box-shadow:0 6px 20px rgba(0,0,0,.2);');
  hint.textContent = 'Click the part you mean. Press Esc to cancel.';
  document.documentElement.append(box, tag, hint);
  const KIND = { a: 'link', button: 'button', img: 'picture', svg: 'picture', picture: 'picture', video: 'video', input: 'field', textarea: 'text box', select: 'menu', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', nav: 'menu bar', header: 'top of the page', footer: 'bottom of the page', form: 'form', ul: 'list', ol: 'list', li: 'list item', p: 'text', span: 'text', label: 'label', table: 'table', section: 'section', main: 'main area', aside: 'side area', article: 'article', figure: 'picture' };
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const nameOf = (el) => clean(el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || el.textContent).slice(0, 60);
  const kindOf = (el) => KIND[el.tagName.toLowerCase()] || 'area';
  const labelOf = (el) => { const n = nameOf(el); const k = kindOf(el); return n ? (n.length > 40 ? n.slice(0, 40) + '…' : n) + ' ' + k : k; };
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      let p = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(p + '#' + esc(n.id)); break; }
      const cls = Array.from(n.classList).filter((c) => !/^(hover|focus|active)/.test(c)).slice(0, 2);
      if (cls.length) p += '.' + cls.map(esc).join('.');
      const sibs = n.parentElement ? Array.from(n.parentElement.children).filter((s) => s.tagName === n.tagName) : [];
      if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      parts.unshift(p);
      if (n === document.body) break;
    }
    return parts.join(' > ');
  };
  let current = null;
  const place = () => {
    if (!current || !current.isConnected) { box.style.display = 'none'; tag.style.display = 'none'; return; }
    const r = current.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    tag.textContent = labelOf(current);
    const above = r.top > 34;
    Object.assign(tag.style, { display: 'block', left: Math.max(4, r.left - 2) + 'px', top: (above ? r.top - 30 : Math.min(window.innerHeight - 28, r.bottom + 6)) + 'px' });
  };
  const target = (e) => { const el = e.target; return el && el.nodeType === 1 && !el.hasAttribute('data-sinfonie-overlay') ? el : null; };
  const block = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const onMove = (e) => { const el = target(e); if (el && el !== current && el !== document.documentElement && el !== document.body) { current = el; place(); } };
  const onClick = (e) => { block(e); const el = target(e); finish(el && el !== document.documentElement ? el : current); };
  const onKey = (e) => {
    if (e.key === 'Escape') { block(e); finish(null); }
    else if (e.key === 'Enter' && current) { block(e); finish(current); }
  };
  const onFocus = (e) => { const el = target(e); if (el) { current = el; place(); } };
  const opts = { capture: true };
  const listen = (on) => {
    const f = on ? 'addEventListener' : 'removeEventListener';
    window[f]('mousemove', onMove, opts); window[f]('click', onClick, opts); window[f]('keydown', onKey, opts); window[f]('focusin', onFocus, opts);
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu']) window[f](t, block, opts);
    window[f]('scroll', place, opts); window[f]('resize', place, opts);
  };
  const finish = (el) => {
    listen(false);
    box.remove(); tag.remove(); hint.remove();
    delete window.__sinfoniePick;
    if (!el) return resolve(null);
    document.querySelectorAll('[' + ${JSON.stringify(attr)} + ']').forEach((n) => n.removeAttribute(${JSON.stringify(attr)}));
    el.setAttribute(${JSON.stringify(attr)}, ${JSON.stringify(token)});
    const r = el.getBoundingClientRect();
    resolve({ tag: el.tagName.toLowerCase(), name: nameOf(el), text: clean(el.innerText || el.textContent).slice(0, 200), selector: pathOf(el), url: location.pathname + location.search, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, vw: window.innerWidth, vh: window.innerHeight });
  };
  window.__sinfoniePick = { token: ${JSON.stringify(token)}, cancel: () => finish(null) };
  listen(true);
}))()`

/** Implicit roles for when the accessibility tree has nothing better (a plain div is "generic"). */
const TAG_ROLE: Record<string, string> = { a: 'link', button: 'button', img: 'img', input: 'textbox', textarea: 'textbox', select: 'combobox', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', nav: 'navigation', ul: 'list', ol: 'list', li: 'listitem', p: 'paragraph', form: 'form', table: 'table' }

/** Give the keyboard back to the app window that shows this tab. */
function focusApp(tab: BrowserTab): void {
  if (tab.wc.isDestroyed()) return
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.contentView.children.includes(tab.view)) ?? BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.focus()
}

/**
 * Waits for the person to point at an element in the preview. Null when they press Esc, the pick is cancelled
 * (by its token), the page navigates away, or the preview is not open. The result is page data, validated here.
 */
export async function pick(workspaceId: string, token: string): Promise<PickedElement | null> {
  if (!/^[\w-]{1,40}$/.test(token)) return null
  const tab = livePage(workspaceId)
  if (!tab) return null
  tab.wc.focus()
  let onNav: (() => void) | null = null
  const navigated = new Promise<null>((r) => {
    onNav = () => r(null)
    tab.wc.once('did-navigate', onNav)
  })
  let raw: unknown
  try {
    raw = await Promise.race([inWorld<unknown>(tab, pickerScript(token, PICK_ATTR), 0).catch(() => null), navigated, sleep(10 * 60_000).then(() => null)])
  } finally {
    if (onNav && !tab.wc.isDestroyed()) tab.wc.removeListener('did-navigate', onNav)
    focusApp(tab)
  }
  if (!raw || typeof raw !== 'object') {
    void cancelPick(workspaceId, token)
    return null
  }
  const r = raw as Record<string, unknown>
  const rect = (r.rect && typeof r.rect === 'object' ? r.rect : {}) as Record<string, unknown>
  const vw = finite(r.vw, 1, 10_000) || 1
  const vh = finite(r.vh, 1, 10_000) || 1
  const box = { x: finite(rect.x, -10_000, 10_000), y: finite(rect.y, -10_000, 10_000), width: finite(rect.width, 0, 10_000), height: finite(rect.height, 0, 10_000) }
  const tagRaw = pageText(r.tag, 20).toLowerCase()
  const tag = /^[a-z][a-z0-9-]*$/.test(tagRaw) ? tagRaw : 'element'
  const marked = `[${PICK_ATTR}="${token}"]`
  const ax = await tab.describe(marked)
  void inWorld(tab, `document.querySelectorAll(${JSON.stringify(marked)}).forEach((n) => n.removeAttribute(${JSON.stringify(PICK_ATTR)}))`).catch(() => undefined)
  let image: string | undefined
  if (isShown(workspaceId) && box.width > 2 && box.height > 2) {
    const pad = 12
    const x = Math.max(0, box.x - pad)
    const y = Math.max(0, box.y - pad)
    const width = Math.min(vw - x, box.width + pad * 2)
    const height = Math.min(vh - y, Math.min(box.height + pad * 2, 900))
    if (width > 4 && height > 4) image = (await tab.capture({ rect: { x, y, width, height }, maxWidth: 640, quality: 80 }).catch(() => null)) ?? undefined
  }
  const role = pageText(ax?.role, 40)
  return {
    role: role || (Object.hasOwn(TAG_ROLE, tag) ? TAG_ROLE[tag] : 'generic'),
    name: pageText(ax?.name, 150) || pageText(r.name, 150),
    text: pageText(r.text, 200),
    tag,
    selector: pageText(r.selector, 300),
    url: pageText(r.url, 300),
    image
  }
}

/** Cancels the pick with this token; a newer pick in the same preview is left alone. */
export async function cancelPick(workspaceId: string, token: string): Promise<void> {
  const tab = peekTab(workspaceId)
  if (!tab || tab.wc.isDestroyed()) return
  await inWorld(tab, `(() => { const p = window.__sinfoniePick; if (p && p.token === ${JSON.stringify(token)}) p.cancel(); })()`).catch(() => undefined)
  focusApp(tab)
}

// ---------- visual checks ----------

/** Page-reported lines as data for Maestro: cleaned, de-duplicated, a few at most. */
const evidence = (xs: unknown[], n = 8): string => [...new Set(xs.map((x) => pageText(x, 300)).filter(Boolean))].slice(0, n).join('\n')
/** Requests nobody sees fail: the browser asks for a favicon on its own, and dev servers keep a live-reload socket. */
const NOISE = /favicon\.ico|\/__vite_ping|\/_next\/webpack-hmr|sockjs-node|\/@vite\/client|hot-update/i
/** Each Send for review sheet's run; closing the sheet (or a newer run) makes the older one stop. */
const checkRuns = new Map<string, number>()

export function cancelChecks(workspaceId: string): void {
  checkRuns.set(workspaceId, (checkRuns.get(workspaceId) ?? 0) + 1)
}

/**
 * Quick checks on the preview before it goes to a reviewer: it loads, no errors in the page, pictures load, what it
 * asks the server for arrives, and nothing sticks out sideways on a laptop or a phone. A page that loaded in the last
 * two minutes is read as it is; an older one is reloaded first so the results are about the current version. Every
 * step is bounded (about 20 seconds in all) and stops when the sheet closes.
 */
export async function checks(workspaceId: string): Promise<VisualCheck[]> {
  const gen = (checkRuns.get(workspaceId) ?? 0) + 1
  checkRuns.set(workspaceId, gen)
  const alive = (): boolean => checkRuns.get(workspaceId) === gen
  const deadline = Date.now() + 20_000
  const left = (): number => Math.max(500, deadline - Date.now())
  const tab = peekTab(workspaceId)
  if (!tab || tab.wc.isDestroyed() || !tab.url() || tab.url() === 'about:blank') {
    return [{ id: 'loads', ok: false, title: 'The preview is not open, so it could not be checked', detail: 'Open the preview and try again, or send it anyway.' }]
  }
  const fresh = !tab.loadFailed && tab.finishedAt > 0 && Date.now() - tab.finishedAt < 120_000 && Boolean(tab.navigatedAt)
  let since = tab.navigatedAt
  if (!fresh) {
    since = new Date().toISOString()
    tab.wc.reload()
    await sleep(300)
    await tab.settle(Math.min(8000, left()), 600)
  }
  if (!alive()) return []
  const out: VisualCheck[] = []

  const docs = tab.network.filter((n) => n.at >= since && n.type === 'Document')
  const doc = docs[docs.length - 1]
  if (tab.loadFailed || Boolean(doc?.failed) || (doc?.status ?? 200) >= 400) {
    out.push({
      id: 'loads',
      ok: false,
      title: 'The page does not load',
      detail: 'The app may have stopped, or the latest change broke it.',
      fix: 'The page does not load in the preview. Please find out why and fix it, then make sure the app is running again.',
      evidence: evidence([`${doc?.failed ?? (doc?.status ? `HTTP ${doc.status}` : 'load failed')} for ${tab.url()}`])
    })
    return out
  }
  out.push({ id: 'loads', ok: true, title: 'The app starts and the page loads' })

  const errors = tab.console.filter((c) => c.at >= since && c.level === 'error' && !NOISE.test(c.text)).map((c) => c.text)
  out.push(
    errors.length
      ? { id: 'console', ok: false, title: errors.length === 1 ? 'The page reports a problem' : `The page reports ${errors.length} problems`, detail: 'Visitors may not notice, but something in the page is not working as intended.', fix: 'The page reports problems while it runs (errors in the browser console of the preview). Please find the cause and fix them.', evidence: evidence(errors) }
      : { id: 'console', ok: true, title: 'No problems reported by the page' }
  )

  const failed = tab.network.filter((n) => n.at >= since && n.type !== 'Document' && !NOISE.test(n.url) && (n.failed || (n.status ?? 0) >= 400) && n.failed !== 'net::ERR_ABORTED')
  const brokenRaw = await inWorld<unknown>(tab, `Array.from(document.images).filter((i) => i.currentSrc && i.complete && i.naturalWidth === 0).map((i) => i.currentSrc).slice(0, 20)`, Math.min(5000, left())).catch(() => [])
  const broken = Array.isArray(brokenRaw) ? brokenRaw.filter((x): x is string => typeof x === 'string') : []
  if (!alive()) return []
  out.push(
    broken.length
      ? { id: 'images', ok: false, title: broken.length === 1 ? 'A picture does not show' : `${broken.length} pictures do not show`, fix: 'Some pictures on the page do not show (the images below fail to load). Please fix them.', evidence: evidence(broken) }
      : { id: 'images', ok: true, title: 'Pictures load' }
  )
  const other = failed.filter((n) => !broken.includes(n.url))
  if (other.length) {
    out.push({
      id: 'requests',
      ok: false,
      title: other.length === 1 ? 'Something the page needs did not load' : `${other.length} things the page needs did not load`,
      detail: 'Parts of the page may be missing or not work.',
      fix: 'Some things the page needs do not load (the requests below failed). Please find out why and fix them.',
      evidence: evidence(other.map((n) => `${n.method} ${n.url} -> ${n.failed ?? n.status}`))
    })
  }

  const overflowJs = `(() => { const w = document.documentElement.clientWidth; const wide = document.documentElement.scrollWidth > w + 1; const culprits = []; if (wide && document.body) for (const el of document.body.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.right > w + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed') { culprits.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList[0] ? '.' + el.classList[0] : '')); if (culprits.length > 5) break; } } return { wide, culprits }; })()`
  const read = (v: unknown): { wide: boolean; culprits: string[] } => {
    const o = (v && typeof v === 'object' ? v : {}) as { wide?: unknown; culprits?: unknown }
    return { wide: o.wide === true, culprits: Array.isArray(o.culprits) ? o.culprits.filter((c): c is string => typeof c === 'string') : [] }
  }
  const desk = read(await inWorld<unknown>(tab, overflowJs, Math.min(5000, left())).catch(() => null))
  if (!alive()) return []
  const phoneRaw = await tab.atWidth(390, 844, () => inWorld<unknown>(tab, overflowJs, Math.min(5000, left()))).catch(() => undefined)
  if (!alive()) return []
  const phone = phoneRaw === undefined ? null : read(phoneRaw)
  const where = [desk.wide && 'on a laptop', phone?.wide && 'on a phone'].filter(Boolean).join(' and ')
  const culprits = [...desk.culprits, ...(phone?.culprits ?? [])]
  out.push(
    where
      ? { id: 'overflow', ok: false, title: `The page sticks out sideways ${where}`, detail: 'People would have to scroll left and right to see all of it.', fix: `The page sticks out sideways ${where}${phone?.wide ? ' (checked at 390 px wide)' : ''}, so people have to scroll left and right. Please fix the layout so nothing is wider than the screen.`, evidence: culprits.length ? `Elements sticking out: ${evidence(culprits, 6).replace(/\n/g, ', ')}` : undefined }
      : { id: 'overflow', ok: true, title: phone ? 'Fits the screen on a laptop and a phone' : 'Fits the screen' }
  )
  return out
}
