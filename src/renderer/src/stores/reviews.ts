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
  owner: string
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
  setOwner: (o: string) => void
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
  owner: localStorage.getItem('orchestra.reviews.owner') ?? '',
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
      const owner = get().owner && orgs.includes(get().owner) ? get().owner : orgs[0] ?? ''
      set({ orgs, owner, runs: Object.fromEntries(runs.map((r) => [r.key, r])), loadingOrgs: false })
      await get().refreshPrs()
    } catch (err) {
      set({ loadingOrgs: false, error: err instanceof Error ? err.message : String(err) })
    }
  },
  setOwner: (owner) => {
    localStorage.setItem('orchestra.reviews.owner', owner)
    set({ owner })
    void get().refreshPrs()
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
    const { owner, mode } = get()
    if (!owner) return
    set({ loadingPrs: true, error: undefined })
    try {
      const prs = await api.invoke('reviews:list', owner, mode)
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
