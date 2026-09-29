import { create } from 'zustand'
import { api } from '@/lib/api'
import type { AssistantItem, MaestroContext, MaestroConversation, MaestroConversationMeta, MaestroScreen, MaestroSuggestion } from '@shared/types'

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
/** newConversation calls in flight, by context, so two at once create one conversation. */
const creating = new Map<string, Promise<string>>()

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
    // An untouched conversation with the same context is reused, so opening Maestro twice (or React running an
    // effect twice) never leaves a trail of empty "New conversation"s. Concurrent calls share one request.
    const same = (c: MaestroConversationMeta): boolean => !c.archivedAt && !c.preview && !c.titleLocked && (c.context?.workspaceId ?? '') === (context?.workspaceId ?? '') && (c.context?.screen ?? '') === (context?.screen ?? '')
    const reuse = get().conversations.find(same)
    if (reuse) {
      await get().select(reuse.id)
      return reuse.id
    }
    const key = `${context?.workspaceId ?? ''}|${context?.screen ?? ''}`
    const pending = creating.get(key)
    if (pending) return pending
    const job = (async (): Promise<string> => {
      const c = await api.invoke('maestro:new', context)
      set((s) => ({ conversations: [c, ...s.conversations.filter((x) => x.id !== c.id)], byId: { ...s.byId, [c.id]: empty() } }))
      await get().select(c.id)
      return c.id
    })()
    creating.set(key, job)
    try {
      return await job
    } finally {
      creating.delete(key)
    }
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

/** Which Maestro screen a view counts as, for the dock's context. Maestro home itself has no dock. */
const SCREEN_OF: Partial<Record<string, MaestroScreen>> = { workspace: 'build', agents: 'build', reviews: 'review', oncall: 'review', notes: 'notes', home: 'home' }
const RESUME_WITHIN_MS = 8 * 60 * 60 * 1000

/**
 * ⌘J: the Maestro dock on the current screen. It knows what the screen shows (the open workspace, the space, which
 * place in the rail) and resumes the recent conversation about the same thing instead of starting a new one each time.
 * On Maestro home it does nothing: Maestro is already the whole screen.
 */
export async function toggleMaestroDock(): Promise<void> {
  const m = useMaestro.getState()
  const app = (await import('./app')).useApp.getState()
  if (app.view === 'maestro') return
  if (m.open) {
    m.setOpen(false)
    return
  }
  m.subscribe()
  if (!m.listLoaded) await m.loadList()
  const screen = SCREEN_OF[app.view]
  const workspaceId = app.view === 'workspace' ? (app.selectedId ?? undefined) : undefined
  const context: MaestroContext = { ...(workspaceId ? { workspaceId } : {}), ...(app.activeSpaceId ? { spaceId: app.activeSpaceId } : {}), ...(screen ? { screen } : {}) }
  const now = Date.now()
  const same = useMaestro
    .getState()
    .conversations.find((c) => !c.archivedAt && now - new Date(c.updatedAt).getTime() < RESUME_WITHIN_MS && (workspaceId ? c.context?.workspaceId === workspaceId : !c.context?.workspaceId && c.context?.screen === screen))
  if (same) await useMaestro.getState().select(same.id)
  else await useMaestro.getState().newConversation(context)
  useMaestro.getState().setShape('side')
  useMaestro.getState().setOpen(true)
}

/** ⌘K's fallback: send a question to Maestro, on Maestro home or in the dock of the current screen. */
export async function askMaestro(text: string): Promise<void> {
  const app = (await import('./app')).useApp.getState()
  if (app.view !== 'maestro' && !useMaestro.getState().open) await toggleMaestroDock()
  const m = useMaestro.getState()
  m.subscribe()
  if (!m.listLoaded) await m.loadList()
  const id = useMaestro.getState().activeId ?? (await useMaestro.getState().newConversation())
  await useMaestro.getState().send(id, text)
}
