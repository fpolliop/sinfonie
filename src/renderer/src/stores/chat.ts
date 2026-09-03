import { create } from 'zustand'
import type { AgentEvent, ChatItem, ChatToolBlock, ChatTurnResult, PermissionRequest } from '@shared/types'
import { api } from '@/lib/api'

interface WorkspaceChat {
  items: ChatItem[]
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
  send: (workspaceId: string, text: string) => Promise<void>
  interrupt: (workspaceId: string) => Promise<void>
  reset: (workspaceId: string) => Promise<void>
  setDraft: (workspaceId: string, draft: string) => void
  answerPermission: (requestId: string, decision: 'allow' | 'always' | 'deny') => Promise<void>
  handleEvent: (e: AgentEvent) => void
  subscribe: () => void
}

const empty = (): WorkspaceChat => ({ items: [], busy: false, draft: '' })

function updateChat(state: ChatState, id: string, fn: (c: WorkspaceChat) => WorkspaceChat): Partial<ChatState> {
  const c = state.chats[id] ?? empty()
  return { chats: { ...state.chats, [id]: fn(c) } }
}

function updateItem(c: WorkspaceChat, itemId: string, fn: (it: ChatItem) => ChatItem): WorkspaceChat {
  return { ...c, items: c.items.map((it) => (it.id === itemId ? fn(it) : it)) }
}

export const useChat = create<ChatState>((set, get) => ({
  chats: {},
  permissions: [],
  ensure: (id) => get().chats[id] ?? empty(),

  send: async (id, text) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const item: ChatItem = { id: crypto.randomUUID(), role: 'user', blocks: [{ type: 'text', text: trimmed }], createdAt: new Date().toISOString() }
    set((s) => updateChat(s, id, (c) => ({ ...c, items: [...c.items, item], busy: true, error: undefined, draft: '' })))
    try {
      await api.invoke('agent:send', id, trimmed)
    } catch (err) {
      set((s) => updateChat(s, id, (c) => ({ ...c, busy: false, error: String(err) })))
    }
  },
  interrupt: async (id) => api.invoke('agent:interrupt', id),
  reset: async (id) => {
    await api.invoke('agent:reset', id)
    set((s) => updateChat(s, id, () => empty()))
  },
  setDraft: (id, draft) => set((s) => updateChat(s, id, (c) => ({ ...c, draft }))),

  answerPermission: async (requestId, decision) => {
    set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== requestId) }))
    await api.invoke('agent:permission', { requestId, decision })
  },

  handleEvent: (e) => {
    switch (e.type) {
      case 'init':
        set((s) => updateChat(s, e.workspaceId, (c) => ({ ...c, sessionId: e.sessionId, model: e.model })))
        break
      case 'status':
        set((s) => updateChat(s, e.workspaceId, (c) => ({ ...c, busy: e.busy })))
        break
      case 'assistant_start':
        set((s) =>
          updateChat(s, e.workspaceId, (c) => ({
            ...c,
            busy: true,
            items: [...c.items, { id: e.itemId, role: 'assistant', blocks: [], createdAt: new Date().toISOString() }]
          }))
        )
        break
      case 'text_delta':
      case 'thinking_delta': {
        const kind = e.type === 'text_delta' ? 'text' : 'thinking'
        set((s) =>
          updateChat(s, e.workspaceId, (c) =>
            updateItem(c, e.itemId, (it) => {
              const last = it.blocks[it.blocks.length - 1]
              if (last && last.type === kind) {
                return { ...it, blocks: [...it.blocks.slice(0, -1), { type: kind, text: last.text + e.text }] }
              }
              return { ...it, blocks: [...it.blocks, { type: kind, text: e.text }] }
            })
          )
        )
        break
      }
      case 'tool_start':
        set((s) =>
          updateChat(s, e.workspaceId, (c) =>
            updateItem(c, e.itemId, (it) => ({
              ...it,
              blocks: [...it.blocks, { type: 'tool', toolUseId: e.toolUseId, name: e.name, input: undefined, done: false } as ChatToolBlock]
            }))
          )
        )
        break
      case 'tool_input':
        set((s) =>
          updateChat(s, e.workspaceId, (c) =>
            updateItem(c, e.itemId, (it) => ({
              ...it,
              blocks: it.blocks.map((b) => (b.type === 'tool' && b.toolUseId === e.toolUseId ? { ...b, input: e.input } : b))
            }))
          )
        )
        break
      case 'tool_result':
        set((s) =>
          updateChat(s, e.workspaceId, (c) => ({
            ...c,
            items: c.items.map((it) => ({
              ...it,
              blocks: it.blocks.map((b) =>
                b.type === 'tool' && b.toolUseId === e.toolUseId ? { ...b, result: e.result, isError: e.isError, done: true } : b
              )
            }))
          }))
        )
        break
      case 'assistant_end':
        break
      case 'result':
        set((s) => updateChat(s, e.result.workspaceId, (c) => ({ ...c, busy: false, lastResult: e.result, error: e.result.isError ? e.result.errorText : undefined })))
        break
      case 'error':
        set((s) => updateChat(s, e.workspaceId, (c) => ({ ...c, busy: false, error: e.message })))
        break
    }
  },

  subscribe: () => {
    api.on('agent:event', (e) => get().handleEvent(e))
    api.on('agent:permission', (p) => set((s) => ({ permissions: [...s.permissions, p] })))
  }
}))
