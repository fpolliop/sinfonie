/**
 * The phone companion. The Mac keeps one WebSocket to relay.sinfonie.dev; phones that scanned the
 * pairing QR join the same room. Room id and auth token are both derived from the pairing key, and
 * every message is AES-GCM encrypted with it, so the relay forwards envelopes it cannot read. The
 * only plaintext it sees is a notification request (workspace name, prompt kind, tool name).
 *
 * Phones get the workspace list, the transcript of a workspace they open, live item updates, and
 * pending prompts; they can reply, interrupt, and answer permissions and questions. Push goes out
 * only when the Mac has been idle for a while, so someone sitting at it is not nagged twice.
 */
import { app, powerMonitor, powerSaveBlocker, safeStorage } from 'electron'
import { createHash, randomBytes, webcrypto } from 'crypto'
import { hostname } from 'os'
import QRCode from 'qrcode'
import { getStore } from '../store'
import { getTranscript } from './transcripts'
import * as agent from './agent'
import type { AgentEvent, ChatItem, Incident, IncidentStatus, OnCallState, PermissionRequest, PermissionResponse, QuestionRequest, QuestionResponse, RemoteFromPhone, RemoteIncident, RemotePrompt, RemoteReviewPr, RemoteSettings, RemoteStatus, RemoteSpace, RemoteToPhone, RemoteWorkspace, Severity } from '@shared/types'

export const RELAY_URL = process.env.SINFONIE_RELAY_URL ?? 'https://relay.sinfonie.dev'
const PHONE_URL = process.env.SINFONIE_PHONE_URL ?? 'https://sinfonie.dev/m/'
const SECRET_KEY = 'remote:key'
const subtle = webcrypto.subtle

// ---------- secrets (same scheme as the other services) ----------
function encrypt(text: string): string {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64')
  return 'plain:' + Buffer.from(text, 'utf8').toString('base64')
}
function decrypt(stored: string): string {
  if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
  return stored
}
function pairingKey(): string | undefined {
  const raw = getStore().get().secrets?.[SECRET_KEY]
  if (!raw) return undefined
  try {
    return decrypt(raw)
  } catch {
    return undefined
  }
}
function writePairingKey(key: string | undefined): void {
  getStore().update((d) => {
    d.secrets = d.secrets ?? {}
    if (key === undefined) delete d.secrets[SECRET_KEY]
    else d.secrets[SECRET_KEY] = encrypt(key)
  })
}
export function settings(): RemoteSettings {
  return getStore().get().settings.remote ?? {}
}
export function updateSettings(patch: Partial<RemoteSettings>): RemoteSettings {
  getStore().update((d) => {
    d.settings.remote = { ...(d.settings.remote ?? {}), ...patch }
  })
  return settings()
}

// ---------- derived identifiers and message crypto ----------
const roomIdOf = (k: string): string => createHash('sha256').update('room:' + k).digest('hex').slice(0, 32)
const authOf = (k: string): string => createHash('sha256').update('auth:' + k).digest('hex')
let aesKey: webcrypto.CryptoKey | null = null
let aesFor: string | null = null
async function key(k: string): Promise<webcrypto.CryptoKey> {
  if (aesKey && aesFor === k) return aesKey
  aesKey = await subtle.importKey('raw', Buffer.from(k, 'base64url'), 'AES-GCM', false, ['encrypt', 'decrypt'])
  aesFor = k
  return aesKey
}
async function seal(k: string, obj: unknown): Promise<string> {
  const iv = randomBytes(12)
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await key(k), Buffer.from(JSON.stringify(obj)))
  return JSON.stringify({ iv: iv.toString('base64url'), ct: Buffer.from(ct).toString('base64url') })
}
async function unseal(k: string, text: string): Promise<unknown> {
  const { iv, ct } = JSON.parse(text) as { iv: string; ct: string }
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64url') }, await key(k), Buffer.from(ct, 'base64url'))
  return JSON.parse(Buffer.from(pt).toString('utf8'))
}

