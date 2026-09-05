import { claudeExecutableOption } from './claude-cli'
import * as usage from './usage'
import { costModeFor, leanModel, LEAN } from './cost-mode'
import { app, BrowserWindow, Notification } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { nanoid } from 'nanoid'
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { FixRound, ReviewFinding, ReviewPr, ReviewRun, ReviewVerdict } from '@shared/types'
import { readFileSync as readText } from 'fs'
import { getStore } from '../store'
import { accountEnv } from './accounts'
import { git } from './git'
import { isReadOnlyCommand } from './readonly'

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
      if (r.status === 'running' || r.status === 'preparing' || r.status === 'fixing') r.status = 'error', (r.error = 'Interrupted by app restart')
      if (r.iteration?.status === 'running') r.iteration = { ...r.iteration, status: 'error', error: 'Interrupted by app restart', finishedAt: new Date().toISOString() }
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

/** The GitHub repositories behind a space's registered repos, as owner/name. */
export async function detectRepos(spaceId: string): Promise<string[]> {
  const repos = getStore().get().repos.filter((r) => (spaceId ? r.spaceId === spaceId : !r.spaceId))
  const out = new Set<string>()
  for (const r of repos) {
    try {
      const url = await git(r.path).remote(['get-url', 'origin'])
      const norm = normalizeRemote(String(url ?? ''))
      if (/^[^/]+\/[^/]+$/.test(norm) && /github\.com/.test(String(url))) out.add(norm)
    } catch {
      /* no origin */
    }
  }
  return Array.from(out).sort()
}

