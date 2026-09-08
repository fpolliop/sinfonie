import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Siren, ExternalLink, RefreshCw, Send, Trash2, MessageSquare, Sparkles, Settings as SettingsIcon, GitPullRequest, Search, Filter, X, Check, Ban, FolderPlus } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useOnCall, subscribeOnCall, matchesFilters, type OnCallFilters, type OnCallView as ViewId } from '@/stores/oncall'
import { Badge, Button, Spinner, inputCls } from './ui'
import { Markdown } from '@/lib/markdown'
import { timeAgo } from '@/lib/format'
import { incidentBrief } from '@shared/oncall-brief'
import type { Incident, IncidentStatus, OnCallBulkOp, Severity } from '@shared/types'

const SEV: Record<Severity, { tone: 'muted' | 'ok' | 'warn' | 'danger' | 'accent'; label: string }> = {
  low: { tone: 'muted', label: 'low' },
  medium: { tone: 'accent', label: 'medium' },
  high: { tone: 'warn', label: 'high' },
  critical: { tone: 'danger', label: 'critical' }
}
const STATUSES: { id: IncidentStatus; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'triaging', label: 'Triaging' },
  { id: 'open', label: 'Open' },
  { id: 'waiting', label: 'Waiting on them' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'dismissed', label: 'Dismissed' }
]
const OPEN = new Set<IncidentStatus>(['new', 'triaging', 'open', 'waiting'])
const VIEWS: { id: ViewId; label: string; hint: string; counted?: boolean }[] = [
  { id: 'open', label: 'Open', hint: 'Everything not resolved or dismissed', counted: true },
  { id: 'new', label: 'New', hint: 'Not yet triaged', counted: true },
  { id: 'needs', label: 'Needs you', hint: 'Triage asked for a human, or a reply is drafted', counted: true },
  { id: 'resolved', label: 'Done', hint: 'Resolved or dismissed' },
  { id: 'all', label: 'All', hint: 'Every incident' }
]
const NO_INCIDENTS: Incident[] = []
const selectCls = 'h-6 min-w-0 rounded-md border border-border bg-bg px-1 text-[11px]'