// ---------- connection ----------
let ws: WebSocket | null = null
let connected = false
let phones = 0
let lastError: string | undefined
let reconnectTimer: NodeJS.Timeout | null = null
let heartbeat: NodeJS.Timeout | null = null
let backoff = 1000
let emitStatus: (s: RemoteStatus) => void = () => undefined
export function setStatusEmitter(fn: typeof emitStatus): void {
  emitStatus = fn
}
export function status(): RemoteStatus {
  return { paired: Boolean(pairingKey()), connected, phones, relay: RELAY_URL, pairedAt: settings().pairedAt, lastError }
}
const publish = (): void => emitStatus(status())

function wsUrl(k: string): string {
  const u = new URL(RELAY_URL)
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:'
  u.pathname = `/room/${roomIdOf(k)}/ws`
  u.searchParams.set('role', 'desktop')
  u.searchParams.set('auth', authOf(k))
  return u.toString()
}
function disconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  const sock = ws
  ws = null
  connected = false
  phones = 0
  try {
    sock?.close(1000)
  } catch {
    /* already closed */
  }
}
function scheduleReconnect(): void {
  if (reconnectTimer || !pairingKey()) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, backoff)
  backoff = Math.min(backoff * 2, 30_000)
}
export function connect(): void {
  const k = pairingKey()
  if (!k || ws) return
  let sock: WebSocket
  try {
    sock = new WebSocket(wsUrl(k))
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    scheduleReconnect()
    return
  }
  ws = sock
  sock.onopen = () => {
    if (ws !== sock) return
    connected = true
    lastError = undefined
    backoff = 1000
    heartbeat = setInterval(() => sock.readyState === sock.OPEN && sock.send('ping'), 25_000)
    sock.send(JSON.stringify({ ctl: 'presence?' }))
    void send({ type: 'hello', host: hostname(), version: app.getVersion() })
    publish()
  }
  sock.onmessage = (m) => {
    if (ws !== sock) return
    const text = String(m.data)
    if (text === 'pong') return
    if (text.startsWith('{"ctl"')) {
      try {
        const ctl = JSON.parse(text) as { ctl: string; phones?: number }
        if (ctl.ctl === 'presence') {
          const before = phones
          phones = ctl.phones ?? 0
          if (phones > before) void pushAll()
          publish()
          updatePowerBlocker()
        }
      } catch {
        /* ignore */
      }
      return
    }
    void unseal(k, text)
      .then((msg) => handle(msg as RemoteFromPhone))
      .catch(() => undefined) // a phone with an old key, or garbage: drop it
  }
  sock.onclose = (e) => {
    if (ws !== sock) return
    ws = null
    connected = false
    phones = 0
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    if (e.code === 4001 || e.code === 1008) lastError = 'The relay refused the pairing key.'
    publish()
    updatePowerBlocker()
    scheduleReconnect()
  }
  sock.onerror = () => {
    lastError = 'Could not reach the relay.'
  }
}
async function send(msg: RemoteToPhone): Promise<void> {
  const k = pairingKey()
  if (!k || !ws || ws.readyState !== ws.OPEN || phones === 0) return
  try {
    ws.send(await seal(k, msg))
  } catch {
    /* socket closing */
  }
}
function control(ctl: Record<string, unknown>): void {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(ctl))
}

// ---------- pairing ----------
/** Creates the pairing key if needed and returns what the phone scans. The key travels only in the URL fragment. */
export async function pair(): Promise<{ url: string; qrSvg: string }> {
  let k = pairingKey()
  if (!k) {
    k = randomBytes(32).toString('base64url')
    writePairingKey(k)
    updateSettings({ pairedAt: new Date().toISOString() })
  }
  connect()
  const url = `${PHONE_URL}#k=${k}&relay=${encodeURIComponent(RELAY_URL)}`
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#e6e8ec', light: '#0000' } })
  return { url, qrSvg }
}
/** Forgets the key: the relay drops the room's subscriptions and disconnects phones; a new pairing makes a new room. */
export function unpair(): RemoteStatus {
  control({ ctl: 'reset' })
  disconnect()
  writePairingKey(undefined)
  updateSettings({ pairedAt: undefined })
  publish()
  return status()
}

