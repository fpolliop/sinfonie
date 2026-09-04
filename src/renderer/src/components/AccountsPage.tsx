import React, { useEffect, useState } from 'react'
import { Plus, Trash2, RefreshCw, LogIn, Star } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, inputCls } from './ui'
import { LoginTerminal } from './LoginTerminal'
import { shortPath } from '@/lib/format'
import { VENDORS, type AcpProbe, type Engine, type Vendor } from '@shared/types'

/** Module-level cache of the last probe per engine, for model pickers elsewhere. */
export const acpProbeCache: Partial<Record<Engine, AcpProbe>> = {}

/** One page for every login: Anthropic, OpenAI, Google, xAI, each with any number of accounts. */
export function AccountsPage(): React.JSX.Element {
  const { settings, setError, openSettings } = useApp()
  const [names, setNames] = useState<Partial<Record<Vendor, string>>>({})
  const [login, setLogin] = useState<{ id: string; name: string } | null>(null)
  const [checking, setChecking] = useState<string | null>(null)
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const check = async (id: string): Promise<void> => {
    setChecking(id)
    await go(() => api.invoke('accounts:check', id))
    setChecking(null)
  }
  // Probe each vendor agent once for its model list, so the default-model pickers have options.
  useEffect(() => {
    for (const v of VENDORS) {
      if (v.id === 'anthropic' || acpProbeCache[v.engine]) continue
      api.invoke('acp:probe', v.engine).then((p) => (acpProbeCache[v.engine] = p)).catch(() => undefined)
    }
  }, [])
  const defaultFor = (vendor: Vendor): string | undefined => (vendor === 'anthropic' ? settings.defaultClaudeAccountId : settings.defaultAccounts?.[vendor] ?? `${vendor}-default`)
  const update = (patch: Record<string, unknown>): Promise<unknown> => api.invoke('settings:update', patch as never)

  return (
    <div className="max-w-[760px]">
      <p className="mb-4 text-[12px] text-muted">Each vendor’s coding agent keeps its own login. Sinfonie can hold several accounts per vendor, each in its own config folder, and a space or workspace picks which one to use. The vendor’s engine is what you select under General.</p>
      <div className="flex flex-col gap-4">
        {VENDORS.map((v) => {
          const list = settings.claudeAccounts.filter((a) => (a.vendor ?? 'anthropic') === v.id)
          const def = defaultFor(v.id)
          const probe = acpProbeCache[v.engine]
          const modelKey = `${v.engine === 'claude-code' ? '' : v.engine}Model`
          return (
            <section key={v.id} className="rounded-lg border border-border">
              <div className="flex items-center gap-3 border-b border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold">
                    {v.label} <span className="font-normal text-muted">· {v.agent}</span>
                  </div>
                  <div className="text-[11px] text-muted">{v.hint}</div>
                </div>
                {v.id === 'google' && (
                  <Button size="sm" variant="ghost" onClick={() => openSettings({ scope: 'app', page: 'providers' })}>
                    Model providers → Google
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-1.5 p-2">
                {list.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[13px] font-medium">
                        {a.name}
                        {a.id === def && <Badge tone="accent">default</Badge>}
                        {a.loggedIn === true && <Badge tone="ok">signed in</Badge>}
                        {a.loggedIn === false && <Badge tone="warn">not signed in</Badge>}
                        {a.loggedIn === undefined && <Badge>unchecked</Badge>}
                      </div>
                      <div className="truncate text-[11px] text-muted">{a.detail || (a.configDir ? shortPath(a.configDir) : 'your normal login on this Mac')}</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => check(a.id)} disabled={checking === a.id} title="Ask the CLI whether this account is signed in">
                      <RefreshCw size={12} className={checking === a.id ? 'animate-spin' : ''} /> {checking === a.id ? 'Checking…' : 'Check'}
                    </Button>
                    {v.id !== 'google' && (
                      <Button size="sm" onClick={() => setLogin({ id: a.id, name: `${v.agent} · ${a.name}` })}>
                        <LogIn size={12} /> Sign in
                      </Button>
                    )}
                    {a.id !== def && (
                      <Button size="sm" variant="ghost" onClick={() => go(() => api.invoke('accounts:setDefault', a.id))} title="Use this account unless a space or workspace picks another">
                        <Star size={12} /> Make default
                      </Button>
                    )}
                    {a.configDir !== null && (
                      <button title="Remove this account (its config folder is kept on disk)" className="rounded p-1 text-muted hover:text-danger" onClick={() => go(() => api.invoke('accounts:remove', a.id))}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <input className={inputCls} placeholder={`Add another ${v.label} account, e.g. Work`} value={names[v.id] ?? ''} onChange={(e) => setNames({ ...names, [v.id]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && names[v.id]?.trim() && go(() => api.invoke('accounts:add', names[v.id]!, v.id)).then(() => setNames({ ...names, [v.id]: '' }))} />
                  <Button variant="primary" size="sm" disabled={!names[v.id]?.trim()} onClick={() => go(() => api.invoke('accounts:add', names[v.id]!, v.id)).then(() => setNames({ ...names, [v.id]: '' }))}>
                    <Plus size={12} /> Add
                  </Button>
                </div>
                {v.engine !== 'claude-code' && probe?.signedIn && probe.models.length > 0 && (
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                    <span>Default model for the {v.agent} engine:</span>
                    <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[11px]" value={(settings as unknown as Record<string, string | undefined>)[modelKey] ?? ''} onChange={(e) => go(() => update({ [modelKey]: e.target.value || undefined }))}>
                      <option value="">Agent default{probe.currentModel ? ` (${probe.currentModel})` : ''}</option>
                      {probe.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    {probe.modes.length > 0 && <span>· modes: {probe.modes.join(', ')}</span>}
                  </div>
                )}
              </div>
            </section>
          )
        })}
      </div>
      {login && (
        <LoginTerminal
          accountId={login.id}
          accountName={login.name}
          onClose={() => {
            setLogin(null)
            void check(login.id)
          }}
        />
      )}
    </div>
  )
}
