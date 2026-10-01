import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Bot, Check, ChevronDown, ChevronRight, MessageSquareShare, Scale, ShieldCheck, StickyNote, Trash2, X } from 'lucide-react'
import { useNotes } from '@/stores/notes'
import { useChat } from '@/stores/chat'
import { useApp } from '@/stores/app'
import { isStandingNote, noteStatuses, type Note, type NotePatch } from '@shared/types'
import { IconButton } from './ui'

const EMPTY: Note[] = []

/** The four kinds, in picker order, with what the composer asks for. Shared with the Notes view. */
export const NOTE_KINDS: { id: Note['kind']; label: string; placeholder: string }[] = [
  { id: 'todo', label: 'Todo', placeholder: 'Something to do… (Enter adds)' },
  { id: 'note', label: 'Note', placeholder: 'A note to keep… (Enter adds)' },
  { id: 'decision', label: 'Decision', placeholder: 'Something decided, e.g. legacy tiers keep the 2023 table until Q1 (Enter adds)' },
  { id: 'rule', label: 'Rule', placeholder: 'A standing rule, e.g. staging changes are fine; production needs a person (Enter adds)' }
]

/**
 * A leading "[] " or "- [ ] " means todo, "# " or "note:" note, "decision:" decision, "rule:" rule;
 * otherwise the picked kind decides. Returns the kind and the text without the prefix.
 */
export function parseNoteInput(t: string, picked: Note['kind']): { kind: Note['kind']; text: string } {
  const m = /^(\[\s?\]|-\s\[\s?\]|note:|#|decision:|rule:)\s*/i.exec(t)
  if (!m) return { kind: picked, text: t }
  const p = m[1].toLowerCase()
  const kind: Note['kind'] = p === 'decision:' ? 'decision' : p === 'rule:' ? 'rule' : p === 'note:' || p === '#' ? 'note' : 'todo'
  return { kind, text: t.slice(m[0].length) }
}

/** The kind picker under a composer: one button per kind, Tab-reachable, pressed state announced. */
export function KindPicker({ value, onChange }: { value: Note['kind']; onChange: (k: Note['kind']) => void }): React.JSX.Element {
  return (
    <div role="group" aria-label="Kind" className="flex items-center gap-1">
      {NOTE_KINDS.map((k) => (
        <button
          key={k.id}
          type="button"
          aria-pressed={value === k.id}
          onClick={() => onChange(k.id)}
          className={clsx('rounded-md px-1.5 py-0.5 text-[11px]', value === k.id ? (k.id === 'decision' || k.id === 'rule' ? 'bg-maestro/15 text-maestro' : 'bg-panel-2 text-text') : 'text-muted hover:text-text')}
        >
          {k.label}
        </button>
      ))}
    </div>
  )
}

/** "Decision" or "Rule", in Maestro's colour: these are what Maestro answers and acts with. */
export function KindChip({ kind }: { kind: Note['kind'] }): React.JSX.Element | null {
  if (kind !== 'decision' && kind !== 'rule') return null
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-maestro/15 px-1 text-[11px] font-medium text-maestro">
      {kind === 'rule' ? <ShieldCheck size={10} /> : <Scale size={10} />}
      {kind === 'rule' ? 'Rule' : 'Decision'}
    </span>
  )
}

