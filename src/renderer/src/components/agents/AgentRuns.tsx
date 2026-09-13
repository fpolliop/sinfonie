import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { CalendarClock, ChevronDown, ChevronRight, Loader2, Play, Timer, XCircle, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Markdown } from '@/lib/markdown'
import { Button, Field, inputCls } from '../ui'
import type { AgentRun, AgentSchedule, AgentSpec } from '@shared/types'

const INTERVALS: { minutes: number; label: string }[] = [
  { minutes: 15, label: 'Every 15 minutes' },
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 120, label: 'Every 2 hours' },
  { minutes: 240, label: 'Every 4 hours' },
  { minutes: 480, label: 'Every 8 hours' }
]

const TRIGGER_LABEL: Record<AgentRun['trigger'], string> = { manual: 'Run now', chat: 'Chat', mention: '@mention', schedule: 'Scheduled' }

/** The agent's schedule and its run history. */
export function AgentRuns({ agent }: { agent: AgentSpec }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const workspaces = useApp((s) => s.workspaces)
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const schedule: AgentSchedule = agent.schedule ?? { enabled: false, kind: 'interval', everyMinutes: 60, at: '09:00' }
  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err))
  useEffect(() => {
    api.invoke('agents:runs', agent.id).then(setRuns).catch(fail)
    return api.on('agents:runsChanged', (e) => e.agentId === agent.id && setRuns(e.runs))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id])
  const save = (patch: Partial<AgentSchedule>): void => {
    void api.invoke('agents:save', { ...agent, schedule: { ...schedule, ...patch } }).catch(fail)
  }
  const runNow = async (): Promise<void> => {
    setStarting(true)
    try {
      await api.invoke('agents:runNow', agent.id)
    } catch (err) {
      fail(err)
    } finally {
      setStarting(false)
    }
  }
  const running = runs.some((r) => !r.endedAt)
  const next = nextRunLabel(schedule, runs)
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto px-6 py-4">
      <section className="mx-auto w-full max-w-3xl">
        <div className="mb-2 flex items-center gap-2">
          <CalendarClock size={14} className="text-accent" />
          <span className="text-[13px] font-semibold">Schedule</span>
          <span className="text-[11px] text-muted">Runs while Sinfonie is open. Each run lands in the Chat tab and notifies you when it reports something.</span>
        </div>
        <div className="rounded-lg border border-border p-3">
          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={schedule.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
            <span className="font-medium">Run on a schedule</span>
            {schedule.enabled && next && <span className="text-muted">· next {next}</span>}
          </label>
          <div className={clsx('mt-3 grid grid-cols-[180px_1fr] gap-3', !schedule.enabled && 'opacity-60')}>
            <Field label="When">
              <select className={inputCls} value={schedule.kind === 'daily' ? 'daily' : String(schedule.everyMinutes ?? 60)} onChange={(e) => (e.target.value === 'daily' ? save({ kind: 'daily' }) : save({ kind: 'interval', everyMinutes: Number(e.target.value) }))}>
                {INTERVALS.map((i) => (
                  <option key={i.minutes} value={i.minutes}>
                    {i.label}
                  </option>
                ))}
                <option value="daily">Once a day at…</option>
              </select>
            </Field>
            {schedule.kind === 'daily' ? (
              <Field label="Time">
                <input type="time" className={clsx(inputCls, 'w-40')} value={schedule.at ?? '09:00'} onChange={(e) => save({ at: e.target.value })} />
              </Field>
            ) : (
              <div />
            )}
          </div>
          <Field label="Standing task" hint="What each run does. Empty means the agent's own description. It also gets the time and report of its previous run.">
            <textarea rows={2} className={inputCls} placeholder='e.g. "Sweep Slack since your previous run and file new todos."' value={schedule.prompt ?? ''} onChange={(e) => save({ prompt: e.target.value })} />
          </Field>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="primary" disabled={starting || running} onClick={() => void runNow()} title="Run the standing task now, outside the schedule">
              {starting || running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run now
            </Button>
            <span className="text-[11px] text-muted">{running ? 'A run is in progress; watch it in the Chat tab.' : ''}</span>
          </div>
        </div>
      </section>
      <section className="mx-auto mt-6 w-full max-w-3xl">
        <div className="mb-2 flex items-center gap-2">
          <Timer size={14} className="text-accent" />
          <span className="text-[13px] font-semibold">History</span>
          <span className="text-[11px] text-muted">{runs.length ? `${runs.length} run${runs.length === 1 ? '' : 's'}` : 'no runs yet'}</span>
        </div>
        <div className="flex flex-col gap-1">
          {runs.map((r) => {
            const isOpen = open === r.id
            const ws = r.workspaceId ? workspaces.find((w) => w.id === r.workspaceId) : undefined
            return (
              <div key={r.id} className="rounded-lg border border-border">
                <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]" onClick={() => setOpen(isOpen ? null : r.id)}>
                  {isOpen ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                  {!r.endedAt ? <Loader2 size={12} className="shrink-0 animate-spin text-warn" /> : r.error ? <XCircle size={12} className="shrink-0 text-danger" /> : <CheckCircle2 size={12} className="shrink-0 text-ok" />}
                  <span className="w-20 shrink-0 text-muted">{TRIGGER_LABEL[r.trigger]}</span>
                  <span className="min-w-0 flex-1 truncate">{r.error ?? firstLine(r.report) ?? r.prompt}</span>
                  {ws && <span className="shrink-0 text-[10px] text-muted">{ws.name}</span>}
                  <span className="shrink-0 text-[10px] text-muted">{when(r.startedAt)}{r.endedAt ? ` · ${duration(r.startedAt, r.endedAt)}` : ''}</span>
                </button>
                {isOpen && (
                  <div className="border-t border-border px-3 py-2 text-[12px]">
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">Task</div>
                    <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg p-2 font-mono text-[11px]">{r.prompt}</pre>
                    {r.report && (
                      <>
                        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">Report</div>
                        <div className="rounded-md border border-border bg-bg p-2">
                          <Markdown text={r.report.slice(0, 40_000)} />
                        </div>
                      </>
                    )}
                    {r.error && <div className="text-danger">{r.error}</div>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function firstLine(text?: string): string | undefined {
  if (!text) return undefined
  return text
    .replace(/[#*_`>]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
}
function when(iso: string): string {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function duration(a: string, b: string): string {
  const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
function nextRunLabel(s: AgentSchedule, runs: AgentRun[]): string | null {
  if (!s.enabled) return null
  const last = runs.find((r) => r.trigger === 'schedule' && r.endedAt)
  if (s.kind === 'interval') {
    const every = Math.max(5, s.everyMinutes ?? 60) * 60_000
    const at = last ? new Date(new Date(last.startedAt).getTime() + every) : new Date()
    return at.getTime() <= Date.now() ? 'within a minute' : at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  return `at ${s.at ?? '09:00'}`
}