// ---------- what phones see ----------
const subscribed = new Set<string>()
/** Workspaces opened on the Mac, so their phone notifications can be cleared even if the phone was offline. */
const seenOnMac = new Map<string, number>()
const pending = new Map<string, RemotePrompt>()
const itemTimers = new Map<string, NodeJS.Timeout>()
/** The last assistant item id we sent a "finished" notification for, per workspace, to avoid repeats. */
const finishNotified = new Map<string, string>()
let workspacesTimer: NodeJS.Timeout | null = null

// The relay drops any frame larger than ~512 KB, so a whole transcript never reaches the phone. Send the
// tail and let the phone page older history in; also clamp each item so no single one can blow the limit.
const PHONE_PAGE = 50
const PHONE_ITEM_MAX = 12_000
const PHONE_FRAME_BUDGET = 300_000
function phoneItem(it: ChatItem): ChatItem {
  const clamp = (t: string): string => (t.length > PHONE_ITEM_MAX ? t.slice(0, PHONE_ITEM_MAX) + '\n… (truncated — open on your Mac to see the rest)' : t)
  return {
    ...it,
    blocks: it.blocks.map((b) => {
      if (b.type === 'text' || b.type === 'thinking') return { ...b, text: clamp(b.text) }
      if (b.type === 'tool') {
        const input = ((): unknown => {
          try {
            const s = JSON.stringify(b.input)
            return s && s.length > PHONE_ITEM_MAX ? { truncated: clamp(s) } : b.input
          } catch {
            return b.input
          }
        })()
        return { ...b, input, result: b.result ? clamp(b.result) : b.result }
      }
      return b
    })
  }
}
/** A window of items ending at `end` (exclusive), newest-biased, kept under the frame budget. */
function pageBefore(all: ChatItem[], end: number): { items: ChatItem[]; from: number } {
  const items: ChatItem[] = []
  let size = 0
  for (let i = end - 1; i >= 0; i--) {
    const it = phoneItem(all[i])
    const len = JSON.stringify(it).length
    if (items.length > 0 && (items.length >= PHONE_PAGE || size + len > PHONE_FRAME_BUDGET)) break
    items.unshift(it)
    size += len
  }
  return { items, from: end - items.length }
}
function transcriptTail(id: string): { items: ChatItem[]; hasMore: boolean } {
  const all = getTranscript(id)
  const { items, from } = pageBefore(all, all.length)
  return { items, hasMore: from > 0 }
}
function transcriptHistory(id: string, beforeId: string): { items: ChatItem[]; hasMore: boolean } {
  const all = getTranscript(id)
  const idx = all.findIndex((x) => x.id === beforeId)
  const { items, from } = pageBefore(all, idx < 0 ? all.length : idx)
  return { items, hasMore: from > 0 }
}

