/**
 * Keep it mergeable (feedback #50), phase 1: watch the pull requests of workspaces that asked for it
 * and, when something changes that needs doing, propose a fix. A check that starts failing, a review
 * thread that appears, a branch that starts conflicting: each becomes one proposal the person starts
 * with a click (the workspace's agent fixes and commits; it never pushes or replies on GitHub). An
 * approved, green, mergeable PR gets a "ready to merge" note. Only what changed since the last look
 * is proposed, so the same failure is not proposed twice. Phase 2 (merge-update.ts): a branch that is behind
 * or conflicts with its base is updated or merged in from the card, with conflicts handed to the agent.
 */
import { BrowserWindow, Notification } from 'electron'
import { nanoid } from 'nanoid'
import { getStore } from '../store'
import { behindBy, repoPrStatus } from './github'
import { getWorkspace, patchWorkspace } from './workspaces'
import { buildAddressPrompt, buildCiPrompt, buildConflictPrompt } from '@shared/merge-prompts'
import { headOf, inProgressOp } from './merge-update'
import type { MergeProposal, MergeWatch, Workspace } from '@shared/types'

const POLL_MS = 4 * 60 * 1000
const checking = new Set<string>()
let timer: NodeJS.Timeout | null = null

export function setWatch(workspaceId: string, on: boolean): Workspace {
  const ws = getWorkspace(workspaceId)
  const next: MergeWatch | undefined = on ? { on: true, since: new Date().toISOString(), seen: {}, proposals: ws.mergeWatch?.proposals ?? [], ...(ws.mergeWatch?.style ? { style: ws.mergeWatch.style } : {}) } : undefined
  const saved = patchWorkspace(workspaceId, { mergeWatch: next })
  if (on) void check(workspaceId).catch(() => undefined)
  return saved
}

export function dismiss(workspaceId: string, proposalId: string): Workspace {
  const ws = getWorkspace(workspaceId)
  if (!ws.mergeWatch) return ws
  return patchWorkspace(workspaceId, { mergeWatch: { ...ws.mergeWatch, proposals: (ws.mergeWatch.proposals ?? []).filter((p) => p.id !== proposalId) } })
}