type RawPr = { number: number; title: string; repository: { nameWithOwner: string }; author: { login: string }; updatedAt: string; url: string; isDraft: boolean }
async function searchPrs(scope: string[], mode: 'requested' | 'all'): Promise<ReviewPr[]> {
  const args = ['search', 'prs', ...scope, '--state', 'open', '--limit', '100', '--sort', 'updated', '--json', 'number,title,repository,author,updatedAt,url,isDraft']
  if (mode === 'requested') args.push('--review-requested', '@me')
  const raw = JSON.parse(await gh(args)) as RawPr[]
  return raw.map((p) => ({ nameWithOwner: p.repository.nameWithOwner, number: p.number, title: p.title, author: p.author?.login ?? '', url: p.url, updatedAt: p.updatedAt, isDraft: p.isDraft }))
}
/** Open PRs in the space's repositories, plus whole owners when the space configured some. */
export async function listPrs(owners: string[], mode: 'requested' | 'all', repos: string[] = []): Promise<ReviewPr[]> {
  const jobs: Promise<ReviewPr[]>[] = []
  // gh accepts many --repo flags, but very long argument lists get slow; batch them.
  for (let i = 0; i < repos.length; i += 20) jobs.push(searchPrs(repos.slice(i, i + 20).flatMap((r) => ['--repo', r]), mode))
  if (owners.length) jobs.push(searchPrs(owners.flatMap((o) => ['--owner', o]), mode))
  if (jobs.length === 0) return []
  const seen = new Set<string>()
  const out: ReviewPr[] = []
  for (const list of await Promise.all(jobs)) {
    for (const p of list) {
      const k = `${p.nameWithOwner}#${p.number}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(p)
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// ---------- checkout ----------

function reviewsRoot(): string {
  return join(homedir(), 'sinfonie', 'reviews')
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
  const meta = JSON.parse(await gh(['pr', 'view', String(pr.number), '--repo', pr.nameWithOwner, '--json', 'baseRefName,headRefName,isCrossRepository,headRepositoryOwner,headRepository'])) as { baseRefName: string; headRefName: string; isCrossRepository?: boolean; headRepositoryOwner?: { login: string }; headRepository?: { name: string } }
  const headRepo = meta.headRepositoryOwner && meta.headRepository ? `${meta.headRepositoryOwner.login}/${meta.headRepository.name}` : pr.nameWithOwner
  update(key, { phase: 'Fetching PR', baseRefName: meta.baseRefName, headRefName: meta.headRefName, headRepo, isFork: Boolean(meta.isCrossRepository) }, emit)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  mkdirSync(reviewsRoot(), { recursive: true })
  const local = await findLocalRepo(pr.nameWithOwner)
  if (local) {
    const g = git(local)
    await g.fetch(['origin', `pull/${pr.number}/head:refs/sinfonie/pr-${pr.number}`, '--force'])
    await g.fetch(['origin', meta.baseRefName])
    await g.raw(['worktree', 'add', '--detach', dir, `refs/sinfonie/pr-${pr.number}`])
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

function prompt(pr: ReviewPr, base: string, lean = false): string {
  return [
    ...(lean ? ['Lean mode: the user is on a tight token budget. Review the diff itself; open files outside the diff only when a finding depends on them, and read small ranges. No exploratory reads, no repository tour.'] : []),
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

function notify(title: string, body: string, key: string): void {
  if (!Notification.isSupported()) return
  const win = BrowserWindow.getAllWindows()[0]
  const n = new Notification({ title, body: body.slice(0, 180) })
  n.on('click', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('ui:openReview', { key })
    }
  })
  n.show()
}

/** The lines a finding points at, so the cockpit can show the code without opening GitHub. */
function snippetFor(dir: string, f: { path: string; line: number | null }): ReviewFinding['snippet'] {
  if (f.line == null) return undefined
  try {
    const lines = readText(join(dir, f.path), 'utf8').split('\n')
    const start = Math.max(1, f.line - 6)
    const end = Math.min(lines.length, f.line + 6)
    return { start, lines: lines.slice(start - 1, end) }
  } catch {
    return undefined
  }
}

async function execute(run: ReviewRun, emit: Emit): Promise<void> {
  const abort = new AbortController()
  aborts.set(run.key, abort)
  try {
    const { dir, base } = await checkout(run.pr, run.key, emit)
    update(run.key, { checkoutPath: dir, status: 'running', phase: 'Reading the diff' }, emit)
    const { settings } = getStore().get()
    const allowed = ['Read', 'Grep', 'Glob', 'LS']
    const options: Options = {
    ...claudeExecutableOption(),
      cwd: dir,
      permissionMode: 'default',
      allowedTools: allowed,
      // Shell commands are checked for being read-only; anything else is refused so the review cannot change the checkout.
      canUseTool: async (tool, input) => {
        if (tool === 'Bash' && typeof (input as { command?: unknown }).command === 'string' && isReadOnlyCommand((input as { command: string }).command)) {
          return { behavior: 'allow', updatedInput: input }
        }
        return { behavior: 'deny', message: `${tool} is not available during a review${tool === 'Bash' ? ' unless the command is read-only (git diff/log/show/blame/fetch, grep, head, cat…)' : ''}; use Read, Grep, Glob and read-only git commands.` }
      },
      model: costModeFor() !== 'standard' ? leanModel(settings.model) : settings.model,
      maxTurns: costModeFor() === 'lean' ? LEAN.reviewTurns : 80,
      abortController: abort,
      settingSources: ['user'],
      outputFormat: { type: 'json_schema', schema: SCHEMA as unknown as Record<string, unknown> },
      env: { ...process.env, ...accountEnv(run.accountId) },
      stderr: (d) => console.error(`[review ${run.key}]`, d.trimEnd())
    }
    let structured: unknown
    let cost = 0
    let tools = 0
    for await (const msg of query({ prompt: prompt(run.pr, base, costModeFor() === 'lean'), options }) as AsyncIterable<SDKMessage>) {
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
        try {
          usage.recordTurn(usage.fromResult(msg, { workspaceId: '', spaceId: '', accountId: run.accountId, kind: 'review' }))
        } catch {
          /* ledger must never break the review */
        }
        if (msg.subtype === 'success') structured = msg.structured_output
        else throw new Error(`Review ended with ${msg.subtype}${'errors' in msg && Array.isArray(msg.errors) ? `: ${(msg.errors as string[]).join('; ')}` : ''}`)
      }
    }
    const parsed = (structured ?? {}) as { findings?: Omit<ReviewFinding, 'id' | 'approved'>[]; verdict?: ReviewVerdict }
    const findings: ReviewFinding[] = (parsed.findings ?? []).map((f) => ({ ...f, id: nanoid(6), approved: false, snippet: snippetFor(dir, f) }))
    const before = runs.get(run.key)
    update(run.key, { status: 'done', phase: `${tools} tool calls`, findings, verdict: parsed.verdict, costUsd: (before?.costUsd ?? 0) + cost, passes: (before?.passes ?? 0) + 1, finishedAt: new Date().toISOString() }, emit)
    if (!run.iteration || run.iteration.status !== 'running') {
      const crit = findings.filter((f) => f.severity === 'critical' || f.severity === 'major').length
      notify(`Review ready: ${run.pr.title}`, `${findings.length} finding${findings.length === 1 ? '' : 's'}${crit ? `, ${crit} to fix before merge` : ''}. Verdict: ${parsed.verdict?.decision?.replace('_', ' ') ?? 'none'}.`, run.key)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    update(run.key, { status: abort.signal.aborted ? 'cancelled' : 'error', error: abort.signal.aborted ? undefined : message, finishedAt: new Date().toISOString() }, emit)
    if (!abort.signal.aborted && run.iteration?.status !== 'running') notify(`Review failed: ${run.pr.title}`, message, run.key)
  } finally {
    aborts.delete(run.key)
  }
}

// ---------- fixing and iterating ----------

const fixAborts = new Map<string, AbortController>()
const iterationStops = new Set<string>()

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'addressed', 'commitMessage'],
  properties: {
    summary: { type: 'string', description: 'What was changed, 2-5 sentences, for the PR author and the reviewer.' },
    addressed: { type: 'array', items: { type: 'string' }, description: 'Ids of the findings that were actually fixed.' },
    skipped: { type: 'array', items: { type: 'object', required: ['id', 'why'], properties: { id: { type: 'string' }, why: { type: 'string' } } } },
    commitMessage: { type: 'string', description: 'Conventional commit subject plus an optional body.' }
  }
}
const DESTRUCTIVE = /\bgit\s+(push|reset\s+--hard|checkout\s+--\s|clean\s+-f|rebase|branch\s+-D)|\brm\s+-rf\b|\bgit\s+commit\b/

/** Make the fixes for a set of findings in the PR checkout, commit them, and push to the PR branch. */
export async function fixFindings(key: string, ids: string[] | 'all', emit: Emit, roundNo?: number): Promise<ReviewRun> {
  load()
  let run = runs.get(key)
  if (!run) throw new Error(`No review ${key}`)
  if (run.status === 'running' || run.status === 'preparing' || run.status === 'fixing') throw new Error('The review is still busy')
  if (run.isFork) throw new Error(`This PR comes from a fork (${run.headRepo}); Sinfonie can only push to branches of ${run.pr.nameWithOwner}.`)
  const targets = run.findings.filter((f) => (ids === 'all' ? f.severity !== 'nit' && !f.addressedRound : ids.includes(f.id)))
  if (targets.length === 0) throw new Error('Nothing to fix: pick findings, or every remaining one is a nit or already addressed.')
  if (!run.checkoutPath || !existsSync(run.checkoutPath)) {
    const { dir } = await checkout(run.pr, key, emit)
    update(key, { checkoutPath: dir }, emit)
    run = runs.get(key)!
  }
  const dir = run.checkoutPath!
  const round: FixRound = { n: roundNo ?? (run.fixes?.length ?? 0) + 1, status: 'fixing', findingIds: targets.map((f) => f.id), startedAt: new Date().toISOString(), costUsd: 0 }
  update(key, { status: 'fixing', phase: `Fixing ${targets.length} finding${targets.length === 1 ? '' : 's'}`, fixes: [...(run.fixes ?? []), round] }, emit)
  const setRound = (patch: Partial<FixRound>): void => {
    Object.assign(round, patch)
    update(key, { fixes: [...(runs.get(key)!.fixes ?? [])] }, emit)
  }
  const abort = new AbortController()
  fixAborts.set(key, abort)
  try {
    const { settings } = getStore().get()
    const list = targets.map((f) => `- id=${f.id} [${f.severity}] ${f.path}${f.line != null ? `:${f.line}` : ''}: ${f.title}\n  ${f.body.replace(/\n+/g, ' ')}${f.suggestion ? `\n  Suggested replacement:\n${f.suggestion.split('\n').map((l) => '    ' + l).join('\n')}` : ''}`).join('\n')
    const prompt = [
      `You are addressing code review findings on pull request #${run.pr.number} "${run.pr.title}" in ${run.pr.nameWithOwner}. You are in a checkout of the PR head (branch ${run.headRefName}); the base is origin/${run.baseRefName}.`,
      '',
      'Findings to address:',
      list,
      '',
      'For each finding: make the smallest correct change that resolves it, in the spirit of the reviewer\u2019s comment. Read the surrounding code first. Keep the PR\u2019s style. Run the relevant tests or type-check when they exist and are cheap, and fix what you broke. Do not commit or push; Sinfonie commits and pushes after you finish. Do not touch findings that are not listed. If a finding is wrong or cannot be fixed safely, leave it and say why in skipped.',
      'Return the structured result when done.'
    ].join('\n')
    const options: Options = {
      ...claudeExecutableOption(),
      cwd: dir,
      permissionMode: 'acceptEdits',
      canUseTool: async (tool, input) => {
        if (tool === 'Bash') {
          const cmd = String((input as { command?: unknown }).command ?? '')
          if (DESTRUCTIVE.test(cmd)) return { behavior: 'deny', message: 'Not during a fix round: Sinfonie commits and pushes; never rewrite history or delete trees.' }
          return { behavior: 'allow', updatedInput: input }
        }
        return { behavior: 'allow', updatedInput: input }
      },
      model: costModeFor() !== 'standard' ? leanModel(settings.model) : settings.model,
      maxTurns: costModeFor() === 'lean' ? LEAN.fixTurns : 120,
      abortController: abort,
      settingSources: ['user'],
      outputFormat: { type: 'json_schema', schema: FIX_SCHEMA as unknown as Record<string, unknown> },
      env: { ...process.env, ...accountEnv(run.accountId) },
      stderr: (d) => console.error(`[fix ${key}]`, d.trimEnd())
    }
    let structured: unknown
    for await (const msg of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            const input = block.input as Record<string, unknown>
            const what = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : ''
            update(key, { phase: `Round ${round.n}: ${block.name} ${what}`.slice(0, 120) }, emit)
          }
        }
      } else if (msg.type === 'result') {
        round.costUsd = msg.total_cost_usd
        try {
          usage.recordTurn(usage.fromResult(msg, { workspaceId: '', spaceId: '', accountId: run.accountId, kind: 'review' }))
        } catch {
          /* ledger must never break the fix */
        }
        if (msg.subtype === 'success') structured = msg.structured_output
        else throw new Error(`Fix round ended with ${msg.subtype}${'errors' in msg && Array.isArray(msg.errors) ? `: ${(msg.errors as string[]).join('; ')}` : ''}`)
      }
    }
    const out = (structured ?? {}) as { summary?: string; addressed?: string[]; skipped?: { id: string; why: string }[]; commitMessage?: string }
    const g = git(dir)
    const status = await g.status()
    if (status.files.length === 0) {
      setRound({ status: 'done', finishedAt: new Date().toISOString(), summary: `${out.summary ?? 'No changes were needed.'}${out.skipped?.length ? ` Skipped: ${out.skipped.map((x) => `${x.id} (${x.why})`).join('; ')}` : ''}` })
      update(key, { status: 'done', phase: 'No changes to push' }, emit)
      return runs.get(key)!
    }
    setRound({ status: 'pushing' })
    update(key, { phase: `Round ${round.n}: committing and pushing` }, emit)
    await g.add(['-A'])
    const message = (out.commitMessage?.trim() || `fix: address review findings (round ${round.n})`) + `\n\nAddressed with Sinfonie from review findings ${round.findingIds.join(', ')}.`
    const commit = await g.commit(message)
    await g.push(['origin', `HEAD:refs/heads/${run.headRefName}`])
    const sha = commit.commit || (await g.revparse(['HEAD'])).trim()
    const addressed = new Set(out.addressed?.length ? out.addressed : round.findingIds)
    update(key, { findings: runs.get(key)!.findings.map((f) => (addressed.has(f.id) ? { ...f, addressedRound: round.n } : f)) })
    setRound({ status: 'done', finishedAt: new Date().toISOString(), commit: sha, summary: `${out.summary ?? ''}${out.skipped?.length ? ` Skipped: ${out.skipped.map((x) => `${x.id} (${x.why})`).join('; ')}` : ''}`.trim() })
    update(key, { status: 'done', phase: `Round ${round.n} pushed (${sha.slice(0, 7)})` }, emit)
    if (runs.get(key)!.iteration?.status !== 'running') notify(`Fixes pushed: ${run.pr.title}`, `${addressed.size} finding${addressed.size === 1 ? '' : 's'} addressed in ${sha.slice(0, 7)}.`, key)
    return runs.get(key)!
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setRound({ status: 'error', finishedAt: new Date().toISOString(), error: abort.signal.aborted ? 'Stopped' : message })
    update(key, { status: 'done', phase: abort.signal.aborted ? 'Fix round stopped' : `Fix round failed: ${message}` }, emit)
    if (!abort.signal.aborted) throw err
    return runs.get(key)!
  } finally {
    fixAborts.delete(key)
  }
}

