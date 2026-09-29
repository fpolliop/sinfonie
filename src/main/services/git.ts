import { simpleGit, type SimpleGit } from 'simple-git'
import { existsSync, readFileSync, writeFileSync, lstatSync, realpathSync, statSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { createHash } from 'crypto'
import type { ChangeScope, ChangedFileStat, ConductorConfig, GitFileStatus } from '@shared/types'

export function git(cwd: string): SimpleGit {
  return simpleGit({ baseDir: cwd, maxConcurrentProcesses: 4 })
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const top = (await git(path).revparse(['--show-toplevel'])).trim()
    return top === path || top === path.replace(/\/$/, '')
  } catch {
    return false
  }
}

export async function detectDefaultBranch(path: string): Promise<string> {
  const g = git(path)
  try {
    const ref = (await g.raw(['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim()
    const name = ref.replace('refs/remotes/origin/', '')
    if (name) return name
  } catch {
    /* no origin/HEAD */
  }
  const branches = await g.branchLocal()
  if (branches.all.includes('main')) return 'main'
  if (branches.all.includes('master')) return 'master'
  return branches.current || 'main'
}

export function readConductorConfig(repoPath: string): ConductorConfig | null {
  // sinfonie.json is the app's own file; conductor.json is honoured so existing repos need no change.
  const file = ['sinfonie.json', 'conductor.json'].map((n) => join(repoPath, n)).find((f) => existsSync(f))
  if (!file) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ConductorConfig
  } catch (err) {
    console.error(`Invalid ${file} in ${repoPath}`, err)
    return null
  }
}

/**
 * Writes sinfonie.json for a repo, merging the patch into whatever is there (or conductor.json's content).
 * Empty strings clear a script or the preview URL. Returns the config as re-read from disk.
 */
export function writeConductorConfig(
  repoPath: string,
  patch: { scripts?: Partial<NonNullable<ConductorConfig['scripts']>>; preview?: string; runScriptMode?: ConductorConfig['runScriptMode'] }
): ConductorConfig {
  const current = readConductorConfig(repoPath) ?? {}
  const next: ConductorConfig = { ...current }
  if (patch.scripts) {
    const scripts: Record<string, unknown> = { ...(current.scripts ?? {}) }
    for (const [k, v] of Object.entries(patch.scripts)) {
      if (v === undefined) continue
      if (v === '') delete scripts[k]
      else scripts[k] = v
    }
    if (Object.keys(scripts).length) next.scripts = scripts as ConductorConfig['scripts']
    else delete next.scripts
  }
  if (patch.preview !== undefined) {
    if (patch.preview === '') delete next.preview
    else next.preview = patch.preview
  }
  if (patch.runScriptMode !== undefined) next.runScriptMode = patch.runScriptMode
  writeFileSync(join(repoPath, 'sinfonie.json'), JSON.stringify(next, null, 2) + '\n')
  return next
}

export async function listBranches(repoPath: string): Promise<string[]> {
  const g = git(repoPath)
  const local = await g.branchLocal()
  let remote: string[] = []
  try {
    const r = await g.branch(['-r'])
    remote = r.all
      .filter((b) => !b.endsWith('/HEAD'))
      .map((b) => b.replace(/^origin\//, ''))
  } catch {
    /* no remotes */
  }
  return Array.from(new Set([...local.all, ...remote])).sort()
}

/**
 * Create a worktree at `worktreePath` on a new branch `branch` cut from
 * `baseBranch`. Fetches first so the base is fresh, then prefers the remote
 * ref when it exists.
 */
export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string
): Promise<void> {
  const g = git(repoPath)
  try {
    await g.fetch(['origin', baseBranch])
  } catch {
    /* offline or no origin: fall back to local */
  }
  let startPoint = baseBranch
  try {
    await g.revparse(['--verify', `origin/${baseBranch}`])
    startPoint = `origin/${baseBranch}`
  } catch {
    /* local only */
  }
  const branchExists = (await g.branchLocal()).all.includes(branch)
  if (branchExists) {
    await g.raw(['worktree', 'add', worktreePath, branch])
    return
  }
  // A teammate may have pushed this branch already: start from theirs and track it.
  let remoteBranch = false
  try {
    await g.fetch(['origin', branch])
    await g.revparse(['--verify', `origin/${branch}`])
    remoteBranch = true
  } catch {
    /* not on origin */
  }
  if (remoteBranch) {
    await g.raw(['worktree', 'add', '--track', '-b', branch, worktreePath, `origin/${branch}`])
  } else {
    await g.raw(['worktree', 'add', '-b', branch, worktreePath, startPoint])
  }
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  deleteBranch: boolean
): Promise<void> {
  const g = git(repoPath)
  if (existsSync(worktreePath)) {
    await g.raw(['worktree', 'remove', '--force', worktreePath])
  }
  await g.raw(['worktree', 'prune'])
  if (deleteBranch) {
    try {
      await g.raw(['branch', '-D', branch])
    } catch (err) {
      console.warn(`Could not delete branch ${branch}`, err)
    }
  }
}

export async function renameBranch(worktreePath: string, newBranch: string): Promise<void> {
  await git(worktreePath).raw(['branch', '-m', newBranch])
}

/** Commits on HEAD that no remote has: relative to the upstream when tracked, else to origin/<base>. */
export async function unpushedCount(worktreePath: string, baseBranch: string): Promise<{ count: number; hasUpstream: boolean }> {
  const g = git(worktreePath)
  const tracked = await hasUpstream(worktreePath)
  const ref = tracked ? '@{upstream}' : `origin/${baseBranch}`
  try {
    const out = await g.raw(['rev-list', '--count', `${ref}..HEAD`])
    return { count: Number(out.trim()) || 0, hasUpstream: tracked }
  } catch {
    try {
      const out = await g.raw(['rev-list', '--count', `${baseBranch}..HEAD`])
      return { count: Number(out.trim()) || 0, hasUpstream: tracked }
    } catch {
      return { count: 0, hasUpstream: tracked }
    }
  }
}

export async function hasUpstream(worktreePath: string): Promise<boolean> {
  try {
    await git(worktreePath).raw(['rev-parse', '--abbrev-ref', '@{upstream}'])
    return true
  } catch {
    return false
  }
}

/** After GitHub renamed origin/<old> to origin/<new>, refresh refs and track the new one. */
export async function retrackAfterRemoteRename(worktreePath: string, oldBranch: string, newBranch: string): Promise<void> {
  const g = git(worktreePath)
  await g.fetch(['origin', '--prune'])
  try {
    await g.raw(['branch', `--set-upstream-to=origin/${newBranch}`, newBranch])
  } catch {
    /* remote ref not visible yet; next push -u fixes it */
  }
  void oldBranch
}

export async function status(worktreePath: string): Promise<{
  branch: string
  ahead: number
  behind: number
  hasUpstream: boolean
  files: GitFileStatus[]
}> {
  const s = await git(worktreePath).status()
  const files: GitFileStatus[] = s.files.map((f) => ({
    path: f.path,
    status: (f.index !== ' ' && f.index !== '?' ? f.index : f.working_dir) || '?',
    staged: f.index !== ' ' && f.index !== '?'
  }))
  return {
    branch: s.current ?? '',
    ahead: s.ahead,
    behind: s.behind,
    hasUpstream: Boolean(s.tracking),
    files
  }
}

/** The file as committed at HEAD, relative to the worktree; null when HEAD has no such file. */
export async function showHead(worktreePath: string, path: string): Promise<string | null> {
  try {
    return await git(worktreePath).show([`HEAD:${path}`])
  } catch {
    return null
  }
}

export async function diff(worktreePath: string, path?: string): Promise<string> {
  const g = git(worktreePath)
  const args = ['--no-color']
  if (path) args.push('--', path)
  // Working tree vs HEAD, including staged changes and untracked files.
  const tracked = await g.diff(['HEAD', ...args]).catch(() => g.diff(args))
  const untracked = (await g.raw(['ls-files', '--others', '--exclude-standard', ...(path ? ['--', path] : [])]))
    .split('\n')
    .filter(Boolean)
  let extra = ''
  for (const file of untracked) {
    try {
      extra += await g.raw(['diff', '--no-color', '--no-index', '/dev/null', file])
    } catch (e: unknown) {
      // git diff --no-index exits 1 when files differ; simple-git throws with the output attached.
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('diff --git')) extra += msg
    }
  }
  return tracked + extra
}

/**
 * What a scope compares the working tree with: HEAD for uncommitted work, or the merge-base with the base branch
 * (origin's copy first) for the whole branch. Null when there is nothing to compare with (no commits yet).
 */
async function scopeRef(worktreePath: string, scope: ChangeScope, baseBranch: string): Promise<string | null> {
  const g = git(worktreePath)
  if (scope === 'branch') {
    for (const ref of [`origin/${baseBranch}`, baseBranch]) {
      try {
        const mb = (await g.raw(['merge-base', 'HEAD', ref])).trim()
        if (mb) return mb
      } catch {
        /* try the next ref */
      }
    }
  }
  try {
    return (await g.raw(['rev-parse', '--verify', 'HEAD'])).trim() || null
  } catch {
    return null
  }
}

const UNTRACKED_COUNTED = 200
const UNTRACKED_MAX_BYTES = 1_048_576

/** Lines in an untracked file, read from disk (no git process); null for binary, large or unreadable files. */
function untrackedLines(file: string): number | null {
  try {
    if (statSync(file).size > UNTRACKED_MAX_BYTES) return null
    const buf = readFileSync(file)
    if (buf.includes(0)) return null
    if (buf.length === 0) return 0
    let n = 0
    for (const b of buf) if (b === 10) n++
    return buf[buf.length - 1] === 10 ? n : n + 1
  } catch {
    return null
  }
}

/**
 * Every changed file in a worktree with its +/− counts, in two git processes plus one for untracked files:
 * uncommitted work (against HEAD) or the whole branch (against the merge-base with the base branch). Untracked
 * files are counted from disk, the first few hundred only.
 */
export async function changes(worktreePath: string, scope: ChangeScope, baseBranch: string): Promise<{ base: string | null; files: ChangedFileStat[] }> {
  const g = git(worktreePath)
  const base = await scopeRef(worktreePath, scope, baseBranch)
  const against = base ? [base] : []
  const [numstat, names, untracked] = await Promise.all([
    g.raw(['diff', '--numstat', '--no-renames', ...against]).catch(() => ''),
    g.raw(['diff', '--name-status', '--no-renames', ...against]).catch(() => ''),
    g.raw(['ls-files', '--others', '--exclude-standard']).catch(() => '')
  ])
  const statusOf = new Map<string, string>()
  for (const line of names.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab > 0) statusOf.set(line.slice(tab + 1), line.slice(0, 1))
  }
  const files: ChangedFileStat[] = []
  for (const line of numstat.split('\n')) {
    const [a, d, ...rest] = line.split('\t')
    const path = rest.join('\t')
    if (!path) continue
    const binary = a === '-' && d === '-'
    files.push({ path, adds: binary ? null : Number(a) || 0, dels: binary ? null : Number(d) || 0, status: statusOf.get(path) ?? 'M', binary })
  }
  untracked
    .split('\n')
    .filter(Boolean)
    .forEach((path, i) => {
      const lines = i < UNTRACKED_COUNTED ? untrackedLines(join(worktreePath, path)) : null
      files.push({ path, adds: lines, dels: 0, status: '?', binary: false })
    })
  return { base, files }
}

/** One file's unified diff in a scope; untracked files show as entirely added. */
export async function fileDiff(worktreePath: string, scope: ChangeScope, baseBranch: string, path: string): Promise<string> {
  const g = git(worktreePath)
  const base = await scopeRef(worktreePath, scope, baseBranch)
  const tracked = await g.diff(['--no-color', ...(base ? [base] : []), '--', path]).catch(() => '')
  if (tracked) return tracked
  const isUntracked = (await g.raw(['ls-files', '--others', '--exclude-standard', '--', path]).catch(() => '')).trim()
  if (!isUntracked) return ''
  try {
    return await g.raw(['diff', '--no-color', '--no-index', '--', '/dev/null', path])
  } catch (e: unknown) {
    // git diff --no-index exits 1 when files differ; simple-git throws with the output attached.
    const msg = e instanceof Error ? e.message : String(e)
    return msg.includes('diff --git') ? msg.slice(msg.indexOf('diff --git')) : ''
  }
}

/**
 * The absolute path of a file inside a worktree, refusing anything that is a symlink or resolves outside it.
 * A missing file is allowed (a deleted file can be brought back), as long as its folder is inside.
 */
function insideWorktree(worktreePath: string, path: string): string {
  if (isAbsolute(path)) throw new Error('Expected a path relative to the repository.')
  const root = realpathSync(worktreePath)
  const abs = resolve(worktreePath, path)
  const rel = relative(resolve(worktreePath), abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${path} is outside the repository.`)
  let real: string
  if (existsSync(abs)) {
    if (lstatSync(abs).isSymbolicLink()) throw new Error(`${path} is a symbolic link; revert it in the terminal instead.`)
    real = realpathSync(abs)
  } else real = join(realpathSync(resolve(abs, '..')), abs.slice(abs.lastIndexOf(sep) + 1))
  if (!real.startsWith(root + sep)) throw new Error(`${path} is outside the repository.`)
  return abs
}

const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

/**
 * Revert one modified, tracked file to HEAD with git itself (so filters, LFS and line endings apply), staged and
 * unstaged changes both. Returns the bytes it replaced, for Undo, and the hash of what git wrote.
 */
export async function restoreFile(worktreePath: string, path: string): Promise<{ saved: string; hash: string }> {
  const abs = insideWorktree(worktreePath, path)
  const g = git(worktreePath)
  const st = (await g.raw(['status', '--porcelain', '--', path])).split('\n').find(Boolean) ?? ''
  if (!/^(M.|.M)\s/.test(st) || !existsSync(abs)) throw new Error('Only a changed file that is already tracked can be reverted here.')
  const saved = readFileSync(abs)
  await g.raw(['restore', '--source=HEAD', '--staged', '--worktree', '--', path])
  return { saved: saved.toString('base64'), hash: sha(readFileSync(abs)) }
}

/** Undo a restore: put the saved bytes back, only if the file is still exactly what the restore left. */
export function undoRestore(worktreePath: string, path: string, saved: string, hash: string): void {
  const abs = insideWorktree(worktreePath, path)
  if (!existsSync(abs) || sha(readFileSync(abs)) !== hash) throw new Error('The file changed after it was reverted, so the undo was skipped to keep those changes.')
  writeFileSync(abs, Buffer.from(saved, 'base64'))
}

export async function commitAll(worktreePath: string, message: string): Promise<string> {
  const g = git(worktreePath)
  await g.add(['-A'])
  const r = await g.commit(message)
  return r.commit
}

/** Commits everything in a worktree only if it is dirty, for guided-mode checkpoints. Returns the SHA, or null. */
export async function checkpoint(worktreePath: string, message: string): Promise<string | null> {
  const g = git(worktreePath)
  const s = await g.status()
  if (s.isClean()) return null
  await g.add(['-A'])
  const r = await g.commit(message)
  return r.commit || null
}

export async function push(worktreePath: string): Promise<string> {
  const g = git(worktreePath)
  const branch = (await g.revparse(['--abbrev-ref', 'HEAD'])).trim()
  const r = await g.push(['-u', 'origin', branch])
  return r.remoteMessages?.all.join('\n') ?? `pushed ${branch}`
}
