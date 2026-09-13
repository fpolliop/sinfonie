import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { StickyNote, Sparkles, Loader2, Plus, Bot, User } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useNotes } from '@/stores/notes'
import { Markdown } from '@/lib/markdown'
import { Button, Dialog, inputCls } from './ui'
import { Row } from './NotesPanel'
import type { Note, NotesFilter } from '@shared/types'

const APP = 'app'
const SINCE_OPTIONS: { id: string; label: string; days?: number }[] = [
  { id: 'any', label: 'Any time' },
  { id: 'today', label: 'Today', days: 0 },
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 }
]

function sinceDate(id: string): string | undefined {
  const o = SINCE_OPTIONS.find((x) => x.id === id)
  if (!o || o.days === undefined) return undefined
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - o.days)
  return d.toISOString()
}

/**
 * Every note and todo in one place: the app's own, each space's, and each workspace's. Filter
 * by where it lives, who wrote it, kind, status and date; add at any level; ask Claude for a
 * summary or a question over the filtered set.
 */
export function NotesView(): React.JSX.Element {
  const byOwner = useNotes((s) => s.byWorkspace)
  const labels = useNotes((s) => s.labels)
  const { loadAll, subscribe, add, update, remove } = useNotes()
  const spaces = useApp((s) => s.spaces)
  const workspaces = useApp((s) => s.workspaces)
  const setError = useApp((s) => s.setError)
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
  useEffect(() => {
    subscribe()
    void loadAll().catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [loadAll, subscribe, setError])
  const go = (fn: () => Promise<void>): void => {
    fn().catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  const labelOf = (o: string): string => {
    if (o === APP) return 'App'
    if (o.startsWith('space:')) return `Space · ${spaces.find((s) => s.id === o.slice(6))?.name ?? 'deleted space'}`
    const ws = workspaces.find((w) => w.id === o)
    return ws ? `${ws.name}${ws.spaceId ? ` · ${spaces.find((s) => s.id === ws.spaceId)?.name ?? ''}` : ''}` : (labels[o] ?? 'deleted workspace')
  }
  // Owners to offer: the app, every space, every live workspace, plus anything that has notes.
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
  const groups = useMemo(() => {
    const out: { owner: string; notes: Note[] }[] = []
    for (const o of Object.keys(byOwner)) {
      if (owner !== 'all' && o !== owner) continue
      const list = (byOwner[o] ?? []).filter(
        (n) =>
          (source === 'all' || n.source === source) &&
          (kind === 'all' || n.kind === kind) &&
          (status === 'all' || (status === 'open' ? !(n.kind === 'todo' && n.done) : n.kind === 'todo' && n.done)) &&
          (!sinceMs || new Date(n.createdAt).getTime() >= sinceMs) &&
          (!q || n.text.toLowerCase().includes(q))
      )
      if (list.length) out.push({ owner: o, notes: [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) })
    }
    const rank = (o: string): number => (o === APP ? 0 : o.startsWith('space:') ? 1 : 2)
    return out.sort((a, b) => rank(a.owner) - rank(b.owner) || labelOf(a.owner).localeCompare(labelOf(b.owner)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byOwner, owner, source, kind, status, sinceMs, q, spaces, workspaces])
  const total = groups.reduce((n, g) => n + g.notes.length, 0)
  const openTotal = Object.values(byOwner).reduce((n, list) => n + list.filter((x) => x.kind === 'todo' && !x.done).length, 0)

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    const asTodo = /^(\[\s?\]|-\s\[\s?\])\s*/.test(t)
    const asNote = /^(note:|#)\s*/i.test(t)
    const clean = t.replace(/^(\[\s?\]|-\s\[\s?\]|note:|#)\s*/i, '')
    go(() => add(addOwner, clean, asTodo ? 'todo' : asNote ? 'note' : addKind))
    setText('')
  }
  const select = 'h-7 rounded-md border border-border bg-bg px-1.5 text-[12px]'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-4">
        <StickyNote size={16} className="text-accent" />
        <span className="text-[13px] font-semibold">Notes</span>
        <span className="text-[11px] text-muted">{openTotal ? `${openTotal} open todo${openTotal === 1 ? '' : 's'}` : 'nothing open'}</span>
        <div className="no-drag ml-auto flex items-center gap-2">
          <Button size="sm" variant="primary" onClick={() => setSummary(true)} disabled={total === 0} title="Claude summarises the notes shown, or answers a question about them">
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
          <option value="all">Todos and notes</option>
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
        <input className={clsx(inputCls, 'h-7 w-56 py-0')} placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="ml-auto text-[11px] text-muted">{total} shown</span>
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
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {groups.length === 0 && (
          <div className="mx-auto mt-10 max-w-md rounded-md border border-dashed border-border p-4 text-center text-[12px] text-muted">
            {Object.values(byOwner).some((l) => l.length) ? 'Nothing matches these filters.' : 'Nothing yet. Add a todo above, jot notes in a workspace, or let an agent file what it finds: an agent can write to the app, a space or a workspace.'}
          </div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {groups.map((g) => (
            <section key={g.owner}>
              <div className="mb-1 flex items-center gap-2 px-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{labelOf(g.owner)}</span>
                <span className="text-[10px] text-muted">{g.notes.length}</span>
                <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted">
                  {g.notes.some((n) => n.source === 'agent') && <Bot size={10} />}
                  {g.notes.some((n) => n.source === 'user') && <User size={10} />}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {g.notes.map((n) => (
                  <Row key={n.id} note={n} workspaceId={g.owner === APP || g.owner.startsWith('space:') ? undefined : g.owner} onUpdate={(p) => go(() => update(g.owner, n.id, p))} onRemove={() => go(() => remove(g.owner, n.id))} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
      {summary && <SummaryDialog filter={filter} count={total} onClose={() => setSummary(false)} />}
    </div>
  )
}

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
