import React from 'react'
import { inputCls } from './ui'

/** Models Claude Code accepts: tier aliases (resolve to the newest of that tier) and exact ids. */
export const MODEL_GROUPS: { label: string; options: { id: string; label: string }[] }[] = [
  {
    label: 'Aliases (newest of each tier)',
    options: [
      { id: 'fable', label: 'fable · Claude Fable, most capable' },
      { id: 'opus', label: 'opus · Claude Opus' },
      { id: 'sonnet', label: 'sonnet · Claude Sonnet' },
      { id: 'haiku', label: 'haiku · Claude Haiku, fastest and cheapest' }
    ]
  },
  {
    label: 'Exact models',
    options: [
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 · $10 / $50 per M tokens' },
      { id: 'claude-opus-5', label: 'Claude Opus 5 · $5 / $25' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 · $5 / $25' },
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7 · $5 / $25' },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 · $5 / $25' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 · $2 / $10' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 · $3 / $15' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 · $1 / $5' }
    ]
  }
]

const KNOWN = new Set(MODEL_GROUPS.flatMap((g) => g.options.map((o) => o.id)))

/**
 * Dropdown over every model the app knows. `allowDefault` adds an empty
 * "use the default" entry; an unknown current value is kept as its own entry
 * so nothing is silently changed.
 */
export function ModelSelect({ value, onChange, allowDefault, defaultLabel, className }: { value: string; onChange: (id: string) => void; allowDefault?: boolean; defaultLabel?: string; className?: string }): React.JSX.Element {
  return (
    <select className={className ?? inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      {allowDefault && <option value="">{defaultLabel ?? 'App default'}</option>}
      {value && !KNOWN.has(value) && <option value={value}>{value} (custom)</option>}
      {MODEL_GROUPS.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