/** Notes, reminders and todos for one workspace. The orchestrator sees and edits the same list. */
export function NotesPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): React.JSX.Element {
  const notes = useNotes((s) => s.byWorkspace[workspaceId]) ?? EMPTY
  const { load, add, update, remove, subscribe } = useNotes()
  const setError = useApp((s) => s.setError)
  const setView = useApp((s) => s.setView)
  const [text, setText] = useState('')
  const [kind, setKind] = useState<Note['kind']>('todo')
  const [showDone, setShowDone] = useState(false)
  useEffect(() => {
    subscribe()
    void load(workspaceId).catch((e) => setError(e))
  }, [workspaceId, load, subscribe, setError])
  const go = (fn: () => Promise<void>): void => {
    fn().catch((e) => setError(e))
  }
  // Delete waits for the Undo window: the note is hidden at once and removed for real when the toast closes.
  const notify = useApp((s) => s.notify)
  const [hiding, setHiding] = useState<Set<string>>(() => new Set())
  const removeLater = (n: Note): void => {
    setHiding((h) => new Set(h).add(n.id))
    const timer = setTimeout(() => go(() => remove(workspaceId, n.id)), 6500)
    notify({
      kind: 'info',
      text: `Deleted “${n.text.length > 40 ? `${n.text.slice(0, 40)}…` : n.text}”`,
      undo: () => {
        clearTimeout(timer)
        setHiding((h) => {
          const next = new Set(h)
          next.delete(n.id)
          return next
        })
      }
    })
  }
  const visible = useMemo(() => notes.filter((n) => !hiding.has(n.id) && !n.archived), [notes, hiding])
  const open = useMemo(() => visible.filter((n) => n.kind === 'todo' && !n.done), [visible])
  const plain = useMemo(() => visible.filter((n) => n.kind === 'note'), [visible])
  // Rules first, then decisions, newest first.
  const standing = useMemo(() => visible.filter(isStandingNote).sort((a, b) => (a.kind === b.kind ? b.createdAt.localeCompare(a.createdAt) : a.kind === 'rule' ? -1 : 1)), [visible])
  const done = useMemo(() => visible.filter((n) => n.kind === 'todo' && n.done), [visible])
  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    const parsed = parseNoteInput(t, kind)
    if (!parsed.text.trim()) return
    // The text stays in the box until the note is saved, so a failed add loses nothing.
    add(workspaceId, parsed.text, parsed.kind)
      .then(() => setText((cur) => (cur.trim() === t ? '' : cur)))
      .catch((e) => setError(e))
  }
  return (
    <aside className="flex w-[380px] max-w-[55%] shrink-0 flex-col border-l border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <StickyNote size={14} className="text-accent" />
        <span className="text-[13px] font-semibold">Notes</span>
        <span className="text-[11px] text-muted">{open.length ? `${open.length} open` : visible.length ? 'nothing open' : ''}</span>
        <button className="ml-auto text-[11px] text-muted hover:text-text" title="Every note across workspaces, spaces and the app" onClick={() => setView('notes')}>
          All todos &amp; notes
        </button>
        <IconButton label="Close notes" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="border-b border-border p-2">
        <div className="rounded-lg border border-border bg-bg focus-within:border-accent">
          <textarea
            value={text}
            rows={2}
            placeholder={NOTE_KINDS.find((k) => k.id === kind)?.placeholder}
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
            <KindPicker value={kind} onChange={setKind} />
            <span className="ml-auto truncate text-[11px] text-muted">{kind === 'rule' ? 'Agents and Maestro follow rules.' : kind === 'decision' ? 'Agents and Maestro build on decisions.' : 'The agent reads these and can add its own.'}</span>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-2">
        {visible.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-3 text-center text-[12px] text-muted">
            Nothing yet. Jot down what to pick up later, or ask the agent to “remember” something and it lands here.
          </div>
        )}
        {open.length > 0 && <Section title="To do">{open.map((n) => <Row key={n.id} note={n} workspaceId={workspaceId} onUpdate={(p) => go(() => update(workspaceId, n.id, p))} onRemove={() => removeLater(n)} />)}</Section>}
        {standing.length > 0 && (
          <Section title="Decisions and rules" hint="Maestro answers and acts with these." maestro>
            {standing.map((n) => (
              <Row key={n.id} note={n} workspaceId={workspaceId} onUpdate={(p) => go(() => update(workspaceId, n.id, p))} onRemove={() => removeLater(n)} />
            ))}
          </Section>
        )}
        {plain.length > 0 && <Section title="Notes">{plain.map((n) => <Row key={n.id} note={n} workspaceId={workspaceId} onUpdate={(p) => go(() => update(workspaceId, n.id, p))} onRemove={() => removeLater(n)} />)}</Section>}
        {done.length > 0 && (
          <div className="mt-2">
            <button className="flex items-center gap-1 px-1 text-[11px] font-medium uppercase tracking-wide text-muted hover:text-text" onClick={() => setShowDone(!showDone)}>
              {showDone ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Done · {done.length}
            </button>
            {showDone && done.map((n) => <Row key={n.id} note={n} workspaceId={workspaceId} onUpdate={(p) => go(() => update(workspaceId, n.id, p))} onRemove={() => removeLater(n)} />)}
          </div>
        )}
      </div>
    </aside>
  )
}

