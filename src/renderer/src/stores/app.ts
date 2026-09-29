import { tokens } from '@/lib/theme'
import { create } from 'zustand'
import type { AgentSpec, Engine, Label, Repo, Settings, Space, StoreData, Workspace } from '@shared/types'

export type View = 'workspace' | 'reviews' | 'oncall' | 'agents' | 'notes' | 'maestro' | 'home'
import { api } from '@/lib/api'

export interface Notice {
  kind: 'success' | 'info'
  text: string
  /** Shown as an Undo button; the notice closes after it runs. */
  undo?: () => void
  /** Identifies the notice so a later action can withdraw it (e.g. sending a message cancels "undo new session"). */
  id?: string
  /** A button that opens a web page (e.g. the pull request just opened). */
  link?: { label: string; url: string }
}
/**
 * The workspace's side panel (the inspector beside the conversation): changes, files, preview, checks, terminal,
 * run scripts, data, or a generated view. 'chat' is kept for callers that ask to "show the conversation": the
 * conversation is always on screen, so it changes nothing. A generated view tab is `view:<id>`.
 */
export type Tab = 'chat' | 'changes' | 'code' | 'prs' | 'terminal' | 'run' | 'browser' | 'data' | `view:${string}`
export type AppPage = 'preferences' | 'general' | 'spaces' | 'repos' | 'providers' | 'accounts' | 'logins' | 'crew' | 'resources' | 'usage' | 'oncall' | 'mcp' | 'jira' | 'linear' | 'slack' | 'gcp' | 'integrations' | 'feedback' | 'phone' | 'plan' | 'about'
export type SpacePage = 'general' | 'repos' | 'crew' | 'oncall' | 'mcp' | 'jira' | 'linear' | 'slack' | 'gcp' | 'databases' | 'github'
export type SettingsTarget = { scope: 'app'; page: AppPage } | { scope: 'space'; spaceId: string; page: SpacePage }

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
  sidebarView: 'status' | 'date' | 'activity' | 'manual'
  sidebarDateDir: 'desc' | 'asc'
  collapsedStages: Record<string, boolean>
  setSidebarView: (v: 'status' | 'date' | 'activity' | 'manual') => void
  setSidebarDateDir: (d: 'desc' | 'asc') => void
  toggleStage: (id: string) => void
  /** Move to the previous/next space in the dot bar, wrapping around. */
  stepSpace: (dir: 1 | -1) => void
  /** Space the New workspace dialog should default to: the selected workspace's, else the last used. */
  newWorkspaceSpaceId: string
  workspaces: Workspace[]
  settings: Settings
  selectedId: string | null
  view: View
  tab: Tab
  /** The Home page view on screen (a generated view id). */
  homeViewId: string | null
  setHomeViewId: (id: string | null) => void
  /** The workspace's side panel is expanded (collapsed, it is a thin rail of tab icons). */
  inspectorOpen: boolean
  setInspectorOpen: (v: boolean) => void
  /** Bumped whenever a panel tab is asked for, so a panel folded for lack of room can show itself over the chat. */
  inspectorReveal: number
  /** The side panel's width in px; the conversation keeps the rest. */
  inspectorWidth: number
  setInspectorWidth: (w: number) => void
  /** The agent library, mirrored from main. */
  agents: AgentSpec[]
  setAgents: (a: AgentSpec[]) => void
  /** An agent the Agents view should select on next render (notification click, links). */
  openAgentId: string | null
  setOpenAgentId: (id: string | null) => void
  showNewWorkspace: boolean
  /** The open settings page, or null when the window is closed. */
  settingsTarget: SettingsTarget | null
  openSettings: (t: SettingsTarget) => void
  /** An invite token from a sinfonie://join link, waiting for the Plan page to accept it. */
  pendingInvite: { token: string; kind: 'join' | 'redeem' } | null
  setPendingInvite: (p: { token: string; kind: 'join' | 'redeem' } | null) => void
  closeSettings: () => void
  showArchived: boolean
  error: string | null
  /** A non-error toast: success or info, optionally with an Undo that runs before the notice times out. */
  notice: Notice | null
  notify: (n: Notice | null) => void
  /** Ids hidden from lists while their removal waits out its Undo window (see lib/undo). */
  pendingRemoval: string[]
  setPendingRemoval: (id: string, pending: boolean) => void
  branchPrompt: { workspaceId: string; name: string; newSlug: string; currentBranch: string } | null
  feedbackDialog: 'feedback' | 'errors' | null
  setFeedbackDialog: (v: 'feedback' | 'errors' | null) => void
  assistantOpen: boolean
  setAssistantOpen: (v: boolean) => void
  /** A first message for the Maestro conversation the next assistantOpen starts fresh with (setup hand-off). */
  maestroSeed: string | null
  setMaestroSeed: (s: string | null) => void
  /** The first-run setup wizard or the spotlight tour, when one is showing. */
  onboarding: 'setup' | 'tour' | null
  setOnboarding: (v: 'setup' | 'tour' | null) => void
  /** The step the setup wizard opens on (0 = Welcome); set by openSetupAt, reset when the wizard opens. */
  setupStartStep: number
  /** Open the setup wizard straight on one step, e.g. 2 for "Your team" / "First space". */
  openSetupAt: (step: number) => void
  /** What the setup wizard's First space step has collected so far. */
  onboardingDraft: { name: string; color: string; root: string; repos: string[]; added: Set<string> }
  setOnboardingDraft: (patch: Partial<AppState['onboardingDraft']>) => void

  load: () => Promise<void>
  applyStore: (d: StoreData) => void
  select: (id: string | null) => void
  setView: (v: View) => void
  setTab: (t: Tab) => void
  setShowNewWorkspace: (v: boolean, spaceId?: string) => void
  /** What the New workspace dialog starts from when opened from an incident or a ticket: a name and the first message. */
  newWorkspaceSeed: { name: string; draft: string } | null
  setNewWorkspaceSeed: (seed: { name: string; draft: string } | null) => void
  /** A shell or agent CLI the Terminal tab should open as soon as it shows (from the workspace menu). */
  pendingShell: { workspaceId: string; repoId?: string | null; agent?: Engine } | null
  setPendingShell: (p: { workspaceId: string; repoId?: string | null; agent?: Engine } | null) => void
  /** Kept for older call sites: opens Application → General. */
  setShowSettings: (v: boolean) => void
  setShowArchived: (v: boolean) => void
  setError: (e: string | null) => void
  setBranchPrompt: (p: AppState['branchPrompt']) => void
}

