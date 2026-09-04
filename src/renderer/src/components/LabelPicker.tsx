import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Tag, Plus, Trash2, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { SPACE_COLORS } from '@shared/types'
import type { Label, Workspace } from '@shared/types'

/** Labels visible in a space: the space's own plus the shared ones. */
export function labelsFor(labels: Label[], spaceId: string | undefined): Label[] {
  return labels.filter((l) => !l.spaceId || l.spaceId === spaceId)
}

export function LabelChip({ label, small, onRemove }: { label: Label; small?: boolean; onRemove?: () => void }): React.JSX.Element {
  return (
    <span className={clsx('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 font-medium', small ? 'py-px text-[10px]' : 'py-0.5 text-[11px]')} style={{ borderColor: label.color + '80', color: label.color, background: label.color + '1a' }}>
      {label.name}
      {onRemove && (
        <button className="opacity-60 hover:opacity-100" onClick={(e) => (e.stopPropagation(), onRemove())} title="Remove label">
          ×
        </button>
      )}
    </span>
  )
}

/** Header control: shows the workspace's labels and a popover to toggle, create, or delete labels. */
export function LabelPicker({ ws }: { ws: Workspace }): React.JSX.Element {
  const { labels, setError } = useApp()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState(SPACE_COLORS[3])
  const ref = useRef<HTMLDivElement>(null)
  const available = labelsFor(labels, ws.spaceId)
  const mine = (ws.labelIds ?? []).map((id) => labels.find((l) => l.id === id)).filter((l): l is Label => Boolean(l))
  const go = (fn: () => Promise<unknown>): void => {
    fn().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  const toggle = (id: string): void => {
    const cur = ws.labelIds ?? []
    go(() => api.invoke('workspaces:setLabels', ws.id, cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }
  const create = (): void => {
    if (!name.trim()) return
    go(async () => {
      const l = await api.invoke('labels:create', name, color, ws.spaceId ?? null)
      await api.invoke('workspaces:setLabels', ws.id, [...(ws.labelIds ?? []), l.id])
      setName('')
    })
  }
  return (
    <div ref={ref} className="no-drag relative flex shrink-0 items-center gap-1">
      {mine.map((l) => (
        <LabelChip key={l.id} label={l} onRemove={() => toggle(l.id)} />
      ))}
      <button onClick={() => setOpen(!open)} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-border px-1.5 py-0.5 text-[11px] text-muted hover:text-text" title="Labels">
        <Tag size={11} /> {mine.length === 0 ? 'Add label' : ''}
      </button>
      {open && (
        <div className="absolute left-0 top-7 z-30 w-64 rounded-lg border border-border bg-panel p-2 shadow-xl">
          <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-muted">Labels</div>
          {available.length === 0 && <div className="px-1 py-1 text-[12px] text-muted">No labels yet. Create one below.</div>}
          <div className="max-h-48 overflow-auto">
            {available.map((l) => {
              const on = (ws.labelIds ?? []).includes(l.id)
              return (
                <div key={l.id} className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-panel-2">
                  <button className="flex flex-1 items-center gap-2 text-left" onClick={() => toggle(l.id)}>
                    <span className={clsx('flex h-3.5 w-3.5 items-center justify-center rounded border', on ? 'border-accent bg-accent text-white' : 'border-border')}>{on && <Check size={10} />}</span>
                    <LabelChip label={l} small />
                    {!l.spaceId && <span className="text-[10px] text-muted">shared</span>}
                  </button>
                  <button className="opacity-0 group-hover:opacity-100 text-muted hover:text-danger" title="Delete label everywhere" onClick={() => go(() => api.invoke('labels:delete', l.id))}>
                    <Trash2 size={11} />
                  </button>
                </div>
              )
            })}
          </div>
          <div className="mt-2 border-t border-border pt-2">
            <div className="flex items-center gap-1.5">
              <input className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-[12px] outline-none focus:border-accent" placeholder="New label" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
              <button className="rounded-md bg-accent-2 p-1.5 text-white hover:bg-accent disabled:opacity-50" disabled={!name.trim()} onClick={create} title="Create and attach">
                <Plus size={12} />
              </button>
            </div>
            <div className="mt-1.5 flex gap-1">
              {SPACE_COLORS.map((c) => (
                <button key={c} className="h-4 w-4 rounded-full border-2" style={{ background: c, borderColor: c === color ? '#fff' : 'transparent' }} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
