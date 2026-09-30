/**
 * The review inbox's small backend (redesign phase 5): a pre-read and a risk level for every change, the local
 * "changes requested" marks, and the GitHub fallbacks for notes, approvals and taking a pull request over.
 *
 * Nothing here asks a model. The summary is the AI review's verdict when one exists, else the PR description,
 * else a sentence built from the diff; the risk is always a rule-based score with its reasons, labelled as such.
 */
import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import type { ChangedFileStat, ReviewPr, ReviewRun, Workspace } from '@shared/types'
import type { InboxMark, PreRead, RiskLevel } from '@shared/inbox'
import { getStore } from '../store'
import * as gitSvc from './git'
import * as workspaces from './workspaces'
import { listRuns } from './reviews'
import { remoteOf } from './shared-space'

const exec = promisify(execFile)
async function gh(args: string[]): Promise<string> {
  const { stdout } = await exec('gh', args, { env: process.env, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

// ---------- persistence ----------

/** The raw facts about a change; the pre-read is recomputed from them, so a newer AI review shows at once. */
interface Facts {
  updatedAt: string
  fetchedAt: string
  body: string
  files: { path: string; additions: number; deletions: number }[]
  additions: number
  deletions: number
  changedFiles: number
  checks: PreRead['checks']
  headRefName?: string
  baseRefName?: string
  isFork?: boolean
  headSha?: string
}
interface Data {
  facts: Record<string, Facts>
  marks: Record<string, InboxMark>
}
let data: Data | null = null
const file = (): string => join(app.getPath('userData'), 'inbox.json')
function load(): Data {
  if (data) return data
  data = { facts: {}, marks: {} }
  if (existsSync(file())) {
    try {
      const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Data>
      data = { facts: raw.facts ?? {}, marks: raw.marks ?? {} }
    } catch (err) {
      console.error('inbox.json unreadable', err)
    }
  }
  return data
}
let saveTimer: NodeJS.Timeout | null = null
/** Written off the main thread, at most once a second. */
function save(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const d = load()
    // Keep the cache bounded: the 400 most recently fetched changes, and marks from the last 60 days.
    const keys = Object.keys(d.facts)
    if (keys.length > 400) {
      for (const k of keys.sort((a, b) => d.facts[a].fetchedAt.localeCompare(d.facts[b].fetchedAt)).slice(0, keys.length - 400)) delete d.facts[k]
    }
    const cutoff = Date.now() - 60 * 86_400_000
    for (const [k, m] of Object.entries(d.marks)) if (Date.parse(m.at) < cutoff) delete d.marks[k]
    writeFile(file(), JSON.stringify(d)).catch((err) => console.error('inbox.json not saved', err))
  }, 1000)
}

const keyOfPr = (pr: ReviewPr): string => `${pr.nameWithOwner}#${pr.number}`

// ---------- the rules ----------

const TEST = /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/i
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|rs|php|cs|swift|scala|ex|exs)$/i
const QUIET = /\.(css|scss|sass|less|md|mdx|txt|png|jpe?g|gif|svg|webp|ico|woff2?)$/i
const RULES: { re: RegExp; reason: string; points: number }[] = [
  { re: /(^|[/_.-])(payments?|billing|stripe|checkout|invoic|refund|subscription|charges?[/_.-])/i, reason: 'Touches payments or billing', points: 2 },
  { re: /(^|[/_.-])(auth(?!or)|oauth|login|logout|sessions?[/_.-]|passwords?|permissions?|rbac|acl[/_.-]|jwt|sso[/_.-]|credentials?)/i, reason: 'Touches sign-in or permissions', points: 2 },
  { re: /(^|\/)(migrations?|migrate|alembic)\/|(^|\/)schema\.(sql|prisma|rb)$|\.sql$/i, reason: 'Includes a database migration or schema change', points: 2 },
  { re: /(^|\/)\.env|(^|\/)secrets?\//i, reason: 'Touches environment or secret configuration', points: 2 },
  { re: /(^|\/)(\.github\/workflows|terraform|infra|deploy|k8s|helm)\/|Dockerfile|docker-compose|\.tf$/i, reason: 'Changes build or deploy setup', points: 1 },
  { re: /(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|go\.mod|go\.sum|requirements\.txt|Gemfile(\.lock)?|Cargo\.(toml|lock)|poetry\.lock|pyproject\.toml)$/, reason: 'Changes dependencies', points: 1 }
]

function score(f: Omit<Facts, 'updatedAt' | 'fetchedAt'>, run?: ReviewRun): { risk: RiskLevel; reasons: string[] } {
  const reasons: { text: string; points: number }[] = []
  const paths = f.files.map((x) => x.path)
  if (f.checks.failed > 0) reasons.push({ text: `${f.checks.failed} check${f.checks.failed === 1 ? '' : 's'} failing (${f.checks.failedNames.slice(0, 3).join(', ')})`, points: 3 })
  const done = run && (run.status === 'done' || run.status === 'submitted')
  if (done) {
    const open = run.findings.filter((x) => !x.addressedRound)
    const crit = open.filter((x) => x.severity === 'critical').length
    const major = open.filter((x) => x.severity === 'major').length
    if (crit) reasons.push({ text: `AI review found ${crit} critical issue${crit === 1 ? '' : 's'}`, points: 3 })
    if (major) reasons.push({ text: `AI review found ${major} major issue${major === 1 ? '' : 's'}`, points: 1 })
  }
  for (const rule of RULES) {
    const hits = paths.filter((p) => rule.re.test(p))
    if (hits.length) reasons.push({ text: `${rule.reason} (${hits.slice(0, 2).join(', ')}${hits.length > 2 ? ` and ${hits.length - 2} more` : ''})`, points: rule.points })
  }
  const lines = f.additions + f.deletions
  const files = Math.max(f.changedFiles, f.files.length)
  if (lines >= 600 || files >= 25) reasons.push({ text: `Large change: ${files} files, +${f.additions} −${f.deletions}`, points: 2 })
  else if (lines >= 200 || files >= 10) reasons.push({ text: `Medium-sized change: ${files} files, +${f.additions} −${f.deletions}`, points: 1 })
  const code = f.files.filter((x) => CODE.test(x.path) && !TEST.test(x.path))
  const codeAdds = code.reduce((n, x) => n + x.additions, 0)
  if (code.length && codeAdds >= 40 && !paths.some((p) => TEST.test(p))) reasons.push({ text: 'Changes code without changing any tests', points: 1 })
  const total = reasons.reduce((n, r) => n + r.points, 0)
  const risk: RiskLevel = total >= 4 ? 'high' : total >= 2 ? 'medium' : 'low'
  const out = reasons.sort((a, b) => b.points - a.points).map((r) => r.text)
  if (out.length === 0) {
    if (paths.length && paths.every((p) => QUIET.test(p))) out.push('Only text, styling or images changed; no code, data or payments touched')
    else out.push('Small change; nothing sensitive touched and no checks failing')
  }
  // gh reports at most 100 files; say so rather than pretend the rest were read.
  if (f.changedFiles > f.files.length) out.push(`Only the first ${f.files.length} of ${f.changedFiles} files were checked for sensitive paths`)
  if (f.checks.pending > 0 && f.checks.failed === 0) out.push(`${f.checks.pending} check${f.checks.pending === 1 ? '' : 's'} still running`)
  if (done && run.verdict?.decision === 'approve' && risk === 'low') out.push('The AI review suggests approving')
  return { risk, reasons: out }
}

/** Top-level areas a change touches, in words: "api (payments, webhooks)". */
function areas(paths: string[]): string {
  const counts = new Map<string, number>()
  for (const p of paths) {
    const parts = p.split('/')
    const area = parts.length > 2 && /^(src|app|lib|packages|apps|services)$/.test(parts[0]) ? `${parts[0]}/${parts[1]}` : parts.length > 1 ? parts[0] : 'the top folder'
    counts.set(area, (counts.get(area) ?? 0) + 1)
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a)
  return top.length ? top.join(', ') + (counts.size > 3 ? ` and ${counts.size - 3} more place${counts.size - 3 === 1 ? '' : 's'}` : '') : ''
}

/** The PR description's first real paragraph, without templates, comments or Sinfonie's own footer. */
function describe(body: string): string {
  const clean = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\n-{3,}\n/)[0]
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#+\s.*$/gm, '').replace(/^\s*[-*]\s*\[[ x]\]\s*/gim, '').trim())
    .find((p) => p.length >= 20)
  if (!clean) return ''
  return clean.length > 360 ? `${clean.slice(0, 357).trimEnd()}…` : clean
}