/** Run another review pass on the same PR, keeping fix history. Resolves when the pass is over. */
async function reviewAgain(key: string, emit: Emit): Promise<ReviewRun> {
  const run = runs.get(key)!
  await cleanupCheckout(run)
  update(key, { status: 'preparing', phase: 'Preparing checkout', findings: [], verdict: undefined, error: undefined, submittedUrl: undefined, checkoutPath: undefined, startedAt: new Date().toISOString(), finishedAt: undefined }, emit)
  await execute(runs.get(key)!, emit)
  return runs.get(key)!
}

function mergeReady(run: ReviewRun): boolean {
  return run.status === 'done' && !run.findings.some((f) => (f.severity === 'critical' || f.severity === 'major') && !f.addressedRound) && (run.verdict?.decision === 'approve' || run.findings.length === 0)
}

/** Fix everything worth fixing, push, review again, and repeat until the reviewer approves or the round cap is hit. */
export async function iterate(key: string, maxRounds: number, emit: Emit): Promise<ReviewRun> {
  load()
  const run = runs.get(key)
  if (!run) throw new Error(`No review ${key}`)
  if (run.iteration?.status === 'running') return run
  if (run.isFork) throw new Error(`This PR comes from a fork (${run.headRepo}); Sinfonie can only push to branches of ${run.pr.nameWithOwner}.`)
  iterationStops.delete(key)
  // Lean mode: one fix round, then stop; every round is a full review plus a full fix pass.
  if (costModeFor() === 'lean') maxRounds = Math.min(maxRounds, 1)
  update(key, { iteration: { status: 'running', maxRounds, round: 0, startedAt: new Date().toISOString(), phase: 'Starting' } }, emit)
  void (async () => {
    const it = (): NonNullable<ReviewRun['iteration']> => runs.get(key)!.iteration!
    const setIt = (patch: Partial<NonNullable<ReviewRun['iteration']>>): void => {
      update(key, { iteration: { ...it(), ...patch } }, emit)
    }
    try {
      // Start from a fresh review unless the last pass is recent and complete.
      let cur = runs.get(key)!
      if (cur.status !== 'done') {
        setIt({ phase: 'Reviewing' })
        cur = await reviewAgain(key, emit)
        if (cur.status !== 'done') throw new Error(cur.error || 'The review did not complete')
      }
      let round = 0
      while (!mergeReady(cur) && round < maxRounds && !iterationStops.has(key)) {
        round++
        setIt({ round, phase: `Round ${round}: fixing` })
        const toFix = cur.findings.filter((f) => f.severity !== 'nit' && !f.addressedRound)
        if (toFix.length === 0) break
        await fixFindings(key, 'all', emit, round)
        if (iterationStops.has(key)) break
        setIt({ phase: `Round ${round}: reviewing again` })
        cur = await reviewAgain(key, emit)
        if (cur.status !== 'done') throw new Error(cur.error || 'The review did not complete')
      }
      const final = runs.get(key)!
      const rounds = (final.fixes ?? []).filter((r) => r.status === 'done' && r.commit)
      const left = final.findings.filter((f) => !f.addressedRound)
      const summary = [
        mergeReady(final) ? `Ready to merge after ${round} fix round${round === 1 ? '' : 's'} and ${final.passes ?? 0} review passes.` : iterationStops.has(key) ? `Stopped by you after ${round} round${round === 1 ? '' : 's'}.` : `Stopped after ${round} round${round === 1 ? '' : 's'} (the cap); ${left.length} finding${left.length === 1 ? '' : 's'} remain${left.length === 1 ? 's' : ''}.`,
        ...rounds.map((r) => `Round ${r.n} (${r.commit!.slice(0, 7)}): ${r.summary || `${r.findingIds.length} findings addressed`}`),
        final.verdict ? `Final verdict: ${final.verdict.decision.replace('_', ' ')}. ${final.verdict.summary}` : ''
      ]
        .filter(Boolean)
        .join('\n\n')
      setIt({ status: iterationStops.has(key) ? 'stopped' : 'done', finishedAt: new Date().toISOString(), phase: undefined, summary })
      notify(mergeReady(final) ? `Ready to merge: ${final.pr.title}` : `Iteration finished: ${final.pr.title}`, summary.split('\n')[0], key)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setIt({ status: 'error', error: message, finishedAt: new Date().toISOString(), phase: undefined })
      notify(`Iteration failed: ${runs.get(key)!.pr.title}`, message, key)
    } finally {
      iterationStops.delete(key)
    }
  })()
  return runs.get(key)!
}

