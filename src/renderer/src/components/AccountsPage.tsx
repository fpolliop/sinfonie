import React, { useEffect, useState } from 'react'
import { Plus, Trash2, RefreshCw, LogIn, Star, KeyRound, LogOut } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, IconButton, inputCls } from './ui'
import { LoginDialog, PREREQS } from './LoginDialog'
import { shortPath } from '@/lib/format'
import { VENDORS, type AcpProbe, type ClaudeAccount, type Engine, type Vendor } from '@shared/types'
import { useGuided, words } from '@/lib/guided'
import { friendlyError, rawMessage } from '@/lib/errors'

/** Product names for the guided lens, where "Default (~/.claude)" would show a folder. */
const PRODUCT: Record<Vendor, string> = { anthropic: 'Claude', openai: 'OpenAI', google: 'Google', xai: 'Grok' }

/** An account's name as a person should read it: the built-in default accounts become "Your Claude account" in guided. */
export function accountDisplayName(a: Pick<ClaudeAccount, 'name' | 'vendor'>, guided: boolean): string {
  if (!guided) return a.name
  const vendor = a.vendor ?? 'anthropic'
  if (/^Default \(/.test(a.name)) return `Your ${PRODUCT[vendor]} account`
  return a.name.replace(/\s*\([~/][^)]*\)\s*$/, '')
}

/** Why an account is not signed in, in the reader's words (both lenses), or null when there is nothing useful to add. */
function notSignedInReason(a: ClaudeAccount, vendor: Vendor, guided: boolean): string | null {
  if (a.loggedIn !== false) return null
  if (a.missing) {
    const pre = PREREQS[a.missing]
    return vendor === 'google' ? `Needs ${guided ? pre.guided : pre.expert} on this Mac. Install it, then press Check.` : `Needs ${guided ? pre.guided : pre.expert} on this Mac. Press Sign in to set it up.`
  }
  if (vendor === 'google') return guided ? 'Paste your Google key above, then press Check.' : 'Gemini signs in with a key: add one under Model providers → Google, then press Check.'
  return guided ? 'Not signed in yet. Press Sign in to connect it.' : null
}

/** Module-level cache of the last probe per engine, for model pickers elsewhere. */
export const acpProbeCache: Partial<Record<Engine, AcpProbe>> = {}

/**
 * One page for every login: Anthropic, OpenAI, Google, xAI, each with any number of accounts. Guided mode shows
 * the same vendors with the product-terms intro and without the developer hints (CLI names, config folders).
 */
