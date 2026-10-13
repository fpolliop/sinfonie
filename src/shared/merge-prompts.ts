/**
 * What the workspace's agent is asked to do about a pull request: address review threads, fix failing
 * checks, resolve conflicts with the base branch. Shared by the PR pane's buttons and Keep it mergeable.
 * Every prompt ends with "Do not push": pushing and replying on GitHub stay the person's call.
 */
import type { PrCheck, PrInfo, ReviewThread, Workspace, WorkspaceRepo } from './types'

export function buildAddressPrompt(ws: Pick<Workspace, 'name'>, items: { repo: WorkspaceRepo; pr: Pick<PrInfo, 'number' | 'title' | 'url'>; thread: ReviewThread }[]): string {
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

export function buildCiPrompt(repo: WorkspaceRepo, pr: Pick<PrInfo, 'number' | 'title' | 'url'>, failing: PrCheck[]): string {
  const list = failing.map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ''}`).join('\n')
  return [
    `Checks are failing on ${repo.repoName} PR #${pr.number} "${pr.title}" (${pr.url}).`,
    ``,
    `Failing:`,
    list,
    ``,
    `In the worktree ${repo.worktreePath}: read why each failed (\`gh pr checks ${pr.number}\`, then \`gh run view <run id> --log-failed\` for GitHub Actions), reproduce it locally when you can, and fix the cause in the code. Do not weaken or skip the check, and do not change CI configuration to make it pass. Commit with a message that references the PR number and tell me in two lines what failed and what you changed. Do not push.`
  ].join('\n')
}

/** The rule every conflict prompt carries: resolve the mechanical, ask about the rest. */
const AMBIGUITY = `Resolve only mechanical conflicts: both sides added different things (keep both), imports, formatting, a rename both sides clearly agree on. When the intent is unclear (both sides changed the same behaviour differently, or a change on one side depends on code the other side removed), stop and ask me with the AskUserQuestion tool, showing both versions, before choosing.`

export function buildConflictPrompt(repo: WorkspaceRepo, pr: Pick<PrInfo, 'number' | 'title' | 'url' | 'baseRefName'>): string {
  return [
    `${repo.repoName} PR #${pr.number} "${pr.title}" (${pr.url}) conflicts with ${pr.baseRefName}.`,
    ``,
    `In the worktree ${repo.worktreePath}: fetch origin and merge origin/${pr.baseRefName} into this branch (merge, do not rebase, never force-push). ${AMBIGUITY} Run the tests that cover the files you touched, commit the merge, and tell me what conflicted and how you resolved it. Do not push.`
  ].join('\n')
}

/**
 * Sinfonie already started the merge (or rebase) of the base in the worktree and git stopped on conflicts:
 * the agent finishes it, or aborts it when it cannot.
 */
export function buildConflictResolvePrompt(repo: WorkspaceRepo, pr: Pick<PrInfo, 'number' | 'title' | 'url' | 'baseRefName'>, op: 'merge' | 'rebase', files: string[]): string {
  const finish = op === 'merge' ? '`git add` each resolved file, then `git commit --no-edit` to finish the merge' : '`git add` each resolved file, then `git rebase --continue` (repeat for each commit that stops)'
  const abort = op === 'merge' ? 'git merge --abort' : 'git rebase --abort'
  return [
    `Sinfonie started ${op === 'merge' ? `merging origin/${pr.baseRefName} into` : `rebasing onto origin/${pr.baseRefName}`} ${repo.repoName} PR #${pr.number} "${pr.title}" (${pr.url}) in the worktree ${repo.worktreePath}, and git stopped on conflicts in:`,
    ``,
    files.map((f) => `- ${f}`).join('\n'),
    ``,
    `Resolve them there. ${AMBIGUITY} Then ${finish}. Run the tests that cover the files you touched, and tell me per file what conflicted and how you resolved it. If you cannot finish, run \`${abort}\` so the branch is as it was, and tell me why. Do not push${op === 'rebase' ? ' (after a rebase the branch needs a force-push, which is my call)' : ''}.`
  ].join('\n')
}
