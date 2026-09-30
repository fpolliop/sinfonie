import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ArrowRight, Globe, Plus } from 'lucide-react'
import type { Workspace } from '@shared/types'
import { useApp, spaceScope } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useGithub } from '@/stores/github'
import { useBuilder } from '@/stores/builder'
import { repoLabel, workspaceLabel } from '@/lib/labels'
import { timeAgo } from '@/lib/format'
import { stageLabel } from '@/lib/guided'
import { Button } from '../ui'

type Tone = 'attn' | 'run' | 'ok' | 'danger' | 'idle'
interface Status {
  tone: Tone
  text: string
  /** The next thing to do, as the card's call to action. */
  next: string
  /** Sort key: who is waiting on whom (docs/design/README.md principle 2). */
  rank: number
}

/**
 * The builder home (guided Tasks, docs/design/README.md "task cards with previews"): one card per task with the
 * last picture of its preview, where it stands in plain words, and the next thing to do. Tasks waiting for the
 * person come first. Pictures are the ones Sinfonie took of the preview; a task never previewed shows none.
 */
export function BuilderHome(): React.JSX.Element {
  const spaces = useApp((s) => s.spaces)
  const workspaces = useApp((s) => s.workspaces)
  const repos = useApp((s) => s.repos)
  const activeSpaceId = useApp((s) => s.activeSpaceId)
  const pendingRemoval = useApp((s) => s.pendingRemoval)
  const select = useApp((s) => s.select)
  const setShowNewWorkspace = useApp((s) => s.setShowNewWorkspace)
  const chats = useChat((s) => s.chats)
  const permissions = useChat((s) => s.permissions)
  const questions = useChat((s) => s.questions)
  const prs = useGithub((s) => s.byWorkspace)
  const thumbs = useBuilder((s) => s.thumbs)
  const [tab, setTab] = useState<'active' | 'live'>('active')
  useEffect(() => useBuilder.getState().subscribe(), [])

  const { currentId, inSpace } = useMemo(() => spaceScope({ spaces, workspaces, activeSpaceId, pendingRemoval }), [spaces, workspaces, activeSpaceId, pendingRemoval])
  const space = spaces.find((s) => s.id === currentId)
  const ids = useMemo(() => inSpace.map((w) => w.id), [inSpace])
  useEffect(() => {
    void useBuilder.getState().loadThumbs(ids)
    // Only when the set of tasks changes; pictures taken meanwhile arrive through the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')])

  const statusOf = (ws: Workspace): Status => {
    const c = chats[ws.id]
    if (ws.status === 'creating') return { tone: 'idle', text: 'Getting ready', next: 'Open', rank: 3 }
    if (ws.status === 'error') return { tone: 'danger', text: 'Could not be set up', next: 'See what happened', rank: 0 }
    if (permissions.some((p) => p.workspaceId === ws.id) || questions.some((q) => q.workspaceId === ws.id)) return { tone: 'attn', text: 'Waiting for you', next: 'Answer Maestro', rank: 0 }
    const reviewed = (prs[ws.id]?.repos ?? []).filter((p) => p.pr && p.pr.state === 'OPEN')
    if (reviewed.some((p) => p.pr!.reviewDecision === 'CHANGES_REQUESTED' || p.threads.some((t) => !t.isResolved))) return { tone: 'attn', text: 'Changes asked', next: 'See what the reviewer asked', rank: 0 }
    if (c?.busy) return { tone: 'run', text: 'Working', next: 'Watch it work', rank: 1 }
    if (c && !c.busy && (c.error || c.lastResult?.isError)) return { tone: 'danger', text: 'Hit a problem', next: 'See what happened', rank: 0 }
    // Otherwise the task's stage, in the same words as the task's header and the sidebar (lib/guided stageLabel).
    const stage = ws.stage ?? 'todo'
    const text = stageLabel(stage, true)
    if (stage === 'done') return { tone: 'ok', text, next: 'See it', rank: 5 }
    if (stage === 'in-review') {
      if (reviewed.some((p) => p.pr!.reviewDecision === 'APPROVED')) return { tone: 'ok', text: 'Approved', next: 'Open', rank: 4 }
      return { tone: 'idle', text, next: 'Open', rank: 4 }
    }
    if (stage === 'on-hold') return { tone: 'idle', text, next: 'Pick it up again', rank: 3 }
    const started = Boolean(ws.lastMessageAt) || (c?.items ?? []).some((it) => it.role === 'user')
    return { tone: 'idle', text, next: started ? 'Look at the preview' : 'Describe what should change', rank: 2 }
  }

  const rows = inSpace
    .map((ws) => ({ ws, st: statusOf(ws) }))
    .filter((r) => (tab === 'live' ? r.ws.stage === 'done' : r.ws.stage !== 'done'))
    .sort((a, b) => a.st.rank - b.st.rank || (b.ws.lastMessageAt ?? b.ws.createdAt).localeCompare(a.ws.lastMessageAt ?? a.ws.createdAt))
  const liveCount = inSpace.filter((w) => w.stage === 'done').length
  const waiting = rows.filter((r) => r.st.rank === 0).length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-6">
        <h1 className="text-[18px] font-semibold">Your tasks</h1>
        {space && <span className="truncate text-[13px] text-muted">{space.name}</span>}
        <Button variant="primary" className="ml-auto" onClick={() => setShowNewWorkspace(true, currentId)}>
          <Plus size={14} aria-hidden /> New task
          <kbd className="ml-1 rounded bg-black/30 px-1 font-sans text-[11px]">⇧⌘N</kbd>
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-[1080px] flex-col gap-5 px-6 py-6 text-[15px]">
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-muted">
              {waiting ? `${waiting} ${waiting === 1 ? 'task is' : 'tasks are'} waiting for you.` : rows.length ? 'Pick a task to see it and keep going.' : null}
            </p>
            <div role="radiogroup" aria-label="Which tasks" className="inline-flex rounded-md border border-border bg-bg p-0.5">
              {(
                [
                  { id: 'active', label: 'In progress' },
                  { id: 'live', label: `Live${liveCount ? ` · ${liveCount}` : ''}` }
                ] as { id: 'active' | 'live'; label: string }[]
              ).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={tab === o.id}
                  onClick={() => setTab(o.id)}
                  className={clsx('min-h-7 rounded px-3 text-[13px] font-medium transition-colors', tab === o.id ? 'bg-panel text-text shadow-sm ring-1 ring-border' : 'text-muted hover:text-text')}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
              <p className="max-w-md text-muted">{tab === 'live' ? 'Nothing is live yet. Tasks show here once the team approves them.' : 'No tasks in progress. A task is one thing you want built or changed in your app.'}</p>
              {tab === 'active' && (
                <Button variant="primary" onClick={() => setShowNewWorkspace(true, currentId)}>
                  <Plus size={14} aria-hidden /> Start a task
                </Button>
              )}
            </div>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
              {rows.map(({ ws, st }) => {
                const app = ws.repos.map((r) => repoLabel(repos.find((x) => x.id === r.repoId) ?? { name: r.repoName })).join(', ')
                const title = workspaceLabel(ws, true)
                const shot = thumbs[ws.id]
                return (
                  <li key={ws.id}>
                    <button type="button" onClick={() => select(ws.id)} className="group flex w-full flex-col overflow-hidden rounded-xl border border-border bg-panel text-left transition-shadow hover:shadow-md">
                      <div className="relative h-[150px] w-full overflow-hidden border-b border-border bg-panel-2">
                        {shot ? (
                          <img src={shot} alt={`The preview of ${title}`} className="h-full w-full object-cover object-top" />
                        ) : (
                          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-[13px] text-muted">
                            <Globe size={20} aria-hidden className="opacity-60" />
                            No preview yet
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-2 px-4 py-3">
                        <span className="line-clamp-2 font-semibold leading-snug">{title}</span>
                        <span className="flex min-w-0 flex-wrap items-center gap-2 text-[13px]">
                          <StatusPill tone={st.tone} text={st.text} />
                          <span className="min-w-0 truncate text-muted">
                            {app}
                            {ws.lastMessageAt ? ` · ${timeAgo(ws.lastMessageAt)}` : ''}
                          </span>
                        </span>
                        <span className="inline-flex items-center gap-1 text-[13px] font-medium text-accent group-hover:underline">
                          {st.next} <ArrowRight size={13} aria-hidden />
                        </span>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusPill({ tone, text }: { tone: Tone; text: string }): React.JSX.Element {
  return (
    <span
      className={clsx(
        'inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[12px] font-medium',
        tone === 'attn' && 'bg-warn/15 text-warn',
        tone === 'run' && 'bg-accent/15 text-accent',
        tone === 'ok' && 'bg-ok/15 text-ok',
        tone === 'danger' && 'bg-danger/15 text-danger',
        tone === 'idle' && 'bg-panel-2 text-muted'
      )}
    >
      <span aria-hidden className={clsx('h-1.5 w-1.5 rounded-full', tone === 'attn' ? 'bg-warn' : tone === 'run' ? 'animate-pulse bg-accent' : tone === 'ok' ? 'bg-ok' : tone === 'danger' ? 'bg-danger' : 'bg-muted')} />
      {text}
    </span>
  )
}
