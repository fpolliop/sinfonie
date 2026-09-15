import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Brain, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Button, Dialog, Field, inputCls } from '../ui'
import type { MaestroAutonomy, MaestroMemoryCategory, MaestroMemoryEntry } from '@shared/types'

const CATEGORIES: { id: MaestroMemoryCategory; label: string; hint: string }[] = [
  { id: 'user', label: 'About you', hint: 'Role, name, languages, timezone' },
  { id: 'work', label: 'How you work', hint: 'Stack, testing, reviews, deploys, team' },
  { id: 'preference', label: 'Preferences', hint: 'How you like answers, models, cost' },
  { id: 'space', label: 'Spaces and apps', hint: 'Facts about each product or client' },
  { id: 'thread', label: 'Open threads', hint: 'Things to follow up' }
]
const AUTONOMY: { id: MaestroAutonomy; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask before every change', hint: 'Maestro explains and waits for a yes before it writes anything.' },
  { id: 'destructive', label: 'Ask only for destructive changes', hint: 'Ordinary changes happen and are reported; deleting or archiving asks first.' },
  { id: 'trusted', label: 'Trusted', hint: 'Maestro acts and reports. Deleting a space, workspace, agent or note still asks.' }
]

/** What Maestro remembers about you, editable, and how much it may do on its own. */
export function MaestroMemory({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const setError = useApp((s) => s.setError)
  const [entries, setEntries] = useState<MaestroMemoryEntry[]>([])
  const [text, setText] = useState('')
  const [category, setCategory] = useState<MaestroMemoryCategory>('user')
  const autonomy = settings.maestro?.autonomy ?? 'ask'
  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err))
  useEffect(() => {
    api.invoke('maestro:memory').then(setEntries).catch(fail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const add = (): void => {
    if (!text.trim()) return
    api.invoke('maestro:memoryAdd', category, text.trim()).then(setEntries).catch(fail)
    setText('')
  }
  return (
    <Dialog title="Maestro’s memory and autonomy" onClose={onClose} width={720}>
      <Field label="Autonomy" hint={AUTONOMY.find((a) => a.id === autonomy)?.hint}>
        <div className="flex rounded-md border border-border bg-bg p-0.5 text-[12px]">
          {AUTONOMY.map((a) => (
            <button key={a.id} onClick={() => void api.invoke('settings:update', { maestro: { ...(settings.maestro ?? {}), autonomy: a.id } }).catch(fail)} className={clsx('flex-1 rounded px-2 py-1', autonomy === a.id ? 'bg-panel-2 font-medium text-text' : 'text-muted hover:text-text')}>
              {a.label}
            </button>
          ))}
        </div>
      </Field>
      <div className="mb-2 mt-4 flex items-center gap-2">
        <Brain size={14} className="text-accent" />
        <span className="text-[13px] font-semibold">What Maestro remembers</span>
        <span className="text-[11px] text-muted">{entries.length ? `${entries.length} fact${entries.length === 1 ? '' : 's'}` : 'nothing yet: it asks in the first conversation'}</span>
      </div>
      <div className="max-h-[40vh] overflow-auto rounded-lg border border-border">
        {CATEGORIES.map((c) => {
          const list = entries.filter((e) => e.category === c.id)
          if (list.length === 0) return null
          return (
            <div key={c.id} className="border-b border-border last:border-b-0">
              <div className="bg-panel px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{c.label}</div>
              {list.map((e) => (
                <Entry key={e.id} entry={e} onSave={(t) => api.invoke('maestro:memoryUpdate', e.id, t).then(setEntries).catch(fail)} onRemove={() => api.invoke('maestro:memoryRemove', e.id).then(setEntries).catch(fail)} />
              ))}
            </div>
          )
        })}
        {entries.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-muted">Maestro saves facts as it learns them. You can add one below, or correct anything it got wrong.</div>}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <select className="h-8 rounded-md border border-border bg-bg px-1.5 text-[12px]" value={category} onChange={(e) => setCategory(e.target.value as MaestroMemoryCategory)}>
          {CATEGORIES.map((c) => (
            <option key={c.id} value={c.id} title={c.hint}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          className={inputCls}
          placeholder="Something Maestro should always know…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <Button size="sm" variant="primary" disabled={!text.trim()} onClick={add}>
          <Plus size={12} /> Add
        </Button>
      </div>
    </Dialog>
  )
}

function Entry({ entry, onSave, onRemove }: { entry: MaestroMemoryEntry; onSave: (t: string) => void; onRemove: () => void }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.text)
  return (
    <div className="group flex items-start gap-2 px-3 py-1.5 text-[12px] hover:bg-panel-2/60">
      {editing ? (
        <input
          autoFocus
          className={inputCls}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false)
            if (draft.trim() && draft.trim() !== entry.text) onSave(draft.trim())
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setDraft(entry.text)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span className="min-w-0 flex-1 cursor-text" onDoubleClick={() => setEditing(true)} title="Double-click to edit">
          {entry.text}
        </span>
      )}
      <span className="shrink-0 text-[10px] text-muted">{new Date(entry.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
      <button className="shrink-0 rounded p-0.5 text-muted opacity-0 hover:text-danger group-hover:opacity-100" title="Forget" onClick={onRemove}>
        <Trash2 size={12} />
      </button>
    </div>
  )
}