/** localStorage can be unavailable or full; a preference that cannot be read or saved just uses its default. */
function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* the preference lasts for this session only */
  }
}
/** The side panel's width limits; the conversation also keeps a minimum, enforced by the layout. */
export const INSPECTOR_MIN = 360
export const INSPECTOR_MAX = 1100
export const INSPECTOR_DEFAULT = 560
const clampInspector = (w: number): number => Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, Math.round(w)))

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
  sidebarView: (localStorage.getItem('orchestra.sidebarView') as 'status' | 'date' | 'activity' | 'manual') ?? 'status',
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
    // Land inside the space: keep the selection if it belongs there, else the most recent
    // conversation of that space, else the empty page. Never leave another space's chat on screen.
    const { workspaces, spaces, selectedId, view, settings } = get()
    if (view === 'reviews') return
    if (view === 'oncall') {
      // On call is per space: leave the view when the new space does not watch Slack.
      const sp = spaces.find((s) => s.id === id)
      const watches = sp ? Boolean(sp.oncall?.channels?.length) : Boolean(settings.oncall?.channels?.length)
      if (watches) return
      get().setView('workspace')
    }
    const spaceOf = (w: Workspace): string => (w.spaceId && spaces.some((s) => s.id === w.spaceId) ? w.spaceId : '')
    const current = workspaces.find((w) => w.id === selectedId)
    if (current && spaceOf(current) === id) return
    // Build's overview (nothing open) shows the new space's overview; away from Build (Maestro, Notes, Agents) the
    // switch never pulls the person onto a workspace. Either way another space's workspace stops being selected.
    if (get().view !== 'workspace' || !selectedId) {
      if (current) {
        localStorage.removeItem('orchestra.selected')
        set({ selectedId: null })
      }
      return
    }
    const next = workspaces
      .filter((w) => w.status !== 'archived' && spaceOf(w) === id)
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))[0]
    get().select(next?.id ?? null)
  },
  stepSpace: (dir) => {
    const { spaces, workspaces, activeSpaceId, setActiveSpace } = get()
    const ids = spaceOrder(spaces.map((s) => s.id), workspaces.some((w) => w.status !== 'archived' && (!w.spaceId || !spaces.some((s) => s.id === w.spaceId))))
    if (ids.length < 2) return
    const i = Math.max(0, ids.indexOf(activeSpaceId))
    setActiveSpace(ids[(i + dir + ids.length) % ids.length])
  },
  workspaces: [],
  settings: { workspacesRoot: '', basePort: 55000, model: 'claude-opus-5', permissionMode: 'default', jira: { connected: false, siteUrl: '', email: '', hasToken: false, defaultJql: '' }, claudeAccounts: [{ id: 'default', name: 'Default', configDir: null }], defaultClaudeAccountId: 'default', agents: [] },
  // Everyone lands on Maestro home (docs/design/README.md, decision 3); the last view is not restored.
  view: 'maestro',
  agents: [],
  setAgents: (agents) => set({ agents }),
  openAgentId: null,
  setOpenAgentId: (openAgentId) => set({ openAgentId }),
  selectedId: localStorage.getItem('orchestra.selected'),
  tab: (readLocal('sinfonie.inspector.tab') as Tab | null) ?? 'changes',
  homeViewId: localStorage.getItem('sinfonie.homeView'),
  setHomeViewId: (homeViewId) => {
    if (homeViewId) localStorage.setItem('sinfonie.homeView', homeViewId)
    else localStorage.removeItem('sinfonie.homeView')
    set({ homeViewId })
  },
  showNewWorkspace: false,
  settingsTarget: null,
  openSettings: (settingsTarget) => set({ settingsTarget }),
  pendingInvite: null,
  setPendingInvite: (pendingInvite) => set({ pendingInvite }),
  closeSettings: () => set({ settingsTarget: null }),
  showArchived: false,
  error: null,
  notice: null,
  notify: (notice) => set({ notice }),
  pendingRemoval: [],
  setPendingRemoval: (id, pending) => set((s) => ({ pendingRemoval: pending ? [...new Set([...s.pendingRemoval, id])] : s.pendingRemoval.filter((x) => x !== id) })),
  branchPrompt: null,
  feedbackDialog: null,
  setFeedbackDialog: (feedbackDialog) => set({ feedbackDialog }),
  assistantOpen: false,
  setAssistantOpen: (assistantOpen) => set({ assistantOpen }),
  maestroSeed: null,
  setMaestroSeed: (maestroSeed) => set({ maestroSeed }),

  onboarding: null,
  setOnboarding: (onboarding) => set({ onboarding }),
  setupStartStep: 0,
  openSetupAt: (setupStartStep) => set({ setupStartStep, onboarding: 'setup' }),
  onboardingDraft: { name: 'Personal', color: tokens.accent, root: '', repos: [], added: new Set() },
  setOnboardingDraft: (patch) => set((s) => ({ onboardingDraft: { ...s.onboardingDraft, ...patch } })),
  load: async () => {
    const d = await api.invoke('store:get')
    get().applyStore(d)
    // First run: nothing signed in, nothing created. Existing installs never see Maestro unasked.
    const fresh = !d.settings.onboarding?.setupDoneAt && d.workspaces.length === 0 && d.repos.length === 0 && !d.settings.claudeAccounts.some((a) => a.loggedIn)
    set({ loaded: true, ...(fresh ? { onboarding: 'setup' as const } : {}) })
    api.on('store:changed', (data) => get().applyStore(data))
    api.invoke('agents:list').then((agents) => set({ agents })).catch(() => undefined)
    api.on('agents:changed', (agents) => set({ agents }))
  },
  applyStore: (d) => {
    const selected = get().selectedId
    const stillThere = d.workspaces.some((w) => w.id === selected)
    set({ spaces: d.spaces, labels: d.labels, repos: d.repos, workspaces: d.workspaces, settings: d.settings, selectedId: stillThere ? selected : null })
  },
  select: (id) => {
    if (id) void import('./chat').then((m) => m.useChat.getState().markSeen(id))
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
    // The side panel keeps its tab from one workspace to the next; the conversation is always beside it.
    set({ selectedId: id, view: 'workspace' })
  },
  setView: (view) => {
    set({ view })
  },
  // Asking for a panel tab also expands the panel, so whoever asked sees it. 'chat' is always on screen already.
  setTab: (tab) => {
    if (tab === 'chat') return
    writeLocal('sinfonie.inspector.tab', tab)
    writeLocal('sinfonie.inspector.open', '1')
    set((s) => ({ tab, inspectorOpen: true, inspectorReveal: s.inspectorReveal + 1 }))
  },
  inspectorReveal: 0,
  inspectorOpen: readLocal('sinfonie.inspector.open') !== '0',
  setInspectorOpen: (inspectorOpen) => {
    writeLocal('sinfonie.inspector.open', inspectorOpen ? '1' : '0')
    set({ inspectorOpen })
  },
  inspectorWidth: clampInspector(Number(readLocal('sinfonie.inspector.width')) || INSPECTOR_DEFAULT),
  setInspectorWidth: (w) => {
    const inspectorWidth = clampInspector(w)
    writeLocal('sinfonie.inspector.width', String(inspectorWidth))
    set({ inspectorWidth })
  },
  newWorkspaceSeed: null,
  setNewWorkspaceSeed: (newWorkspaceSeed) => set({ newWorkspaceSeed }),
  pendingShell: null,
  setPendingShell: (pendingShell) => set({ pendingShell }),
  setShowNewWorkspace: (v, spaceId) => {
    if (spaceId !== undefined) {
      localStorage.setItem('orchestra.lastSpace', spaceId)
      set({ newWorkspaceSpaceId: spaceId })
    }
    set({ showNewWorkspace: v })
  },
  setShowSettings: (v) => set({ settingsTarget: v ? { scope: 'app', page: 'general' } : null }),
  setShowArchived: (v) => set({ showArchived: v }),
  setError: (error) => set({ error }),
  setBranchPrompt: (branchPrompt) => set({ branchPrompt })
}))

