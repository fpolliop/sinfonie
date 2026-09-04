import React, { useEffect, useState } from 'react'
import { inputCls } from './ui'
import { useApp } from '@/stores/app'
import { api } from '@/lib/api'
import { acpProbeCache } from './AccountsPage'
import { ACP_ENGINES, AGENT_ENGINES, CLAUDE_MODELS, classifyModel, type ProviderConfig } from '@shared/types'

/** Models Claude Code accepts: tier aliases (resolve to the newest of that tier) and exact ids. */
export const MODEL_GROUPS: { label: string; options: { id: string; label: string }[] }[] = [
  { label: 'Aliases (newest of each tier)', options: CLAUDE_MODELS.filter((m) => m.alias).map((m) => ({ id: m.id, label: `${m.id} · ${m.label}` })) },
  { label: 'Exact models', options: CLAUDE_MODELS.filter((m) => !m.alias).map((m) => ({ id: m.id, label: `${m.label}${m.price ? ` · $${m.price[0]} / $${m.price[1]} per M tokens` : ''}` })) }
]

const KNOWN = new Set(MODEL_GROUPS.flatMap((g) => g.options.map((o) => o.id)))
const EMPTY_PROVIDERS: ProviderConfig[] = []

/**
 * Dropdown over the Claude models. `allowDefault` adds an empty "use the default" entry; an
 * unknown current value is kept as its own entry so nothing is silently changed.
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

const AGENT_LABEL: Record<string, string> = { codex: 'Codex · ChatGPT login', gemini: 'Gemini CLI · Google API key', grok: 'Grok Build · grok.com login' }

/** Short human label for any model reference, for badges. */
export function modelLabel(ref: string, providers: ProviderConfig[]): string {
  const m = classifyModel(ref)
  if (m.kind === 'claude') return ref
  if (m.kind === 'agent') return `${m.engine} · ${m.modelId}`
  const p = providers.find((x) => x.id === m.providerId)
  return `${p?.name ?? m.providerId} · ${m.modelId}`
}

/** Load the main process's cached vendor-agent probes into the renderer cache once. */
function useAgentProbes(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (AGENT_ENGINES.every((e) => acpProbeCache[e])) return
    api
      .invoke('acp:probes')
      .then((all) => {
        Object.assign(acpProbeCache, all)
        setTick((t) => t + 1)
      })
      .catch(() => undefined)
  }, [])
  return tick
}

/**
 * One dropdown over every model a crew member can run on: Claude through your Claude login,
 * each API-key provider, and each signed-in vendor agent (Codex, Gemini, Grok).
 */
export function CrewModelSelect({ value, onChange, className }: { value: string; onChange: (ref: string) => void; className?: string }): React.JSX.Element {
  const providersRaw = useApp((s) => s.settings.providers)
  const providers = providersRaw ?? EMPTY_PROVIDERS
  useAgentProbes()
  const agents = ACP_ENGINES.map((e) => ({ id: e.id, models: acpProbeCache[e.id]?.signedIn ? (acpProbeCache[e.id]?.models ?? []) : [] })).filter((e) => e.models.length)
  const known = new Set<string>([...KNOWN, ...providers.flatMap((p) => (p.models ?? []).map((m) => `${p.id}/${m}`)), ...agents.flatMap((a) => a.models.map((m) => `${a.id}/${m}`))])
  return (
    <select className={className ?? inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      {value && !known.has(value) && <option value={value}>{modelLabel(value, providers)} (custom)</option>}
      {MODEL_GROUPS.map((g) => (
        <optgroup key={g.label} label={`Claude · your Claude login · ${g.label.toLowerCase()}`}>
          {g.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
      {agents.map((a) => (
        <optgroup key={a.id} label={AGENT_LABEL[a.id]}>
          {a.models.map((m) => (
            <option key={m} value={`${a.id}/${m}`}>
              {m}
            </option>
          ))}
        </optgroup>
      ))}
      {providers.map((p) => (
        <optgroup key={p.id} label={`${p.name} · API key`}>
          {(p.models ?? []).length === 0 && (
            <option value="" disabled>
              no models fetched yet
            </option>
          )}
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
