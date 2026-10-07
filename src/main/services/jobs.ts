/**
 * Running (feedback #65): everything Sinfonie is doing right now across every space, and what is
 * scheduled next, read from the services that already track it, with Stop routed to each one's own
 * stop. Nothing here starts work; it only looks and stops.
 */
import { getStore } from '../store'
import * as agent from './agent'
import * as cliSession from './cli-session'
import * as resources from './resources'
import * as scripts from './scripts'
import * as assistant from './assistant'
import * as reviews from './reviews'
import * as runs from './crew/runs'
import * as library from './agents'
import * as scheduler from './crew/scheduler'
import * as oncall from './oncall/service'
import type { Job } from '@shared/types'

/** First time each running thing was seen, so a turn without its own start time still shows how long it has run. */
const firstSeen = new Map<string, string>()
const DAY_MS = 24 * 60 * 60 * 1000

function seen(id: string): string {
  let at = firstSeen.get(id)
  if (!at) {
    at = new Date().toISOString()
    firstSeen.set(id, at)
  }
  return at
}

export function list(): Job[] {
  const { workspaces, spaces, repos } = getStore().get()
  const out: Job[] = []
  const live = workspaces.filter((w) => w.status !== 'archived')
  const snap = resources.current()
  const rssOf = (workspaceId: string): number | undefined => snap.sessions.find((s) => s.workspaceId === workspaceId)?.rss || undefined

  for (const w of live) {
    if (agent.isBusy(w.id)) out.push({ id: `turn:${w.id}`, kind: 'agent-turn', state: 'running', title: w.name, detail: 'Agent working', workspaceId: w.id, spaceId: w.spaceId, startedAt: seen(`turn:${w.id}`), rss: rssOf(w.id), stoppable: true })
    else if (cliSession.isRunning(w.id)) out.push({ id: `cli:${w.id}`, kind: 'cli', state: 'running', title: w.name, detail: 'CLI session open', workspaceId: w.id, spaceId: w.spaceId, startedAt: seen(`cli:${w.id}`), rss: rssOf(w.id), stoppable: true })
    for (const t of resources.runningTasks(w.id)) out.push({ id: `task:${w.id}:${t.taskId}`, kind: 'agent-task', state: 'running', title: t.description || 'Subagent', detail: `In ${w.name}`, workspaceId: w.id, spaceId: w.spaceId, startedAt: t.startedAt, stoppable: true })
  }
  for (const id of snap.waiting) {
    const w = live.find((x) => x.id === id)
    out.push({ id: `queued:${id}`, kind: 'queued', state: 'queued', title: w?.name ?? 'A workspace', detail: 'Message waiting for a free session slot', workspaceId: id, spaceId: w?.spaceId, startedAt: seen(`queued:${id}`), stoppable: true })
  }
  for (const s of scripts.runningScripts()) {
    const w = live.find((x) => x.id === s.workspaceId)
    const repo = repos.find((r) => r.id === s.repoId)
    out.push({ id: `script:${s.workspaceId}:${s.repoId}:${s.kind}`, kind: 'script', state: 'running', title: `${s.kind === 'run' ? 'Run' : s.kind === 'setup' ? 'Setup' : s.kind} script · ${repo?.name ?? 'repository'}`, detail: w ? `In ${w.name}` : undefined, workspaceId: s.workspaceId, spaceId: w?.spaceId, startedAt: s.startedAt, stoppable: s.kind !== 'archive' })
  }
  for (const c of assistant.busyConversations()) out.push({ id: `maestro:${c.id}`, kind: 'maestro', state: 'running', title: c.title, detail: 'Maestro answering', conversationId: c.id, startedAt: seen(`maestro:${c.id}`), stoppable: true })
  for (const r of runs.activeRuns()) out.push({ id: `run:${r.runId}`, kind: 'agent-run', state: 'running', title: r.agentName, detail: r.prompt.replace(/\s+/g, ' ').slice(0, 120), agentId: r.agentId, startedAt: r.startedAt, stoppable: true })
  for (const r of reviews.listRuns()) {
    if (r.status !== 'preparing' && r.status !== 'running' && r.status !== 'fixing') continue
    const what = r.status === 'fixing' ? 'Fixing review findings' : r.status === 'preparing' ? 'Preparing the review' : 'Reviewing'
    out.push({ id: `review:${r.key}`, kind: 'review', state: 'running', title: `${r.pr.nameWithOwner}#${r.pr.number}`, detail: `${what}: ${r.pr.title}`, reviewKey: r.key, startedAt: r.startedAt, stoppable: true })
  }
  for (const inc of oncall.state().incidents) {
    if (inc.status === 'triaging') out.push({ id: `triage:${inc.id}`, kind: 'triage', state: 'running', title: inc.title, detail: `On call triage · #${inc.channelName}`, incidentId: inc.id, spaceId: inc.spaceId || undefined, startedAt: seen(`triage:${inc.id}`), stoppable: true })
    if (inc.fix?.status === 'running') out.push({ id: `fix:${inc.id}`, kind: 'fix-pr', state: 'running', title: inc.title, detail: `Drafting a fix PR${inc.fix.phase ? ` · ${inc.fix.phase}` : ''}`, incidentId: inc.id, spaceId: inc.spaceId || undefined, startedAt: seen(`fix:${inc.id}`), stoppable: true })
  }
  const now = Date.now()
  for (const spec of library.list()) {
    if (!spec.enabled) continue
    const next = scheduler.nextRunAt(spec)
    if (next && next.getTime() - now < DAY_MS) out.push({ id: `scheduled:${spec.id}`, kind: 'scheduled', state: 'scheduled', title: spec.name, detail: 'Scheduled run', agentId: spec.id, nextAt: next.toISOString(), spaceId: spec.scope, stoppable: false })
  }
  // Forget start times of things that are no longer running.
  const ids = new Set(out.map((j) => j.id))
  for (const id of firstSeen.keys()) if (!ids.has(id)) firstSeen.delete(id)
  void spaces
  return out
}

