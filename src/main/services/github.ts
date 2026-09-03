import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PrCheck, PrInfo, RepoPr, ReviewThread } from '@shared/types'

const exec = promisify(execFile)

async function gh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('gh', args, { cwd, env: process.env, maxBuffer: 8 * 1024 * 1024 })
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
    return { ...base, error: `gh repo view failed: ${shortErr(err)}` }
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
    return { ...base, nameWithOwner, error: `gh pr view failed: ${msg}` }
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

function shortErr(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err && typeof (err as { stderr: unknown }).stderr === 'string') {
    const s = (err as { stderr: string }).stderr.trim()
    if (s) return s.split('\n').slice(0, 3).join(' ')
  }
  return err instanceof Error ? err.message.split('\n')[0] : String(err)
}
