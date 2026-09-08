import { create } from 'zustand'
import type { ReviewPr, ReviewRun } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from './app'

const useAppView = (): string => useApp.getState().view

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
  /** Owners the space configured explicitly (whole-org listing); empty means repositories only. */
  owners: string[]
  /** GitHub repositories behind the space's registered repos; these always drive the list. */
  repos: string[]
  spaceId: string | null
  mode: 'requested' | 'all'
  repoFilter: string
  statusFilter: StatusFilter
  sortDir: SortDir
  prs: ReviewPr[]
  runs: Record<string, ReviewRun>
  selectedKey: string | null
  /** PR keys ticked in the list for a bulk action, in the order they were ticked. */
  checked: string[]
  /** Bulk review: PRs waiting for a free slot, and the keys this batch started that are still busy. */
  batchQueue: ReviewPr[]
  batchRunning: string[]
  batchAccountId: string
  /** Runs that finished (review, fix round or iteration) while not on screen; cleared when opened. */
  unseen: Record<string, true>
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
  toggleChecked: (key: string, on?: boolean) => void
  setChecked: (keys: string[]) => void
  clearChecked: () => void
  /** Start (or restart) one review; resolves as soon as the main process accepted it. */
  startReview: (pr: ReviewPr, accountId: string) => Promise<ReviewRun>
  /** Queue reviews for every PR that is not already busy; at most MAX_BATCH_CONCURRENCY run at once. */
  startBatch: (prs: ReviewPr[], accountId: string) => void
  pumpBatch: () => void
  markSeen: (key: string) => void
  subscribe: () => void
}

/** Bulk reviews in flight at the same time, counting reviews started by hand. */
export const MAX_BATCH_CONCURRENCY = 3

/** Busy means a review pass, a fix round or an iteration is in flight. */
export const isRunBusy = (r?: ReviewRun): boolean => Boolean(r && (r.status === 'preparing' || r.status === 'running' || r.status === 'fixing' || r.iteration?.status === 'running'))

export const keyOf = (pr: ReviewPr): string => `${pr.nameWithOwner}#${pr.number}`

