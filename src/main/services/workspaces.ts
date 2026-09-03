import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import type { CreateWorkspaceInput, Repo, ScriptOutputEvent, Workspace, WorkspaceRepo } from '@shared/types'
import { getStore } from '../store'
import * as git from './git'
import { runScript, stopAllScripts } from './scripts'

type Emit = (event: ScriptOutputEvent) => void

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'workspace'
  )
}

function uniqueSlug(base: string): string {
  const taken = new Set(getStore().get().workspaces.map((w) => w.slug))
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

function allocatePort(): number {
  const { workspaces, settings } = getStore().get()
  const used = new Set(workspaces.filter((w) => w.status !== 'archived').map((w) => w.port))
  let port = settings.basePort
  while (used.has(port)) port += 10
  return port
}

export function getRepo(repoId: string): Repo {
  const repo = getStore().get().repos.find((r) => r.id === repoId)
  if (!repo) throw new Error(`Unknown repo ${repoId}`)
  return repo
}

export function getWorkspace(workspaceId: string): Workspace {
  const ws = getStore().get().workspaces.find((w) => w.id === workspaceId)
  if (!ws) throw new Error(`Unknown workspace ${workspaceId}`)
  return ws
}

export function patchWorkspace(id: string, patch: Partial<Workspace>): Workspace {
  let out: Workspace | undefined
  getStore().update((d) => {
    const ws = d.workspaces.find((w) => w.id === id)
    if (ws) {
      Object.assign(ws, patch)
      out = ws
    }
  })
  if (!out) throw new Error(`Unknown workspace ${id}`)
  return out
}

/**
 * The core of the app: one workspace = one worktree per selected repo, all
 * on the same branch name, under one folder. Setup scripts run per repo.
 */
export async function createWorkspace(input: CreateWorkspaceInput, emit: Emit): Promise<Workspace> {
  if (input.repos.length === 0) throw new Error('Pick at least one repository')
  const { settings } = getStore().get()
  const slug = uniqueSlug(slugify(input.name))
  const rootPath = join(settings.workspacesRoot, slug)
  const repos = input.repos.map((r) => getRepo(r.repoId))
  const primaryRepoId = input.primaryRepoId ?? input.repos[0].repoId

  const wsRepos: WorkspaceRepo[] = input.repos.map((r, i) => ({
    repoId: r.repoId,
    repoName: repos[i].name,
    worktreePath: join(rootPath, repos[i].name),
    branch: slug,
    baseBranch: r.baseBranch || repos[i].defaultBranch
  }))

  const ws: Workspace = {
    id: nanoid(10),
    name: input.name.trim() || slug,
    slug,
    rootPath,
    repos: wsRepos,
    primaryRepoId,
    port: allocatePort(),
    status: 'creating',
    createdAt: new Date().toISOString()
  }
  getStore().update((d) => d.workspaces.push(ws))

  try {
    mkdirSync(rootPath, { recursive: true })
    for (const wr of wsRepos) {
      const repo = getRepo(wr.repoId)
      await git.createWorktree(repo.path, wr.worktreePath, wr.branch, wr.baseBranch)
    }
    // Setup scripts run after every worktree exists, so a script in one repo
    // can reference the sibling worktree via ORCHESTRA_WORKSPACE_ROOT.
    await Promise.all(
      wsRepos.map(async (wr) => {
        const repo = getRepo(wr.repoId)
        const cmd = repo.config?.scripts?.setup
        if (cmd) await runScript(ws, repo, wr.worktreePath, 'setup', cmd, emit)
      })
    )
    return patchWorkspace(ws.id, { status: 'ready' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return patchWorkspace(ws.id, { status: 'error', error: message })
  }
}

export async function archiveWorkspace(
  workspaceId: string,
  opts: { deleteBranches: boolean },
  emit: Emit
): Promise<Workspace> {
  const ws = getWorkspace(workspaceId)
  patchWorkspace(ws.id, { status: 'archiving' })
  stopAllScripts(ws.id)
  for (const wr of ws.repos) {
    let repo: Repo | null = null
    try {
      repo = getRepo(wr.repoId)
    } catch {
      /* repo was removed from the app; still try to clean the folder */
    }
    if (repo) {
      const cmd = repo.config?.scripts?.archive
      if (cmd && existsSync(wr.worktreePath)) await runScript(ws, repo, wr.worktreePath, 'archive', cmd, emit)
      try {
        await git.removeWorktree(repo.path, wr.worktreePath, wr.branch, opts.deleteBranches)
      } catch (err) {
        console.warn('worktree removal failed, falling back to rm', err)
      }
    }
    if (existsSync(wr.worktreePath)) rmSync(wr.worktreePath, { recursive: true, force: true })
  }
  if (existsSync(ws.rootPath)) rmSync(ws.rootPath, { recursive: true, force: true })
  return patchWorkspace(ws.id, { status: 'archived', archivedAt: new Date().toISOString() })
}

export function deleteWorkspaceRecord(workspaceId: string): void {
  getStore().update((d) => {
    d.workspaces = d.workspaces.filter((w) => w.id !== workspaceId)
  })
}

export function renameWorkspace(workspaceId: string, name: string): Workspace {
  return patchWorkspace(workspaceId, { name: name.trim() || getWorkspace(workspaceId).name })
}

/** Rename the branch in every worktree of the workspace at once. */
export async function renameWorkspaceBranch(workspaceId: string, branch: string): Promise<Workspace> {
  const ws = getWorkspace(workspaceId)
  const clean = branch.trim()
  if (!clean) throw new Error('Branch name is empty')
  for (const wr of ws.repos) {
    await git.renameBranch(wr.worktreePath, clean)
  }
  return patchWorkspace(ws.id, { repos: ws.repos.map((r) => ({ ...r, branch: clean })) })
}

export async function runWorkspaceScript(workspaceId: string, kind: 'setup' | 'run', emit: Emit): Promise<void> {
  const ws = getWorkspace(workspaceId)
  const jobs = ws.repos.map(async (wr) => {
    const repo = getRepo(wr.repoId)
    const cmd = repo.config?.scripts?.[kind]
    if (!cmd) {
      emit({ workspaceId: ws.id, repoId: repo.id, kind, data: `[no ${kind} script in conductor.json]\r\n`, done: true, exitCode: 0 })
      return
    }
    await runScript(ws, repo, wr.worktreePath, kind, cmd, emit)
  })
  const mode = ws.repos.map((wr) => getRepo(wr.repoId).config?.runScriptMode).find(Boolean) ?? 'concurrent'
  if (mode === 'sequential') {
    for (const j of jobs) await j
  } else {
    await Promise.all(jobs)
  }
}
