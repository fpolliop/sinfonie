import { create } from 'zustand'
import { api } from '@/lib/api'
import type { Note } from '@shared/types'

interface NotesState {
  byWorkspace: Record<string, Note[]>
  load: (workspaceId: string) => Promise<void>
  add: (workspaceId: string, text: string, kind: Note['kind']) => Promise<void>
  update: (workspaceId: string, id: string, patch: Partial<Pick<Note, 'text' | 'done' | 'kind'>>) => Promise<void>
  remove: (workspaceId: string, id: string) => Promise<void>
  subscribe: () => void
}

let subscribed = false

export const useNotes = create<NotesState>((set) => ({
  byWorkspace: {},
  load: async (workspaceId) => {
    const notes = await api.invoke('notes:list', workspaceId)
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: notes } }))
  },
  add: async (workspaceId, text, kind) => {
    const notes = await api.invoke('notes:add', workspaceId, text, kind)
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: notes } }))
  },
  update: async (workspaceId, id, patch) => {
    const notes = await api.invoke('notes:update', workspaceId, id, patch)
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: notes } }))
  },
  remove: async (workspaceId, id) => {
    const notes = await api.invoke('notes:remove', workspaceId, id)
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: notes } }))
  },
  subscribe: () => {
    if (subscribed) return
    subscribed = true
    api.on('notes:changed', ({ workspaceId, notes }) => set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: notes } })))
  }
}))