function toPreRead(key: string, f: Omit<Facts, 'updatedAt' | 'fetchedAt'> & { fetchedAt: string }, run?: ReviewRun): PreRead {
  const { risk, reasons } = score(f, run)
  const verdict = run && (run.status === 'done' || run.status === 'submitted') ? run.verdict?.summary?.trim() : ''
  const desc = describe(f.body)
  const files = Math.max(f.changedFiles, f.files.length)
  const where = areas(f.files.map((x) => x.path))
  const summary = verdict
    ? verdict.length > 480 ? `${verdict.slice(0, 477).trimEnd()}…` : verdict
    : desc || `Changes ${files} file${files === 1 ? '' : 's'}${where ? ` in ${where}` : ''}: ${f.additions} line${f.additions === 1 ? '' : 's'} added, ${f.deletions} removed.`
  return {
    key,
    summary,
    summarySource: verdict ? 'ai-review' : desc ? 'description' : 'heuristic',
    risk,
    reasons,
    riskSource: 'heuristic',
    files,
    additions: f.additions,
    deletions: f.deletions,
    paths: f.files.slice(0, 200).map((x) => x.path),
    checks: f.checks,
    headRefName: f.headRefName,
    baseRefName: f.baseRefName,
    isFork: f.isFork,
    headSha: f.headSha,
    computedAt: f.fetchedAt
  }
}