export function stopIteration(key: string): void {
  iterationStops.add(key)
  fixAborts.get(key)?.abort()
  aborts.get(key)?.abort()
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

let viewerLogin: string | null = null
async function viewer(): Promise<string> {
  if (viewerLogin) return viewerLogin
  try {
    viewerLogin = (await gh(['api', 'user', '--jq', '.login'])).trim()
  } catch {
    viewerLogin = ''
  }
  return viewerLogin
}
/** GitHub's own explanation from a failed `gh api` call, instead of the bare HTTP status. */
function githubError(e: unknown): string {
  const err = e as { stderr?: string; stdout?: string }
  try {
    const j = JSON.parse(err.stdout ?? '') as { message?: string; errors?: ({ message?: string } | string)[] }
    const details = (j.errors ?? []).map((x) => (typeof x === 'string' ? x : x.message ?? '')).filter(Boolean)
    const msg = [j.message, ...details].filter(Boolean).join(': ')
    if (msg) return msg
  } catch {
    /* not json */
  }
  return (err.stderr || err.stdout || '').trim().split('\n').slice(0, 3).join(' ') || 'gh api failed'
}

/** Posts one GitHub review: the verdict as body, approved findings as inline comments. */
export async function submitReview(key: string, emit: Emit): Promise<ReviewRun> {
  load()
  const run = runs.get(key)
  if (!run) throw new Error(`No review ${key}`)
  if (!run.verdict) throw new Error('Set a verdict first')
  // GitHub refuses approvals and change requests on your own pull request; say so before it does.
  if (run.verdict.decision !== 'comment') {
    const me = await viewer()
    if (me && me.toLowerCase() === run.pr.author.toLowerCase()) throw new Error(`GitHub does not let you ${run.verdict.decision === 'approve' ? 'approve' : 'request changes on'} your own pull request (${me}). Switch the verdict to Comment to post the findings, or ask a teammate to approve.`)
  }
  const approved = run.findings.filter((f) => f.approved)
  const inline = approved.filter((f) => f.line != null)
  const fileLevel = approved.filter((f) => f.line == null)
  // A comment or change-request review must carry a body; an approval may be empty.
  const bodyParts = [run.verdict.summary.trim() || (run.verdict.decision === 'approve' ? '' : approved.length ? 'Review findings below.' : 'Reviewed with Sinfonie.')]
  if (fileLevel.length) bodyParts.push(fileLevel.map((f) => `- \`${f.path}\`: ${formatComment(f).replace(/\n+/g, ' ')}`).join('\n'))
  // gh api with --input reads stdin; execFile has no stdin helper, so shell out via a temp file.
  const tmp = join(app.getPath('temp'), `sinfonie-review-${nanoid(6)}.json`)
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
      throw new Error(githubError(e))
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
