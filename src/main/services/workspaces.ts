import { existsSync, mkdirSync, rmSync } from 'fs'
import { createServer } from 'node:net'
import { join } from 'path'
import { nanoid } from 'nanoid'
import type { ConductorConfig, CreateWorkspaceInput, Repo, RepoSafety, ScriptOutputEvent, Workspace, WorkspaceRepo, WorkspaceStage } from '@shared/types'
import { PLAIN_ERROR_MARK } from '@shared/types'
import * as jira from './jira'
import * as linear from './linear'
import { getStore } from '../store'
import * as git from './git'
import { runScript, stopAllScripts } from './scripts'
import { renameRemoteBranch } from './github'
import { stageVeto } from './team-rules'

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

/** True when nothing on this Mac is listening on `port` (IPv4 or IPv6). */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port)
  })
}

/**
 * The first block of 10 ports no other workspace holds and nothing else on the Mac is using, so a workspace's app
 * never fails to start because another server (another app, another Sinfonie profile) already took its port.
 */
async function allocatePort(): Promise<number> {
  const { workspaces, settings } = getStore().get()
  const used = new Set(workspaces.filter((w) => w.status !== 'archived').map((w) => w.port))
  for (let port = settings.basePort, tries = 0; tries < 200; port += 10, tries++) {
    if (used.has(port)) continue
    const block = await Promise.all(Array.from({ length: 10 }, (_, i) => portFree(port + i)))
    if (block.every(Boolean)) return port
  }
  // Everything nearby is busy: fall back to the old rule rather than failing to create the workspace.
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

/**
 * The scripts that apply to a repository inside a workspace: the worktree's own sinfonie.json when it has one (the agent
 * may have just added or changed it on the workspace branch), else the one read from the repository when it was added.
 */
export function configFor(repo: Repo, worktreePath: string): ConductorConfig | null {
  return (existsSync(worktreePath) ? git.readConductorConfig(worktreePath) : null) ?? repo.config ?? null
}

const isGuidedMode = (): boolean => getStore().get().settings.mode === 'guided'

/**
 * An empty repository has nothing to branch from. Guided mode makes the first (empty) commit itself; expert mode
 * says what is wrong and how to fix it.
 */
async function ensureHasCommits(repo: Repo): Promise<void> {
  if (await git.hasCommits(repo.path)) return
  if (isGuidedMode()) {
    await git.createInitialCommit(repo.path)
    return
  }
  throw new Error(`${repo.name} has no commits yet, so there is no branch to start from. Make a first commit in ${repo.path} (for example git commit --allow-empty -m "Initial commit"), then retry setup.`)
}

async function addWorktree(repo: Repo, wr: WorkspaceRepo): Promise<void> {
  await ensureHasCommits(repo)
  try {
    await git.createWorktree(repo.path, wr.worktreePath, wr.branch, wr.baseBranch)
  } catch (err) {
    throw git.explainWorktreeError(err, wr)
  }
}

/** Runs the setup script of each given repository (all at once), from the worktree's sinfonie.json when it has one. */
async function runSetupScripts(ws: Workspace, wrs: WorkspaceRepo[], emit: Emit): Promise<void> {
  await Promise.all(
    wrs.map(async (wr) => {
      let repo: Repo
      try {
        repo = getRepo(wr.repoId)
      } catch {
        return
      }
      const cmd = configFor(repo, wr.worktreePath)?.scripts?.setup
      if (cmd) await runScript(ws, repo, wr.worktreePath, 'setup', cmd, emit)
    })
  )
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
  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === input.spaceId)
  // A fixed branch (a teammate's) must be used as is; a fresh one is made unique.
  let slug: string
  if (input.branch) {
    slug = input.branch
    if (getStore().get().workspaces.some((w) => w.slug === slug && w.status !== 'archived')) throw new Error(`You already have a workspace on ${slug}.`)
  } else slug = uniqueSlug(slugify(input.name))
  const rootPath = join(space?.workspacesRoot || settings.workspacesRoot, slug)
  const repos = input.repos.map((r) => getRepo(r.repoId))
  const primaryRepoId = input.primaryRepoId ?? input.repos[0]?.repoId ?? ''

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
    port: await allocatePort(),
    status: 'creating',
    stage: 'in-progress',
    createdAt: new Date().toISOString(),
    ...(input.jira ? { jira: input.jira } : {}),
    ...(input.linear ? { linear: input.linear } : {}),
    ...(input.claudeAccountId ? { claudeAccountId: input.claudeAccountId } : {}),
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    ...(space?.permissionMode ? { permissionMode: space.permissionMode } : {})
  }
  getStore().update((d) => d.workspaces.push(ws))

  try {
    mkdirSync(rootPath, { recursive: true })
    for (const wr of wsRepos) await addWorktree(getRepo(wr.repoId), wr)
    // Setup scripts run after every worktree exists, so a script in one repo
    // can reference the sibling worktree via SINFONIE_WORKSPACE_ROOT. They stop after a while
    // (SCRIPT_TIMEOUT_MS), and Skip setup (workspaces:stopScript 'setup') lets the workspace go ready at once.
    await runSetupScripts(ws, wsRepos, emit)
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
  patchWorkspace(ws.id, { status: 'archiving', archiveFailed: undefined })
  stopAllScripts(ws.id)
  for (const wr of ws.repos) {
    let repo: Repo | null = null
    try {
      repo = getRepo(wr.repoId)
    } catch {
      /* repo was removed from the app; still try to clean the folder */
    }
    if (repo) {
      const cmd = configFor(repo, wr.worktreePath)?.scripts?.archive
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
/** Worktrees the workspace records that are gone from disk (deleted by hand, a moved folder, a pruned checkout). */
export function missingWorktrees(ws: Workspace): WorkspaceRepo[] {
  return ws.repos.filter((r) => !existsSync(r.worktreePath))
}

/**
 * Fail early and clearly when a workspace's folders are gone. Without this the agent runtimes
 * report a spawn failure in a misleading way (the SDK blames a libc mismatch when cwd is absent).
 */
export function assertOnDisk(ws: Workspace): void {
  const missing = missingWorktrees(ws)
  if (missing.length === 0 && (ws.repos.length > 0 || existsSync(ws.rootPath))) return
  const list = missing.length ? missing.map((r) => `${r.repoName} at ${r.worktreePath} (branch ${r.branch})`).join('; ') : ws.rootPath
  throw new Error(`The folders of workspace "${ws.name}" are missing on disk: ${list}. Use Repair in the workspace header to recreate the worktrees from their branches, or archive the workspace.`)
}

/**
 * Recreate every missing worktree from its recorded branch (the branch is kept if it still exists, else made from the
 * base branch). When setup failed or was interrupted, this is also "Retry setup": the workspace goes back to setting
 * up, missing worktrees are made, and the setup scripts run again.
 */
export async function repairWorkspace(workspaceId: string, emit: Emit = () => undefined): Promise<Workspace> {
  const ws = getWorkspace(workspaceId)
  // A workspace whose archive failed is on its way out: recreating its worktrees would undo half an archive.
  if (ws.archiveFailed) throw new Error(PLAIN_ERROR_MARK + 'This was being finished when Sinfonie closed, so it is not set up again. Finish it instead.')
  const retrySetup = ws.status === 'error' || ws.status === 'creating'
  const missing = missingWorktrees(ws)
  if (!existsSync(ws.rootPath)) mkdirSync(ws.rootPath, { recursive: true })
  if (retrySetup) patchWorkspace(ws.id, { status: 'creating', error: undefined })
  const errors: string[] = []
  const recreated: WorkspaceRepo[] = []
  for (const wr of missing) {
    try {
      const repo = getRepo(wr.repoId)
      // Git may still register the old path; prune it so the branch can be checked out again.
      await git.git(repo.path).raw(['worktree', 'prune'])
      await addWorktree(repo, wr)
      recreated.push(wr)
    } catch (err) {
      errors.push(`${wr.repoName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (errors.length) return patchWorkspace(ws.id, { status: 'error', error: `${retrySetup ? 'Setup' : 'Repair'} failed: ${errors.join('; ')}` })
  const toSetUp = retrySetup ? ws.repos : recreated
  if (toSetUp.length) await runSetupScripts(getWorkspace(ws.id), toSetUp, emit)
  return patchWorkspace(ws.id, { status: 'ready', error: undefined })
}

/** Why a workspace is in the error state after Sinfonie quit or crashed while it was being set up. */
export const INTERRUPTED_SETUP = 'Setup was interrupted: Sinfonie closed before it finished. Retry setup to finish it.'

/**
 * At startup: nothing is setting up or archiving any more (the app quit or crashed mid-way). A workspace left
 * "creating" becomes an error with a Retry; one left "archiving" finishes archiving in the background.
 */
export function reconcileInterrupted(emit: Emit): void {
  const { workspaces } = getStore().get()
  for (const w of workspaces) {
    if (w.status === 'creating') patchWorkspace(w.id, { status: 'error', error: INTERRUPTED_SETUP })
  }
  for (const w of workspaces.filter((x) => x.status === 'archiving')) {
    void archiveWorkspace(w.id, { deleteBranches: false }, emit).catch((err) => {
      console.warn(`finishing the archive of ${w.id} failed`, err)
      patchWorkspace(w.id, { status: 'error', archiveFailed: true, error: `Archiving was interrupted and could not finish: ${err instanceof Error ? err.message : String(err)}. Finish archiving to try again.` })
    })
  }
}

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
  // Team guardrail: builders send for review before a task is done (renderer and Maestro both land here).
  const veto = stageVeto(getWorkspace(workspaceId), stage)
  if (veto) throw new Error(veto)
  return patchWorkspace(workspaceId, { stage })
}

/** Only ever moves forward, so a manual choice is not undone by a refresh. */
export function advanceStage(workspaceId: string, stage: WorkspaceStage): void {
  const order: WorkspaceStage[] = ['todo', 'on-hold', 'in-progress', 'in-review', 'done']
  const ws = getWorkspace(workspaceId)
  if (order.indexOf(stage) > order.indexOf(ws.stage)) patchWorkspace(workspaceId, { stage })
}

export async function refreshJiraStatus(workspaceId: string): Promise<Workspace> {
  const ws = getWorkspace(workspaceId)
  if (!ws.jira) return ws
  const issue = await jira.issue(jira.connectionForSpace(ws.spaceId), ws.jira.key)
  return patchWorkspace(workspaceId, { jiraStatus: issue.status, jiraStatusAt: new Date().toISOString(), jira: { ...ws.jira, summary: issue.summary || ws.jira.summary } })
}

export async function refreshLinearStatus(workspaceId: string): Promise<Workspace> {
  const ws = getWorkspace(workspaceId)
  if (!ws.linear) return ws
  const issue = await linear.issue(linear.connectionForSpace(ws.spaceId), ws.linear.identifier)
  return patchWorkspace(workspaceId, { linearStatus: issue.state, linearStatusAt: new Date().toISOString(), linear: { ...ws.linear, title: issue.title || ws.linear.title } })
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
  await addWorktree(repo, wr)
  const out = patchWorkspace(ws.id, { repos: [...ws.repos, wr], ...(ws.primaryRepoId ? {} : { primaryRepoId: repoId }) })
  await runSetupScripts(out, [wr], emit)
  return out
}

export async function removeRepoFromWorkspace(workspaceId: string, repoId: string, opts: { deleteBranch: boolean }, emit: Emit): Promise<Workspace> {
  const ws = getWorkspace(workspaceId)
  const wr = ws.repos.find((r) => r.repoId === repoId)
  if (!wr) throw new Error('Repository is not in this workspace')
  let repo: Repo | null = null
  try {
    repo = getRepo(repoId)
  } catch {
    /* removed from the app */
  }
  if (repo) {
    const cmd = configFor(repo, wr.worktreePath)?.scripts?.archive
    if (cmd && existsSync(wr.worktreePath)) await runScript(ws, repo, wr.worktreePath, 'archive', cmd, emit)
    try {
      await git.removeWorktree(repo.path, wr.worktreePath, wr.branch, opts.deleteBranch)
    } catch (err) {
      console.warn('worktree removal failed, falling back to rm', err)
    }
  }
  if (existsSync(wr.worktreePath)) rmSync(wr.worktreePath, { recursive: true, force: true })
  const repos = ws.repos.filter((r) => r.repoId !== repoId)
  return patchWorkspace(ws.id, { repos, primaryRepoId: ws.primaryRepoId === repoId ? (repos[0]?.repoId ?? '') : ws.primaryRepoId })
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

/**
 * Starts each repository's setup or run script and returns as soon as they are started (a run script is a server
 * that never exits; callers go on to open Preview). Scripts come from the worktree's sinfonie.json first, so a script
 * the agent just added on this branch is used. Sequential mode starts the next script when the previous one exits.
 * Returns how many scripts were started.
 */
export async function runWorkspaceScript(workspaceId: string, kind: 'setup' | 'run', emit: Emit): Promise<{ started: number }> {
  const ws = getWorkspace(workspaceId)
  const jobs: { repo: Repo; wr: WorkspaceRepo; cmd: string }[] = []
  for (const wr of ws.repos) {
    let repo: Repo
    try {
      repo = getRepo(wr.repoId)
    } catch {
      continue
    }
    const cmd = configFor(repo, wr.worktreePath)?.scripts?.[kind]
    if (!cmd) {
      emit({ workspaceId: ws.id, repoId: repo.id, kind, data: `[no ${kind} script in sinfonie.json]\r\n`, done: true, exitCode: 0 })
      continue
    }
    jobs.push({ repo, wr, cmd })
  }
  const mode = jobs.map((j) => configFor(j.repo, j.wr.worktreePath)?.runScriptMode).find(Boolean) ?? 'concurrent'
  const start = (j: (typeof jobs)[number]): Promise<number | null> => runScript(ws, j.repo, j.wr.worktreePath, kind, j.cmd, emit)
  if (mode === 'sequential') {
    // The first starts now; the rest follow in order, in the background.
    void jobs.reduce<Promise<unknown>>((prev, j) => prev.then(() => start(j)), Promise.resolve())
  } else {
    for (const j of jobs) void start(j)
  }
  return { started: jobs.length }
}
