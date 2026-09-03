import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { nanoid } from 'nanoid'
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ReviewFinding, ReviewPr, ReviewRun, ReviewVerdict } from '@shared/types'
import { getStore } from '../store'
import { accountEnv } from './accounts'
import { git } from './git'

const exec = promisify(execFile)
type Emit = (run: ReviewRun) => void

// ---------- persistence ----------

const runs = new Map<string, ReviewRun>()
const aborts = new Map<string, AbortController>()
let loaded = false

function file(): string {
  return join(app.getPath('userData'), 'reviews.json')
}
function load(): void {
  if (loaded) return
  loaded = true
  if (!existsSync(file())) return
  try {
    for (const r of JSON.parse(readFileSync(file(), 'utf8')) as ReviewRun[]) {
      // Anything that was mid-flight when the app died is over.
      if (r.status === 'running' || r.status === 'preparing') r.status = 'error', (r.error = 'Interrupted by app restart')
      runs.set(r.key, r)
    }
  } catch (err) {
    console.error('reviews.json unreadable', err)
  }
}
function save(): void {
  writeFileSync(file(), JSON.stringify(Array.from(runs.values())))
}
function update(key: string, patch: Partial<ReviewRun>, emit?: Emit): ReviewRun {
  const r = runs.get(key)
  if (!r) throw new Error(`No review ${key}`)
  Object.assign(r, patch)
  save()
  emit?.(r)
  return r
}

