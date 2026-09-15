import { create } from 'zustand'
import { api } from '@/lib/api'
import type { Note, NotePatch } from '@shared/types'

interface NotesState {
  /** Notes per owner: a workspace id, "space:<id>" or "app". */
  byWorkspace: Record<string, Note[]>
  /** Display labels for owners seen by loadAll. */
  labels: Record<string, string>
  allLoaded: boolean
  load: (owner: string) => Promise<void>
  loadAll: () => Promise<void>
  add: (owner: string, text: string, kind: Note['kind']) => Promise<void>
  update: (owner: string, id: string, patch: NotePatch) => Promise<void>
  move: (fromOwner: string, id: string, toOwner: string) => Promise<void>
  remove: (owner: string, id: string) => Promise<void>
  subscribe: () => void
}

let subscribed = false

export const useNotes = create<NotesState>((set) => ({
  byWorkspace: {},
  labels: {},
  allLoaded: false,
  load: async (owner) => {
    const notes = await api.invoke('notes:list', owner)
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [owner]: notes } }))
  },
  loadAll: async () => {
    const groups = await api.invoke('notes:all')
    set((s) => ({
      byWorkspace: { ...Object.fromEntries(Object.keys(s.byWorkspace).map((k) => [k, []])), ...s.byWorkspace, ...Object.fromEntries(groups.map((g) => [g.owner, g.notes])) },
      labels: { ...s.labels, ...Object.fromEntries(groups.map((g) => [g.owner, g.label])) },
      allLoaded: true
    }))
  },
  add: async (owner, text, kind) => {
    const notes = await api.invoke('notes:add', owner, text, kind)
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [owner]: notes } }))
  },
  update: async (owner, id, patch) => {
    const notes = await api.invoke('notes:update', owner, id, patch)
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [owner]: notes } }))
  },
  move: async (fromOwner, id, toOwner) => {
    const dest = await api.invoke('notes:move', fromOwner, id, toOwner)
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [fromOwner]: (s.byWorkspace[fromOwner] ?? []).filter((n) => n.id !== id), [toOwner]: dest } }))
  },
  remove: async (owner, id) => {
    const notes = await api.invoke('notes:remove', owner, id)
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [owner]: notes } }))
  },
  subscribe: () => {
    if (subscribed) return
    subscribed = true
    api.on('notes:changed', ({ workspaceId, notes }) => set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: notes } })))
  }
}))
