import { create } from 'zustand'
import type { AgentEvent, ChatTurnResult, PermissionRequest, QuestionRequest, QuestionResponse } from '@shared/types'
import type { ChatItem } from '@shared/types'
import { applyEvent } from '@shared/transcript'
import { api } from '@/lib/api'
import { useApp } from './app'
import { prepareImage, type PendingImage } from '@/lib/images'

interface WorkspaceChat {
  items: ChatItem[]
  loaded: boolean
  busy: boolean
  sessionId?: string
  model?: string
  lastResult?: ChatTurnResult
  error?: string
  draft: string
  /** Context size of the live session, in tokens, plus the window it is measured against and its recent growth. */
  contextTokens?: number
  contextWindow?: number
  contextCacheRead?: number
  contextHistory?: number[]
  /** A limit card waiting for the user's choice. */
  limit?: Extract<AgentEvent, { type: 'limit' }> | null
  /** Images attached to the draft, not sent yet. */
  images: PendingImage[]
  queue: { id: string; text: string }[]
}

interface ChatState {
  chats: Record<string, WorkspaceChat>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  /** Workspaces whose turn ended while not on screen; cleared when opened. */
  unseenDone: Record<string, true>
  markSeen: (workspaceId: string) => void
  answerQuestion: (response: QuestionResponse) => Promise<void>
  ensure: (workspaceId: string) => WorkspaceChat
  load: (workspaceId: string) => Promise<void>
  /** Re-read the transcript from main (after a resume replaced it). */
  reload: (workspaceId: string) => Promise<void>
  send: (workspaceId: string, text: string) => Promise<void>
  addImages: (workspaceId: string, files: (File | Blob)[]) => Promise<void>
  removeImage: (workspaceId: string, imageId: string) => void
  interrupt: (workspaceId: string) => Promise<void>
  unqueue: (workspaceId: string, id: string) => Promise<void>
  reset: (workspaceId: string) => Promise<void>
  setDraft: (workspaceId: string, draft: string) => void
  answerPermission: (requestId: string, decision: 'allow' | 'always' | 'deny') => Promise<void>
  handleEvent: (e: AgentEvent) => void
  subscribe: () => void
}

let subscribed = false
const empty = (): WorkspaceChat => ({ items: [], loaded: false, busy: false, draft: '', images: [], queue: [] })

function updateChat(state: ChatState, id: string, fn: (c: WorkspaceChat) => WorkspaceChat): Partial<ChatState> {
  const c = state.chats[id] ?? empty()
  return { chats: { ...state.chats, [id]: fn(c) } }
}


