/**
 * Team console (rail → Team; admins and experts): overview with a setup checklist that ends with a working team,
 * people and roles, apps, guardrails, connections, and usage and plan (docs/design/README.md, "Information
 * architecture"). The team scope is the current space. Admins edit; everyone else reads. Every checklist step is
 * derived from real state and has one action. Guardrails are enforced in the main process (services/team-rules.ts).
 */
import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Users, Check, ShieldCheck, LayoutGrid, Plug, BarChart3, ClipboardCheck, Lock } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp, spaceScope, type SpacePage } from '@/stores/app'
import { useGuided, useWords, cap, an } from '@/lib/guided'
import { friendlyError } from '@/lib/errors'
import { Badge, Button, SectionHeader, Toggle } from '../ui'
import { TeamSection } from '../TeamSection'
import { PlanPage } from '../PlanPage'
import { UsagePage } from '../UsagePage'
import { GuardrailsSection } from './GuardrailsSection'
import { isLookOnly, useAppKeys, useSpend } from './useTeamData'
import type { CloudOrgDetail, Space } from '@shared/types'

type Section = 'overview' | 'people' | 'apps' | 'guardrails' | 'connections' | 'usage'

/** Mirrors team-rules.ts isAdminOf: an organisation space is edited by its admins; a personal one by its owner. */
export function useIsTeamAdmin(space: Space | undefined): boolean {
  const orgs = useApp((s) => s.settings.cloud?.account?.orgs)
  if (!space?.orgId) return true
  return Boolean(orgs?.some((o) => o.id === space.orgId && o.role === 'admin'))
}

