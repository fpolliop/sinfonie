import React, { useState } from 'react'
import { Plus, RefreshCw, Trash2, KeyRound, Server } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Field, inputCls } from './ui'
import { PROVIDER_KINDS, type ProviderKind } from '@shared/types'

/** Model providers for the native engine: cloud APIs and local servers. */
export function ProvidersSection(): React.JSX.Element {
  const { settings, setError } = useApp()
  const providers = settings.providers ?? []
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<ProviderKind>('anthropic')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [keyEdit, setKeyEdit] = useState<Record<string, string>>({})
  const go = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  const kindInfo = PROVIDER_KINDS.find((k) => k.id === kind)!
  const add = (): void =>
    void go('add', async () => {
      const p = await api.invoke('providers:add', { kind, name: name || kindInfo.label, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined })
      setAdding(false)
      setName('')
      setBaseUrl('')
      setApiKey('')
      await api.invoke('providers:models', p.id).catch(() => undefined)
    })
  return (
    <section className="mt-5">
      <div className="mb-1 flex items-center">
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">Model providers</h3>
        <Button size="sm" className="ml-auto" onClick={() => setAdding(true)}>
          <Plus size={12} /> Add provider
        </Button>
      </div>
      <p className="mb-2 text-[11px] text-muted">For the native engine. Keys are stored encrypted on this Mac. Local servers such as Ollama and LM Studio need no key.</p>
      <div className="flex flex-col gap-1.5">
        {providers.length === 0 && !adding && <div className="rounded-md border border-dashed border-border p-3 text-center text-[12px] text-muted">No providers yet. Add one to use models other than Claude Code's.</div>}
        {providers.map((p) => {
          const info = PROVIDER_KINDS.find((k) => k.id === p.kind)
          return (
            <div key={p.id} className="rounded-lg border border-border px-3 py-2">
              <div className="flex items-center gap-3">
                <Server size={14} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-medium">
                    {p.name} <Badge>{info?.label ?? p.kind}</Badge>
                    {info?.needsKey && (p.hasKey ? <Badge tone="ok">key set</Badge> : <Badge tone="warn">no key</Badge>)}
                    {p.models && <Badge tone="accent">{p.models.length} models</Badge>}
                  </div>
                  <div className="truncate text-[11px] text-muted">{p.baseUrl ?? 'default endpoint'}</div>
                </div>
                <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => go(p.id, () => api.invoke('providers:models', p.id))} title="Fetch the model list">
                  <RefreshCw size={12} className={busy === p.id ? 'animate-spin' : ''} /> Models
                </Button>
                <button className="rounded p-1 text-muted hover:text-danger" title="Remove" onClick={() => go(p.id, () => api.invoke('providers:remove', p.id))}>
                  <Trash2 size={13} />
                </button>
              </div>
              {info?.needsKey && (
                <div className="mt-2 flex items-center gap-2">
                  <KeyRound size={12} className="text-muted" />
                  <input type="password" className={inputCls} placeholder={p.hasKey ? 'Paste a new key to replace' : 'API key'} value={keyEdit[p.id] ?? ''} onChange={(e) => setKeyEdit({ ...keyEdit, [p.id]: e.target.value })} />
                  <Button size="sm" disabled={!keyEdit[p.id]?.trim()} onClick={() => go(p.id, async () => {
                    await api.invoke('providers:update', p.id, { apiKey: keyEdit[p.id] })
                    setKeyEdit({ ...keyEdit, [p.id]: '' })
                    await api.invoke('providers:models', p.id).catch(() => undefined)
                  })}>
                    Save key
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {adding && (
        <div className="mt-2 rounded-lg border border-accent/40 p-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Provider">
              <select className={inputCls} value={kind} onChange={(e) => {
                const k = e.target.value as ProviderKind
                setKind(k)
                setBaseUrl(PROVIDER_KINDS.find((x) => x.id === k)?.baseUrl ?? '')
              }}>
                {PROVIDER_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name" hint="Shown in model pickers.">
              <input className={inputCls} placeholder={kindInfo.label} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <p className="mb-2 text-[11px] text-muted">{kindInfo.hint}</p>
          {(kind === 'openai-compatible' || kind === 'ollama' || kind === 'lmstudio' || baseUrl) && (
            <Field label="Base URL" hint="The /v1 root of the API.">
              <input className={inputCls} placeholder={kindInfo.baseUrl ?? 'https://api.example.com/v1'} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </Field>
          )}
          {kindInfo.needsKey && (
            <Field label="API key">
              <input type="password" className={inputCls} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </Field>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={add} disabled={busy === 'add' || (kindInfo.needsKey && !apiKey.trim())}>
              {busy === 'add' ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
