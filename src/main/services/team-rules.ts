/**
 * Team guardrails (Team → Guardrails): which apps builders may change, paths no agent writes, the review gate,
 * and a daily spend limit. The rules live on the space (`Space.rules`) and travel with its shared definition
 * and the organisation sync. This module is the one place that decides; every engine's permission layer asks it
 * before a write runs (docs/design/README.md, "Rules bind Maestro"):
 *
 * - Claude Code (SDK sessions and crew workers): a PreToolUse hook, which runs in every permission mode.
 * - Claude Code in the terminal (CLI mode): the PreToolUse hook server in cli-session.ts (a failed hook blocks).
 * - Native engine and native crew workers: inside the Write, Edit and Bash tools themselves.
 * - ACP engines (Codex, Gemini CLI, Grok Build): asked mode while rules exist, the permission request, the client's
 *   file and terminal calls, and a check after each finished edit that restores protected files.
 * - Maestro: its prompt, and the review and spend gates here (it has no file tools).
 *
 * Known limits are listed for admins in the Guardrails page ("How this is enforced"); keep the two in step.
 * Nothing here imports an engine or workspaces.ts, so every engine can import it.
 */
import { execFile } from 'child_process'
import { shell } from 'electron'
import { existsSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { getStore } from '../store'
import { ghEnv, ghPath } from './prereqs'
import * as cloud from './cloud'
import * as usage from './usage'
import { isReadOnlyCommand } from './readonly'
import { normalizeRemote, remoteOf } from './shared-space'
import type { Space, TeamRules, Workspace } from '@shared/types'

type WsLike = Pick<Workspace, 'id' | 'repos' | 'rootPath' | 'primaryRepoId'> & { spaceId?: string; reviewRequestedAt?: string }

const pad = (n: number): string => String(n).padStart(2, '0')
/** The person's local calendar day, which is what "today" means for the spend limit and its override. */
function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const localMidnight = (): number => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
/**
 * Builder rules follow the person's own mode on this Mac: the cloud has admin and member roles only, with no
 * builder assignment, so guided mode is the only signal of "builder" there is.
 */
const guided = (): boolean => getStore().get().settings.mode === 'guided'
const CI = process.platform === 'darwin'

export function spaceOf(spaceId?: string): Space | undefined {
  return spaceId ? getStore().get().spaces.find((s) => s.id === spaceId) : undefined
}
function rulesFor(spaceId?: string): TeamRules {
  return spaceOf(spaceId)?.rules ?? {}
}
function hasRules(r: TeamRules): boolean {
  return Boolean(r.builderReadOnly?.length || r.protectedPaths?.length || r.requireReview || r.dailySpendUsd)
}

/**
 * Who may change a space's rules: its organisation's admins; a personal space belongs to the person on this Mac.
 * Signed out of an organisation space means read-only, since the role cannot be checked.
 */
export function isAdminOf(space: Space | undefined): boolean {
  if (!space?.orgId) return true
  return cloud.state().account?.orgs.some((o) => o.id === space.orgId && o.role === 'admin') ?? false
}

// ---------- apps, keyed by remote ----------

/** repo id -> normalised remote ("github.com/acme/web"), or '' when the repo has none. Filled in the background. */
const remoteKeys = new Map<string, string>()
let warming: Promise<void> | null = null
function warmRemotes(): Promise<void> {
  if (warming) return warming
  warming = (async () => {
    for (const r of getStore().get().repos) {
      if (remoteKeys.has(r.id)) continue
      const remote = await remoteOf(r.path).catch(() => null)
      remoteKeys.set(r.id, remote ? normalizeRemote(remote) : '')
    }
  })().finally(() => {
    warming = null
  })
  return warming
}
setTimeout(() => void warmRemotes().catch(() => undefined), 3000)

/** How a repo is named in `builderReadOnly`: its remote (the same on every teammate's Mac), else its local name. */
function appKey(repoId: string, name: string): string {
  if (!remoteKeys.has(repoId)) void warmRemotes().catch(() => undefined)
  return remoteKeys.get(repoId) || name
}
export async function appKeys(spaceId: string): Promise<Record<string, string>> {
  await warmRemotes()
  return Object.fromEntries(getStore().get().repos.filter((r) => r.spaceId === spaceId).map((r) => [r.id, remoteKeys.get(r.id) || r.name]))
}
function lookOnly(rules: TeamRules, repoId: string | undefined, name: string): boolean {
  const list = rules.builderReadOnly ?? []
  if (!list.length || !guided()) return false
  if (list.includes(name)) return true
  const key = repoId ? appKey(repoId, name) : ''
  return Boolean(key && list.includes(key))
}
const appName = (repoName: string): string => getStore().get().repos.find((r) => r.name === repoName)?.displayName || repoName

// ---------- paths ----------

/** A gitignore-flavoured glob as a regex over a repo-relative path: no slash matches at any depth, a trailing slash (or a directory match) covers everything inside. */
function globRe(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, '').replace(/^\//, '')
  if (g.endsWith('/')) g = g.slice(0, -1)
  const anchored = g.includes('/')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${re}(?:/.*)?$`, CI ? 'i' : '')
}

/** The real path, resolving symlinks through the nearest existing parent so a file about to be created counts too. */
function real(p: string): string {
  let cur = resolve(p)
  const tail: string[] = []
  for (let i = 0; i < 128; i++) {
    try {
      const r = realpathSync.native(cur)
      return tail.length ? join(r, ...tail.reverse()) : r
    } catch {
      const parent = dirname(cur)
      if (parent === cur) break
      tail.push(basename(cur))
      cur = parent
    }
  }
  return resolve(p)
}
/** `abs` relative to `root` when inside it ('' for the root itself), else null. Case-insensitive on macOS. */
function inside(root: string, abs: string): string | null {
  const rel = CI ? relative(root.toLowerCase(), abs.toLowerCase()) : relative(root, abs)
  if (rel === '') return ''
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/** Which repository of the workspace a path is in, and the path relative to it. Checks worktrees and the original checkouts. */
function locate(ws: WsLike, path: string): { repoId?: string; repoName?: string; rel: string } {
  const abs = real(path)
  const { repos } = getStore().get()
  const roots: { path: string; id: string; name: string }[] = []
  for (const r of ws.repos) roots.push({ path: r.worktreePath, id: r.repoId, name: r.repoName })
  for (const r of ws.repos) {
    const orig = repos.find((x) => x.id === r.repoId)
    if (orig) roots.push({ path: orig.path, id: r.repoId, name: r.repoName })
  }
  for (const root of roots) {
    const rel = inside(real(root.path), abs)
    if (rel !== null) return { repoId: root.id, repoName: root.name, rel }
  }
  const rel = inside(real(ws.rootPath), abs)
  return { rel: rel ?? abs }
}

function defaultCwd(ws: WsLike): string {
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  return primary?.worktreePath ?? ws.rootPath
}

function protectedHit(rules: TeamRules, rel: string): string | null {
  if (!rel) return null
  for (const g of rules.protectedPaths ?? []) {
    if (!g.trim()) continue
    try {
      if (globRe(g).test(rel)) return g.trim()
    } catch {
      /* a malformed glob protects nothing rather than everything */
    }
  }
  return null
}

function protectedMsg(glob: string, rel: string): string {
  return `Team rule: agents never change "${glob}" (${rel}). Leave it as it is and tell the person what would need to change there; a team admin can change this rule in Team, Guardrails.`
}
function readOnlyMsg(repoName: string): string {
  return `Team rule: builders can't change the ${appName(repoName)} app. You may read it, but make no changes there; say what would need to change and offer to ask a teammate.`
}

/** Why writing this file breaks a team rule, or null. */
export function writeVeto(ws: WsLike, filePath: string, cwd?: string): string | null {
  const rules = rulesFor(ws.spaceId)
  if (!rules.protectedPaths?.length && !rules.builderReadOnly?.length) return null
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd ?? defaultCwd(ws), filePath)
  const { repoId, repoName, rel } = locate(ws, abs)
  if (repoName && lookOnly(rules, repoId, repoName)) return readOnlyMsg(repoName)
  const hit = protectedHit(rules, rel)
  return hit ? protectedMsg(hit, rel) : null
}