export function AccountsPage({ guided: guidedProp }: { guided?: boolean } = {}): React.JSX.Element {
  const { settings, setError, openSettings } = useApp()
  const guidedMode = useGuided()
  const guided = guidedProp ?? guidedMode
  const [names, setNames] = useState<Partial<Record<Vendor, string>>>({})
  const [login, setLogin] = useState<{ id: string; name: string; vendor: string } | null>(null)
  const [checking, setChecking] = useState<string | null>(null)
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(friendlyError(err))
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
  const w = words(guided)

  return (
    <div className="max-w-[760px]">
      <p className="mb-4 text-[12px] text-muted">{guided ? 'Sign in to the AI you want to build with: Anthropic, OpenAI or xAI. For Google (Gemini), paste the key your admin gave you.' : 'Each vendor’s coding agent keeps its own login, and Sinfonie can hold several accounts per vendor. A space or workspace picks which one to use; the engine itself is chosen under Agents & models.'}</p>
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
                    {v.label} {!guided && <span className="font-normal text-muted">· {v.agent}</span>}
                  </div>
                  {!guided && <div className="text-[11px] text-muted">{v.hint}</div>}
                </div>
                {v.id === 'google' && !guided && (
                  <Button size="sm" variant="ghost" onClick={() => openSettings({ scope: 'app', page: 'providers' })}>
                    Model providers → Google
                  </Button>
                )}
              </div>
              {/* Guided has no Model providers page, so the Gemini key is pasted right here. */}
              {v.id === 'google' && guided && <GoogleKeyField onSaved={() => list.forEach((a) => void check(a.id))} />}
              <div className="flex flex-col gap-1.5 p-2">
                {list.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[13px] font-medium">
                        {accountDisplayName(a, guided)}
                        {a.id === def && <Badge tone="accent">default</Badge>}
                        {a.loggedIn === true && <Badge tone="ok">signed in</Badge>}
                        {a.loggedIn === false && <Badge tone="warn">not signed in</Badge>}
                        {a.loggedIn === undefined && <Badge>unchecked</Badge>}
                      </div>
                      {!guided && <div className="truncate text-[11px] text-muted">{a.detail || (a.configDir ? shortPath(a.configDir) : 'your normal login on this Mac')}</div>}
                      {checking === a.id && v.id !== 'anthropic' && <div className="text-[11px] text-muted">{guided ? 'The first check can take a minute or two.' : 'The first check downloads the agent; this can take a minute or two.'}</div>}
                      {checking !== a.id && notSignedInReason(a, v.id, guided) && <div className="text-[11px] text-warn">{notSignedInReason(a, v.id, guided)}</div>}
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => check(a.id)} disabled={checking === a.id} title={guided ? 'Check whether this account is signed in' : 'Ask the CLI whether this account is signed in'}>
                      <RefreshCw size={12} className={checking === a.id ? 'animate-spin' : ''} /> {checking === a.id ? 'Checking…' : 'Check'}
                    </Button>
                    {v.id !== 'google' && (
                      <Button size="sm" onClick={() => setLogin({ id: a.id, name: accountDisplayName(a, guided), vendor: v.label })}>
                        <LogIn size={12} /> Sign in
                      </Button>
                    )}
                    {a.id !== def && (
                      <Button size="sm" variant="ghost" onClick={() => go(() => api.invoke('accounts:setDefault', a.id))} title={`Use this account unless a ${w.space} or ${w.workspace} picks another`}>
                        <Star size={12} /> Make default
                      </Button>
                    )}
                    {a.configDir !== null &&
                      (guided ? (
                        <IconButton label={`Sign out of ${accountDisplayName(a, guided)}`} className="hover:text-danger" onClick={() => window.confirm(`Sign out of ${accountDisplayName(a, guided)}? Teams and tasks using it switch to your default account.`) && go(() => api.invoke('accounts:remove', a.id))}>
                          <LogOut size={13} />
                        </IconButton>
                      ) : (
                        <IconButton label={`Remove ${a.name} (its config folder is kept on disk)`} className="hover:text-danger" onClick={() => window.confirm('Remove this account? Spaces and workspaces using it fall back to the default; its login folder stays on disk.') && go(() => api.invoke('accounts:remove', a.id))}>
                          <Trash2 size={13} />
                        </IconButton>
                      ))}
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <input className={inputCls} aria-label={`Add another ${v.label} account`} placeholder={`Add another ${v.label} account, e.g. Work`} value={names[v.id] ?? ''} onChange={(e) => setNames({ ...names, [v.id]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && names[v.id]?.trim() && go(() => api.invoke('accounts:add', names[v.id]!, v.id)).then(() => setNames({ ...names, [v.id]: '' }))} />
                  <Button variant="primary" size="sm" disabled={!names[v.id]?.trim()} onClick={() => go(() => api.invoke('accounts:add', names[v.id]!, v.id)).then(() => setNames({ ...names, [v.id]: '' }))}>
                    <Plus size={12} /> Add
                  </Button>
                </div>
                {!guided && v.engine !== 'claude-code' && probe?.signedIn && probe.models.length > 0 && (
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                    <span className="shrink-0">Default model for the {v.agent} engine:</span>
                    <div className="w-[220px] shrink-0">
                    <select className={inputCls} aria-label={`Default model for the ${v.agent} engine`} value={(settings as unknown as Record<string, string | undefined>)[modelKey] ?? ''} onChange={(e) => go(() => update({ [modelKey]: e.target.value || undefined }))}>
                      <option value="">Agent default{probe.currentModel ? ` (${probe.currentModel})` : ''}</option>
                      {probe.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    </div>
                    {probe.modes.length > 0 && <span>· modes: {probe.modes.join(', ')}</span>}
                  </div>
                )}
              </div>
            </section>
          )
        })}
      </div>
      {login && (
        <LoginDialog
          accountId={login.id}
          vendorLabel={login.vendor}
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

/**
 * Guided mode's Google key: the Gemini agent signs in with a key from a "Google Gemini" model provider. Guided users
 * never see Model providers, so this saves to the same provider (creating it the first time) from the Sign-in page.
 */
function GoogleKeyField({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const provider = useApp((s) => (s.settings.providers ?? []).find((p) => p.kind === 'google'))
  const notify = useApp((s) => s.notify)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    if (!key.trim() || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const id = provider ? provider.id : (await api.invoke('providers:add', { kind: 'google', name: 'Google Gemini', apiKey: key.trim() })).id
      if (provider) await api.invoke('providers:update', provider.id, { apiKey: key.trim() })
      setKey('')
      // Saved either way; now ask Google whether it takes the key, and say plainly when it does not.
      try {
        await api.invoke('providers:models', id)
        notify({ kind: 'success', text: 'Google key saved and working.' })
      } catch (err) {
        if (/reach|did not answer|fetch failed|network|ENOTFOUND|ETIMEDOUT/i.test(rawMessage(err))) notify({ kind: 'success', text: 'Google key saved. Sinfonie could not check it right now; press Check when you are back online.' })
        else setFailure(friendlyError(err, 'Google did not accept that key. Paste a new key and save again.'))
      }
      onSaved()
    } catch (err) {
      setFailure(friendlyError(err, 'That key could not be saved. Check it and try again.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="border-b border-border px-3 py-2">
      <label className="mb-1 flex items-center gap-2 text-[12px] text-muted" htmlFor="guided-google-key">
        <KeyRound size={12} /> Google (Gemini) · paste the key your admin gave you
        {provider?.hasKey && <Badge tone="ok">key saved</Badge>}
      </label>
      <div className="flex items-center gap-2">
        <input id="guided-google-key" type="password" className={inputCls} placeholder={provider?.hasKey ? 'Paste a new key to replace the saved one' : 'Paste the key here'} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
        <Button size="sm" variant="primary" disabled={!key.trim() || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {failure && <p className="mt-1 text-[12px] text-danger">{failure}</p>}
    </div>
  )
}
