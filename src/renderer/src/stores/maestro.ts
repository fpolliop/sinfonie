import { create } from 'zustand'
import { api } from '@/lib/api'
import type { AssistantItem, MaestroContext, MaestroConversation, MaestroConversationMeta, MaestroSuggestion } from '@shared/types'

/** One loaded conversation: its items, the text still streaming per item, and whether Maestro is answering. */
export interface Loaded {
  items: AssistantItem[]
  deltas: Record<string, string>
  busy: boolean
  draft: string
}
export type Shape = 'side' | 'full'

interface MaestroState {
  /** The side panel is showing (full screen is the 'maestro' view in the app store). */
  open: boolean
  shape: Shape
  width: number
  activeId: string | null
  conversations: MaestroConversationMeta[]
  byId: Record<string, Loaded>
  suggestions: MaestroSuggestion[]
  listLoaded: boolean
  setOpen: (v: boolean) => void
  setShape: (s: Shape) => void
  setWidth: (w: number) => void
  loadList: () => Promise<void>
  select: (id: string | null) => Promise<void>
  newConversation: (context?: MaestroContext) => Promise<string>
  send: (id: string, text: string) => Promise<void>
  stop: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  pin: (id: string, pinned: boolean) => Promise<void>
  archive: (id: string, archived: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
  setDraft: (id: string, draft: string) => void
  loadSuggestions: () => Promise<void>
  subscribe: () => void
}

const empty = (): Loaded => ({ items: [], deltas: {}, busy: false, draft: '' })
let subscribed = false

export const useMaestro = create<MaestroState>((set, get) => ({
  open: false,
  shape: (localStorage.getItem('sinfonie.maestro.shape') as Shape) || 'side',
  width: Math.min(900, Math.max(380, Number(localStorage.getItem('sinfonie.maestro.width')) || 460)),
  activeId: localStorage.getItem('sinfonie.maestro.active'),
  conversations: [],
  byId: {},
  suggestions: [],
  listLoaded: false,
  setOpen: (open) => set({ open }),
  setShape: (shape) => {
    localStorage.setItem('sinfonie.maestro.shape', shape)
    set({ shape })
  },
  setWidth: (width) => {
    const w = Math.min(900, Math.max(380, Math.round(width)))
    localStorage.setItem('sinfonie.maestro.width', String(w))
    set({ width: w })
  },
  loadList: async () => {
    const conversations = await api.invoke('maestro:conversations')
    set({ conversations, listLoaded: true })
    const { activeId } = get()
    if (activeId && !conversations.some((c) => c.id === activeId)) set({ activeId: null })
  },
  select: async (id) => {
    if (id) localStorage.setItem('sinfonie.maestro.active', id)
    else localStorage.removeItem('sinfonie.maestro.active')
    set({ activeId: id })
    if (!id || get().byId[id]) return
    const c: MaestroConversation = await api.invoke('maestro:get', id)
    set((s) => ({ byId: { ...s.byId, [id]: { ...empty(), items: c.items, busy: Boolean(c.busy) } } }))
  },
  newConversation: async (context) => {
    const c = await api.invoke('maestro:new', context)
    set((s) => ({ conversations: [c, ...s.conversations.filter((x) => x.id !== c.id)], byId: { ...s.byId, [c.id]: empty() } }))
    await get().select(c.id)
    return c.id
  },
  send: async (id, text) => {
    const t = text.trim()
    if (!t) return
    set((s) => ({ byId: { ...s.byId, [id]: { ...(s.byId[id] ?? empty()), busy: true, draft: '' } } }))
    try {
      await api.invoke('maestro:send', id, t)
    } catch (err) {
      set((s) => ({ byId: { ...s.byId, [id]: { ...(s.byId[id] ?? empty()), busy: false, draft: t } } }))
      throw err
    }
  },
  stop: (id) => api.invoke('maestro:stop', id),
  rename: async (id, title) => {
    await api.invoke('maestro:rename', id, title)
  },
  pin: async (id, pinned) => {
    await api.invoke('maestro:pin', id, pinned)
  },
  archive: async (id, archived) => {
    await api.invoke('maestro:archive', id, archived)
  },
  remove: async (id) => {
    await api.invoke('maestro:delete', id)
    set((s) => {
      const byId = { ...s.byId }
      delete byId[id]
      return { conversations: s.conversations.filter((c) => c.id !== id), byId, activeId: s.activeId === id ? null : s.activeId }
    })
  },
  setDraft: (id, draft) => set((s) => ({ byId: { ...s.byId, [id]: { ...(s.byId[id] ?? empty()), draft } } })),
  loadSuggestions: async () => {
    try {
      set({ suggestions: await api.invoke('maestro:suggestions') })
    } catch {
      /* the empty state just shows less */
    }
  },
  subscribe: () => {
    if (subscribed) return
    subscribed = true
    api.on('maestro:event', (e) => {
      const id = e.conversationId
      set((s) => {
        const cur = s.byId[id]
        if (e.type === 'meta') {
          const exists = s.conversations.some((c) => c.id === id)
          return { conversations: exists ? s.conversations.map((c) => (c.id === id ? e.meta : c)) : [e.meta, ...s.conversations] }
        }
        if (e.type === 'removed') {
          const byId = { ...s.byId }
          delete byId[id]
          return { conversations: s.conversations.filter((c) => c.id !== id), byId, activeId: s.activeId === id ? null : s.activeId }
        }
        if (!cur) return {}
        if (e.type === 'item') {
          const deltas = { ...cur.deltas }
          delete deltas[e.item.id]
          const items = cur.items.some((x) => x.id === e.item.id) ? cur.items.map((x) => (x.id === e.item.id ? e.item : x)) : [...cur.items, e.item]
          return { byId: { ...s.byId, [id]: { ...cur, items, deltas } } }
        }
        if (e.type === 'delta') return { byId: { ...s.byId, [id]: { ...cur, deltas: { ...cur.deltas, [e.id]: e.text } } } }
        if (e.type === 'status') return { byId: { ...s.byId, [id]: { ...cur, busy: e.busy } }, conversations: s.conversations.map((c) => (c.id === id ? { ...c, busy: e.busy } : c)) }
        return {}
      })
    })
  }
}))

/** Open Maestro in its last shape, optionally starting a conversation from a workspace or space. */
export async function openMaestro(opts?: { context?: MaestroContext; fresh?: boolean; prompt?: string }): Promise<void> {
  const m = useMaestro.getState()
  m.subscribe()
  if (!m.listLoaded) await m.loadList()
  const { setView } = (await import('./app')).useApp.getState()
  if (opts?.fresh || opts?.context || !useMaestro.getState().activeId) {
    const id = await useMaestro.getState().newConversation(opts?.context)
    if (opts?.prompt) useMaestro.getState().setDraft(id, opts.prompt)
  } else await useMaestro.getState().select(useMaestro.getState().activeId)
  if (useMaestro.getState().shape === 'full') setView('maestro')
  else useMaestro.getState().setOpen(true)
}
