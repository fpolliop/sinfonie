import { create } from 'zustand'
import type { Repo, Settings, Space, StoreData, Workspace } from '@shared/types'
import { api } from '@/lib/api'

export type Tab = 'chat' | 'changes' | 'prs' | 'terminal' | 'run'

interface AppState {
  loaded: boolean
  spaces: Space[]
  repos: Repo[]
  collapsedSpaces: Record<string, boolean>
  toggleSpace: (id: string) => void
  /** Space the New workspace dialog should default to: the selected workspace's, else the last used. */
  newWorkspaceSpaceId: string
  workspaces: Workspace[]
  settings: Settings
  selectedId: string | null
  view: 'workspace' | 'reviews'
  tab: Tab
  showNewWorkspace: boolean
  showSettings: boolean
  showArchived: boolean
  error: string | null
  branchPrompt: { workspaceId: string; name: string; newSlug: string; currentBranch: string } | null

  load: () => Promise<void>
  applyStore: (d: StoreData) => void
  select: (id: string | null) => void
  setView: (v: 'workspace' | 'reviews') => void
  setTab: (t: Tab) => void
  setShowNewWorkspace: (v: boolean, spaceId?: string) => void
  setShowSettings: (v: boolean) => void
  setShowArchived: (v: boolean) => void
  setError: (e: string | null) => void
  setBranchPrompt: (p: AppState['branchPrompt']) => void
}

export const useApp = create<AppState>((set, get) => ({
  loaded: false,
  spaces: [],
  repos: [],
  collapsedSpaces: JSON.parse(localStorage.getItem('orchestra.collapsedSpaces') ?? '{}'),
  toggleSpace: (id) =>
    set((s) => {
      const collapsedSpaces = { ...s.collapsedSpaces, [id]: !s.collapsedSpaces[id] }
      localStorage.setItem('orchestra.collapsedSpaces', JSON.stringify(collapsedSpaces))
      return { collapsedSpaces }
    }),
  newWorkspaceSpaceId: localStorage.getItem('orchestra.lastSpace') ?? '',
  workspaces: [],
  settings: { workspacesRoot: '', basePort: 55000, model: 'claude-opus-5', permissionMode: 'default', jira: { connected: false, siteUrl: '', email: '', hasToken: false, defaultJql: '' }, claudeAccounts: [{ id: 'default', name: 'Default', configDir: null }], defaultClaudeAccountId: 'default' },
  view: (localStorage.getItem('orchestra.view') as 'workspace' | 'reviews') ?? 'workspace',
  selectedId: localStorage.getItem('orchestra.selected'),
  tab: 'chat',
  showNewWorkspace: false,
  showSettings: false,
  showArchived: false,
  error: null,
  branchPrompt: null,

  load: async () => {
    const d = await api.invoke('store:get')
    get().applyStore(d)
    set({ loaded: true })
    api.on('store:changed', (data) => get().applyStore(data))
  },
  applyStore: (d) => {
    const selected = get().selectedId
    const stillThere = d.workspaces.some((w) => w.id === selected)
    set({ spaces: d.spaces, repos: d.repos, workspaces: d.workspaces, settings: d.settings, selectedId: stillThere ? selected : null })
  },
  select: (id) => {
    if (id) localStorage.setItem('orchestra.selected', id)
    else localStorage.removeItem('orchestra.selected')
    localStorage.setItem('orchestra.view', 'workspace')
    const ws = get().workspaces.find((w) => w.id === id)
    if (ws) localStorage.setItem('orchestra.lastSpace', ws.spaceId ?? '')
    set({ selectedId: id, tab: 'chat', view: 'workspace', ...(ws ? { newWorkspaceSpaceId: ws.spaceId ?? '' } : {}) })
  },
  setView: (view) => {
    localStorage.setItem('orchestra.view', view)
    set({ view })
  },
  setTab: (tab) => set({ tab }),
  setShowNewWorkspace: (v, spaceId) => {
    if (spaceId !== undefined) {
      localStorage.setItem('orchestra.lastSpace', spaceId)
      set({ newWorkspaceSpaceId: spaceId })
    }
    set({ showNewWorkspace: v })
  },
  setShowSettings: (v) => set({ showSettings: v }),
  setShowArchived: (v) => set({ showArchived: v }),
  setError: (error) => set({ error }),
  setBranchPrompt: (branchPrompt) => set({ branchPrompt })
}))

export function useSelectedWorkspace(): Workspace | undefined {
  return useApp((s) => s.workspaces.find((w) => w.id === s.selectedId))
}
