import { create } from 'zustand'
import type { AgentEvent, ChatTurnResult, PermissionRequest } from '@shared/types'
import type { ChatItem } from '@shared/types'
import { applyEvent } from '@shared/transcript'
import { api } from '@/lib/api'

interface WorkspaceChat {
  items: ChatItem[]
  loaded: boolean
  busy: boolean
  sessionId?: string
  model?: string
  lastResult?: ChatTurnResult
  error?: string
  draft: string
}

interface ChatState {
  chats: Record<string, WorkspaceChat>
  permissions: PermissionRequest[]
  ensure: (workspaceId: string) => WorkspaceChat
  load: (workspaceId: string) => Promise<void>
  send: (workspaceId: string, text: string) => Promise<void>
  interrupt: (workspaceId: string) => Promise<void>
  reset: (workspaceId: string) => Promise<void>
  setDraft: (workspaceId: string, draft: string) => void
  answerPermission: (requestId: string, decision: 'allow' | 'always' | 'deny') => Promise<void>
  handleEvent: (e: AgentEvent) => void
  subscribe: () => void
}

let subscribed = false
const empty = (): WorkspaceChat => ({ items: [], loaded: false, busy: false, draft: '' })

function updateChat(state: ChatState, id: string, fn: (c: WorkspaceChat) => WorkspaceChat): Partial<ChatState> {
  const c = state.chats[id] ?? empty()
  return { chats: { ...state.chats, [id]: fn(c) } }
}


export const useChat = create<ChatState>((set, get) => ({
  chats: {},
  permissions: [],
  ensure: (id) => get().chats[id] ?? empty(),

  /** Pull the persisted transcript from main once per workspace; live events keep it current after that. */
  load: async (id) => {
    if (get().chats[id]?.loaded) return
    const { items, busy } = await api.invoke('chat:load', id)
    set((s) => updateChat(s, id, (c) => ({ ...c, items: c.items.length > items.length ? c.items : items, busy: busy || c.busy, loaded: true })))
  },
  send: async (id, text) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // The user item itself arrives back as a user_message event, so main and renderer stay identical.
    set((s) => updateChat(s, id, (c) => ({ ...c, busy: true, error: undefined, draft: '' })))
    try {
      await api.invoke('agent:send', id, trimmed)
    } catch (err) {
      set((s) => updateChat(s, id, (c) => ({ ...c, busy: false, error: String(err) })))
    }
  },
  interrupt: async (id) => api.invoke('agent:interrupt', id),
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
        case 'assistant_start':
          next = { ...next, busy: true }
          break
        case 'result':
          next = { ...next, busy: false, lastResult: e.result, error: e.result.isError ? e.result.errorText : undefined }
          break
        case 'error':
          next = { ...next, busy: false, error: e.message }
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
  }
}))
