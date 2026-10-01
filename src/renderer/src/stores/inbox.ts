/**
 * The review inbox (redesign phase 5): pull requests, builder hand-offs and incidents in one list, sorted by what
 * waits on the person. PR data comes from the reviews store, incidents from the on-call store; this store adds
 * pre-reads, "changes requested" / "approved" marks, the "requested of me" set, teammates' hand-offs, draft
 * notes and the selection.
 */
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { Incident, ReviewPr, ReviewRun, TeammateWorkspace, Workspace } from '@shared/types'
import type { InboxMark, PreRead } from '@shared/inbox'
import { api } from '@/lib/api'
import { isGuided } from '@/lib/guided'
import { useApp } from './app'
import { useReviews, keyOf, setInboxSelection } from './reviews'
import { useOnCall, subscribeOnCall } from './oncall'
import { useGithub } from './github'

export type InboxFilter = 'all' | 'reviews' | 'incidents' | 'mine'

/** Why GitHub did not answer, by what fixes it: install/connect GitHub, sign in again, the network, or waiting. */
export type GitHubProblem = { kind: 'gh-missing' | 'auth' | 'network' | 'rate' | 'other'; text: string; detail: string }
export function classifyGitHubError(detail: string): GitHubProblem {
  if (/gh-missing|ENOENT|command not found|not installed/i.test(detail)) return { kind: 'gh-missing', text: 'GitHub is not connected on this Mac yet, so no pull requests are listed.', detail }
  if (/rate limit|secondary rate|abuse detection|HTTP 429/i.test(detail)) return { kind: 'rate', text: 'GitHub is limiting how often Sinfonie can ask. Pull requests show again in a few minutes.', detail }
  if (/gh auth login|not logged in|authentication|HTTP 401|Bad credentials|token.*(expired|invalid)|re-authenticate/i.test(detail)) return { kind: 'auth', text: 'The GitHub sign-in on this Mac has expired, so no pull requests are listed.', detail }
  if (/timed out|could not resolve|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|connection|dial tcp|i\/o timeout|HTTP 5\d\d/i.test(detail)) return { kind: 'network', text: 'Sinfonie could not reach GitHub, so no pull requests are listed. Check your connection.', detail }
  return { kind: 'other', text: 'GitHub did not answer, so no pull requests are listed.', detail }
}

export interface ChangeItem {
  kind: 'change'
  key: string
  title: string
  pr?: ReviewPr
  /** The local workspace this change lives in: a hand-off on this Mac, or a PR on one of its branches. */
  ws?: Workspace
  teammate?: TeammateWorkspace
  handoff: boolean
  requested: boolean
  mark?: InboxMark
  /** New commits since the reviewer's note or approval. */
  updatedAfterNote: boolean
  /** An AI review finished while the person was elsewhere. */
  unseen: boolean
  waiting: boolean
  at: string
}
interface IncidentItem {
  kind: 'incident'
  key: string
  title: string
  inc: Incident
  waiting: boolean
  at: string
}
export type InboxItem = ChangeItem | IncidentItem

type PreState = PreRead | { error: string } | 'loading'

interface InboxState {
  prereads: Record<string, PreState>
  marks: Record<string, InboxMark>
  /** PR keys where the person's review was requested; null until known. */
  requested: Set<string> | null
  teammates: TeammateWorkspace[]
  /** Local repository id to its origin's "owner/name", to match PRs by repository. */
  remotes: Record<string, string>
  filter: InboxFilter
  /** A filter chosen by a link (notification, Maestro, ⌘K); not remembered, cleared when the person picks one. */
  override: InboxFilter | null
  selectedKey: string | null
  /** Unsent notes, per item, so a refresh or switching items never loses them. */
  drafts: Record<string, string>
  /** A problem with the inbox itself (GitHub not reachable), classified so the banner can offer the fitting action. */
  error: GitHubProblem | null
  /** Parts that failed to load on the last boot (marks, teammates, …); the inbox still works without them. */
  partial: string[]
  setFilter: (f: InboxFilter) => void
  select: (key: string | null) => void
  setDraft: (key: string, text: string) => void
  /** Load everything the inbox needs for the active space. `force` re-lists; `hard` also re-reads every pre-read. */
  boot: (force?: boolean, hard?: boolean) => Promise<void>
  preread: (pr: ReviewPr, force?: boolean) => void
  prereadWorkspace: (workspaceId: string, force?: boolean) => void
  setMark: (key: string, mark: InboxMark | null) => Promise<void>
}

