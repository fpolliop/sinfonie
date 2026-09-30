/**
 * What Sinfonie needs on this Mac to work with GitHub, and the in-app fixes for each piece:
 *
 * - git (on macOS it comes with Apple's developer tools: `xcode-select --install`);
 * - the GitHub CLI `gh`: the person's own copy when there is one, else a copy downloaded on demand from GitHub's
 *   release page into Sinfonie's data folder (checksum-verified). `ghPath()` is the one resolver every spawn uses,
 *   and the download folder is on PATH, so older call sites that spawn plain `gh` find it too;
 * - a GitHub sign-in, done in-app: `gh auth login --web` in a pty, the one-time code shown in the app, then
 *   `gh auth setup-git` so git itself can fetch and push private apps;
 * - a git identity per app, taken from GitHub or the Sinfonie account when none is set.
 *
 * Also here: cloning an app with progress, Cancel and plain failure kinds, and the GitHub side of Send for review
 * (can this account push, put an app on GitHub, make your own copy, merge your own change).
 */
import { app, shell } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, delimiter, dirname, join, resolve as resolvePath } from 'path'
import { homedir, hostname, userInfo } from 'os'
import { getStore } from '../store'
import { createTerminal, disposeTerminal, writeTerminal } from './terminal'
import { logError } from './telemetry'
import { PLAIN_ERROR_MARK } from '@shared/types'
import type { CloneFailure, CloneProgress, CloneResult, FolderKind, GitHubConnectState, GitHubConnection, RepoGitHubAccess } from '@shared/types'

// ---------- running tools ----------

interface RunResult {
  code: number
  stdout: string
  stderr: string
  /** The spawn itself failed (ENOENT: not installed). */
  spawnError?: string
}

function run(bin: string, args: string[], opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeout ?? 30_000, env: opts.env ?? ghEnv(), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
      resolve({
        code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        ...(e && typeof e.code === 'string' ? { spawnError: e.code } : {})
      })
    })
  })
}

const text = (r: RunResult): string => `${r.stderr}\n${r.stdout}`.trim()

// ---------- gh: one resolver ----------

/** Sinfonie's own tools folder (inside its data folder); the downloaded gh lives in `bin` here. */
export function toolsDir(): string {
  return join(app.getPath('userData'), 'tools')
}
const bundledGhPath = (): string => join(toolsDir(), 'bin', process.platform === 'win32' ? 'gh.exe' : 'gh')

function executable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The first `bin` on PATH (plus the usual Homebrew folders), leaving out Sinfonie's own tools folder. */
function onPath(bin: string): string | null {
  const own = join(toolsDir(), 'bin')
  const dirs = [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter((d) => d && resolvePath(d) !== own)
  for (const d of new Set(dirs)) {
    const p = join(d, bin)
    if (executable(p)) return p
  }
  return null
}

/**
 * The gh to run: the person's own (Homebrew, installer) when there is one, since that is the one already signed
 * in; else the copy Sinfonie downloaded; else plain 'gh' (the spawn then fails with ENOENT, which callers map to
 * "Connect GitHub").
 */
export function ghPath(): string {
  return onPath('gh') ?? (executable(bundledGhPath()) ? bundledGhPath() : 'gh')
}
export const ghInstalled = (): boolean => ghPath() !== 'gh'
const ghIsBundled = (): boolean => ghPath() === bundledGhPath()

/** Environment for gh: no prompts, no update nags. */
export function ghEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0', ...extra }
}

/**
 * Puts Sinfonie's tools folder at the END of PATH, so every `spawn('gh')` in the app finds the downloaded copy when
 * the person has none of their own (their own always wins). Called at startup and after a download.
 */
export function ensureToolsOnPath(): void {
  const own = join(toolsDir(), 'bin')
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (!parts.includes(own)) process.env.PATH = [...parts, own].join(delimiter)
}

/** Run gh with the resolved binary. */
export function gh(args: string[], cwd?: string, timeout = 30_000): Promise<RunResult> {
  return run(ghPath(), args, { cwd, timeout })
}

/**
 * Git options that let git use the GitHub sign-in for github.com even when `gh auth setup-git` never ran (or ran
 * with another gh): a credential helper scoped to github.com that asks gh. Empty when gh is not installed.
 */