export function OnCallView(): React.JSX.Element {
  const { state, selectedId, select, filters, setFilters, checked, toggleChecked, setChecked } = useOnCall()
  const settings = useApp((s) => s.settings)
  const openSettings = useApp((s) => s.openSettings)
  const setError = useApp((s) => s.setError)
  useEffect(() => subscribeOnCall(), [])
  const [checking, setChecking] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const checkNow = (): void => {
    setChecking(true)
    void go(() => api.invoke('oncall:pollNow')).finally(() => setChecking(false))
  }
  // On call is per space: the view follows the sidebar's active space ('' = the application-level watch).
  const activeSpaceId = useApp((s) => s.activeSpaceId)
  const allIncidents = state?.incidents ?? NO_INCIDENTS
  const all = useMemo(() => allIncidents.filter((i) => i.spaceId === activeSpaceId), [allIncidents, activeSpaceId])
  const incidents = useMemo(() => all.filter((i) => matchesFilters(i, filters)), [all, filters])
  const counts = useMemo(() => {
    const c = { open: 0, new: 0, needs: 0, waiting: 0, resolved: 0, all: all.length }
    for (const i of all) {
      if (OPEN.has(i.status)) c.open++
      if (i.status === 'new' || i.status === 'triaging') c.new++
      if (OPEN.has(i.status) && (i.report?.needsHuman || i.proposals.some((p) => p.status === 'proposed'))) c.needs++
      if (i.status === 'waiting') c.waiting++
      if (i.status === 'resolved' || i.status === 'dismissed') c.resolved++
    }
    return c
  }, [all])
  const channels = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of all) m.set(i.channelId, i.channelName)
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [all])
  const selected = all.find((i) => i.id === selectedId) ?? null
  const spaces = useApp((s) => s.spaces)
  const activeSpace = spaces.find((sp) => sp.id === activeSpaceId)
  const configured = activeSpaceId ? (activeSpace?.oncall?.channels?.length ?? 0) > 0 || state?.activeSpaces.includes(activeSpaceId) === true : Boolean(settings.slack?.connected && (settings.oncall?.channels?.length ?? 0) > 0) || state?.activeSpaces.includes('') === true
  const spaceOf = (id: string): { name: string; color: string } | null => {
    const sp = spaces.find((x) => x.id === id)
    return sp ? { name: sp.name, color: sp.color } : null
  }
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const narrowed = Boolean(filters.channel || filters.severity || filters.kind || filters.spaceId)
  const visibleIds = incidents.map((i) => i.id)
  const allVisibleChecked = visibleIds.length > 0 && visibleIds.every((id) => checked.includes(id))
  const bulk = (op: OnCallBulkOp): void => {
    if (!checked.length) return
    setBulkBusy(true)
    setConfirmDelete(false)
    void go(async () => {
      await api.invoke('oncall:bulk', checked, op)
      if (op.action === 'remove' && selectedId && checked.includes(selectedId)) select(null)
      setChecked([])
    }).finally(() => setBulkBusy(false))
  }
  const statusText = checking ? 'Checking Slack…' : state?.lastError ? state.lastError : state?.lastPollAt ? `Checked ${timeAgo(state.lastPollAt)}${state.nextPollAt ? `, next in ${Math.max(0, Math.round((new Date(state.nextPollAt).getTime() - Date.now()) / 1000))}s` : ''}` : state?.running ? 'Waiting for the first check…' : ''

  return (
    <div className="flex h-full">
      <div className="flex w-[340px] shrink-0 flex-col border-r border-border">
        <div className="drag flex h-[52px] items-center gap-2 border-b border-border px-4">
          <Siren size={15} className="text-accent" />
          <span className="text-[13px] font-semibold">On call</span>
          {activeSpace && (
            <span className="flex items-center gap-1 text-[12px] text-muted">
              <span className="h-2 w-2 rounded-full" style={{ background: activeSpace.color }} /> {activeSpace.name}
            </span>
          )}
          <span className={clsx('ml-1 h-2 w-2 rounded-full', state?.running ? 'bg-ok' : 'bg-muted/50')} title={state?.running ? `Watching ${state.activeSpaces.map((id) => spaceOf(id)?.name ?? 'application').join(', ')}${state.lastPollAt ? `, last check ${timeAgo(state.lastPollAt)}` : ''}. Slack allows one channel or thread read per minute, so watched channels and open threads are checked in turn.` : 'Not running'} />
          <div className="no-drag ml-auto flex items-center gap-1">
            <button className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-text disabled:opacity-40" title="Check Slack now" onClick={checkNow} disabled={!configured || checking}>
              <RefreshCw size={13} className={clsx(checking && 'animate-spin')} />
            </button>
            <button className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-text" title="On call settings" onClick={() => openSettings(activeSpaceId ? { scope: 'space', spaceId: activeSpaceId, page: 'oncall' } : { scope: 'app', page: 'oncall' })}>
              <SettingsIcon size={13} />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-0.5 border-b border-border px-2 py-1.5 text-[11px]">
          {VIEWS.map((v) => (
            <button key={v.id} onClick={() => setFilters({ view: v.id })} className={clsx('flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5', filters.view === v.id ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')} title={`${v.hint}${counts[v.id] ? ` (${counts[v.id]})` : ''}`}>
              {v.label}
              {v.counted && counts[v.id] > 0 && <span className={clsx('rounded-full px-1 text-[10px] tabular-nums', v.id === 'needs' && filters.view !== v.id ? 'bg-warn/15 text-warn' : 'bg-panel text-muted')}>{counts[v.id]}</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
          <div className="relative min-w-0 flex-1">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <input className="w-full rounded-md border border-border bg-bg py-1 pl-6 pr-6 text-[12px] outline-none placeholder:text-muted focus:border-accent" placeholder="Search incidents" value={filters.q} onChange={(e) => setFilters({ q: e.target.value })} />
            {filters.q && (
              <button className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted hover:text-text" onClick={() => setFilters({ q: '' })} title="Clear search">
                <X size={12} />
              </button>
            )}
          </div>
          <button className={clsx('relative rounded-md p-1 hover:bg-panel-2', showFilters || narrowed ? 'text-accent' : 'text-muted hover:text-text')} title="Filter incidents by channel, severity, kind or space" onClick={() => setShowFilters(!showFilters)}>
            <Filter size={13} />
            {narrowed && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
          </button>
        </div>
        {showFilters && (
          <div data-testid="oncall-filters" className="grid grid-cols-2 gap-1.5 border-b border-border bg-panel px-2 py-2 text-[11px]">
            <select className={selectCls} value={filters.channel} onChange={(e) => setFilters({ channel: e.target.value })} title="Channel">
              <option value="">All channels</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
            <select className={selectCls} value={filters.severity} onChange={(e) => setFilters({ severity: e.target.value as Severity | '' })} title="Severity">
              <option value="">Any severity</option>
              {(Object.keys(SEV) as Severity[]).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select className={selectCls} value={filters.kind} onChange={(e) => setFilters({ kind: e.target.value as OnCallFilters['kind'] })} title="Kind">
              <option value="">Alerts and support</option>
              <option value="alerts">Alerts only</option>
              <option value="support">Support only</option>
            </select>
            <span />
            {narrowed && (
              <button className="col-span-2 text-left text-accent hover:underline" onClick={() => setFilters({ channel: '', severity: '', kind: '', spaceId: '' })}>
                Clear filters
              </button>
            )}
          </div>
        )}
        {checked.length > 0 ? (
          <div className="flex items-center gap-1 border-b border-border bg-accent/10 px-2 py-1 text-[11px]">
            <input type="checkbox" className="accent-accent" checked={allVisibleChecked} onChange={() => setChecked(allVisibleChecked ? [] : visibleIds)} title={allVisibleChecked ? 'Clear selection' : 'Select everything in the list'} />
            <span className="shrink-0 whitespace-nowrap tabular-nums">{checked.length} selected</span>
            <div className="ml-auto flex items-center gap-0.5">
              <BulkButton icon={<Sparkles size={13} />} title={`Triage ${checked.length} selected`} disabled={bulkBusy} onClick={() => bulk({ action: 'triage' })} />
              <BulkButton icon={<Check size={13} />} title={`Resolve ${checked.length} selected`} disabled={bulkBusy} onClick={() => bulk({ action: 'setStatus', status: 'resolved' })} />
              <BulkButton icon={<Ban size={13} />} title={`Dismiss ${checked.length} selected (not incidents)`} disabled={bulkBusy} onClick={() => bulk({ action: 'setStatus', status: 'dismissed' })} />
              <select className="h-6 w-[68px] rounded-md border border-border bg-bg px-1 text-[11px]" value="" title="Set severity for selected" disabled={bulkBusy} onChange={(e) => e.target.value && bulk({ action: 'setSeverity', severity: e.target.value as Severity })}>
                <option value="">Severity</option>
                {(Object.keys(SEV) as Severity[]).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {confirmDelete ? (
                <button className="rounded-md bg-danger px-1.5 py-0.5 text-white hover:opacity-90" onClick={() => bulk({ action: 'remove' })} onBlur={() => setConfirmDelete(false)} autoFocus>
                  Delete {checked.length}?
                </button>
              ) : (
                <BulkButton icon={<Trash2 size={13} />} title={`Delete ${checked.length} selected from the list`} danger disabled={bulkBusy} onClick={() => setConfirmDelete(true)} />
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1 text-[11px]">
            <input type="checkbox" className="accent-accent" checked={false} disabled={visibleIds.length === 0} onChange={() => setChecked(visibleIds)} title="Select everything in the list" />
            <span className={clsx('min-w-0 flex-1 truncate', state?.lastError && !checking ? 'text-warn' : 'text-muted')} title={statusText}>
              {statusText || (visibleIds.length ? `Select all ${visibleIds.length}` : '')}
            </span>
            {bulkBusy && <Spinner />}
          </div>
        )}
        <div className="flex-1 overflow-auto">
          {!configured && (
            <div className="p-4 text-[12px] text-muted">
              <p className="mb-2">The on-call agent watches Slack channels, turns requests and alerts into incidents, triages each one with the code at hand, and drafts replies you approve.</p>
              <Button size="sm" variant="primary" onClick={() => openSettings({ scope: 'app', page: 'oncall' })}>
                Set up on call
              </Button>
            </div>
          )}
          {configured && incidents.length === 0 && (
            <div className="p-4 text-[12px] text-muted">
              {all.length === 0 ? 'No incidents yet. New messages in the watched channels appear here within a minute.' : filters.q || narrowed ? 'Nothing matches these filters.' : filters.view === 'open' ? 'Nothing open.' : 'Nothing here.'}
            </div>
          )}
          {incidents.map((i) => {
            const isChecked = checked.includes(i.id)
            return (
              <div key={i.id} className={clsx('group flex border-b border-border hover:bg-panel-2/60', i.id === selectedId && 'bg-panel-2', isChecked && 'bg-accent/5')}>
                <label className="flex shrink-0 cursor-pointer items-start px-2 pt-2.5" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" className={clsx('accent-accent', !isChecked && checked.length === 0 && 'opacity-40 group-hover:opacity-100')} checked={isChecked} onChange={() => toggleChecked(i.id)} />
                </label>
                <button onClick={() => select(i.id)} className="block min-w-0 flex-1 py-2 pr-3 text-left">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted">
                    {i.severity ? <Badge tone={SEV[i.severity].tone}>{SEV[i.severity].label}</Badge> : <Badge>{i.status === 'triaging' ? 'triaging' : 'untriaged'}</Badge>}
                    {(i.occurrences ?? 1) > 1 && (
                      <span className="rounded bg-panel px-1 text-[10px] tabular-nums" title={`Fired ${i.occurrences} times${i.lastSeenAt ? `, last ${timeAgo(i.lastSeenAt)}` : ''}`}>
                        ×{i.occurrences}
                      </span>
                    )}
                    {spaceOf(i.spaceId) && !filters.spaceId && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: spaceOf(i.spaceId)!.color }} title={spaceOf(i.spaceId)!.name} />}
                    <span className="truncate">#{i.channelName}</span>
                    <span className="ml-auto shrink-0">{timeAgo(i.updatedAt)}</span>
                  </div>
                  <div className={clsx('mt-0.5 truncate text-[13px]', i.status === 'new' || i.status === 'open' ? 'font-medium' : 'text-muted')}>{i.title}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                    <span>{STATUSES.find((s) => s.id === i.status)?.label}</span>
                    {i.status === 'triaging' && <Spinner />}
                    {i.proposals.some((p) => p.status === 'proposed') && <span className="text-accent">reply drafted</span>}
                    {i.report?.needsHuman && <span className="text-warn">needs you</span>}
                  </div>
                </button>
              </div>
            )
          })}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">{selected ? <IncidentDetail inc={selected} go={go} /> : <div className="drag flex h-[52px]" />}</div>
    </div>
  )
}

function BulkButton({ icon, label, title, onClick, disabled, danger }: { icon: React.ReactNode; label?: string; title: string; onClick: () => void; disabled?: boolean; danger?: boolean }): React.JSX.Element {
  return (
    <button className={clsx('inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-panel-2 disabled:opacity-40', danger ? 'text-muted hover:text-danger' : 'text-text')} title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      {icon}
      {label}
    </button>
  )
}

function IncidentDetail({ inc, go }: { inc: Incident; go: (fn: () => Promise<unknown>) => Promise<void> }): React.JSX.Element {
  const setNewWorkspaceSeed = useApp((s) => s.setNewWorkspaceSeed)
  const setShowNewWorkspace = useApp((s) => s.setShowNewWorkspace)
  const setView = useApp((s) => s.setView)
  // Take the thread and the triage into a workspace: the dialog opens in the incident's space with a name and the first message ready.
  const toWorkspace = (): void => {
    const name = inc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'incident'
    setNewWorkspaceSeed({ name, draft: incidentBrief(inc) })
    setView('workspace')
    setShowNewWorkspace(true, inc.spaceId)
  }
  const [question, setQuestion] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [asking, setAsking] = useState(false)
  const [newReply, setNewReply] = useState('')
  const r = inc.report
  return (
    <div className="flex h-full flex-col">
      <div className="drag flex h-[52px] items-center gap-2 border-b border-border px-5">
        <span className="truncate text-[14px] font-semibold">{inc.title}</span>
        <div className="no-drag ml-auto flex items-center gap-2">
          {inc.permalink && (
            <Button size="sm" variant="ghost" onClick={() => void api.invoke('shell:openExternal', inc.permalink!)}>
              <ExternalLink size={12} /> Open in Slack
            </Button>
          )}
          <Button size="sm" variant="ghost" title="Run the triage again with the current thread" onClick={() => go(() => api.invoke('oncall:triage', inc.id))} disabled={inc.status === 'triaging'}>
            <Sparkles size={12} /> Re-triage
          </Button>
          <Button size="sm" onClick={toWorkspace} title="Open a new workspace in this space with the thread and the triage as the first message">
            <FolderPlus size={12} /> Work on it
          </Button>
          <button className="rounded p-1 text-muted hover:text-danger" title="Remove this incident from the list" onClick={() => go(() => api.invoke('oncall:remove', inc.id))}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2 text-[12px]">
        <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={inc.status} onChange={(e) => go(() => api.invoke('oncall:setStatus', inc.id, e.target.value as IncidentStatus))}>
          {STATUSES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={inc.severity ?? ''} onChange={(e) => e.target.value && go(() => api.invoke('oncall:setSeverity', inc.id, e.target.value as Severity))}>
          <option value="">severity…</option>
          {(Object.keys(SEV) as Severity[]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="text-muted">
          #{inc.channelName} · {inc.kind} · opened {timeAgo(inc.createdAt)}
          {(inc.occurrences ?? 1) > 1 ? ` · fired ${inc.occurrences} times${inc.lastSeenAt ? `, last ${timeAgo(inc.lastSeenAt)}` : ''}` : ''}
          {inc.costUsd > 0 ? ` · $${inc.costUsd.toFixed(2)} spent` : ''}
        </span>
        {r && <Badge tone={r.confidence === 'high' ? 'ok' : r.confidence === 'medium' ? 'accent' : 'warn'}>{r.confidence} confidence</Badge>}
        {r?.category && <Badge>{r.category}</Badge>}
      </div>
      <div className="flex-1 space-y-4 overflow-auto px-5 py-4 text-[13px]">
        {inc.error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">Triage failed: {inc.error}</div>}
        {inc.status === 'triaging' && (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> Investigating…
          </div>
        )}
        {r && (
          <section className="rounded-lg border border-border p-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Triage</div>
            <p className="mb-2">{r.summary}</p>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Likely cause</div>
            <p className="mb-2">{r.likelyCause}</p>
            {r.evidence.length > 0 && (
              <>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Evidence</div>
                <ul className="mb-2 list-disc pl-5 text-[12px]">
                  {r.evidence.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </>
            )}
            {r.nextSteps.length > 0 && (
              <>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Next steps</div>
                <ol className="list-decimal pl-5 text-[12px]">
                  {r.nextSteps.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ol>
              </>
            )}
          </section>
        )}
        {r && (
          <section className={clsx('rounded-lg border p-3', r.proposedFix ? 'border-ok/40 bg-ok/5' : 'border-border')}>
            <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Proposed fix
              {r.proposedFix && r.confidence === 'high' && <Badge tone="ok">recommended</Badge>}
            </div>
            {r.proposedFix ? (
              <>
                <p className="mb-2">{r.proposedFix.summary}</p>
                <ul className="mb-2 list-disc pl-5 text-[12px]">
                  {r.proposedFix.changes.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
                {r.proposedFix.risks && (
                  <p className="mb-2 text-[12px] text-muted">
                    <span className="font-medium text-text">Risks:</span> {r.proposedFix.risks}
                  </p>
                )}
              </>
            ) : (
              <p className="mb-2 text-[12px] text-muted">The triage did not propose a code change{r.confidence !== 'high' ? ` (confidence ${r.confidence})` : ''}. You can still ask for a draft PR; the agent derives the change from the evidence.</p>
            )}
            {inc.fix?.status === 'running' ? (
              <div className="flex items-center gap-2 text-[12px] text-muted">
                <Spinner /> {inc.fix.phase ?? 'Working…'}
                {inc.fix.branch && <span className="font-mono">{inc.fix.branch}</span>}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant={r.proposedFix && r.confidence === 'high' ? 'primary' : undefined} onClick={() => go(() => api.invoke('oncall:openFixPr', inc.id))} title="Branch from the default branch, let the agent apply the fix, push, and open a draft PR for review">
                  <GitPullRequest size={12} /> {inc.fix?.status === 'done' ? 'Open another draft PR' : inc.fix?.status === 'failed' ? 'Retry the draft PR' : 'Open a draft PR with the fix'}
                </Button>
                {inc.fix?.status === 'done' && inc.fix.prUrl && (
                  <Button size="sm" variant="ghost" onClick={() => void api.invoke('shell:openExternal', inc.fix!.prUrl!)}>
                    <ExternalLink size={12} /> {inc.fix.prUrl.replace(/^https?:\/\/github\.com\//, '')}
                  </Button>
                )}
                {inc.fix?.status === 'failed' && <span className="text-[12px] text-danger">Failed: {inc.fix.error}</span>}
                {inc.fix?.costUsd ? <span className="text-[11px] text-muted">${inc.fix.costUsd.toFixed(2)}</span> : null}
              </div>
            )}
          </section>
        )}
        {inc.proposals.filter((p) => p.status !== 'dismissed').length > 0 && (
          <section className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Replies</div>
            {inc.proposals
              .filter((p) => p.status !== 'dismissed')
              .map((p) => (
                <div key={p.id} className={clsx('rounded-lg border p-3', p.status === 'sent' ? 'border-border' : 'border-accent/40 bg-accent/5')}>
                  {p.status === 'sent' ? (
                    <div className="text-[12px]">
                      <span className="text-muted">Sent {timeAgo(p.sentAt ?? p.createdAt)}: </span>
                      {p.text}
                    </div>
                  ) : (
                    <>
                      <textarea className={clsx(inputCls, 'mb-2 min-h-[72px]')} value={drafts[p.id] ?? p.text} onChange={(e) => setDrafts({ ...drafts, [p.id]: e.target.value })} />
                      <div className="flex gap-2">
                        <Button size="sm" variant="primary" onClick={() => go(() => api.invoke('oncall:approve', inc.id, p.id, drafts[p.id] ?? p.text))}>
                          <Send size={12} /> Send in thread as you
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => go(() => api.invoke('oncall:dismissProposal', inc.id, p.id))}>
                          Dismiss
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ))}
          </section>
        )}
        <section>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Thread</div>
          <div className="space-y-1.5">
            {inc.messages.map((m) => (
              <div key={m.ts} className="rounded-lg bg-panel px-3 py-2 text-[12px]">
                <span className="font-medium">{m.userName ?? m.user}</span> <span className="text-muted">{timeAgo(new Date(Number(m.ts) * 1000).toISOString())}</span>
                <div className="mt-0.5 whitespace-pre-wrap">{m.text}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input className={inputCls} placeholder="Write a reply to send in the thread…" value={newReply} onChange={(e) => setNewReply(e.target.value)} />
            <Button size="sm" disabled={!newReply.trim()} onClick={() => go(async () => (await api.invoke('oncall:addProposal', inc.id, newReply.trim()), setNewReply('')))}>
              Draft
            </Button>
          </div>
        </section>
        {inc.notes.length > 0 && (
          <section>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Notes and questions</div>
            <div className="space-y-2">
              {inc.notes.map((n, i) => (
                <div key={i} className={clsx('rounded-lg px-3 py-2 text-[12px]', n.role === 'user' ? 'bg-accent-2/20' : n.role === 'agent' ? 'border border-border' : 'text-muted')}>
                  {n.role === 'agent' ? <Markdown text={n.text} /> : n.text}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      <div className="border-t border-border px-5 py-3">
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="Ask about this incident… (the agent reads the code and Slack, never changes anything)"
            value={question}
            disabled={asking}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && question.trim() && !asking) {
                setAsking(true)
                const q = question.trim()
                setQuestion('')
                void go(() => api.invoke('oncall:ask', inc.id, q)).finally(() => setAsking(false))
              }
            }}
          />
          <Button size="sm" variant="primary" disabled={!question.trim() || asking} onClick={() => {
            setAsking(true)
            const q = question.trim()
            setQuestion('')
            void go(() => api.invoke('oncall:ask', inc.id, q)).finally(() => setAsking(false))
          }}>
            {asking ? <Spinner /> : <MessageSquare size={12} />} Ask
          </Button>
        </div>
      </div>
    </div>
  )
}
