import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  StickyNote,
  Sparkles,
  Loader2,
  Plus,
  Bot,
  User,
  LayoutList,
  Columns3,
  Check,
  Trash2,
  X,
  Flag,
  CalendarDays,
  ArrowRightLeft,
  MessageSquareShare,
  Settings2,
  Search,
  ChevronRight,
  SlidersHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Layers,
  Archive,
  ArchiveRestore,
  ArrowUp,
  ArrowDown,
  FolderInput
} from 'lucide-react'
import { api } from '@/lib/api'
import { useApp, spaceScope } from '@/stores/app'
import { useNotes } from '@/stores/notes'
import { useChat } from '@/stores/chat'
import { Markdown } from '@/lib/markdown'
import { Button, Dialog, IconButton, Segmented, Toggle, chipCls, hasOpenDialog, inputCls, useFocusTrap } from './ui'
import { ErrorNote } from './ErrorNote'
import { useGuided, useWords, cap } from '@/lib/guided'
import { yieldsToEditor } from '@/lib/keys'
import { KindChip, KindPicker, NOTE_KINDS, parseNoteInput } from './NotesPanel'
import { isStandingNote, noteStatus, noteStatuses, BUILTIN_NOTE_STATUSES, type Note, type NotePatch, type NotePriority, type NoteStatus, type NoteStatusDef, type NotesFilter, type Space, type Workspace } from '@shared/types'

// ---------- constants and small helpers ----------

const APP = 'app'
const SINCE_OPTIONS: { id: string; label: string; days?: number }[] = [
  { id: 'any', label: 'Any time' },
  { id: 'today', label: 'Today', days: 0 },
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 }
]
const KIND_OPTIONS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'Every kind' },
  { id: 'todo', label: 'Todos' },
  { id: 'note', label: 'Notes' },
  { id: 'standing', label: 'Decisions and rules' },
  { id: 'decision', label: 'Decisions' },
  { id: 'rule', label: 'Rules' }
]
const PRIORITY: { id: NotePriority; label: string; cls: string }[] = [
  { id: 'high', label: 'High', cls: 'bg-danger/15 text-danger' },
  { id: 'medium', label: 'Medium', cls: 'bg-warn/15 text-warn' },
  { id: 'low', label: 'Low', cls: 'bg-panel-2 text-muted' }
]
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }
/** Above this many notes in scope, the list is the default view (until the person picks one). */
const LIST_THRESHOLD = 60
const COLUMN_PAGE = 40
const DONE_PAGE = 20
const LIST_PAGE = 200
const CLEANUP_DAYS = 30
const UNDO_WINDOW_MS = 6500

const LS = {
  scope: 'sinfonie.notes.scope',
  view: 'sinfonie.notes.viewPicked',
  groupBy: 'sinfonie.notes.groupBy',
  sort: 'sinfonie.notes.sort',
  nav: 'sinfonie.notes.navCollapsed',
  expanded: 'sinfonie.notes.navExpanded'
}
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: the choice just isn't remembered */
  }
}

type KindFilter = 'all' | NonNullable<NotesFilter['kind']>
type GroupBy = 'status' | 'owner' | 'priority'
type SortBy = 'updated' | 'created' | 'due' | 'priority'
interface SortState {
  by: SortBy
  /** 1 is the natural order (newest, soonest, highest first); -1 reverses it. */
  dir: 1 | -1
}
interface Filters {
  status: 'open' | 'done' | 'all'
  source: 'all' | Note['source']
  dueSoon: boolean
  high: boolean
  kind: KindFilter
  since: string
  archived: boolean
}
const DEFAULT_FILTERS: Filters = { status: 'open', source: 'all', dueSoon: false, high: false, kind: 'all', since: 'any', archived: false }

/** A note with where it lives and what search and cards need, computed once per note object. */
type Located = Note & { owner: string; key: string; lower: string; title: string; body: string; isDone: boolean }
const located = new WeakMap<Note, Located>()
function locate(n: Note, owner: string): Located {
  const hit = located.get(n)
  if (hit && hit.owner === owner) return hit
  const { title, body } = splitNote(n.text)
  const loc: Located = { ...n, owner, key: `${owner}|${n.id}`, lower: `${n.text}\n${(n.tags ?? []).join(' ')}`.toLowerCase(), title, body, isDone: noteStatus(n) === 'done' }
  located.set(n, loc)
  return loc
}
/** First non-empty line is the title (without a heading or list marker); the rest is the body. */
function splitNote(text: string): { title: string; body: string } {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  const title = (lines[i] ?? '')
    .replace(/^\s*(#{1,6}\s+|[-*]\s+(\[[ xX]?\]\s*)?)/, '')
    .replace(/\*\*/g, '')
    .trim()
  return { title, body: lines.slice(i + 1).join('\n').trim() }
}

type Column = { id: string; label: string; notes: Located[]; drop?: (n: Located) => void; accepts?: (n: Located) => boolean; maestro?: boolean; hint?: string; done?: boolean }
/** Rules first, then decisions, newest first. */
const standingOrder = (a: Located, b: Located): number => (a.kind === b.kind ? b.createdAt.localeCompare(a.createdAt) : a.kind === 'rule' ? -1 : 1)
const isSpace = (o: string): boolean => o.startsWith('space:')
const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dayOffset = (days: number): string => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return ymd(d)
}
const fmtDay = (day: string): string => {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}
function relTime(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}
function dueInfo(n: Located): { label: string; tone: 'danger' | 'warn' | 'muted' } | null {
  if (!n.due) return null
  if (n.isDone) return { label: fmtDay(n.due), tone: 'muted' }
  const today = dayOffset(0)
  if (n.due < today) return { label: `Overdue · ${fmtDay(n.due)}`, tone: 'danger' }
  if (n.due === today) return { label: 'Due today', tone: 'warn' }
  return { label: `Due ${fmtDay(n.due)}`, tone: n.due <= dayOffset(7) ? 'warn' : 'muted' }
}
function sinceMsOf(id: string): number {
  const o = SINCE_OPTIONS.find((x) => x.id === id)
  if (!o || o.days === undefined) return 0
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - o.days)
  return d.getTime()
}
function passes(n: Located, f: Filters, soon: string, sinceMs: number, skipStatus = false): boolean {
  if (!skipStatus && f.status !== 'all' && (f.status === 'open' ? n.isDone : !n.isDone)) return false
  if (f.source !== 'all' && n.source !== f.source) return false
  if (f.dueSoon && !(n.due && !n.isDone && n.due <= soon)) return false
  if (f.high && n.priority !== 'high') return false
  if (f.kind !== 'all' && (f.kind === 'standing' ? !isStandingNote(n) : n.kind !== f.kind)) return false
  if (sinceMs && Date.parse(n.createdAt) < sinceMs) return false
  return true
}
function comparator(sort: SortState): (a: Located, b: Located) => number {
  const d = sort.dir
  return (a, b) => {
    let r = 0
    if (sort.by === 'due') r = (a.due ?? '9999').localeCompare(b.due ?? '9999')
    else if (sort.by === 'priority') r = (PRIORITY_RANK[a.priority ?? ''] ?? 3) - (PRIORITY_RANK[b.priority ?? ''] ?? 3)
    else if (sort.by === 'created') r = b.createdAt.localeCompare(a.createdAt)
    else r = b.updatedAt.localeCompare(a.updatedAt)
    return r * d || b.updatedAt.localeCompare(a.updatedAt)
  }
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const trimTo = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const isTypingTarget = (t: EventTarget | null): boolean => t instanceof HTMLElement && Boolean(t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))

/** A callback whose identity never changes but always runs the latest closure, so memoised rows stay memoised. */
function useStable<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...a: A) => ref.current(...a), [])
}

/** Several removals behind one Undo toast; committed after the window, or at once if the window closes. */
const pendingBulk = new Map<string, () => void>()
let unloadHooked = false
function removeManyWithUndo(items: Located[], text: string, remove: (owner: string, id: string) => Promise<void>): void {
  if (items.length === 0) return
  const app = useApp.getState()
  for (const n of items) app.setPendingRemoval(n.id, true)
  if (!unloadHooked) {
    unloadHooked = true
    window.addEventListener('beforeunload', () => {
      for (const run of [...pendingBulk.values()]) run()
    })
  }
  const token = `${Date.now()}-${Math.random()}`
  let settled = false
  const release = (): void => {
    for (const n of items) useApp.getState().setPendingRemoval(n.id, false)
  }
  const run = (): void => {
    if (settled) return
    settled = true
    pendingBulk.delete(token)
    void (async () => {
      for (const n of items) {
        try {
          await remove(n.owner, n.id)
        } catch (e) {
          useApp.getState().setError(e instanceof Error ? e.message : String(e))
        }
      }
      release()
    })()
  }
  pendingBulk.set(token, run)
  const timer = window.setTimeout(run, UNDO_WINDOW_MS)
  app.notify({
    kind: 'info',
    text,
    undo: () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      pendingBulk.delete(token)
      release()
    }
  })
}

// ---------- the scope navigator's model ----------

interface Where {
  name: string
  color?: string
  /** The space a workspace belongs to, for labels that need both. */
  spaceName?: string
}
interface NavWs {
  key: string
  name: string
  open: number
  total: number
  last: string
}
interface NavSpace {
  key: string
  id: string
  name: string
  color?: string
  open: number
  total: number
  own: NavWs | null
  live: NavWs[]
  archivedKey: string
  archived: NavWs[]
}
interface NavTree {
  all: { open: number; total: number }
  app: { open: number; total: number }
  spaces: NavSpace[]
  removed: NavWs[]
  /** Scope key → the owners it covers. Everywhere is absent (it covers every owner). */
  owners: Map<string, string[]>
}
type OwnerStats = Map<string, { open: number; total: number; last: string; firstTitle: string }>

function buildTree(stats: OwnerStats, spaces: Space[], workspaces: Workspace[], names: { noSpace: string; removedSpace: string }): NavTree {
  const wsById = new Map(workspaces.map((w) => [w.id, w]))
  const spaceIds = new Set(spaces.map((s) => s.id))
  const groups = new Map<string, { live: NavWs[]; archived: NavWs[] }>()
  const removed: NavWs[] = []
  const owners = new Map<string, string[]>()
  const all = { open: 0, total: 0 }
  for (const [owner, st] of stats) {
    all.open += st.open
    all.total += st.total
    if (owner === APP || st.total === 0) continue
    const row: NavWs = { key: owner, name: '', open: st.open, total: st.total, last: st.last }
    if (isSpace(owner)) {
      if (!spaceIds.has(owner.slice(6))) removed.push({ ...row, name: names.removedSpace })
      continue
    }
    const ws = wsById.get(owner)
    if (!ws) {
      removed.push({ ...row, name: `“${trimTo(st.firstTitle || 'Untitled', 34)}”` })
      continue
    }
    const sid = ws.spaceId && spaceIds.has(ws.spaceId) ? ws.spaceId : ''
    const g = groups.get(sid) ?? { live: [], archived: [] }
    groups.set(sid, g)
    ;(ws.status === 'archived' ? g.archived : g.live).push({ ...row, name: ws.name })
  }
  const byRecent = (a: NavWs, b: NavWs): number => b.last.localeCompare(a.last)
  const out: NavSpace[] = []
  const add = (id: string, name: string, color: string | undefined): void => {
    const g = groups.get(id) ?? { live: [], archived: [] }
    g.live.sort(byRecent)
    g.archived.sort(byRecent)
    const ownSt = id ? stats.get(`space:${id}`) : undefined
    const own: NavWs | null = ownSt && ownSt.total ? { key: `spaceown:${id}`, name: '', open: ownSt.open, total: ownSt.total, last: ownSt.last } : null
    const key = id ? `space:${id}` : 'nospace'
    const archivedKey = `archived:${id || 'none'}`
    const members = [...g.live, ...g.archived]
    const sum = (k: 'open' | 'total'): number => members.reduce((n, w) => n + w[k], own?.[k] ?? 0)
    out.push({ key, id, name, color, open: sum('open'), total: sum('total'), own, live: g.live, archivedKey, archived: g.archived })
    owners.set(key, [...(id ? [`space:${id}`] : []), ...members.map((w) => w.key)])
    if (id) owners.set(`spaceown:${id}`, [`space:${id}`])
    owners.set(archivedKey, g.archived.map((w) => w.key))
    for (const w of members) owners.set(w.key, [w.key])
  }
  for (const s of spaces) add(s.id, s.name, s.color)
  if (groups.has('')) add('', names.noSpace, undefined)
  removed.sort(byRecent)
  owners.set('removed', removed.map((w) => w.key))
  for (const w of removed) owners.set(w.key, [w.key])
  owners.set(APP, [APP])
  const appSt = stats.get(APP)
  return { all, app: { open: appSt?.open ?? 0, total: appSt?.total ?? 0 }, spaces: out, removed, owners }
}