export function TeamView(): React.JSX.Element {
  const t = useWords()
  const spaces = useApp((s) => s.spaces)
  const repos = useApp((s) => s.repos)
  const currentId = useApp((s) => spaceScope(s).currentId)
  const setActiveSpace = useApp((s) => s.setActiveSpace)
  const setError = useApp((s) => s.setError)
  const account = useApp((s) => s.settings.cloud?.account)
  // The rail's scope can be "no space" (loose workspaces); the console then shows the first space.
  const space = spaces.find((s) => s.id === currentId) ?? spaces[0]
  const admin = useIsTeamAdmin(space)
  const [section, setSection] = useState<Section>('overview')
  const [orgs, setOrgs] = useState<CloudOrgDetail[] | null>(null)
  // A failed load is not "no organisation": the checklist says it could not check and offers Retry, never "Create".
  const [orgsError, setOrgsError] = useState<string | null>(null)
  const [orgsTry, setOrgsTry] = useState(0)
  // Re-read the organisations when coming back to a section, so invites made under People count on the checklist.
  const accountId = account?.user.id
  useEffect(() => {
    if (!accountId) {
      setOrgsError(null)
      return setOrgs(null)
    }
    let live = true
    api
      .invoke('cloud:orgs')
      .then((o) => {
        if (!live) return
        setOrgs(o)
        setOrgsError(null)
      })
      .catch((err) => live && setOrgsError(friendlyError(err, 'Your organisations could not be loaded. Check your connection and try again.')))
    return () => {
      live = false
    }
  }, [accountId, section, orgsTry])

  const apps = space ? repos.filter((r) => r.spaceId === space.id) : []
  const org = orgs?.find((o) => o.id === space?.orgId) ?? orgs?.find((o) => o.role === 'admin') ?? orgs?.[0]
  const nav: { id: Section; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'overview', label: 'Overview', icon: <ClipboardCheck size={14} /> },
    { id: 'apps', label: cap(t.repos), icon: <LayoutGrid size={14} />, count: apps.length },
    { id: 'people', label: 'People and roles', icon: <Users size={14} />, count: org?.members.length },
    { id: 'guardrails', label: 'Guardrails', icon: <ShieldCheck size={14} /> },
    { id: 'connections', label: 'Connections', icon: <Plug size={14} /> },
    { id: 'usage', label: 'Usage and plan', icon: <BarChart3 size={14} /> }
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-4">
        <Users size={16} className="text-accent" />
        <span className="text-[13px] font-semibold">Team</span>
        {spaces.length > 1 ? (
          <select className="no-drag rounded-md border border-border bg-bg px-2 py-1 text-[12px]" aria-label={cap(t.space)} value={space?.id ?? ''} onChange={(e) => setActiveSpace(e.target.value)}>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          space && <span className="text-[12px] text-muted">{space.name}</span>
        )}
        {space?.orgSpace?.pushError && (
          <span className="no-drag ml-2 flex items-center gap-1.5 text-[12px] text-warn" title={space.orgSpace.pushError}>
            Not shared yet
            <Button size="sm" variant="ghost" onClick={() => api.invoke('orgSpaces:publish', space.id, space.orgId!).catch((err) => setError(friendlyError(err)))}>
              Retry
            </Button>
          </span>
        )}
        {space && !admin && (
          <span className="ml-auto flex items-center gap-1 text-[12px] text-muted" title="Only a team admin can change these settings">
            <Lock size={12} /> Read-only
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Team sections" className="w-[200px] shrink-0 space-y-0.5 border-r border-border p-2">
          {nav.map((n) => (
            <button
              key={n.id}
              type="button"
              aria-current={section === n.id ? 'page' : undefined}
              onClick={() => setSection(n.id)}
              className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]', section === n.id ? 'bg-panel-2 text-text' : 'text-muted hover:bg-panel-2/60 hover:text-text')}
            >
              {n.icon}
              <span className="flex-1">{n.label}</span>
              {n.count ? <span className="text-[11px] text-muted">{n.count}</span> : null}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          {section === 'overview' && <Overview space={space} org={org} orgsError={orgsError} retryOrgs={() => setOrgsTry((n) => n + 1)} admin={admin} go={setSection} />}
          {section === 'people' && <People signedIn={Boolean(account)} />}
          {section === 'apps' && (space ? <Apps space={space} admin={admin} /> : <NoSpace />)}
          {section === 'guardrails' && (space ? <GuardrailsSection key={space.id} space={space} admin={admin} org={org} onOpenApps={() => setSection('apps')} /> : <NoSpace />)}
          {section === 'connections' && (space ? <Connections space={space} /> : <NoSpace />)}
          {section === 'usage' && (
            <div>
              <UsagePage />
              <SectionHeader>Plan</SectionHeader>
              <PlanPage hideTeam />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function NoSpace(): React.JSX.Element {
  const t = useWords()
  const openSettings = useApp((s) => s.openSettings)
  return (
    <div className="text-[13px] text-muted">
      <p className="mb-3">There is no {t.space} yet. Create one to add {t.repos} and set rules for it.</p>
      <Button variant="primary" onClick={() => openSettings({ scope: 'app', page: 'spaces' })}>
        Create {an(t.space)}
      </Button>
    </div>
  )
}

// ---------- overview ----------

interface Step {
  id: string
  label: string
  done: boolean
  detail?: string
  action?: { label: string; run: () => void | Promise<unknown> }
}

function Overview({ space, org, orgsError, retryOrgs, admin, go }: { space?: Space; org?: CloudOrgDetail; orgsError: string | null; retryOrgs: () => void; admin: boolean; go: (s: Section) => void }): React.JSX.Element {
  const guided = useGuided()
  const t = useWords()
  const account = useApp((s) => s.settings.cloud?.account)
  const repos = useApp((s) => s.repos)
  const workspaces = useApp((s) => s.workspaces)
  const openSettings = useApp((s) => s.openSettings)
  const setShowNewWorkspace = useApp((s) => s.setShowNewWorkspace)
  const setError = useApp((s) => s.setError)
  const spend = useSpend(space)
  const [busy, setBusy] = useState<string | null>(null)
  const orgWord = guided ? 'company' : 'organisation'
  const apps = space ? repos.filter((r) => r.spaceId === space.id) : []
  const inSpace = space ? workspaces.filter((w) => w.spaceId === space.id) : []
  const orgAdmin = org?.role === 'admin'
  const run = async (id: string, fn: () => void | Promise<unknown>): Promise<void> => {
    setBusy(id)
    try {
      await fn()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(null)
    }
  }

  const steps: Step[] = [
    { id: 'signin', label: 'Signed in to Sinfonie', done: Boolean(account), detail: account ? (account.user.name || account.user.login) : undefined, action: { label: 'Sign in with GitHub', run: () => api.invoke('cloud:signIn', 'github') } },
    // Loading failed: say so and offer Retry. Never offer "Create" then, since the team may well have one already.
    orgsError && !org
      ? { id: 'org', label: `${cap(an(orgWord))} for the team`, done: false, detail: orgsError, action: { label: 'Retry', run: retryOrgs } }
      : { id: 'org', label: `${cap(an(orgWord))} for the team`, done: Boolean(org), detail: org?.name ?? (account ? undefined : 'Needs you signed in first'), action: account ? { label: `Create ${an(orgWord)}`, run: () => go('people') } : { label: 'Sign in first', run: () => api.invoke('cloud:signIn', 'github') } },
    { id: 'space', label: `${cap(an(t.space))} for the work`, done: Boolean(space), detail: space?.name, action: { label: `Create ${an(t.space)}`, run: () => openSettings({ scope: 'app', page: 'spaces' }) } },
    { id: 'apps', label: `${cap(t.repos)} added`, done: apps.length > 0, detail: apps.length ? `${apps.length} ${apps.length === 1 ? t.repo : t.repos}` : space ? undefined : `Needs ${an(t.space)} first`, action: space ? { label: `Add ${t.repos}`, run: () => openSettings({ scope: 'space', spaceId: space.id, page: 'repos' }) } : { label: `Create ${an(t.space)}`, run: () => openSettings({ scope: 'app', page: 'spaces' }) } },
    {
      id: 'shared',
      label: `${cap(t.space)} shared with the ${orgWord}`,
      done: Boolean(space?.orgSpace),
      detail: space?.orgSpace ? (space.orgSpace.pushError ? `Not shared yet: your latest changes did not reach the team` : `Synced ${new Date(space.orgSpace.syncedAt).toLocaleDateString()}`) : orgsError && !org ? 'Waiting for your organisations to load' : !org ? `Needs ${an(orgWord)} first` : !orgAdmin ? `An admin of ${org.name} can share it` : undefined,
      action: space && org && orgAdmin ? { label: `Share with ${org.name}`, run: () => api.invoke('orgSpaces:publish', space.id, org.id) } : orgsError && !org ? { label: 'Retry', run: retryOrgs } : !org ? { label: `Create ${an(orgWord)}`, run: () => go('people') } : !space ? { label: `Create ${an(t.space)}`, run: () => openSettings({ scope: 'app', page: 'spaces' }) } : undefined
    },
    { id: 'people', label: 'People invited', done: Boolean(org && (org.members.length > 1 || org.invites.length > 0)), detail: org ? `${org.members.length} member${org.members.length === 1 ? '' : 's'}${org.invites.length ? `, ${org.invites.length} invite${org.invites.length === 1 ? '' : 's'} open` : ''}` : undefined, action: { label: 'Invite people', run: () => go('people') } },
    { id: 'rules', label: 'Guardrails reviewed', done: Boolean(space?.rules?.reviewedAt), detail: space?.rules?.reviewedAt ? `Saved ${new Date(space.rules.reviewedAt).toLocaleDateString()}` : undefined, action: { label: 'Review guardrails', run: () => go('guardrails') } },
    { id: 'first', label: `A first ${t.workspace} sent for review`, done: inSpace.some((w) => w.reviewRequestedAt || w.stage === 'done'), detail: space && !apps.length ? `Needs ${t.repos} first` : undefined, action: !space ? { label: `Create ${an(t.space)}`, run: () => openSettings({ scope: 'app', page: 'spaces' }) } : !apps.length ? { label: `Add ${t.repos}`, run: () => openSettings({ scope: 'space', spaceId: space.id, page: 'repos' }) } : { label: `Start ${an(t.workspace)}`, run: () => setShowNewWorkspace(true, space.id) } }
  ]
  const done = steps.filter((s) => s.done).length
  const rules = space?.rules ?? {}
  const spent = spend?.spent ?? 0

  return (
    <div className="max-w-[760px]">
      <h2 className="mb-1 text-[18px] font-semibold">{space ? `${space.name} overview` : 'Team overview'}</h2>
      <p className="mb-5 text-[13px] text-muted">Everything the team needs to work, and what’s still missing.</p>

      <section className="mb-6 rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="text-[13px] font-semibold">Setup</span>
          <span className="text-[12px] text-muted">
            {done} of {steps.length} done
          </span>
          {done === steps.length && <Badge tone="ok">Ready</Badge>}
        </div>
        <ul>
          {steps.map((s) => (
            <li key={s.id} className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-b-0">
              <span aria-hidden className={clsx('flex h-4 w-4 shrink-0 items-center justify-center rounded-full', s.done ? 'bg-ok/20 text-ok' : 'border border-border')}>
                {s.done && <Check size={11} />}
              </span>
              <span className={clsx('text-[13px]', s.done && 'text-muted')}>
                {s.label}
                <span className="sr-only">{s.done ? ' (done)' : ' (to do)'}</span>
              </span>
              {s.detail && <span className="truncate text-[12px] text-muted">· {s.detail}</span>}
              {!s.done && s.action && (admin || s.id === 'signin') && (
                <Button size="sm" className="ml-auto shrink-0" disabled={busy !== null} onClick={() => void run(s.id, s.action!.run)}>
                  {busy === s.id ? 'Working…' : s.action.label}
                </Button>
              )}
              {!s.done && s.action && !(admin || s.id === 'signin') && <span className="ml-auto shrink-0 text-[12px] text-muted">A team admin does this</span>}
            </li>
          ))}
        </ul>
      </section>

      {space && (
        <section className="grid grid-cols-3 gap-3">
          <Health
            title="Guardrails"
            value={[rules.builderReadOnly?.length ? `${rules.builderReadOnly.length} look-only` : '', rules.protectedPaths?.length ? `${rules.protectedPaths.length} protected` : '', rules.requireReview ? 'review required' : ''].filter(Boolean).join(' · ') || 'None set'}
            sub={rules.requireReview && !(space.guided?.reviewers ?? []).length ? 'No reviewer set: builders can’t send for review' : 'Agents and Maestro follow them'}
            warn={Boolean(rules.requireReview && !(space.guided?.reviewers ?? []).length)}
            onClick={() => go('guardrails')}
          />
          <Health title="Spend today (you)" value={`$${spent.toFixed(2)}${rules.dailySpendUsd ? ` of $${rules.dailySpendUsd}` : ''}`} sub={rules.dailySpendUsd ? (spend?.lifted ? 'Limit lifted for today on this Mac' : spent >= rules.dailySpendUsd ? 'Limit reached: new messages stop' : 'On this Mac, estimated at list price') : 'No daily limit'} warn={Boolean(rules.dailySpendUsd && spent >= rules.dailySpendUsd && !spend?.lifted)} onClick={() => go('usage')} />
          <Health title={cap(t.workspaces)} value={`${inSpace.filter((w) => w.status !== 'archived').length} open`} sub={`${inSpace.filter((w) => w.stage === 'in-review').length} waiting for review`} onClick={() => go('apps')} />
        </section>
      )}
    </div>
  )
}

function Health({ title, value, sub, warn, onClick }: { title: string; value: string; sub: string; warn?: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} className="rounded-lg border border-border p-3 text-left hover:bg-panel-2/60">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</div>
      <div className="mt-1 text-[15px] font-medium">{value}</div>
      <div className={clsx('mt-0.5 text-[12px]', warn ? 'text-warn' : 'text-muted')}>{sub}</div>
    </button>
  )
}

// ---------- people ----------

function People({ signedIn }: { signedIn: boolean }): React.JSX.Element {
  const guided = useGuided()
  const t = useWords()
  const setError = useApp((s) => s.setError)
  return (
    <div className="max-w-[820px]">
      <p className="mb-4 max-w-[72ch] text-[13px] text-muted">
        {guided
          ? `People in your company and whether they are an admin. Admins change the rules and invite people. Whether someone builds with Maestro (guided) or with the full toolbox is their own choice; new people start in the company’s default.`
          : `Members of your organisation with their role, from sinfonie.dev. Admins edit ${t.space} guardrails and invite people. Builder or engineer is each person’s mode (guided or expert); new members start in the organisation’s default mode. Reviewer and on-call are not stored as roles yet: reviewers are set per ${t.space} in Guardrails, on-call in Connections.`}
      </p>
      {!signedIn && (
        <div className="mb-4 flex items-center gap-2">
          <Button variant="primary" onClick={() => api.invoke('cloud:signIn', 'github').catch((err) => setError(friendlyError(err)))}>
            Sign in with GitHub
          </Button>
          <Button onClick={() => api.invoke('cloud:signIn', 'google').catch((err) => setError(friendlyError(err)))}>Sign in with Google</Button>
          <span className="text-[12px] text-muted">People and roles live in your Sinfonie account.</span>
        </div>
      )}
      <TeamSection signedIn={signedIn} />
    </div>
  )
}

// ---------- apps ----------

function Apps({ space, admin }: { space: Space; admin: boolean }): React.JSX.Element {
  const guided = useGuided()
  const t = useWords()
  const repos = useApp((s) => s.repos)
  const openSettings = useApp((s) => s.openSettings)
  const setError = useApp((s) => s.setError)
  const apps = repos.filter((r) => r.spaceId === space.id)
  const keys = useAppKeys(space.id)
  // Main applies each switch to the latest stored rules, so quick successive toggles don't undo each other.
  const toggle = (repoId: string, canChange: boolean): void => {
    api.invoke('team:setAppLookOnly', space.id, repoId, !canChange).catch((err) => setError(friendlyError(err)))
  }
  return (
    <div className="max-w-[720px]">
      <SectionHeader
        action={
          admin && (
            <Button size="sm" onClick={() => openSettings({ scope: 'space', spaceId: space.id, page: 'repos' })}>
              Add or remove {t.repos}
            </Button>
          )
        }
      >
        {cap(t.repos)} in {space.name}
      </SectionHeader>
      {apps.length === 0 && <p className="text-[13px] text-muted">No {t.repos} yet.</p>}
      <ul className="space-y-2">
        {apps.map((r) => (
          <li key={r.id} className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[13px] font-medium">{r.displayName || r.name}</span>
              {!guided && r.displayName && <span className="text-[12px] text-muted">{r.name}</span>}
              {isLookOnly(space, r, keys) ? <Badge tone="warn">Look only for builders</Badge> : <Badge tone="ok">Builders can change</Badge>}
            </div>
            {r.description && <p className="mb-2 text-[12px] text-muted">{r.description}</p>}
            <Toggle checked={!isLookOnly(space, r, keys)} disabled={!admin} onChange={(v) => toggle(r.id, v)} label="Builders can change this" hint={guided ? 'When off, Maestro can look at it in builders’ tasks but not change it.' : 'When off, agents in guided workspaces treat it as read-only; experts are not affected.'} />
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------- connections ----------

function Connections({ space }: { space: Space }): React.JSX.Element {
  const guided = useGuided()
  const t = useWords()
  const settings = useApp((s) => s.settings)
  const openSettings = useApp((s) => s.openSettings)
  const rows: { page: SpacePage; label: string; on: boolean; detail: string; hide?: boolean }[] = [
    { page: 'github', label: 'GitHub', on: (space.githubOwners ?? []).length > 0, detail: (space.githubOwners ?? []).length ? space.githubOwners!.join(', ') : 'Detected from the apps' },
    { page: 'slack', label: 'Slack', on: Boolean(space.slack?.connected || settings.slack?.connected), detail: space.slack?.connected ? (space.slack.teamName ?? `This ${t.space}’s own`) : settings.slack?.connected ? 'Shared with the app' : 'Not connected' },
    { page: 'jira', label: 'Jira', on: Boolean(space.jira?.connected || space.jira?.hasToken || settings.jira?.connected || settings.jira?.hasToken), detail: space.jira?.siteName || space.jira?.siteUrl || settings.jira?.siteName || 'Not connected' },
    { page: 'linear', label: 'Linear', on: Boolean(space.linear?.connected || settings.linear?.connected), detail: space.linear?.orgName || settings.linear?.orgName || 'Not connected' },
    { page: 'gcp', label: 'Google Cloud', on: Boolean(space.gcp?.projectId || settings.gcp?.projectId), detail: space.gcp?.projectId || settings.gcp?.projectId || 'No project' },
    { page: 'oncall', label: 'On-call', on: Boolean(space.oncall?.enabled), detail: space.oncall?.enabled ? `${space.oncall.channels?.length ?? 0} channel${space.oncall.channels?.length === 1 ? '' : 's'} watched` : 'Off' },
    { page: 'databases', label: 'Databases', on: (space.databases ?? []).length > 0, detail: (space.databases ?? []).length ? `${space.databases!.length} connected` : 'None', hide: guided },
    { page: 'mcp', label: 'MCP servers', on: (space.mcpServers ?? []).length > 0, detail: `${(space.mcpServers ?? []).length} configured`, hide: guided }
  ]
  return (
    <div className="max-w-[720px]">
      <p className="mb-4 text-[13px] text-muted">What {space.name} is connected to. Each opens its settings page.</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {rows
          .filter((r) => !r.hide)
          .map((r) => (
            <li key={r.page} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-[120px] text-[13px] font-medium">{r.label}</span>
              <Badge tone={r.on ? 'ok' : 'muted'}>{r.on ? 'Connected' : 'Off'}</Badge>
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{r.detail}</span>
              <Button size="sm" variant="ghost" onClick={() => openSettings({ scope: 'space', spaceId: space.id, page: r.page })}>
                Open
              </Button>
            </li>
          ))}
      </ul>
    </div>
  )
}
