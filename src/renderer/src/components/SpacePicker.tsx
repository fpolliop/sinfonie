import React from 'react'
import clsx from 'clsx'
import { Layers } from 'lucide-react'
import { useApp } from '@/stores/app'

/** Dropdown over the user's spaces; empty value means "no space". */
export function SpacePicker({ value, onChange, className, pill }: { value: string; onChange: (id: string) => void; className?: string; pill?: boolean }): React.JSX.Element {
  const spaces = useApp((s) => s.spaces)
  const current = spaces.find((s) => s.id === value)
  if (pill) {
    return (
      <label className={clsx('no-drag relative inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted hover:text-text', className)} title="Space">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: current?.color ?? '#8b93a1' }} />
        {current?.name ?? 'No space'}
        <span className="opacity-60">▾</span>
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