// ---------- pull requests ----------

type Rollup = { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string }
function tallyChecks(rollup: Rollup[] | null | undefined): PreRead['checks'] {
  const c = { passed: 0, failed: 0, pending: 0, failedNames: [] as string[] }
  for (const r of rollup ?? []) {
    const name = r.name || r.context || 'check'
    const state = (r.conclusion || r.state || r.status || '').toUpperCase()
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state)) c.passed++
    else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(state)) {
      c.failed++
      c.failedNames.push(name)
    } else c.pending++
  }
  return c
}

async function fetchPrFacts(pr: ReviewPr): Promise<Facts> {
  const raw = JSON.parse(
    await gh(['pr', 'view', String(pr.number), '--repo', pr.nameWithOwner, '--json', 'body,files,additions,deletions,changedFiles,statusCheckRollup,headRefName,headRefOid,baseRefName,isCrossRepository,updatedAt'])
  ) as { body?: string; files?: { path: string; additions: number; deletions: number }[]; additions: number; deletions: number; changedFiles: number; statusCheckRollup?: Rollup[]; headRefName: string; headRefOid?: string; baseRefName: string; isCrossRepository?: boolean; updatedAt?: string }
  return {
    updatedAt: pr.updatedAt,
    fetchedAt: new Date().toISOString(),
    body: (raw.body ?? '').slice(0, 4000),
    files: (raw.files ?? []).map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? raw.files?.length ?? 0,
    checks: tallyChecks(raw.statusCheckRollup),
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    isFork: Boolean(raw.isCrossRepository),
    headSha: raw.headRefOid
  }
}

/** Cached per PR and its last update; pending checks refresh after two minutes. */
export async function prereadPr(pr: ReviewPr, force = false): Promise<PreRead> {
  const d = load()
  const key = keyOfPr(pr)
  let f = d.facts[key]
  const stale = !f || f.updatedAt !== pr.updatedAt || (f.checks.pending > 0 && Date.now() - Date.parse(f.fetchedAt) > 120_000)
  if (force || stale) {
    f = await fetchPrFacts(pr)
    d.facts[key] = f
    save()
  }
  return toPreRead(key, f, listRuns().find((r) => r.key === key))
}