// ---------- shell commands ----------

/** Prose that is not a path: heredoc bodies, commit messages (-m, -am, --message, -F), $(cat <<EOF …) bodies. */
function stripProse(cmd: string): string {
  return cmd
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\s|$|\))/g, ' $3 ')
    .replace(/(^|\s)(-[a-zA-Z]*m|--message)(=|\s*)("(?:[^"\\]|\\.)*"|'[^']*'|\$\((?:[^()]|\([^()]*\))*\))/g, ' ')
    .replace(/(^|\s)(-F|--file)(=|\s+)\S+/g, ' ')
}

/**
 * A command that certainly writes nothing: the shared read-only check, minus the forms it lets through that can
 * write (sed scripts other than printing line ranges, awk, xargs, backticks, find's -fprint/-fls).
 */
function strictlyReadOnly(cmd: string): boolean {
  if (!isReadOnlyCommand(cmd)) return false
  if (/`|\bxargs\b|\bawk\b|-fprint|-fls\b/.test(cmd)) return false
  const seds = cmd.match(/\bsed\b[^|;&]*/g) ?? []
  return seds.every((s) => /^sed\s+-n\s+(['"]?)[\d,$]+p\1(\s|$)/.test(s.trim()))
}

function reviewGateVeto(ws: WsLike, cmd: string): string | null {
  if (!guided() || !rulesFor(ws.spaceId).requireReview) return null
  const text = stripProse(cmd)
  const msg = 'Your team requires a review: changes go out only when the person clicks Send for review. Make the change and stop there.'
  if (/\bgh\s+pr\s+(create|merge|ready|review)\b/.test(text)) return msg
  if (/\bgh\s+api\b[^|;&]*\/(pulls|merges)\b/.test(text)) return msg
  const bases = new Set(ws.repos.map((r) => r.baseBranch))
  for (const m of text.matchAll(/\bgit\b[^|;&\n]*\bpush\b([^|;&\n]*)/g)) {
    const words = m[1].split(/\s+/).filter(Boolean)
    if (words.some((w) => w === '--all' || w === '--mirror')) return msg
    if (words.some((w) => bases.has(w.replace(/^\+/, '').split(':').pop()!.replace(/^refs\/heads\//, '')))) return msg
  }
  return null
}

/**
 * Why this shell command breaks a team rule, or null. A heuristic over the command text: it catches the plain
 * cases (sed -i, rm, mv, cp, redirects, git checkout of a file, gh pr create), not a script that computes its paths.
 * Commands that certainly only read may name protected paths; anything else may not.
 */
export function commandVeto(ws: WsLike, command: string, cwd?: string): string | null {
  const rules = rulesFor(ws.spaceId)
  const gate = reviewGateVeto(ws, command)
  if (gate) return gate
  const anyLookOnly = guided() && (rules.builderReadOnly?.length ?? 0) > 0
  if (!rules.protectedPaths?.length && !anyLookOnly) return null
  if (strictlyReadOnly(command)) return null
  let dir = cwd ?? defaultCwd(ws)
  const lead = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)/.exec(command)
  if (lead) dir = resolve(dir, lead[1].replace(/^["']|["']$/g, ''))
  const here = locate(ws, dir)
  if (here.repoName && lookOnly(rules, here.repoId, here.repoName) && !/\bcd\s/.test(command.slice(lead ? lead[0].length : 0))) return readOnlyMsg(here.repoName)
  const words = stripProse(command)
    .split(/[\s"'`=<>|;&()]+/)
    .filter((w) => w && !w.startsWith('-') && /[\w.*]/.test(w))
  for (const w of words) {
    if (/^[a-z]+:\/\//i.test(w)) continue
    const abs = isAbsolute(w) ? w : resolve(dir, w)
    // A bare word counts only when it looks like a path or names something that exists.
    if (!/[/.]/.test(w) && !existsSync(abs)) continue
    const { repoId, repoName, rel } = locate(ws, abs)
    if (repoName && rel && lookOnly(rules, repoId, repoName)) return readOnlyMsg(repoName)
    const hit = protectedHit(rules, rel) ?? protectedHit(rules, w.replace(/^\.\//, ''))
    if (hit) return protectedMsg(hit, rel || w)
  }
  return null
}

const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/

/** For Claude Code-shaped tool calls (SDK, CLI hooks, native engine). `tool` may carry a "worker: " prefix. */
export function toolVeto(ws: WsLike, tool: string, input: unknown, cwd?: string): string | null {
  const name = tool.replace(/^.*:\s*/, '')
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (WRITE_TOOLS.test(name)) {
    const p = [i.file_path, i.notebook_path, i.path].find((v) => typeof v === 'string') as string | undefined
    return p ? writeVeto(ws, p, cwd) : null
  }
  if (name === 'Bash' && typeof i.command === 'string') return commandVeto(ws, i.command, typeof i.cwd === 'string' ? i.cwd : cwd)
  return null
}

/** Paths an ACP tool call names: its input fields, its locations, and the files of a patch. */
export function acpPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const k of ['file_path', 'path', 'filePath', 'abs_path', 'destination', 'new_path', 'old_path']) if (typeof input[k] === 'string') paths.push(input[k] as string)
  const locs = input.locations
  if (Array.isArray(locs)) for (const l of locs) if (l && typeof (l as { path?: unknown }).path === 'string') paths.push((l as { path: string }).path)
  const changes = input.changes
  if (changes && typeof changes === 'object') paths.push(...Object.keys(changes as object))
  return paths
}

