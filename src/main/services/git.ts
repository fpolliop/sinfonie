import { simpleGit, type SimpleGit } from 'simple-git'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ConductorConfig, GitFileStatus } from '@shared/types'

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
  const file = join(repoPath, 'conductor.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ConductorConfig
  } catch (err) {
    console.error(`Invalid conductor.json in ${repoPath}`, err)
    return null
  }
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

export async function commitAll(worktreePath: string, message: string): Promise<string> {
  const g = git(worktreePath)
  await g.add(['-A'])
  const r = await g.commit(message)
  return r.commit
}

export async function push(worktreePath: string): Promise<string> {
  const g = git(worktreePath)
  const branch = (await g.revparse(['--abbrev-ref', 'HEAD'])).trim()
  const r = await g.push(['-u', 'origin', branch])
  return r.remoteMessages?.all.join('\n') ?? `pushed ${branch}`
}
