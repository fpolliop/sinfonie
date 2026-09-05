import React, { useEffect, useMemo } from 'react'
import clsx from 'clsx'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useUsage, subscribeUsage, windowLabel, clock, fmtTokens } from '@/stores/usage'
import { Badge, Field, inputCls } from './ui'
import type { UsageLimit } from '@shared/types'

function tone(u: number): 'ok' | 'warn' | 'danger' {
  return u >= 0.9 ? 'danger' : u >= 0.7 ? 'warn' : 'ok'
}
const BAR: Record<'ok' | 'warn' | 'danger', string> = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger' }

/** Application → Usage: subscription windows per account, spend per day, and where it went. */
export function UsagePage(): React.JSX.Element {
  const snap = useUsage((s) => s.snapshot)
  const settings = useApp((s) => s.settings)
  const workspaces = useApp((s) => s.workspaces)
  const spaces = useApp((s) => s.spaces)
  const setError = useApp((s) => s.setError)
  useEffect(() => subscribeUsage(), [])
  const nameOfWs = (id: string): string => workspaces.find((w) => w.id === id)?.name ?? (id ? 'Removed workspace' : 'Outside workspaces')
  const nameOfSpace = (id: string): string => spaces.find((s) => s.id === id)?.name ?? (id ? 'Removed space' : 'No space')
  const update = (patch: Record<string, unknown>): void => {
    api.invoke('settings:update', { usage: { ...(settings.usage ?? {}), ...patch } }).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  const last14 = useMemo(() => (snap?.days ?? []).slice(-14), [snap])
  const maxDay = Math.max(0.01, ...last14.map((d) => d.costUsd))
  const week = useMemo(() => (snap?.days ?? []).slice(-7).reduce((n, d) => n + d.costUsd, 0), [snap])

  return (
    <div className="max-w-[820px]">
      <p className="mb-4 text-[12px] text-muted">Subscription windows come from Claude Code itself on every turn, so they reflect all your Claude use, not only Sinfonie. Spend figures are estimates at list price; on a subscription they show relative weight, not a bill.</p>

      <section className="mb-5">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Subscription windows</div>
        {(snap?.accounts ?? []).length === 0 && <div className="text-[12px] text-muted">No Claude accounts yet.</div>}
        {(snap?.accounts ?? []).map((a) => (
          <div key={a.accountId} className="mb-2 rounded-lg border border-border p-3">
            <div className="mb-1.5 flex items-center gap-2 text-[13px] font-medium">
              {a.name}
              {a.limits.length === 0 && <span className="text-[11px] font-normal text-muted">no readings yet; they arrive with the first turn</span>}
            </div>
            {a.limits.map((l: UsageLimit) => {
              const t = tone(l.utilization)
              return (
                <div key={l.type} className="mb-2 last:mb-0">
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="w-[110px] text-muted">{windowLabel(l.type)}</span>
                    <span className="font-mono">{Math.round(l.utilization * 100)}%</span>
                    <Badge tone={t}>{l.status === 'rejected' ? 'exhausted' : t === 'danger' ? 'nearly full' : t === 'warn' ? 'filling up' : 'ok'}</Badge>
                    <span className="ml-auto text-[11px] text-muted">
                      {l.resetsAt ? `resets ${clock(l.resetsAt)}` : ''}
                      {l.projectedExhaustAt && l.utilization < 1 ? ` · at this pace runs out around ${clock(l.projectedExhaustAt)}` : ''}
                      {` · read ${clock(l.at)}`}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
                    <div className={clsx('h-full rounded-full', BAR[t])} style={{ width: `${Math.min(100, l.utilization * 100)}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </section>

      <section className="mb-5 grid grid-cols-3 gap-3">
        <Tile label="Today" value={`$${(snap?.today.costUsd ?? 0).toFixed(2)}`} sub={`${snap?.today.turns ?? 0} turns · ${fmtTokens(snap?.today.inputTokens ?? 0)} in · ${fmtTokens(snap?.today.outputTokens ?? 0)} out`} />
        <Tile label="Last 7 days" value={`$${week.toFixed(2)}`} sub="estimated at list price" />
        <Tile label="Open sessions" value={String(Object.values(snap?.contextTokens ?? {}).filter((t) => t >= (snap?.contextWarnTokens ?? 120000)).length)} sub={`with more than ${fmtTokens(snap?.contextWarnTokens ?? 120000)} tokens of context`} />
      </section>

      <section className="mb-5">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Last 14 days</div>
        <div className="flex h-[96px] items-end gap-1 rounded-lg border border-border px-3 pt-3 pb-2">
          {last14.length === 0 && <div className="text-[12px] text-muted">Nothing recorded yet.</div>}
          {last14.map((d) => (
            <div key={d.day} className="group relative flex flex-1 flex-col items-center justify-end" title={`${d.day}: $${d.costUsd.toFixed(2)} · ${d.turns} turns`}>
              <div className="w-full rounded-t bg-accent/70 group-hover:bg-accent" style={{ height: `${Math.max(2, (d.costUsd / maxDay) * 70)}px` }} />
              <div className="mt-1 text-[9px] text-muted">{d.day.slice(5)}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-5 grid grid-cols-2 gap-3">
        <Breakdown title="Today by model" rows={Object.entries(snap?.today.byModel ?? {}).map(([k, v]) => [k, v] as [string, number])} />
        <Breakdown title="Today by kind" rows={Object.entries(snap?.today.byKind ?? {}).map(([k, v]) => [k, v] as [string, number])} />
        <Breakdown title="Today by space" rows={Object.entries(snap?.today.bySpace ?? {}).map(([k, v]) => [nameOfSpace(k), v] as [string, number])} />
        <Breakdown title="Today by workspace" rows={(snap?.topWorkspaces ?? []).map((w) => [`${nameOfWs(w.workspaceId)} · ${w.turns} turns`, w.costUsd] as [string, number])} />
      </section>

      <section className="mb-5 rounded-lg border border-border p-3 text-[12px]">
        <div className="mb-1 font-semibold">What burns a subscription fastest</div>
        <ul className="list-disc space-y-0.5 pl-5 text-muted">
          <li>Long sessions: every message re-reads the whole context. Start a new session per task; Sinfonie nudges you past {fmtTokens(snap?.contextWarnTokens ?? 120000)} tokens.</li>
          <li>Fan-out: several subagents each cost a full context. Budget mode caps them at two.</li>
          <li>Opus for routine work. Use the crew optimizer's cost setting, or Budget mode on a space, to keep Sonnet and Haiku on the routine parts.</li>
        </ul>
      </section>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Warn before a task at (% of a window)" hint="Below this Sinfonie stays quiet; at or above it asks before starting a turn and offers the alternatives.">
          <input type="number" min={50} max={99} className={inputCls} defaultValue={snap?.warnAtPct ?? 85} onBlur={(e) => update({ warnAtPct: Math.min(99, Math.max(50, Number(e.target.value) || 85)) })} />
        </Field>
        <Field label="Long-session nudge (tokens)" hint="One warning per session when its context passes this size.">
          <input type="number" min={20000} step={10000} className={inputCls} defaultValue={snap?.contextWarnTokens ?? 120000} onBlur={(e) => update({ contextWarnTokens: Math.max(20000, Number(e.target.value) || 120000) })} />
        </Field>
      </div>
    </div>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="text-[20px] font-semibold">{value}</div>
      <div className="text-[11px] text-muted">{sub}</div>
    </div>
  )
}
function Breakdown({ title, rows }: { title: string; rows: [string, number][] }): React.JSX.Element {
  const total = rows.reduce((n, [, v]) => n + v, 0) || 1
  const sorted = [...rows].sort((a, b) => b[1] - a[1]).slice(0, 8)
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-1.5 text-[12px] font-semibold">{title}</div>
      {sorted.length === 0 && <div className="text-[11px] text-muted">Nothing yet today.</div>}
      {sorted.map(([k, v]) => (
        <div key={k} className="mb-1 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{k}</span>
            <span className="font-mono text-[11px]">${v.toFixed(2)}</span>
            <span className="w-8 text-right text-[11px] text-muted">{Math.round((v / total) * 100)}%</span>
          </div>
          <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-panel-2">
            <div className="h-full rounded-full bg-accent/70" style={{ width: `${(v / total) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}