export function listRuns(): ReviewRun[] {
  load()
  return Array.from(runs.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

// ---------- GitHub listing ----------

async function gh(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec('gh', args, { cwd, env: process.env, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

export async function listOrgs(): Promise<string[]> {
  const [me, orgs] = await Promise.all([gh(['api', 'user', '--jq', '.login']), gh(['api', 'user/orgs', '--paginate', '--jq', '.[].login'])])
  return [me.trim(), ...orgs.split('\n').map((s) => s.trim()).filter(Boolean)]
}

/** Owners (user or org) of the origin remotes of a space's registered repos. */
export async function detectOwners(spaceId: string): Promise<string[]> {
  const repos = getStore().get().repos.filter((r) => (spaceId ? r.spaceId === spaceId : !r.spaceId))
  const owners = new Set<string>()
  for (const r of repos) {
    try {
      const url = await git(r.path).remote(['get-url', 'origin'])
      const norm = normalizeRemote(String(url ?? ''))
      const owner = norm.split('/')[0]
      if (owner) owners.add(owner)
    } catch {
      /* no origin */
    }
  }
  return Array.from(owners)
}

export async function listPrs(owners: string[], mode: 'requested' | 'all'): Promise<ReviewPr[]> {
  if (owners.length === 0) return []
  const args = ['search', 'prs', ...owners.flatMap((o) => ['--owner', o]), '--state', 'open', '--limit', '100', '--sort', 'updated', '--json', 'number,title,repository,author,updatedAt,url,isDraft']
  if (mode === 'requested') args.push('--review-requested', '@me')
  const raw = JSON.parse(await gh(args)) as { number: number; title: string; repository: { nameWithOwner: string }; author: { login: string }; updatedAt: string; url: string; isDraft: boolean }[]
  return raw.map((p) => ({ nameWithOwner: p.repository.nameWithOwner, number: p.number, title: p.title, author: p.author?.login ?? '', url: p.url, updatedAt: p.updatedAt, isDraft: p.isDraft }))
}

// ---------- checkout ----------

function reviewsRoot(): string {
  return join(homedir(), 'orchestra', 'reviews')
}

function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .toLowerCase()
}

/** A registered repo whose origin is this GitHub repo, if any: lets us use a worktree instead of a clone. */
async function findLocalRepo(nameWithOwner: string): Promise<string | null> {
  for (const r of getStore().get().repos) {
    try {
      const url = await git(r.path).remote(['get-url', 'origin'])
      if (url && normalizeRemote(String(url)) === nameWithOwner.toLowerCase()) return r.path
    } catch {
      /* no origin */
    }
  }
  return null
}

async function checkout(pr: ReviewPr, key: string, emit: Emit): Promise<{ dir: string; base: string; head: string }> {
  const [owner, repo] = pr.nameWithOwner.split('/')
  const dir = join(reviewsRoot(), `${owner}-${repo}-${pr.number}`)
  const meta = JSON.parse(await gh(['pr', 'view', String(pr.number), '--repo', pr.nameWithOwner, '--json', 'baseRefName,headRefName'])) as { baseRefName: string; headRefName: string }
  update(key, { phase: 'Fetching PR', baseRefName: meta.baseRefName, headRefName: meta.headRefName }, emit)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  mkdirSync(reviewsRoot(), { recursive: true })
  const local = await findLocalRepo(pr.nameWithOwner)
  if (local) {
    const g = git(local)
    await g.fetch(['origin', `pull/${pr.number}/head:refs/orchestra/pr-${pr.number}`, '--force'])
    await g.fetch(['origin', meta.baseRefName])
    await g.raw(['worktree', 'add', '--detach', dir, `refs/orchestra/pr-${pr.number}`])
  } else {
    update(key, { phase: 'Cloning repository (shallow)' }, emit)
    await gh(['repo', 'clone', pr.nameWithOwner, dir, '--', '--depth', '1', '--branch', meta.baseRefName])
    const g = git(dir)
    await g.fetch(['origin', `pull/${pr.number}/head`, '--depth', '200'])
    await g.fetch(['origin', meta.baseRefName, '--depth', '200'])
    await g.checkout(['--detach', 'FETCH_HEAD'])
    // FETCH_HEAD now points at the base fetch; re-fetch the head last so HEAD is the PR.
    await g.fetch(['origin', `pull/${pr.number}/head`, '--depth', '200'])
    await g.checkout(['--detach', 'FETCH_HEAD'])
  }
  return { dir, base: `origin/${meta.baseRefName}`, head: 'HEAD' }
}

async function cleanupCheckout(run: ReviewRun): Promise<void> {
  if (!run.checkoutPath || !existsSync(run.checkoutPath)) return
  const local = await findLocalRepo(run.pr.nameWithOwner)
  if (local) {
    try {
      await git(local).raw(['worktree', 'remove', '--force', run.checkoutPath])
    } catch {
      rmSync(run.checkoutPath, { recursive: true, force: true })
    }
    try {
      await git(local).raw(['worktree', 'prune'])
    } catch {
      /* ignore */
    }
  } else {
    rmSync(run.checkoutPath, { recursive: true, force: true })
  }
}

// ---------- the review itself ----------

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'verdict'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'line', 'severity', 'title', 'body'],
        properties: {
          path: { type: 'string', description: 'File path relative to the repository root' },
          line: { type: ['integer', 'null'], description: 'Line number on the NEW side of the diff the comment attaches to, or null for a file-level comment' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          title: { type: 'string', description: 'One short line' },
          body: { type: 'string', description: 'The review comment as it should be posted: what is wrong, why it matters, what to do. Markdown allowed.' },
          suggestion: { type: 'string', description: 'Optional replacement code for the commented lines, no fences' }
        }
      }
    },
    verdict: {
      type: 'object',
      additionalProperties: false,
      required: ['decision', 'summary'],
      properties: {
        decision: { type: 'string', enum: ['approve', 'request_changes', 'comment'] },
        summary: { type: 'string', description: 'The review body: 2-6 sentences on what the PR does, overall quality, and what must change before merge' }
      }
    }
  }
} as const

