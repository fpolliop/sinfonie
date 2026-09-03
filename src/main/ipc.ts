import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename } from 'path'
import { spawn } from 'child_process'
import { nanoid } from 'nanoid'
import type { OrchestraEvents, OrchestraInvoke } from '@shared/ipc'
import type { Repo, RepoGitStatus } from '@shared/types'
import { getStore } from './store'
import * as git from './services/git'
import * as workspaces from './services/workspaces'
import * as agent from './services/agent'
import * as terminal from './services/terminal'
import { clearTranscript, flushAllTranscripts, getTranscript, recordEvent } from './services/transcripts'
import { runScript, stopScript, workspaceEnv } from './services/scripts'
import { repoPrStatus } from './services/github'
import * as jira from './services/jira'
import * as accounts from './services/accounts'
import * as reviews from './services/reviews'

function send<C extends keyof OrchestraEvents>(channel: C, payload: OrchestraEvents[C]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function handle<C extends keyof OrchestraInvoke>(
  channel: C,
  fn: (...args: Parameters<OrchestraInvoke[C]>) => ReturnType<OrchestraInvoke[C]> | Promise<ReturnType<OrchestraInvoke[C]>>
): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as Parameters<OrchestraInvoke[C]>)))
}

const emitScript = (e: Parameters<typeof send<'script:output'>>[1]): void => send('script:output', e)
const emitAgent = (e: Parameters<typeof send<'agent:event'>>[1]): void => {
  recordEvent(e)
  send('agent:event', e)
}
const emitPermission = (e: Parameters<typeof send<'agent:permission'>>[1]): void => send('agent:permission', e)

