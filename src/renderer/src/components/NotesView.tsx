import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { StickyNote, Sparkles, Loader2, Plus, Bot, User, LayoutList, Columns3, Check, Trash2, X, Flag, CalendarDays, ArrowRightLeft, MessageSquareShare, Settings2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useNotes } from '@/stores/notes'
import { useChat } from '@/stores/chat'
import { Markdown } from '@/lib/markdown'
import { Button, Dialog, inputCls } from './ui'
import { noteStatus, noteStatuses, BUILTIN_NOTE_STATUSES, type Note, type NotePatch, type NotePriority, type NoteStatus, type NoteStatusDef, type NotesFilter } from '@shared/types'

const APP = 'app'
const SINCE_OPTIONS: { id: string; label: string; days?: number }[] = [
  { id: 'any', label: 'Any time' },
  { id: 'today', label: 'Today', days: 0 },
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 }
]
const PRIORITY: { id: NotePriority; label: string; cls: string }[] = [
  { id: 'high', label: 'High', cls: 'bg-danger/15 text-danger' },
  { id: 'medium', label: 'Medium', cls: 'bg-warn/15 text-warn' },
  { id: 'low', label: 'Low', cls: 'bg-panel-2 text-muted' }
]
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }
type Located = Note & { owner: string }
type GroupBy = 'status' | 'owner' | 'priority'
type Sort = 'created' | 'due' | 'priority' | 'updated'

function sinceDate(id: string): string | undefined {
  const o = SINCE_OPTIONS.find((x) => x.id === id)
  if (!o || o.days === undefined) return undefined
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - o.days)
  return d.toISOString()
}
const today = (): string => new Date().toISOString().slice(0, 10)
const overdue = (n: Note): boolean => Boolean(n.due && n.due < today() && noteStatus(n) !== 'done')
const isSpace = (o: string): boolean => o.startsWith('space:')

/**
 * Every note and todo in one place, as a list or a board. Filter by where it lives, who wrote it,
 * kind, status and date; drag cards between columns; open one for status, priority, due date and
 * moving it elsewhere; ask Claude for a summary of what is shown.
 */
