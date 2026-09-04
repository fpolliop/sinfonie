import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Bot, Check, ChevronDown, ChevronRight, MessageSquareShare, StickyNote, Trash2 } from 'lucide-react'
import { useNotes } from '@/stores/notes'
import { useChat } from '@/stores/chat'
import { useApp } from '@/stores/app'
import type { Note } from '@shared/types'

const EMPTY: Note[] = []

/** Notes, reminders and todos for one workspace. The orchestrator sees and edits the same list. */
export function NotesPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): React.JSX.Element {
  const notes = useNotes((s) => s.byWorkspace[workspaceId]) ?? EMPTY
  const { load, add, update, remove, subscribe } = useNotes()
  const setError = useApp((s) => s.setError)
  const [text, setText] = useState('')
  const [kind, setKind] = useState<Note['kind']>('todo')
  const [showDone, setShowDone] = useState(false)
  useEffect(() => {
    subscribe()
    void load(workspaceId)
  }, [workspaceId, load, subscribe])
  const go = (fn: () => Promise<void>): void => {
    fn().catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  const open = useMemo(() => notes.filter((n) => n.kind === 'todo' && !n.done), [notes])
  const plain = useMemo(() => notes.filter((n) => n.kind === 'note'), [notes])
  const done = useMemo(() => notes.filter((n) => n.kind === 'todo' && n.done), [notes])
  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    // A leading "[] " or "- [ ] " means todo, "# " or "note:" means note; otherwise the toggle decides.
    const asTodo = /^(\[\s?\]|-\s\[\s?\])\s*/.test(t)
    const asNote = /^(note:|#)\s*/i.test(t)
    const clean = t.replace(/^(\[\s?\]|-\s\[\s?\]|note:|#)\s*/i, '')
    go(() => add(workspaceId, clean, asTodo ? 'todo' : asNote ? 'note' : kind))
    setText('')
  }
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <StickyNote size={14} className="text-accent" />
        <span className="text-[13px] font-semibold">Notes</span>
        <span className="text-[11px] text-muted">{open.length ? `${open.length} open` : notes.length ? 'nothing open' : ''}</span>
        <button className="ml-auto text-muted hover:text-text" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="border-b border-border p-2">
        <div className="rounded-lg border border-border bg-bg focus-within:border-accent">
          <textarea
            value={text}
            rows={2}
            placeholder={kind === 'todo' ? 'Something to do later… (Enter adds)' : 'A note to keep… (Enter adds)'}
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
              <button key={k} onClick={() => setKind(k)} className={clsx('rounded-md px-1.5 py-0.5 text-[11px]', kind === k ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
                {k === 'todo' ? 'Todo' : 'Note'}
              </button>
            ))}
            <span className="ml-auto text-[10px] text-muted">The agent reads these and can add its own.</span>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-2">
        {notes.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-3 text-center text-[12px] text-muted">
            Nothing yet. Jot down what to pick up later, or ask the agent to “remember” something and it lands here.
          </div>
        )}
        {open.length > 0 && <Section title="To do">{open.map((n) => <Row key={n.id} note={n} workspaceId={workspaceId} onUpdate={(p) => go(() => update(workspaceId, n.id, p))} onRemove={() => go(() => remove(workspaceId, n.id))} />)}</Section>}
        {plain.length > 0 && <Section title="Notes">{plain.map((n) => <Row key={n.id} note={n} workspaceId={workspaceId} onUpdate={(p) => go(() => update(workspaceId, n.id, p))} onRemove={() => go(() => remove(workspaceId, n.id))} />)}</Section>}
        {done.length > 0 && (
          <div className="mt-2">
            <button className="flex items-center gap-1 px-1 text-[11px] font-medium uppercase tracking-wide text-muted hover:text-text" onClick={() => setShowDone(!showDone)}>
              {showDone ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Done · {done.length}
            </button>
            {showDone && done.map((n) => <Row key={n.id} note={n} workspaceId={workspaceId} onUpdate={(p) => go(() => update(workspaceId, n.id, p))} onRemove={() => go(() => remove(workspaceId, n.id))} />)}
          </div>
        )}
      </div>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-2">
      <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted">{title}</div>
      <div className="mt-1 flex flex-col gap-1">{children}</div>
    </div>
  )
}

function Row({ note, workspaceId, onUpdate, onRemove }: { note: Note; workspaceId: string; onUpdate: (p: Partial<Pick<Note, 'text' | 'done' | 'kind'>>) => void; onRemove: () => void }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.text)
  const setChatDraft = useChat((s) => s.setDraft)
  const chatDraft = useChat((s) => s.chats[workspaceId]?.draft ?? '')
  const save = (): void => {
    setEditing(false)
    if (draft.trim() && draft.trim() !== note.text) onUpdate({ text: draft })
    else setDraft(note.text)
  }
  return (
    <div className={clsx('group flex items-start gap-2 rounded-md border px-2 py-1.5 text-[12px]', note.done ? 'border-transparent opacity-60' : 'border-border bg-bg/40')}>
      {note.kind === 'todo' ? (
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
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted">
          {note.source === 'agent' && (
            <span className="inline-flex items-center gap-0.5 rounded bg-accent/10 px-1 text-accent" title="Added by the agent">
              <Bot size={9} /> agent
            </span>
          )}
          <span>{new Date(note.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
        <button className="rounded p-0.5 text-muted hover:text-accent" title="Put this in the chat box" onClick={() => setChatDraft(workspaceId, (chatDraft ? chatDraft + '\n' : '') + note.text)}>
          <MessageSquareShare size={12} />
        </button>
        <button className="rounded p-0.5 text-muted hover:text-danger" title="Delete" onClick={onRemove}>
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}
