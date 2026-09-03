import { create } from 'zustand'
import type { Label, Repo, Settings, Space, StoreData, Workspace } from '@shared/types'
import { api } from '@/lib/api'

export type Tab = 'chat' | 'changes' | 'prs' | 'terminal' | 'run'

interface AppState {
  loaded: boolean
  spaces: Space[]
  labels: Label[]
  /** Sidebar label filter, per space id ('' = ungrouped). A workspace must carry every selected label. */
  labelFilter: Record<string, string[]>
  toggleLabelFilter: (spaceId: string, labelId: string) => void
  clearLabelFilter: (spaceId: string) => void
  repos: Repo[]
  collapsedSpaces: Record<string, boolean>
  toggleSpace: (id: string) => void
  /** The space the sidebar is showing; '' is the ungrouped bucket. */
  activeSpaceId: string
  setActiveSpace: (id: string) => void
  /** Sidebar layout: workspaces grouped by stage, or a flat list by start date. */
  sidebarView: 'status' | 'date'
  sidebarDateDir: 'desc' | 'asc'
  collapsedStages: Record<string, boolean>
  setSidebarView: (v: 'status' | 'date') => void
  setSidebarDateDir: (d: 'desc' | 'asc') => void
  toggleStage: (id: string) => void
  /** Move to the previous/next space in the dot bar, wrapping around. */
  stepSpace: (dir: 1 | -1) => void
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
  labels: [],
  labelFilter: JSON.parse(localStorage.getItem('orchestra.labelFilter') ?? '{}'),
  toggleLabelFilter: (spaceId, labelId) =>
    set((s) => {
      const cur = s.labelFilter[spaceId] ?? []
      const next = cur.includes(labelId) ? cur.filter((x) => x !== labelId) : [...cur, labelId]
      const labelFilter = { ...s.labelFilter, [spaceId]: next }
      localStorage.setItem('orchestra.labelFilter', JSON.stringify(labelFilter))
      return { labelFilter }
    }),
  clearLabelFilter: (spaceId) =>
    set((s) => {
      const labelFilter = { ...s.labelFilter, [spaceId]: [] }
      localStorage.setItem('orchestra.labelFilter', JSON.stringify(labelFilter))
      return { labelFilter }
    }),
  repos: [],
  collapsedSpaces: JSON.parse(localStorage.getItem('orchestra.collapsedSpaces') ?? '{}'),
  toggleSpace: (id) =>
    set((s) => {
      const collapsedSpaces = { ...s.collapsedSpaces, [id]: !s.collapsedSpaces[id] }
      localStorage.setItem('orchestra.collapsedSpaces', JSON.stringify(collapsedSpaces))
      return { collapsedSpaces }
    }),
  newWorkspaceSpaceId: localStorage.getItem('orchestra.lastSpace') ?? '',
  activeSpaceId: localStorage.getItem('orchestra.activeSpace') ?? '',
  sidebarView: (localStorage.getItem('orchestra.sidebarView') as 'status' | 'date') ?? 'status',
  sidebarDateDir: (localStorage.getItem('orchestra.sidebarDateDir') as 'desc' | 'asc') ?? 'desc',
  collapsedStages: JSON.parse(localStorage.getItem('orchestra.collapsedStages') ?? '{}'),
  setSidebarView: (sidebarView) => {
    localStorage.setItem('orchestra.sidebarView', sidebarView)
    set({ sidebarView })
  },
  setSidebarDateDir: (sidebarDateDir) => {
    localStorage.setItem('orchestra.sidebarDateDir', sidebarDateDir)
    set({ sidebarDateDir })
  },
  toggleStage: (id) =>
    set((s) => {
      const collapsedStages = { ...s.collapsedStages, [id]: !s.collapsedStages[id] }
      localStorage.setItem('orchestra.collapsedStages', JSON.stringify(collapsedStages))
      return { collapsedStages }
    }),
  setActiveSpace: (id) => {
    localStorage.setItem('orchestra.activeSpace', id)
    localStorage.setItem('orchestra.lastSpace', id)
    set({ activeSpaceId: id, newWorkspaceSpaceId: id })
  },
  stepSpace: (dir) => {
    const { spaces, workspaces, activeSpaceId, setActiveSpace } = get()
    const ids = spaceOrder(spaces.map((s) => s.id), workspaces.some((w) => w.status !== 'archived' && (!w.spaceId || !spaces.some((s) => s.id === w.spaceId))))
    if (ids.length < 2) return
    const i = Math.max(0, ids.indexOf(activeSpaceId))
    setActiveSpace(ids[(i + dir + ids.length) % ids.length])
  },
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
    set({ spaces: d.spaces, labels: d.labels, repos: d.repos, workspaces: d.workspaces, settings: d.settings, selectedId: stillThere ? selected : null })
  },
  select: (id) => {
    if (id) localStorage.setItem('orchestra.selected', id)
    else localStorage.removeItem('orchestra.selected')
    localStorage.setItem('orchestra.view', 'workspace')
    const ws = get().workspaces.find((w) => w.id === id)
    if (ws) {
      const sid = ws.spaceId && get().spaces.some((s) => s.id === ws.spaceId) ? ws.spaceId : ''
      localStorage.setItem('orchestra.lastSpace', sid)
      localStorage.setItem('orchestra.activeSpace', sid)
      set({ newWorkspaceSpaceId: sid, activeSpaceId: sid })
    }
    set({ selectedId: id, tab: 'chat', view: 'workspace' })
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

/** Dot-bar order: every space, then the ungrouped bucket when it has something (or when there are no spaces at all). */
export function spaceOrder(spaceIds: string[], hasUngrouped: boolean): string[] {
  return spaceIds.length === 0 || hasUngrouped ? [...spaceIds, ''] : spaceIds
}

export function useSelectedWorkspace(): Workspace | undefined {
  return useApp((s) => s.workspaces.find((w) => w.id === s.selectedId))
}
