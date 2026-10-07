import React, { useEffect } from 'react'
import clsx from 'clsx'
import { Square, X } from 'lucide-react'
import { api } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { useApp } from '@/stores/app'
import { useResources, subscribeResources, gb } from '@/stores/resources'
import { Badge, Button, Field, IconButton, Toggle, inputCls } from './ui'
import type { PressureLevel, ResourceSettings } from '@shared/types'

const DEFAULTS: Required<ResourceSettings> = { governor: 'enforce', maxSubagentsPerSession: 4, maxActiveSessions: 6, memoryBudgetPct: 60, stopSubagentsOnCritical: true }

const LEVEL: Record<PressureLevel, { label: string; tone: 'ok' | 'warn' | 'danger'; bar: string }> = {
  normal: { label: 'normal', tone: 'ok', bar: 'bg-ok' },
  warn: { label: 'under pressure', tone: 'warn', bar: 'bg-warn' },
  critical: { label: 'critical', tone: 'danger', bar: 'bg-danger' }
}

/** Settings → Resources: what Sinfonie costs the Mac right now, per workspace, and the limits the governor enforces. */
export function ResourcesPage(): React.JSX.Element {
  const snap = useResources((s) => s.snapshot)
  const settings = useApp((s) => s.settings)
  const workspaces = useApp((s) => s.workspaces)
  const setError = useApp((s) => s.setError)
  useEffect(() => subscribeResources(), [])
  const r = { ...DEFAULTS, ...(settings.resources ?? {}) }
  const update = (patch: Partial<ResourceSettings>): void => {
    api.invoke('settings:update', { resources: { ...r, ...patch } }).catch((err) => setError(friendlyError(err)))
  }
  const nameOf = (id: string): string => workspaces.find((w) => w.id === id)?.name ?? 'Unknown workspace'
  const pct = snap ? Math.min(100, (snap.appRss / snap.budget) * 100) : 0

  return (
    <div className="max-w-[760px]">
      <p className="mb-4 text-[12px] text-muted">Every agent process Sinfonie starts, plus whatever it spawns (MCP servers, test runners, builds), is measured every few seconds and charged to its workspace. The governor uses these numbers to keep the Mac responsive.</p>

      {snap ? (
        <>
          <div className="mb-4 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 text-[13px]">
              <span className="font-semibold">Sinfonie is using {gb(snap.appRss)}</span>
              <span className="text-muted">of a {gb(snap.budget)} budget ({r.memoryBudgetPct}% of {gb(snap.totalMem)})</span>
              <Badge tone={LEVEL[snap.appLevel ?? snap.level].tone}>{LEVEL[snap.appLevel ?? snap.level].label}</Badge>
              <span className="ml-auto text-[11px] text-muted" title="What the macOS kernel reports for the whole machine">
                macOS: {snap.osPressure} · swap {gb(snap.swapUsed)}
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
              <div className={clsx('h-full rounded-full transition-all', LEVEL[snap.appLevel ?? snap.level].bar)} style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1.5 text-[11px] text-muted">
              Sessions {gb(snap.sessions.reduce((n, s) => n + s.rss, 0))} · terminals {gb(snap.terminalsRss + snap.sessions.reduce((n, s) => n + s.terminalsRss, 0))} · app and other {gb(snap.otherRss)}
            </div>
            {snap.mac && (
              <div className="mt-3 border-t border-border pt-2.5">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="font-medium">Your Mac: {gb(snap.mac.used)} of {gb(snap.totalMem)} in use</span>
                  <span className="text-muted">
                    apps {gb(snap.mac.apps)} · wired {gb(snap.mac.wired)} · compressed {gb(snap.mac.compressed)} · cached files {gb(snap.mac.cached)}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-panel-2" title="Memory Used, as Activity Monitor counts it">
                  <div className={clsx('h-full rounded-full transition-all', snap.osPressure === 'critical' ? 'bg-danger' : snap.osPressure === 'warn' ? 'bg-warn' : 'bg-muted')} style={{ width: `${Math.min(100, (snap.mac.used / snap.totalMem) * 100)}%` }} />
                </div>
              </div>
            )}
            {snap.osPressure !== 'normal' && (
              <p className={clsx('mt-2 text-[12px]', snap.osPressure === 'critical' ? 'text-danger' : 'text-warn')}>
                Your Mac is low on memory, and it is not Sinfonie: macOS reports {snap.osPressure} pressure with {gb(snap.swapUsed)} in swap.
                {snap.topOthers?.length ? ` The biggest apps right now: ${snap.topOthers.map((o) => `${o.name} ${gb(o.rss)}`).join(', ')}.` : ''}
                {snap.osPressure === 'critical' ? ' New subagents wait until it eases.' : ' Subagents keep running; Sinfonie only holds back if macOS reports critical pressure.'}
              </p>
            )}
          </div>

          <div className="mb-4 rounded-lg border border-border">
            <div className="border-b border-border px-3 py-2 text-[12px] font-semibold">Sessions</div>
            {snap.sessions.length === 0 && <div className="px-3 py-3 text-[12px] text-muted">No agent process is running.</div>}
            {snap.sessions.map((s) => (
              <div key={s.workspaceId} className="border-b border-border px-3 py-2 last:border-b-0">
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="font-medium">{nameOf(s.workspaceId)}</span>
                  {s.busy && <Badge tone="accent">generating</Badge>}
                  <span className="ml-auto font-mono text-[12px]">{gb(s.rss)}</span>
                  <span className="w-20 text-right text-[11px] text-muted">{s.procs} proc{s.procs === 1 ? '' : 's'}</span>
                </div>
                {s.tasks.map((t) => (
                  <div key={t.taskId} className="mt-1 flex items-center gap-2 pl-4 text-[12px] text-muted">
                    <span className="h-1.5 w-1.5 rounded-full bg-warn" />
                    <span className="truncate">{t.description}</span>
                    <span className="text-[11px]">since {new Date(t.startedAt).toLocaleTimeString()}</span>
                    <button className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-panel-2 hover:text-danger" title="Stop this subagent; the orchestrator is told it was stopped" onClick={() => api.invoke('resources:stopTask', s.workspaceId, t.taskId).catch((err) => setError(friendlyError(err)))}>
                      <Square size={10} /> Stop
                    </button>
                  </div>
                ))}
              </div>
            ))}
            {snap.waiting.length > 0 && (
              <div className="border-t border-border px-3 py-2 text-[12px] text-muted">
                Waiting for a slot:{' '}
                {snap.waiting.map((id) => (
                  <span key={id} className="mr-2 inline-flex items-center gap-1">
                    {nameOf(id)}
                    <IconButton label={`Cancel the waiting message in ${nameOf(id)}`} className="hover:text-danger" onClick={() => void api.invoke('resources:cancelWaiting', id).catch((err) => setError(friendlyError(err)))}>
                      <X size={11} />
                    </IconButton>
                  </span>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <p className="mb-4 text-[12px] text-muted">Sampling…</p>
      )}

      <Field label="Governor" hint="Off only measures. Warn posts notices in the affected chats. Enforce also refuses new subagents and, when memory is critical, stops the newest one.">
        <select className={inputCls} value={r.governor} onChange={(e) => update({ governor: e.target.value as ResourceSettings['governor'] })}>
          <option value="off">Off, measure only</option>
          <option value="warn">Warn</option>
          <option value="enforce">Enforce</option>
        </select>
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Subagents per session" hint="The orchestrator is refused beyond this and told why.">
          <input type="number" min={1} max={32} className={inputCls} key={r.maxSubagentsPerSession} defaultValue={r.maxSubagentsPerSession} onBlur={(e) => update({ maxSubagentsPerSession: Math.max(1, Number(e.target.value) || DEFAULTS.maxSubagentsPerSession) })} />
        </Field>
        <Field label="Sessions generating at once" hint="Further messages wait for a free slot.">
          <input type="number" min={1} max={32} className={inputCls} key={r.maxActiveSessions} defaultValue={r.maxActiveSessions} onBlur={(e) => update({ maxActiveSessions: Math.max(1, Number(e.target.value) || DEFAULTS.maxActiveSessions) })} />
        </Field>
        <Field label="Memory budget, % of RAM" hint="Sinfonie holds back new subagents at 80% of it, and stops the newest one over 100%. macOS's own pressure only counts when it reports critical.">
          <input type="number" min={10} max={95} className={inputCls} key={r.memoryBudgetPct} defaultValue={r.memoryBudgetPct} onBlur={(e) => update({ memoryBudgetPct: Math.min(95, Math.max(10, Number(e.target.value) || DEFAULTS.memoryBudgetPct)) })} />
        </Field>
      </div>
      <Toggle checked={r.stopSubagentsOnCritical} onChange={(v) => update({ stopSubagentsOnCritical: v })} label="Under critical pressure, stop the newest subagent until it eases" />
      <p className="mt-3 text-[11px] text-muted">Samples are appended to logs/resources.jsonl in the app data folder, so a blowup can be traced afterwards.</p>
      <div className="mt-3">
        <Button size="sm" variant="ghost" onClick={() => update({ ...DEFAULTS })}>
          Reset to defaults
        </Button>
      </div>
    </div>
  )
}