// ---------- local workspaces without a pull request ----------

const wsCache = new Map<string, { at: number; pre: PreRead }>()
export async function prereadWorkspace(workspaceId: string, force = false): Promise<PreRead> {
  const hit = wsCache.get(workspaceId)
  if (!force && hit && Date.now() - hit.at < 60_000) return hit.pre
  const ws = workspaces.getWorkspace(workspaceId)
  const files: Facts['files'] = []
  const heads: string[] = []
  for (const wr of ws.repos) {
    try {
      heads.push((await gitSvc.git(wr.worktreePath).revparse(['HEAD'])).trim())
      const res = await gitSvc.changes(wr.worktreePath, 'branch', wr.baseBranch)
      const prefix = ws.repos.length > 1 ? `${wr.repoName}/` : ''
      for (const x of res.files as ChangedFileStat[]) files.push({ path: prefix + x.path, additions: x.adds ?? 0, deletions: x.dels ?? 0 })
    } catch {
      /* worktree missing: nothing to count */
    }
  }
  const pre = toPreRead(`ws:${workspaceId}`, {
    fetchedAt: new Date().toISOString(),
    body: '',
    files,
    additions: files.reduce((n, x) => n + x.additions, 0),
    deletions: files.reduce((n, x) => n + x.deletions, 0),
    changedFiles: files.length,
    checks: { passed: 0, failed: 0, pending: 0, failedNames: [] },
    headRefName: ws.repos[0]?.branch,
    baseRefName: ws.repos[0]?.baseBranch,
    headSha: heads.join(',') || undefined
  })
  wsCache.set(workspaceId, { at: Date.now(), pre })
  return pre
}

// ---------- marks ----------

export function marks(): Record<string, InboxMark> {
  return load().marks
}
export function setMark(key: string, mark: InboxMark | null): Record<string, InboxMark> {
  const d = load()
  if (mark) d.marks[key] = mark
  else delete d.marks[key]
  save()
  return d.marks
}

// ---------- GitHub fallbacks ----------

const ghError = (err: unknown): string => {
  const e = err as { stderr?: string; message?: string }
  return (e.stderr || e.message || String(err)).trim().split('\n').slice(0, 3).join(' ')
}

/** A note on an external PR: a GitHub review asking for changes, or a comment on your own PR (GitHub refuses the former). */
export async function noteBackPr(pr: ReviewPr, text: string): Promise<InboxMark> {
  try {
    await gh(['pr', 'review', String(pr.number), '--repo', pr.nameWithOwner, '--request-changes', '--body', text])
  } catch (err) {
    const msg = ghError(err)
    if (!/own pull request/i.test(msg)) throw new Error(msg)
    try {
      await gh(['pr', 'review', String(pr.number), '--repo', pr.nameWithOwner, '--comment', '--body', text])
    } catch (e2) {
      throw new Error(ghError(e2))
    }
  }
  const mark: InboxMark = { state: 'changes-requested', note: text, at: new Date().toISOString(), via: 'github', url: pr.url, headSha: load().facts[keyOfPr(pr)]?.headSha }
  setMark(keyOfPr(pr), mark)
  return mark
}

/**
 * Approve exactly the commit the reviewer read: refuse when the PR moved on since, and pin the review to that
 * commit (the REST API's commit_id; `gh pr review` has no such option).
 */
export async function approvePr(pr: ReviewPr, expectedHead: string): Promise<void> {
  let head = ''
  try {
    head = (JSON.parse(await gh(['pr', 'view', String(pr.number), '--repo', pr.nameWithOwner, '--json', 'headRefOid'])) as { headRefOid?: string }).headRefOid ?? ''
  } catch (err) {
    throw new Error(ghError(err))
  }
  if (!expectedHead || head !== expectedHead) throw new Error('This change got new commits since you read it. Read the pre-read again, then approve.')
  try {
    await gh(['api', '-X', 'POST', `repos/${pr.nameWithOwner}/pulls/${pr.number}/reviews`, '-f', 'event=APPROVE', '-f', `commit_id=${head}`])
  } catch (err) {
    throw new Error(ghError(err))
  }
  setMark(keyOfPr(pr), { state: 'approved', note: '', at: new Date().toISOString(), via: 'github', url: pr.url, headSha: head })
}

