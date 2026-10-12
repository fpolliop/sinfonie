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

export function buildConflictPrompt(repo: WorkspaceRepo, pr: Pick<PrInfo, 'number' | 'title' | 'url' | 'baseRefName'>): string {
  return [
    `${repo.repoName} PR #${pr.number} "${pr.title}" (${pr.url}) conflicts with ${pr.baseRefName}.`,
    ``,
    `In the worktree ${repo.worktreePath}: fetch origin and merge origin/${pr.baseRefName} into this branch (merge, do not rebase, never force-push). Resolve each conflict keeping both changes' intent. If a conflict is ambiguous (both sides changed the same behaviour differently), stop and ask me before choosing. Run the tests that cover the files you touched, commit the merge, and tell me what conflicted and how you resolved it. Do not push.`
  ].join('\n')
}
