/**
 * Keep it mergeable (feedback #50): what Sinfonie noticed on this workspace's pull requests, each with
 * one action. Fix it hands the prepared request to the workspace's agent, which fixes and commits but
 * does not push; Open PR is for a pull request that is ready to merge. Dismiss forgets the proposal.
 */
import React from 'react'
import clsx from 'clsx'
import { CheckCircle2, GitMerge, MessageSquareText, Wrench, XCircle } from 'lucide-react'
import type { MergeProposal } from '@shared/types'
import { api } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { useGuided } from '@/lib/guided'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { Button } from './ui'

const ICON: Record<MergeProposal['kind'], React.ReactNode> = {
  ci: <XCircle size={14} className="text-danger" />,
  review: <MessageSquareText size={14} className="text-warn" />,
  conflict: <GitMerge size={14} className="text-warn" />,
  ready: <CheckCircle2 size={14} className="text-ok" />
}
/** The guided lens: the same news without checks, PR numbers or branches. */
const GUIDED_TITLE: Record<MergeProposal['kind'], string> = {
  ci: 'An automatic check failed on your change.',
  review: 'A reviewer left comments on your change.',
  conflict: 'Your change clashes with newer work from the team.',
  ready: 'Your change is approved and ready to go live.'
}

/** A proposal's one line, in the lens's words. */
export function proposalTitle(p: MergeProposal, guided: boolean): string {
  return guided ? GUIDED_TITLE[p.kind] : p.title
}

export function MergeProposals({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const proposals = useApp((s) => s.workspaces.find((w) => w.id === workspaceId)?.mergeWatch?.proposals)
  const setError = useApp((s) => s.setError)
  const send = useChat((s) => s.send)
  const guided = useGuided()
  if (!proposals?.length) return null
  const dismiss = (p: MergeProposal): void => void api.invoke('mergeWatch:dismiss', workspaceId, p.id).catch((err) => setError(friendlyError(err)))
  const fix = (p: MergeProposal): void => {
    if (!p.prompt) return
    void send(workspaceId, p.prompt).then(() => dismiss(p))
  }
  return (
    <div className="mb-2 flex flex-col gap-1.5" aria-label="Keep it mergeable">
      {proposals.map((p) => (
        <div key={p.id} role="status" className={clsx('flex items-center gap-2 rounded-xl border px-3 py-2 text-[12px]', p.kind === 'ready' ? 'border-ok/40 bg-ok/5' : p.kind === 'ci' ? 'border-danger/40 bg-danger/5' : 'border-warn/40 bg-warn/5')}>
          {ICON[p.kind]}
          <span className="min-w-0 flex-1">{proposalTitle(p, guided)}</span>
          {p.prompt ? (
            <Button size="sm" variant="primary" onClick={() => fix(p)} title="The agent fixes and commits; it does not push or reply on GitHub.">
              <Wrench size={12} aria-hidden /> {p.kind === 'review' ? (guided ? 'Make the changes' : 'Address comments') : p.kind === 'conflict' ? (guided ? 'Sort it out' : 'Resolve conflicts') : 'Fix it'}
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void api.invoke('shell:openExternal', p.prUrl)}>
              {guided ? 'See it' : 'Open PR'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => dismiss(p)}>
            Dismiss
          </Button>
        </div>
      ))}
    </div>
  )
}

/** The switch, for the PR pane's header. */
export function MergeWatchToggle({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const watch = useApp((s) => s.workspaces.find((w) => w.id === workspaceId)?.mergeWatch)
  const setError = useApp((s) => s.setError)
  const on = Boolean(watch?.on)
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[12px]" title={on ? `Watching${watch?.checkedAt ? `; last look ${new Date(watch.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}. Failing checks, new review comments and conflicts become one-click fixes; nothing is pushed on its own.` : 'Watch these pull requests and propose a fix when a check fails, a reviewer comments or the branch conflicts.'}>
      <input type="checkbox" className="accent-[var(--color-accent)]" checked={on} onChange={(e) => void api.invoke('mergeWatch:set', workspaceId, e.target.checked).catch((err) => setError(friendlyError(err)))} />
      Keep it mergeable
      {watch?.lastError && <span className="text-warn" title={watch.lastError}>· could not check</span>}
    </label>
  )
}
