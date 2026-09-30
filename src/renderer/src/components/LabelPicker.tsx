import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Tag, Plus, Trash2, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { SPACE_COLORS } from '@shared/types'
import { colorName } from './colorNames'
import type { Label, Workspace } from '@shared/types'
import { chipCls } from './ui'

/** Labels visible in a space: the space's own plus the shared ones. */
export function labelsFor(labels: Label[], spaceId: string | undefined): Label[] {
  return labels.filter((l) => !l.spaceId || l.spaceId === spaceId)
}

export function LabelChip({ label, small, onRemove }: { label: Label; small?: boolean; onRemove?: () => void }): React.JSX.Element {
  return (
    <span className={clsx(small ? 'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px text-[11px] font-medium' : clsx(chipCls, 'shrink-0'))} style={{ color: label.color, background: label.color + '1f', ...(small ? { borderColor: label.color + '80' } : {}) }}>
      {label.name}
      {onRemove && (
        <button className="opacity-60 hover:opacity-100" onClick={(e) => (e.stopPropagation(), onRemove())} aria-label={`Remove label ${label.name}`} title="Remove label">
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
    <div ref={ref} className="no-drag relative flex shrink-0 items-center gap-1.5">
      {mine.map((l) => (
        <LabelChip key={l.id} label={l} onRemove={() => toggle(l.id)} />
      ))}
      <button
        onClick={() => setOpen(!open)}
        aria-label={mine.length === 0 ? 'Add label' : 'Labels'}
        aria-expanded={open}
        className={clsx(chipCls, 'shrink-0 border border-border bg-panel text-muted hover:text-text', mine.length > 0 && 'w-[22px] justify-center px-0')}
        title={mine.length === 0 ? 'Add label' : 'Labels'}
      >
        <Tag size={11} />
        {mine.length === 0 && 'Label'}
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
                  <button className="flex flex-1 items-center gap-2 text-left" aria-pressed={on} onClick={() => toggle(l.id)}>
                    <span className={clsx('flex h-3.5 w-3.5 items-center justify-center rounded border', on ? 'border-accent bg-accent text-white' : 'border-border')}>{on && <Check size={10} />}</span>
                    <LabelChip label={l} small />
                    {!l.spaceId && <span className="text-[11px] text-muted">shared</span>}
                  </button>
                  <button className="reveal-on-focus flex min-h-6 min-w-6 items-center justify-center rounded text-muted opacity-0 hover:text-danger group-hover:opacity-100" aria-label={`Delete label ${l.name} everywhere`} title="Delete label everywhere" onClick={() => window.confirm(`Delete the label “${l.name}” everywhere? It comes off everything that has it.`) && go(() => api.invoke('labels:delete', l.id))}>
                    <Trash2 size={11} />
                  </button>
                </div>
              )
            })}
          </div>
          <div className="mt-2 border-t border-border pt-2">
            <div className="flex items-center gap-1.5">
              <input className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-[12px] outline-none focus:border-accent" aria-label="New label name" placeholder="New label" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
              <button className="rounded-md bg-primary p-1.5 text-white hover:bg-primary-hover disabled:opacity-50" disabled={!name.trim()} onClick={create} aria-label="Create and attach" title="Create and attach">
                <Plus size={12} />
              </button>
            </div>
            <div role="radiogroup" aria-label="New label colour" className="mt-1.5 flex gap-1">
              {SPACE_COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={colorName(c)} title={colorName(c)} className="h-4 w-4 rounded-full border-2" style={{ background: c, borderColor: c === color ? 'var(--color-text)' : 'transparent' }} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