function workspaceList(): RemoteWorkspace[] {
  const { workspaces, spaces } = getStore().get()
  return workspaces
    .filter((w) => w.status !== 'archived')
    .map((w) => {
      const sp = spaces.find((s) => s.id === w.spaceId)
      const items = getTranscript(w.id)
      const last = [...items].reverse().find((i) => i.role === 'assistant' && i.blocks.some((b) => b.type === 'text' && b.text.trim()))
      const lastText = last?.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(' ').trim().slice(0, 140)
      const busy = agent.isBusy(w.id)
      const needsInput = [...pending.values()].some((p) => p.request.workspaceId === w.id)
      // "Your move": the agent spoke last and nothing is pending — so the phone's inbox can surface it.
      const lastItem = items[items.length - 1]
      return {
        id: w.id,
        name: w.name,
        space: sp ? { name: sp.name, color: sp.color } : undefined,
        stage: w.stage,
        status: w.status,
        busy,
        needsInput,
        awaitingReply: !busy && !needsInput && lastItem?.role === 'assistant',
        lastMessageAt: w.lastMessageAt,
        lastText: lastText || undefined
      }
    })
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))
}
function spaceList(): RemoteSpace[] {
  const { spaces, repos } = getStore().get()
  return spaces.map((s) => ({ id: s.id, name: s.name, color: s.color, repoCount: repos.filter((r) => r.spaceId === s.id).length }))
}
/** Shape the on-call incidents for the phone: the newest 200, with space, trimmed thread and proposals. */
function incidentList(incidents: Incident[]): RemoteIncident[] {
  const { spaces } = getStore().get()
  return [...incidents]
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, 200)
    .map((i) => {
      const sp = i.spaceId ? spaces.find((s) => s.id === i.spaceId) : undefined
      return {
        id: i.id,
        space: sp ? { name: sp.name, color: sp.color } : undefined,
        channelName: i.channelName,
        kind: i.kind,
        title: i.title,
        status: i.status,
        severity: i.severity,
        permalink: i.permalink,
        occurrences: i.occurrences,
        needsHuman: i.report?.needsHuman ?? false,
        costUsd: i.costUsd,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        report: i.report,
        fix: i.fix,
        proposals: i.proposals.map((p) => ({ id: p.id, text: p.text, status: p.status })),
        messages: i.messages.slice(-20).map((m) => ({ user: m.userName || m.user, text: m.text, at: m.ts })),
        notes: i.notes.map((n) => ({ at: n.at, role: n.role, text: n.text }))
      }
    })
}
/** Live-push the on-call list when the desktop's incident state changes (called from the oncall emitter). */
export function pushOnCall(s: OnCallState): void {
  void send({ type: 'oncall', items: incidentList(s.incidents), running: s.running })
}
/** The workspace was opened on the Mac: tell the phone to clear its notifications (now, and on next sync). */
export function markSeen(workspaceId: string): void {
  seenOnMac.set(workspaceId, Date.now())
  void send({ type: 'notifClear', workspaceId })
}
function scheduleWorkspaces(): void {
  if (phones === 0 || workspacesTimer) return
  workspacesTimer = setTimeout(() => {
    workspacesTimer = null
    void send({ type: 'workspaces', items: workspaceList() })
    void send({ type: 'spaces', items: spaceList() })
  }, 400)
}
async function pushAll(): Promise<void> {
  await send({ type: 'hello', host: hostname(), version: app.getVersion() })
  await send({ type: 'workspaces', items: workspaceList() })
  await send({ type: 'spaces', items: spaceList() })
  await send({ type: 'prompts', items: [...pending.values()] })
  // Re-clear notifications for workspaces opened on the Mac while the phone was away (pruning stale entries).
  const cutoff = Date.now() - 12 * 60 * 60_000
  for (const [wid, at] of seenOnMac) {
    if (at < cutoff) seenOnMac.delete(wid)
    else await send({ type: 'notifClear', workspaceId: wid })
  }
  for (const id of subscribed) {
    const t = transcriptTail(id)
    await send({ type: 'transcript', workspaceId: id, items: t.items, hasMore: t.hasMore })
  }
}

