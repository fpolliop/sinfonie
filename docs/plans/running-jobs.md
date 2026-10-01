# Running: one place for everything Sinfonie is doing

Feedback #65 ("View running jobs"), 2026-09-22. Status: plan, 2026-10-01.

## Problem

Sinfonie runs a lot in the background, but you can only see some of it, one place at a time. Mission
control (0.1.70) lists the workspace agents that are running **in the current space**. Everything else
is invisible or scattered:

| Runs today | Where you can see it now | Can you stop it? |
|---|---|---|
| Workspace agent turns (SDK and CLI) | Mission control, per space | Yes, in the chat |
| An agent's own background tasks (subagents, long Bash) | Resources page, per session | Yes (`resources:stopTask`) |
| Messages queued for a free session slot | Resources page | Yes (`resources:cancelWaiting`) |
| Standalone agent runs (manual, scheduled, `@name`) | Agents view, per agent | Yes (`runs.cancel`) |
| Scheduled agents due later | Agents view, per agent | Pause the schedule |
| AI reviews and fix rounds / iterate | Review inbox, per PR | Yes (`cancelReview`, `stopIteration`) |
| On-call triage and draft-fix PRs | On call view | No |
| Setup and run scripts | The workspace's Run area | Yes (`workspaces:stopScript`) |
| Terminals | The workspace's terminal | Close the tab |
| Maestro conversations | Maestro | Yes (`maestro:stop`) |
| Tool processes started by ACP/native engines | Nowhere | No |

## Goal

One **Running** list across every space: what is running, queued and scheduled next, where, for how
long, what it is doing now, what it costs in memory, and a **Stop** on each row. Opening a row takes you
to the thing itself.

## Design

### A jobs registry in main

`src/main/services/jobs.ts` keeps `Job` records, and every service that starts long work registers one:

```ts
interface Job {
  id: string
  kind: 'agent-turn' | 'agent-task' | 'queued' | 'agent-run' | 'scheduled' | 'review' | 'review-fix'
      | 'triage' | 'fix-pr' | 'script' | 'terminal' | 'maestro' | 'tool'
  title: string                 // "Attribution: Claude Code", "Review fpolliop/sinfonie#76"
  workspaceId?: string; spaceId?: string; agentId?: string; reviewKey?: string; incidentId?: string
  state: 'running' | 'queued' | 'scheduled'
  startedAt?: string; nextAt?: string
  now?: string                  // current tool or step, short
  pid?: number                  // to join with the resources sampler for memory
  stoppable: boolean
}
```

- `jobs.start(job) → handle` with `update(patch)` and `end()`. Services call it where they already
  emit "busy" or register processes; `resources.registerProcess` becomes a thin caller of it.
- `jobs:list` (IPC) and a `jobs:changed` event, throttled to one emit per 500 ms.
- `jobs:stop(id)` dispatches to the owner's existing stop function (table above). On-call triage
  and fix-PR runs get an AbortController (they have none today).
- Memory per row comes from the resources sampler (joined by pid / workspace), so there is no second sampler.

### The Running panel

- A **Running** entry under Build in the rail, with a count badge, plus `⌘K → Running`.
- Grouped by state: Running, Queued, Scheduled next (24 h). Sorted by start time, Maestro last.
- Each row: kind icon, title, space chip, elapsed, current step, memory, and Open / Stop.
  Stop asks only for things that leave the Mac mid-flight (a fix PR that is pushing); otherwise Undo
  is not possible, so the button says what happens ("Stop the review; findings so far are kept").
- Guided lens: only the person's own tasks and Maestro, in plain words ("Working on Attribution",
  "Checking your change"). No scripts, tools or terminals.
- Maestro: a `running_jobs` tool, and the dock on Build can answer "what's running?" and stop things
  (stopping asks first, like every Maestro write).

### Out of scope

Historical runs and logs (Agents and Review keep theirs), CPU graphs, killing arbitrary system processes.

## Phases

1. **Registry**: `jobs.ts` and IPC; register agent turns, queued messages, scripts, Maestro,
   standalone runs and reviews (they already have stop functions).
2. **Panel**: the Running list with Open/Stop, rail entry, ⌘K, guided lens.
3. **Gaps**: register on-call triage and fix PRs with cancellation, ACP/native tool processes,
   terminals, and agent background tasks (from `resources`); add scheduled-next.
4. **Maestro**: `running_jobs` and `stop_job` tools; "N things running" in the brief when something
   has run for unusually long.

## Open questions

- Should a long-running job notify you (for example a turn over 20 minutes, or a script that exited
  with an error)? Proposal: yes, through the existing desktop notification setting.
- Does the phone companion get the list? It's cheap once `jobs:changed` exists; proposal: phase 4.