// ---------- the view ----------

/**
 * Every note, todo, decision and rule in one place. A navigator on the left picks where to look (everywhere, the
 * app, a space, one workspace); search comes first; quick filters narrow it; the board or the list shows it. Open
 * a note for status, priority, due date and moving it elsewhere; select several for bulk changes; ask Claude for
 * a summary of what is shown. Decisions and rules get their own board column in Maestro's colour.
 */
export function NotesView(): React.JSX.Element {
  const byOwner = useNotes((s) => s.byWorkspace)
  const allLoaded = useNotes((s) => s.allLoaded)
  const loadAll = useNotes((s) => s.loadAll)
  const subscribe = useNotes((s) => s.subscribe)
  const add = useNotes((s) => s.add)
  const update = useNotes((s) => s.update)
  const remove = useNotes((s) => s.remove)
  const move = useNotes((s) => s.move)
  const spaces = useApp((s) => s.spaces)
  const workspaces = useApp((s) => s.workspaces)
  const setError = useApp((s) => s.setError)
  const notify = useApp((s) => s.notify)
  const pendingRemoval = useApp((s) => s.pendingRemoval)
  const customStatuses = useApp((s) => s.settings.noteStatuses)
  const guided = useGuided()
  const w = useWords()
  const statuses = useMemo(() => noteStatuses(customStatuses), [customStatuses])

  const appLabel = guided ? 'General' : 'App'
  const archivedWord = 'Archived'
  const removedLabel = `Removed ${w.workspaces}`

  // ----- layout -----
  const rootRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1200)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const narrow = width < 900
  const [navCollapsed, setNavCollapsed] = useState(() => lsGet(LS.nav) === '1')
  const showNav = !narrow && !navCollapsed
  const [scopePop, setScopePop] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = lsGet(LS.expanded)
      if (raw) return new Set(JSON.parse(raw) as string[])
    } catch {
      /* fall through */
    }
    const sid = spaceScope(useApp.getState()).currentId
    return new Set(sid ? [`space:${sid}`] : [])
  })
  const toggleExpanded = useCallback((key: string) => {
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      lsSet(LS.expanded, JSON.stringify([...next]))
      return next
    })
  }, [])

  // ----- state -----
  const [scope, setScopeState] = useState<string>(() => {
    const saved = lsGet(LS.scope)
    if (saved) return saved
    // The space the rail shows (spaceScope), not the raw activeSpaceId, which can be empty while the rail shows one.
    const st = useApp.getState()
    const { currentId, ids } = spaceScope(st)
    if (currentId && st.spaces.some((s) => s.id === currentId)) return `space:${currentId}`
    return ids.includes('') && ids.length > 1 ? 'nospace' : 'all'
  })
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [pickedView, setPickedView] = useState<'list' | 'board' | null>(() => {
    const v = lsGet(LS.view)
    return v === 'list' || v === 'board' ? v : null
  })
  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    const g = lsGet(LS.groupBy)
    return g === 'owner' || g === 'priority' ? g : 'status'
  })
  const [sort, setSort] = useState<SortState>(() => {
    try {
      const s = JSON.parse(lsGet(LS.sort) ?? '') as SortState
      if (['updated', 'created', 'due', 'priority'].includes(s.by) && (s.dir === 1 || s.dir === -1)) return s
    } catch {
      /* default */
    }
    return { by: 'updated', dir: 1 }
  })
  const [composing, setComposing] = useState(false)
  const [text, setText] = useState('')
  const [addKind, setAddKind] = useState<Note['kind']>('todo')
  const [addOwner, setAddOwner] = useState(APP)
  const [summary, setSummary] = useState(false)
  const [statusesDlg, setStatusesDlg] = useState(false)
  const [cleanupDlg, setCleanupDlg] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [cursorKey, setCursorKey] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const anchorRef = useRef<string | null>(null)
  const [doneOpen, setDoneOpen] = useState(false)
  const [limits, setLimits] = useState<Record<string, number>>({})
  const searchRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    subscribe()
    void loadAll().catch((e) => setError(e))
  }, [loadAll, subscribe, setError])
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(queryInput), 100)
    return () => window.clearTimeout(t)
  }, [queryInput])
  const setScope = useCallback((s: string) => {
    setScopeState(s)
    lsSet(LS.scope, s)
    setSelected(new Set())
    setLimits({})
    setScopePop(false)
  }, [])
  const go = (fn: () => Promise<void>): void => {
    fn().catch((e) => setError(e))
  }

  // ----- the index: every note once, with its lowercase text for search -----
  const pending = useMemo(() => new Set(pendingRemoval), [pendingRemoval])
  const index: Located[] = useMemo(() => {
    const out: Located[] = []
    for (const o of Object.keys(byOwner)) for (const n of byOwner[o] ?? []) out.push(locate(n, o))
    return out
  }, [byOwner])
  const byKey = useMemo(() => new Map(index.map((n) => [n.key, n])), [index])
  const live = useMemo(() => index.filter((n) => !pending.has(n.id)), [index, pending])

  // ----- where notes live -----
  const stats: OwnerStats = useMemo(() => {
    const m: OwnerStats = new Map()
    for (const n of live) {
      if (n.archived) continue
      const s = m.get(n.owner) ?? { open: 0, total: 0, last: '', firstTitle: '' }
      s.total += 1
      if (!n.isDone) s.open += 1
      if (n.updatedAt > s.last) {
        s.last = n.updatedAt
        s.firstTitle = n.title
      }
      m.set(n.owner, s)
    }
    return m
  }, [live])
  const tree = useMemo(() => buildTree(stats, spaces, workspaces, { noSpace: `No ${w.space}`, removedSpace: `Removed ${w.space}` }), [stats, spaces, workspaces, w.space])
  const wsById = useMemo(() => new Map(workspaces.map((x) => [x.id, x])), [workspaces])
  const spaceById = useMemo(() => new Map(spaces.map((x) => [x.id, x])), [spaces])
  const whereCache = useMemo(() => new Map<string, Where>(), [wsById, spaceById, appLabel, w])
  const whereOf = useCallback(
    (o: string): Where => {
      const hit = whereCache.get(o)
      if (hit) return hit
      let res: Where
      if (o === APP) res = { name: appLabel }
      else if (isSpace(o)) {
        const sp = spaceById.get(o.slice(6))
        res = sp ? { name: sp.name, color: sp.color } : { name: `Removed ${w.space}` }
      } else {
        const ws = wsById.get(o)
        const sp = ws?.spaceId ? spaceById.get(ws.spaceId) : undefined
        res = ws ? { name: ws.name, color: sp?.color, spaceName: sp?.name } : { name: `Removed ${w.workspace}` }
      }
      whereCache.set(o, res)
      return res
    },
    [whereCache, spaceById, wsById, appLabel, w]
  )
  const labelOf = useCallback((o: string): string => {
    const wh = whereOf(o)
    return wh.spaceName ? `${wh.name} · ${wh.spaceName}` : wh.name
  }, [whereOf])
  const scopeOwners: string[] | null | undefined = useMemo(() => (scope === 'all' ? null : (tree.owners.get(scope) ?? (wsById.has(scope) || (isSpace(scope) && spaceById.has(scope.slice(6))) ? [scope] : undefined))), [scope, tree, wsById, spaceById])
  // A remembered scope that no longer exists (its workspace was removed and its notes are gone) falls back.
  useEffect(() => {
    if (allLoaded && scopeOwners === undefined) setScope('all')
  }, [allLoaded, scopeOwners, setScope])
  const scopeLabel = useMemo(() => {
    if (scope === 'all') return 'Everywhere'
    if (scope === APP) return appLabel
    if (scope === 'removed') return removedLabel
    if (scope === 'nospace') return `No ${w.space}`
    if (scope.startsWith('spaceown:')) return `${spaceById.get(scope.slice(9))?.name ?? ''} · ${cap(w.space)} notes`
    if (scope.startsWith('archived:')) {
      const id = scope.slice(9)
      return `${archivedWord} · ${id === 'none' ? `No ${w.space}` : (spaceById.get(id)?.name ?? '')}`
    }
    return whereOf(scope).name
  }, [scope, appLabel, removedLabel, w.space, spaceById, whereOf])
  const singleOwner = scopeOwners?.length === 1 && !isSpace(scope) && scope !== 'removed' && !scope.startsWith('archived:') && scope !== 'nospace'

  // ----- filtering: scope → search → archived → quick filters -----
  const scoped = useMemo(() => {
    if (!scopeOwners) return live
    const set = new Set(scopeOwners)
    return live.filter((n) => set.has(n.owner))
  }, [live, scopeOwners])
  const search = useMemo(() => searchOf(query), [query])
  const terms = search.terms
  const hl = search.hl
  const searched = useMemo(() => (search.phrase ? scoped.filter((n) => search.matches(n.lower)) : scoped), [scoped, search])
  const base = useMemo(() => (filters.archived ? searched : searched.filter((n) => !n.archived)), [searched, filters.archived])
  const soon = useMemo(() => dayOffset(7), [])
  const sinceMs = sinceMsOf(filters.since)
  const cmp = useMemo(() => comparator(sort), [sort])
  const shown = useMemo(() => {
    const list = base.filter((n) => passes(n, filters, soon, sinceMs))
    // While searching, the best matches lead: the exact phrase, then a title hit, then the chosen order.
    return search.phrase ? list.sort((a, b) => search.score(b) - search.score(a) || cmp(a, b)) : list.sort(cmp)
  }, [base, filters, soon, sinceMs, cmp, search])
  const counts = useMemo(() => {
    const c = { open: 0, done: 0, all: 0, mine: 0, agents: 0, dueSoon: 0, high: 0, standing: 0 }
    const f = filters
    for (const n of base) {
      if (passes(n, f, soon, sinceMs, true)) {
        c.all += 1
        if (n.isDone) c.done += 1
        else c.open += 1
      }
      if (passes(n, { ...f, source: 'user' }, soon, sinceMs)) c.mine += 1
      if (passes(n, { ...f, source: 'agent' }, soon, sinceMs)) c.agents += 1
      if (passes(n, { ...f, dueSoon: true }, soon, sinceMs)) c.dueSoon += 1
      if (passes(n, { ...f, high: true }, soon, sinceMs)) c.high += 1
      if (passes(n, { ...f, kind: 'standing' }, soon, sinceMs)) c.standing += 1
    }
    return c
  }, [base, filters, soon, sinceMs])
  const view: 'list' | 'board' = pickedView ?? (scoped.length > LIST_THRESHOLD ? 'list' : 'board')
  const boardByStatus = view === 'board' && groupBy === 'status'
  // With "Open", the board still has a Done column (collapsed): it holds the done notes the other filters allow.
  const doneExtra = useMemo(() => (boardByStatus && filters.status === 'open' ? base.filter((n) => n.isDone && passes(n, filters, soon, sinceMs, true)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : []), [boardByStatus, base, filters, soon, sinceMs])
  const cleanupCandidates = useMemo(() => {
    const cutoff = new Date(Date.now() - CLEANUP_DAYS * 86400_000).toISOString()
    return scoped.filter((n) => n.isDone && !n.archived && !isStandingNote(n) && n.updatedAt < cutoff)
  }, [scoped])
  const openTotal = tree.all.open

  const filtersActive = filters.status !== 'open' || filters.source !== 'all' || filters.dueSoon || filters.high || filters.kind !== 'all' || filters.since !== 'any' || filters.archived
  const setF = useCallback(<K extends keyof Filters>(k: K, v: Filters[K]) => {
    setFilters((f) => ({ ...f, [k]: v }))
    setLimits({})
  }, [])
  const clearFilters = (): void => setFilters(DEFAULT_FILTERS)
  const clearSearch = (): void => {
    setQueryInput('')
    setQuery('')
  }
  const clearAll = (): void => {
    clearFilters()
    clearSearch()
  }
  const pickView = (v: 'list' | 'board'): void => {
    setPickedView(v)
    lsSet(LS.view, v)
  }
  const pickGroupBy = (g: GroupBy): void => {
    setGroupBy(g)
    lsSet(LS.groupBy, g)
  }
  const onSort = useStable((by: SortBy) => {
    setSort((s) => {
      const next: SortState = s.by === by ? { by, dir: s.dir === 1 ? -1 : 1 } : { by, dir: 1 }
      lsSet(LS.sort, JSON.stringify(next))
      return next
    })
  })

  // ----- board columns -----
  const patch = useStable((n: Located, p: NotePatch) => go(() => update(n.owner, n.id, p)))
  const columns: Column[] = useMemo(() => {
    if (groupBy === 'status') {
      const doneSrc = filters.status === 'open' ? doneExtra : shown.filter((n) => n.isDone && !isStandingNote(n)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      const doneCol: Column = { id: 'done', label: statuses[statuses.length - 1]?.label ?? 'Done', notes: doneSrc, done: true, accepts: (n) => !isStandingNote(n), drop: (n) => patch(n, { status: 'done', ...(n.kind === 'note' ? { kind: 'todo' as const } : {}) }) }
      if (filters.status === 'done') return [doneCol]
      // Decisions and rules have no status: they get their own column, just before Done.
      const byStatus: Column[] = statuses.slice(0, -1).map((s) => ({ id: s.id, label: s.label, notes: shown.filter((n) => !isStandingNote(n) && !n.isDone && (n.kind === 'note' ? s.id === 'todo' : noteStatus(n) === s.id)), accepts: (n) => !isStandingNote(n), drop: (n) => patch(n, { status: s.id, ...(n.kind === 'note' ? { kind: 'todo' as const } : {}) }) }))
      const standing = shown.filter(isStandingNote).sort(standingOrder)
      if (filters.kind === 'standing') return [{ id: 'standing', label: 'Decisions and rules', notes: standing, maestro: true, hint: 'Maestro answers and acts with these.' }]
      if (!standing.length) return [...byStatus, doneCol]
      return [...byStatus, { id: 'standing', label: 'Decisions and rules', notes: standing, maestro: true, hint: 'Maestro answers and acts with these.' }, doneCol]
    }
    if (groupBy === 'priority') {
      return [
        ...PRIORITY.map((p) => ({ id: p.id, label: p.label, notes: shown.filter((n) => n.priority === p.id), accepts: (n: Located) => !isStandingNote(n), drop: (n: Located) => patch(n, { priority: p.id }) })),
        { id: 'none', label: 'No priority', notes: shown.filter((n) => !n.priority), accepts: (n: Located) => !isStandingNote(n), drop: (n: Located) => patch(n, { priority: undefined as unknown as NotePriority }) }
      ]
    }
    const ids = [...new Set(shown.map((n) => n.owner))]
    return ids.map((o) => ({ id: o, label: labelOf(o), notes: shown.filter((n) => n.owner === o), drop: (n: Located) => n.owner !== o && go(() => move(n.owner, n.id, o)) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupBy, shown, doneExtra, filters.status, filters.kind, statuses, labelOf])
  const limitOf = (c: Column): number => limits[c.id] ?? (c.done ? DONE_PAGE : COLUMN_PAGE)
  const doneExpanded = doneOpen || filters.status === 'done'

  // What J/K walk through, in screen order.
  const order: Located[] = useMemo(() => {
    if (view === 'list') return shown.slice(0, limits.list ?? LIST_PAGE)
    return columns.flatMap((c) => (c.done && !doneExpanded ? [] : c.notes.slice(0, limits[c.id] ?? (c.done ? DONE_PAGE : COLUMN_PAGE))))
  }, [view, shown, columns, limits, doneExpanded])
  const opened = openKey ? (byKey.get(openKey) ?? null) : null
  useEffect(() => {
    if (openKey && !byKey.has(openKey)) setOpenKey(null)
  }, [openKey, byKey])

  // ----- selection -----
  const selectedNotes = useMemo(() => (selected.size ? [...selected].map((k) => byKey.get(k)).filter((n): n is Located => Boolean(n) && !pending.has(n!.id)) : []), [selected, byKey, pending])
  const selecting = selectedNotes.length > 0
  const clearSelection = (): void => {
    setSelected(new Set())
    anchorRef.current = null
  }
  const onCheck = useStable((n: Located, shift: boolean) => {
    setSelected((cur) => {
      const next = new Set(cur)
      const anchor = anchorRef.current
      if (shift && anchor && anchor !== n.key) {
        const a = order.findIndex((x) => x.key === anchor)
        const b = order.findIndex((x) => x.key === n.key)
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          for (let i = lo; i <= hi; i++) next.add(order[i].key)
          return next
        }
      }
      if (next.has(n.key)) next.delete(n.key)
      else next.add(n.key)
      anchorRef.current = n.key
      return next
    })
    setCursorKey(n.key)
  })
  const onOpen = useStable((n: Located, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || selecting) {
      onCheck(n, e.shiftKey)
      return
    }
    setCursorKey(n.key)
    setOpenKey((k) => (k === n.key ? null : n.key))
  })
  const onFocusNote = useStable((n: Located) => setCursorKey(n.key))

  // ----- actions -----
  const runAll = async (fns: (() => Promise<void>)[]): Promise<void> => {
    for (const f of fns) {
      try {
        await f()
      } catch (e) {
        setError(e)
      }
    }
  }
  const doneTarget = (n: Located): NotePatch => (n.kind === 'note' ? { kind: 'todo', status: 'done' } : { status: 'done' })
  const toggleDone = (n: Located): void => {
    if (isStandingNote(n)) return
    patch(n, n.isDone ? { status: 'todo' } : doneTarget(n))
  }
  const bulkDone = async (): Promise<void> => {
    const items = selectedNotes.filter((n) => !isStandingNote(n) && !n.isDone)
    if (!items.length) return
    const prev = items.map((n) => ({ owner: n.owner, id: n.id, kind: n.kind, status: noteStatus(n) }))
    await runAll(items.map((n) => () => update(n.owner, n.id, doneTarget(n))))
    clearSelection()
    notify({ kind: 'success', text: `Marked ${plural(items.length, 'note')} done`, undo: () => void runAll(prev.map((p) => () => update(p.owner, p.id, p.kind === 'note' ? { kind: 'note', status: 'todo' } : { status: p.status }))) })
  }
  const bulkPriority = async (priority: NotePriority | undefined): Promise<void> => {
    const items = selectedNotes.filter((n) => !isStandingNote(n))
    if (!items.length) return
    const prev = items.map((n) => ({ owner: n.owner, id: n.id, priority: n.priority }))
    await runAll(items.map((n) => () => update(n.owner, n.id, { priority: priority ?? (undefined as unknown as NotePriority) })))
    notify({ kind: 'success', text: `Priority changed on ${plural(items.length, 'note')}`, undo: () => void runAll(prev.map((p) => () => update(p.owner, p.id, { priority: p.priority ?? (undefined as unknown as NotePriority) }))) })
  }
  const bulkMove = async (to: string): Promise<void> => {
    const items = selectedNotes.filter((n) => n.owner !== to)
    if (!items.length) return
    const prev = items.map((n) => ({ from: n.owner, id: n.id }))
    await runAll(items.map((n) => () => move(n.owner, n.id, to)))
    clearSelection()
    notify({ kind: 'success', text: `Moved ${plural(items.length, 'note')} to ${whereOf(to).name}`, undo: () => void runAll(prev.map((p) => () => move(to, p.id, p.from))) })
  }
  const deleteNotes = (items: Located[]): void => {
    if (!items.length) return
    if (openKey && items.some((n) => n.key === openKey)) setOpenKey(null)
    const one = items.length === 1 ? items[0] : null
    removeManyWithUndo(items, one ? `Deleted “${trimTo(one.title || one.text, 40)}”` : `Deleted ${plural(items.length, 'note')}`, remove)
    clearSelection()
  }
  const archiveNotes = async (items: Located[], on: boolean): Promise<void> => {
    if (!items.length) return
    await runAll(items.map((n) => () => update(n.owner, n.id, { archived: on })))
    notify({ kind: 'success', text: on ? `Archived ${plural(items.length, 'done note')}` : `Restored ${plural(items.length, 'note')}`, undo: () => void runAll(items.map((n) => () => update(n.owner, n.id, { archived: !on }))) })
  }

  // ----- composer -----
  const defaultPlace = (): string => {
    const current = spaceScope(useApp.getState()).currentId
    const fallback = current && spaceById.has(current) ? `space:${current}` : APP
    if (scope === APP) return APP
    if (isSpace(scope)) return spaceById.has(scope.slice(6)) ? scope : fallback
    if (scope.startsWith('spaceown:')) return `space:${scope.slice(9)}`
    if (scope.startsWith('archived:')) {
      const id = scope.slice(9)
      return spaceById.has(id) ? `space:${id}` : fallback
    }
    const ws = wsById.get(scope)
    if (ws) return ws.status !== 'archived' ? ws.id : ws.spaceId && spaceById.has(ws.spaceId) ? `space:${ws.spaceId}` : fallback
    return fallback
  }
  const openComposer = (): void => {
    if (!composing) setAddOwner(defaultPlace())
    setComposing(true)
    requestAnimationFrame(() => composerRef.current?.focus())
  }
  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    const parsed = parseNoteInput(t, addKind)
    if (!parsed.text.trim()) return
    const place = addOwner
    // The text stays in the box until the note is saved, so a failed add loses nothing.
    add(place, parsed.text, parsed.kind)
      .then(() => {
        setText((cur) => (cur.trim() === t ? '' : cur))
        const kindHidden = filters.kind !== 'all' && filters.kind !== parsed.kind && !(filters.kind === 'standing' && (parsed.kind === 'decision' || parsed.kind === 'rule'))
        const hidden = terms.length > 0 || filters.status === 'done' || filters.source === 'agent' || filters.dueSoon || filters.high || kindHidden
        if (hidden) notify({ kind: 'success', text: `Added to ${whereOf(place).name}. Your filters may hide it.`, action: { label: 'Clear filters', run: clearAll } })
      })
      .catch((e) => setError(e))
  }

  // ----- keyboard -----
  const keys = useRef({ order, cursorKey, view, selecting, openKey, shown })
  useLayoutEffect(() => {
    keys.current = { order, cursorKey, view, selecting, openKey, shown }
  })
  const focusNote = (key: string | null): void => {
    if (!key) return
    requestAnimationFrame(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
      el?.focus({ preventScroll: true })
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }
  const onKey = useStable((e: KeyboardEvent) => {
    if (hasOpenDialog() || yieldsToEditor(e)) return
    const k = keys.current
    const mod = e.metaKey || e.ctrlKey
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
      return
    }
    if (isTypingTarget(e.target)) return
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a' && k.view === 'list') {
      e.preventDefault()
      setSelected(new Set(k.shown.map((n) => n.key)))
      return
    }
    if (mod || e.altKey) return
    const idx = k.cursorKey ? k.order.findIndex((n) => n.key === k.cursorKey) : -1
    // Enter, X and E act on the note under the cursor only when focus is on a note (or nowhere), never on a button.
    const onNote = e.target === document.body || (e.target instanceof HTMLElement && e.target.hasAttribute('data-key'))
    const cur = idx >= 0 && onNote ? k.order[idx] : null
    switch (e.key) {
      case 'j':
      case 'k': {
        if (!k.order.length) return
        e.preventDefault()
        const next = e.key === 'j' ? Math.min(k.order.length - 1, idx + 1) : Math.max(0, idx < 0 ? 0 : idx - 1)
        const key = k.order[next].key
        setCursorKey(key)
        focusNote(key)
        if (k.view === 'list' && next >= k.order.length - 5 && k.order.length < k.shown.length) setLimits((l) => ({ ...l, list: (l.list ?? LIST_PAGE) + LIST_PAGE }))
        return
      }
      case 'Enter':
        if (!cur) return
        e.preventDefault()
        setOpenKey(cur.key)
        return
      case 'x':
        if (!cur) return
        e.preventDefault()
        onCheck(cur, e.shiftKey)
        return
      case 'e':
        if (!cur) return
        e.preventDefault()
        toggleDone(cur)
        return
      case 'n':
        e.preventDefault()
        openComposer()
        return
      case '/':
        e.preventDefault()
        searchRef.current?.focus()
        return
      case 'Escape':
        if (k.selecting) {
          clearSelection()
          e.preventDefault()
        } else if (k.openKey) {
          setOpenKey(null)
          e.preventDefault()
        }
        return
    }
  })
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onKey])

  // ----- summary: exactly what is shown -----
  const summaryFilter: NotesFilter = useMemo(() => {
    const list = boardByStatus && filters.status === 'open' && doneExpanded ? [...shown, ...doneExtra] : shown
    return { ...(scopeOwners ? { owners: scopeOwners } : {}), ids: list.map((n) => n.id) }
  }, [shown, doneExtra, boardByStatus, filters.status, doneExpanded, scopeOwners])

  // ----- places, for the composer, Move to… and the detail pane -----
  const places = useMemo(() => {
    const liveWs = workspaces.filter((x) => x.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name))
    const groups = spaces.map((s) => ({ label: s.name, options: [{ value: `space:${s.id}`, label: `${s.name} · ${cap(w.space)} notes` }, ...liveWs.filter((x) => x.spaceId === s.id).map((x) => ({ value: x.id, label: x.name }))] }))
    const loose = liveWs.filter((x) => !x.spaceId || !spaceById.has(x.spaceId))
    if (loose.length) groups.push({ label: `No ${w.space}`, options: loose.map((x) => ({ value: x.id, label: x.name })) })
    return { app: { value: APP, label: appLabel }, groups }
  }, [workspaces, spaces, spaceById, w.space, appLabel])

  // ----- render -----
  const nav = <ScopeNav tree={tree} scope={scope} onPick={setScope} expanded={expanded} onToggle={toggleExpanded} appLabel={appLabel} removedLabel={removedLabel} archivedWord={archivedWord} />
  const hasAny = live.some((n) => !n.archived)
  const nothingHere = scoped.filter((n) => !n.archived).length === 0
  const showBoard = view === 'board' && (shown.length > 0 || doneExtra.length > 0)
  const showList = view === 'list' && shown.length > 0
  const resultText = terms.length ? `${plural(shown.length, 'result')} for “${query.trim()}”` : `${shown.length} shown`

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      {/* title bar */}
      <div className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-4">
        {!narrow && (
          <IconButton label={showNav ? 'Hide the list of places' : 'Show the list of places'} onClick={() => (setNavCollapsed(!navCollapsed), lsSet(LS.nav, navCollapsed ? '0' : '1'))} className="no-drag">
            {showNav ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </IconButton>
        )}
        <StickyNote size={16} className="text-accent" />
        <span className="text-[13px] font-semibold">Notes</span>
        <span className="text-[11px] text-muted">{openTotal ? `${openTotal} open` : 'nothing open'}</span>
        <div className="no-drag ml-auto flex items-center gap-2">
          <Segmented
            size="sm"
            value={view}
            onChange={pickView}
            options={[
              {
                id: 'board',
                label: (
                  <span className="inline-flex items-center gap-1">
                    <Columns3 size={12} /> Board
                  </span>
                )
              },
              {
                id: 'list',
                label: (
                  <span className="inline-flex items-center gap-1">
                    <LayoutList size={12} /> List
                  </span>
                )
              }
            ]}
          />
          <Button size="sm" variant="ghost" onClick={() => setStatusesDlg(true)} title="Your own statuses, as board columns">
            <Settings2 size={12} /> Statuses
          </Button>
          <Button size="sm" variant="subtle" onClick={() => setSummary(true)} disabled={shown.length === 0} title="Claude summarises the notes shown, or answers a question about them">
            <Sparkles size={12} /> Summarise
          </Button>
          <Button size="sm" variant="primary" onClick={openComposer} title="New note (N)">
            <Plus size={12} /> New note
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {showNav && <aside className="flex w-[240px] shrink-0 flex-col border-r border-border bg-panel/40">{nav}</aside>}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* search */}
          <div className="flex items-center gap-2 px-4 pb-2 pt-3">
            {!showNav && (
              <span className="relative">
                <Button size="sm" variant="subtle" onClick={() => setScopePop((v) => !v)} aria-expanded={scopePop} aria-haspopup="dialog" className="h-8 max-w-[220px]" title="Where to look">
                  <Layers size={12} className="shrink-0" />
                  <span className="truncate">{scopeLabel}</span>
                </Button>
                {scopePop && (
                  <Popover onClose={() => setScopePop(false)} width={300} label="Where to look">
                    <div className="flex max-h-[65vh] min-h-0 flex-col">{nav}</div>
                  </Popover>
                )}
              </span>
            )}
            <div className="relative min-w-0 flex-1">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                ref={searchRef}
                type="search"
                aria-label="Search notes"
                placeholder="Search notes"
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    if (queryInput) clearSearch()
                    else e.currentTarget.blur()
                  } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                    const first = order[0]
                    if (first) {
                      e.preventDefault()
                      setCursorKey(first.key)
                      focusNote(first.key)
                    }
                  }
                }}
                className={clsx(inputCls, 'h-8 pl-8 pr-16 [&::-webkit-search-cancel-button]:hidden')}
              />
              <span className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                {queryInput ? (
                  <IconButton label="Clear search" onClick={clearSearch}>
                    <X size={12} />
                  </IconButton>
                ) : (
                  <kbd className="rounded border border-border px-1 text-[11px] text-muted">⌘F</kbd>
                )}
              </span>
            </div>
            <span className="shrink-0 text-[11px] text-muted" aria-live="polite">
              {scope !== 'all' && !showNav ? '' : scope !== 'all' ? `${scopeLabel} · ` : ''}
              {resultText}
            </span>
          </div>

          {/* quick filters */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 pb-2">
            <Segmented
              size="sm"
              value={filters.status}
              onChange={(v) => setF('status', v)}
              options={[
                { id: 'open', label: <Count label="Open" n={counts.open} /> },
                { id: 'done', label: <Count label="Done" n={counts.done} /> },
                { id: 'all', label: <Count label="All" n={counts.all} /> }
              ]}
            />
            <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
            <Chip active={filters.source === 'user'} onClick={() => setF('source', filters.source === 'user' ? 'all' : 'user')} count={counts.mine}>
              <User size={11} /> Mine
            </Chip>
            <Chip active={filters.source === 'agent'} onClick={() => setF('source', filters.source === 'agent' ? 'all' : 'agent')} count={counts.agents}>
              <Bot size={11} /> From agents
            </Chip>
            <Chip active={filters.dueSoon} onClick={() => setF('dueSoon', !filters.dueSoon)} count={counts.dueSoon} title="Overdue, or due in the next 7 days">
              <CalendarDays size={11} /> Due soon
            </Chip>
            <Chip active={filters.high} onClick={() => setF('high', !filters.high)} count={counts.high}>
              <Flag size={11} /> High priority
            </Chip>
            <Chip active={filters.kind === 'standing'} onClick={() => setF('kind', filters.kind === 'standing' ? 'all' : 'standing')} count={counts.standing} maestro>
              Decisions and rules
            </Chip>
            <span className="relative">
              <Chip active={moreOpen} onClick={() => setMoreOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={moreOpen}>
                <SlidersHorizontal size={11} /> More filters
              </Chip>
              {moreOpen && (
                <Popover onClose={() => setMoreOpen(false)} width={280} label="More filters">
                  <div className="flex flex-col gap-2.5 p-1 text-[12px]">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Kind</span>
                      <select className={clsx(inputCls, 'h-7 py-0 text-[12px]')} value={filters.kind} onChange={(e) => setF('kind', e.target.value as KindFilter)}>
                        {KIND_OPTIONS.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Who wrote it</span>
                      <select className={clsx(inputCls, 'h-7 py-0 text-[12px]')} value={filters.source} onChange={(e) => setF('source', e.target.value as Filters['source'])}>
                        <option value="all">Anyone</option>
                        <option value="user">Me</option>
                        <option value="agent">Agents</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Created</span>
                      <select className={clsx(inputCls, 'h-7 py-0 text-[12px]')} value={filters.since} onChange={(e) => setF('since', e.target.value)}>
                        {SINCE_OPTIONS.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Toggle checked={filters.archived} onChange={(v) => setF('archived', v)} label="Show archived notes" hint="Done notes you tidied away." />
                    <div className="border-t border-border pt-2">
                      <Button size="sm" variant="ghost" disabled={cleanupCandidates.length === 0} onClick={() => (setMoreOpen(false), setCleanupDlg(true))}>
                        <Archive size={12} /> Archive done notes older than {CLEANUP_DAYS} days{cleanupCandidates.length ? ` (${cleanupCandidates.length})` : ''}
                      </Button>
                    </div>
                  </div>
                </Popover>
              )}
            </span>
            {filters.kind !== 'all' && filters.kind !== 'standing' && <RemovableChip onRemove={() => setF('kind', 'all')}>{KIND_OPTIONS.find((o) => o.id === filters.kind)?.label}</RemovableChip>}
            {filters.since !== 'any' && <RemovableChip onRemove={() => setF('since', 'any')}>Created: {SINCE_OPTIONS.find((o) => o.id === filters.since)?.label}</RemovableChip>}
            {filters.archived && <RemovableChip onRemove={() => setF('archived', false)}>Including archived</RemovableChip>}
            {(filtersActive || terms.length > 0) && (
              <button className="ml-1 text-[11px] text-accent hover:underline" onClick={clearAll}>
                Clear filters
              </button>
            )}
            {view === 'board' && (
              <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
                Columns
                <select className="h-6 rounded-md border border-border bg-bg px-1 text-[11px] text-text" value={groupBy} onChange={(e) => pickGroupBy(e.target.value as GroupBy)}>
                  <option value="status">by status</option>
                  <option value="owner">by where</option>
                  <option value="priority">by priority</option>
                </select>
              </label>
            )}
          </div>

          {/* composer */}
          {composing && (
            <div className="border-b border-border px-4 py-2">
              <div className="rounded-lg border border-border bg-bg focus-within:border-accent">
                <textarea
                  ref={composerRef}
                  autoFocus
                  aria-label="New note"
                  value={text}
                  rows={2}
                  placeholder={NOTE_KINDS.find((k) => k.id === addKind)?.placeholder}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      submit()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      setComposing(false)
                    }
                  }}
                  className="w-full resize-none bg-transparent px-2.5 pt-2 text-[13px] outline-none placeholder:text-muted"
                />
                <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1.5">
                  <KindPicker value={addKind} onChange={setAddKind} />
                  <span className="ml-1 text-[11px] text-muted">in</span>
                  <PlaceSelect value={addOwner} onChange={setAddOwner} places={places} extraLabel={whereOf(addOwner).name} className="h-6 max-w-[240px] rounded-md border border-border bg-bg px-1 text-[11px]" />
                  <span className="ml-auto" />
                  <Button size="sm" variant="ghost" onClick={() => setComposing(false)}>
                    Close
                  </Button>
                  <Button size="sm" variant="primary" onClick={submit} disabled={!text.trim()}>
                    <Plus size={12} /> Add
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* bulk actions */}
          {selecting && <BulkBar count={selectedNotes.length} places={places} onDone={() => void bulkDone()} onMove={(to) => void bulkMove(to)} onPriority={(p) => void bulkPriority(p)} onDelete={() => deleteNotes(selectedNotes)} onClear={clearSelection} onSelectAll={() => setSelected(new Set(shown.map((n) => n.key)))} allSelected={selectedNotes.length >= shown.length} />}

          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 min-w-0 flex-1 overflow-auto">
              {!showBoard && !showList && (
                <EmptyState
                  kind={!hasAny ? 'first' : nothingHere ? 'here' : 'nomatch'}
                  scopeLabel={scopeLabel}
                  query={query.trim()}
                  filtersActive={filtersActive}
                  loaded={allLoaded}
                  doneHidden={filters.status === 'open' ? counts.done : 0}
                  onNew={openComposer}
                  onEverywhere={scope !== 'all' ? () => setScope('all') : undefined}
                  onClearSearch={clearSearch}
                  onClearFilters={clearFilters}
                  onShowDone={() => setF('status', 'all')}
                />
              )}
              {showBoard && (
                <Board
                  columns={columns}
                  limitOf={limitOf}
                  onMore={(c) => setLimits((l) => ({ ...l, [c.id]: limitOf(c) + (c.done ? DONE_PAGE : COLUMN_PAGE) }))}
                  doneExpanded={doneExpanded}
                  onToggleDone={() => setDoneOpen((v) => !v)}
                  canToggleDone={filters.status !== 'done'}
                  cleanup={cleanupCandidates.length}
                  onCleanup={() => setCleanupDlg(true)}
                  openKey={openKey}
                  cursorKey={cursorKey}
                  selected={selected}
                  selecting={selecting}
                  hl={hl}
                  terms={terms}
                  onPatch={patch}
                  whereOf={whereOf}
                  showWhere={!singleOwner}
                  statuses={statuses}
                  onOpen={onOpen}
                  onCheck={onCheck}
                  onFocus={onFocusNote}
                />
              )}
              {showList && (
                <List
                  notes={shown}
                  limit={limits.list ?? LIST_PAGE}
                  onMore={() => setLimits((l) => ({ ...l, list: (l.list ?? LIST_PAGE) + LIST_PAGE }))}
                  sort={sort}
                  onSort={onSort}
                  openKey={openKey}
                  cursorKey={cursorKey}
                  selected={selected}
                  selecting={selecting}
                  hl={hl}
                  terms={terms}
                  onPatch={patch}
                  whereOf={whereOf}
                  showWhere={!singleOwner}
                  statuses={statuses}
                  onOpen={onOpen}
                  onCheck={onCheck}
                  onFocus={onFocusNote}
                />
              )}
            </div>
            {opened && (
              <Detail
                note={opened}
                places={places}
                whereLabel={labelOf(opened.owner)}
                statuses={statuses}
                onPatch={(p) => patch(opened, p)}
                onMove={(to) => go(() => move(opened.owner, opened.id, to).then(() => setOpenKey(`${to}|${opened.id}`)))}
                onRemove={() => deleteNotes([opened])}
                onArchive={(on) => void archiveNotes([opened], on)}
                onClose={() => setOpenKey(null)}
              />
            )}
          </div>

          <div className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-1 text-[11px] text-muted" aria-hidden>
            <Hint k="J K">move</Hint>
            <Hint k="↵">open</Hint>
            <Hint k="X">select</Hint>
            <Hint k="E">done</Hint>
            <Hint k="N">new note</Hint>
            <Hint k="⌘F">search</Hint>
            {view === 'list' && <Hint k="⌘A">select all</Hint>}
            {selecting && <Hint k="Esc">clear selection</Hint>}
          </div>
        </div>
      </div>

      {summary && <SummaryDialog filter={summaryFilter} count={summaryFilter.ids?.length ?? 0} onClose={() => setSummary(false)} />}
      {statusesDlg && <StatusesDialog custom={customStatuses ?? []} onClose={() => setStatusesDlg(false)} />}
      {cleanupDlg && (
        <Dialog title="Archive old done notes" onClose={() => setCleanupDlg(false)} width={460}>
          <p className="text-[13px]">
            {plural(cleanupCandidates.length, 'done note')} {cleanupCandidates.length === 1 ? 'was' : 'were'} finished more than {CLEANUP_DAYS} days ago{scope !== 'all' ? ` in ${scopeLabel}` : ''}. Archiving takes them off the board and lists, and agents stop seeing them.
          </p>
          <p className="mt-2 text-[12px] text-muted">Nothing is deleted. Find them again with More filters, then Show archived notes.</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCleanupDlg(false)}>
              Keep them
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setCleanupDlg(false)
                void archiveNotes(cleanupCandidates, true)
              }}
            >
              <Archive size={13} /> Archive {plural(cleanupCandidates.length, 'note')}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  )
}

