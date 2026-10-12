/**
 * Running (feedback #65): everything Sinfonie is doing right now, in every space, and what is
 * scheduled next. Each row opens the thing itself or stops it with its own stop. Mission control
 * stays the attention view per space; this is the whole machine's to-do list.
 */
import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Activity, Bot, CalendarClock, Clock, FileCode, GitPullRequest, Hourglass, MessageSquare, Siren, Square, TerminalSquare, Wand2, Workflow } from 'lucide-react'
import type { Job } from '@shared/types'
import { api } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { elapsed, untilText, useJobs } from '@/lib/jobs'
import { useGuided } from '@/lib/guided'
import { useApp } from '@/stores/app'
import { useReviews } from '@/stores/reviews'
import { useOnCall } from '@/stores/oncall'
import { useMaestro, openMaestro } from '@/stores/maestro'
import { Button } from './ui'

const ICON: Record<Job['kind'], React.ReactNode> = {
  'agent-turn': <MessageSquare size={14} />,
  cli: <TerminalSquare size={14} />,
  'agent-task': <Workflow size={14} />,
  queued: <Hourglass size={14} />,
  'agent-run': <Bot size={14} />,
  scheduled: <CalendarClock size={14} />,
  review: <GitPullRequest size={14} />,
  triage: <Siren size={14} />,
  'fix-pr': <GitPullRequest size={14} />,
  script: <FileCode size={14} />,
  maestro: <Wand2 size={14} />
}
const STOP_LABEL: Partial<Record<Job['kind'], string>> = { queued: 'Remove', cli: 'Interrupt', review: 'Stop review', script: 'Stop script' }
/** The guided lens shows the person's own work and Maestro, in plain words; no scripts, CLI or subagents. */
const GUIDED_KINDS: Job['kind'][] = ['agent-turn', 'queued', 'maestro', 'review']

const gb = (b: number): string => `${(b / 1024 ** 3).toFixed(1)} GB`

export function RunningView(): React.JSX.Element {
  const { jobs: all, refresh } = useJobs(2500)
  const guided = useGuided()
  const spaces = useApp((s) => s.spaces)
  const notify = useApp((s) => s.notify)
  const setError = useApp((s) => s.setError)
  const [stopping, setStopping] = useState<string | null>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 15000)
    return () => window.clearInterval(t)
  }, [])

  const jobs = useMemo(() => (guided ? all.filter((j) => GUIDED_KINDS.includes(j.kind)) : all), [all, guided])
  const running = jobs.filter((j) => j.state === 'running').sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
  const waiting = jobs.filter((j) => j.state === 'queued')
  const scheduled = jobs.filter((j) => j.state === 'scheduled').sort((a, b) => (a.nextAt ?? '').localeCompare(b.nextAt ?? ''))
  const spaceOf = (id?: string): { name: string; color: string } | undefined => spaces.find((s) => s.id === id)

  const open = (j: Job): void => {
    const app = useApp.getState()
    if (j.workspaceId) app.select(j.workspaceId)
    else if (j.reviewKey) {
      app.setView('reviews')
      useReviews.getState().select(j.reviewKey)
    } else if (j.incidentId) {
      app.setView('oncall')
      useOnCall.getState().select(j.incidentId)
    } else if (j.conversationId) {
      void openMaestro().then(() => useMaestro.getState().select(j.conversationId!))
    } else if (j.agentId) {
      app.setOpenAgentId(j.agentId)
      app.setView('agents')
    }
  }
  const stop = (j: Job): void => {
    setStopping(j.id)
    void api
      .invoke('jobs:stop', j.id)
      .then((text) => notify({ kind: 'success', text }))
      .catch((err) => setError(friendlyError(err)))
      .finally(() => {
        setStopping(null)
        refresh()
      })
  }

  const row = (j: Job): React.JSX.Element => {
    const sp = spaceOf(j.spaceId)
    const when = j.state === 'scheduled' ? untilText(j.nextAt) : elapsed(j.startedAt)
    return (
      <li key={j.id} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
        <span className={clsx('shrink-0', j.state === 'running' ? 'text-accent' : 'text-muted')}>{ICON[j.kind]}</span>
        <button type="button" onClick={() => open(j)} className="min-w-0 flex-1 text-left" title="Open">
          <div className="truncate text-[13px] font-medium">{j.title}</div>
          {j.detail && <div className="truncate text-[12px] text-muted">{j.detail}</div>}
        </button>
        {sp && (
          <span className="hidden shrink-0 items-center gap-1 text-[11px] text-muted sm:inline-flex">
            <span className="h-2 w-2 rounded-full" style={{ background: sp.color }} />
            {sp.name}
          </span>
        )}
        {j.rss ? <span className="shrink-0 text-[11px] tabular-nums text-muted">{gb(j.rss)}</span> : null}
        {when && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted">
            <Clock size={11} aria-hidden />
            {when}
          </span>
        )}
        {j.stoppable && (
          <Button size="sm" variant="ghost" disabled={stopping === j.id} onClick={() => stop(j)}>
            <Square size={11} aria-hidden /> {STOP_LABEL[j.kind] ?? 'Stop'}
          </Button>
        )}
      </li>
    )
  }

  const section = (title: string, hint: string, list: Job[]): React.JSX.Element | null =>
    list.length ? (
      <section className="mb-5">
        <h2 className="mb-1.5 flex items-baseline gap-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
          {title} <span className="tabular-nums">{list.length}</span>
          <span className="normal-case tracking-normal">{hint}</span>
        </h2>
        <ul className="rounded-lg border border-border bg-panel">{list.map(row)}</ul>
      </section>
    ) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-4">
        <Activity size={15} className="text-accent" />
        <span className="text-[13px] font-semibold">{guided ? 'Working now' : 'Running'}</span>
        <span className="text-[12px] text-muted">{guided ? 'Everything Maestro and your tasks are doing.' : 'Everything Sinfonie is doing, in every space.'}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto max-w-[900px]">
          {section(guided ? 'Working' : 'Running', guided ? '' : 'oldest first', running)}
          {section('Waiting', 'for a free session slot', waiting)}
          {section('Scheduled next', 'in the next 24 hours', scheduled)}
          {jobs.length === 0 && <div className="py-16 text-center text-[13px] text-muted">{guided ? 'Nothing is working right now.' : 'Nothing is running right now.'}</div>}
        </div>
      </div>
    </div>
  )
}