export function gitCredentialArgs(): string[] {
  if (!ghInstalled()) return []
  const bin = ghPath().replace(/'/g, `'\\''`)
  return ['-c', 'credential.https://github.com.helper=', '-c', `credential.https://github.com.helper=!'${bin}' auth git-credential`]
}

// ---------- downloading gh ----------

let installing: Promise<string> | null = null

/**
 * Downloads the latest GitHub CLI for this Mac from GitHub's release page into Sinfonie's tools folder, verifying
 * the archive against the release's checksums file. Returns the binary's path. One download at a time.
 */
export function installGh(): Promise<string> {
  installing ??= doInstallGh().finally(() => (installing = null))
  return installing
}

async function doInstallGh(): Promise<string> {
  const plat = process.platform === 'darwin' ? 'macOS' : process.platform === 'linux' ? 'linux' : null
  if (!plat) throw new Error('Sinfonie can only download the GitHub tool on macOS and Linux.')
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Sinfonie' }
  const rel = (await (await fetch('https://api.github.com/repos/cli/cli/releases/latest', { headers, signal: AbortSignal.timeout(20_000) })).json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] }
  const assets = rel.assets ?? []
  const want = assets.find((a) => new RegExp(`^gh_[\\d.]+_${plat}_${arch}\\.(zip|tar\\.gz)$`).test(a.name))
  const sums = assets.find((a) => /_checksums\.txt$/.test(a.name))
  if (!want || !sums) throw new Error('GitHub’s download page did not list the tool for this Mac. Try again later.')
  const [archive, checksums] = await Promise.all([
    fetch(want.browser_download_url, { headers: { 'User-Agent': 'Sinfonie' }, signal: AbortSignal.timeout(180_000) }).then(async (r) => {
      if (!r.ok) throw new Error(`Download failed (${r.status}).`)
      return Buffer.from(await r.arrayBuffer())
    }),
    fetch(sums.browser_download_url, { headers: { 'User-Agent': 'Sinfonie' }, signal: AbortSignal.timeout(30_000) }).then((r) => r.text())
  ])
  const expected = checksums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find((parts) => parts[1]?.replace(/^\*/, '') === want.name)?.[0]
  const actual = createHash('sha256').update(archive).digest('hex')
  if (!expected || expected.toLowerCase() !== actual) throw new Error('The downloaded GitHub tool did not match its published checksum, so it was thrown away. Try again.')
  const work = join(toolsDir(), `download-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  try {
    const file = join(work, want.name)
    writeFileSync(file, archive)
    const out = join(work, 'x')
    mkdirSync(out)
    const r = want.name.endsWith('.zip')
      ? process.platform === 'darwin'
        ? await run('/usr/bin/ditto', ['-x', '-k', file, out], { env: process.env })
        : await run('unzip', ['-q', file, '-d', out], { env: process.env })
      : await run('tar', ['-xzf', file, '-C', out], { env: process.env })
    if (r.code !== 0) throw new Error(`Could not unpack the GitHub tool: ${text(r)}`)
    const found = findFile(out, 'gh')
    if (!found) throw new Error('The GitHub tool download did not contain the program.')
    mkdirSync(dirname(bundledGhPath()), { recursive: true })
    copyFileSync(found, bundledGhPath())
    chmodSync(bundledGhPath(), 0o755)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  ensureToolsOnPath()
  return bundledGhPath()
}

/** `…/bin/<name>` somewhere under dir. */
function findFile(dir: string, name: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const f = findFile(p, name)
      if (f) return f
    } else if (e.name === name && basename(dir) === 'bin') return p
  }
  return null
}

// ---------- git and Apple's developer tools ----------

/**
 * git's state without ever running /usr/bin/git when Apple's developer tools are missing (that pops up the system
 * installer by itself). A Homebrew git counts even without the developer tools.
 */
export async function gitState(): Promise<GitHubConnection['git']> {
  const own = onPath('git')
  if (process.platform === 'darwin') {
    const brewed = own && own !== '/usr/bin/git' ? own : null
    if (!brewed) {
      const x = await run('/usr/bin/xcode-select', ['-p'], { timeout: 10_000, env: process.env })
      if (x.code !== 0) return 'needs-xcode'
    }
  }
  const r = await run('git', ['--version'], { timeout: 15_000, env: process.env })
  if (r.code === 0 && /git version/.test(r.stdout)) return 'ok'
  return process.platform === 'darwin' ? 'needs-xcode' : 'missing'
}

/** Opens Apple's installer for the developer tools (git comes with them). The person finishes it in the system dialog. */
export async function installXcodeTools(): Promise<void> {
  if (process.platform !== 'darwin') {
    await shell.openExternal('https://git-scm.com/downloads')
    return
  }
  const r = await run('/usr/bin/xcode-select', ['--install'], { timeout: 20_000, env: process.env })
  // "already installed" is fine; anything else: the Apple download page is the fallback.
  if (r.code !== 0 && !/already installed/i.test(text(r))) await shell.openExternal('https://developer.apple.com/download/all/?q=command%20line%20tools')
}

// ---------- the connection ----------

let cached: GitHubConnection | null = null

/** What this Mac has for GitHub. Cached for 30 seconds unless `refresh`. */
export async function connection(refresh = false): Promise<GitHubConnection> {
  if (!refresh && cached && Date.now() - Date.parse(cached.checkedAt) < 30_000) return cached
  const git = await gitState()
  const installed = ghInstalled()
  let signedIn = false
  let login: string | undefined
  if (installed) {
    const s = await gh(['auth', 'status', '--hostname', 'github.com'], undefined, 20_000)
    signedIn = s.code === 0
    if (signedIn) login = /account\s+(\S+)/i.exec(text(s))?.[1] ?? /Logged in to github\.com as\s+(\S+)/i.exec(text(s))?.[1]
  }
  const identity: GitHubConnection['identity'] = {}
  if (git === 'ok') {
    identity.name = (await run('git', ['config', '--global', 'user.name'], { env: process.env })).stdout.trim() || undefined
    identity.email = (await run('git', ['config', '--global', 'user.email'], { env: process.env })).stdout.trim() || undefined
  }
  cached = { git, gh: installed ? 'ok' : 'missing', ...(installed ? { ghBundled: ghIsBundled() } : {}), signedIn, ...(login ? { login } : {}), identity, checkedAt: new Date().toISOString() }
  return cached
}

// ---------- Connect GitHub (gh auth login --web in a pty) ----------

const DEVICE_URL = 'https://github.com/login/device'
let emitConnect: ((s: GitHubConnectState) => void) | null = null
export function setConnectEmitter(fn: (s: GitHubConnectState) => void): void {
  emitConnect = fn
}
let lastState: GitHubConnectState = { phase: 'idle' }
function report(s: GitHubConnectState): void {
  lastState = s
  emitConnect?.(s)
}
let active: { tid: string | null; cancelled: boolean } | null = null

/** The current state of Connect GitHub (for a screen that opens mid-flow). */
export const connectState = (): GitHubConnectState => lastState

/**
 * Connect GitHub from inside the app: download gh when missing, run its browser sign-in in a pty, surface the
 * one-time code (the screen shows it with Copy and opens github.com/login/device), then `gh auth setup-git`.
 * Progress goes out through the connect emitter; a second call while one runs only repeats the current state.
 */
export function connect(): void {
  if (active) return report(lastState)
  const me = { tid: null as string | null, cancelled: false }
  active = me
  void (async () => {
    try {
      report({ phase: 'checking' })
      const git = await gitState()
      if (git !== 'ok') return report({ phase: 'failed', missing: 'xcode', message: 'Apple’s developer tools are needed first. Install them, then connect GitHub.' })
      if (!ghInstalled()) {
        report({ phase: 'installing' })
        await installGh()
      }
      if (me.cancelled) return
      const pre = await gh(['auth', 'status', '--hostname', 'github.com'])
      if (pre.code === 0) return await finish(me)
      report({ phase: 'starting' })
      await login(me)
      if (me.cancelled) return
      await finish(me)
    } catch (err) {
      if (me.cancelled) return
      logError('github:connect', err)
      report({ phase: 'failed', message: plainConnectError(err) })
    } finally {
      if (active === me) active = null
    }
  })()
}

/** Fixed plain sentences only; the raw error is logged by the caller (logError). */
function plainConnectError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|timed out/i.test(msg)) return 'Sinfonie could not reach GitHub. Check your connection and try again.'
  if (/checksum/i.test(msg)) return 'The GitHub tool Sinfonie downloaded did not pass its safety check, so it was thrown away. Try again.'
  if (/download|unpack|did not list|did not contain/i.test(msg)) return 'Sinfonie could not download the GitHub tool it needs. Try again in a few minutes.'
  if (/expired/i.test(msg)) return 'The code expired before it was entered on GitHub. Try again and enter the new code.'
  if (/denied|cancel/i.test(msg)) return 'Access was not approved on GitHub. Try again if that was a mistake.'
  return 'Connecting GitHub did not finish. Try again.'
}

/** Runs `gh auth login --web` in a pty and answers its prompts. Resolves when it exits successfully. */
function login(me: { tid: string | null; cancelled: boolean }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const bin = ghPath().replace(/'/g, `'\\''`)
    // GH_BROWSER=true: pressing Enter must not open a second browser tab; the app opens github.com itself.
    const env = { ...process.env, GH_BROWSER: 'true', BROWSER: 'true', GH_NO_UPDATE_NOTIFIER: '1' }
    delete (env as Record<string, string | undefined>).GH_PROMPT_DISABLED
    let buffer = ''
    let code: string | null = null
    let answeredGit = false
    let pressedEnter = false
    let answeredReauth = false
    me.tid = createTerminal(
      homedir(),
      env,
      (tid, d) => {
        buffer = (buffer + d.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(-8000)
        if (!answeredGit && /Authenticate Git with your GitHub credentials/i.test(buffer)) {
          answeredGit = true
          writeTerminal(tid, 'Y\r')
        }
        if (!answeredReauth && /re-?authenticate/i.test(buffer) && /already logged in/i.test(buffer)) {
          answeredReauth = true
          writeTerminal(tid, 'n\r')
        }
        const m = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(buffer)
        if (m && m[1] !== code) {
          code = m[1]
          report({ phase: 'code', code, url: DEVICE_URL })
        }
        if (code && !pressedEnter && /Press Enter/i.test(buffer)) {
          pressedEnter = true
          writeTerminal(tid, '\r')
        }
      },
      (_tid, exit) => {
        me.tid = null
        if (me.cancelled) return resolve()
        if (exit === 0 || /Logged in as|Authentication complete/i.test(buffer)) return resolve()
        const lines = buffer.trim().split('\n').map((l) => l.trim()).filter(Boolean)
        reject(new Error(lines.find((l) => /error|expired|denied/i.test(l)) ?? lines.at(-1) ?? `gh exited ${exit}`))
      },
      `'${bin}' auth login --web --git-protocol https --hostname github.com`
    )
  })
}