/**
 * For ACP tool calls: edits, deletes and moves by their paths; executes by their command. A call without a kind
 * is judged by what it carries (a command, else its paths), never allowed for lack of a label.
 */
export function acpVeto(ws: WsLike, kind: string | undefined | null, input: Record<string, unknown>, cwd?: string): string | null {
  const c = input.command
  const cmd = Array.isArray(c) ? c.join(' ') : typeof c === 'string' ? c : ''
  if (kind === 'read' || kind === 'search' || kind === 'fetch' || kind === 'think' || kind === 'switch_mode') return null
  if (kind === 'execute' || ((!kind || kind === 'other') && cmd)) return cmd ? commandVeto(ws, cmd, typeof input.cwd === 'string' ? input.cwd : cwd) : null
  for (const p of acpPaths(input)) {
    const v = writeVeto(ws, p, cwd)
    if (v) return v
  }
  return null
}

/** True when an ACP agent must be kept in an asking mode so its edits reach the permission check. */
export function acpNeedsAsk(ws: WsLike): boolean {
  const r = rulesFor(ws.spaceId)
  return Boolean(r.protectedPaths?.length || (guided() && (r.builderReadOnly?.length || r.requireReview)))
}

/**
 * Put back a protected file an agent changed without asking (ACP agents in their own auto modes): tracked files
 * from the last commit, new files to the Trash (recoverable). Returns the repo-relative path.
 */
