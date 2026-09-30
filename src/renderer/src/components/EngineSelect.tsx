import React from 'react'
import { useApp } from '@/stores/app'
import { inputCls } from './ui'
import { VENDORS, type Engine, type ProviderConfig } from '@shared/types'

const EMPTY_PROVIDERS: ProviderConfig[] = []

export const ENGINES: { id: Engine; label: string; hint: string }[] = [
  { id: 'claude-code', label: 'Claude Code', hint: 'Anthropic’s agent runtime with your Claude login. Claude models only.' },
  { id: 'native', label: 'Sinfonie native', hint: 'Sinfonie’s own agent loop. Any provider: Anthropic API, OpenAI, Gemini, DeepSeek, local models.' },
  { id: 'codex', label: 'Codex (OpenAI)', hint: 'OpenAI’s coding agent with your ChatGPT login. Set up under Accounts.' },
  { id: 'gemini', label: 'Gemini CLI (Google)', hint: 'Google’s coding agent. API key login. Set up under Accounts.' },
  { id: 'grok', label: 'Grok Build (xAI)', hint: 'xAI’s coding agent with your grok.com login. Set up under Accounts.' }
]

type Readiness = { ok: true } | { ok: false; why: string; page: 'accounts' | 'providers' }

/** Whether an engine can run, from the last account checks (no probing here): not installed, not signed in, or no providers. */
function useReadiness(): (engine: Engine) => Readiness {
  const accounts = useApp((s) => s.settings.claudeAccounts)
  const providersRaw = useApp((s) => s.settings.providers)
  const defaults = useApp((s) => s.settings.defaultAccounts)
  const defaultClaude = useApp((s) => s.settings.defaultClaudeAccountId)
  return (engine) => {
    if (engine === 'native') return (providersRaw ?? EMPTY_PROVIDERS).length > 0 ? { ok: true } : { ok: false, why: 'no model providers yet', page: 'providers' }
    const vendor = VENDORS.find((v) => v.engine === engine)?.id
    if (!vendor) return { ok: true }
    const list = accounts.filter((a) => (a.vendor ?? 'anthropic') === vendor)
    const defId = vendor === 'anthropic' ? defaultClaude : (defaults?.[vendor] ?? `${vendor}-default`)
    const acc = list.find((a) => a.id === defId) ?? list[0]
    if (list.some((a) => a.loggedIn === true)) return { ok: true }
    if (acc?.missing) return { ok: false, why: 'not installed', page: 'accounts' }
    if (list.length > 0 && list.every((a) => a.loggedIn === false)) return { ok: false, why: 'not signed in', page: 'accounts' }
    return { ok: true } // never checked: do not guess
  }
}

export function EngineSelect({ value, onChange, allowDefault }: { value: string; onChange: (e: string) => void; allowDefault?: boolean }): React.JSX.Element {
  const def = useApp((s) => s.settings.engine ?? 'claude-code')
  const openSettings = useApp((s) => s.openSettings)
  const readiness = useReadiness()
  const chosen = (value || def) as Engine
  const r = readiness(chosen)
  const label = (e: Engine): string => {
    const x = readiness(e)
    return x.ok ? '' : ` (${x.why})`
  }
  return (
    <div>
      <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
        {allowDefault && <option value="">App default ({ENGINES.find((e) => e.id === def)?.label}{label(def)})</option>}
        {ENGINES.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
            {label(e.id)} — {e.hint}
          </option>
        ))}
      </select>
      {!r.ok && (
        <p className="mt-1 text-[12px] text-warn" role="status">
          {ENGINES.find((e) => e.id === chosen)?.label} is {r.why === 'no model providers yet' ? 'missing a model provider' : r.why} on this Mac, so agents on it will not start.{' '}
          <button type="button" className="text-accent hover:underline" onClick={() => openSettings({ scope: 'app', page: r.page })}>
            {r.page === 'providers' ? 'Add one in Model providers' : 'Set up in Accounts'}
          </button>
        </p>
      )}
    </div>
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
      {providers.length === 0 && <option value="" disabled>No model providers yet: add one under Model providers</option>}
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