/** Local repositories as "owner/name" of their origin, so the inbox matches PRs by repository, not folder name. */
export async function repoRemotes(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    getStore()
      .get()
      .repos.map(async (r) => {
        const remote = await remoteOf(r.path)
        if (remote) out[r.id] = ownerName(remote)
      })
  )
  return out
}

const ownerName = (remote: string): string =>
  remote
    .trim()
    .replace(/^git@[^:]+:/, '')
    .replace(/^(ssh|https?|git):\/\/(?:[^@]+@)?[^/]+\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()

/**
 * Take a PR over: the workspace already on its branch, else a new one on the PR branch, in the space of the
 * matching repository. The branch must come from GitHub as it is now: the PR head is fetched first, an existing
 * local branch is fast-forwarded to it, and anything else (no such branch, local commits GitHub has not got) is
 * refused in plain words rather than opening a workspace without the PR's commits.
 */
export async function takeOverPr(pr: ReviewPr, emit: Parameters<typeof workspaces.createWorkspace>[1]): Promise<Workspace> {
  const pre = await prereadPr(pr, true)
  const branch = pre.headRefName
  if (!branch) throw new Error('GitHub did not say which branch this pull request is on.')
  if (pre.isFork) throw new Error(`This pull request comes from a fork, so its branch is not in ${pr.nameWithOwner}. Check it out by hand, or ask the author to push to the repository.`)
  const store = getStore().get()
  const remotes = await repoRemotes()
  const repo = store.repos.find((r) => remotes[r.id] === pr.nameWithOwner.toLowerCase())
  if (!repo) throw new Error(`${pr.nameWithOwner} is not on this Mac yet. Add the repository in Settings, then take the change over again.`)
  const g = gitSvc.git(repo.path)
  try {
    await g.fetch(['origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
  } catch (err) {
    throw new Error(`Could not fetch ${branch} from GitHub, so the workspace would miss the pull request's commits. Check your connection and try again. (${ghError(err)})`)
  }
  const remoteHead = (await g.revparse([`origin/${branch}`])).trim()
  const existing = store.workspaces.find((w) => w.status !== 'archived' && w.repos.some((wr) => wr.repoId === repo.id && wr.branch === branch))
  if (existing) {
    // Bring its checkout up to the PR head when that is a plain fast-forward; otherwise leave the person's work alone.
    const wr = existing.repos.find((x) => x.repoId === repo.id)!
    try {
      await gitSvc.git(wr.worktreePath).raw(['merge', '--ff-only', `origin/${branch}`])
    } catch {
      /* local edits or local commits: the workspace opens as it is */
    }
    return existing
  }
  const local = (await g.branchLocal()).all.includes(branch)
  if (local) {
    const localHead = (await g.revparse([branch])).trim()
    if (localHead !== remoteHead) {
      const isAncestor = await g
        .raw(['merge-base', '--is-ancestor', localHead, remoteHead])
        .then(() => true)
        .catch(() => false)
      if (!isAncestor) throw new Error(`This Mac has its own commits on ${branch} that are not in the pull request. Open or clean up that branch first, then take the change over.`)
      await g.raw(['branch', '-f', branch, remoteHead])
    }
  } else {
    await g.raw(['branch', '--track', branch, `origin/${branch}`])
  }
  const space = store.spaces.find((s) => s.id === repo.spaceId)
  return workspaces.createWorkspace(
    {
      name: pr.title.slice(0, 60),
      branch,
      repos: [{ repoId: repo.id, baseBranch: pre.baseRefName || repo.defaultBranch }],
      primaryRepoId: repo.id,
      ...(repo.spaceId ? { spaceId: repo.spaceId } : {}),
      ...(space?.claudeAccountId || store.settings.defaultClaudeAccountId ? { claudeAccountId: space?.claudeAccountId ?? store.settings.defaultClaudeAccountId } : {})
    },
    emit
  )
}