function Section({ title, hint, maestro, children }: { title: string; hint?: string; maestro?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-2">
      <div className={clsx('px-1 text-[11px] font-medium uppercase tracking-wide', maestro ? 'text-maestro' : 'text-muted')}>{title}</div>
      {hint && <div className="px-1 text-[11px] text-muted">{hint}</div>}
      <div className="mt-1 flex flex-col gap-1">{children}</div>
    </div>
  )
}

/** One note. `workspaceId` enables the "put in the chat box" action; owners that are not workspaces omit it. */
export function Row({ note, workspaceId, onUpdate, onRemove }: { note: Note; workspaceId?: string; onUpdate: (p: NotePatch) => void; onRemove: () => void }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.text)
  const setChatDraft = useChat((s) => s.setDraft)
  const chatDraft = useChat((s) => (workspaceId ? s.chats[workspaceId]?.draft : '') ?? '')
  const save = (): void => {
    setEditing(false)
    if (draft.trim() && draft.trim() !== note.text) onUpdate({ text: draft })
    else setDraft(note.text)
  }
  return (
    <div className={clsx('group flex items-start gap-2 rounded-md border px-2 py-1.5 text-[12px]', isStandingNote(note) ? 'border-maestro/30 bg-maestro/10' : note.done ? 'border-transparent opacity-60' : 'border-border bg-bg/40')}>
      {isStandingNote(note) ? (
        note.kind === 'rule' ? <ShieldCheck size={13} className="mt-0.5 shrink-0 text-maestro" /> : <Scale size={13} className="mt-0.5 shrink-0 text-maestro" />
      ) : note.kind === 'todo' ? (
        <button onClick={() => onUpdate({ done: !note.done })} className={clsx('mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border', note.done ? 'border-ok bg-ok/20 text-ok' : 'border-muted hover:border-accent')} title={note.done ? 'Mark not done' : 'Mark done'}>
          {note.done && <Check size={9} />}
        </button>
      ) : (
        <StickyNote size={13} className="mt-0.5 shrink-0 text-muted" />
      )}
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            autoFocus
            value={draft}
            rows={Math.min(6, draft.split('\n').length + 1)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                save()
              }
              if (e.key === 'Escape') {
                setDraft(note.text)
                setEditing(false)
              }
            }}
            className="w-full resize-none rounded border border-accent bg-bg px-1.5 py-1 text-[12px] outline-none"
          />
        ) : (
          <div className={clsx('whitespace-pre-wrap break-words', note.done && 'line-through')} onDoubleClick={() => setEditing(true)} title="Double-click to edit">
            {note.text}
          </div>
        )}
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
          <KindChip kind={note.kind} />
          {note.source === 'agent' && (
            <span className="inline-flex items-center gap-0.5 rounded bg-accent/10 px-1 text-accent" title="Added by the agent">
              <Bot size={9} /> agent
            </span>
          )}
          {note.status && note.status !== 'todo' && !note.done && <StatusChip id={note.status} />}
          {note.priority && <span className={clsx('rounded px-1', note.priority === 'high' ? 'bg-danger/15 text-danger' : note.priority === 'medium' ? 'bg-warn/15 text-warn' : 'bg-panel-2')}>{note.priority}</span>}
          {note.due && <span className={clsx(note.due < new Date().toISOString().slice(0, 10) && !note.done && 'text-danger')}>due {note.due}</span>}
          <span>{new Date(note.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        </div>
      </div>
      <div className="reveal-on-focus flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
        {workspaceId && (
          <IconButton label="Put this in the chat box" className="hover:text-accent" onClick={() => setChatDraft(workspaceId, (chatDraft ? chatDraft + '\n' : '') + note.text)}>
            <MessageSquareShare size={12} />
          </IconButton>
        )}
        <IconButton label="Delete" className="hover:text-danger" onClick={onRemove}>
          <Trash2 size={12} />
        </IconButton>
      </div>
    </div>
  )
}


function StatusChip({ id }: { id: string }): React.JSX.Element {
  const custom = useApp((s) => s.settings.noteStatuses)
  const def = noteStatuses(custom).find((s) => s.id === id)
  return <span className={clsx('rounded bg-panel-2 px-1', def?.tone ?? 'text-accent')}>{def?.label ?? id}</span>
}
