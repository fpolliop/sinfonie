import { create } from 'zustand'
import type { Repo, Settings, StoreData, Workspace } from '@shared/types'
import { api } from '@/lib/api'

export type Tab = 'chat' | 'changes' | 'terminal' | 'run'

interface AppState {
  loaded: boolean
  repos: Repo[]
  workspaces: Workspace[]
  settings: Settings
  selectedId: string | null
  tab: Tab
  showNewWorkspace: boolean
  showSettings: boolean
  showArchived: boolean
  error: string | null

  load: () => Promise<void>
  applyStore: (d: StoreData) => void
  select: (id: string | null) => void
  setTab: (t: Tab) => void
  setShowNewWorkspace: (v: boolean) => void
  setShowSettings: (v: boolean) => void
  setShowArchived: (v: boolean) => void
  setError: (e: string | null) => void
}

export const useApp = create<AppState>((set, get) => ({
  loaded: false,
  repos: [],
  workspaces: [],
  settings: { workspacesRoot: '', basePort: 55000, model: 'claude-opus-5', permissionMode: 'default' },
  selectedId: localStorage.getItem('orchestra.selected'),
  tab: 'chat',
  showNewWorkspace: false,
  showSettings: false,
  showArchived: false,
  error: null,

  load: async () => {
    const d = await api.invoke('store:get')
    get().applyStore(d)
    set({ loaded: true })
    api.on('store:changed', (data) => get().applyStore(data))
  },
  applyStore: (d) => {
    const selected = get().selectedId
    const stillThere = d.workspaces.some((w) => w.id === selected)
    set({ repos: d.repos, workspaces: d.workspaces, settings: d.settings, selectedId: stillThere ? selected : null })
  },
  select: (id) => {
    if (id) localStorage.setItem('orchestra.selected', id)
    else localStorage.removeItem('orchestra.selected')
    set({ selectedId: id, tab: 'chat' })
  },
  setTab: (tab) => set({ tab }),
  setShowNewWorkspace: (v) => set({ showNewWorkspace: v }),
  setShowSettings: (v) => set({ showSettings: v }),
  setShowArchived: (v) => set({ showArchived: v }),
  setError: (error) => set({ error })
}))

export function useSelectedWorkspace(): Workspace | undefined {
  return useApp((s) => s.workspaces.find((w) => w.id === s.selectedId))
}
