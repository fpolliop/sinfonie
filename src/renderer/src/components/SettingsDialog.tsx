import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Dialog, Field, inputCls } from './ui'
import { shortPath } from '@/lib/format'
import { PERMISSION_MODES } from '@shared/types'
import { LoginTerminal } from './LoginTerminal'
import { JiraSection } from './JiraSection'
import { McpSection } from './McpSection'
import { AgentsSection, DEFAULT_CREW } from './AgentsSection'
import { ModelSelect } from './ModelSelect'
import { SpaceSettingsDialog } from './SpaceSettingsDialog'
import { SPACE_COLORS } from '@shared/types'

function AboutRow(): React.JSX.Element {
  const [version, setVersion] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  useEffect(() => {
    api.invoke('app:version').then(setVersion).catch(() => undefined)
  }, [])
  const check = async (): Promise<void> => {
    setStatus('Checking…')
    try {
      const u = await api.invoke('updates:check')
      setStatus(u ? `Version ${u.version} is available.` : `You're on the latest version.`)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-[12px]">
      <span className="font-medium">Sinfonie {version}</span>
      <button className="text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', 'https://sinfonie.dev')}>
        sinfonie.dev
      </button>
      <button className="text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', 'https://github.com/fpolliop/sinfonie-releases/releases')}>
        Releases
      </button>
      <span className="ml-auto flex items-center gap-2">
        {status && <span className="text-muted">{status}</span>}
        <Button size="sm" onClick={check}>
          Check for updates
        </Button>
      </span>
    </div>
  )
}

function FeedbackSection(): React.JSX.Element {
  const { settings, setError } = useApp()
  const [kind, setKind] = useState<'feature' | 'bug' | 'feedback'>('feature')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [includeLogs, setIncludeLogs] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const send = async (): Promise<void> => {
    if (!message.trim()) return
    setStatus('Sending…')
    const r = await api.invoke('feedback:send', { kind, message, email: email || undefined, includeLogs })
    setStatus(r.ok ? 'Sent. Thank you.' : `Could not send: ${r.error}`)
    if (r.ok) setMessage('')
  }
  return (
    <section className="mt-5">
      <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">Feedback and diagnostics</h3>
      <div className="mb-3 rounded-lg border border-border p-3">
        <div className="mb-2 flex gap-1.5">
          {(
            [
              ['feature', 'Feature request'],
              ['bug', 'Bug'],
              ['feedback', 'Feedback']
            ] as const
          ).map(([id, label]) => (
            <button key={id} onClick={() => setKind(id)} className={clsx('rounded-full border px-2.5 py-0.5 text-[12px]', kind === id ? 'border-accent/60 bg-accent/15 text-accent' : 'border-border text-muted hover:text-text')}>
              {label}
            </button>
          ))}
        </div>
        <textarea rows={3} className={inputCls} placeholder={kind === 'bug' ? 'What happened, and what did you expect?' : 'What would make Sinfonie better for you?'} value={message} onChange={(e) => setMessage(e.target.value)} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input className={clsx(inputCls, 'max-w-[240px]')} placeholder="Email for a reply (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
          {kind === 'bug' && (
            <label className="flex items-center gap-1.5 text-[12px] text-muted">
              <input type="checkbox" checked={includeLogs} onChange={(e) => setIncludeLogs(e.target.checked)} /> attach recent error log
            </label>
          )}
          <span className="ml-auto flex items-center gap-2">
            {status && <span className="text-[12px] text-muted">{status}</span>}
            <Button size="sm" variant="primary" disabled={!message.trim()} onClick={send}>
              Send
            </Button>
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-[12px]">
        <label className="flex flex-1 items-center gap-2">
          <input type="checkbox" checked={settings.crashReports !== false} onChange={(e) => api.invoke('settings:update', { crashReports: e.target.checked }).catch((err) => setError(String(err)))} />
          <span>
            Send crash reports automatically
            <span className="block text-[11px] text-muted">Error message, stack trace, app version and macOS version. Never chat content, file paths from your repos, or tokens.</span>
          </span>
        </label>
        <Button size="sm" onClick={() => void api.invoke('logs:open')}>
          Open logs folder
        </Button>
      </div>
    </section>
  )
}

function SpacesSection(): React.JSX.Element {
  const { spaces, workspaces, repos, settings, setError } = useApp()
  const [name, setName] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const add = (): void => {
    if (!name.trim()) return
    void go(() => api.invoke('spaces:create', name)).then(() => setName(''))
  }
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">Spaces</h3>
      <p className="mb-3 text-[11px] text-muted">Each space owns its repositories, Jira connection, Claude account, model, permission mode and workspaces folder. Open one to configure it.</p>
      <div className="mb-3 flex flex-col gap-1.5">
        {spaces.map((s) => {
          const nWs = workspaces.filter((w) => w.spaceId === s.id && w.status !== 'archived').length
          const nRepos = repos.filter((r) => r.spaceId === s.id).length
          return (
            <div key={s.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
              <label className="relative h-4 w-4 shrink-0 cursor-pointer rounded-full" style={{ background: s.color }} title="Colour">
                <select className="absolute inset-0 cursor-pointer opacity-0" value={s.color} onChange={(e) => go(() => api.invoke('spaces:update', s.id, { color: e.target.value }))}>
                  {SPACE_COLORS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <input className="min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none" defaultValue={s.name} onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && go(() => api.invoke('spaces:update', s.id, { name: e.target.value.trim() }))} />
              <span className="shrink-0 text-[11px] text-muted">
                {nWs} workspace{nWs === 1 ? '' : 's'} · {nRepos} repo{nRepos === 1 ? '' : 's'}
              </span>
              {settings.claudeAccounts.length > 1 && (
                <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[11px]" value={s.claudeAccountId ?? ''} onChange={(e) => go(() => api.invoke('spaces:update', s.id, { claudeAccountId: e.target.value || undefined }))} title="Default Claude account for this space">
                  <option value="">Default account</option>
                  {settings.claudeAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              )}
              <Button size="sm" onClick={() => setOpen(s.id)}>
                Settings
              </Button>
              <button title="Delete space (workspaces and repos are kept)" className="rounded p-1 text-muted hover:text-danger" onClick={() => go(() => api.invoke('spaces:delete', s.id))}>
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex gap-2">
        <input className={inputCls} placeholder="New space, e.g. Lumepic" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <Button variant="primary" disabled={!name.trim()} onClick={add}>
          <Plus size={13} /> Add space
        </Button>
      </div>
      {open && <SpaceSettingsDialog spaceId={open} onClose={() => setOpen(null)} />}
    </section>
  )
}

function AccountsSection(): React.JSX.Element {
  const { settings, setError } = useApp()
  const [name, setName] = useState('')
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
  return (
    <section className="mt-5">
      <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">Claude accounts</h3>
      <p className="mb-3 text-[11px] text-muted">Each account is a separate Claude Code login with its own config directory. Pick one per workspace and for the review cockpit.</p>
      <div className="mb-3 flex flex-col gap-1.5">
        {settings.claudeAccounts.map((a) => (
          <div key={a.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                {a.name}
                {a.id === settings.defaultClaudeAccountId && <Badge tone="accent">default</Badge>}
                {a.loggedIn === true && <Badge tone="ok">logged in</Badge>}
                {a.loggedIn === false && <Badge tone="warn">not logged in</Badge>}
              </div>
              <div className="truncate text-[11px] text-muted">{a.detail || (a.configDir ? shortPath(a.configDir) : '~/.claude')}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => check(a.id)} disabled={checking === a.id}>
              {checking === a.id ? 'Checking…' : 'Check'}
            </Button>
            <Button size="sm" onClick={() => setLogin({ id: a.id, name: a.name })}>
              Log in
            </Button>
            {a.id !== settings.defaultClaudeAccountId && (
              <Button size="sm" variant="ghost" onClick={() => go(() => api.invoke('accounts:setDefault', a.id))}>
                Make default
              </Button>
            )}
            {a.id !== 'default' && (
              <button title="Remove" className="rounded p-1 text-muted hover:text-danger" onClick={() => go(() => api.invoke('accounts:remove', a.id))}>
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input className={inputCls} placeholder="Account name, e.g. Work" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && go(() => api.invoke('accounts:add', name)).then(() => setName(''))} />
        <Button variant="primary" disabled={!name.trim()} onClick={() => go(() => api.invoke('accounts:add', name)).then(() => setName(''))}>
          <Plus size={13} /> Add account
        </Button>
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
    </section>
  )
}

export function SettingsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { repos, settings, setError, workspaces, spaces } = useApp()
  const [busy, setBusy] = useState(false)
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const update = (patch: Partial<typeof settings>): Promise<unknown> => api.invoke('settings:update', patch)

  return (
    <Dialog title="Settings" onClose={onClose} width={640}>
      <AboutRow />
      <SpacesSection />
      <section className="mb-5 mt-5">
        <div className="mb-2 flex items-center">
          <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">All repositories</h3>
          <Button size="sm" variant="primary" className="ml-auto" disabled={busy} onClick={() => go(() => api.invoke('repos:pickAndAdd'))}>
            <Plus size={13} /> Add repository
          </Button>
        </div>
        {repos.length === 0 && <div className="rounded-md border border-dashed border-border p-4 text-center text-muted">Add the root folder of each git repository you want to combine in workspaces.</div>}
        <div className="flex flex-col gap-1.5">
          {repos.map((r) => {
            const inUse = workspaces.filter((w) => w.status !== 'archived' && w.repos.some((x) => x.repoId === r.id)).length
            return (
              <div key={r.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-medium">
                    {r.name}
                    <Badge>{r.defaultBranch}</Badge>
                    {r.config?.scripts ? <Badge tone="ok">conductor.json</Badge> : <Badge tone="warn">no conductor.json</Badge>}
                  </div>
                  <div className="truncate text-[11px] text-muted">{shortPath(r.path)}</div>
                </div>
                {spaces.length > 0 && (
                  <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[11px]" value={r.spaceId ?? ''} onChange={(e) => go(() => api.invoke('repos:setSpace', r.id, e.target.value || null))} title="Space">
                    <option value="">No space</option>
                    {spaces.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
                <button title="Reload conductor.json" className="rounded p-1 text-muted hover:text-text" onClick={() => go(() => api.invoke('repos:reloadConfig', r.id))}>
                  <RefreshCw size={13} />
                </button>
                <button title={inUse ? `Used by ${inUse} workspace(s)` : 'Remove'} disabled={inUse > 0} className="rounded p-1 text-muted hover:text-danger disabled:opacity-30" onClick={() => go(() => api.invoke('repos:remove', r.id))}>
                  <Trash2 size={13} />
                </button>
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">App defaults</h3>
        <p className="mb-3 text-[11px] text-muted">Used by spaces that don't set their own. Open a space's settings (gear next to its name in the sidebar) to override per space.</p>
        <Field label="Workspaces folder" hint="Each workspace becomes <folder>/<name>/<repo> so all worktrees of a feature sit together.">
          <input className={inputCls} defaultValue={settings.workspacesRoot} onBlur={(e) => e.target.value !== settings.workspacesRoot && go(() => update({ workspacesRoot: e.target.value }))} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Base port" hint="Each workspace gets a block of 10 ports starting here.">
            <input type="number" className={inputCls} defaultValue={settings.basePort} onBlur={(e) => go(() => update({ basePort: Number(e.target.value) || 55000 }))} />
          </Field>
          <Field label="Model" hint="The orchestrator model for spaces that don't set their own.">
            <ModelSelect value={settings.model} onChange={(model) => go(() => update({ model }))} />
          </Field>
        </div>
        <Field label="Permission mode" hint="Each chat can still switch its own mode from the composer or with Shift+Tab.">
          <select className={inputCls} value={settings.permissionMode} onChange={(e) => go(() => update({ permissionMode: e.target.value as typeof settings.permissionMode }))}>
            {PERMISSION_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.hint}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-[11px] text-muted">Model and permission mode apply to sessions started after the change. Use "New session" in a chat to restart one.</p>
      </section>

      <AccountsSection />
      <AgentsSection
        title="Default crew"
        intro="The subagents spaces get unless they define their own. Orchestrator = the chat model; these handle delegated subtasks with cheaper or more focused models."
        agents={settings.agents}
        onChange={(agents) => go(() => update({ agents }))}
        onResetToDefaults={() => go(() => update({ agents: DEFAULT_CREW }))}
      />

      <McpSection
        title="MCP servers for every space"
        intro="Available to Claude in all workspaces. Add space-specific servers in each space's settings."
        servers={settings.mcpServers ?? []}
        onChange={(mcpServers) => go(() => update({ mcpServers }))}
        strict={{ value: Boolean(settings.strictMcp), onToggle: (v) => go(() => update({ strictMcp: v })) }}
      />
      <FeedbackSection />
      <JiraSection connId="" title="Default Jira" intro="Fallback for spaces without their own Jira connection. Set each space's Jira in its space settings." />
    </Dialog>
  )
}