const OPEN = new Set(['new', 'triaging', 'open', 'waiting'])
/** Missing severity ranks with high: an untriaged incident is not assumed to be minor. */
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, '': 1, medium: 2, low: 3 }
/** Timestamps from GitHub and from this Mac differ in precision and by seconds; never compare them closer than this. */
const GRACE_MS = 5 * 60_000

let orgsLoaded: Promise<void> | null = null
let bootedFor: string | null = null
let bootedOwners = ''
let bootedAt = 0

// Pre-reads: at most three calls at once; when each was last asked, to know when to ask again.
const queue: (() => Promise<void>)[] = []
const inflight = new Set<string>()
const askedAt = new Map<string, number>()
let staleBefore = 0
let active = 0
function pump(): void {
  while (active < 3 && queue.length) {
    const job = queue.shift()!
    active++
    void job().finally(() => {
      active--
      pump()
    })
  }
}
function needsAsk(k: string, cur: PreState | undefined, updatedAt?: string, run?: ReviewRun): boolean {
  if (inflight.has(k)) return false
  if (!cur) return true
  const at = askedAt.get(k) ?? 0
  if (at < staleBefore) return true
  if (cur === 'loading' || 'error' in cur) return false
  if (updatedAt && Date.parse(updatedAt) > at) return true
  if (cur.checks.pending > 0 && Date.now() - at > 120_000) return true
  if (run?.finishedAt && Date.parse(run.finishedAt) > at) return true
  return false
}

