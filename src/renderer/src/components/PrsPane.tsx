import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { RefreshCw, ExternalLink, GitPullRequest, MessageSquareText, CheckCircle2, XCircle, Circle, MinusCircle, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useGithub } from '@/stores/github'
import { useChat } from '@/stores/chat'
import { Badge, Button, Dialog, Field, inputCls } from './ui'
import { timeAgo } from '@/lib/format'
import type { PrCheck, RepoPr, ReviewThread, Workspace } from '@shared/types'

export function PrsPane({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const setTab = useApp((s) => s.setTab)
  const setError = useApp((s) => s.setError)
  const state = useGithub((s) => s.byWorkspace[workspaceId])
  const refresh = useGithub((s) => s.refresh)
  const send = useChat((s) => s.send)
  const [prDlg, setPrDlg] = useState<string | null>(null)

  useEffect(() => {
    if (!state?.fetchedAt) void refresh(workspaceId)
  }, [workspaceId, state?.fetchedAt, refresh])

  if (!ws) return <div />

  const addressAll = (): void => {
    const unresolved = (state?.repos ?? []).flatMap((r) => r.threads.filter((t) => !t.isResolved).map((t) => ({ repo: ws.repos.find((x) => x.repoId === r.repoId)!, pr: r.pr!, thread: t })))
    if (unresolved.length === 0) return
    void send(workspaceId, buildAddressPrompt(ws, unresolved))
    setTab('chat')
  }
  const addressRepo = (repoId: string): void => {
    const r = state?.repos.find((x) => x.repoId === repoId)
    if (!r?.pr) return
    const unresolved = r.threads.filter((t) => !t.isResolved).map((t) => ({ repo: ws.repos.find((x) => x.repoId === repoId)!, pr: r.pr!, thread: t }))
    if (unresolved.length === 0) return
    void send(workspaceId, buildAddressPrompt(ws, unresolved))
    setTab('chat')
  }

  const totalUnresolved = (state?.repos ?? []).reduce((n, r) => n + r.threads.filter((t) => !t.isResolved).length, 0)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Pull requests</span>
        {state?.fetchedAt && <span className="text-[11px] text-muted">· updated {timeAgo(state.fetchedAt)}</span>}
        <span className="ml-auto" />
        {totalUnresolved > 0 && (
          <Button size="sm" variant="primary" onClick={addressAll}>
            <Sparkles size={12} /> Address all {totalUnresolved} review comment{totalUnresolved === 1 ? '' : 's'}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void refresh(workspaceId)} disabled={state?.loading}>
          <RefreshCw size={13} className={clsx(state?.loading && 'animate-spin')} /> Refresh
        </Button>
      </div>
      {state?.error && <div className="border-b border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{state.error}</div>}
      <div className="flex-1 overflow-auto p-4">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          {ws.repos.map((wr) => {
            const r = state?.repos.find((x) => x.repoId === wr.repoId)
            return (
              <RepoCard
                key={wr.repoId}
                repoName={wr.repoName}
                branch={wr.branch}
                data={r}
                loading={Boolean(state?.loading) && !r}
                onOpenPr={() => setPrDlg(wr.repoId)}
                onAddress={() => addressRepo(wr.repoId)}
              />
            )
          })}
        </div>
      </div>
      {prDlg && (
        <CreatePrDialog
          onClose={() => setPrDlg(null)}
          defaultTitle={ws.jira ? `${ws.jira.key}: ${ws.jira.summary}` : ws.linear ? `${ws.linear.identifier}: ${ws.linear.title}` : ws.name}
          onSubmit={async (t, b) => {
            try {
              const out = await api.invoke('git:createPr', workspaceId, prDlg, t, b)
              setError(out)
              await refresh(workspaceId)
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}
    </div>
  )
}

function RepoCard({ repoName, branch, data, loading, onOpenPr, onAddress }: { repoName: string; branch: string; data?: RepoPr; loading: boolean; onOpenPr: () => void; onAddress: () => void }): React.JSX.Element {
  const pr = data?.pr
  const unresolved = data?.threads.filter((t) => !t.isResolved) ?? []
  const resolved = data?.threads.filter((t) => t.isResolved) ?? []
  const [showResolved, setShowResolved] = useState(false)
  return (
    <section className="rounded-xl border border-border bg-panel">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <GitPullRequest size={15} className="text-muted" />
        <span className="text-[13px] font-semibold">{repoName}</span>
        <span className="font-mono text-[11px] text-muted">{branch}</span>
        {data?.nameWithOwner && <span className="text-[11px] text-muted">· {data.nameWithOwner}</span>}
        <span className="ml-auto" />
        {pr ? (
          <>
            <StateBadge pr={pr} />
            <button className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', pr.url)}>
              #{pr.number} <ExternalLink size={11} />
            </button>
          </>
        ) : loading ? (
          <span className="text-[12px] text-muted">Loading…</span>
        ) : data?.error ? null : (
          <Button size="sm" variant="primary" onClick={onOpenPr}>
            <GitPullRequest size={12} /> Open PR
          </Button>
        )}
      </header>
      {data?.error && <div className="px-4 py-2 text-[12px] text-danger">{data.error}</div>}
      {pr && (
        <div className="px-4 py-3">
          <div className="mb-2 text-[13px] font-medium">{pr.title}</div>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <span>
              {pr.headRefName} → {pr.baseRefName}
            </span>
            <span className="text-ok">+{pr.additions}</span>
            <span className="text-danger">−{pr.deletions}</span>
            <ReviewBadge decision={pr.reviewDecision} />
            {pr.mergeable === 'CONFLICTING' && <Badge tone="danger">merge conflicts</Badge>}
            <span>by {pr.author}</span>
          </div>
          {pr.checks.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                Checks · {pr.checks.filter((c) => c.status === 'success').length}/{pr.checks.length} passing
              </div>
              <div className="flex flex-wrap gap-1.5">
                {pr.checks.map((c, i) => (
                  <CheckChip key={i} check={c} />
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
              Review threads · {unresolved.length} open{resolved.length ? `, ${resolved.length} resolved` : ''}
            </div>
            {unresolved.length > 0 && (
              <Button size="sm" variant="primary" className="ml-auto" onClick={onAddress}>
                <Sparkles size={12} /> Address with Claude
              </Button>
            )}
          </div>
          {unresolved.length === 0 && <div className="mt-1 text-[12px] text-muted">Nothing to address.</div>}
          <div className="mt-2 flex flex-col gap-2">
            {unresolved.map((t) => (
              <ThreadView key={t.id} thread={t} />
            ))}
          </div>
          {resolved.length > 0 && (
            <button className="mt-2 text-[12px] text-muted hover:text-text" onClick={() => setShowResolved(!showResolved)}>
              {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved
            </button>
          )}
          {showResolved && (
            <div className="mt-2 flex flex-col gap-2 opacity-60">
              {resolved.map((t) => (
                <ThreadView key={t.id} thread={t} />
              ))}
            </div>
          )}
        </div>
      )}
      {!pr && !loading && !data?.error && <div className="px-4 py-3 text-[12px] text-muted">No pull request for this branch yet.</div>}
    </section>
  )
}

function ThreadView({ thread }: { thread: ReviewThread }): React.JSX.Element {
  return (
    <div className={clsx('rounded-md border border-border bg-bg p-2.5 text-[12px]', thread.isOutdated && 'border-dashed')}>
      <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] text-muted">
        <MessageSquareText size={12} />
        <span className="truncate">
          {thread.path}
          {thread.line != null && `:${thread.line}`}
        </span>
        {thread.isOutdated && <Badge>outdated</Badge>}
        {thread.isResolved && <Badge tone="ok">resolved</Badge>}
      </div>
      {thread.comments.map((c) => (
        <div key={c.id} className="mb-1.5 last:mb-0">
          <span className="font-medium">{c.author}</span> <span className="text-muted">{timeAgo(c.createdAt)}</span>
          <div className="whitespace-pre-wrap">{c.body}</div>
        </div>
      ))}
    </div>
  )
}

function StateBadge({ pr }: { pr: NonNullable<RepoPr['pr']> }): React.JSX.Element {
  if (pr.state === 'MERGED') return <Badge tone="accent">merged</Badge>
  if (pr.state === 'CLOSED') return <Badge tone="danger">closed</Badge>
  if (pr.isDraft) return <Badge>draft</Badge>
  return <Badge tone="ok">open</Badge>
}

function ReviewBadge({ decision }: { decision: string }): React.JSX.Element | null {
  if (decision === 'APPROVED') return <Badge tone="ok">approved</Badge>
  if (decision === 'CHANGES_REQUESTED') return <Badge tone="danger">changes requested</Badge>
  if (decision === 'REVIEW_REQUIRED') return <Badge tone="warn">review required</Badge>
  return null
}

function CheckChip({ check }: { check: PrCheck }): React.JSX.Element {
  const icon =
    check.status === 'success' ? <CheckCircle2 size={12} className="text-ok" /> : check.status === 'failure' ? <XCircle size={12} className="text-danger" /> : check.status === 'pending' ? <Circle size={12} className="text-warn" /> : <MinusCircle size={12} className="text-muted" />
  const inner = (
    <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px]">
      {icon} {check.name}
    </span>
  )
  return check.url ? (
    <button onClick={() => void api.invoke('shell:openExternal', check.url!)} className="hover:opacity-80">
      {inner}
    </button>
  ) : (
    inner
  )
}

function CreatePrDialog({ onClose, onSubmit, defaultTitle }: { onClose: () => void; onSubmit: (title: string, body: string) => Promise<void>; defaultTitle: string }): React.JSX.Element {
  const [title, setTitle] = useState(defaultTitle)
  const [body, setBody] = useState('')
  return (
    <Dialog title="Open pull request" onClose={onClose} width={520}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          await onSubmit(title, body)
          onClose()
        }}
      >
        <Field label="Title">
          <input autoFocus className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Body" hint="The Jira link and the sibling branches of this workspace are appended automatically.">
          <textarea rows={6} className={inputCls} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim()}>
            Create PR
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** The prompt sent to Claude when addressing review comments. Everything the reviewer wrote goes in verbatim. */
function buildAddressPrompt(ws: Workspace, items: { repo: Workspace['repos'][number]; pr: NonNullable<RepoPr['pr']>; thread: ReviewThread }[]): string {
  const byRepo = new Map<string, typeof items>()
  for (const it of items) byRepo.set(it.repo.repoId, [...(byRepo.get(it.repo.repoId) ?? []), it])
  const sections: string[] = []
  for (const [, list] of byRepo) {
    const { repo, pr } = list[0]
    const threads = list
      .map(({ thread }, i) => {
        const loc = `${thread.path}${thread.line != null ? `:${thread.line}` : ''}${thread.isOutdated ? ' (outdated: the code moved since the comment)' : ''}`
        const comments = thread.comments.map((c) => `  ${c.author}: ${c.body.replace(/\n/g, '\n  ')}`).join('\n')
        return `${i + 1}. ${loc}\n${comments}\n   thread url: ${thread.comments[0]?.url ?? pr.url}`
      })
      .join('\n\n')
    sections.push(`### ${repo.repoName} — PR #${pr.number} "${pr.title}"\nworktree: ${repo.worktreePath}\n\n${threads}`)
  }
  return [
    `Address the unresolved review comments on the pull request${byRepo.size > 1 ? 's' : ''} for workspace "${ws.name}".`,
    ``,
    `For each thread: make the change the reviewer asked for in that repository's worktree, or explain briefly why not if you disagree. Keep each repository's changes inside its own worktree. When you are done, commit in each affected worktree with a message that references the PR number, and give me a short list of what you changed per thread. Do not push.`,
    ``,
    sections.join('\n\n')
  ].join('\n')
}