async function finish(me: { cancelled: boolean }): Promise<void> {
  if (me.cancelled) return
  report({ phase: 'finishing' })
  await gh(['auth', 'setup-git', '--hostname', 'github.com'])
  identityCache = null
  const c = await connection(true)
  if (!c.signedIn) throw new Error('GitHub did not confirm the sign-in.')
  report({ phase: 'done', login: c.login })
}

/** Stops a Connect GitHub in progress. */
export function cancelConnect(): void {
  if (!active) return
  active.cancelled = true
  if (active.tid) disposeTerminal(active.tid)
  active = null
  report({ phase: 'cancelled' })
}

// ---------- git identity ----------

let identityCache: { name: string; email: string } | null = null

/** Who commits: the GitHub account when signed in, else the Sinfonie account, else this Mac's user. */
async function fallbackIdentity(): Promise<{ name: string; email: string }> {
  if (identityCache) return identityCache
  if (ghInstalled()) {
    const r = await gh(['api', 'user'], undefined, 15_000)
    if (r.code === 0) {
      try {
        const u = JSON.parse(r.stdout) as { login: string; id: number; name?: string | null; email?: string | null }
        identityCache = { name: u.name || u.login, email: u.email || `${u.id}+${u.login}@users.noreply.github.com` }
        return identityCache
      } catch {
        // fall through
      }
    }
  }
  const acct = getStore().get().settings.cloud?.account
  const email = acct?.emails?.[0]?.email
  if (acct && email) return { name: acct.user.name || acct.user.login, email }
  const who = userInfo().username
  return { name: who, email: `${who}@${hostname()}` }
}

