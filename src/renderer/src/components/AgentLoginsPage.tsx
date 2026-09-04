import React, { useEffect, useState } from 'react'
import { RefreshCw, LogIn, CheckCircle2, XCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Field, inputCls } from './ui'
import { LoginTerminal } from './LoginTerminal'
import { ACP_ENGINES, type AcpProbe, type Engine } from '@shared/types'

/** Module-level cache so pickers elsewhere can list an agent's models without re-probing. */
export const acpProbeCache: Partial<Record<Engine, AcpProbe>> = {}

/** Vendor agents that bring their own login: Codex (ChatGPT), Gemini CLI, Grok Build. */
export function AgentLoginsPage(): React.JSX.Element {
  const { settings, setError, openSettings } = useApp()
  const [probes, setProbes] = useState<Partial<Record<Engine, AcpProbe>>>({ ...acpProbeCache })
  const [busy, setBusy] = useState<Engine | null>(null)
  const [terminal, setTerminal] = useState<{ command: string; title: string } | null>(null)
  const check = async (engine: Engine): Promise<void> => {
    setBusy(engine)
    try {
      const p = await api.invoke('acp:probe', engine)
      acpProbeCache[engine] = p
      setProbes((x) => ({ ...x, [engine]: p }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  useEffect(() => {
    for (const e of ACP_ENGINES) if (!acpProbeCache[e.id]) void check(e.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const signIn = async (engine: Engine, methodId: string, name: string): Promise<void> => {
    try {
      const r = await api.invoke('acp:authenticate', engine, methodId)
      if (r.terminalCommand) setTerminal({ command: r.terminalCommand, title: `${name}: ${methodId}` })
      else if (!r.ok) setError(r.error ?? 'Sign-in failed')
      else void check(engine)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const update = (patch: Record<string, unknown>): Promise<unknown> => api.invoke('settings:update', patch as never)
  return (
    <div className="max-w-[720px]">
      <p className="mb-3 text-[12px] text-muted">These engines run the vendor’s own coding agent with its own account, the way the Claude Code engine uses your Claude login. Pick one as an engine in Application → General or in a space’s General page.</p>
      <div className="flex flex-col gap-2">
        {ACP_ENGINES.map((e) => {
          const p = probes[e.id]
          const modelKey = `${e.id}Model`
          const current = (settings as unknown as Record<string, string | undefined>)[modelKey] ?? ''
          return (
            <div key={e.id} className="rounded-lg border border-border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-medium">
                    {e.label}
                    {p ? p.signedIn ? <Badge tone="ok">ready</Badge> : p.installed ? <Badge tone="warn">not signed in</Badge> : <Badge tone="danger">not installed</Badge> : busy === e.id ? <Badge>checking…</Badge> : null}
                    {p?.agent && <span className="text-[11px] text-muted">{p.agent}</span>}
                  </div>
                  <div className="text-[11px] text-muted">{e.loginHint}</div>
                </div>
                <Button size="sm" variant="ghost" disabled={busy === e.id} onClick={() => check(e.id)}>
                  <RefreshCw size={12} className={busy === e.id ? 'animate-spin' : ''} /> Check
                </Button>
              </div>
              {p?.error && !p.signedIn && <div className="mt-2 rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger">{p.error}</div>}
              {p && e.id === 'gemini' && !p.signedIn && (
                <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
                  <span>Add a Gemini API key from aistudio.google.com under</span>
                  <button className="text-accent hover:underline" onClick={() => openSettings({ scope: 'app', page: 'providers' })}>
                    Model providers → Google
                  </button>
                  <span>, then Check.</span>
                </div>
              )}
              {p && p.authMethods.length > 0 && e.id !== 'gemini' && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-muted">Sign in with:</span>
                  {p.authMethods.map((m) => (
                    <Button key={m.id} size="sm" onClick={() => signIn(e.id, m.id, e.label)} title={m.description ?? m.id}>
                      <LogIn size={12} /> {m.name}
                    </Button>
                  ))}
                </div>
              )}
              {p && p.signedIn && (
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <Field label="Default model" hint={p.models.length ? `${p.models.length} available; current ${p.currentModel ?? 'agent default'}` : 'The agent chooses.'}>
                    <select className={inputCls} value={current} onChange={(ev) => update({ [modelKey]: ev.target.value || undefined }).catch((err) => setError(String(err)))}>
                      <option value="">Agent default{p.currentModel ? ` (${p.currentModel})` : ''}</option>
                      {p.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="text-[11px] text-muted">
                    <div className="mb-1 font-medium text-text">Modes</div>
                    {p.modes.length ? p.modes.join(', ') : 'none exposed'}
                    <div className="mt-1">Sinfonie maps Ask, Accept edits, Plan and Auto onto these.</div>
                  </div>
                </div>
              )}
              {p && !p.installed && (
                <div className="mt-2 text-[11px] text-muted">
                  {p.signedIn ? null : e.id === 'grok' ? 'Install Grok Build from x.ai, then Check.' : e.id === 'codex' ? 'Runs through npx; make sure Node is on your PATH.' : 'Runs through npx; make sure Node is on your PATH.'}
                </div>
              )}
              <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
                <span className="inline-flex items-center gap-1">{p?.signedIn ? <CheckCircle2 size={12} className="text-ok" /> : <XCircle size={12} className="text-muted" />} usable as an engine</span>
              </div>
            </div>
          )
        })}
      </div>
      {terminal && <LoginTerminal command={terminal.command} accountName={terminal.title} onClose={() => setTerminal(null)} />}
    </div>
  )
}
