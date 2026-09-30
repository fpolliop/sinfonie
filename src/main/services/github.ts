import { execFile } from 'child_process'
import { promisify } from 'util'
import { ghEnv, ghPath } from './prereqs'
import { PLAIN_ERROR_MARK } from '@shared/types'
import type { PrCheck, PrInfo, RepoPr, ReviewThread } from '@shared/types'

const exec = promisify(execFile)

async function gh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec(ghPath(), args, { cwd, env: ghEnv(), maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

interface RawRollup {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

function mapCheck(r: RawRollup): PrCheck {
  const name = r.name ?? r.context ?? 'check'
  const url = r.detailsUrl ?? r.targetUrl
  const c = (r.conclusion ?? r.state ?? '').toUpperCase()
  if (r.status && r.status !== 'COMPLETED' && !r.state) return { name, status: 'pending', url }
  if (c === 'SUCCESS') return { name, status: 'success', url }
  if (c === 'FAILURE' || c === 'ERROR' || c === 'TIMED_OUT' || c === 'CANCELLED' || c === 'ACTION_REQUIRED') return { name, status: 'failure', url }
  if (c === 'SKIPPED') return { name, status: 'skipped', url }
  if (c === 'PENDING' || c === 'EXPECTED' || c === '') return { name, status: 'pending', url }
  return { name, status: 'neutral', url }
}

const THREADS_QUERY = `query($owner:String!,$repo:String!,$n:Int!){
  repository(owner:$owner,name:$repo){ pullRequest(number:$n){
    reviewThreads(first:100){ nodes{ id isResolved isOutdated path line
      comments(first:50){ nodes{ id author{login} body url createdAt } } } } } } }`

/** PR + review threads for one worktree's branch. Uses the user's `gh` login. */
export async function repoPrStatus(repoId: string, worktreePath: string, branch: string): Promise<RepoPr> {
  const base: RepoPr = { repoId, branch, pr: null, threads: [], fetchedAt: new Date().toISOString() }
  let nameWithOwner: string | undefined
  try {
    nameWithOwner = (JSON.parse(await gh(['repo', 'view', '--json', 'nameWithOwner'], worktreePath)) as { nameWithOwner: string }).nameWithOwner
  } catch (err) {
    return { ...base, error: `gh repo view failed: ${shortErr(err)}`, ...ghErrorKind(err) }
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(
      await gh(
        ['pr', 'view', branch, '--json', 'number,title,url,state,isDraft,reviewDecision,mergeable,baseRefName,headRefName,additions,deletions,statusCheckRollup,author'],
        worktreePath
      )
    ) as Record<string, unknown>
  } catch (err) {
    const msg = shortErr(err)
    if (/no pull requests found/i.test(msg)) return { ...base, nameWithOwner }
    return { ...base, nameWithOwner, error: `gh pr view failed: ${msg}`, ...ghErrorKind(err) }
  }
  const pr: PrInfo = {
    number: raw.number as number,
    title: raw.title as string,
    url: raw.url as string,
    state: raw.state as PrInfo['state'],
    isDraft: Boolean(raw.isDraft),
    author: ((raw.author as { login?: string }) ?? {}).login ?? '',
    reviewDecision: (raw.reviewDecision as PrInfo['reviewDecision']) ?? '',
    mergeable: (raw.mergeable as string) ?? '',
    baseRefName: raw.baseRefName as string,
    headRefName: raw.headRefName as string,
    additions: (raw.additions as number) ?? 0,
    deletions: (raw.deletions as number) ?? 0,
    checks: ((raw.statusCheckRollup as RawRollup[]) ?? []).map(mapCheck)
  }
  let threads: ReviewThread[] = []
  try {
    const [owner, repo] = nameWithOwner.split('/')
    const out = JSON.parse(await gh(['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `n=${pr.number}`], worktreePath)) as {
      data: { repository: { pullRequest: { reviewThreads: { nodes: RawThread[] } } } }
    }
    threads = out.data.repository.pullRequest.reviewThreads.nodes.map((t) => ({
      id: t.id,
      path: t.path,
      line: t.line,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      comments: t.comments.nodes.map((c) => ({ id: c.id, author: c.author?.login ?? 'unknown', body: c.body, url: c.url, createdAt: c.createdAt }))
    }))
  } catch (err) {
    return { ...base, nameWithOwner, pr, error: `review threads failed: ${shortErr(err)}` }
  }
  return { ...base, nameWithOwner, pr, threads }
}

interface RawThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  comments: { nodes: { id: string; author: { login: string } | null; body: string; url: string; createdAt: string }[] }
}

/** Rename a branch on GitHub so open PRs follow it. Returns false when there is no remote branch. */
export async function renameRemoteBranch(worktreePath: string, oldBranch: string, newBranch: string): Promise<boolean> {
  let nameWithOwner: string
  try {
    nameWithOwner = (JSON.parse(await gh(['repo', 'view', '--json', 'nameWithOwner'], worktreePath)) as { nameWithOwner: string }).nameWithOwner
  } catch {
    return false
  }
  try {
    await gh(['api', '-X', 'POST', `repos/${nameWithOwner}/branches/${encodeURIComponent(oldBranch)}/rename`, '-f', `new_name=${newBranch}`], worktreePath)
    return true
  } catch (err) {
    const msg = shortErr(err)
    if (/404|Branch not found/i.test(msg)) return false
    throw new Error(`GitHub branch rename failed: ${msg}`)
  }
}

/** A gh failure the person can fix (install and sign in, or put the app on GitHub), for PrsPane's Connect GitHub card. */
function ghErrorKind(err: unknown): Pick<RepoPr, 'errorKind'> {
  if ((err as { code?: unknown })?.code === 'ENOENT') return { errorKind: 'gh-missing' }
  const msg = shortErr(err)
  if (/gh auth login|not logged in|authentication|HTTP 401|Bad credentials/i.test(msg)) return { errorKind: 'gh-auth' }
  if (/none of the git remotes|no git remotes|not a git repository|could not determine|unable to determine/i.test(msg)) return { errorKind: 'not-github' }
  return {}
}

function shortErr(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err && typeof (err as { stderr: unknown }).stderr === 'string') {
    const s = (err as { stderr: string }).stderr.trim()
    if (s) return s.split('\n').slice(0, 3).join(' ')
  }
  return err instanceof Error ? err.message.split('\n')[0] : String(err)
}

// ---------- search (views) ----------

export interface SearchedPr {
  repo: string
  repoName: string
  number: number
  title: string
  url: string
  branch: string
  draft: boolean
  author: string
  updatedAt: string
  additions: number
  deletions: number
  reviewDecision: string
  mergeable: string
  ci: 'success' | 'failure' | 'pending' | 'none'
}

const SEARCH_QUERY = `query($q:String!,$n:Int!){ search(query:$q, type:ISSUE, first:$n){ nodes{ ... on PullRequest {
  number title url isDraft headRefName updatedAt additions deletions reviewDecision mergeable author{login}
  repository{ nameWithOwner name }
  commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } } } } } }`

interface RawSearchPr {
  number: number
  title: string
  url: string
  isDraft: boolean
  headRefName: string
  updatedAt: string
  additions: number
  deletions: number
  reviewDecision: string | null
  mergeable: string
  author: { login: string } | null
  repository: { nameWithOwner: string; name: string }
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
}

function rollup(state: string | undefined): SearchedPr['ci'] {
  const s = (state ?? '').toUpperCase()
  if (s === 'SUCCESS') return 'success'
  if (s === 'FAILURE' || s === 'ERROR') return 'failure'
  if (s === 'PENDING' || s === 'EXPECTED') return 'pending'
  return 'none'
}

/** Open PRs matching a GitHub search (e.g. "author:@me"), with CI rollup and review state. Uses the gh login. */
export async function searchPrs(filter: string, owners: string[] = [], limit = 30): Promise<SearchedPr[]> {
  const q = ['is:pr', 'is:open', 'archived:false', filter, ...owners.map((o) => `user:${o}`)].join(' ')
  let out: string
  try {
    out = await gh(['api', 'graphql', '-f', `query=${SEARCH_QUERY}`, '-f', `q=${q}`, '-F', `n=${Math.min(Math.max(limit, 1), 50)}`], process.cwd())
  } catch (err) {
    throw new Error(`GitHub search failed: ${shortErr(err)}`)
  }
  const nodes = (JSON.parse(out) as { data?: { search?: { nodes?: RawSearchPr[] } } }).data?.search?.nodes ?? []
  return nodes
    .filter((n) => n && typeof n.number === 'number')
    .map((n) => ({
      repo: n.repository.nameWithOwner,
      repoName: n.repository.name,
      number: n.number,
      title: n.title,
      url: n.url,
      branch: n.headRefName,
      draft: n.isDraft,
      author: n.author?.login ?? '',
      updatedAt: n.updatedAt,
      additions: n.additions,
      deletions: n.deletions,
      reviewDecision: n.reviewDecision ?? '',
      mergeable: n.mergeable,
      ci: rollup(n.commits.nodes[0]?.commit.statusCheckRollup?.state)
    }))
}

/** The PR for one branch, light: number, url, state, CI rollup. Null when there is none. */
export async function prSummary(worktreePath: string, branch: string): Promise<{ number: number; url: string; state: string; ci: SearchedPr['ci'] } | null> {
  try {
    const raw = JSON.parse(await gh(['pr', 'view', branch, '--json', 'number,url,state,statusCheckRollup'], worktreePath)) as { number: number; url: string; state: string; statusCheckRollup?: RawRollup[] }
    const checks = (raw.statusCheckRollup ?? []).map(mapCheck)
    const ci: SearchedPr['ci'] = !checks.length ? 'none' : checks.some((c) => c.status === 'failure') ? 'failure' : checks.some((c) => c.status === 'pending') ? 'pending' : 'success'
    return { number: raw.number, url: raw.url, state: raw.state, ci }
  } catch {
    return null
  }
}

/** Merge a PR with gh. A refusal comes back as one plain sentence (PLAIN_ERROR_MARK) saying why and what to do. */
export async function mergePr(repo: string, number: number, method: 'squash' | 'merge' | 'rebase' = 'squash'): Promise<string> {
  try {
    const { stdout } = await exec(ghPath(), ['pr', 'merge', String(number), '--repo', repo, `--${method}`], { cwd: process.cwd(), env: ghEnv(), maxBuffer: 8 * 1024 * 1024, timeout: 90_000 })
    return stdout.trim() || `Merged ${repo}#${number}`
  } catch (err) {
    throw new Error(PLAIN_ERROR_MARK + mergeFailure(err, method))
  }
}

/** Why GitHub refused a merge, in words, with the next step. */
function mergeFailure(err: unknown, method: 'squash' | 'merge' | 'rebase'): string {
  const e = err as { code?: unknown; killed?: boolean }
  if (e?.code === 'ENOENT') return 'The merge did not happen: GitHub is not connected on this Mac. Connect GitHub, then try again.'
  if (e?.killed) return 'GitHub did not answer in time, so the merge may not have happened. Check the pull request on GitHub before trying again.'
  const m = shortErr(err)
  const other = method === 'squash' ? 'merge' : 'squash'
  if (/(squash|merge commits?|rebase)( merges?)? (are|is) not allowed|not allowed.*(squash|merge|rebase)|method.*not allowed/i.test(m)) return `This repository does not allow ${method === 'merge' ? 'merge commits' : `${method} merges`}. Ask Maestro to change the button to "${other}", or merge on GitHub.`
  if (/at least \d+ approving review|review required|approving review|changes requested|REVIEW_REQUIRED/i.test(m)) return 'GitHub branch protection needs an approving review first. Ask a reviewer to approve it, then merge.'
  if (/required status check|status checks? (are|is) (failing|expected|pending)|checks? (have|has) not passed/i.test(m)) return 'GitHub branch protection needs the required checks to pass first. Wait for them, or fix what is failing, then merge.'
  if (/base branch policy|protected branch|branch protection|merge queue/i.test(m)) return 'GitHub branch protection does not allow this merge yet. Open the pull request on GitHub to see what it is waiting for.'
  if (/must have (write|push|admin)|does not have (the correct )?permission|Resource not accessible|HTTP 403|not permitted|permission to merge/i.test(m)) return 'Your GitHub account cannot merge in this repository. Ask someone with write access to merge it.'
  if (/draft/i.test(m)) return 'This pull request is still a draft. Mark it ready for review on GitHub first.'
  if (/conflict|not mergeable|dirty/i.test(m)) return 'The pull request has conflicts with its base branch. Update the branch first, then merge.'
  if (/already (been )?merged|MERGED/i.test(m)) return 'This pull request was already merged.'
  if (/auth|HTTP 401|Bad credentials|gh auth login|not logged in/i.test(m)) return 'GitHub sign-in on this Mac has expired. Connect GitHub again, then merge.'
  if (/could not resolve|ENOTFOUND|timeout|network|connection/i.test(m)) return 'Sinfonie could not reach GitHub. Check your connection and try again.'
  return `GitHub did not merge it: ${m}`
}