// ---------- bridge to the app ----------
interface Bridge {
  send: (workspaceId: string, text: string) => Promise<unknown> | unknown
  interrupt: (workspaceId: string) => Promise<unknown> | unknown
  permission: (r: PermissionResponse) => void
  question: (r: QuestionResponse) => void
  /** Create a workspace in a space and send the first message; returns its id (or null on failure). */
  create: (input: { spaceId?: string; name?: string; text: string }) => Promise<string | null>
  /** Pull requests across the person's spaces where they are asked to review. */
  reviews: () => Promise<RemoteReviewPr[]>
  /** On-call incidents across the person's spaces (running flag + the incidents). */
  oncall: () => { running: boolean; incidents: Incident[] }
  oncallSetStatus: (id: string, status: IncidentStatus) => void
  oncallSetSeverity: (id: string, severity: Severity) => void
  /** Send a drafted reply in its Slack thread. */
  oncallApprove: (id: string, proposalId: string) => Promise<unknown> | unknown
  oncallDismiss: (id: string, proposalId: string) => void
}
let bridge: Bridge | null = null
export function setBridge(b: Bridge): void {
  bridge = b
}
async function handle(msg: RemoteFromPhone): Promise<void> {
  if (!bridge || !msg || typeof msg !== 'object') return
  try {
    switch (msg.type) {
      case 'sync':
        await pushAll()
        break
      case 'subscribe': {
        subscribed.add(msg.workspaceId)
        const t = transcriptTail(msg.workspaceId)
        await send({ type: 'transcript', workspaceId: msg.workspaceId, items: t.items, hasMore: t.hasMore })
        await send({ type: 'busy', workspaceId: msg.workspaceId, busy: agent.isBusy(msg.workspaceId) })
        break
      }
      case 'history': {
        const h = transcriptHistory(msg.workspaceId, msg.beforeId)
        await send({ type: 'history', workspaceId: msg.workspaceId, items: h.items, hasMore: h.hasMore })
        break
      }
      case 'unsubscribe':
        subscribed.delete(msg.workspaceId)
        break
      case 'send':
        if (typeof msg.text === 'string' && msg.text.trim()) await bridge.send(msg.workspaceId, msg.text)
        break
      case 'interrupt':
        await bridge.interrupt(msg.workspaceId)
        break
      case 'create':
        if (typeof msg.text === 'string' && msg.text.trim()) {
          const id = await bridge.create({ spaceId: msg.spaceId, name: msg.name, text: msg.text })
          if (id) await send({ type: 'created', workspaceId: id })
          await pushAll()
        }
        break
      case 'reviews':
        await send({ type: 'reviews', items: await bridge.reviews() })
        break
      case 'oncall': {
        const { running, incidents } = bridge.oncall()
        await send({ type: 'oncall', items: incidentList(incidents), running })
        break
      }
      case 'oncall:setStatus':
        bridge.oncallSetStatus(msg.id, msg.status)
        break
      case 'oncall:setSeverity':
        bridge.oncallSetSeverity(msg.id, msg.severity)
        break
      case 'oncall:approve':
        await bridge.oncallApprove(msg.id, msg.proposalId)
        break
      case 'oncall:dismissProposal':
        bridge.oncallDismiss(msg.id, msg.proposalId)
        break
      case 'permission':
        if (pending.has(msg.requestId)) bridge.permission({ requestId: msg.requestId, decision: msg.decision === 'allow' || msg.decision === 'always' ? msg.decision : 'deny', message: msg.decision === 'deny' ? 'Denied from the phone' : undefined })
        break
      case 'question':
        if (pending.has(msg.requestId)) bridge.question({ requestId: msg.requestId, answers: msg.answers ?? {}, response: msg.response })
        break
    }
  } catch (err) {
    await send({ type: 'error', workspaceId: 'workspaceId' in msg ? msg.workspaceId : undefined, message: err instanceof Error ? err.message : String(err) })
  }
}

