/**
 * Keep it mergeable, phase 2: bring a pull request's base branch into its branch when the person clicks
 * the proposal.
 *
 * - Behind its base, merge style: GitHub's "Update branch" (a merge commit made on GitHub). This leaves
 *   the Mac, so it only runs from the card that says so; the click is the confirmation.
 * - Behind its base, rebase style, or conflicting: a local merge (or rebase) of origin/<base> in the
 *   worktree. A clean result is committed and waits for the person to push. If git stops on conflicts,
 *   the conflicted files go to the workspace's agent with a prompt that resolves only mechanical
 *   conflicts and asks about the rest.
 *
 * Never stashes, discards or pushes: a worktree with uncommitted changes is refused, and "Abort" puts the
 * branch back exactly as it was.
 */
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { isAbsolute, join } from 'path'
import { buildConflictResolvePrompt } from '@shared/merge-prompts'
import type { MergeProposal, MergeUpdateResult, Workspace, WorkspaceRepo } from '@shared/types'
import { gitNet } from './git'
import { updatePrBranch } from './github'
import { ensureIdentity } from './prereqs'
import { getWorkspace, patchWorkspace } from './workspaces'

type Op = 'merge' | 'rebase'

/** A local git command; resolves with its output, rejects with git's own words. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // GIT_EDITOR=true: a merge commit or rebase step never waits for an editor that nobody will see.
    execFile('git', args, { cwd, env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${stderr || ''}${stdout || ''}`.trim() || err.message))
      else resolve(`${stdout}${stderr}`)
    })
  })
}

async function gitPath(cwd: string, name: string): Promise<string> {
  const p = (await git(cwd, ['rev-parse', '--git-path', name])).trim()
  return isAbsolute(p) ? p : join(cwd, p)
}

/** The worktree's current commit. */
export async function headOf(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim()
}