function prompt(pr: ReviewPr, base: string): string {
  return [
    `Review pull request #${pr.number} "${pr.title}" by ${pr.author} in ${pr.nameWithOwner}.`,
    `You are in a checkout of the PR head. The base is ${base}. Start with \`git diff ${base}...HEAD --stat\` and \`git diff ${base}...HEAD\`, then read whatever surrounding code you need to judge the change properly.`,
    ``,
    `Look for: correctness bugs, edge cases and error handling, security issues, data or migration risks, concurrency problems, API or contract breaks, missing or misleading tests, and clear maintainability problems. Do not comment on formatting or style the linter would catch. Do not restate the diff.`,
    ``,
    `Report each finding once, at the most relevant changed line; use the NEW-side line number from the diff, or null for file-level notes. Severity: critical blocks merge, major should be fixed before merge, minor is worth fixing, nit is optional. Write each body as the comment a careful senior reviewer would post: specific, direct, and with a concrete fix. Keep to the findings that matter; an empty list is a valid answer for a clean PR.`,
    ``,
    `Decision: request_changes if any critical or major finding exists, approve if the PR is mergeable as is, comment otherwise.`
  ].join('\n')
}

export async function startReview(pr: ReviewPr, accountId: string, emit: Emit): Promise<ReviewRun> {
  load()
  const key = `${pr.nameWithOwner}#${pr.number}`
  const existing = runs.get(key)
  if (existing && (existing.status === 'running' || existing.status === 'preparing')) return existing
  if (existing) await cleanupCheckout(existing)
  const run: ReviewRun = { key, pr, accountId, status: 'preparing', phase: 'Preparing checkout', findings: [], startedAt: new Date().toISOString() }
  runs.set(key, run)
  save()
  emit(run)
  void execute(run, emit)
  return run
}

async function execute(run: ReviewRun, emit: Emit): Promise<void> {
  const abort = new AbortController()
  aborts.set(run.key, abort)
  try {
    const { dir, base } = await checkout(run.pr, run.key, emit)
    update(run.key, { checkoutPath: dir, status: 'running', phase: 'Reading the diff' }, emit)
    const { settings } = getStore().get()
    const allowed = ['Read', 'Grep', 'Glob', 'LS', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git blame:*)', 'Bash(git status:*)']
    const options: Options = {
      cwd: dir,
      permissionMode: 'default',
      allowedTools: allowed,
      // Anything not on the allow list is refused: the review must not change the checkout.
      canUseTool: async (tool) => ({ behavior: 'deny', message: `${tool} is not available during a review; use Read, Grep, Glob and read-only git commands.` }),
      model: settings.model,
      maxTurns: 80,
      abortController: abort,
      settingSources: ['user'],
      outputFormat: { type: 'json_schema', schema: SCHEMA as unknown as Record<string, unknown> },
      env: { ...process.env, ...accountEnv(run.accountId) },
      stderr: (d) => console.error(`[review ${run.key}]`, d.trimEnd())
    }
    let structured: unknown
    let cost = 0
    let tools = 0
    for await (const msg of query({ prompt: prompt(run.pr, base), options }) as AsyncIterable<SDKMessage>) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            tools++
            const input = block.input as Record<string, unknown>
            const what = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : typeof input.pattern === 'string' ? input.pattern : ''
            update(run.key, { phase: `${block.name} ${what}`.slice(0, 120) }, emit)
          }
        }
      } else if (msg.type === 'result') {
        cost = msg.total_cost_usd
        if (msg.subtype === 'success') structured = msg.structured_output
        else throw new Error(`Review ended with ${msg.subtype}${'errors' in msg && Array.isArray(msg.errors) ? `: ${(msg.errors as string[]).join('; ')}` : ''}`)
      }
    }
    const parsed = (structured ?? {}) as { findings?: Omit<ReviewFinding, 'id' | 'approved'>[]; verdict?: ReviewVerdict }
    const findings: ReviewFinding[] = (parsed.findings ?? []).map((f) => ({ ...f, id: nanoid(6), approved: false }))
    update(run.key, { status: 'done', phase: `${tools} tool calls`, findings, verdict: parsed.verdict, costUsd: cost, finishedAt: new Date().toISOString() }, emit)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    update(run.key, { status: abort.signal.aborted ? 'cancelled' : 'error', error: abort.signal.aborted ? undefined : message, finishedAt: new Date().toISOString() }, emit)
  } finally {
    aborts.delete(run.key)
  }
}

export function cancelReview(key: string): void {
  aborts.get(key)?.abort()
}