export async function restorePath(ws: WsLike, filePath: string, cwd?: string): Promise<string> {
  const abs = real(isAbsolute(filePath) ? filePath : resolve(cwd ?? defaultCwd(ws), filePath))
  const root = ws.repos.map((r) => real(r.worktreePath)).find((r) => inside(r, abs) !== null)
  if (!root) return abs
  const rel = relative(root, abs)
  const tracked = await run('git', ['ls-files', '--error-unmatch', '--', rel], root)
  if (tracked.ok) await run('git', ['checkout', 'HEAD', '--', rel], root)
  else if (existsSync(abs)) await shell.trashItem(abs)
  return rel
}

// ---------- the review gate ----------

function run(bin: string, args: string[], cwd?: string, timeoutMs = 20_000, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; text: string }> {
  return new Promise((done) => {
    execFile(bin, args, { cwd, env, timeout: timeoutMs }, (err, stdout) => done({ ok: !err, text: String(stdout ?? '').trim() }))
  })
}
const gh = (args: string[], cwd?: string): Promise<{ ok: boolean; text: string }> => run(ghPath(), args, cwd, 20_000, ghEnv())

/** Builders open a PR only through Send for review (with the team's reviewers), when the team requires reviews. */
export function prVeto(ws: WsLike, reviewers?: string[]): string | null {
  const space = spaceOf(ws.spaceId)
  if (!space?.rules?.requireReview || !guided()) return null
  if (reviewers?.length) return null
  if (!(space.guided?.reviewers ?? []).length) return 'Your team requires a review before anything goes out, and no reviewer is set up yet. Ask your team admin to pick one in Team.'
  return 'Your team requires a review first. Use Send for review so a teammate sees it.'
}