/** A merge or rebase git is in the middle of in this worktree, if any. */
export async function inProgressOp(cwd: string): Promise<Op | null> {
  if (existsSync(await gitPath(cwd, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(await gitPath(cwd, 'rebase-merge')) || existsSync(await gitPath(cwd, 'rebase-apply'))) return 'rebase'
  return null
}

/** Tracked files with uncommitted changes (untracked files do not block a merge and are left alone). */
async function dirtyFiles(cwd: string): Promise<string[]> {
  return (await git(cwd, ['status', '--porcelain', '--untracked-files=no']))
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
}

async function conflictedFiles(cwd: string): Promise<string[]> {
  return (await git(cwd, ['diff', '--name-only', '--diff-filter=U']))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

function findProposal(ws: Workspace, proposalId: string): { proposal: MergeProposal; repo: WorkspaceRepo } {
  const proposal = ws.mergeWatch?.proposals?.find((p) => p.id === proposalId)
  if (!proposal) throw new Error('That suggestion is gone; the pull request may have changed since. Check again from the pull requests pane.')
  const repo = ws.repos.find((r) => r.repoId === proposal.repoId)
  if (!repo) throw new Error(`${proposal.repoName} is no longer part of this workspace.`)
  return { proposal, repo }
}

/** Replace or drop one proposal, keeping the rest of the watch as it is now. */
function patchProposal(workspaceId: string, proposalId: string, next: MergeProposal | null): void {
  const w = getWorkspace(workspaceId).mergeWatch
  if (!w) return
  const proposals = (w.proposals ?? []).flatMap((p) => (p.id !== proposalId ? [p] : next ? [next] : []))
  patchWorkspace(workspaceId, { mergeWatch: { ...w, proposals } })
}

/**
 * The proposal's action: update on GitHub, or merge/rebase the base locally. The caller hands
 * `prompt` to the workspace's agent when the outcome is "conflicts".
 */
export async function bringInBase(workspaceId: string, proposalId: string): Promise<MergeUpdateResult> {
  const ws = getWorkspace(workspaceId)
  const { proposal, repo } = findProposal(ws, proposalId)
  if (proposal.kind !== 'behind' && proposal.kind !== 'conflict') throw new Error('Only a branch that is behind or conflicts with its base can be updated.')
  const base = proposal.baseRefName
  if (!base) throw new Error('The base branch of this pull request is unknown; check again from the pull requests pane.')
  const style: Op = ws.mergeWatch?.style === 'rebase' ? 'rebase' : 'merge'
  const cwd = repo.worktreePath

  if (proposal.kind === 'behind' && style === 'merge') {
    await updatePrBranch(cwd, proposal.pr)
    // Bring GitHub's merge commit into the worktree when that is a plain fast-forward; otherwise leave it for the next pull.
    let local = ' Pull to bring it into the worktree.'
    try {
      if (!(await dirtyFiles(cwd)).length && !(await inProgressOp(cwd))) {
        await gitNet(cwd, ['fetch', 'origin', repo.branch])
        await git(cwd, ['merge', '--ff-only', `origin/${repo.branch}`])
        local = ' The worktree has it too.'
      }
    } catch {
      /* the update on GitHub worked; the local fast-forward is a convenience */
    }
    patchProposal(workspaceId, proposalId, null)
    return { outcome: 'updated-on-github', message: `Updated ${repo.repoName} #${proposal.pr} on GitHub with the latest ${base} (a merge commit).${local}` }
  }

  const running = await inProgressOp(cwd)
  if (running) throw new Error(`A ${running} is already in progress in ${repo.repoName}. Finish it, or use Abort to put the branch back as it was.`)
  const dirty = await dirtyFiles(cwd)
  if (dirty.length) throw new Error(`${repo.repoName} has uncommitted changes in ${dirty.length} file${dirty.length === 1 ? '' : 's'} (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}). Commit them first; Sinfonie never stashes or discards your work.`)
  await ensureIdentity(cwd)
  await gitNet(cwd, ['fetch', 'origin', base])
  const before = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
  try {
    await git(cwd, style === 'merge' ? ['merge', '--no-edit', `origin/${base}`] : ['rebase', `origin/${base}`])
  } catch (err) {
    const files = await conflictedFiles(cwd)
    if (!files.length) {
      // Not a conflict (a hook, a missing ref…): put the branch back and say what git said.
      if (await inProgressOp(cwd)) await git(cwd, [style, '--abort']).catch(() => undefined)
      throw err
    }
    const prompt = buildConflictResolvePrompt(repo, { number: proposal.pr, title: proposal.title, url: proposal.prUrl, baseRefName: base }, style, files)
    patchProposal(workspaceId, proposalId, { ...proposal, inProgress: { op: style, files, startedAt: new Date().toISOString(), head: before } })
    return { outcome: 'conflicts', files, prompt, message: `${style === 'merge' ? 'Merging' : 'Rebasing onto'} ${base} stopped on conflicts in ${files.length} file${files.length === 1 ? '' : 's'}. The agent resolves the mechanical ones and asks you about the rest; Abort puts the branch back as it was.` }
  }
  const after = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
  patchProposal(workspaceId, proposalId, null)
  if (after === before) return { outcome: 'up-to-date', message: `${repo.repoName} already has the latest ${base}.` }
  return style === 'merge'
    ? { outcome: 'merged', message: `Merged the latest ${base} into ${repo.repoName} without conflicts. Push to update #${proposal.pr}.` }
    : { outcome: 'rebased', message: `Rebased ${repo.repoName} onto the latest ${base} without conflicts. The pull request needs a force-push (git push --force-with-lease) to update; that is your call.` }
}

/** Put the branch back as it was before the merge or rebase Sinfonie started. */
export async function abort(workspaceId: string, proposalId: string): Promise<Workspace> {
  const ws = getWorkspace(workspaceId)
  const { proposal, repo } = findProposal(ws, proposalId)
  const op = await inProgressOp(repo.worktreePath)
  if (op) await git(repo.worktreePath, [op, '--abort'])
  const { inProgress: _done, ...rest } = proposal
  void _done
  patchProposal(workspaceId, proposalId, rest)
  return getWorkspace(workspaceId)
}

export function setStyle(workspaceId: string, style: Op): Workspace {
  const w = getWorkspace(workspaceId).mergeWatch
  if (!w) throw new Error('Turn on Keep it mergeable first.')
  return patchWorkspace(workspaceId, { mergeWatch: { ...w, style } })
}
