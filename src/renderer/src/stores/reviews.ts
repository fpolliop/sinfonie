import { create } from 'zustand'
import type { ReviewPr, ReviewRun } from '@shared/types'
import { api } from '@/lib/api'

let subscribed = false

export type StatusFilter = 'all' | 'ready' | 'draft' | 'unreviewed' | 'running' | 'reviewed' | 'submitted' | 'failed'
export type SortDir = 'desc' | 'asc'

export const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All statuses' },
  { id: 'ready', label: 'Ready for review' },
  { id: 'draft', label: 'Draft' },
  { id: 'unreviewed', label: 'No AI review yet' },
  { id: 'running', label: 'AI review running' },
  { id: 'reviewed', label: 'AI reviewed, not submitted' },
  { id: 'submitted', label: 'Review submitted' },
  { id: 'failed', label: 'AI review failed' }
]

interface ReviewsState {
  orgs: string[]
  /** Owners currently listed, and the space they came from. */
  owners: string[]
  spaceId: string | null
  mode: 'requested' | 'all'
  repoFilter: string
  statusFilter: StatusFilter
  sortDir: SortDir
  prs: ReviewPr[]
  runs: Record<string, ReviewRun>
  selectedKey: string | null
  loadingOrgs: boolean
  loadingPrs: boolean
  error?: string
  init: () => Promise<void>
  /** Point the cockpit at a space: owners come from its settings or its repos. */
  useSpace: (spaceId: string, configured: string[] | undefined) => Promise<void>
  setMode: (m: 'requested' | 'all') => void
  setRepoFilter: (r: string) => void
  setStatusFilter: (s: StatusFilter) => void
  setSortDir: (d: SortDir) => void
  refreshPrs: () => Promise<void>
  select: (key: string | null) => void
  subscribe: () => void
}

export const keyOf = (pr: ReviewPr): string => `${pr.nameWithOwner}#${pr.number}`

export const useReviews = create<ReviewsState>((set, get) => ({
  orgs: [],
  owners: [],
  spaceId: null,
  mode: (localStorage.getItem('orchestra.reviews.mode') as 'requested' | 'all') ?? 'requested',
  repoFilter: localStorage.getItem('orchestra.reviews.repo') ?? '',
  statusFilter: (localStorage.getItem('orchestra.reviews.status') as StatusFilter) ?? 'all',
  sortDir: (localStorage.getItem('orchestra.reviews.sort') as SortDir) ?? 'desc',
  prs: [],
  runs: {},
  selectedKey: null,
  loadingOrgs: false,
  loadingPrs: false,

  init: async () => {
    get().subscribe()
    set({ loadingOrgs: true, error: undefined })
    try {
      const [orgs, runs] = await Promise.all([api.invoke('reviews:orgs'), api.invoke('reviews:runs')])
      set({ orgs, runs: Object.fromEntries(runs.map((r) => [r.key, r])), loadingOrgs: false })
    } catch (err) {
      set({ loadingOrgs: false, error: err instanceof Error ? err.message : String(err) })
    }
  },
  useSpace: async (spaceId, configured) => {
    set({ spaceId, error: undefined })
    let owners = configured?.length ? configured : []
    if (owners.length === 0) {
      try {
        owners = await api.invoke('reviews:detectOwners', spaceId)
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    }
    // A space with no repos and nothing configured: fall back to everything the user can see.
    if (owners.length === 0) owners = get().orgs
    set({ owners, prs: [] })
    await get().refreshPrs()
  },
  setMode: (mode) => {
    localStorage.setItem('orchestra.reviews.mode', mode)
    set({ mode })
    void get().refreshPrs()
  },
  setRepoFilter: (repoFilter) => {
    localStorage.setItem('orchestra.reviews.repo', repoFilter)
    set({ repoFilter })
  },
  setStatusFilter: (statusFilter) => {
    localStorage.setItem('orchestra.reviews.status', statusFilter)
    set({ statusFilter })
  },
  setSortDir: (sortDir) => {
    localStorage.setItem('orchestra.reviews.sort', sortDir)
    set({ sortDir })
  },
  refreshPrs: async () => {
    const { owners, mode } = get()
    if (owners.length === 0) return
    set({ loadingPrs: true, error: undefined })
    try {
      const prs = await api.invoke('reviews:list', owners, mode)
      set({ prs, loadingPrs: false })
    } catch (err) {
      set({ loadingPrs: false, error: err instanceof Error ? err.message : String(err) })
    }
  },
  select: (selectedKey) => set({ selectedKey }),
  subscribe: () => {
    if (subscribed) return
    subscribed = true
    api.on('review:changed', (run) => set((s) => ({ runs: { ...s.runs, [run.key]: run } })))
  }
}))