// ---------- small parts ----------

function Count({ label, n }: { label: string; n: number }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <span className="tabular-nums text-muted">{n}</span>
    </span>
  )
}

function Chip({ active, onClick, count, children, title, maestro, ...rest }: { active: boolean; onClick: () => void; count?: number; children: React.ReactNode; title?: string; maestro?: boolean } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={clsx(chipCls, 'border transition-colors', active ? (maestro ? 'border-maestro/50 bg-maestro/15 text-maestro' : 'border-accent/50 bg-accent/15 text-accent') : 'border-border text-muted hover:bg-panel-2 hover:text-text')}
      {...rest}
    >
      {children}
      {count !== undefined && <span className="tabular-nums">{count}</span>}
    </button>
  )
}

function RemovableChip({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }): React.JSX.Element {
  return (
    <span className={clsx(chipCls, 'border border-accent/40 bg-accent/10 pr-0.5 text-accent')}>
      {children}
      <button type="button" aria-label="Remove this filter" onClick={onRemove} className="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-accent/20">
        <X size={10} />
      </button>
    </span>
  )
}

function Hint({ k, children }: { k: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1">
      <kbd className="rounded border border-border px-1 font-sans">{k}</kbd>
      {children}
    </span>
  )
}

function Hl({ text, re }: { text: string; re: RegExp | null }): React.JSX.Element {
  if (!re || !text) return <>{text}</>
  const parts = text.split(re)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-warn/30 text-text">
            {p}
          </mark>
        ) : (
          p
        )
      )}
    </>
  )
}