export const useInbox = create<InboxState>((set, get) => ({
  prereads: {},
  marks: {},
  requested: null,
  teammates: [],
  remotes: {},
  filter: (localStorage.getItem('sinfonie.inbox.filter') as InboxFilter) || 'all',
  override: null,
  selectedKey: null,
  drafts: {},
  error: null,
  partial: [],
  setFilter: (filter) => {
    localStorage.setItem('sinfonie.inbox.filter', filter)
    set({ filter, override: null })
  },
  select: (selectedKey) => {
    set({ selectedKey })
    if (selectedKey) useReviews.getState().markSeen(selectedKey)
  },
  setDraft: (key, text) =>
    set((s) => {
      const drafts = { ...s.drafts }
      if (text) drafts[key] = text
      else delete drafts[key]
      return { drafts }
    }),
  boot: async (force, hard) => {
    subscribeOnCall()
    const app = useApp.getState()
    const spaceId = app.activeSpaceId
    const space = app.spaces.find((s) => s.id === spaceId)
    const ownersKey = (space?.githubOwners ?? []).join(',')
    const spaceChanged = bootedFor !== spaceId || bootedOwners !== ownersKey
    if (!force && !spaceChanged && Date.now() - bootedAt < 5 * 60_000) return
    bootedFor = spaceId
    bootedOwners = ownersKey
    bootedAt = Date.now()
    if (hard) staleBefore = Date.now()
    if (spaceChanged) set({ requested: null, teammates: [] })
    // Side loads never block the list; what fails is collected into one quiet "partly loaded" note with Retry.
    const failed = new Set<string>()
    const note = (what: string) => (): void => {
      failed.add(what)
      set({ partial: [...failed] })
    }
    set({ partial: [] })
    void api.invoke('inbox:marks').then((marks) => set({ marks })).catch(note('your notes and approvals'))
    void api.invoke('inbox:repoRemotes').then((remotes) => set({ remotes })).catch(note('which repositories are on this Mac'))
    // The PR list comes from the reviews store. A failed first `gh` call is retried on the next boot.
    if (!orgsLoaded || hard) orgsLoaded = useReviews.getState().init()
    await orgsLoaded
    if (useReviews.getState().orgs.length === 0) {
      orgsLoaded = null
      set({ error: classifyGitHubError(useReviews.getState().initError ?? useReviews.getState().error ?? '') })
    } else set({ error: null })
    // A new space re-points the list (and clears it); the same space only re-lists, keeping selection and ticks.
    if (spaceChanged || useReviews.getState().spaceId !== spaceId) await useReviews.getState().useSpace(spaceId, space?.githubOwners)
    else await useReviews.getState().refreshPrs()
    const { owners, repos, mode } = useReviews.getState()
    // "Waiting on me" needs the requested list even when the cockpit shows every open PR.
    if (mode === 'requested') set({ requested: new Set(useReviews.getState().prs.map(keyOf)) })
    else if (owners.length || repos.length) {
      api
        .invoke('reviews:list', owners, 'requested', repos)
        .then((prs) => set({ requested: new Set(prs.map(keyOf)) }))
        .catch(note('which reviews are requested of you'))
    }
    // Local hand-offs: their PR status tells which listed PR they are.
    for (const w of useApp.getState().workspaces) if (w.stage === 'in-review' && w.status === 'ready') void useGithub.getState().refresh(w.id)
    if (space?.orgSpace) {
      api
        .invoke('orgSpaces:teammates', spaceId)
        .then((teammates) => set({ teammates }))
        .catch(note('teammates’ hand-offs'))
    }
  },
  preread: (pr, force) => {
    const k = keyOf(pr)
    const cur = get().prereads[k]
    if (!force && !needsAsk(k, cur, pr.updatedAt, useReviews.getState().runs[k])) return
    if (inflight.has(k)) return
    inflight.add(k)
    // Keep showing the previous pre-read while a newer one loads.
    if (!isPreRead(cur)) set((s) => ({ prereads: { ...s.prereads, [k]: 'loading' } }))
    // What the person is looking at (or asked for again) goes first, so Approve never waits behind the whole list.
    queue[force || get().selectedKey === k ? 'unshift' : 'push'](async () => {
      try {
        const pre = await api.invoke('inbox:preread', pr, force)
        set((s) => ({ prereads: { ...s.prereads, [k]: pre } }))
      } catch (err) {
        set((s) => ({ prereads: { ...s.prereads, [k]: { error: err instanceof Error ? err.message : String(err) } } }))
      } finally {
        askedAt.set(k, Date.now())
        inflight.delete(k)
      }
    })
    pump()
  },
  prereadWorkspace: (id, force) => {
    const k = `ws:${id}`
    const cur = get().prereads[k]
    const stale = !cur || (askedAt.get(k) ?? 0) < Math.max(staleBefore, Date.now() - 120_000)
    if ((!force && !stale) || inflight.has(k)) return
    inflight.add(k)
    if (!isPreRead(cur)) set((s) => ({ prereads: { ...s.prereads, [k]: 'loading' } }))
    queue[force || get().selectedKey === k ? 'unshift' : 'push'](async () => {
      try {
        const pre = await api.invoke('inbox:prereadWorkspace', id, force)
        set((s) => ({ prereads: { ...s.prereads, [k]: pre } }))
      } catch (err) {
        set((s) => ({ prereads: { ...s.prereads, [k]: { error: err instanceof Error ? err.message : String(err) } } }))
      } finally {
        askedAt.set(k, Date.now())
        inflight.delete(k)
      }
    })
    pump()
  },
  setMark: async (key, mark) => {
    const marks = await api.invoke('inbox:mark', key, mark)
    set({ marks })
  }
}))

// A review finishing on the item the inbox shows is not "unseen".
setInboxSelection(() => useInbox.getState().selectedKey)

// Arriving at "On call" from anywhere (⌘K, a link, Maestro) shows incidents, without changing the saved filter.
let opening = false
useApp.subscribe((s, prev) => {
  if (opening || s.view === prev.view) return
  if (s.view === 'oncall') useInbox.setState({ override: 'incidents' })
  // Coming back to Review from elsewhere (the rail) shows the saved filter again.
  else if (s.view === 'reviews' && prev.view !== 'oncall') useInbox.setState({ override: null })
})

/**
 * Open the inbox on one item (a PR key, "ws:<id>" or "inc:<id>") or a filter: for notifications, Maestro rows and
 * saved views. The item always shows, whatever filter was saved. Guided people have no Review: a hand-off of theirs
 * opens as the task, anything else lands on Maestro with a plain note.
 */
