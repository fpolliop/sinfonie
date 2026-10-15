/**
 * Keep it mergeable (feedback #50): what Sinfonie noticed on this workspace's pull requests, each with
 * one action. Fix it hands the prepared request to the workspace's agent, which fixes and commits but
 * does not push; Open PR is for a pull request that is ready to merge. Dismiss forgets the proposal.
 *
 * Phase 2: a branch behind its base is updated (on GitHub, which the card says, or rebased locally), and
 * Resolve conflicts merges the base in the worktree first; if git stops on conflicts the agent gets them,
 * and Abort puts the branch back as it was.
 */
import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowDownToLine, CheckCircle2, GitMerge, MessageSquareText, Undo2, Wrench, XCircle } from 'lucide-react'
import type { MergeProposal, MergeUpdateResult } from '@shared/types'
import { api } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { useGuided, useWords } from '@/lib/guided'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { Button, Spinner } from './ui'

const ICON: Record<MergeProposal['kind'], React.ReactNode> = {
  ci: <XCircle size={14} className="text-danger" />,
  review: <MessageSquareText size={14} className="text-warn" />,
  conflict: <GitMerge size={14} className="text-warn" />,
  behind: <ArrowDownToLine size={14} className="text-warn" />,
  ready: <CheckCircle2 size={14} className="text-ok" />
}
/** The guided lens: the same news without checks, PR numbers or branches. */
const GUIDED_TITLE: Record<MergeProposal['kind'], string> = {
  ci: 'An automatic check failed on your change.',
  review: 'A reviewer left comments on your change.',
  conflict: 'Your change clashes with newer work from the team.',
  behind: 'Newer work from the team needs to be brought into your change before it can go live.',
  ready: 'Your change is approved and ready to go live.'
}

/** A proposal's one line, in the lens's words. */
export function proposalTitle(p: MergeProposal, guided: boolean): string {
  return guided ? GUIDED_TITLE[p.kind] : p.title
}

/** What happened after the click, in the lens's words; the agent's name comes from the vocabulary. */
function outcomeText(r: MergeUpdateResult, guided: boolean, agent: string): string {
  if (!guided) return r.message
  if (r.outcome === 'conflicts') return `Some of the changes clash. ${agent.charAt(0).toUpperCase() + agent.slice(1)} is sorting out the simple ones and will ask you about the rest.`
  if (r.outcome === 'up-to-date') return 'Your change already has the newest work.'
  return 'Brought the newest work into your change. Send it again to update the review.'
}