/** Builders can't mark a task done before it was sent for review. Experts are warned in the UI instead. */
export function stageVeto(ws: WsLike, stage: string): string | null {
  if (stage !== 'done' || ws.reviewRequestedAt) return null
  const space = spaceOf(ws.spaceId)
  if (!space?.rules?.requireReview || !guided()) return null
  return 'Your team requires a review before a task is finished. Send it for review first.'
}

/** A PR opened outside Sinfonie still counts as sent for review: look on GitHub before the stage gate says no. */
export async function ensureReviewKnown(ws: Workspace): Promise<void> {
  if (ws.reviewRequestedAt || !spaceOf(ws.spaceId)?.rules?.requireReview) return
  for (const r of ws.repos) {
    const out = await gh(['pr', 'list', '--head', r.branch, '--state', 'all', '--json', 'number', '-q', 'length'], r.worktreePath)
    if (out.ok && Number(out.text) > 0) {
      getStore().update((d) => {
        const w = d.workspaces.find((x) => x.id === ws.id)
        if (w && !w.reviewRequestedAt) w.reviewRequestedAt = new Date().toISOString()
      })
      return
    }
  }
}

/** Merging a PR from a generated view, in guided mode: only once GitHub shows it approved, if its space requires reviews. */
export async function mergeVeto(repo: string, number: number): Promise<string | null> {
  if (!guided()) return null
  await warmRemotes()
  const { repos, spaces } = getStore().get()
  const suffix = `/${repo.toLowerCase()}`
  const owners = repos.filter((r) => (remoteKeys.get(r.id) ?? '').endsWith(suffix)).map((r) => r.spaceId)
  const required = owners.length ? owners.some((id) => spaceOf(id)?.rules?.requireReview) : spaces.some((s) => s.rules?.requireReview)
  if (!required) return null
  const out = await gh(['pr', 'view', String(number), '--repo', repo, '--json', 'reviewDecision,latestReviews'])
  if (!out.ok) return 'Your team requires an approved review, and Sinfonie could not check whether this one was approved, so nothing went live. Check your connection and try again in a moment.'
  let decision = ''
  let reviews: { state?: string }[] = []
  try {
    const j = JSON.parse(out.text) as { reviewDecision?: string; latestReviews?: { state?: string }[] }
    decision = j.reviewDecision ?? ''
    reviews = j.latestReviews ?? []
  } catch {
    /* treated as not approved */
  }
  if (decision === 'APPROVED') return null
  if (!decision && reviews.some((r) => r.state === 'APPROVED') && !reviews.some((r) => r.state === 'CHANGES_REQUESTED')) return null
  return 'Your team requires an approved review before this goes live. It has not been approved yet.'
}

// ---------- daily spend ----------

/** Estimated spend today (the person's local day) in a space, from this Mac's usage ledger. */
function spentToday(spaceId: string): number {
  return usage.spentSince(spaceId, localMidnight())
}
/** An admin's "allow more today" for this person, synced through the organisation, counts for their local day. */
function allowedToday(space: Space): boolean {
  const me = cloud.state().account?.user.id
  if (!me) return false
  return (space.rules?.spendAllowances ?? []).some((a) => a.userId === me && localDay(new Date(a.grantedAt)) === localDay())
}
/** Lifted on this Mac (the admin's own override) or for this person by an admin from the Team console. */
function spendLifted(space: Space | undefined): boolean {
  return Boolean(space && (space.rulesOverride?.spendDay === localDay() || allowedToday(space)))
}
/** Called when a message is stopped by the limit, so a fresh "allow more" from an admin is pulled soon. Set by ipc. */
let onSpendBlocked: ((spaceId: string) => void) | null = null
export function setOnSpendBlocked(fn: (spaceId: string) => void): void {
  onSpendBlocked = fn
}
export function spendStatus(spaceId: string): { spent: number; limit?: number; lifted: boolean; day: string } {
  const space = spaceOf(spaceId)
  return { spent: spentToday(spaceId), limit: space?.rules?.dailySpendUsd, lifted: spendLifted(space), day: localDay() }
}