export function registerIpc(): void {
  getStore().subscribe(() => send('store:changed', getStore().public()))

  handle('store:get', () => getStore().public())
  handle('settings:update', (patch) => getStore().update((d) => Object.assign(d.settings, patch)).settings)

  // ---- repos ----
  handle('repos:pickAndAdd', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Add a git repository' })
    if (r.canceled || r.filePaths.length === 0) return null
    const path = r.filePaths[0]
    if (!(await git.isGitRepo(path))) throw new Error(`${path} is not the root of a git repository`)
    const existing = getStore().get().repos.find((x) => x.path === path)
    if (existing) return existing
    const repo: Repo = {
      id: nanoid(8),
      name: basename(path),
      path,
      defaultBranch: await git.detectDefaultBranch(path),
      config: git.readConductorConfig(path),
      addedAt: new Date().toISOString()
    }
    getStore().update((d) => d.repos.push(repo))
    return repo
  })
  handle('repos:remove', (repoId) => {
    getStore().update((d) => {
      d.repos = d.repos.filter((r) => r.id !== repoId)
    })
  })
  handle('repos:branches', (repoId) => git.listBranches(workspaces.getRepo(repoId).path))
  handle('repos:reloadConfig', (repoId) => {
    let out: Repo | undefined
    getStore().update((d) => {
      const r = d.repos.find((x) => x.id === repoId)
      if (r) {
        r.config = git.readConductorConfig(r.path)
        out = r
      }
    })
    if (!out) throw new Error('Unknown repo')
    return out
  })

  // ---- workspaces ----
  handle('workspaces:create', (input) => workspaces.createWorkspace(input, emitScript))
  handle('workspaces:archive', async (id, opts) => {
    agent.closeSession(id)
    const ws = await workspaces.archiveWorkspace(id, opts, emitScript)
    if (opts.forget) {
      clearTranscript(id)
      workspaces.deleteWorkspaceRecord(id)
      return null
    }
    return ws
  })
  handle('workspaces:safety', (id) => workspaces.safetyReport(id))
  handle('workspaces:setStage', (id, stage) => workspaces.setStage(id, stage))
  handle('workspaces:refreshJira', (id) => workspaces.refreshJiraStatus(id))
  handle('workspaces:delete', (id) => {
    agent.closeSession(id)
    clearTranscript(id)
    workspaces.deleteWorkspaceRecord(id)
  })
  handle('workspaces:rename', (id, name, opts) => workspaces.renameWorkspace(id, name, opts))
  handle('workspaces:renameBranch', (id, branch) => workspaces.renameWorkspaceBranch(id, branch))
  handle('workspaces:openIn', (id, target) => {
    const ws = workspaces.getWorkspace(id)
    if (target === 'finder') shell.showItemInFolder(ws.rootPath)
    else if (target === 'vscode') spawn('open', ['-a', 'Visual Studio Code', ws.rootPath], { detached: true }).unref()
    else if (target === 'cursor') spawn('open', ['-a', 'Cursor', ws.rootPath], { detached: true }).unref()
    else spawn('open', ['-a', 'Terminal', ws.rootPath], { detached: true }).unref()
  })
  handle('workspaces:runScript', (id, kind) => workspaces.runWorkspaceScript(id, kind, emitScript))
  handle('workspaces:stopScript', (id, kind) => {
    for (const r of workspaces.getWorkspace(id).repos) stopScript(id, r.repoId, kind)
  })

  // ---- git ----
  handle('git:status', async (id) => {
    const ws = workspaces.getWorkspace(id)
    const out: RepoGitStatus[] = []
    for (const wr of ws.repos) {
      try {
        const s = await git.status(wr.worktreePath)
        out.push({ repoId: wr.repoId, ...s })
      } catch {
        out.push({ repoId: wr.repoId, branch: wr.branch, ahead: 0, behind: 0, hasUpstream: false, files: [] })
      }
    }
    return out
  })
  handle('git:diff', (id, repoId, path) => {
    const wr = workspaces.getWorkspace(id).repos.find((r) => r.repoId === repoId)
    if (!wr) throw new Error('Repo not in workspace')
    return git.diff(wr.worktreePath, path)
  })
  handle('git:commit', (id, repoId, message) => {
    const wr = workspaces.getWorkspace(id).repos.find((r) => r.repoId === repoId)
    if (!wr) throw new Error('Repo not in workspace')
    return git.commitAll(wr.worktreePath, message)
  })
  handle('git:push', (id, repoId) => {
    const wr = workspaces.getWorkspace(id).repos.find((r) => r.repoId === repoId)
    if (!wr) throw new Error('Repo not in workspace')
    return git.push(wr.worktreePath)
  })
  handle('git:createPr', async (id, repoId, title, body) => {
    const ws = workspaces.getWorkspace(id)
    const wr = ws.repos.find((r) => r.repoId === repoId)
    if (!wr) throw new Error('Repo not in workspace')
    const siblings = ws.repos.filter((r) => r.repoId !== repoId).map((r) => `- ${r.repoName} on branch \`${r.branch}\``)
    const footer: string[] = []
    if (ws.jira) footer.push(`Jira: [${ws.jira.key}](${ws.jira.url}) ${ws.jira.summary}`)
    if (siblings.length) footer.push(`Part of workspace **${ws.name}**. Related branches:\n${siblings.join('\n')}`)
    const fullBody = footer.length ? `${body}\n\n---\n${footer.join('\n\n')}` : body
    return new Promise<string>((resolve, reject) => {
      const child = spawn('gh', ['pr', 'create', '--title', title, '--body', fullBody, '--head', wr.branch], { cwd: wr.worktreePath, env: process.env })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.on('close', (code) => {
        if (code === 0) {
          workspaces.advanceStage(id, 'in-review')
          resolve(out.trim())
        } else reject(new Error(out.trim() || `gh exited ${code}`))
      })
      child.on('error', reject)
    })
  })

  // ---- github / jira / shell ----
  handle('github:status', async (id) => {
    const ws = workspaces.getWorkspace(id)
    const result = await Promise.all(ws.repos.map((wr) => repoPrStatus(wr.repoId, wr.worktreePath, wr.branch)))
    // Let PR state pull the stage forward: any PR means review, all PRs merged means done.
    const prs = result.map((r) => r.pr).filter((p): p is NonNullable<typeof p> => Boolean(p))
    if (prs.length > 0 && ws.status === 'ready') {
      if (prs.every((p) => p.state === 'MERGED')) workspaces.advanceStage(id, 'done')
      else if (prs.some((p) => p.state === 'OPEN')) workspaces.advanceStage(id, 'in-review')
    }
    return result
  })
  handle('jira:authenticate', () => jira.authenticate())
  handle('jira:disconnect', () => jira.disconnect())
  handle('jira:saveToken', (token) => jira.saveToken(token))
  handle('jira:search', (q) => jira.search(q))
  handle('jira:issue', (key) => jira.issue(key))
  handle('shell:openExternal', (url) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })

  // ---- claude accounts ----
  handle('accounts:add', (name) => accounts.addAccount(name))
  handle('accounts:remove', (id) => accounts.removeAccount(id))
  handle('accounts:setDefault', (id) => accounts.setDefaultAccount(id))
  handle('accounts:check', (id) => accounts.checkAccount(id))
  handle('accounts:loginTerminal', (id) =>
    accounts.loginTerminal(
      id,
      (terminalId, data) => send('terminal:data', { terminalId, data }),
      (terminalId, exitCode) => send('terminal:exit', { terminalId, exitCode })
    )
  )

  // ---- review cockpit ----
  const emitReview = (run: Parameters<typeof send<'review:changed'>>[1]): void => send('review:changed', run)
  handle('reviews:orgs', () => reviews.listOrgs())
  handle('reviews:list', (owner, mode) => reviews.listPrs(owner, mode))
  handle('reviews:runs', () => reviews.listRuns())
  handle('reviews:start', (pr, accountId) => reviews.startReview(pr, accountId, emitReview))
  handle('reviews:cancel', (key) => reviews.cancelReview(key))
  handle('reviews:discard', (key) => reviews.discardReview(key))
  handle('reviews:updateFinding', (key, fid, patch) => reviews.updateFinding(key, fid, patch, emitReview))
  handle('reviews:setAll', (key, approved) => reviews.setAllFindings(key, approved, emitReview))
  handle('reviews:setVerdict', (key, verdict) => reviews.setVerdict(key, verdict, emitReview))
  handle('reviews:submit', (key) => reviews.submitReview(key, emitReview))

  // ---- agent ----
  handle('agent:send', (id, text) => agent.sendMessage(id, text, emitAgent, emitPermission))
  handle('agent:interrupt', (id) => agent.interrupt(id))
  handle('agent:permission', (r) => agent.answerPermission(r))
  handle('agent:reset', (id) => {
    agent.resetSession(id)
    clearTranscript(id)
  })
  handle('chat:load', (id) => ({ items: getTranscript(id), busy: agent.isBusy(id) }))
  handle('agent:setMode', (id, mode) => agent.setMode(id, mode))

  // ---- terminal ----
  handle('terminal:create', (id, repoId) => {
    const ws = workspaces.getWorkspace(id)
    const wr = ws.repos.find((r) => r.repoId === repoId)
    if (!wr) throw new Error('Repo not in workspace')
    const repo = workspaces.getRepo(repoId)
    return terminal.createTerminal(
      wr.worktreePath,
      workspaceEnv(ws, repo, wr.worktreePath),
      (terminalId, data) => send('terminal:data', { terminalId, data }),
      (terminalId, exitCode) => send('terminal:exit', { terminalId, exitCode })
    )
  })
  handle('terminal:write', (tid, data) => terminal.writeTerminal(tid, data))
  handle('terminal:resize', (tid, cols, rows) => terminal.resizeTerminal(tid, cols, rows))
  handle('terminal:dispose', (tid) => terminal.disposeTerminal(tid))

  app.on('before-quit', () => {
    flushAllTranscripts()
    agent.closeAllSessions()
    terminal.disposeAllTerminals()
  })
  // keep runScript referenced for the archive path's typing
  void runScript
}
