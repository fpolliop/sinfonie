import React from 'react'
import { useApp } from '@/stores/app'
import { inputCls } from './ui'
import type { Engine, ProviderConfig } from '@shared/types'

const EMPTY_PROVIDERS: ProviderConfig[] = []

export const ENGINES: { id: Engine; label: string; hint: string }[] = [
  { id: 'claude-code', label: 'Claude Code', hint: 'Anthropic’s agent runtime with your Claude login. Claude models only.' },
  { id: 'native', label: 'Sinfonie native', hint: 'Sinfonie’s own agent loop. Any provider: Anthropic API, OpenAI, Gemini, DeepSeek, local models.' }
]

export function EngineSelect({ value, onChange, allowDefault }: { value: string; onChange: (e: string) => void; allowDefault?: boolean }): React.JSX.Element {
  const def = useApp((s) => s.settings.engine ?? 'claude-code')
  return (
    <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      {allowDefault && <option value="">App default ({ENGINES.find((e) => e.id === def)?.label})</option>}
      {ENGINES.map((e) => (
        <option key={e.id} value={e.id}>
          {e.label} — {e.hint}
        </option>
      ))}
    </select>
  )
}

/** Native-engine model picker: "<provider>/<model>" from the configured providers' fetched lists. */
export function NativeModelSelect({ value, onChange, allowDefault, defaultLabel }: { value: string; onChange: (ref: string) => void; allowDefault?: boolean; defaultLabel?: string }): React.JSX.Element {
  // Select the stored array itself; a `?? []` inside a selector makes a fresh array per read and loops React.
  const providersRaw = useApp((s) => s.settings.providers)
  const providers = providersRaw ?? EMPTY_PROVIDERS
  const known = new Set(providers.flatMap((p) => (p.models ?? []).map((m) => `${p.id}/${m}`)))
  return (
    <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      {allowDefault && <option value="">{defaultLabel ?? 'App default'}</option>}
      {value && !known.has(value) && <option value={value}>{value} (custom)</option>}
      {providers.length === 0 && <option value="" disabled>Add a provider in Settings first</option>}
      {providers.map((p) => (
        <optgroup key={p.id} label={p.name}>
          {(p.models ?? []).length === 0 && <option value="" disabled>no models fetched yet</option>}
          {(p.models ?? []).map((m) => (
            <option key={m} value={`${p.id}/${m}`}>
              {m}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