export function NotesView(): React.JSX.Element {
  const byOwner = useNotes((s) => s.byWorkspace)
  const labels = useNotes((s) => s.labels)
  const { loadAll, subscribe, add, update, remove, move } = useNotes()
  const spaces = useApp((s) => s.spaces)
  const workspaces = useApp((s) => s.workspaces)
  const setError = useApp((s) => s.setError)
  const customStatuses = useApp((s) => s.settings.noteStatuses)
  const statuses = useMemo(() => noteStatuses(customStatuses), [customStatuses])
  const [statusesDlg, setStatusesDlg] = useState(false)
  const [view, setView] = useState<'list' | 'board'>(() => (localStorage.getItem('sinfonie.notes.view') as 'list' | 'board') || 'board')
  const [groupBy, setGroupBy] = useState<GroupBy>(() => (localStorage.getItem('sinfonie.notes.groupBy') as GroupBy) || 'status')
  const [sort, setSort] = useState<Sort>('created')
  const [owner, setOwner] = useState<string>('all')
  const [source, setSource] = useState<'all' | Note['source']>('all')
  const [kind, setKind] = useState<'all' | Note['kind']>('all')
  const [status, setStatus] = useState<'open' | 'done' | 'all'>('open')
  const [since, setSince] = useState('any')
  const [query, setQuery] = useState('')
  const [text, setText] = useState('')
  const [addKind, setAddKind] = useState<Note['kind']>('todo')
  const [addOwner, setAddOwner] = useState(APP)
  const [summary, setSummary] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  useEffect(() => {
    subscribe()
    void loadAll().catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [loadAll, subscribe, setError])
  useEffect(() => localStorage.setItem('sinfonie.notes.view', view), [view])
  useEffect(() => localStorage.setItem('sinfonie.notes.groupBy', groupBy), [groupBy])
  const go = (fn: () => Promise<void>): void => {
    fn().catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  const labelOf = (o: string): string => {
    if (o === APP) return 'App'
    if (isSpace(o)) return `Space · ${spaces.find((s) => s.id === o.slice(6))?.name ?? 'deleted space'}`
    const ws = workspaces.find((w) => w.id === o)
    return ws ? `${ws.name}${ws.spaceId ? ` · ${spaces.find((s) => s.id === ws.spaceId)?.name ?? ''}` : ''}` : (labels[o] ?? 'deleted workspace')
  }
  const owners = useMemo(() => {
    const ids = new Set<string>([APP, ...spaces.map((s) => `space:${s.id}`), ...workspaces.filter((w) => w.status !== 'archived').map((w) => w.id), ...Object.keys(byOwner).filter((o) => byOwner[o]?.length)])
    return [...ids]
  }, [spaces, workspaces, byOwner])

  const filter: NotesFilter = useMemo(
    () => ({
      ...(owner !== 'all' ? { owners: [owner] } : {}),
      ...(source !== 'all' ? { source } : {}),
      ...(kind !== 'all' ? { kind } : {}),
      ...(status === 'open' ? { openOnly: true } : {}),
      ...(sinceDate(since) ? { since: sinceDate(since) } : {}),
      ...(query.trim() ? { query: query.trim() } : {})
    }),
    [owner, source, kind, status, since, query]
  )
  const sinceMs = sinceDate(since) ? new Date(sinceDate(since)!).getTime() : 0
  const q = query.trim().toLowerCase()
  const shown: Located[] = useMemo(() => {
    const out: Located[] = []
    for (const o of Object.keys(byOwner)) {
      if (owner !== 'all' && o !== owner) continue
      for (const n of byOwner[o] ?? []) {
        const st = noteStatus(n)
        if (source !== 'all' && n.source !== source) continue
        if (kind !== 'all' && n.kind !== kind) continue
        const boardByStatus = view === 'board' && groupBy === 'status'
        if (!boardByStatus && status === 'open' && n.kind === 'todo' && st === 'done') continue
        if (!boardByStatus && status === 'done' && !(n.kind === 'todo' && st === 'done')) continue
        if (sinceMs && new Date(n.createdAt).getTime() < sinceMs) continue
        if (q && !n.text.toLowerCase().includes(q)) continue
        out.push({ ...n, owner: o })
      }
    }
    const cmp = (a: Located, b: Located): number => {
      if (sort === 'due') return (a.due ?? '9999').localeCompare(b.due ?? '9999') || b.createdAt.localeCompare(a.createdAt)
      if (sort === 'priority') return (PRIORITY_RANK[a.priority ?? 'zz'] ?? 3) - (PRIORITY_RANK[b.priority ?? 'zz'] ?? 3) || b.createdAt.localeCompare(a.createdAt)
      if (sort === 'updated') return b.updatedAt.localeCompare(a.updatedAt)
      return b.createdAt.localeCompare(a.createdAt)
    }
    return out.sort(cmp)
  }, [byOwner, owner, source, kind, status, sinceMs, q, sort, view, groupBy])
  const openTotal = Object.values(byOwner).reduce((n, list) => n + list.filter((x) => x.kind === 'todo' && noteStatus(x) !== 'done').length, 0)
  const opened = openId ? shown.find((n) => n.id === openId) ?? null : null

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    const asTodo = /^(\[\s?\]|-\s\[\s?\])\s*/.test(t)
    const asNote = /^(note:|#)\s*/i.test(t)
    const clean = t.replace(/^(\[\s?\]|-\s\[\s?\]|note:|#)\s*/i, '')
    go(() => add(addOwner, clean, asTodo ? 'todo' : asNote ? 'note' : addKind))
    setText('')
  }
  const patch = (n: Located, p: NotePatch): void => go(() => update(n.owner, n.id, p))
  const select = 'h-7 rounded-md border border-border bg-bg px-1.5 text-[12px]'

  // Board columns for the chosen grouping.
  const columns: { id: string; label: string; notes: Located[]; drop?: (n: Located) => void }[] = useMemo(() => {
    if (groupBy === 'status') return statuses.map((s) => ({ id: s.id, label: s.label, notes: shown.filter((n) => (n.kind === 'note' ? s.id === 'todo' : noteStatus(n) === s.id)), drop: (n) => patch(n, { status: s.id, ...(n.kind === 'note' ? { kind: 'todo' as const } : {}) }) }))
    if (groupBy === 'priority') return [...PRIORITY.map((p) => ({ id: p.id, label: p.label, notes: shown.filter((n) => n.priority === p.id), drop: (n: Located) => patch(n, { priority: p.id }) })), { id: 'none', label: 'No priority', notes: shown.filter((n) => !n.priority), drop: (n: Located) => patch(n, { priority: undefined as unknown as NotePriority }) }]
    const ids = [...new Set([...(owner === 'all' ? owners.filter((o) => o === APP || isSpace(o) || shown.some((n) => n.owner === o)) : [owner]), ...shown.map((n) => n.owner)])]
    return ids.map((o) => ({ id: o, label: labelOf(o), notes: shown.filter((n) => n.owner === o), drop: (n: Located) => n.owner !== o && go(() => move(n.owner, n.id, o)) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupBy, shown, status, owner, owners, spaces, workspaces, statuses])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-4">
        <StickyNote size={16} className="text-accent" />
        <span className="text-[13px] font-semibold">Todos &amp; notes</span>
        <span className="text-[11px] text-muted">{openTotal ? `${openTotal} open todo${openTotal === 1 ? '' : 's'}` : 'nothing open'}</span>
        <div className="no-drag ml-auto flex items-center gap-2">
          <div className="flex rounded-md bg-panel p-0.5">
            {(
              [
                ['board', 'Board', <Columns3 key="b" size={12} />],
                ['list', 'List', <LayoutList key="l" size={12} />]
              ] as const
            ).map(([id, label, icon]) => (
              <button key={id} onClick={() => setView(id)} className={clsx('flex items-center gap-1 rounded px-2 py-0.5 text-[12px]', view === id ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
                {icon} {label}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setStatusesDlg(true)} title="Your own statuses, as board columns">
            <Settings2 size={12} /> Statuses
          </Button>
          <Button size="sm" variant="primary" onClick={() => setSummary(true)} disabled={shown.length === 0} title="Claude summarises the notes shown, or answers a question about them">
            <Sparkles size={12} /> Summarise
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <select className={select} value={owner} onChange={(e) => setOwner(e.target.value)} title="Where the note lives">
          <option value="all">Everywhere</option>
          {owners.map((o) => (
            <option key={o} value={o}>
              {labelOf(o)}
            </option>
          ))}
        </select>
        <select className={select} value={source} onChange={(e) => setSource(e.target.value as typeof source)} title="Who wrote it">
          <option value="all">Anyone</option>
          <option value="user">Me</option>
          <option value="agent">Agents</option>
        </select>
        <select className={select} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="all">Todos &amp; notes</option>
          <option value="todo">Todos</option>
          <option value="note">Notes</option>
        </select>
        <select className={select} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="all">Open and done</option>
        </select>
        <select className={select} value={since} onChange={(e) => setSince(e.target.value)} title="Created since">
          {SINCE_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <input className={clsx(inputCls, 'h-7 w-48 py-0')} placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="ml-auto flex items-center gap-2 text-[11px] text-muted">
          {view === 'board' ? (
            <>
              Columns
              <select className={select} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                <option value="status">by status</option>
                <option value="owner">by where</option>
                <option value="priority">by priority</option>
              </select>
            </>
          ) : (
            <>
              Sort
              <select className={select} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="created">newest</option>
                <option value="updated">last changed</option>
                <option value="due">due date</option>
                <option value="priority">priority</option>
              </select>
            </>
          )}
          <span>{shown.length} shown</span>
        </span>
      </div>
      <div className="border-b border-border px-4 py-2">
        <div className="rounded-lg border border-border bg-bg focus-within:border-accent">
          <textarea
            value={text}
            rows={1}
            placeholder={addKind === 'todo' ? 'Something to do… (Enter adds)' : 'A note to keep… (Enter adds)'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            className="w-full resize-none bg-transparent px-2.5 pt-2 text-[12px] outline-none placeholder:text-muted"
          />
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            {(['todo', 'note'] as const).map((k) => (
              <button key={k} onClick={() => setAddKind(k)} className={clsx('rounded-md px-1.5 py-0.5 text-[11px]', addKind === k ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
                {k === 'todo' ? 'Todo' : 'Note'}
              </button>
            ))}
            <span className="text-[11px] text-muted">in</span>
            <select className="h-6 rounded-md border border-border bg-bg px-1 text-[11px]" value={addOwner} onChange={(e) => setAddOwner(e.target.value)}>
              {owners.map((o) => (
                <option key={o} value={o}>
                  {labelOf(o)}
                </option>
              ))}
            </select>
            <span className="ml-auto" />
            <Button size="sm" variant="ghost" onClick={submit} disabled={!text.trim()}>
              <Plus size={12} /> Add
            </Button>
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {shown.length === 0 && (
            <div className="mx-auto mt-10 max-w-md rounded-md border border-dashed border-border p-4 text-center text-[12px] text-muted">
              {Object.values(byOwner).some((l) => l.length) ? 'Nothing matches these filters.' : 'Nothing yet. Add a todo above, jot notes in a workspace, or let an agent file what it finds.'}
            </div>
          )}
          {shown.length > 0 && view === 'board' && <Board columns={columns} openId={openId} onOpen={setOpenId} labelOf={labelOf} statuses={statuses} />}
          {shown.length > 0 && view === 'list' && <List notes={shown} openId={openId} onOpen={setOpenId} labelOf={labelOf} onPatch={patch} statuses={statuses} />}
        </div>
        {opened && <Detail note={opened} owners={owners} labelOf={labelOf} statuses={statuses} onPatch={(p) => patch(opened, p)} onMove={(to) => go(() => move(opened.owner, opened.id, to))} onRemove={() => (setOpenId(null), go(() => remove(opened.owner, opened.id)))} onClose={() => setOpenId(null)} />}
      </div>
      {summary && <SummaryDialog filter={filter} count={shown.length} onClose={() => setSummary(false)} />}
      {statusesDlg && <StatusesDialog custom={customStatuses ?? []} onClose={() => setStatusesDlg(false)} />}
    </div>
  )
}

// ---------- board ----------

function Board({ columns, openId, onOpen, labelOf, statuses }: { columns: { id: string; label: string; notes: Located[]; drop?: (n: Located) => void }[]; openId: string | null; onOpen: (id: string) => void; labelOf: (o: string) => string; statuses: NoteStatusDef[] }): React.JSX.Element {
  const [dragging, setDragging] = useState<Located | null>(null)
  const [over, setOver] = useState<string | null>(null)
  return (
    <div className="flex h-full min-w-max gap-3 px-4 py-3">
      {columns.map((c) => (
        <div
          key={c.id}
          className={clsx('flex w-[280px] shrink-0 flex-col rounded-xl border bg-panel/40', over === c.id && dragging ? 'border-accent/60 bg-accent/5' : 'border-border')}
          onDragOver={(e) => {
            if (!dragging || !c.drop) return
            e.preventDefault()
            setOver(c.id)
          }}
          onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
          onDrop={(e) => {
            e.preventDefault()
            if (dragging && c.drop) c.drop(dragging)
            setDragging(null)
            setOver(null)
          }}
        >
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{c.label}</span>
            <span className="rounded-full bg-panel-2 px-1.5 text-[10px] text-muted">{c.notes.length}</span>
          </div>
          <div className="flex min-h-[80px] flex-1 flex-col gap-2 overflow-auto px-2 pb-2">
            {c.notes.map((n) => (
              <Card key={`${n.owner}:${n.id}`} note={n} selected={n.id === openId} labelOf={labelOf} statuses={statuses} onOpen={() => onOpen(n.id)} onDragStart={() => setDragging(n)} onDragEnd={() => (setDragging(null), setOver(null))} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function Card({ note: n, selected, labelOf, statuses, onOpen, onDragStart, onDragEnd }: { note: Located; selected: boolean; labelOf: (o: string) => string; statuses: NoteStatusDef[]; onOpen: () => void; onDragStart: () => void; onDragEnd: () => void }): React.JSX.Element {
  const st = noteStatus(n)
  const stDef = statuses.find((s) => s.id === st)
  return (
    <div draggable onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={onOpen} className={clsx('cursor-pointer rounded-lg border bg-bg px-3 py-2 text-[12px] shadow-sm hover:border-accent/60', selected ? 'border-accent' : 'border-border', st === 'done' && 'opacity-60')}>
      <div className={clsx('whitespace-pre-wrap break-words', st === 'done' && 'line-through')}>{n.text.length > 220 ? `${n.text.slice(0, 220)}…` : n.text}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
        {n.kind === 'note' ? <StickyNote size={10} /> : st !== 'todo' && st !== 'done' ? <span className={clsx('rounded bg-panel-2 px-1', stDef?.tone ?? 'text-accent')}>{stDef?.label ?? st}</span> : null}
        {n.priority && <span className={clsx('rounded px-1', PRIORITY.find((p) => p.id === n.priority)?.cls)}>{n.priority}</span>}
        {n.due && (
          <span className={clsx('inline-flex items-center gap-0.5', overdue(n) && 'text-danger')}>
            <CalendarDays size={9} /> {n.due}
          </span>
        )}
        <span className="truncate">{labelOf(n.owner)}</span>
        <span className="ml-auto inline-flex items-center gap-0.5">{n.source === 'agent' ? <Bot size={9} /> : <User size={9} />}</span>
      </div>
    </div>
  )
}

// ---------- list ----------

function List({ notes, openId, onOpen, labelOf, onPatch, statuses }: { notes: Located[]; openId: string | null; onOpen: (id: string) => void; labelOf: (o: string) => string; onPatch: (n: Located, p: NotePatch) => void; statuses: NoteStatusDef[] }): React.JSX.Element {
  return (
    <div className="px-4 py-2">
      <div className="grid grid-cols-[24px_1fr_110px_90px_90px_150px_70px] items-center gap-2 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
        <span />
        <span>Item</span>
        <span>Status</span>
        <span>Priority</span>
        <span>Due</span>
        <span>Where</span>
        <span>Created</span>
      </div>
      <div className="flex flex-col">
        {notes.map((n) => {
          const st = noteStatus(n)
          return (
            <div key={`${n.owner}:${n.id}`} onClick={() => onOpen(n.id)} className={clsx('grid cursor-pointer grid-cols-[24px_1fr_110px_90px_90px_150px_70px] items-center gap-2 rounded-md border-b border-border/60 px-2 py-1.5 text-[12px] hover:bg-panel-2/60', n.id === openId && 'bg-panel-2', st === 'done' && 'opacity-60')}>
              {n.kind === 'todo' ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onPatch(n, { status: st === 'done' ? 'todo' : 'done' })
                  }}
                  className={clsx('flex h-3.5 w-3.5 items-center justify-center rounded border', st === 'done' ? 'border-ok bg-ok/20 text-ok' : 'border-muted hover:border-accent')}
                >
                  {st === 'done' && <Check size={9} />}
                </button>
              ) : (
                <StickyNote size={12} className="text-muted" />
              )}
              <span className={clsx('truncate', st === 'done' && 'line-through')} title={n.text}>
                {n.text}
              </span>
              <span onClick={(e) => e.stopPropagation()}>
                {n.kind === 'todo' ? (
                  <select className="h-6 w-full rounded-md border border-border bg-bg px-1 text-[11px]" value={st} onChange={(e) => onPatch(n, { status: e.target.value as NoteStatus })}>
                    {statuses.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-[11px] text-muted">note</span>
                )}
              </span>
              <span onClick={(e) => e.stopPropagation()}>
                <select className="h-6 w-full rounded-md border border-border bg-bg px-1 text-[11px]" value={n.priority ?? ''} onChange={(e) => onPatch(n, { priority: (e.target.value || undefined) as NotePriority })}>
                  <option value="">—</option>
                  {PRIORITY.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </span>
              <span className={clsx('text-[11px]', overdue(n) ? 'text-danger' : 'text-muted')}>{n.due ?? '—'}</span>
              <span className="truncate text-[11px] text-muted" title={labelOf(n.owner)}>
                {labelOf(n.owner)}
              </span>
              <span className="text-[11px] text-muted" title={n.createdAt}>
                {new Date(n.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------- detail drawer ----------

function Detail({ note: n, owners, labelOf, statuses, onPatch, onMove, onRemove, onClose }: { note: Located; owners: string[]; labelOf: (o: string) => string; statuses: NoteStatusDef[]; onPatch: (p: NotePatch) => void; onMove: (to: string) => void; onRemove: () => void; onClose: () => void }): React.JSX.Element {
  const [text, setText] = useState(n.text)
  const [tags, setTags] = useState((n.tags ?? []).join(', '))
  const setChatDraft = useChat((s) => s.setDraft)
  const select = useApp((s) => s.select)
  useEffect(() => {
    setText(n.text)
    setTags((n.tags ?? []).join(', '))
  }, [n.id, n.text, n.tags])
  const st = noteStatus(n)
  const isWs = n.owner !== APP && !isSpace(n.owner)
  const field = 'mb-3'
  const label = 'mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted'
  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[12px] font-semibold">{n.kind === 'todo' ? 'Todo' : 'Note'}</span>
        <span className="inline-flex items-center gap-1 text-[10px] text-muted">{n.source === 'agent' ? <Bot size={10} /> : <User size={10} />} {n.source === 'agent' ? 'by an agent' : 'by you'}</span>
        <button className="ml-auto text-muted hover:text-text" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        <div className={field}>
          <textarea value={text} rows={Math.min(10, Math.max(3, text.split('\n').length + 1))} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() && text.trim() !== n.text && onPatch({ text })} className={clsx(inputCls, 'resize-none')} />
        </div>
        {n.kind === 'todo' && (
          <div className={field}>
            <span className={label}>Status</span>
            <div className="flex flex-wrap rounded-md border border-border bg-bg p-0.5 text-[12px]">
              {statuses.map((s) => (
                <button key={s.id} onClick={() => onPatch({ status: s.id })} className={clsx('flex-1 rounded px-2 py-1', st === s.id ? `bg-panel-2 ${s.tone ?? 'text-accent'} font-medium` : 'text-muted hover:text-text')}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className={field}>
          <span className={label}>
            <Flag size={9} className="mr-1 inline" />
            Priority
          </span>
          <div className="flex rounded-md border border-border bg-bg p-0.5 text-[12px]">
            {[...PRIORITY, { id: '' as NotePriority, label: 'None', cls: '' }].map((p) => (
              <button key={p.id || 'none'} onClick={() => onPatch({ priority: (p.id || undefined) as NotePriority })} className={clsx('flex-1 rounded px-2 py-1', (n.priority ?? '') === p.id ? `bg-panel-2 font-medium ${p.id === 'high' ? 'text-danger' : p.id === 'medium' ? 'text-warn' : 'text-text'}` : 'text-muted hover:text-text')}>
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
            <input type="date" className={clsx(inputCls, 'w-44')} value={n.due ?? ''} onChange={(e) => onPatch({ due: e.target.value || undefined })} />
            {n.due && (
              <button className="text-[11px] text-muted hover:text-text" onClick={() => onPatch({ due: undefined })}>
                clear
              </button>
            )}
          </div>
        </div>
        <div className={field}>
          <span className={label}>Tags</span>
          <input className={inputCls} placeholder="comma separated" value={tags} onChange={(e) => setTags(e.target.value)} onBlur={() => onPatch({ tags: tags.split(',').map((t) => t.trim()).filter(Boolean) })} />
        </div>
        <div className={field}>
          <span className={label}>
            <ArrowRightLeft size={9} className="mr-1 inline" />
            Where
          </span>
          <select className={inputCls} value={n.owner} onChange={(e) => e.target.value !== n.owner && onMove(e.target.value)}>
            {[...new Set([n.owner, ...owners])].map((o) => (
              <option key={o} value={o}>
                {labelOf(o)}
              </option>
            ))}
          </select>
        </div>
        <div className="text-[10px] text-muted">
          Created {new Date(n.createdAt).toLocaleString()} · changed {new Date(n.updatedAt).toLocaleString()} · id {n.id}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        {isWs && (
          <Button
            size="sm"
            variant="ghost"
            title="Open the workspace with this in its chat box"
            onClick={() => {
              setChatDraft(n.owner, n.text)
              select(n.owner)
            }}
          >
            <MessageSquareShare size={12} /> To chat
          </Button>
        )}
        <span className="ml-auto" />
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
  const [error, setError] = useState<string | null>(null)
  const run = async (q?: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setResult(await api.invoke('notes:summarize', filter, q))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <Dialog title={`Summary of ${count} note${count === 1 ? '' : 's'}`} onClose={onClose} width={680}>
      <div className="max-h-[50vh] overflow-auto rounded-lg border border-border bg-bg p-3 text-[12px]">
        {busy && !result && (
          <div className="flex items-center gap-2 text-muted">
            <Loader2 size={14} className="animate-spin text-accent" /> Reading the notes shown…
          </div>
        )}
        {error && <div className="text-danger">{error}</div>}
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
    void api.invoke('settings:update', { noteStatuses: next }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
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
            <span className="ml-auto text-[10px]">built in</span>
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
          <span className="ml-auto text-[10px]">built in</span>
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
