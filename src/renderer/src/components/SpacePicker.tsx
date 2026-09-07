import React from 'react'
import clsx from 'clsx'
import { Layers, ChevronDown } from 'lucide-react'
import { useApp } from '@/stores/app'
import { chipCls } from './ui'

/** Dropdown over the user's spaces; empty value means "no space". */
export function SpacePicker({ value, onChange, className, pill }: { value: string; onChange: (id: string) => void; className?: string; pill?: boolean }): React.JSX.Element {
  const spaces = useApp((s) => s.spaces)
  const current = spaces.find((s) => s.id === value)
  if (pill) {
    return (
      <label className={clsx(chipCls, 'no-drag relative shrink-0 cursor-pointer border border-border bg-panel text-muted hover:text-text', className)} title="Space">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: current?.color ?? '#8b93a1' }} />
        {current?.name ?? 'No space'}
        <ChevronDown size={11} className="-mr-0.5 opacity-60" />
        <select className="absolute inset-0 cursor-pointer opacity-0" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">No space</option>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
    )
  }
  return (
    <label className={clsx('inline-flex items-center gap-1.5 text-[12px]', className)} title="Space">
      <Layers size={14} className="text-muted" />
      <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No space</option>
        {spaces.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  )
}
