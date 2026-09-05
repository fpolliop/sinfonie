import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Plus, RefreshCw, Trash2, FolderGit2, Settings as SettingsIcon, Layers, Server, UserCircle2, Users, Plug, Ticket, GitPullRequest, MessageSquarePlus, Info, FolderTree, ChevronRight, Gauge, Siren, CircleDot, Hash, Activity } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp, type SettingsTarget, type AppPage, type SpacePage } from '@/stores/app'
import { Badge, Button, Field, inputCls } from './ui'
import { shortPath } from '@/lib/format'
import { PERMISSION_MODES, SPACE_COLORS, jiraConnectionFor, linearConnectionFor, type Space } from '@shared/types'
import { JiraSection } from './JiraSection'
import { LinearSection } from './LinearSection'
import { SlackConnectionCard } from './SlackConnectionCard'
import { McpSection } from './McpSection'
import { AgentsSection, DEFAULT_CREW } from './AgentsSection'
import { ModelSelect } from './ModelSelect'
import { ProvidersSection } from './ProvidersSection'
import { EngineSelect, NativeModelSelect } from './EngineSelect'
import { AccountsPage, acpProbeCache } from './AccountsPage'
import { ResourcesPage } from './ResourcesPage'
import { UsagePage } from './UsagePage'
import { OnCallSettings } from './OnCallSettings'
import { ACP_ENGINES, VENDORS } from '@shared/types'

/**
 * One settings window for everything. The rail on the left separates what
 * applies to the whole application from what belongs to one space; every page
 * says which of the two it is, and space pages say what they override.
 */
const APP_PAGES: { id: AppPage; label: string; icon: React.ReactNode; desc: string; group?: string }[] = [
  { id: 'general', label: 'General', icon: <SettingsIcon size={14} />, desc: 'Defaults every space starts from: engine, models, permission mode, folders, ports.' },
  { id: 'spaces', label: 'Spaces', icon: <Layers size={14} />, desc: 'Create and remove spaces. Each space has its own pages below.' },
  { id: 'repos', label: 'Repositories', icon: <FolderGit2 size={14} />, desc: 'Every git repository the app knows, and which space each belongs to.' },
  { id: 'providers', label: 'Model providers', icon: <Server size={14} />, desc: 'API keys and local servers for the native engine. Shared by all spaces.' },
  { id: 'accounts', label: 'Accounts', icon: <UserCircle2 size={14} />, desc: 'Logins for Anthropic, OpenAI, Google and xAI agents. Several per vendor; spaces and workspaces pick one.' },
  { id: 'crew', label: 'Default crew', icon: <Users size={14} />, desc: 'The subagents a space gets unless it defines its own crew.' },
  { id: 'resources', label: 'Resources', icon: <Gauge size={14} />, desc: 'Memory per session, subagent and session limits, and what happens under pressure.' },
  { id: 'usage', label: 'Usage', icon: <Activity size={14} />, desc: 'Subscription windows per account, spend per day, and where it went.' },
  { id: 'oncall', label: 'On call', icon: <Siren size={14} />, desc: 'Slack channels to watch, the triage agent, and how it drafts replies.' },
  { id: 'jira', label: 'Jira', icon: <Ticket size={14} />, desc: 'The fallback Jira connection for spaces without their own.', group: 'Integrations' },
  { id: 'linear', label: 'Linear', icon: <CircleDot size={14} />, desc: 'The fallback Linear connection for spaces without their own.', group: 'Integrations' },
  { id: 'slack', label: 'Slack', icon: <Hash size={14} />, desc: 'Your Slack sign-in, used by the on-call agent and available to sessions.', group: 'Integrations' },
  { id: 'mcp', label: 'MCP servers', icon: <Plug size={14} />, desc: 'MCP servers available in every space.', group: 'Integrations' },
  { id: 'feedback', label: 'Feedback & diagnostics', icon: <MessageSquarePlus size={14} />, desc: 'Send feedback, review captured errors, control crash reports.' },
  { id: 'about', label: 'About & updates', icon: <Info size={14} />, desc: 'Version, links, and update checks.' }
]
const SPACE_PAGES: { id: SpacePage; label: string; icon: React.ReactNode; desc: string; overrides?: AppPage; group?: string }[] = [
  { id: 'general', label: 'General', icon: <SettingsIcon size={14} />, desc: 'Name, colour, and this space’s engine, model, permission mode, folder and account.', overrides: 'general' },
  { id: 'repos', label: 'Repositories', icon: <FolderGit2 size={14} />, desc: 'Repositories this space owns. New workspaces here offer these.', overrides: 'repos' },
  { id: 'crew', label: 'Crew', icon: <Users size={14} />, desc: 'Subagents the orchestrator can delegate to in this space.', overrides: 'crew' },
  { id: 'oncall', label: 'On call', icon: <Siren size={14} />, desc: 'Slack channels this space\u2019s on-call agent watches, and how it triages.' },
  { id: 'jira', label: 'Jira', icon: <Ticket size={14} />, desc: 'This space’s Jira site and login.', overrides: 'jira', group: 'Integrations' },
  { id: 'linear', label: 'Linear', icon: <CircleDot size={14} />, desc: 'This space’s Linear login.', overrides: 'linear', group: 'Integrations' },
  { id: 'slack', label: 'Slack', icon: <Hash size={14} />, desc: 'This space\u2019s Slack sign-in, when it lives in a different Slack workspace than the application default.', overrides: 'slack', group: 'Integrations' },
  { id: 'github', label: 'GitHub', icon: <GitPullRequest size={14} />, desc: 'Which GitHub owners the review cockpit lists for this space.', group: 'Integrations' },
  { id: 'mcp', label: 'MCP servers', icon: <Plug size={14} />, desc: 'Servers for this space, on top of the application-wide ones.', overrides: 'mcp', group: 'Integrations' }
]