/** Dot-bar order: every space, then the ungrouped bucket when it has something (or when there are no spaces at all). */
export function spaceOrder(spaceIds: string[], hasUngrouped: boolean): string[] {
  return spaceIds.length === 0 || hasUngrouped ? [...spaceIds, ''] : spaceIds
}

/**
 * The space Build is showing and what lives in it, derived the same way the sidebar does: the active space when it
 * still exists, else the first one in dot-bar order ('' is the ungrouped bucket). Archived workspaces and ones
 * waiting out an Undo are left out.
 */
export function spaceScope(s: Pick<AppState, 'spaces' | 'workspaces' | 'activeSpaceId' | 'pendingRemoval'>): { ids: string[]; currentId: string; live: Workspace[]; inSpace: Workspace[] } {
  const live = s.workspaces.filter((w) => w.status !== 'archived' && !s.pendingRemoval.includes(w.id))
  const isUngrouped = (w: Workspace): boolean => !w.spaceId || !s.spaces.some((sp) => sp.id === w.spaceId)
  const ids = spaceOrder(
    s.spaces.map((sp) => sp.id),
    live.some(isUngrouped)
  )
  const currentId = ids.includes(s.activeSpaceId) ? s.activeSpaceId : (ids[0] ?? '')
  const inSpace = currentId ? live.filter((w) => w.spaceId === currentId) : live.filter(isUngrouped)
  return { ids, currentId, live, inSpace }
}

export function useSelectedWorkspace(): Workspace | undefined {
  return useApp((s) => s.workspaces.find((w) => w.id === s.selectedId))
}