/** A small anchored panel: closes on Escape or a click outside, keeps focus inside while open. */
function Popover({ onClose, children, width, label, align = 'left' }: { onClose: () => void; children: React.ReactNode; width: number; label: string; align?: 'left' | 'right' }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const box = ref.current
      if (box && !box.contains(e.target as Node) && !box.parentElement?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || hasOpenDialog()) return
      e.stopImmediatePropagation()
      e.preventDefault()
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [onClose])
  return (
    <div ref={ref} role="dialog" aria-label={label} tabIndex={-1} className={clsx('absolute top-full z-30 mt-1 flex flex-col overflow-hidden rounded-lg border border-border bg-panel p-1.5 shadow-xl outline-none', align === 'right' ? 'right-0' : 'left-0')} style={{ width }}>
      {children}
    </div>
  )
}

interface Places {
  app: { value: string; label: string }
  groups: { label: string; options: { value: string; label: string }[] }[]
}
function PlaceSelect({ value, onChange, places, extraLabel, className, ariaLabel = 'Where the note lives' }: { value: string; onChange: (v: string) => void; places: Places; extraLabel?: string; className?: string; ariaLabel?: string }): React.JSX.Element {
  const known = value === places.app.value || places.groups.some((g) => g.options.some((o) => o.value === value))
  return (
    <select aria-label={ariaLabel} className={className} value={value} onChange={(e) => onChange(e.target.value)}>
      {!known && value && <option value={value}>{extraLabel ?? value}</option>}
      <option value={places.app.value}>{places.app.label}</option>
      {places.groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function EmptyState({ kind, scopeLabel, query, filtersActive, loaded, doneHidden, onNew, onEverywhere, onClearSearch, onClearFilters, onShowDone }: { kind: 'first' | 'here' | 'nomatch'; scopeLabel: string; query: string; filtersActive: boolean; loaded: boolean; doneHidden: number; onNew: () => void; onEverywhere?: () => void; onClearSearch: () => void; onClearFilters: () => void; onShowDone: () => void }): React.JSX.Element {
  if (!loaded) {
    return (
      <div className="mt-16 flex items-center justify-center gap-2 text-[12px] text-muted">
        <Loader2 size={14} className="animate-spin" /> Loading notes…
      </div>
    )
  }
  const box = 'mx-auto mt-12 max-w-md rounded-lg border border-dashed border-border p-5 text-center'
  if (kind === 'first') {
    return (
      <div className={box}>
        <div className="text-[13px] font-medium">No notes yet</div>
        <p className="mt-1 text-[12px] text-muted">Add a todo, a decision or a rule, jot notes while you work, or let an agent file what it finds.</p>
        <Button className="mt-3" size="sm" variant="primary" onClick={onNew}>
          <Plus size={12} /> New note
        </Button>
      </div>
    )
  }
  if (kind === 'here') {
    return (
      <div className={box}>
        <div className="text-[13px] font-medium">Nothing in {scopeLabel} yet</div>
        <div className="mt-3 flex justify-center gap-2">
          <Button size="sm" variant="primary" onClick={onNew}>
            <Plus size={12} /> New note
          </Button>
          {onEverywhere && (
            <Button size="sm" variant="ghost" onClick={onEverywhere}>
              Look everywhere
            </Button>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className={box}>
      <div className="text-[13px] font-medium">{query ? `No notes match “${query}”` : 'Nothing matches these filters'}</div>
      {doneHidden > 0 && <p className="mt-1 text-[12px] text-muted">{plural(doneHidden, 'done note')} {doneHidden === 1 ? 'matches' : 'match'}.</p>}
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {query && (
          <Button size="sm" onClick={onClearSearch}>
            Clear search
          </Button>
        )}
        {filtersActive && (
          <Button size="sm" onClick={onClearFilters}>
            Clear filters
          </Button>
        )}
        {doneHidden > 0 && (
          <Button size="sm" variant="ghost" onClick={onShowDone}>
            Show done too
          </Button>
        )}
        {onEverywhere && (
          <Button size="sm" variant="ghost" onClick={onEverywhere}>
            Look everywhere
          </Button>
        )}
      </div>
    </div>
  )
}

// ---------- scope navigator ----------

function ScopeNav({ tree, scope, onPick, expanded, onToggle, appLabel, removedLabel, archivedWord }: { tree: NavTree; scope: string; onPick: (s: string) => void; expanded: Set<string>; onToggle: (k: string) => void; appLabel: string; removedLabel: string; archivedWord: string }): React.JSX.Element {
  const w = useWords()
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  const match = (s: string): boolean => !q || s.toLowerCase().includes(q)
  const spaceNotes = `${cap(w.space)} notes`
  const shownSpaces = useMemo(() => {
    return tree.spaces
      .map((sp) => {
        if (!q || sp.name.toLowerCase().includes(q)) return { sp, live: sp.live, archived: sp.archived, own: sp.own, forced: Boolean(q) }
        const live = sp.live.filter((x) => x.name.toLowerCase().includes(q))
        const archived = sp.archived.filter((x) => x.name.toLowerCase().includes(q))
        const own = sp.own && spaceNotes.toLowerCase().includes(q) ? sp.own : null
        return live.length || archived.length || own ? { sp, live, archived, own, forced: true } : null
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
  }, [tree.spaces, q, spaceNotes])
  const removed = tree.removed.filter((x) => match(x.name) || match(removedLabel))
  return (
    <nav aria-label="Where notes live" className="flex min-h-0 flex-1 flex-col">
      <div className="p-2">
        <input className={clsx(inputCls, 'h-7 py-0 text-[12px]')} placeholder={`Filter ${w.spaces} and ${w.workspaces}`} aria-label={`Filter ${w.spaces} and ${w.workspaces}`} value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && filter && (e.stopPropagation(), setFilter(''))} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-3">
        <NavRow label="Everywhere" icon={<Layers size={12} className="shrink-0" />} count={tree.all.open} active={scope === 'all'} onPick={() => onPick('all')} />
        {match(appLabel) && <NavRow label={appLabel} icon={<StickyNote size={12} className="shrink-0" />} count={tree.app.open} active={scope === APP} onPick={() => onPick(APP)} title={`Notes not tied to any ${w.space}`} />}
        {shownSpaces.length > 0 && <div className="mb-0.5 mt-3 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{cap(w.spaces)}</div>}
        {shownSpaces.map(({ sp, live, archived, own, forced }) => {
          const open = forced || expanded.has(sp.key)
          const archOpen = forced || expanded.has(sp.archivedKey)
          return (
            <div key={sp.key}>
              <NavRow label={sp.name} dot={sp.color} count={sp.open} active={scope === sp.key} onPick={() => {
                  onPick(sp.key)
                  if (!open && (sp.live.length || sp.archived.length || sp.own)) onToggle(sp.key)
                }} expanded={open} onToggle={sp.live.length || sp.archived.length || sp.own ? () => onToggle(sp.key) : undefined} strong />
              {open && (
                <>
                  {own && <NavRow depth={1} label={spaceNotes} count={own.open} active={scope === own.key} onPick={() => onPick(own.key)} />}
                  {live.map((x) => (
                    <NavRow key={x.key} depth={1} label={x.name} count={x.open} active={scope === x.key} onPick={() => onPick(x.key)} title={`${x.name} · ${plural(x.total, 'note')}, last changed ${relTime(x.last)}`} />
                  ))}
                  {archived.length > 0 && (
                    <>
                      <NavRow depth={1} label={`${archivedWord} (${archived.length})`} icon={<Archive size={11} className="shrink-0" />} count={archived.reduce((n, x) => n + x.open, 0)} active={scope === sp.archivedKey} onPick={() => onPick(sp.archivedKey)} expanded={archOpen} onToggle={() => onToggle(sp.archivedKey)} muted />
                      {archOpen && archived.map((x) => <NavRow key={x.key} depth={2} label={x.name} count={x.open} active={scope === x.key} onPick={() => onPick(x.key)} muted />)}
                    </>
                  )}
                </>
              )}
            </div>
          )
        })}
        {removed.length > 0 && (
          <div className="mt-3">
            <NavRow label={`${removedLabel} (${removed.length})`} icon={<Trash2 size={11} className="shrink-0" />} count={removed.reduce((n, x) => n + x.open, 0)} active={scope === 'removed'} onPick={() => onPick('removed')} expanded={Boolean(q) || expanded.has('removed')} onToggle={() => onToggle('removed')} muted />
            {(Boolean(q) || expanded.has('removed')) && removed.map((x) => <NavRow key={x.key} depth={1} label={x.name} count={x.open} active={scope === x.key} onPick={() => onPick(x.key)} muted title={`Notes left from a ${w.workspace} that no longer exists · last changed ${relTime(x.last)}`} />)}
          </div>
        )}
        {q && !shownSpaces.length && !removed.length && !match(appLabel) && <div className="px-2 py-3 text-[12px] text-muted">Nothing called “{filter.trim()}”.</div>}
      </div>
    </nav>
  )
}

function NavRow({ label, count, active, onPick, depth = 0, expanded, onToggle, dot, icon, muted, strong, title }: { label: string; count: number; active: boolean; onPick: () => void; depth?: number; expanded?: boolean; onToggle?: () => void; dot?: string; icon?: React.ReactNode; muted?: boolean; strong?: boolean; title?: string }): React.JSX.Element {
  return (
    <div className={clsx('group flex h-7 items-center rounded-md pr-1.5 text-[12px]', active ? 'bg-panel-2 font-medium text-text' : muted ? 'text-muted hover:bg-panel-2/60 hover:text-text' : 'text-text hover:bg-panel-2/60')} style={{ paddingLeft: 2 + depth * 14 }}>
      {onToggle ? (
        <button type="button" aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`} onClick={onToggle} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-border hover:text-text">
          <ChevronRight size={12} className={clsx('transition-transform', expanded && 'rotate-90')} />
        </button>
      ) : (
        <span className="w-5 shrink-0" />
      )}
      <button type="button" aria-current={active ? 'true' : undefined} onClick={onPick} title={title ?? label} className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left">
        {dot && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} aria-hidden />}
        {icon}
        <span className={clsx('truncate', strong && 'font-medium')}>{label}</span>
      </button>
      {count > 0 && <span className="ml-1 shrink-0 text-[11px] tabular-nums text-muted">{count}</span>}
    </div>
  )
}

// ---------- bulk actions ----------

function BulkBar({ count, places, onDone, onMove, onPriority, onDelete, onClear, onSelectAll, allSelected }: { count: number; places: Places; onDone: () => void; onMove: (to: string) => void; onPriority: (p: NotePriority | undefined) => void; onDelete: () => void; onClear: () => void; onSelectAll: () => void; allSelected: boolean }): React.JSX.Element {
  const [pop, setPop] = useState<'move' | 'priority' | null>(null)
  return (
    <div role="toolbar" aria-label="Selected notes" className="flex flex-wrap items-center gap-1.5 border-b border-border bg-accent/5 px-4 py-1.5 text-[12px]">
      <span className="font-medium">{count} selected</span>
      {!allSelected && (
        <button className="text-[11px] text-accent hover:underline" onClick={onSelectAll}>
          Select all shown
        </button>
      )}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <Button size="sm" variant="subtle" onClick={onDone}>
        <Check size={12} /> Mark done
      </Button>
      <span className="relative">
        <Button size="sm" variant="subtle" aria-haspopup="dialog" aria-expanded={pop === 'move'} onClick={() => setPop(pop === 'move' ? null : 'move')}>
          <FolderInput size={12} /> Move to…
        </Button>
        {pop === 'move' && (
          <Popover onClose={() => setPop(null)} width={280} label="Move to">
            <div className="p-1">
              <PlaceSelect
                ariaLabel="Move the selected notes to"
                value=""
                extraLabel="Pick a place…"
                places={places}
                onChange={(v) => {
                  if (!v) return
                  setPop(null)
                  onMove(v)
                }}
                className={clsx(inputCls, 'h-8 py-0 text-[12px]')}
              />
            </div>
          </Popover>
        )}
      </span>
      <span className="relative">
        <Button size="sm" variant="subtle" aria-haspopup="dialog" aria-expanded={pop === 'priority'} onClick={() => setPop(pop === 'priority' ? null : 'priority')}>
          <Flag size={12} /> Priority
        </Button>
        {pop === 'priority' && (
          <Popover onClose={() => setPop(null)} width={160} label="Change priority">
            {[...PRIORITY, { id: undefined, label: 'No priority', cls: '' }].map((p) => (
              <button
                key={p.label}
                type="button"
                className="rounded px-2 py-1 text-left text-[12px] hover:bg-panel-2"
                onClick={() => {
                  setPop(null)
                  onPriority(p.id)
                }}
              >
                {p.label}
              </button>
            ))}
          </Popover>
        )}
      </span>
      <Button size="sm" variant="danger" onClick={onDelete}>
        <Trash2 size={12} /> Delete
      </Button>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
        <X size={12} /> Clear selection
      </Button>
    </div>
  )
}

// ---------- board ----------

interface ItemHandlers {
  onPatch: (n: Located, p: NotePatch) => void
  onOpen: (n: Located, e: React.MouseEvent) => void
  onCheck: (n: Located, shift: boolean) => void
  onFocus: (n: Located) => void
}
interface ItemContext extends ItemHandlers {
  openKey: string | null
  cursorKey: string | null
  selected: Set<string>
  selecting: boolean
  hl: RegExp | null
  terms: string[]
  whereOf: (o: string) => Where
  showWhere: boolean
  statuses: NoteStatusDef[]
}

function Board({ columns, limitOf, onMore, doneExpanded, onToggleDone, canToggleDone, cleanup, onCleanup, ...ctx }: { columns: Column[]; limitOf: (c: Column) => number; onMore: (c: Column) => void; doneExpanded: boolean; onToggleDone: () => void; canToggleDone: boolean; cleanup: number; onCleanup: () => void } & ItemContext): React.JSX.Element {
  const [dragging, setDragging] = useState<Located | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const onDragEnd = useCallback(() => {
    setDragging(null)
    setOver(null)
  }, [])
  return (
    <div className="flex h-full min-w-max items-start gap-3 px-4 py-3">
      {columns.map((c) => {
        const collapsed = c.done && !doneExpanded
        const limit = limitOf(c)
        return (
          <section
            key={c.id}
            aria-label={`${c.label}, ${c.notes.length}`}
            className={clsx('flex max-h-full w-[288px] shrink-0 flex-col rounded-xl border', over === c.id && dragging ? 'border-accent/60 bg-accent/5' : c.maestro ? 'border-maestro/30 bg-maestro/5' : 'border-border bg-panel/40')}
            onDragOver={(e) => {
              if (!dragging || !c.drop || (c.accepts && !c.accepts(dragging))) return
              e.preventDefault()
              setOver(c.id)
            }}
            onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
            onDrop={(e) => {
              e.preventDefault()
              if (dragging && c.drop && (!c.accepts || c.accepts(dragging))) c.drop(dragging)
              onDragEnd()
            }}
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <span className={clsx('text-[11px] font-semibold uppercase tracking-wide', c.maestro ? 'text-maestro' : c.done ? 'text-ok' : 'text-muted')}>{c.label}</span>
              <span className={clsx('rounded-full px-1.5 text-[11px] tabular-nums', c.maestro ? 'bg-maestro/15 text-maestro' : 'bg-panel-2 text-muted')}>{c.notes.length}</span>
              {c.done && canToggleDone && c.notes.length > 0 && (
                <button type="button" aria-expanded={!collapsed} className="ml-auto text-[11px] text-accent hover:underline" onClick={onToggleDone}>
                  {collapsed ? 'Show' : 'Hide'}
                </button>
              )}
            </div>
            {c.hint && <div className="-mt-1 px-3 pb-1.5 text-[11px] text-muted">{c.hint}</div>}
            {collapsed ? (
              <div className="px-3 pb-2.5 text-[11px] text-muted">
                {c.notes.length ? `${plural(c.notes.length, 'note')} done. Drop a card here to finish it.` : 'Drop a card here to finish it.'}
                {cleanup > 0 && (
                  <button type="button" className="mt-1 flex items-center gap-1 text-accent hover:underline" onClick={onCleanup}>
                    <Archive size={11} /> Archive {cleanup} older than {CLEANUP_DAYS} days
                  </button>
                )}
              </div>
            ) : (
              <div className="flex min-h-[64px] flex-1 flex-col gap-1.5 overflow-auto px-2 pb-2">
                {c.maestro && c.notes.length === 0 && <div className="rounded-lg border border-dashed border-maestro/30 p-3 text-center text-[11px] text-muted">None yet. Pick Decision or Rule in a new note to add one.</div>}
                {c.notes.slice(0, limit).map((n) => (
                  <Card key={n.key} note={n} active={n.key === ctx.openKey} cursor={n.key === ctx.cursorKey} checked={ctx.selected.has(n.key)} selecting={ctx.selecting} hl={ctx.hl} terms={ctx.terms} where={ctx.whereOf(n.owner)} showWhere={ctx.showWhere} statuses={ctx.statuses} onOpen={ctx.onOpen} onCheck={ctx.onCheck} onFocus={ctx.onFocus} onPatch={ctx.onPatch} onDragStart={setDragging} onDragEnd={onDragEnd} />
                ))}
                {c.notes.length > limit && (
                  <button type="button" className="rounded-md py-1 text-[11px] text-accent hover:bg-panel-2" onClick={() => onMore(c)}>
                    {c.done ? `Show older (${c.notes.length - limit})` : `Show ${Math.min(c.done ? DONE_PAGE : COLUMN_PAGE, c.notes.length - limit)} more`}
                  </button>
                )}
                {c.done && cleanup > 0 && (
                  <button type="button" className="flex items-center justify-center gap-1 rounded-md py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-text" onClick={onCleanup}>
                    <Archive size={11} /> Clean up: archive {cleanup} older than {CLEANUP_DAYS} days
                  </button>
                )}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function WhereChip({ where }: { where: Where }): React.JSX.Element {
  return (
    <span className="inline-flex min-w-0 max-w-[150px] items-center gap-1 rounded bg-panel-2 px-1" title={where.spaceName ? `${where.name} · ${where.spaceName}` : where.name}>
      {where.color && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: where.color }} aria-hidden />}
      <span className="truncate">{where.name}</span>
    </span>
  )
}

/** Words too common to require on their own ("add all to cart" should not need "to" somewhere in the note). */
const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'and', 'or', 'for', 'is', 'de', 'la', 'el', 'en', 'y', 'o', 'los', 'las', 'del', 'un', 'una'])
/** A word that starts where the term starts: "cart" finds "cart" and "cartesian", never "discart". */
const wordStart = (t: string): RegExp => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}`, 'u')

/**
 * The search: every meaningful word must start a word in the note (stopwords only count when they are all there
 * is), and the exact phrase ranks first, then a hit in the title.
 */
function searchOf(query: string): { phrase: string; terms: string[]; hl: RegExp | null; matches: (lower: string) => boolean; score: (n: Located) => number } {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, ' ')
  const words = phrase ? phrase.split(' ') : []
  const meaningful = words.filter((w) => !STOPWORDS.has(w))
  const terms = meaningful.length ? meaningful : words
  const res = terms.map(wordStart)
  // Highlights start at a word too, so "all" never lights up inside "Manually".
  const hl = phrase ? new RegExp(`(?<=^|[^\\p{L}\\p{N}])(${[phrase, ...terms].map(escapeRe).join('|')})`, 'giu') : null
  return {
    phrase,
    terms,
    hl,
    matches: (lower) => lower.includes(phrase) || res.every((r) => r.test(lower)),
    score: (n) => (n.lower.includes(phrase) ? 2 : 0) + (res.every((r) => r.test(n.title.toLowerCase())) ? 1 : 0)
  }
}

/**
 * When a search hit is not in the part of the title that shows, a one-line excerpt around the first hit, so the
 * person sees why the note matched. Null when the title already shows it (or the hit is only in a tag).
 */
function matchSnippet(n: Located, terms: string[], titleShows: number, bodyShows: number): string | null {
  if (!terms.length) return null
  const title = n.title.toLowerCase()
  const inTitle = terms.some((x) => {
    const i = title.indexOf(x)
    return i >= 0 && i + x.length <= titleShows
  })
  if (inTitle) return null
  if (bodyShows && terms.some((x) => n.body.slice(0, bodyShows).toLowerCase().includes(x))) return null
  const flat = n.text.replace(/\s+/g, ' ')
  const lower = flat.toLowerCase()
  let at = lower.indexOf(terms.join(' '))
  if (at < 0)
    for (const x of terms) {
      const m = wordStart(x).exec(lower)
      if (m && (at < 0 || m.index < at)) at = m.index + m[1].length
    }
  if (at < 0) return null
  const start = Math.max(0, at - 40)
  const end = Math.min(flat.length, at + 90)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}

/** A select that reads as a plain chip until hovered or focused; still one Tab stop and a native picker. */
const inlineSelect = 'h-5 max-w-full cursor-pointer appearance-none truncate rounded border border-transparent px-1 text-[11px] outline-none transition-colors hover:border-border focus-visible:border-accent'

function StatusInline({ n, statuses, onPatch }: { n: Located; statuses: NoteStatusDef[]; onPatch: (n: Located, p: NotePatch) => void }): React.JSX.Element {
  const st = noteStatus(n)
  const def = statuses.find((s) => s.id === st)
  return (
    <select
      aria-label="Status"
      title="Change status"
      value={st}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onPatch(n, { status: e.target.value as NoteStatus })}
      className={clsx(inlineSelect, 'bg-transparent', st === 'todo' ? 'text-muted' : (def?.tone ?? 'text-accent'))}
    >
      {statuses.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label}
        </option>
      ))}
    </select>
  )
}

function PriorityInline({ n, onPatch }: { n: Located; onPatch: (n: Located, p: NotePatch) => void }): React.JSX.Element {
  const def = PRIORITY.find((x) => x.id === n.priority)
  return (
    <select
      aria-label="Priority"
      title="Change priority"
      value={n.priority ?? ''}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onPatch(n, { priority: (e.target.value || undefined) as NotePriority })}
      className={clsx(inlineSelect, def ? `${def.cls} font-medium` : 'bg-transparent text-muted')}
    >
      <option value="">—</option>
      {PRIORITY.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </select>
  )
}

/** The to-do's own done control: a circle that fills with a check, unlike the square selection box. */
function DoneCircle({ n, onPatch, className }: { n: Located; onPatch: (n: Located, p: NotePatch) => void; className?: string }): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={n.isDone}
      aria-label={n.isDone ? 'Done. Mark not done' : 'Mark done'}
      title={n.isDone ? 'Mark not done' : 'Mark done'}
      onClick={(e) => {
        e.stopPropagation()
        onPatch(n, n.isDone ? { status: 'todo' } : { status: 'done' })
      }}
      className={clsx('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors', n.isDone ? 'border-ok bg-ok text-bg' : 'border-muted text-transparent hover:border-ok hover:text-ok', className)}
    >
      <Check size={10} strokeWidth={3} />
    </button>
  )
}

const Card = memo(function Card({ note: n, active, cursor, checked, selecting, hl, terms, where, showWhere, statuses, onOpen, onCheck, onFocus, onPatch, onDragStart, onDragEnd }: { note: Located; active: boolean; cursor: boolean; checked: boolean; selecting: boolean; hl: RegExp | null; terms: string[]; where: Where; showWhere: boolean; statuses: NoteStatusDef[]; onDragStart: (n: Located) => void; onDragEnd: () => void } & ItemHandlers): React.JSX.Element {
  const [more, setMore] = useState(false)
  const standing = isStandingNote(n)
  const st = noteStatus(n)
  const long = n.body.length > 160 || n.body.split('\n').length > 3 || n.title.length > 100
  const due = standing ? null : dueInfo(n)
  const snippet = more ? null : matchSnippet(n, terms, 80, 150)
  return (
    <article
      data-key={n.key}
      tabIndex={0}
      aria-label={n.title || 'Note'}
      draggable
      onDragStart={() => onDragStart(n)}
      onDragEnd={onDragEnd}
      onFocus={(e) => e.target === e.currentTarget && onFocus(n)}
      onClick={(e) => onOpen(n, e)}
      className={clsx(
        'group cursor-pointer rounded-lg border px-2.5 py-2 text-[12px] shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent',
        standing ? 'bg-maestro/10' : checked ? 'bg-accent/5' : 'bg-bg',
        active ? (standing ? 'border-maestro' : 'border-accent') : checked ? 'border-accent/60' : cursor ? 'border-accent/40' : standing ? 'border-maestro/30 hover:border-maestro' : 'border-border hover:border-accent/60',
        n.isDone && !active && 'opacity-75'
      )}
    >
      <div className="flex items-start gap-1.5">
        <input
          type="checkbox"
          checked={checked}
          readOnly
          aria-label={`Select “${trimTo(n.title, 60)}”`}
          onClick={(e) => {
            e.stopPropagation()
            onCheck(n, e.shiftKey)
          }}
          className={clsx('mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer rounded-sm accent-accent', !selecting && !checked && 'reveal-on-focus opacity-0 group-hover:opacity-100')}
        />
        {n.kind === 'todo' ? <DoneCircle n={n} onPatch={onPatch} className="mt-px" /> : n.isDone ? <Check size={12} className="mt-0.5 shrink-0 text-ok" aria-label="Done" /> : null}
        <div className={clsx('min-w-0 flex-1 break-words font-semibold leading-snug', !more && 'line-clamp-2')}>
          <Hl text={n.title || 'Untitled'} re={hl} />
        </div>
      </div>
      {snippet ? (
        <div className="mt-1 truncate text-muted" title={snippet}>
          <Hl text={snippet} re={hl} />
        </div>
      ) : (
        n.body && (
          <div className={clsx('mt-1 whitespace-pre-wrap break-words leading-snug text-muted', !more && 'line-clamp-3')}>
            <Hl text={n.body} re={hl} />
          </div>
        )
      )}
      {long && (
        <button
          type="button"
          aria-expanded={more}
          className={clsx('mt-0.5 text-[11px] text-accent hover:underline', !more && 'reveal-on-focus opacity-0 group-hover:opacity-100')}
          onClick={(e) => {
            e.stopPropagation()
            setMore((m) => !m)
          }}
        >
          {more ? 'less' : 'more'}
        </button>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted">
        {standing ? <KindChip kind={n.kind} /> : n.kind === 'note' ? <span className="inline-flex items-center gap-0.5"><StickyNote size={10} /> Note</span> : st !== 'todo' && st !== 'done' ? <StatusInline n={n} statuses={statuses} onPatch={onPatch} /> : null}
        {n.priority && !standing && <PriorityInline n={n} onPatch={onPatch} />}
        {due && (
          <span className={clsx('inline-flex items-center gap-0.5 rounded px-1', due.tone === 'danger' ? 'bg-danger/15 text-danger' : due.tone === 'warn' ? 'bg-warn/15 text-warn' : '')}>
            <CalendarDays size={10} /> {due.label}
          </span>
        )}
        {showWhere && <WhereChip where={where} />}
        {n.archived && (
          <span className="inline-flex items-center gap-0.5">
            <Archive size={10} /> Archived
          </span>
        )}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1" title={`${n.source === 'agent' ? 'Added by an agent' : 'Added by you'} · changed ${new Date(n.updatedAt).toLocaleString()}`}>
          {n.source === 'agent' ? <Bot size={10} aria-label="By an agent" /> : <User size={10} aria-label="By you" />}
          {relTime(n.updatedAt)}
        </span>
      </div>
    </article>
  )
})

// ---------- list ----------

const LIST_COLS = 'grid-cols-[20px_16px_minmax(0,1fr)_108px_84px_104px_150px_72px]'

function List({ notes, limit, onMore, sort, onSort, ...ctx }: { notes: Located[]; limit: number; onMore: () => void; sort: SortState; onSort: (by: SortBy) => void } & ItemContext): React.JSX.Element {
  const head = (by: SortBy, label: string): React.JSX.Element => (
    <button type="button" onClick={() => onSort(by)} aria-sort={sort.by === by ? (sort.dir === 1 ? 'descending' : 'ascending') : undefined} className={clsx('inline-flex items-center gap-0.5 uppercase tracking-wide hover:text-text', sort.by === by && 'text-text')} title={`Sort by ${label.toLowerCase()}`}>
      {label}
      {sort.by === by && (sort.dir === 1 ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
    </button>
  )
  return (
    <div className="px-4 py-2">
      <div className={clsx('sticky top-0 z-10 grid items-center gap-2 bg-bg px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted', LIST_COLS)}>
        <span />
        <span />
        <span>Note</span>
        <span>Status</span>
        {head('priority', 'Priority')}
        {head('due', 'Due')}
        <span>Where</span>
        {head('updated', 'Updated')}
      </div>
      <div className="flex flex-col">
        {notes.slice(0, limit).map((n) => (
          <Row key={n.key} note={n} active={n.key === ctx.openKey} cursor={n.key === ctx.cursorKey} checked={ctx.selected.has(n.key)} selecting={ctx.selecting} hl={ctx.hl} terms={ctx.terms} where={ctx.whereOf(n.owner)} showWhere={ctx.showWhere} statuses={ctx.statuses} onOpen={ctx.onOpen} onCheck={ctx.onCheck} onFocus={ctx.onFocus} onPatch={ctx.onPatch} />
        ))}
      </div>
      {notes.length > limit && (
        <button type="button" className="mt-2 w-full rounded-md py-1.5 text-[12px] text-accent hover:bg-panel-2" onClick={onMore}>
          Show {Math.min(LIST_PAGE, notes.length - limit)} more of {notes.length - limit}
        </button>
      )}
    </div>
  )
}

const Row = memo(function Row({ note: n, active, cursor, checked, selecting, hl, terms, where, showWhere, statuses, onOpen, onCheck, onFocus, onPatch }: { note: Located; active: boolean; cursor: boolean; checked: boolean; selecting: boolean; hl: RegExp | null; terms: string[]; where: Where; showWhere: boolean; statuses: NoteStatusDef[] } & ItemHandlers): React.JSX.Element {
  const standing = isStandingNote(n)
  const due = standing ? null : dueInfo(n)
  const hit = matchSnippet(n, terms, 60, 0)
  const lead = !hit && n.body ? trimTo(n.body.replace(/\s+/g, ' '), 220) : ''
  return (
    <div
      data-key={n.key}
      tabIndex={0}
      aria-label={n.title || 'Note'}
      onFocus={(e) => e.target === e.currentTarget && onFocus(n)}
      onClick={(e) => onOpen(n, e)}
      className={clsx('group grid cursor-pointer items-center gap-2 rounded-md border-b border-border/60 px-2 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent', LIST_COLS, active ? 'bg-panel-2' : checked ? 'bg-accent/10' : cursor ? 'bg-panel-2/60' : 'hover:bg-panel-2/60', n.isDone && !active && 'text-muted')}
    >
      <input
        type="checkbox"
        checked={checked}
        readOnly
        aria-label={`Select “${trimTo(n.title, 60)}”`}
        onClick={(e) => {
          e.stopPropagation()
          onCheck(n, e.shiftKey)
        }}
        className={clsx('h-3.5 w-3.5 cursor-pointer rounded-sm accent-accent', !selecting && !checked && 'reveal-on-focus opacity-0 group-hover:opacity-100')}
      />
      {standing ? <span className="h-3 w-3 rounded-full bg-maestro/30" aria-hidden /> : n.kind === 'todo' ? <DoneCircle n={n} onPatch={onPatch} /> : <StickyNote size={12} className="text-muted" aria-label="Note" />}
      <span className="flex min-w-0 flex-col" title={n.text}>
        <span className="truncate">
          <span className={clsx('font-medium', !n.isDone && 'text-text')}>
            <Hl text={n.title || 'Untitled'} re={hl} />
          </span>
          {lead && <span className="ml-2 text-muted">{lead}</span>}
        </span>
        {hit && (
          <span className="truncate text-[11px] text-muted">
            <Hl text={hit} re={hl} />
          </span>
        )}
      </span>
      <span className="min-w-0">{n.kind === 'todo' ? <StatusInline n={n} statuses={statuses} onPatch={onPatch} /> : standing ? <KindChip kind={n.kind} /> : <span className="px-1 text-[11px] text-muted">Note</span>}</span>
      <span className="min-w-0">{standing ? null : <PriorityInline n={n} onPatch={onPatch} />}</span>
      <span className={clsx('truncate text-[11px]', due?.tone === 'danger' ? 'font-medium text-danger' : due?.tone === 'warn' ? 'text-warn' : 'text-muted')}>{due?.label ?? ''}</span>
      <span className="min-w-0 text-[11px] text-muted">{showWhere ? <WhereChip where={where} /> : <span className="truncate">{where.name}</span>}</span>
      <span className="text-[11px] text-muted" title={new Date(n.updatedAt).toLocaleString()}>
        {relTime(n.updatedAt)}
      </span>
    </div>
  )
})

// ---------- detail drawer ----------

function Detail({ note: n, places, whereLabel, statuses, onPatch, onMove, onRemove, onArchive, onClose }: { note: Located; places: Places; whereLabel: string; statuses: NoteStatusDef[]; onPatch: (p: NotePatch) => void; onMove: (to: string) => void; onRemove: () => void; onArchive: (on: boolean) => void; onClose: () => void }): React.JSX.Element {
  const [text, setText] = useState(n.text)
  const [tags, setTags] = useState((n.tags ?? []).join(', '))
  const setChatDraft = useChat((s) => s.setDraft)
  const select = useApp((s) => s.select)
  const guided = useGuided()
  const w = useWords()
  useEffect(() => {
    setText(n.text)
    setTags((n.tags ?? []).join(', '))
  }, [n.id, n.text, n.tags])
  const st = noteStatus(n)
  const isWs = n.owner !== APP && !isSpace(n.owner)
  const field = 'mb-3'
  const label = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted'
  return (
    <aside aria-label="Note details" className="flex w-[360px] shrink-0 flex-col border-l border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[12px] font-semibold">{NOTE_KINDS.find((k) => k.id === n.kind)?.label ?? 'Note'}</span>
        <span className="inline-flex items-center gap-1 text-[11px] text-muted">
          {n.source === 'agent' ? <Bot size={10} /> : <User size={10} />} {n.source === 'agent' ? 'by an agent' : 'by you'}
        </span>
        <IconButton label="Close" className="ml-auto" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      {n.archived && (
        <div className="flex items-center gap-2 border-b border-border bg-panel-2 px-3 py-1.5 text-[12px] text-muted">
          <Archive size={12} /> Archived
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onArchive(false)}>
            <ArchiveRestore size={12} /> Restore
          </Button>
        </div>
      )}
      <div className="flex-1 overflow-auto p-3">
        <div className={field}>
          <textarea aria-label="Text" value={text} rows={Math.min(12, Math.max(3, text.split('\n').length + 1))} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() && text.trim() !== n.text && onPatch({ text })} className={clsx(inputCls, 'resize-none')} />
        </div>
        <div className={field}>
          <span className={label}>Kind</span>
          <KindPicker value={n.kind} onChange={(k) => k !== n.kind && onPatch({ kind: k })} />
          {isStandingNote(n) && <p className="mt-1 text-[11px] text-muted">{n.kind === 'rule' ? 'A standing rule. Maestro and agents follow it and ask you when a request goes against it.' : 'Something decided. Maestro and agents build on it and say when they do.'}</p>}
        </div>
        {n.kind === 'todo' && (
          <div className={field}>
            <span className={label}>Status</span>
            <div className="flex flex-wrap rounded-md border border-border bg-bg p-0.5 text-[12px]">
              {statuses.map((s) => (
                <button key={s.id} type="button" aria-pressed={st === s.id} onClick={() => onPatch({ status: s.id })} className={clsx('flex-1 rounded px-2 py-1', st === s.id ? `bg-panel-2 ${s.tone ?? 'text-accent'} font-medium` : 'text-muted hover:text-text')}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {!isStandingNote(n) && (
          <>
            <div className={field}>
              <span className={label}>
                <Flag size={9} className="mr-1 inline" />
                Priority
              </span>
              <div className="flex rounded-md border border-border bg-bg p-0.5 text-[12px]">
                {[...PRIORITY, { id: '' as NotePriority, label: 'None', cls: '' }].map((p) => (
                  <button key={p.id || 'none'} type="button" aria-pressed={(n.priority ?? '') === p.id} onClick={() => onPatch({ priority: (p.id || undefined) as NotePriority })} className={clsx('flex-1 rounded px-2 py-1', (n.priority ?? '') === p.id ? `bg-panel-2 font-medium ${p.id === 'high' ? 'text-danger' : p.id === 'medium' ? 'text-warn' : 'text-text'}` : 'text-muted hover:text-text')}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className={field}>
              <span className={label}>
                <CalendarDays size={9} className="mr-1 inline" />
                Due
              </span>
              <div className="flex items-center gap-2">
                <input type="date" aria-label="Due date" className={clsx(inputCls, 'w-44')} value={n.due ?? ''} onChange={(e) => onPatch({ due: e.target.value || undefined })} />
                {n.due && (
                  <button type="button" className="text-[11px] text-muted hover:text-text" onClick={() => onPatch({ due: undefined })}>
                    clear
                  </button>
                )}
              </div>
            </div>
          </>
        )}
        <div className={field}>
          <span className={label}>Tags</span>
          <input className={inputCls} aria-label="Tags" placeholder="comma separated" value={tags} onChange={(e) => setTags(e.target.value)} onBlur={() => onPatch({ tags: tags.split(',').map((t) => t.trim()).filter(Boolean) })} />
        </div>
        <div className={field}>
          <span className={label}>
            <ArrowRightLeft size={9} className="mr-1 inline" />
            Where
          </span>
          <PlaceSelect value={n.owner} onChange={(v) => v !== n.owner && onMove(v)} places={places} extraLabel={whereLabel} className={inputCls} />
        </div>
        <div className="text-[11px] text-muted">
          Created {new Date(n.createdAt).toLocaleString()} · changed {new Date(n.updatedAt).toLocaleString()}
          {!guided && ` · id ${n.id}`}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        {isWs && (
          <Button
            size="sm"
            variant="ghost"
            title={`Open the ${w.workspace} with this in its chat box`}
            onClick={() => {
              setChatDraft(n.owner, n.text)
              select(n.owner)
            }}
          >
            <MessageSquareShare size={12} /> To chat
          </Button>
        )}
        <span className="ml-auto" />
        {!n.archived && n.isDone && (
          <Button size="sm" variant="ghost" onClick={() => onArchive(true)}>
            <Archive size={12} /> Archive
          </Button>
        )}
        <Button size="sm" variant="danger" onClick={onRemove}>
          <Trash2 size={12} /> Delete
        </Button>
      </div>
    </aside>
  )
}

// ---------- summary ----------

function SummaryDialog({ filter, count, onClose }: { filter: NotesFilter; count: number; onClose: () => void }): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ code: string; message: string; detail?: string } | null>(null)
  const [lastQ, setLastQ] = useState<string | undefined>(undefined)
  const guided = useGuided()
  const openSettings = useApp((s) => s.openSettings)
  const run = async (q?: string): Promise<void> => {
    setBusy(true)
    setFailure(null)
    setLastQ(q)
    try {
      const r = await api.invoke('notes:summarize', filter, q)
      if ('error' in r) setFailure(r.error)
      else setResult(r.text)
    } catch (err) {
      setFailure({ code: 'other', message: 'The summary could not be written. Try again in a moment.', detail: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <Dialog title={`Summary of ${plural(count, 'note')}`} onClose={onClose} width={680}>
      <div className="max-h-[50vh] overflow-auto rounded-lg border border-border bg-bg p-3 text-[12px]">
        {busy && !result && (
          <div className="flex items-center gap-2 text-muted">
            <Loader2 size={14} className="animate-spin text-accent" /> Reading the notes shown…
          </div>
        )}
        {failure && (
          <div>
            <ErrorNote summary={failure.message} detail={guided ? undefined : failure.detail} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="sm" disabled={busy} onClick={() => void run(lastQ)}>
                Try again
              </Button>
              {(failure.code === 'auth' || failure.code === 'billing' || failure.code === 'limit') && (
                <Button size="sm" variant="ghost" onClick={() => openSettings({ scope: 'app', page: 'accounts' })}>
                  {guided ? 'Open Sign-in settings' : 'Open Settings → Accounts'}
                </Button>
              )}
            </div>
          </div>
        )}
        {result && <Markdown text={result} />}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <input
          className={inputCls}
          placeholder="Ask about them instead: what should I do first? what did the Slack agent add this week?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && question.trim() && !busy) void run(question.trim())
          }}
        />
        <Button size="sm" variant="primary" disabled={busy || !question.trim()} onClick={() => void run(question.trim())}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Ask
        </Button>
      </div>
    </Dialog>
  )
}

// ---------- the user's own statuses ----------

const TONES: { id: string; label: string }[] = [
  { id: 'text-accent', label: 'Blue' },
  { id: 'text-warn', label: 'Amber' },
  { id: 'text-ok', label: 'Green' },
  { id: 'text-danger', label: 'Red' },
  { id: 'text-muted', label: 'Grey' }
]

function StatusesDialog({ custom, onClose }: { custom: NoteStatusDef[]; onClose: () => void }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const [label, setLabel] = useState('')
  const [tone, setTone] = useState('text-accent')
  const save = (next: NoteStatusDef[]): void => {
    void api.invoke('settings:update', { noteStatuses: next }).catch((e) => setError(e))
  }
  const add = (): void => {
    const l = label.trim()
    if (!l) return
    const id = l
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (!id || BUILTIN_NOTE_STATUSES.some((b) => b.id === id) || custom.some((c) => c.id === id)) {
      setError('That status already exists.')
      return
    }
    save([...custom, { id, label: l, tone }])
    setLabel('')
  }
  return (
    <Dialog title="Todo statuses" onClose={onClose} width={520}>
      <p className="mb-3 text-[12px] text-muted">To do, In progress and Done are always there. Your own statuses go between In progress and Done, as board columns and in every status picker. Agents can use them by name.</p>
      <div className="rounded-lg border border-border">
        {BUILTIN_NOTE_STATUSES.slice(0, 2).map((b) => (
          <div key={b.id} className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[12px] text-muted">
            <span className={clsx('font-medium', b.tone)}>{b.label}</span>
            <span className="ml-auto text-[11px]">built in</span>
          </div>
        ))}
        {custom.map((c) => (
          <div key={c.id} className="group flex items-center gap-2 border-b border-border px-3 py-1.5 text-[12px]">
            <input className="min-w-0 flex-1 bg-transparent font-medium outline-none" defaultValue={c.label} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== c.label && save(custom.map((x) => (x.id === c.id ? { ...x, label: e.target.value.trim() } : x)))} />
            <select className="h-6 rounded-md border border-border bg-bg px-1 text-[11px]" value={c.tone ?? 'text-accent'} onChange={(e) => save(custom.map((x) => (x.id === c.id ? { ...x, tone: e.target.value } : x)))}>
              {TONES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <button className="rounded p-0.5 text-muted hover:text-danger" title="Remove (todos in it go back to To do on next edit)" onClick={() => save(custom.filter((x) => x.id !== c.id))}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-muted">
          <span className="font-medium text-ok">Done</span>
          <span className="ml-auto text-[11px]">built in</span>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <input
          className={inputCls}
          placeholder="New status, e.g. Blocked, Waiting, Review"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <select className="h-8 rounded-md border border-border bg-bg px-1 text-[12px]" value={tone} onChange={(e) => setTone(e.target.value)}>
          {TONES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <Button size="sm" variant="primary" disabled={!label.trim()} onClick={add}>
          <Plus size={12} /> Add
        </Button>
      </div>
    </Dialog>
  )
}