export const useChat = create<ChatState>((set, get) => ({
  chats: {},
  permissions: [],
  questions: [],
  unseenDone: {},
  markSeen: (id) =>
    set((s) => {
      if (!s.unseenDone[id]) return {}
      const unseenDone = { ...s.unseenDone }
      delete unseenDone[id]
      return { unseenDone }
    }),
  answerQuestion: async (response) => {
    set((s) => ({ questions: s.questions.filter((q) => q.requestId !== response.requestId) }))
    await api.invoke('agent:answerQuestion', response)
  },
  ensure: (id) => get().chats[id] ?? empty(),

  /** Pull the persisted transcript from main once per workspace; live events keep it current after that. */
  load: async (id) => {
    if (get().chats[id]?.loaded) return
    const { items, busy } = await api.invoke('chat:load', id)
    set((s) => updateChat(s, id, (c) => ({ ...c, items: c.items.length > items.length ? c.items : items, busy: busy || c.busy, loaded: true })))
  },
  reload: async (id) => {
    const { items, busy } = await api.invoke('chat:load', id)
    set((s) => updateChat(s, id, (c) => ({ ...c, items, busy, loaded: true, error: undefined })))
  },
  send: async (id, text) => {
    const trimmed = text.trim()
    const images = get().chats[id]?.images ?? []
    if (!trimmed && images.length === 0) return
    // The user item itself arrives back as a user_message event (or a queue event while a turn runs).
    set((s) => updateChat(s, id, (c) => ({ ...c, busy: c.busy || true, error: undefined, draft: '', images: [] })))
    try {
      await api.invoke('agent:send', id, trimmed, images.length ? images.map(({ name, mimeType, data }) => ({ name, mimeType, data })) : undefined)
      for (const img of images) URL.revokeObjectURL(img.preview)
    } catch (err) {
      set((s) => updateChat(s, id, (c) => ({ ...c, busy: false, error: String(err), images })))
    }
  },
  addImages: async (id, files) => {
    const prepared: PendingImage[] = []
    for (const f of files.slice(0, 10)) {
      try {
        prepared.push(await prepareImage(f, 'name' in f ? (f as File).name : 'pasted image'))
      } catch (err) {
        set((s) => updateChat(s, id, (c) => ({ ...c, error: err instanceof Error ? err.message : String(err) })))
      }
    }
    if (prepared.length) set((s) => updateChat(s, id, (c) => ({ ...c, images: [...c.images, ...prepared].slice(0, 10) })))
  },
  removeImage: (id, imageId) => {
    const img = get().chats[id]?.images.find((i) => i.id === imageId)
    if (img) URL.revokeObjectURL(img.preview)
    set((s) => updateChat(s, id, (c) => ({ ...c, images: c.images.filter((i) => i.id !== imageId) })))
  },
  interrupt: async (id) => api.invoke('agent:interrupt', id),
  unqueue: async (id, mid) => api.invoke('agent:unqueue', id, mid),
  reset: async (id) => {
    await api.invoke('agent:reset', id)
    set((s) => updateChat(s, id, () => ({ ...empty(), loaded: true })))
  },
  setDraft: (id, draft) => set((s) => updateChat(s, id, (c) => ({ ...c, draft }))),

  answerPermission: async (requestId, decision) => {
    set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== requestId) }))
    await api.invoke('agent:permission', { requestId, decision })
  },

  handleEvent: (e) => {
    const id = 'workspaceId' in e ? e.workspaceId : e.result.workspaceId
    set((s) => {
      const c = s.chats[id] ?? empty()
      const items = applyEvent(c.items, e)
      let next: WorkspaceChat = { ...c, items }
      switch (e.type) {
        case 'init':
          next = { ...next, sessionId: e.sessionId, model: e.model }
          break
        case 'status':
          next = { ...next, busy: e.busy }
          break
        case 'queue':
          next = { ...next, queue: e.items }
          break
        case 'assistant_start':
          next = { ...next, busy: true }
          break
        case 'result': {
          // Failures are rendered as system items in the transcript now.
          next = { ...next, busy: false, lastResult: e.result, error: undefined }
          // Finished out of sight: badge the workspace and, when the app is not in front, notify.
          const app = useApp.getState()
          const onScreen = app.view === 'workspace' && app.selectedId === id && document.hasFocus()
          if (!onScreen && c.busy) {
            queueMicrotask(() => set((st) => ({ unseenDone: { ...st.unseenDone, [id]: true as const } })))
            const ws = app.workspaces.find((w) => w.id === id)
            if (ws && (!document.hasFocus() || app.selectedId !== id)) {
              try {
                const n = new Notification(e.result.isError ? `${ws.name}: the turn failed` : `${ws.name} is done`, { body: e.result.isError ? (e.result.errorText ?? 'See the chat for details.') : `Finished in ${(e.result.durationMs / 1000).toFixed(0)}s${e.result.costUsd ? ` · $${e.result.costUsd.toFixed(2)}` : ''}. Click to open.`, silent: false })
                n.onclick = () => {
                  app.setView('workspace')
                  app.select(id)
                }
              } catch {
                /* notifications unavailable */
              }
            }
          }
          break
        }
        case 'error':
          next = { ...next, busy: false }
          break
        case 'context':
          next = { ...next, contextTokens: e.tokens, contextWindow: e.window ?? c.contextWindow, contextCacheRead: e.cacheRead, contextHistory: [...(c.contextHistory ?? []), e.tokens].slice(-40) }
          break
        case 'limit':
          next = { ...next, limit: e, busy: e.mode === 'preflight' ? false : next.busy }
          break
        case 'limit_resolved':
          next = { ...next, limit: null }
          break
      }
      return { chats: { ...s.chats, [id]: next } }
    })
  },

  subscribe: () => {
    // React StrictMode runs effects twice in dev; a second listener would double every event.
    if (subscribed) return
    subscribed = true
    api.on('agent:event', (e) => get().handleEvent(e))
    api.on('agent:permission', (p) => set((s) => ({ permissions: [...s.permissions, p] })))
    api.on('agent:question', (q) => set((s) => ({ questions: [...s.questions, q] })))
  }
}))