/** The plain message that stops a new turn when the space's daily limit is reached, or null. */
export function spendBlock(ws: Pick<WsLike, 'spaceId'>): string | null {
  const space = spaceOf(ws.spaceId)
  const limit = space?.rules?.dailySpendUsd
  if (!space || !limit || limit <= 0) return null
  if (spendLifted(space)) return null
  const spent = spentToday(space.id)
  if (spent < limit) return null
  const amounts = `$${spent.toFixed(2)} of $${limit.toFixed(2)}`
  if (isAdminOf(space)) return `Today's spending limit for ${space.name} is reached (${amounts}), so this message was not sent. You're an admin: allow more for today in Team, Guardrails, then send it again.`
  onSpendBlocked?.(space.id)
  return space.orgSpace
    ? `Today's spending limit for ${space.name} is reached (${amounts}), so this message was not sent. Ask your team admin to allow more for you today (Team, Guardrails); a minute after they do, send it again. Or try again tomorrow.`
    : `Today's spending limit for ${space.name} is reached (${amounts}), so this message was not sent. Try again tomorrow.`
}

// ---------- editing ----------

function clean(r: TeamRules): TeamRules {
  const list = (xs?: string[]): string[] | undefined => {
    const out = [...new Set((xs ?? []).map((x) => x.trim()).filter(Boolean))]
    return out.length ? out : undefined
  }
  const out: TeamRules = {
    builderReadOnly: list(r.builderReadOnly),
    protectedPaths: list(r.protectedPaths),
    requireReview: r.requireReview || undefined,
    dailySpendUsd: r.dailySpendUsd && r.dailySpendUsd > 0 ? Math.round(r.dailySpendUsd * 100) / 100 : undefined,
    reviewedAt: r.reviewedAt,
    // An allowance is for one local day; after two days it can no longer apply anywhere, so it is dropped.
    spendAllowances: (() => {
      const live = (r.spendAllowances ?? []).filter((a) => a.userId && Date.now() - Date.parse(a.grantedAt) < 48 * 3600_000)
      return live.length ? live : undefined
    })()
  }
  for (const k of Object.keys(out) as (keyof TeamRules)[]) if (out[k] === undefined) delete out[k]
  return out
}

function needAdmin(spaceId: string, what: string): Space {
  const space = spaceOf(spaceId)
  if (!space) throw new Error('Unknown space')
  if (!isAdminOf(space)) throw new Error(`Only a team admin can ${what}.`)
  return space
}

/** Replace the rules (the Guardrails form); stamps reviewedAt for the setup checklist. The look-only list is kept as stored. */
export function setRules(spaceId: string, rules: TeamRules): Space {
  needAdmin(spaceId, 'change the guardrails')
  for (const g of rules.protectedPaths ?? []) {
    try {
      globRe(g)
    } catch {
      throw new Error(`"${g}" is not a valid path pattern.`)
    }
  }
  getStore().update((d) => {
    const s = d.spaces.find((x) => x.id === spaceId)
    if (s) s.rules = clean({ ...rules, builderReadOnly: s.rules?.builderReadOnly, spendAllowances: s.rules?.spendAllowances, reviewedAt: new Date().toISOString() })
  })
  return spaceOf(spaceId)!
}

/** One app's "builders can change" switch, applied to the latest stored rules; keyed by remote, local name as fallback. */
export async function setAppLookOnly(spaceId: string, repoId: string, lookOnlyOn: boolean): Promise<() => void> {
  needAdmin(spaceId, 'change the guardrails')
  const repo = getStore().get().repos.find((r) => r.id === repoId)
  if (!repo) throw new Error('Unknown app')
  await warmRemotes()
  const key = remoteKeys.get(repoId) || repo.name
  const apply = (): void => {
    getStore().update((d) => {
      const s = d.spaces.find((x) => x.id === spaceId)
      if (!s) return
      const rest = (s.rules?.builderReadOnly ?? []).filter((k) => k !== key && k !== repo.name)
      s.rules = clean({ ...(s.rules ?? {}), builderReadOnly: lookOnlyOn ? [...rest, key] : rest })
    })
  }
  return apply
}