/** Look at every PR of the workspace once and turn what changed into proposals. */
export async function check(workspaceId: string): Promise<MergeProposal[]> {
  if (checking.has(workspaceId)) return []
  checking.add(workspaceId)
  try {
    const ws = getWorkspace(workspaceId)
    const watch = ws.mergeWatch
    if (!watch?.on || ws.status !== 'ready') return []
    const seen = { ...(watch.seen ?? {}) }
    const fresh: MergeProposal[] = []
    let lastError: string | undefined
    const now = new Date().toISOString()
    for (const repo of ws.repos) {
      const st = await repoPrStatus(repo.repoId, repo.worktreePath, repo.branch)
      if (st.error) lastError = st.error
      const pr = st.pr
      if (!pr || pr.state !== 'OPEN') {
        delete seen[repo.repoId]
        continue
      }
      const prev = seen[repo.repoId]?.pr === pr.number ? seen[repo.repoId] : undefined
      const failingChecks = pr.checks.filter((c) => c.status === 'failure')
      const failing = failingChecks.map((c) => c.name)
      const unresolved = st.threads.filter((t) => !t.isResolved)
      const conflict = pr.mergeable === 'CONFLICTING'
      const settled = pr.checks.every((c) => c.status === 'success' || c.status === 'neutral' || c.status === 'skipped')
      const ready = !pr.isDraft && pr.mergeable === 'MERGEABLE' && settled && (pr.reviewDecision === 'APPROVED' || pr.reviewDecision === '')
      const base = { repoId: repo.repoId, repoName: repo.repoName, pr: pr.number, prUrl: pr.url, createdAt: now }

      const newlyFailing = failingChecks.filter((c) => !prev?.failing.includes(c.name))
      if (newlyFailing.length) fresh.push({ ...base, id: nanoid(8), kind: 'ci', title: `${newlyFailing.length === 1 ? `${newlyFailing[0].name} is` : `${newlyFailing.length} checks are`} failing on ${repo.repoName} #${pr.number}.`, prompt: buildCiPrompt(repo, pr, failingChecks) })
      const newThreads = unresolved.filter((t) => !prev?.threads.includes(t.id))
      if (newThreads.length) {
        const who = Array.from(new Set(newThreads.flatMap((t) => t.comments.slice(0, 1).map((c) => c.author)))).join(', ')
        fresh.push({ ...base, id: nanoid(8), kind: 'review', title: `${newThreads.length} new review comment${newThreads.length === 1 ? '' : 's'} on ${repo.repoName} #${pr.number}${who ? ` from ${who}` : ''}.`, prompt: buildAddressPrompt(ws, unresolved.map((thread) => ({ repo, pr, thread }))) })
      }
      if (conflict && !prev?.conflict) fresh.push({ ...base, id: nanoid(8), kind: 'conflict', baseRefName: pr.baseRefName, title: `${repo.repoName} #${pr.number} conflicts with ${pr.baseRefName}.`, prompt: buildConflictPrompt(repo, pr) })
      // Behind, when branch protection requires the branch to be up to date before merging (phase 2).
      const behind = !conflict && pr.mergeStateStatus === 'BEHIND'
      if (behind && !prev?.behind) {
        const n = await behindBy(repo.worktreePath, pr.baseRefName, pr.headRefName)
        fresh.push({ ...base, id: nanoid(8), kind: 'behind', baseRefName: pr.baseRefName, title: `${repo.repoName} #${pr.number} is behind ${pr.baseRefName}${n ? ` by ${n} commit${n === 1 ? '' : 's'}` : ''} and must be up to date to merge.` })
      }
      if (ready && !prev?.ready) fresh.push({ ...base, id: nanoid(8), kind: 'ready', title: `${repo.repoName} #${pr.number} is ${pr.reviewDecision === 'APPROVED' ? 'approved, ' : ''}green and ready to merge.` })

      seen[repo.repoId] = { pr: pr.number, failing, threads: unresolved.map((t) => t.id), conflict, ready, behind }
    }
    // A merge Sinfonie started: once git is no longer in the middle of it, it was either finished (the
    // branch moved past where it started: resolved locally, waiting for a push) or aborted outside Sinfonie.
    const settledIds = new Map<string, 'resolved' | 'aborted'>()
    for (const p of getWorkspace(workspaceId).mergeWatch?.proposals ?? []) {
      if (!p.inProgress) continue
      const repo = ws.repos.find((r) => r.repoId === p.repoId)
      if (!repo || (await inProgressOp(repo.worktreePath).catch(() => null))) continue
      settledIds.set(p.id, p.inProgress.head && (await headOf(repo.worktreePath)) === p.inProgress.head ? 'aborted' : 'resolved')
    }
    // A newer proposal of the same kind for the same PR replaces the older one; fixed problems drop out.
    const latest = getWorkspace(workspaceId).mergeWatch
    if (!latest?.on) return []
    const current = (latest.proposals ?? []).map((p): MergeProposal => {
      const how = settledIds.get(p.id)
      if (!how) return p
      const { inProgress: _done, ...rest } = p
      void _done
      return how === 'resolved' ? { ...rest, resolvedLocally: true } : rest
    })
    const keep = current.filter((p) => {
      // A merge Sinfonie started stays on screen (with Abort) until it is finished or aborted, whatever GitHub says.
      if (p.inProgress) return true
      if (fresh.some((f) => f.repoId === p.repoId && f.kind === p.kind)) return false
      const s = seen[p.repoId]
      if (!s || s.pr !== p.pr) return false
      if (p.kind === 'ci') return s.failing.length > 0
      if (p.kind === 'review') return s.threads.length > 0
      if (p.kind === 'conflict') return s.conflict
      if (p.kind === 'behind') return Boolean(s.behind)
      return s.ready
    })
    // A conflict proposal waiting on the agent is not doubled by a fresh one for the same PR.
    const dedup = fresh.filter((f) => !keep.some((k) => k.inProgress && k.repoId === f.repoId && k.kind === f.kind))
    patchWorkspace(workspaceId, { mergeWatch: { ...latest, seen, proposals: [...keep, ...dedup], checkedAt: now, ...(lastError ? { lastError } : { lastError: undefined }) } })
    if (dedup.length) announce(ws, dedup)
    return dedup
  } finally {
    checking.delete(workspaceId)
  }
}

function announce(ws: Workspace, list: MergeProposal[]): void {
  if (!getStore().get().settings.desktopNotifications || !Notification.isSupported()) return
  const n = new Notification({ title: `${ws.name}: ${list.length === 1 ? list[0].title : `${list.length} things need you on its pull requests`}`, body: list.length === 1 ? (list[0].kind === 'behind' ? 'Open the workspace to update the branch.' : list[0].prompt ? 'Open the workspace to have the agent fix it.' : 'Open the pull request to merge it.') : list.map((p) => p.title).join(' ').slice(0, 180) })
  n.on('click', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('ui:openWorkspace', { workspaceId: ws.id })
  })
  n.show()
}

/** Look at every watched workspace every few minutes. */
export function start(): void {
  if (timer) return
  const tick = async (): Promise<void> => {
    for (const ws of getStore().get().workspaces) {
      if (!ws.mergeWatch?.on || ws.status !== 'ready') continue
      await check(ws.id).catch((err) => {
        const w = getStore().get().workspaces.find((x) => x.id === ws.id)
        if (w?.mergeWatch) patchWorkspace(ws.id, { mergeWatch: { ...w.mergeWatch, lastError: err instanceof Error ? err.message : String(err) } })
      })
    }
  }
  timer = setInterval(() => void tick(), POLL_MS)
  setTimeout(() => void tick(), 20_000)
}
export function stop(): void {
  if (timer) clearInterval(timer)
  timer = null
}
