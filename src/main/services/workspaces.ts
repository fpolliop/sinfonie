import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import type { CreateWorkspaceInput, Repo, RepoSafety, ScriptOutputEvent, Workspace, WorkspaceRepo, WorkspaceStage } from '@shared/types'
import * as jira from './jira'
import { getStore } from '../store'
import * as git from './git'
import { runScript, stopAllScripts } from './scripts'
import { renameRemoteBranch } from './github'

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
  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === input.spaceId)
  const slug = uniqueSlug(slugify(input.name))
  const rootPath = join(space?.workspacesRoot || settings.workspacesRoot, slug)
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
    stage: 'in-progress',
    createdAt: new Date().toISOString(),
    ...(input.jira ? { jira: input.jira } : {}),
    ...(input.claudeAccountId ? { claudeAccountId: input.claudeAccountId } : {}),
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    ...(space?.permissionMode ? { permissionMode: space.permissionMode } : {})
  }
  getStore().update((d) => d.workspaces.push(ws))

  try {
    mkdirSync(rootPath, { recursive: true })
    for (const wr of wsRepos) {
      const repo = getRepo(wr.repoId)
      await git.createWorktree(repo.path, wr.worktreePath, wr.branch, wr.baseBranch)
    }
    // Setup scripts run after every worktree exists, so a script in one repo
    // can reference the sibling worktree via SINFONIE_WORKSPACE_ROOT.
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

/** What archiving would throw away, per repo. */
export async function safetyReport(workspaceId: string): Promise<RepoSafety[]> {
  const ws = getWorkspace(workspaceId)
  return Promise.all(
    ws.repos.map(async (wr) => {
      if (!existsSync(wr.worktreePath)) return { repoId: wr.repoId, repoName: wr.repoName, uncommitted: 0, unpushed: 0, hasUpstream: false }
      try {
        const [st, up] = await Promise.all([git.status(wr.worktreePath), git.unpushedCount(wr.worktreePath, wr.baseBranch)])
        return { repoId: wr.repoId, repoName: wr.repoName, uncommitted: st.files.length, unpushed: up.count, hasUpstream: up.hasUpstream }
      } catch (err) {
        return { repoId: wr.repoId, repoName: wr.repoName, uncommitted: 0, unpushed: 0, hasUpstream: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  )
}

export function setStage(workspaceId: string, stage: WorkspaceStage): Workspace {
  return patchWorkspace(workspaceId, { stage })
}

/** Only ever moves forward, so a manual choice is not undone by a refresh. */
export function advanceStage(workspaceId: string, stage: WorkspaceStage): void {
  const order: WorkspaceStage[] = ['todo', 'in-progress', 'in-review', 'done']
  const ws = getWorkspace(workspaceId)
  if (order.indexOf(stage) > order.indexOf(ws.stage)) patchWorkspace(workspaceId, { stage })
}

export async function refreshJiraStatus(workspaceId: string): Promise<Workspace> {
  const ws = getWorkspace(workspaceId)
  if (!ws.jira) return ws
  const issue = await jira.issue(jira.connectionForSpace(ws.spaceId), ws.jira.key)
  return patchWorkspace(workspaceId, { jiraStatus: issue.status, jiraStatusAt: new Date().toISOString(), jira: { ...ws.jira, summary: issue.summary || ws.jira.summary } })
}

/** Add another repository to a live workspace: worktree on the workspace branch, setup script, done. */
export async function addRepoToWorkspace(workspaceId: string, repoId: string, baseBranch: string, emit: Emit): Promise<Workspace> {
  const ws = getWorkspace(workspaceId)
  if (ws.status !== 'ready') throw new Error('Workspace is not ready')
  if (ws.repos.some((r) => r.repoId === repoId)) throw new Error('That repository is already in this workspace')
  const repo = getRepo(repoId)
  const branch = ws.repos[0]?.branch ?? ws.slug
  const wr: WorkspaceRepo = { repoId, repoName: repo.name, worktreePath: join(ws.rootPath, repo.name), branch, baseBranch: baseBranch || repo.defaultBranch }
  if (existsSync(wr.worktreePath)) throw new Error(`${wr.worktreePath} already exists`)
  await git.createWorktree(repo.path, wr.worktreePath, wr.branch, wr.baseBranch)
  const out = patchWorkspace(ws.id, { repos: [...ws.repos, wr] })
  const cmd = repo.config?.scripts?.setup
  if (cmd) await runScript(out, repo, wr.worktreePath, 'setup', cmd, emit)
  return out
}

export async function removeRepoFromWorkspace(workspaceId: string, repoId: string, opts: { deleteBranch: boolean }, emit: Emit): Promise<Workspace> {
  const ws = getWorkspace(workspaceId)
  const wr = ws.repos.find((r) => r.repoId === repoId)
  if (!wr) throw new Error('Repository is not in this workspace')
  if (ws.repos.length === 1) throw new Error('A workspace needs at least one repository; archive it instead')
  let repo: Repo | null = null
  try {
    repo = getRepo(repoId)
  } catch {
    /* removed from the app */
  }
  if (repo) {
    const cmd = repo.config?.scripts?.archive
    if (cmd && existsSync(wr.worktreePath)) await runScript(ws, repo, wr.worktreePath, 'archive', cmd, emit)
    try {
      await git.removeWorktree(repo.path, wr.worktreePath, wr.branch, opts.deleteBranch)
    } catch (err) {
      console.warn('worktree removal failed, falling back to rm', err)
    }
  }
  if (existsSync(wr.worktreePath)) rmSync(wr.worktreePath, { recursive: true, force: true })
  const repos = ws.repos.filter((r) => r.repoId !== repoId)
  return patchWorkspace(ws.id, { repos, primaryRepoId: ws.primaryRepoId === repoId ? repos[0].repoId : ws.primaryRepoId })
}

export function deleteWorkspaceRecord(workspaceId: string): void {
  getStore().update((d) => {
    d.workspaces = d.workspaces.filter((w) => w.id !== workspaceId)
  })
}

/**
 * Rename the workspace and, when asked, the branch in every repo. The folder on
 * disk keeps its original name: moving worktrees would break running shells
 * and scripts, and the branch is what shows up on GitHub anyway.
 */
export async function renameWorkspace(workspaceId: string, name: string, opts: { renameBranches: boolean }): Promise<Workspace> {
  const ws = getWorkspace(workspaceId)
  const clean = name.trim()
  if (!clean) throw new Error('Name is empty')
  let out = patchWorkspace(workspaceId, { name: clean })
  if (opts.renameBranches && ws.status === 'ready') {
    const newSlug = uniqueSlug(slugify(clean))
    const currentBranch = ws.repos[0]?.branch
    if (newSlug !== currentBranch) {
      out = await renameWorkspaceBranch(workspaceId, newSlug)
      out = patchWorkspace(workspaceId, { slug: newSlug })
    }
  }
  return out
}

/**
 * Rename the branch in every worktree of the workspace at once. Branches that
 * were pushed are renamed on GitHub first (so open PRs follow), then locally,
 * then re-pointed at the new upstream.
 */
export async function renameWorkspaceBranch(workspaceId: string, branch: string): Promise<Workspace> {
  const ws = getWorkspace(workspaceId)
  const clean = branch.trim()
  if (!clean) throw new Error('Branch name is empty')
  const failures: string[] = []
  const repos = [...ws.repos]
  for (const wr of repos) {
    try {
      const pushed = await git.hasUpstream(wr.worktreePath)
      let renamedRemote = false
      if (pushed) renamedRemote = await renameRemoteBranch(wr.worktreePath, wr.branch, clean)
      await git.renameBranch(wr.worktreePath, clean)
      if (renamedRemote) await git.retrackAfterRemoteRename(wr.worktreePath, wr.branch, clean)
      wr.branch = clean
    } catch (err) {
      failures.push(`${wr.repoName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const out = patchWorkspace(ws.id, { repos })
  if (failures.length) throw new Error(`Branch renamed where possible. Failed in ${failures.join('; ')}`)
  return out
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