/** Lift today's spend limit on this Mac. Admins only. */
export function overrideSpend(spaceId: string): Space {
  needAdmin(spaceId, 'allow more spending today')
  getStore().update((d) => {
    const s = d.spaces.find((x) => x.id === spaceId)
    if (s) s.rulesOverride = { ...(s.rulesOverride ?? {}), spendDay: localDay() }
  })
  return spaceOf(spaceId)!
}

/** Lift today's spend limit for one member, everywhere they work: saved in the rules, which the organisation sync carries. Admins only. */
export function allowSpendFor(spaceId: string, userId: string, login?: string): () => void {
  needAdmin(spaceId, 'allow more spending today')
  return () =>
    getStore().update((d) => {
      const s = d.spaces.find((x) => x.id === spaceId)
      if (!s) return
      const rest = (s.rules?.spendAllowances ?? []).filter((a) => a.userId !== userId)
      s.rules = clean({ ...(s.rules ?? {}), spendAllowances: [...rest, { userId, login, grantedAt: new Date().toISOString() }] })
    })
}

// ---------- prompts ----------

/** Appended to an agent's system prompt so it knows the rules before Sinfonie has to refuse anything. */
export function promptFor(ws: WsLike): string {
  const rules = rulesFor(ws.spaceId)
  if (!hasRules(rules)) return ''
  const lines = ['', 'TEAM GUARDRAILS. The team admin set these; Sinfonie refuses tool calls that break them, so plan around them instead of retrying:']
  if (rules.protectedPaths?.length) lines.push(`- Never create, edit, move or delete files matching these paths (relative to each repository root): ${rules.protectedPaths.join(', ')}. Reading them is fine.`)
  const ro = ws.repos.filter((r) => lookOnly(rules, r.repoId, r.repoName)).map((r) => r.repoName)
  if (ro.length) lines.push(`- These repositories are read-only for this person: ${ro.join(', ')}. Read them if you need to; make no changes there.`)
  if (rules.requireReview) lines.push(guided() ? '- Work goes out only when the person sends it for review; never open, merge or push a pull request yourself, and never say a change is live before a teammate approves it.' : '- The team requires a review before work is merged or marked done.')
  if (rules.dailySpendUsd) lines.push(`- The team caps agent spend at about $${rules.dailySpendUsd} a day per person. Keep work focused.`)
  return lines.join('\n')
}

/** Every space's rules, for Maestro's prompt. */
export function maestroPrompt(): string {
  const { spaces, repos } = getStore().get()
  const withRules = spaces.filter((s) => s.rules && hasRules(s.rules))
  if (!withRules.length) return ''
  const lines = ['TEAM GUARDRAILS. Rules bind you like everyone else. Never send a workspace a task that breaks them, never mark work done that the review rule holds back, and never offer to change or get around them: only a team admin changes them, in Team (open_settings cannot). When a rule stops a request, say which rule, in one sentence. Per space:']
  for (const s of withRules) {
    const r = s.rules!
    const parts: string[] = []
    if (r.builderReadOnly?.length) {
      const names = repos.filter((x) => x.spaceId === s.id && (r.builderReadOnly!.includes(x.name) || r.builderReadOnly!.includes(remoteKeys.get(x.id) || '\u0000'))).map((x) => x.displayName || x.name)
      parts.push(`builders can't change ${names.length ? names.join(', ') : r.builderReadOnly.join(', ')}`)
    }
    if (r.protectedPaths?.length) parts.push(`no agent writes ${r.protectedPaths.join(', ')}`)
    if (r.requireReview) parts.push('a review is required before done or a PR from a builder')
    if (r.dailySpendUsd) parts.push(`daily spend limit $${r.dailySpendUsd} per person`)
    lines.push(`- ${s.name}: ${parts.join('; ')}.`)
  }
  return lines.join('\n')
}