/**
 * Makes sure commits in this app have an author: when git has no user.email (for the app or globally), set one
 * for this app only, from GitHub or the Sinfonie account. Never touches the person's global git settings.
 */
export async function ensureIdentity(repoPath: string): Promise<void> {
  const has = (await run('git', ['config', 'user.email'], { cwd: repoPath, env: process.env })).stdout.trim()
  if (has) return
  const id = await fallbackIdentity()
  await run('git', ['config', '--local', 'user.name', id.name], { cwd: repoPath, env: process.env })
  await run('git', ['config', '--local', 'user.email', id.email], { cwd: repoPath, env: process.env })
}

// ---------- one app's access ----------

/** owner/name from a github.com remote URL, else null. */
export function githubNameWithOwner(remote: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/** Can this Mac send changes of this app to GitHub? */
export async function repoAccess(repoPath: string): Promise<RepoGitHubAccess> {
  const identity = Boolean((await run('git', ['config', 'user.email'], { cwd: repoPath, env: process.env })).stdout.trim())
  const origin = (await run('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, env: process.env })).stdout.trim()
  if (!origin) return { remote: 'none', identity }
  const nwo = githubNameWithOwner(origin)
  if (!nwo) return { remote: 'other', identity }
  const out: RepoGitHubAccess = { remote: 'github', nameWithOwner: nwo, identity }
  if (!ghInstalled()) return out
  // After Make your own copy, changes go to the copy: that is the one this account must be able to push to.
  const pushTo = await pushRemote(repoPath)
  const pushNwo = pushTo === 'origin' ? nwo : (githubNameWithOwner((await run('git', ['remote', 'get-url', pushTo], { cwd: repoPath, env: process.env })).stdout.trim()) ?? nwo)
  const r = await gh(['repo', 'view', pushNwo, '--json', 'viewerPermission'], repoPath, 20_000)
  if (r.code === 0) {
    try {
      const p = (JSON.parse(r.stdout) as { viewerPermission?: string }).viewerPermission ?? ''
      out.permission = p
      out.canPush = ['ADMIN', 'MAINTAIN', 'WRITE'].includes(p)
    } catch {
      // unknown
    }
  } else if (/Could not resolve to a Repository/i.test(text(r))) out.canPush = false
  return out
}

/**
 * Puts an app that is not on GitHub yet onto the signed-in account, private: `gh repo create --private
 * --source <app> --push`. Returns owner/name.
 */
export async function publishRepo(repoPath: string, name: string): Promise<string> {
  await ensureIdentity(repoPath)
  const slug = name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-app'
  // An app without a single saved version cannot be pushed; save one first. Never `git add -A` here: only what the
  // person already staged goes in (initFolder saved the files, with the safety checks, for apps set up in Sinfonie).
  const head = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoPath, env: process.env })
  if (head.code !== 0) await run('git', ['commit', '-m', 'First version', '--allow-empty'], { cwd: repoPath, env: process.env })
  const r = await gh(['repo', 'create', slug, '--private', '--source', repoPath, '--remote', 'origin', '--push'], repoPath, 180_000)
  if (r.code !== 0) {
    const t = text(r)
    if (/already exists/i.test(t)) throw new Error(PLAIN_ERROR_MARK + `You already have an app called ${slug} on GitHub. Rename this app's folder, or ask a teammate to connect the two.`)
    throw new Error(t || 'gh repo create failed')
  }
  const origin = (await run('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, env: process.env })).stdout.trim()
  return githubNameWithOwner(origin) ?? slug
}

/** The remote Sinfonie pushes to (`remote.pushDefault`, set by forkRepo), else origin. Shared by all worktrees. */
export async function pushRemote(repoPath: string): Promise<string> {
  const name = (await run('git', ['config', '--get', 'remote.pushDefault'], { cwd: repoPath, env: process.env })).stdout.trim()
  if (!name || name === 'origin') return 'origin'
  const url = (await run('git', ['remote', 'get-url', name], { cwd: repoPath, env: process.env })).stdout.trim()
  return url ? name : 'origin'
}

/**
 * Makes the signed-in account its own copy (fork) of an app it may not change and sends changes there: `origin`
 * stays the original (team sync, app keys and look-only rules are keyed by it, and reviews go there), the copy is
 * added as the remote `fork`, and `remote.pushDefault = fork` records where pushes go.
 */
export async function forkRepo(repoPath: string): Promise<string> {
  const origin = (await run('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, env: process.env })).stdout.trim()
  const parent = githubNameWithOwner(origin)
  if (!parent) throw new Error('This app is not on GitHub.')
  if (!(await run('git', ['remote', 'get-url', 'fork'], { cwd: repoPath, env: process.env })).stdout.trim()) {
    const r = await gh(['repo', 'fork', '--remote', '--remote-name', 'fork'], repoPath, 180_000)
    if (r.code !== 0) throw new Error(text(r) || 'gh repo fork failed')
  }
  await run('git', ['config', 'remote.pushDefault', 'fork'], { cwd: repoPath, env: process.env })
  // Reviews go to the original: make it gh's default repository here.
  await gh(['repo', 'set-default', parent], repoPath)
  const fork = (await run('git', ['remote', 'get-url', 'fork'], { cwd: repoPath, env: process.env })).stdout.trim()
  return githubNameWithOwner(fork) ?? parent
}

/**
 * The --head for `gh pr create` (opened against origin): the plain branch, or `forkOwner:branch` when pushes go to
 * the person's own copy (after forkRepo).
 */
export async function prHead(worktreePath: string, branch: string): Promise<string> {
  const remote = await pushRemote(worktreePath)
  if (remote === 'origin') return branch
  const origin = githubNameWithOwner((await run('git', ['remote', 'get-url', 'origin'], { cwd: worktreePath, env: process.env })).stdout.trim())
  const fork = githubNameWithOwner((await run('git', ['remote', 'get-url', remote], { cwd: worktreePath, env: process.env })).stdout.trim())
  if (!origin || !fork || origin.toLowerCase() === fork.toLowerCase()) return branch
  return `${fork.split('/')[0]}:${branch}`
}

/** Merges a pull request the person opened on their own app (the solo "Publish" path). Only github.com links. */
export async function mergePr(worktreePath: string, url: string): Promise<void> {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/.test(url)) throw new Error('Not a GitHub pull request link: ' + url)
  const r = await gh(['pr', 'merge', url, '--squash'], worktreePath, 120_000)
  if (r.code !== 0) throw new Error(text(r) || 'gh pr merge failed')
}

// ---------- folders ----------

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolvePath(p)
  }
}

/** Folders that are never "one app": the disk, the home folder and the big personal folders in it. */
function unsafeFolder(abs: string): boolean {
  const home = homedir()
  const never = ['/', '/Applications', '/Users', '/Volumes', '/System', '/Library', home, dirname(home), ...['Desktop', 'Documents', 'Downloads', 'Library', 'Pictures', 'Movies', 'Music', 'Public', 'Library/Mobile Documents', 'Library/Mobile Documents/com~apple~CloudDocs'].map((d) => join(home, d))]
  const r = real(abs)
  return never.some((n) => real(n) === r)
}

/**
 * What a folder picked as "my app" is: an app, inside one (use its top), a plain folder, git is missing, or a folder
 * that is too big a thing to be one app. Never runs git when Apple's developer tools are missing (gitState).
 * Shared by the guided wizard and the expert "Add a repository from disk".
 */
export async function inspectFolder(path: string): Promise<FolderKind> {
  const abs = resolvePath(path)
  if (unsafeFolder(abs)) return { kind: 'unsafe', path: abs }
  if ((await gitState()) !== 'ok') return { kind: 'needs-git', path: abs }
  const r = await run('git', ['rev-parse', '--show-toplevel'], { cwd: abs, env: process.env })
  if (r.code !== 0) return { kind: 'not-repo', path: abs }
  const top = r.stdout.trim()
  // A home folder that is itself a git repository (dotfiles) is not "the app".
  if (real(top) === real(homedir())) return { kind: 'not-repo', path: abs }
  return real(top) === real(abs) ? { kind: 'repo', path: abs } : { kind: 'inside-repo', path: top }
}

/** Kept out of a first saved version: heavy folders, build output and anything that looks like a secret. */
const IGNORE_LINES = ['node_modules/', '.DS_Store', '.env*', '*.pem', '*.key', '*.p12', 'credentials*', 'id_rsa*', '.aws/', 'dist/', 'build/', '.next/', '.cache/', '.turbo/', '.parcel-cache/', '__pycache__/', '.venv/', 'venv/']
const MAX_FIRST_FILES = 20_000
const MAX_FIRST_BYTES = 500 * 1024 * 1024
const TOO_BIG = 'That folder has too many files to be one app. Pick the folder of the app itself, the one with its own files in it.'

/**
 * "Set this folder up for Sinfonie": git init on main, a .gitignore that keeps out heavy folders and secrets, and a
 * first saved version, refused for well-known personal folders and for folders too big to be one app (the folder is
 * left as it was). Guided and expert both use this.
 */
export async function initFolder(path: string): Promise<string> {
  const k = await inspectFolder(path)
  if (k.kind === 'repo' || k.kind === 'inside-repo') return k.path
  if (k.kind === 'unsafe') throw new Error(PLAIN_ERROR_MARK + 'That folder holds much more than one app. Choose the folder of one app.')
  if (k.kind === 'needs-git') throw new Error(PLAIN_ERROR_MARK + 'Apple’s developer tools are needed first.')
  const abs = k.path
  const ignore = join(abs, '.gitignore')
  const hadIgnore = existsSync(ignore)
  const before = hadIgnore ? readFileSync(ignore, 'utf8') : null
  let r = await run('git', ['init', '-b', 'main'], { cwd: abs, env: process.env })
  if (r.code !== 0) r = await run('git', ['init'], { cwd: abs, env: process.env })
  if (r.code !== 0) throw new Error(text(r))
  const undo = (): void => {
    rmSync(join(abs, '.git'), { recursive: true, force: true })
    if (before === null) rmSync(ignore, { force: true })
    else writeFileSync(ignore, before)
  }
  try {
    await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: abs, env: process.env })
    const have = new Set((before ?? '').split('\n').map((l) => l.trim()))
    const missing = IGNORE_LINES.filter((l) => !have.has(l))
    if (missing.length) writeFileSync(ignore, before === null ? missing.join('\n') + '\n' : `${before.replace(/\n?$/, '\n')}\n# Added by Sinfonie\n${missing.join('\n')}\n`)
    // How much the first version would hold: refuse before anything is saved when it is clearly not one app.
    const listed = await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: abs, env: process.env, timeout: 120_000 })
    if (listed.code !== 0) throw new Error(PLAIN_ERROR_MARK + TOO_BIG)
    const files = listed.stdout.split('\0').filter(Boolean)
    if (files.length > MAX_FIRST_FILES) throw new Error(PLAIN_ERROR_MARK + TOO_BIG)
    let bytes = 0
    for (const f of files) {
      try {
        bytes += statSync(join(abs, f)).size
      } catch {
        // gone meanwhile
      }
      if (bytes > MAX_FIRST_BYTES) throw new Error(PLAIN_ERROR_MARK + TOO_BIG)
    }
    await ensureIdentity(abs)
    await run('git', ['add', '-A'], { cwd: abs, env: process.env, timeout: 120_000 })
    const c = await run('git', ['commit', '-m', 'First version', '--allow-empty'], { cwd: abs, env: process.env, timeout: 120_000 })
    if (c.code !== 0) throw new Error(text(c))
  } catch (err) {
    undo()
    throw err
  }
  return abs
}