export const useReviews = create<ReviewsState>((set, get) => ({
  orgs: [],
  owners: [],
  repos: [],
  spaceId: null,
  // "All open" by default: "waiting on me" hides every PR you were not explicitly requested on, which reads as
  // empty repositories. The v2 flag migrates installs that still carry the old default.
  mode: (() => {
    if (!localStorage.getItem('orchestra.reviews.modeV2')) {
      localStorage.setItem('orchestra.reviews.modeV2', '1')
      localStorage.setItem('orchestra.reviews.mode', 'all')
    }
    return (localStorage.getItem('orchestra.reviews.mode') as 'requested' | 'all') ?? 'all'
  })(),
  repoFilter: localStorage.getItem('orchestra.reviews.repo') ?? '',
  statusFilter: (localStorage.getItem('orchestra.reviews.status') as StatusFilter) ?? 'all',
  sortDir: (localStorage.getItem('orchestra.reviews.sort') as SortDir) ?? 'desc',
  prs: [],
  runs: {},
  selectedKey: null,
  checked: [],
  batchQueue: [],
  batchRunning: [],
  batchAccountId: '',
  unseen: {},
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
    let repos: string[] = []
    try {
      repos = await api.invoke('reviews:detectRepos', spaceId)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
    // Repositories of the space always count. Configured owners widen the list to whole orgs; a space
    // with neither falls back to everything the user can see.
    let owners = configured?.length ? configured : []
    if (repos.length === 0 && owners.length === 0) {
      try {
        owners = await api.invoke('reviews:detectOwners', spaceId)
      } catch {
        /* handled above */
      }
      if (owners.length === 0) owners = get().orgs
    }
    set({ owners, repos, prs: [], checked: [] })
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
    const { owners, repos, mode } = get()
    if (owners.length === 0 && repos.length === 0) return
    set({ loadingPrs: true, error: undefined })
    try {
      const prs = await api.invoke('reviews:list', owners, mode, repos)
      set((s) => {
        // Ticked PRs that left the list (merged, closed) drop out of the selection.
        const present = new Set(prs.map(keyOf))
        const checked = s.checked.filter((k) => present.has(k))
        return { prs, loadingPrs: false, checked: checked.length === s.checked.length ? s.checked : checked }
      })
    } catch (err) {
      set({ loadingPrs: false, error: err instanceof Error ? err.message : String(err) })
    }
  },
  select: (selectedKey) =>
    set((s) => {
      if (!selectedKey || !s.unseen[selectedKey]) return { selectedKey }
      const unseen = { ...s.unseen }
      delete unseen[selectedKey]
      return { selectedKey, unseen }
    }),
  toggleChecked: (key, on) =>
    set((s) => {
      const has = s.checked.includes(key)
      const want = on ?? !has
      if (want === has) return {}
      return { checked: want ? [...s.checked, key] : s.checked.filter((k) => k !== key) }
    }),
  setChecked: (keys) => set({ checked: Array.from(new Set(keys)) }),
  clearChecked: () => set((s) => (s.checked.length ? { checked: [] } : {})),
  startReview: async (pr, accountId) => {
    const run = await api.invoke('reviews:start', pr, accountId)
    // The 'review:changed' event usually lands first; never overwrite a run that already moved on.
    set((s) => (isRunBusy(s.runs[run.key]) ? {} : { runs: { ...s.runs, [run.key]: run } }))
    return run
  },
  startBatch: (prs, accountId) => {
    set((s) => {
      const queued = new Set([...s.batchQueue.map(keyOf), ...s.batchRunning])
      const fresh = prs.filter((p) => {
        const k = keyOf(p)
        if (queued.has(k) || isRunBusy(s.runs[k])) return false
        queued.add(k)
        return true
      })
      return { batchQueue: [...s.batchQueue, ...fresh], batchAccountId: accountId, error: undefined }
    })
    get().pumpBatch()
  },
  pumpBatch: () => {
    const s = get()
    if (s.batchQueue.length === 0) return
    const busy = new Set(s.batchRunning)
    for (const [k, r] of Object.entries(s.runs)) if (isRunBusy(r)) busy.add(k)
    const queue = [...s.batchQueue]
    const running = [...s.batchRunning]
    const starts: ReviewPr[] = []
    while (queue.length > 0 && busy.size < MAX_BATCH_CONCURRENCY) {
      const pr = queue.shift()!
      const k = keyOf(pr)
      if (busy.has(k)) continue
      busy.add(k)
      running.push(k)
      starts.push(pr)
    }
    if (starts.length === 0 && queue.length === s.batchQueue.length) return
    set({ batchQueue: queue, batchRunning: running })
    for (const pr of starts) {
      void s.startReview(pr, s.batchAccountId).catch((err) => {
        set((st) => ({ batchRunning: st.batchRunning.filter((k) => k !== keyOf(pr)), error: err instanceof Error ? err.message : String(err) }))
        get().pumpBatch()
      })
    }
  },
  markSeen: (key) =>
    set((s) => {
      if (!s.unseen[key]) return {}
      const unseen = { ...s.unseen }
      delete unseen[key]
      return { unseen }
    }),
  subscribe: () => {
    if (subscribed) return
    subscribed = true
    api.on('review:changed', (run) => {
      let freed = false
      set((s) => {
        const prev = s.runs[run.key]
        const finished = isRunBusy(prev) && !isRunBusy(run)
        const inBatch = s.batchRunning.includes(run.key) && !isRunBusy(run)
        freed = finished || inBatch
        // Finished while the user was elsewhere: flag it until they open it.
        const onScreen = useAppView() === 'reviews' && s.selectedKey === run.key && document.hasFocus()
        return {
          runs: { ...s.runs, [run.key]: run },
          ...(inBatch ? { batchRunning: s.batchRunning.filter((k) => k !== run.key) } : {}),
          ...(finished && !onScreen ? { unseen: { ...s.unseen, [run.key]: true as const } } : {})
        }
      })
      // A slot opened up (this batch's or a manual review's): start the next queued PR.
      if (freed) get().pumpBatch()
    })
  }
}))