export function openInbox(opts: { key?: string; filter?: InboxFilter }): void {
  const app = useApp.getState()
  if (isGuided()) {
    if (opts.key?.startsWith('ws:')) return app.select(opts.key.slice(3))
    app.setView('maestro')
    app.notify({ kind: 'info', text: 'Reviews and incidents are handled by your team. Ask Maestro if you want to know where something stands.' })
    return
  }
  opening = true
  app.setView(opts.key?.startsWith('inc:') || opts.filter === 'incidents' ? 'oncall' : 'reviews')
  opening = false
  useInbox.setState({ override: opts.filter ?? (opts.key ? 'all' : null) })
  if (opts.key) useInbox.getState().select(opts.key)
}

export const isPreRead = (p: PreState | undefined): p is PreRead => Boolean(p && p !== 'loading' && !('error' in p))

/** Moved on since the reviewer acted: a different head commit, or (for marks without one) updated well after. */
function movedSince(headNow: string | undefined, headThen: string | undefined, updatedAt: string, actedAt: string | undefined): boolean {
  if (headThen) return Boolean(headNow && headNow !== headThen)
  if (!actedAt) return false
  return Date.parse(updatedAt) > Date.parse(actedAt) + GRACE_MS
}

const NO_INCIDENTS: Incident[] = []

/**
 * Every inbox item for the active space, sorted: incidents first (untriaged or needing a person, then by
 * severity), then what waits on you (waiting longest first), then the rest (most recent first).
 */