// ---------- cloning ----------

const clones = new Map<string, ChildProcess>()

/** Words for a person, per failure kind. */
function cloneMessage(kind: CloneFailure, dest?: string): string {
  switch (kind) {
    case 'needs-github':
      // Not signed in, GitHub answers "not found" for private apps and wrong links alike: say both.
      return 'Sinfonie couldn’t open this app. It may be private, or the link may be wrong.'
    case 'no-access':
      return 'Your GitHub account cannot open this app. Check the link, or ask the app’s owner to give you access.'
    case 'not-found':
      return 'There is no app at that link. Check it, and copy the address of the app’s GitHub page.'
    case 'needs-git':
      return 'Apple’s developer tools are needed to download apps. Install them, then try again.'
    case 'folder-exists':
      return `A different app is already in the folder ${dest ? basename(dest) : ''}. Pick another folder name.`.replace('  ', ' ')
    case 'offline':
      return 'Sinfonie could not reach GitHub. Check your connection and try again.'
    case 'cancelled':
      return 'Download stopped.'
    default:
      return 'Sinfonie could not download that app. Try again, or ask a teammate.'
  }
}

async function classify(out: string): Promise<CloneFailure> {
  if (/Could not resolve host|unable to access.*(Couldn't connect|timed out)|Connection refused|Operation timed out|network is unreachable/i.test(out)) return 'offline'
  if (/xcode-select|developer tools|No developer tools|ENOENT/i.test(out)) return 'needs-git'
  const authish = /could not read Username|Authentication failed|terminal prompts disabled|Invalid username or password|403/i.test(out)
  const notFound = /Repository not found|not found/i.test(out)
  if (authish || notFound) {
    const c = await connection(true)
    if (!c.signedIn) return 'needs-github'
    return notFound ? 'no-access' : 'needs-github'
  }
  return 'other'
}

/**
 * git clone with progress and Cancel, using the GitHub sign-in for private apps. Failures come back as a kind (with
 * plain words), never thrown. An existing checkout of the same app at `dest` is reused.
 */
export async function cloneRepo(url: string, dest: string, onProgress?: (p: CloneProgress) => void): Promise<CloneResult> {
  // Only real remotes: https, ssh and scp-style git@ addresses; never an option or a local/ext transport.
  if (url.startsWith('-') || !/^(https:\/\/|ssh:\/\/|git@)[^\s]+$/i.test(url)) return { ok: false, kind: 'not-found', message: cloneMessage('not-found') }
  if ((await gitState()) !== 'ok') return { ok: false, kind: 'needs-git', message: cloneMessage('needs-git') }
  const want = githubNameWithOwner(url)?.toLowerCase()
  if (existsSync(join(dest, '.git'))) {
    const origin = (await run('git', ['remote', 'get-url', 'origin'], { cwd: dest, env: process.env })).stdout.trim()
    const have = githubNameWithOwner(origin)?.toLowerCase() ?? origin.replace(/\.git$/i, '').toLowerCase()
    if (want ? have === want : have === url.replace(/\.git$/i, '').toLowerCase()) return { ok: true, path: dest }
    return { ok: false, kind: 'folder-exists', message: cloneMessage('folder-exists', dest), dest }
  }
  if (existsSync(dest) && readdirSync(dest).length > 0) return { ok: false, kind: 'folder-exists', message: cloneMessage('folder-exists', dest), dest }
  mkdirSync(dirname(dest), { recursive: true })
  onProgress?.({ url, phase: 'starting' })
  return new Promise<CloneResult>((resolve) => {
    // Same no-prompt environment as git.ts gitNetworkEnv (no terminal to answer; no credential-manager windows).
    const child = spawn('git', ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=user', ...gitCredentialArgs(), 'clone', '--progress', '--', url, dest], { env: ghEnv({ GCM_INTERACTIVE: 'never' }), stdio: ['ignore', 'pipe', 'pipe'] })
    clones.set(url, child)
    let out = ''
    let cancelled = false
    ;(child as ChildProcess & { __cancel?: () => void }).__cancel = () => {
      cancelled = true
      child.kill('SIGTERM')
    }
    const onData = (d: Buffer): void => {
      const s = d.toString()
      out = (out + s).slice(-8000)
      const m = /(Receiving objects|Resolving deltas):\s+(\d+)%/g
      let last: RegExpExecArray | null = null
      for (let x = m.exec(s); x; x = m.exec(s)) last = x
      if (last) onProgress?.({ url, phase: last[1].startsWith('Receiving') ? 'receiving' : 'resolving', percent: Number(last[2]) })
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    let settled = false
    const done = async (code: number | null, spawnErr?: Error): Promise<void> => {
      if (settled) return
      settled = true
      clones.delete(url)
      if (code === 0 && !cancelled) {
        onProgress?.({ url, phase: 'done', percent: 100 })
        return resolve({ ok: true, path: dest })
      }
      // A half-finished clone leaves a folder behind (dest was absent or empty before): remove it so a retry starts clean.
      rmSync(dest, { recursive: true, force: true })
      if (cancelled) return resolve({ ok: false, kind: 'cancelled', message: cloneMessage('cancelled') })
      const kind = spawnErr ? 'needs-git' : await classify(out)
      resolve({ ok: false, kind, message: cloneMessage(kind, dest) })
    }
    child.on('error', (e) => void done(null, e))
    child.on('close', (code) => void done(code))
  })
}

/** Stops the clone of `url`, if one runs. */
export function cancelClone(url: string): void {
  const c = clones.get(url) as (ChildProcess & { __cancel?: () => void }) | undefined
  c?.__cancel?.()
}
