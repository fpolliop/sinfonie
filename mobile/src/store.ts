/**
 * One connection to the relay and the state it produces, shared by every screen through a tiny
 * subscribe/useStore pair. The pairing key lives in SecureStore.
 */
import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { derive, seal, unseal, wsUrl, type ChatItem, type FromPhone, type Pairing, type RemotePrompt, type RemoteReviewPr, type RemoteSpace, type RemoteWorkspace, type ToPhone } from './protocol'

export interface State {
  pairing: Pairing | null
  connected: boolean
  host: string
  workspaces: RemoteWorkspace[]
  spaces: RemoteSpace[]
  prompts: RemotePrompt[]
  /** Transcripts by workspace id, for the ones opened in this session. */
  transcripts: Record<string, ChatItem[]>
  busy: Record<string, boolean>
  lastError: string | null
  /** Set when the Mac confirms a phone-started conversation; the New screen navigates to it, then clears it. */
  created: string | null
  reviews: RemoteReviewPr[]
}
let state: State = { pairing: null, connected: false, host: '', workspaces: [], spaces: [], prompts: [], transcripts: {}, busy: {}, lastError: null, created: null, reviews: [] }
const listeners = new Set<(s: State) => void>()
function set(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  for (const l of listeners) l(state)
}
export function getState(): State {
  return state
}
export function useStore<T>(select: (s: State) => T): T {
  const [v, setV] = useState(() => select(state))
  useEffect(() => {
    const l = (s: State): void => setV(select(s))
    listeners.add(l)
    l(state)
    return () => {
      listeners.delete(l)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return v
}

// ---- pairing persistence ----
const KEY = 'sinfonie.pairing'
export async function loadPairing(): Promise<Pairing | null> {
  const raw = await SecureStore.getItemAsync(KEY)
  if (!raw) return null
  try {
    const { k, relay } = JSON.parse(raw) as { k: string; relay: string }
    const p = derive(k, relay)
    set({ pairing: p })
    return p
  } catch {
    return null
  }
}
export async function savePairing(k: string, relay: string): Promise<Pairing> {
  await SecureStore.setItemAsync(KEY, JSON.stringify({ k, relay }))
  const p = derive(k, relay)
  set({ pairing: p, lastError: null })
  connect()
  return p
}
export async function unpair(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY)
  disconnect()
  set({ pairing: null, workspaces: [], spaces: [], prompts: [], transcripts: {}, busy: {}, host: '', created: null })
}

// ---- connection ----
let ws: WebSocket | null = null
let backoff = 1000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
const subscribed = new Set<string>()
let onPushOk: (() => void) | null = null
export function setPushOkListener(fn: (() => void) | null): void {
  onPushOk = fn
}

export function connect(): void {
  const p = state.pairing
  if (!p || ws) return
  const sock = new WebSocket(wsUrl(p))
  ws = sock
  sock.onopen = () => {
    if (ws !== sock) return
    backoff = 1000
    set({ connected: true, lastError: null })
    send({ type: 'sync' })
    for (const id of subscribed) send({ type: 'subscribe', workspaceId: id })
    heartbeat = setInterval(() => sock.readyState === 1 && sock.send('ping'), 25_000)
  }
  sock.onmessage = (m) => {
    if (ws !== sock) return
    const text = String(m.data)
    if (text === 'pong') return
    if (text.startsWith('{"ctl"')) {
      try {
        const ctl = JSON.parse(text) as { ctl: string }
        if (ctl.ctl === 'push-ok') onPushOk?.()
      } catch {
        /* ignore */
      }
      return
    }
    try {
      handle(unseal(p, text))
    } catch {
      /* wrong key or garbage */
    }
  }
  sock.onclose = (e) => {
    if (ws !== sock) return
    ws = null
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    set({ connected: false })
    if (e.code === 4001) {
      void unpair()
      set({ lastError: 'The Mac unpaired this phone.' })
      return
    }
    scheduleReconnect()
  }
  sock.onerror = () => set({ lastError: 'Could not reach the relay.' })
}
function scheduleReconnect(): void {
  if (reconnectTimer || !state.pairing) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, backoff)
  backoff = Math.min(backoff * 2, 15_000)
}
export function disconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  const s = ws
  ws = null
  try {
    s?.close(1000)
  } catch {
    /* closed */
  }
  set({ connected: false })
}
export function send(msg: FromPhone): void {
  const p = state.pairing
  if (!p || !ws || ws.readyState !== 1) return
  ws.send(seal(p, msg))
}
/** Plaintext control message for the relay itself (push registration). */
export function control(ctl: Record<string, unknown>): void {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(ctl))
}
export function subscribe(workspaceId: string): void {
  subscribed.add(workspaceId)
  send({ type: 'subscribe', workspaceId })
}
export function unsubscribe(workspaceId: string): void {
  subscribed.delete(workspaceId)
  send({ type: 'unsubscribe', workspaceId })
}