export function useInboxItems(): InboxItem[] {
  const activeSpaceId = useApp((s) => s.activeSpaceId)
  const workspaces = useApp((s) => s.workspaces)
  const repoList = useApp((s) => s.repos)
  const prs = useReviews((s) => s.prs)
  const runs = useReviews((s) => s.runs)
  const unseen = useReviews((s) => s.unseen)
  // reviews:orgs lists the signed-in GitHub login first: your own PRs never wait on you.
  const me = useReviews((s) => s.orgs[0]?.toLowerCase() ?? '')
  const incidents = useOnCall((s) => s.state?.incidents ?? NO_INCIDENTS)
  const prereads = useInbox((s) => s.prereads)
  const marks = useInbox((s) => s.marks)
  const requested = useInbox((s) => s.requested)
  const teammates = useInbox((s) => s.teammates)
  const remotes = useInbox((s) => s.remotes)
  const github = useGithub((s) => s.byWorkspace)
  return useMemo(() => {
    const items: InboxItem[] = []
    for (const inc of incidents) {
      if (inc.spaceId !== activeSpaceId || !OPEN.has(inc.status)) continue
      const waiting = inc.status === 'new' || !inc.severity || Boolean(inc.report?.needsHuman) || inc.proposals.some((p) => p.status === 'proposed')
      items.push({ kind: 'incident', key: `inc:${inc.id}`, title: inc.title, inc, waiting, at: inc.updatedAt })
    }
    const local = workspaces.filter((w) => w.status !== 'archived' && (w.spaceId ?? '') === activeSpaceId)
    const handoffs = local.filter((w) => w.status === 'ready' && w.stage === 'in-review')
    const spaceRepos = repoList.filter((r) => (r.spaceId ?? '') === activeSpaceId)
    // Which local workspace a PR belongs to: its GitHub status (hand-offs), or the PR branch in the same repository.
    const wsOfPr = (pr: ReviewPr): Workspace | undefined => {
      const byUrl = handoffs.find((w) => github[w.id]?.repos.some((r) => r.pr?.url === pr.url))
      if (byUrl) return byUrl
      const pre = prereads[keyOf(pr)]
      if (!isPreRead(pre) || !pre.headRefName) return undefined
      const target = pr.nameWithOwner.toLowerCase()
      return local.find((w) => w.repos.some((r) => r.branch === pre.headRefName && remotes[r.repoId] === target))
    }
    // A teammate's workspace names its repositories by name; the local repository of that name gives the owner.
    const teammateOf = (pr: ReviewPr): TeammateWorkspace | undefined => {
      const pre = prereads[keyOf(pr)]
      if (!isPreRead(pre) || !pre.headRefName) return undefined
      const target = pr.nameWithOwner.toLowerCase()
      return teammates.find((t) => t.stage === 'in-review' && t.repos.some((r) => r.branch === pre.headRefName && spaceRepos.some((lr) => lr.name === r.name && remotes[lr.id] === target)))
    }
    const claimed = new Set<string>()
    for (const pr of prs) {
      const key = keyOf(pr)
      const pre = prereads[key]
      const headNow = isPreRead(pre) ? pre.headSha : undefined
      const ws = wsOfPr(pr)
      const teammate = ws ? undefined : teammateOf(pr)
      if (ws) claimed.add(ws.id)
      const handoff = Boolean((ws && ws.stage === 'in-review') || teammate)
      const mark = marks[key]
      const updatedAfterNote = Boolean(mark && movedSince(headNow, mark.headSha, pr.updatedAt, mark.at))
      const run = runs[key]
      const submitted = run?.status === 'submitted' && !movedSince(headNow, run.submittedHead, pr.updatedAt, run.submittedAt ?? run.finishedAt)
      const isRequested = Boolean(requested?.has(key))
      const mine = Boolean(me) && pr.author.toLowerCase() === me
      const waiting = !mine && !pr.isDraft && !submitted && (!mark || updatedAfterNote) && (isRequested || handoff)
      items.push({ kind: 'change', key, title: pr.title, pr, ws, teammate, handoff, requested: isRequested, mark, updatedAfterNote, unseen: Boolean(unseen[key]), waiting, at: pr.updatedAt })
    }
    // Hand-offs on this Mac whose PR is not in the list (another owner, or no PR yet). They are listed so a note
    // can go back to the agent, but work on this Mac is the person's own, so it does not count as waiting on them.
    for (const w of handoffs) {
      if (claimed.has(w.id)) continue
      const key = `ws:${w.id}`
      const mark = marks[key]
      const pre = prereads[key]
      const at = w.lastMessageAt ?? w.createdAt
      const updatedAfterNote = Boolean(mark?.headSha && isPreRead(pre) && pre.headSha && pre.headSha !== mark.headSha)
      items.push({ kind: 'change', key, title: w.name, ws: w, handoff: true, requested: false, mark, updatedAfterNote, unseen: false, waiting: false, at })
    }
    const rank = (i: InboxItem): number => (i.kind === 'incident' ? 0 : i.waiting ? 1 : 2)
    const urgent = (i: Incident): number => (!i.severity || i.status === 'new' || i.report?.needsHuman ? 0 : 1)
    return items.sort((a, b) => {
      const r = rank(a) - rank(b)
      if (r) return r
      if (a.kind === 'incident' && b.kind === 'incident') {
        const u = urgent(a.inc) - urgent(b.inc)
        if (u) return u
        const s = (SEV_RANK[a.inc.severity ?? ''] ?? 1) - (SEV_RANK[b.inc.severity ?? ''] ?? 1)
        return s || Date.parse(b.at) - Date.parse(a.at)
      }
      // Waiting on you: the one waiting longest first. The rest: most recently updated first.
      return rank(a) === 1 ? Date.parse(a.at) - Date.parse(b.at) : Date.parse(b.at) - Date.parse(a.at)
    })
  }, [incidents, activeSpaceId, workspaces, repoList, prs, runs, unseen, me, prereads, marks, requested, teammates, remotes, github])
}

export function matchesFilter(i: InboxItem, f: InboxFilter): boolean {
  if (f === 'reviews') return i.kind === 'change'
  if (f === 'incidents') return i.kind === 'incident'
  if (f === 'mine') return i.waiting
  return true
}

/** The rail badge: what waits on the person, plus AI reviews that finished while they were away. */
function useInboxWaitingCount(): number {
  const items = useInboxItems()
  return items.filter((i) => i.waiting || (i.kind === 'change' && i.unseen)).length
}

/** The rail badge, loading the inbox in the background (and every five minutes) when the person sees Review. */
export function useInboxBadge(enabled: boolean): number {
  const activeSpaceId = useApp((s) => s.activeSpaceId)
  useEffect(() => {
    if (!enabled) return
    void useInbox.getState().boot().catch(() => undefined)
    const t = setInterval(() => void useInbox.getState().boot(true).catch(() => undefined), 5 * 60_000)
    return () => clearInterval(t)
  }, [enabled, activeSpaceId])
  const n = useInboxWaitingCount()
  return enabled ? n : 0
}