/** Stop one job with its owner's own stop. Returns a short sentence of what happened. */
export async function stop(id: string): Promise<string> {
  const [kind, ...rest] = id.split(':')
  const a = rest[0] ?? ''
  switch (kind) {
    case 'turn':
      runs.interrupt(a)
      await agent.interrupt(a)
      return 'Stopped the agent.'
    case 'cli':
      cliSession.interrupt(a)
      return 'Interrupted the CLI.'
    case 'task':
      await agent.stopTask(a, rest.slice(1).join(':'))
      return 'Stopped the subagent.'
    case 'queued':
      resources.cancelWaiting(a)
      return 'Removed the waiting message.'
    case 'script':
      scripts.stopScript(a, rest[1] ?? '', rest[2] ?? '')
      return 'Stopped the script.'
    case 'maestro':
      assistant.stop(a)
      return 'Stopped Maestro.'
    case 'run':
      runs.cancel(a)
      return 'Stopped the agent run.'
    case 'review':
      reviews.cancelReview(rest.join(':'))
      return 'Stopped the review; findings so far are kept.'
    case 'triage':
    case 'fix':
      oncall.cancel(a)
      return kind === 'fix' ? 'Stopped drafting the fix.' : 'Stopped the triage.'
    default:
      throw new Error('This cannot be stopped from here.')
  }
}

let timer: NodeJS.Timeout | null = null
/** Observe every few seconds, so elapsed times are right even before anyone opens Running. */
export function start(): void {
  if (timer) return
  timer = setInterval(() => {
    try {
      list()
    } catch {
      /* a service mid-shutdown must not break the timer */
    }
  }, 3000)
}
export function stopObserving(): void {
  if (timer) clearInterval(timer)
  timer = null
}