export async function discardReview(key: string): Promise<void> {
  load()
  const run = runs.get(key)
  if (!run) return
  aborts.get(key)?.abort()
  await cleanupCheckout(run)
  runs.delete(key)
  save()
}

export function updateFinding(key: string, findingId: string, patch: Partial<ReviewFinding>, emit: Emit): ReviewRun {
  load()
  const run = runs.get(key)
  if (!run) throw new Error(`No review ${key}`)
  return update(key, { findings: run.findings.map((f) => (f.id === findingId ? { ...f, ...patch, id: f.id } : f)) }, emit)
}

export function setAllFindings(key: string, approved: boolean, emit: Emit): ReviewRun {
  load()
  const run = runs.get(key)
  if (!run) throw new Error(`No review ${key}`)
  return update(key, { findings: run.findings.map((f) => ({ ...f, approved })) }, emit)
}

export function setVerdict(key: string, verdict: ReviewVerdict, emit: Emit): ReviewRun {
  load()
  return update(key, { verdict }, emit)
}

const EVENT: Record<ReviewVerdict['decision'], string> = { approve: 'APPROVE', request_changes: 'REQUEST_CHANGES', comment: 'COMMENT' }

function formatComment(f: ReviewFinding): string {
  const head = `**${f.severity}** · ${f.title}`
  const sugg = f.suggestion ? `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\`` : ''
  return `${head}\n\n${f.body}${sugg}`
}

/** Posts one GitHub review: the verdict as body, approved findings as inline comments. */
export async function submitReview(key: string, emit: Emit): Promise<ReviewRun> {
  load()
  const run = runs.get(key)
  if (!run) throw new Error(`No review ${key}`)
  if (!run.verdict) throw new Error('Set a verdict first')
  const approved = run.findings.filter((f) => f.approved)
  const inline = approved.filter((f) => f.line != null)
  const fileLevel = approved.filter((f) => f.line == null)
  const bodyParts = [run.verdict.summary.trim()]
  if (fileLevel.length) bodyParts.push(fileLevel.map((f) => `- \`${f.path}\`: ${formatComment(f).replace(/\n+/g, ' ')}`).join('\n'))
  // gh api with --input reads stdin; execFile has no stdin helper, so shell out via a temp file.
  const tmp = join(app.getPath('temp'), `orchestra-review-${nanoid(6)}.json`)
  const send = async (comments: ReviewFinding[], extraBody: string): Promise<string> => {
    const payload = {
      event: EVENT[run.verdict!.decision],
      body: [...bodyParts, extraBody].filter(Boolean).join('\n\n'),
      comments: comments.map((f) => ({ path: f.path, line: f.line, side: 'RIGHT', body: formatComment(f) }))
    }
    writeFileSync(tmp, JSON.stringify(payload))
    try {
      const { stdout } = await exec('gh', ['api', '-X', 'POST', `repos/${run.pr.nameWithOwner}/pulls/${run.pr.number}/reviews`, '--input', tmp], { env: process.env, maxBuffer: 4 * 1024 * 1024 })
      const j = JSON.parse(stdout) as { html_url?: string }
      return j.html_url ?? run.pr.url
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string }
      throw new Error((err.stderr || err.stdout || '').trim().split('\n').slice(0, 3).join(' ') || 'gh api failed')
    }
  }
  let url: string
  try {
    url = await send(inline, '')
  } catch (err) {
    // GitHub rejects inline comments whose line is not part of the diff. Fall back to listing them in the body.
    const msg = err instanceof Error ? err.message : String(err)
    if (!/line|diff|position|Unprocessable|422/i.test(msg) || inline.length === 0) throw err
    const asText = inline.map((f) => `- \`${f.path}:${f.line}\`: ${formatComment(f).replace(/\n+/g, ' ')}`).join('\n')
    url = await send([], `Inline placement failed for these, so they are listed here:\n${asText}`)
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
  }
  const out = update(key, { status: 'submitted', submittedUrl: url }, emit)
  await cleanupCheckout(out)
  return update(key, { checkoutPath: undefined }, emit)
}