// Reconnect when the app comes back; iOS suspends sockets in the background.
AppState.addEventListener('change', (s) => {
  if (s === 'active') {
    if (!ws) connect()
    else send({ type: 'sync' })
  }
})

function handle(msg: ToPhone): void {
  switch (msg.type) {
    case 'hello':
      set({ host: msg.host })
      break
    case 'workspaces':
      set({ workspaces: msg.items })
      break
    case 'spaces':
      set({ spaces: msg.items })
      break
    case 'created':
      set({ created: msg.workspaceId })
      break
    case 'reviews':
      set({ reviews: msg.items })
      break
    case 'prompts':
      set({ prompts: msg.items })
      break
    case 'prompt':
      set((s) => ({ prompts: [...s.prompts.filter((p) => p.request.requestId !== msg.prompt.request.requestId), msg.prompt] }))
      break
    case 'prompt:resolved':
      set((s) => ({ prompts: s.prompts.filter((p) => p.request.requestId !== msg.requestId) }))
      break
    case 'transcript':
      set((s) => ({ transcripts: { ...s.transcripts, [msg.workspaceId]: msg.items } }))
      break
    case 'item':
      set((s) => {
        let items = s.transcripts[msg.workspaceId] ?? []
        if (msg.item.role === 'user') items = items.filter((x) => !x.id.startsWith('local-'))
        const i = items.findIndex((x) => x.id === msg.item.id)
        items = i >= 0 ? items.map((x, j) => (j === i ? msg.item : x)) : [...items, msg.item]
        return { transcripts: { ...s.transcripts, [msg.workspaceId]: items } }
      })
      break
    case 'busy':
      set((s) => ({ busy: { ...s.busy, [msg.workspaceId]: msg.busy } }))
      break
    case 'error':
      set({ lastError: msg.message })
      break
  }
}

/** Shows the message immediately; the desktop's own copy replaces it. */
/** Ask the Mac to start a new conversation; the reply arrives as `created`. */
export function createConversation(spaceId: string | undefined, name: string | undefined, text: string): void {
  set({ created: null })
  send({ type: 'create', spaceId, name, text })
}
export function clearCreated(): void {
  set({ created: null })
}
export function refreshReviews(): void {
  send({ type: 'reviews' })
}
export function sendMessage(workspaceId: string, text: string): void {
  send({ type: 'send', workspaceId, text })
  set((s) => ({ transcripts: { ...s.transcripts, [workspaceId]: [...(s.transcripts[workspaceId] ?? []), { id: 'local-' + Date.now(), role: 'user', blocks: [{ type: 'text', text }], createdAt: new Date().toISOString() }] } }))
}
export function answerPermission(requestId: string, decision: 'allow' | 'always' | 'deny'): void {
  send({ type: 'permission', requestId, decision })
  set((s) => ({ prompts: s.prompts.filter((p) => p.request.requestId !== requestId) }))
}
export function answerQuestion(requestId: string, answers: Record<string, string>, response?: string): void {
  send({ type: 'question', requestId, answers, response })
  set((s) => ({ prompts: s.prompts.filter((p) => p.request.requestId !== requestId) }))
}

// Development: reach the store from the Hermes debugger.
if (__DEV__) {
  const g = globalThis as unknown as { __sinfonie?: Record<string, unknown> }
  g.__sinfonie = { ...(g.__sinfonie ?? {}), state: getState, send: sendMessage, answerPermission, answerQuestion }
}