// ---------- inputs from the app ----------
/** Called after the transcript recorded the event. */
export function onAgentEvent(e: AgentEvent): void {
  if (!pairingKey()) return
  const id = 'workspaceId' in e ? e.workspaceId : e.result.workspaceId
  if (e.type === 'status') {
    updatePowerBlocker()
    scheduleWorkspaces()
    if (subscribed.has(id)) void send({ type: 'busy', workspaceId: id, busy: e.busy })
    // Notify once per finished reply. A status event can repeat (reconnects, no-op turns), so key on the last
    // assistant message; only a genuinely new reply notifies again.
    if (!e.busy && settings().notifyFinished !== false) {
      const last = lastAssistant(id)
      if (last && finishNotified.get(id) !== last.id) {
        finishNotified.set(id, last.id)
        notify('finished', id, 'Finished', plainText(last.text))
      }
    }
    return
  }
  if (e.type === 'error') {
    if (settings().notifyErrors !== false) notify('error', id, 'Error', e.message.slice(0, 200))
    return
  }
  if (e.type === 'user_message' || e.type === 'assistant_end' || e.type === 'result') scheduleWorkspaces()
  if (!subscribed.has(id) || phones === 0) return
  const itemId = 'itemId' in e ? e.itemId : e.type === 'tool_result' ? itemIdForTool(id, e.toolUseId) : undefined
  if (!itemId) return
  // Coalesce the flood of deltas into one item update every 250 ms.
  const tk = `${id}:${itemId}`
  if (itemTimers.has(tk)) return
  itemTimers.set(
    tk,
    setTimeout(() => {
      itemTimers.delete(tk)
      const item = getTranscript(id).find((i) => i.id === itemId)
      if (item) void send({ type: 'item', workspaceId: id, item: phoneItem(item) })
    }, 250)
  )
}
function itemIdForTool(workspaceId: string, toolUseId: string): string | undefined {
  return getTranscript(workspaceId).find((i) => i.blocks.some((b) => b.type === 'tool' && b.toolUseId === toolUseId))?.id
}
/** The last assistant message with visible text, and its item id (to notify each reply only once). */
function lastAssistant(workspaceId: string): { id: string; text: string } | undefined {
  const items = getTranscript(workspaceId)
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.role !== 'assistant') continue
    const text = it.blocks
      .filter((b): b is Extract<ChatItem['blocks'][number], { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim()
    if (text) return { id: it.id, text }
  }
  return undefined
}
/** Markdown to a readable one-line notification: no #, **, `code`, links or bullets. */
function plainText(md: string): string {
  const s = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.slice(0, 200)
}
export function onPermission(p: PermissionRequest): void {
  if (!pairingKey()) return
  const prompt: RemotePrompt = { kind: 'permission', request: p }
  pending.set(p.requestId, prompt)
  void send({ type: 'prompt', prompt })
  scheduleWorkspaces()
  if (settings().notifyPrompts !== false) notify('permission', p.workspaceId, `Permission: ${p.toolName}`, 'Allow or deny from here, or open Sinfonie to see the details.', p.requestId)
}
export function onQuestion(q: QuestionRequest): void {
  if (!pairingKey()) return
  const prompt: RemotePrompt = { kind: 'question', request: q }
  pending.set(q.requestId, prompt)
  void send({ type: 'prompt', prompt })
  scheduleWorkspaces()
  if (settings().notifyPrompts !== false) notify('question', q.workspaceId, 'Question', q.questions[0]?.question.slice(0, 160) ?? 'The agent has a question.', q.requestId)
}
export function onAnswered(requestId: string): void {
  if (!pending.delete(requestId)) return
  void send({ type: 'prompt:resolved', requestId })
  scheduleWorkspaces()
}
export function onStoreChanged(): void {
  scheduleWorkspaces()
}

// ---------- push ----------
/** Asks the relay to push, but only when nobody has touched the Mac for the configured time. */
/** A notification the CLI mode raises (Claude Code's own permission prompt, or an idle prompt). */
export function notifyFromCli(workspaceId: string, kind: 'permission' | 'finished', title: string, body: string): void {
  notify(kind, workspaceId, title, body)
}
function notify(kind: 'permission' | 'question' | 'finished' | 'error', workspaceId: string, title: string, body: string, requestId?: string): void {
  if (!connected) return
  const awayMinutes = settings().awayMinutes ?? 1
  if (powerMonitor.getSystemIdleTime() < awayMinutes * 60) return
  const ws = getStore().get().workspaces.find((w) => w.id === workspaceId)
  control({ ctl: 'notify', title: ws ? `${ws.name} · ${title}` : title, body, tag: `${kind}:${requestId ?? workspaceId}`, data: { kind, workspaceId, requestId } })
}

// ---------- keep the Mac awake while a phone is watching a running turn ----------
let blockerId: number | null = null
function updatePowerBlocker(): void {
  const busy = getStore()
    .get()
    .workspaces.some((w) => w.status !== 'archived' && agent.isBusy(w.id))
  const want = phones > 0 && busy
  if (want && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension')
  if (!want && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}

/** Connect at startup when paired; the store subscription keeps the phone's list fresh. */
export function start(): void {
  if (pairingKey()) setTimeout(connect, 3000)
  getStore().subscribe(() => onStoreChanged())
}
