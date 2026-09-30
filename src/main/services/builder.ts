/**
 * Guided mode's "Undo this change": every guided turn ends with a save (a checkpoint commit per app, agent.ts), and
 * undoing a turn reverts those saves with new commits, so nothing is ever destroyed. It is all or nothing across the
 * turn's apps: every app is checked first, each revert is staged without committing, and if any app cannot take it
 * the ones already staged are put back. It shares one lock with the turn-end checkpoint and refuses while Maestro works.
 */
import { checkpoint, git } from './git'
import { getWorkspace } from './workspaces'
import { isBusy } from './agent'
import { withWorkspaceLock } from './ws-lock'
import { PLAIN_ERROR_MARK, type ChangeCheckpoint } from '@shared/types'

/** Plain words for the person; the marker tells the renderer to show these messages as they are. */
export class BuilderError extends Error {
  constructor(message: string) {
    super(PLAIN_ERROR_MARK + message)
  }
}

const undoMessage = (sha: string): string => `Undo change ${sha}`

export async function undoChange(workspaceId: string, checkpoints: ChangeCheckpoint[]): Promise<void> {
  if (isBusy(workspaceId)) throw new BuilderError('Maestro is still working. Undo this change when it has finished.')
  await withWorkspaceLock(workspaceId, async () => {
    if (isBusy(workspaceId)) throw new BuilderError('Maestro is still working. Undo this change when it has finished.')
    const ws = getWorkspace(workspaceId)
    // 1. Check every app before touching any.
    const plan: { path: string; sha: string }[] = []
    for (const cp of checkpoints) {
      const wr = ws.repos.find((r) => r.repoId === cp.repoId)
      if (!wr) throw new BuilderError('This change belongs to an app that is no longer part of the task, so it cannot be undone here.')
      if (!/^[0-9a-f]{7,40}$/i.test(cp.sha)) throw new BuilderError('This change cannot be undone.')
      const g = git(wr.worktreePath)
      const inHistory = await g.raw(['merge-base', '--is-ancestor', cp.sha, 'HEAD']).then(() => true, () => false)
      if (!inHistory) throw new BuilderError('This change is no longer part of the task, so there is nothing to undo.')
      const already = (await g.raw(['log', '--format=%H', `--grep=${undoMessage(cp.sha)}`, '--fixed-strings', `${cp.sha}..HEAD`]).catch(() => '')).trim()
      if (already) throw new BuilderError('This change was already undone.')
      const state = (await g.raw(['status', '--porcelain=v1', '--untracked-files=no']).catch(() => '')).split('\n')
      if (state.some((l) => /^(U.|.U|AA|DD)/.test(l))) throw new BuilderError('The app has unfinished changes that need a person to sort out. Ask Maestro or a teammate for help.')
      plan.push({ path: wr.worktreePath, sha: cp.sha })
    }
    // 2. Save anything not saved yet, so the undo never mixes with (or loses) other edits.
    for (const p of plan) await checkpoint(p.path, `Checkpoint: ${ws.name}`)
    // 3. Stage every revert; if one cannot apply, put back the ones already staged.
    const staged: string[] = []
    for (const p of plan) {
      try {
        await git(p.path).raw(['revert', '--no-commit', p.sha])
        staged.push(p.path)
      } catch (err) {
        for (const path of [p.path, ...staged]) await git(path).raw(['revert', '--abort']).catch(() => git(path).raw(['reset', '--hard', 'HEAD']).catch(() => undefined))
        const msg = err instanceof Error ? err.message : String(err)
        if (/index\.lock|another git process/i.test(msg)) throw new BuilderError('Sinfonie is still saving the last change. Try again in a moment.')
        if (/conflict|could not revert|after resolving/i.test(msg)) throw new BuilderError('Later changes build on this one, so it cannot be undone on its own. Ask Maestro to undo it instead.')
        throw new BuilderError('The change could not be undone. Ask Maestro to undo it instead.')
      }
    }
    // 4. One commit per app, naming the change it undoes (so a second undo is recognised).
    for (const p of plan) await git(p.path).raw(['commit', '--no-verify', '--allow-empty', '-m', undoMessage(p.sha)])
  })
}