export function MergeProposals({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const proposals = useApp((s) => s.workspaces.find((w) => w.id === workspaceId)?.mergeWatch?.proposals)
  const style = useApp((s) => s.workspaces.find((w) => w.id === workspaceId)?.mergeWatch?.style ?? 'merge')
  const setError = useApp((s) => s.setError)
  const notify = useApp((s) => s.notify)
  const send = useChat((s) => s.send)
  const guided = useGuided()
  const w = useWords()
  const [busy, setBusy] = useState<string | null>(null)
  // When the agent's turn ends while a merge Sinfonie started is open, look again: it may be finished.
  const agentBusy = useChat((s) => Boolean(s.chats[workspaceId]?.busy))
  const waiting = Boolean(proposals?.some((p) => p.inProgress))
  const wasBusy = useRef(agentBusy)
  useEffect(() => {
    if (wasBusy.current && !agentBusy && waiting) void api.invoke('mergeWatch:check', workspaceId).catch(() => undefined)
    wasBusy.current = agentBusy
  }, [agentBusy, waiting, workspaceId])
  if (!proposals?.length) return null
  const dismiss = (p: MergeProposal): void => void api.invoke('mergeWatch:dismiss', workspaceId, p.id).catch((err) => setError(friendlyError(err)))
  const fix = (p: MergeProposal): void => {
    if (!p.prompt) return
    void send(workspaceId, p.prompt).then(() => dismiss(p))
  }
  /** Behind or conflicting: Sinfonie takes in the base; conflicts go to the agent. */
  const bringIn = (p: MergeProposal): void => {
    setBusy(p.id)
    void api
      .invoke('mergeWatch:bringInBase', workspaceId, p.id)
      .then((r) => {
        notify({ kind: r.outcome === 'conflicts' ? 'info' : 'success', text: outcomeText(r, guided, w.agent) })
        if (r.outcome === 'conflicts' && r.prompt) return send(workspaceId, r.prompt).then(() => undefined)
        return undefined
      })
      .catch((err) => setError(friendlyError(err)))
      .finally(() => setBusy(null))
  }
  const abort = (p: MergeProposal): void => {
    setBusy(p.id)
    void api
      .invoke('mergeWatch:abort', workspaceId, p.id)
      .then(() => notify({ kind: 'success', text: guided ? 'Put your change back as it was.' : `Aborted the ${p.inProgress?.op ?? 'merge'}; ${p.repoName} is back as it was.` }))
      .catch((err) => setError(friendlyError(err)))
      .finally(() => setBusy(null))
  }
  return (
    <div className="mb-2 flex flex-col gap-1.5" aria-label="Keep it mergeable">
      {proposals.map((p) => {
        const onGitHub = p.kind === 'behind' && style === 'merge'
        return (
          <div key={p.id} role="status" className={clsx('flex items-center gap-2 rounded-xl border px-3 py-2 text-[12px]', p.kind === 'ready' ? 'border-ok/40 bg-ok/5' : p.kind === 'ci' ? 'border-danger/40 bg-danger/5' : 'border-warn/40 bg-warn/5')}>
            {ICON[p.kind]}
            <span className="min-w-0 flex-1">
              {proposalTitle(p, guided)}
              {p.resolvedLocally ? (
                <span className="block text-[11px] text-muted">{guided ? 'Sorted out. Send it again to update the review.' : `Resolved in the worktree. Push to update #${p.pr}.`}</span>
              ) : p.inProgress ? (
                <span className="block text-[11px] text-muted">
                  {guided
                    ? `${w.agent.charAt(0).toUpperCase() + w.agent.slice(1)} is sorting out the clashes.`
                    : `${p.inProgress.op === 'merge' ? 'Merge' : 'Rebase'} in progress: ${p.inProgress.files.length} conflicted file${p.inProgress.files.length === 1 ? '' : 's'} (${p.inProgress.files.slice(0, 3).join(', ')}${p.inProgress.files.length > 3 ? ', …' : ''}) with the agent.`}
                </span>
              ) : onGitHub ? (
                <span className="block text-[11px] text-muted">{guided ? 'This updates your change for the team.' : `Updates the pull request on GitHub: merges the latest ${p.baseRefName ?? 'base'} into its branch.`}</span>
              ) : p.kind === 'behind' ? (
                <span className="block text-[11px] text-muted">{guided ? 'This updates your change.' : `Rebases the worktree onto the latest ${p.baseRefName ?? 'base'}; you push (force) afterwards.`}</span>
              ) : null}
            </span>
            {busy === p.id && <Spinner />}
            {p.resolvedLocally ? null : p.inProgress ? (
              <Button size="sm" variant="subtle" onClick={() => abort(p)} disabled={busy === p.id} title="Runs git merge --abort or git rebase --abort: the branch goes back to exactly how it was.">
                <Undo2 size={12} aria-hidden /> {guided ? 'Undo' : `Abort ${p.inProgress.op}`}
              </Button>
            ) : p.kind === 'behind' ? (
              <Button size="sm" variant="primary" onClick={() => bringIn(p)} disabled={busy === p.id}>
                <ArrowDownToLine size={12} aria-hidden /> {guided ? 'Bring it in' : onGitHub ? 'Update on GitHub' : 'Rebase locally'}
              </Button>
            ) : p.kind === 'conflict' ? (
              <Button size="sm" variant="primary" onClick={() => bringIn(p)} disabled={busy === p.id} title={`${style === 'rebase' ? 'Rebases onto' : 'Merges'} the latest base in the worktree. Conflicts go to the agent, which asks you when it is unsure. Nothing is pushed.`}>
                <Wrench size={12} aria-hidden /> {guided ? 'Sort it out' : 'Resolve conflicts'}
              </Button>
            ) : p.prompt ? (
              <Button size="sm" variant="primary" onClick={() => fix(p)} title="The agent fixes and commits; it does not push or reply on GitHub.">
                <Wrench size={12} aria-hidden /> {p.kind === 'review' ? (guided ? 'Make the changes' : 'Address comments') : 'Fix it'}
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => void api.invoke('shell:openExternal', p.prUrl)}>
                {guided ? 'See it' : 'Open PR'}
              </Button>
            )}
            {!p.inProgress && (
              <Button size="sm" variant="ghost" onClick={() => dismiss(p)}>
                Dismiss
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The switch, for the PR pane's header; experts also choose merge or rebase for updates. */
export function MergeWatchToggle({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const watch = useApp((s) => s.workspaces.find((w) => w.id === workspaceId)?.mergeWatch)
  const setError = useApp((s) => s.setError)
  const guided = useGuided()
  const on = Boolean(watch?.on)
  return (
    <span className="flex items-center gap-2">
      <label className="flex cursor-pointer items-center gap-1.5 text-[12px]" title={on ? `Watching${watch?.checkedAt ? `; last look ${new Date(watch.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}. Failing checks, new review comments, conflicts and a branch behind its base become one-click fixes; nothing is pushed on its own.` : 'Watch these pull requests and propose a fix when a check fails, a reviewer comments, or the branch conflicts with or falls behind its base.'}>
        <input type="checkbox" className="accent-[var(--color-accent)]" checked={on} onChange={(e) => void api.invoke('mergeWatch:set', workspaceId, e.target.checked).catch((err) => setError(friendlyError(err)))} />
        Keep it mergeable
        {watch?.lastError && (
          <span className="text-warn" title={watch.lastError}>
            · could not check
          </span>
        )}
      </label>
      {on && !guided && (
        <select
          className="rounded-md border border-border bg-bg px-1.5 py-0.5 text-[12px]"
          value={watch?.style ?? 'merge'}
          onChange={(e) => void api.invoke('mergeWatch:setStyle', workspaceId, e.target.value as 'merge' | 'rebase').catch((err) => setError(friendlyError(err)))}
          aria-label="How the branch takes in its base"
          title="Merge: a merge commit, never needs a force-push (a behind branch is updated on GitHub). Rebase: rebased locally; you force-push."
        >
          <option value="merge">Update by merge</option>
          <option value="rebase">Update by rebase</option>
        </select>
      )}
    </span>
  )
}