export function SettingsWindow({ target, onClose }: { target: SettingsTarget; onClose: () => void }): React.JSX.Element {
  const { spaces, openSettings } = useApp()
  const space = target.scope === 'space' ? spaces.find((s) => s.id === target.spaceId) : undefined
  // Hide any workspace browser page while settings are up, so this overlay stays clickable.
  useEffect(() => {
    void api.invoke('browser:suspend', true)
    return () => void api.invoke('browser:suspend', false)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // A deleted space closes its pages.
  useEffect(() => {
    if (target.scope === 'space' && !space) openSettings({ scope: 'app', page: 'spaces' })
  }, [target, space, openSettings])

  const page = target.scope === 'app' ? APP_PAGES.find((p) => p.id === target.page)! : SPACE_PAGES.find((p) => p.id === target.page)!
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 no-drag" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex h-[84vh] w-[980px] max-w-[95vw] overflow-hidden rounded-xl border border-border bg-panel shadow-2xl">
        {/* rail */}
        <nav className="flex w-[232px] shrink-0 flex-col overflow-auto border-r border-border bg-bg/60 p-2">
          <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Application</div>
          {APP_PAGES.map((p, i) => (
            <React.Fragment key={p.id}>
              {p.group && APP_PAGES[i - 1]?.group !== p.group && <div className="mt-3 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{p.group}</div>}
              {!p.group && APP_PAGES[i - 1]?.group && <div className="mt-3 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Help</div>}
              <NavItem active={target.scope === 'app' && target.page === p.id} icon={p.icon} label={p.label} onClick={() => openSettings({ scope: 'app', page: p.id })} />
            </React.Fragment>
          ))}
          <div className="mt-3 flex items-center px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Spaces
            <button className="ml-auto rounded p-0.5 hover:bg-panel-2 hover:text-text" title="New space" onClick={() => openSettings({ scope: 'app', page: 'spaces' })}>
              <Plus size={12} />
            </button>
          </div>
          {spaces.length === 0 && <div className="px-2 py-1 text-[11px] text-muted">No spaces yet.</div>}
          {spaces.map((s) => {
            const open = target.scope === 'space' && target.spaceId === s.id
            return (
              <div key={s.id}>
                <NavItem active={open && target.page === 'general'} icon={<span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />} label={s.name} chevron={open} onClick={() => openSettings({ scope: 'space', spaceId: s.id, page: 'general' })} />
                {open && (
                  <div className="mb-1 ml-3 border-l border-border pl-1">
                    {SPACE_PAGES.map((p, i) => (
                      <React.Fragment key={p.id}>
                        {p.group && SPACE_PAGES[i - 1]?.group !== p.group && <div className="mt-1.5 px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{p.group}</div>}
                        <NavItem small active={target.page === p.id} icon={p.icon} label={p.label} onClick={() => openSettings({ scope: 'space', spaceId: s.id, page: p.id })} />
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
        {/* content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-start gap-3 border-b border-border px-6 py-4">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
                {target.scope === 'app' ? (
                  <span className="rounded bg-accent/15 px-1.5 py-px text-accent">Application</span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded px-1.5 py-px" style={{ background: (space?.color ?? '#888') + '26', color: space?.color }}>
                    <span className="h-2 w-2 rounded-full" style={{ background: space?.color }} /> Space · {space?.name}
                  </span>
                )}
                <span className="text-muted">/ {page.label}</span>
              </div>
              <h2 className="text-[16px] font-semibold">{page.label}</h2>
              <p className="text-[12px] text-muted">{page.desc}</p>
              {target.scope === 'space' && 'overrides' in page && page.overrides && (
                <p className="mt-1 text-[11px] text-muted">
                  Values set here override the application defaults for this space only.{' '}
                  <button className="text-accent hover:underline" onClick={() => openSettings({ scope: 'app', page: page.overrides as AppPage })}>
                    See application {APP_PAGES.find((p) => p.id === page.overrides)?.label.toLowerCase()}
                  </button>
                </p>
              )}
            </div>
            <button className="text-muted hover:text-text" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </header>
          <div className="flex-1 overflow-auto px-6 py-4">{target.scope === 'app' ? <AppPageView page={target.page} /> : space ? <SpacePageView space={space} page={target.page} /> : null}</div>
        </div>
      </div>
    </div>
  )
}

function NavItem({ active, icon, label, onClick, small, chevron }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void; small?: boolean; chevron?: boolean }): React.JSX.Element {
  return (
    <button onClick={onClick} className={clsx('flex w-full items-center gap-2 rounded-md px-2 text-left', small ? 'py-1 text-[12px]' : 'py-1.5 text-[13px]', active ? 'bg-panel-2 text-text' : 'text-muted hover:bg-panel-2/60 hover:text-text')}>
      <span className="flex w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="truncate">{label}</span>
      {chevron !== undefined && <ChevronRight size={11} className={clsx('ml-auto transition-transform', chevron && 'rotate-90')} />}
    </button>
  )
}

function useGo(): (fn: () => Promise<unknown>) => Promise<void> {
  const setError = useApp((s) => s.setError)
  return async (fn) => {
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
}

// ---------------- application pages ----------------

function AppPageView({ page }: { page: AppPage }): React.JSX.Element {
  const { settings, setFeedbackDialog } = useApp()
  const go = useGo()
  const update = (patch: Partial<typeof settings>): Promise<unknown> => api.invoke('settings:update', patch)
  switch (page) {
    case 'general':
      return (
        <div className="max-w-[640px]">
          <Field label="Engine" hint="Which runtime drives chats. Spaces can override it.">
            <EngineSelect value={settings.engine ?? 'claude-code'} onChange={(engine) => go(() => update({ engine: engine as typeof settings.engine }))} />
          </Field>
          {(settings.engine ?? 'claude-code') === 'claude-code' && (
            <Field label="Claude Code model" hint="Orchestrator model for the Claude Code engine.">
              <ModelSelect value={settings.model} onChange={(model) => go(() => update({ model }))} />
            </Field>
          )}
          {settings.engine === 'native' && (
            <Field label="Native model" hint="Orchestrator model for the native engine, from Model providers.">
              <NativeModelSelect value={settings.nativeModel ?? ''} onChange={(nativeModel) => go(() => update({ nativeModel }))} />
            </Field>
          )}
          {ACP_ENGINES.some((e) => e.id === settings.engine) && (
            <p className="mb-3 text-[11px] text-muted">The default model for this engine is chosen under Accounts.</p>
          )}
          <label className="mb-3 flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={Boolean(settings.budgetMode)} onChange={(e) => go(() => update({ budgetMode: e.target.checked }))} />
            <span>
              Budget mode by default
              <span className="block text-[11px] text-muted">For limited subscriptions: Sonnet as orchestrator, low reasoning effort, at most two subagents, reviews on Sonnet, and 60 tool calls per message before the agent stops and reports. Spaces can override it.</span>
            </span>
          </label>
          <label className="mb-3 flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={Boolean(settings.leanMode)} onChange={(e) => go(() => update({ leanMode: e.target.checked }))} />
            <span>
              Lean mode by default
              <span className="block text-[11px] text-muted">The fewest tokens that still get the job done: one Sonnet agent with no crew or subagents, no browser, notes or web tools, shell output cut to the last lines, 25 tool calls per message before it stops and reports, reviews capped at 30 turns and one fix round. Overrides Budget mode. Spaces can override it.</span>
            </span>
          </label>
          <Field label="Permission mode" hint="Each chat can still switch its own mode from the composer or with Shift+Tab.">
            <select className={inputCls} value={settings.permissionMode} onChange={(e) => go(() => update({ permissionMode: e.target.value as typeof settings.permissionMode }))}>
              {PERMISSION_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.hint}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Workspaces folder" hint="Each workspace becomes <folder>/<name>/<repo> so all worktrees of a feature sit together.">
            <input className={inputCls} defaultValue={settings.workspacesRoot} onBlur={(e) => e.target.value !== settings.workspacesRoot && go(() => update({ workspacesRoot: e.target.value }))} />
          </Field>
          <label className="mb-3 flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={Boolean(settings.browserEvaluate)} onChange={(e) => go(() => update({ browserEvaluate: e.target.checked }))} />
            <span>
              Let agents run JavaScript in the workspace browser (browser_evaluate)
              <span className="block text-[11px] text-muted">Off by default: arbitrary scripts in a logged-in console are the sharpest tool in the box. Sensitive sites still ask first.</span>
            </span>
          </label>
          <Field label="Base port" hint="Each workspace gets a block of 10 ports starting here, exposed as SINFONIE_PORT.">
            <input type="number" className={clsx(inputCls, 'max-w-[200px]')} defaultValue={settings.basePort} onBlur={(e) => go(() => update({ basePort: Number(e.target.value) || 55000 }))} />
          </Field>
          <p className="text-[11px] text-muted">Engine, model and permission mode apply to sessions started after the change. Use New session in a chat to restart one.</p>
        </div>
      )
    case 'spaces':
      return <SpacesPage />
    case 'repos':
      return <ReposPage />
    case 'providers':
      return <ProvidersSection />
    case 'accounts':
    case 'logins':
      return <AccountsPage />
    case 'resources':
      return <ResourcesPage />
    case 'usage':
      return <UsagePage />
    case 'oncall':
      return <OnCallSettings />
    case 'crew':
      return (
        <AgentsSection
          title="Default crew"
          intro="Orchestrator = the chat model; these handle delegated subtasks on any vendor's model. Spaces inherit this list until they edit their own."
          agents={settings.agents}
          onChange={(agents) => go(() => update({ agents }))}
          onResetToDefaults={() => go(() => update({ agents: DEFAULT_CREW }))}
          orchestrator={{
            value: (settings.engine ?? 'claude-code') === 'native' ? settings.nativeModel ?? '' : (settings.engine ?? 'claude-code') === 'claude-code' ? settings.model : ((settings[`${settings.engine}Model` as 'codexModel'] as string | undefined) ?? ''),
            label: 'app default',
            onChange: (model) => go(() => update((settings.engine ?? 'claude-code') === 'native' ? { nativeModel: model } : (settings.engine ?? 'claude-code') === 'claude-code' ? { model } : { [`${settings.engine}Model`]: model }))
          }}
        />
      )
    case 'mcp':
      return <McpSection title="MCP servers for every space" intro="Available in all workspaces. Add space-specific servers on a space’s MCP page." servers={settings.mcpServers ?? []} onChange={(mcpServers) => go(() => update({ mcpServers }))} strict={{ value: Boolean(settings.strictMcp), onToggle: (v) => go(() => update({ strictMcp: v })) }} />
    case 'jira':
      return <JiraSection connId="" title="Default Jira connection" intro="Used by spaces that have not connected their own Jira. Connect a space’s own site on its Jira page." />
    case 'linear':
      return <LinearSection connId="" title="Default Linear connection" intro="Used by spaces that have not connected their own Linear. Connect a space’s own on its Linear page." />
    case 'slack':
      return (
        <div className="max-w-[760px]">
          <SlackConnectionCard />
          <p className="text-[11px] text-muted">The on-call agent uses this sign-in to watch channels and send the replies you approve. Set up channels under Application → On call.</p>
        </div>
      )
    case 'feedback':
      return (
        <div className="max-w-[640px]">
          <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-[12px]">
            <span className="flex-1 text-muted">Feature requests, bugs, the captured error log and the crash-report switch live in the Feedback dialog.</span>
            <Button size="sm" onClick={() => setFeedbackDialog('feedback')}>
              Open Feedback (⇧⌘F)
            </Button>
          </div>
        </div>
      )
    case 'about':
      return <AboutPage />
  }
}

function SpacesPage(): React.JSX.Element {
  const { spaces, workspaces, repos, openSettings } = useApp()
  const go = useGo()
  const [name, setName] = useState('')
  const add = (): void => {
    if (!name.trim()) return
    void go(async () => {
      const s = await api.invoke('spaces:create', name)
      setName('')
      openSettings({ scope: 'space', spaceId: s.id, page: 'general' })
    })
  }
  return (
    <div className="max-w-[640px]">
      <div className="mb-3 flex gap-2">
        <input className={inputCls} placeholder="New space, e.g. Work" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <Button variant="primary" disabled={!name.trim()} onClick={add}>
          <Plus size={13} /> Add space
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        {spaces.map((s) => {
          const nWs = workspaces.filter((w) => w.spaceId === s.id && w.status !== 'archived').length
          const nRepos = repos.filter((r) => r.spaceId === s.id).length
          return (
            <div key={s.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.name}</span>
              <span className="shrink-0 text-[11px] text-muted">
                {nWs} workspace{nWs === 1 ? '' : 's'} · {nRepos} repo{nRepos === 1 ? '' : 's'}
              </span>
              <Button size="sm" onClick={() => openSettings({ scope: 'space', spaceId: s.id, page: 'general' })}>
                Open
              </Button>
              <button title="Delete space (workspaces and repos are kept)" className="rounded p-1 text-muted hover:text-danger" onClick={() => go(() => api.invoke('spaces:delete', s.id))}>
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
        {spaces.length === 0 && <div className="rounded-md border border-dashed border-border p-3 text-center text-[12px] text-muted">No spaces yet. Spaces group workspaces and repositories, e.g. Personal, Work, Client.</div>}
      </div>
    </div>
  )
}

function ReposPage(): React.JSX.Element {
  const { repos, workspaces, spaces } = useApp()
  const go = useGo()
  return (
    <div className="max-w-[700px]">
      <div className="mb-2 flex items-center">
        <span className="text-[12px] text-muted">{repos.length} repositor{repos.length === 1 ? 'y' : 'ies'}</span>
        <Button size="sm" variant="primary" className="ml-auto" onClick={() => go(() => api.invoke('repos:pickAndAdd'))}>
          <Plus size={13} /> Add repository
        </Button>
      </div>
      {repos.length === 0 && <div className="rounded-md border border-dashed border-border p-4 text-center text-muted">Add the root folder of each git repository you want to combine in workspaces.</div>}
      <div className="flex flex-col gap-1.5">
        {repos.map((r) => {
          const inUse = workspaces.filter((w) => w.status !== 'archived' && w.repos.some((x) => x.repoId === r.id)).length
          return (
            <div key={r.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
              <FolderGit2 size={14} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  {r.name}
                  <Badge>{r.defaultBranch}</Badge>
                  {r.config?.scripts ? <Badge tone="ok">sinfonie.json</Badge> : <Badge tone="warn">no conductor.json</Badge>}
                </div>
                <div className="truncate text-[11px] text-muted">{shortPath(r.path)}</div>
              </div>
              <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[11px]" value={r.spaceId ?? ''} onChange={(e) => go(() => api.invoke('repos:setSpace', r.id, e.target.value || null))} title="Space">
                <option value="">No space</option>
                {spaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button title="Reload sinfonie.json" className="rounded p-1 text-muted hover:text-text" onClick={() => go(() => api.invoke('repos:reloadConfig', r.id))}>
                <RefreshCw size={13} />
              </button>
              <button title={inUse ? `Used by ${inUse} workspace(s)` : 'Remove'} disabled={inUse > 0} className="rounded p-1 text-muted hover:text-danger disabled:opacity-30" onClick={() => go(() => api.invoke('repos:remove', r.id))}>
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AboutPage(): React.JSX.Element {
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
  const setOnboarding = useApp((s) => s.setOnboarding)
  const closeSettings = useApp((s) => s.closeSettings)
  return (
    <div className="max-w-[640px]">
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[12px]">
        <span className="text-muted">New here?</span>
        <Button size="sm" variant="ghost" onClick={() => { closeSettings(); setOnboarding('setup') }}>
          Run the setup assistant
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { closeSettings(); setOnboarding('tour') }}>
          Take the tour
        </Button>
      </div>
      <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-3 text-[13px]">
        <span className="font-semibold">Sinfonie {version}</span>
        <button className="text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', 'https://sinfonie.dev')}>
          sinfonie.dev
        </button>
        <button className="text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', 'https://github.com/fpolliop/sinfonie-releases/releases')}>
          Release notes
        </button>
        <span className="ml-auto flex items-center gap-2">
          {status && <span className="text-[12px] text-muted">{status}</span>}
          <Button size="sm" onClick={check}>
            Check for updates
          </Button>
        </span>
      </div>
      <p className="mt-3 text-[11px] text-muted">Updates are checked at launch and every six hours. Unsigned builds update by downloading the new version.</p>
    </div>
  )
}

// ---------------- space pages ----------------

function SpacePageView({ space, page }: { space: Space; page: SpacePage }): React.JSX.Element {
  const { settings } = useApp()
  const go = useGo()
  const upd = (patch: Parameters<typeof api.invoke<'spaces:update'>>[2]): Promise<unknown> => api.invoke('spaces:update', space.id, patch)
  const engine = space.engine ?? settings.engine ?? 'claude-code'
  switch (page) {
    case 'general':
      return (
        <div className="max-w-[640px]">
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label="Name">
              <input className={inputCls} defaultValue={space.name} onBlur={(e) => e.target.value.trim() && e.target.value !== space.name && go(() => upd({ name: e.target.value.trim() }))} />
            </Field>
            <Field label="Colour">
              <div className="flex h-[34px] items-center gap-1.5">
                {SPACE_COLORS.map((c) => (
                  <button key={c} className="h-5 w-5 rounded-full border-2" style={{ background: c, borderColor: c === space.color ? '#fff' : 'transparent' }} onClick={() => go(() => upd({ color: c }))} />
                ))}
              </div>
            </Field>
          </div>
          <Group title="Overrides for this space" hint="Leave a field on “App default” to inherit the application setting.">
            <Field label="Engine" hint="Claude Code uses your Claude login; Sinfonie native runs any provider from Model providers.">
              <EngineSelect value={space.engine ?? ''} allowDefault onChange={(e) => go(() => upd({ engine: (e || undefined) as never }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Model" hint={engine === 'native' ? 'Orchestrator model as provider/model.' : ACP_ENGINES.some((e) => e.id === engine) ? 'From the agent’s own model list (see Agent logins).' : 'Orchestrator model for chats in this space.'}>
                {engine === 'native' ? (
                  <NativeModelSelect value={space.model ?? ''} allowDefault defaultLabel={`App default (${settings.nativeModel || 'not set'})`} onChange={(model) => go(() => upd({ model }))} />
                ) : ACP_ENGINES.some((e) => e.id === engine) ? (
                  <select className={inputCls} value={space.model ?? ''} onChange={(e) => go(() => upd({ model: e.target.value }))}>
                    <option value="">Engine default</option>
                    {space.model && !(acpProbeCache[engine]?.models ?? []).includes(space.model) && <option value={space.model}>{space.model}</option>}
                    {(acpProbeCache[engine]?.models ?? []).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <ModelSelect value={space.model ?? ''} allowDefault defaultLabel={`App default (${settings.model})`} onChange={(model) => go(() => upd({ model }))} />
                )}
              </Field>
              <Field label="Budget mode" hint={`App default: ${settings.budgetMode ? 'on' : 'off'}. Sonnet orchestrator, low effort, two subagents, 60 tool calls per message.`}>
                <select className={inputCls} value={space.budgetMode === undefined ? '' : space.budgetMode ? 'on' : 'off'} onChange={(e) => go(() => upd({ budgetMode: e.target.value === '' ? undefined : e.target.value === 'on' }))}>
                  <option value="">App default</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </Field>
              <Field label="Lean mode" hint={`App default: ${settings.leanMode ? 'on' : 'off'}. One Sonnet agent, no crew, trimmed tools and context, 25 tool calls per message, lean reviews. Overrides Budget mode.`}>
                <select className={inputCls} value={space.leanMode === undefined ? '' : space.leanMode ? 'on' : 'off'} onChange={(e) => go(() => upd({ leanMode: e.target.value === '' ? undefined : e.target.value === 'on' }))}>
                  <option value="">App default</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </Field>
              <Field label="Permission mode" hint={`App default: ${PERMISSION_MODES.find((m) => m.id === settings.permissionMode)?.label ?? settings.permissionMode}`}>
                <select className={inputCls} value={space.permissionMode ?? ''} onChange={(e) => go(() => upd({ permissionMode: (e.target.value || undefined) as never }))}>
                  <option value="">App default</option>
                  {PERMISSION_MODES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.hint}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Workspaces folder" hint={`App default: ${settings.workspacesRoot}`}>
              <input className={inputCls} placeholder={settings.workspacesRoot} defaultValue={space.workspacesRoot ?? ''} onBlur={(e) => (e.target.value.trim() || '') !== (space.workspacesRoot ?? '') && go(() => upd({ workspacesRoot: e.target.value.trim() }))} />
            </Field>
            <Field label="Browser: sites that always ask" hint="One per line, host with optional path (e.g. admin.example.com or example.com/admin). Agent actions there prompt whatever the permission mode. AWS, Cloudflare, GCP, Azure, Vercel, Stripe and other consoles are always included.">
              <textarea className={clsx(inputCls, 'min-h-[64px] font-mono text-[12px]')} defaultValue={(space.browserSensitiveOrigins ?? []).join('\n')} onBlur={(e) => go(() => upd({ browserSensitiveOrigins: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean) }))} />
            </Field>
            <Field label="Account" hint="Which login the engine uses for workspaces in this space. Manage them under Application → Accounts.">
              <select className={inputCls} value={space.claudeAccountId ?? ''} onChange={(e) => go(() => upd({ claudeAccountId: e.target.value || undefined }))}>
                <option value="">Vendor default</option>
                {settings.claudeAccounts
                  .filter((a) => (a.vendor ?? 'anthropic') === (VENDORS.find((v) => v.engine === engine)?.id ?? 'anthropic'))
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
          </Group>
          <div className="mt-6 flex items-center gap-3 rounded-lg border border-danger/30 px-3 py-2 text-[12px]">
            <span className="flex-1 text-muted">Deleting a space keeps its workspaces and repositories; they move to “No space”.</span>
            <Button size="sm" variant="danger" onClick={() => go(() => api.invoke('spaces:delete', space.id))}>
              <Trash2 size={12} /> Delete space
            </Button>
          </div>
        </div>
      )
    case 'repos':
      return <SpaceRepos space={space} />
    case 'crew':
      return (
        <AgentsSection
          title="Crew for this space"
          intro="Subagents the orchestrator can delegate to. Cheaper models for exploration and tests, frontier models for planning and review. Applies to sessions started after the change."
          agents={space.agents ?? settings.agents}
          engine={engine}
          spaceId={space.id}
          orchestrator={{ value: space.model ?? '', label: 'app default', onChange: (model) => go(() => upd({ model })) }}
          inherited={!space.agents}
          onChange={(agents) => go(() => upd({ agents }))}
          onResetToDefaults={() => go(() => upd({ agents: DEFAULT_CREW }))}
          useCrew={{ value: space.useCrew !== false, onToggle: (v) => go(() => upd({ useCrew: v })) }}
        />
      )
    case 'mcp':
      return (
        <McpSection
          title="MCP servers for this space"
          intro="Available in every workspace of this space, on top of the application-wide servers. New sessions pick up changes."
          servers={space.mcpServers ?? []}
          onChange={(mcpServers) => go(() => upd({ mcpServers }))}
          strict={{ value: space.strictMcp ?? Boolean(settings.strictMcp), inherited: space.strictMcp === undefined, onToggle: (v) => go(() => upd({ strictMcp: v })) }}
          jira={{ connected: Boolean(jiraConnectionFor(space)) || settings.jira.connected, exposed: space.exposeJiraMcp !== false, onToggle: (v) => go(() => upd({ exposeJiraMcp: v })) }}
          linear={{ connected: Boolean(linearConnectionFor(space)) || Boolean(settings.linear?.connected), exposed: space.exposeLinearMcp !== false, onToggle: (v) => go(() => upd({ exposeLinearMcp: v })) }}
        />
      )
    case 'jira':
      return <JiraSection connId={space.id} title="Jira for this space" intro="Connect the Jira site this space’s tickets live in. Leave it disconnected to use the application’s default connection." />
    case 'linear':
      return <LinearSection connId={space.id} title="Linear for this space" intro="Connect the Linear workspace this space’s issues live in. Leave it disconnected to use the application’s default connection." />
    case 'oncall':
      return <OnCallSettings spaceId={space.id} />
    case 'slack':
      return (
        <div className="max-w-[760px]">
          <SlackConnectionCard connId={space.id} intro="Sign in to the Slack workspace this space’s channels live in. Leave it disconnected to use the application’s Slack." />
        </div>
      )
    case 'github':
      return <GithubOwnersSection spaceId={space.id} configured={space.githubOwners ?? []} onChange={(owners) => go(() => upd({ githubOwners: owners }))} />
  }
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="mt-2 rounded-lg border border-border p-3">
      <div className="mb-1 text-[12px] font-medium uppercase tracking-wide text-muted">{title}</div>
      {hint && <p className="mb-3 text-[11px] text-muted">{hint}</p>}
      {children}
    </section>
  )
}

function SpaceRepos({ space }: { space: Space }): React.JSX.Element {
  const { repos, workspaces, spaces } = useApp()
  const go = useGo()
  const [assign, setAssign] = useState('')
  const mine = repos.filter((r) => r.spaceId === space.id)
  const others = repos.filter((r) => r.spaceId !== space.id)
  const inUse = (repoId: string): number => workspaces.filter((w) => w.status !== 'archived' && w.spaceId === space.id && w.repos.some((x) => x.repoId === repoId)).length
  return (
    <div className="max-w-[700px]">
      <div className="mb-2 flex items-center">
        <span className="text-[12px] text-muted">{mine.length} in this space</span>
        <Button size="sm" variant="primary" className="ml-auto" onClick={() => go(() => api.invoke('repos:pickAndAdd', space.id))}>
          <Plus size={13} /> Add repository
        </Button>
      </div>
      {mine.length === 0 && <div className="mb-2 rounded-md border border-dashed border-border p-3 text-center text-[12px] text-muted">No repositories in this space yet.</div>}
      <div className="mb-2 flex flex-col gap-1.5">
        {mine.map((r) => (
          <div key={r.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
            <FolderGit2 size={14} className="shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                {r.name}
                <Badge>{r.defaultBranch}</Badge>
                {r.config?.scripts ? <Badge tone="ok">sinfonie.json</Badge> : null}
              </div>
              <div className="truncate text-[11px] text-muted">{shortPath(r.path)}</div>
            </div>
            <span className="text-[11px] text-muted">{inUse(r.id) ? `${inUse(r.id)} workspace${inUse(r.id) === 1 ? '' : 's'}` : ''}</span>
            <button title="Remove from this space (the repo stays in the app)" className="rounded p-1 text-muted hover:text-danger" onClick={() => go(() => api.invoke('repos:setSpace', r.id, null))}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      {others.length > 0 && (
        <div className="flex gap-2">
          <select className={inputCls} value={assign} onChange={(e) => setAssign(e.target.value)}>
            <option value="">Move an existing repository here…</option>
            {others.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.spaceId ? ` (in ${spaces.find((s) => s.id === r.spaceId)?.name ?? 'another space'})` : ''}
              </option>
            ))}
          </select>
          <Button disabled={!assign} onClick={() => go(() => api.invoke('repos:setSpace', assign, space.id)).then(() => setAssign(''))}>
            Move
          </Button>
        </div>
      )}
    </div>
  )
}

/** Which GitHub users/orgs the review cockpit lists for this space. Detected from the repos, overridable. */
function GithubOwnersSection({ spaceId, configured, onChange }: { spaceId: string; configured: string[]; onChange: (owners: string[]) => void }): React.JSX.Element {
  const [orgs, setOrgs] = useState<string[]>([])
  const [detected, setDetected] = useState<string[]>([])
  useEffect(() => {
    api.invoke('reviews:orgs').then(setOrgs).catch(() => setOrgs([]))
    api.invoke('reviews:detectOwners', spaceId).then(setDetected).catch(() => setDetected([]))
  }, [spaceId])
  const all = Array.from(new Set([...detected, ...orgs, ...configured]))
  const effective = configured.length ? configured : detected
  const toggle = (o: string): void => {
    const base = configured.length ? configured : detected
    onChange(base.includes(o) ? base.filter((x) => x !== o) : [...base, o])
  }
  return (
    <div className="max-w-[640px]">
      <p className="mb-2 text-[12px] text-muted">
        Pull requests from these owners appear in the cockpit while this space is active.{' '}
        {configured.length ? (
          <button className="text-accent hover:underline" onClick={() => onChange([])}>
            Reset to detected
          </button>
        ) : (
          'Detected from the space’s repositories; tick to override.'
        )}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {all.length === 0 && <span className="text-[12px] text-muted">Nothing detected yet. Add a repository with a GitHub remote, or sign in with gh.</span>}
        {all.map((o) => {
          const on = effective.includes(o)
          return (
            <button key={o} onClick={() => toggle(o)} className={on ? 'rounded-full border border-accent/50 bg-accent/15 px-2 py-0.5 text-[12px] text-accent' : 'rounded-full border border-border px-2 py-0.5 text-[12px] text-muted hover:text-text'}>
              {o}
              {detected.includes(o) && <span className="ml-1 opacity-60">·repo</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

void FolderTree
