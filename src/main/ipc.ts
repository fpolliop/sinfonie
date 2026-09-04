import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename } from 'path'
import { spawn } from 'child_process'
import { nanoid } from 'nanoid'
import type { SinfonieEvents, SinfonieInvoke } from '@shared/ipc'
import type { Label, McpServerSpec, Repo, RepoGitStatus, ScannedRepo, Space } from '@shared/types'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

interface RawMcp {
  type?: string
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
}
import { SPACE_COLORS } from '@shared/types'
import { getStore } from './store'
import * as git from './services/git'
import * as workspaces from './services/workspaces'
import * as agent from './services/agent'
import * as terminal from './services/terminal'
import { clearTranscript, flushAllTranscripts, getTranscript, markInterrupted, recordEvent } from './services/transcripts'
import { runScript, stopScript, workspaceEnv } from './services/scripts'
import { repoPrStatus } from './services/github'
import * as jira from './services/jira'
import * as accounts from './services/accounts'
import * as reviews from './services/reviews'
import * as sessionsSvc from './services/sessions'
import { checkForUpdate, latestKnownUpdate, downloadUpdate, installUpdate } from './services/updates'
import { clearErrors, listErrors, logsDir, sendFeedback, noteMessage } from './services/telemetry'
import * as interaction from './services/interaction'
import * as providers from './services/providers'
import * as acp from './services/acp/engine'
import * as crewSuggest from './services/crew/suggest'
import * as notes from './services/notes'
import * as resources from './services/resources'
import * as browser from './services/browser/service'
import * as browserHttp from './services/browser/http'
import * as workspaceTools from './services/workspace-tools'
import { saveImages } from './services/images'
import * as slack from './services/slack'
import * as oncall from './services/oncall/service'

function send<C extends keyof SinfonieEvents>(channel: C, payload: SinfonieEvents[C]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function handle<C extends keyof SinfonieInvoke>(
  channel: C,
  fn: (...args: Parameters<SinfonieInvoke[C]>) => ReturnType<SinfonieInvoke[C]> | Promise<ReturnType<SinfonieInvoke[C]>>
): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as Parameters<SinfonieInvoke[C]>)))
}

const emitScript = (e: Parameters<typeof send<'script:output'>>[1]): void => send('script:output', e)
const emitAgent = (e: Parameters<typeof send<'agent:event'>>[1]): void => {
  recordEvent(e)
  send('agent:event', e)
  // A session went idle: a waiting message may take its slot.
  if (e.type === 'status' && !e.busy) void resources.release()
}
const emitPermission = (e: Parameters<typeof send<'agent:permission'>>[1]): void => send('agent:permission', e)

export function registerIpc(): void {
  interaction.setInteractionEmitters(
    (p) => send('agent:permission', p),
    (q) => send('agent:question', q)
  )
  getStore().subscribe(() => send('store:changed', getStore().public()))
  workspaceTools.setScriptEmitter(emitScript)

  handle('store:get', () => getStore().public())
  handle('settings:update', (patch) => {
    const out = getStore().update((d) => Object.assign(d.settings, patch)).settings
    if ('oncall' in patch) oncall.reconcile()
    return out
  })

  // ---- spaces ----
  handle('spaces:create', (name) => {
    const space: Space = { id: nanoid(6), name: name.trim() || 'Space', color: SPACE_COLORS[getStore().get().spaces.length % SPACE_COLORS.length], createdAt: new Date().toISOString() }
    getStore().update((d) => d.spaces.push(space))
    return space
  })
  handle('spaces:update', (id, patch) => {
    let out: Space | undefined
    getStore().update((d) => {
      const s = d.spaces.find((x) => x.id === id)
      if (s) {
        // Empty strings mean "back to the app default".
        const target = s as unknown as Record<string, unknown>
        for (const [k, v] of Object.entries(patch)) {
          if (v === '' || v === undefined || v === null || (Array.isArray(v) && v.length === 0 && k !== 'mcpServers' && k !== 'agents')) delete target[k]
          else if (v === false && k === 'strictMcp') delete target[k]
          else if (v === true && k === 'useCrew') delete target[k]
          else target[k] = v
        }
        out = s
      }
    })
    if (!out) throw new Error('Unknown space')
    return out
  })
  handle('spaces:delete', (id) => {
    getStore().update((d) => {
      d.spaces = d.spaces.filter((s) => s.id !== id)
      for (const w of d.workspaces) if (w.spaceId === id) delete w.spaceId
      for (const r of d.repos) if (r.spaceId === id) delete r.spaceId
    })
  })
  handle('workspaces:setSpace', (wid, spaceId) => workspaces.patchWorkspace(wid, { spaceId: spaceId ?? undefined }))
  handle('workspaces:setLabels', (wid, labelIds) => workspaces.patchWorkspace(wid, { labelIds }))

  // ---- labels ----
  handle('labels:create', (name, color, spaceId) => {
    const label: Label = { id: nanoid(6), name: name.trim() || 'label', color, ...(spaceId ? { spaceId } : {}) }
    getStore().update((d) => d.labels.push(label))
    return label
  })
  handle('labels:update', (id, patch) => {
    let out: Label | undefined
    getStore().update((d) => {
      const l = d.labels.find((x) => x.id === id)
      if (l) {
        Object.assign(l, patch)
        out = l
      }
    })
    if (!out) throw new Error('Unknown label')
    return out
  })
  handle('labels:delete', (id) => {
    getStore().update((d) => {
      d.labels = d.labels.filter((l) => l.id !== id)
      for (const w of d.workspaces) if (w.labelIds?.includes(id)) w.labelIds = w.labelIds.filter((x) => x !== id)
    })
  })
  handle('repos:setSpace', (rid, spaceId) => {
    let out: Repo | undefined
    getStore().update((d) => {
      const r = d.repos.find((x) => x.id === rid)
      if (r) {
        if (spaceId) r.spaceId = spaceId
        else delete r.spaceId
        out = r
      }
    })
    if (!out) throw new Error('Unknown repo')
    return out
  })

  handle('mcp:importable', () => {
    // Claude Code keeps user-scope servers at the top level and project-scope ones under projects[path].mcpServers.
    const file = join(homedir(), '.claude.json')
    if (!existsSync(file)) return []
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, RawMcp>; projects?: Record<string, { mcpServers?: Record<string, RawMcp> }> }
    const found = new Map<string, RawMcp>()
    for (const [n, c] of Object.entries(raw.mcpServers ?? {})) found.set(n, c)
    for (const p of Object.values(raw.projects ?? {})) for (const [n, c] of Object.entries(p.mcpServers ?? {})) if (!found.has(n)) found.set(n, c)
    return Array.from(found.entries()).map(([name, c]) => ({
      id: nanoid(6),
      name,
      transport: (c.type === 'http' || c.type === 'sse' ? c.type : 'stdio') as McpServerSpec['transport'],
      url: c.url,
      headers: c.headers,
      command: c.command,
      args: c.args,
      env: c.env,
      enabled: true
    }))
  })

  // ---- repos ----
  const addRepoAt = async (path: string, spaceId?: string): Promise<Repo> => {
    if (!(await git.isGitRepo(path))) throw new Error(`${path} is not the root of a git repository`)
    const existing = getStore().get().repos.find((x) => x.path === path)
    if (existing) {
      if (spaceId && existing.spaceId !== spaceId) {
        getStore().update((d) => {
          const x = d.repos.find((y) => y.id === existing.id)
          if (x) x.spaceId = spaceId
        })
      }
      return existing
    }
    const repo: Repo = {
      id: nanoid(8),
      name: basename(path),
      path,
      defaultBranch: await git.detectDefaultBranch(path),
      config: git.readConductorConfig(path),
      addedAt: new Date().toISOString(),
      ...(spaceId ? { spaceId } : {})
    }
    getStore().update((d) => d.repos.push(repo))
    return repo
  }
  handle('repos:pickAndAdd', async (spaceId) => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Add a git repository' })
    if (r.canceled || r.filePaths.length === 0) return null
    return addRepoAt(r.filePaths[0], spaceId)
  })
  handle('repos:addPaths', async (paths, spaceId) => {
    const out: Repo[] = []
    for (const p of paths) out.push(await addRepoAt(p, spaceId))
    return out
  })
  handle('repos:scan', async (rootIn) => {
    const root = rootIn.startsWith('~') ? join(homedir(), rootIn.slice(1)) : rootIn
    const known = new Set(getStore().get().repos.map((r) => r.path))
    const out: ScannedRepo[] = []
    const seen = new Set<string>()
    const consider = (p: string): void => {
      if (seen.has(p) || !existsSync(join(p, '.git'))) return
      seen.add(p)
      out.push({ path: p, name: basename(p), added: known.has(p) })
    }
    const children = (dir: string): string[] => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
          .map((e) => join(dir, e.name))
      } catch {
        return []
      }
    }
    if (!existsSync(root)) return out
    consider(root)
    for (const c of children(root)) {
      consider(c)
      if (out.length > 200) break
      if (!seen.has(c)) for (const g of children(c)) consider(g)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  })
  handle('dialog:pickFolder', async (title, defaultPath) => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title, ...(defaultPath ? { defaultPath } : {}) })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
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
    browser.closeWorkspace(id)
    agent.closeSession(id)
    clearTranscript(id)
    notes.deleteAll(id)
    workspaces.deleteWorkspaceRecord(id)
  })
  handle('workspaces:rename', (id, name, opts) => workspaces.renameWorkspace(id, name, opts))
  handle('workspaces:renameBranch', (id, branch) => workspaces.renameWorkspaceBranch(id, branch))
  handle('workspaces:addRepo', async (id, repoId, base) => {
    const out = await workspaces.addRepoToWorkspace(id, repoId, base, emitScript)
    agent.closeSession(id) // next message resumes with the new directory in scope
    return out
  })
  handle('workspaces:removeRepo', async (id, repoId, opts) => {
    agent.closeSession(id)
    return workspaces.removeRepoFromWorkspace(id, repoId, opts, emitScript)
  })
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
  handle('jira:authenticate', (conn) => jira.authenticate(conn))
  handle('jira:disconnect', (conn) => jira.disconnect(conn))
  handle('jira:saveToken', (conn, token) => jira.saveToken(conn, token))
  handle('jira:updateSettings', (conn, patch) => jira.updateJiraSettings(conn, patch))
  handle('jira:search', (conn, q) => jira.search(conn, q))
  handle('jira:issue', (conn, key) => jira.issue(conn, key))
  handle('updates:check', async () => (await checkForUpdate()) ?? latestKnownUpdate())
  handle('updates:download', () => downloadUpdate())
  handle('updates:install', () => installUpdate())
  handle('app:version', () => app.getVersion())
  handle('feedback:send', async (p) => {
    let logs: string | undefined
    if (p.includeLogs) {
      try {
        logs = listErrors()
          .slice(0, 30)
          .map((e) => `${e.ts} [${e.where}] ${e.message}${e.stack ? '\n' + e.stack.split('\n').slice(0, 6).join('\n') : ''}`)
          .join('\n\n')
          .slice(0, 15000)
      } catch {
        logs = undefined
      }
    }
    return sendFeedback({ kind: p.kind, message: p.message, email: p.email, context: logs ? { errorsLog: logs } : undefined })
  })
  handle('logs:open', () => {
    void shell.openPath(logsDir())
  })
  handle('logs:list', () => listErrors())
  handle('logs:clear', () => clearErrors())
  handle('shell:openExternal', (url) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })

  // ---- claude accounts ----
  handle('accounts:add', (name, vendor) => accounts.addAccount(name, vendor))
  handle('accounts:remove', (id) => accounts.removeAccount(id))
  handle('accounts:setDefault', (id) => accounts.setDefaultAccount(id))
  handle('accounts:check', (id) => accounts.checkAccount(id))
  handle('accounts:login', (id) =>
    accounts.startLogin(
      id,
      (terminalId, data) => send('terminal:data', { terminalId, data }),
      (terminalId, exitCode) => send('terminal:exit', { terminalId, exitCode }),
      (p) => send('accounts:loginProgress', p)
    )
  )

  // ---- review cockpit ----
  const emitReview = (run: Parameters<typeof send<'review:changed'>>[1]): void => send('review:changed', run)
  handle('reviews:orgs', () => reviews.listOrgs())
  handle('reviews:list', (owners, mode) => reviews.listPrs(owners, mode))
  handle('reviews:detectOwners', (spaceId) => reviews.detectOwners(spaceId))
  handle('reviews:runs', () => reviews.listRuns())
  handle('reviews:start', (pr, accountId) => reviews.startReview(pr, accountId, emitReview))
  handle('reviews:cancel', (key) => reviews.cancelReview(key))
  handle('reviews:discard', (key) => reviews.discardReview(key))
  handle('reviews:updateFinding', (key, fid, patch) => reviews.updateFinding(key, fid, patch, emitReview))
  handle('reviews:setAll', (key, approved) => reviews.setAllFindings(key, approved, emitReview))
  handle('reviews:setVerdict', (key, verdict) => reviews.setVerdict(key, verdict, emitReview))
  handle('reviews:submit', (key) => reviews.submitReview(key, emitReview))

  // ---- agent ----
  handle('agent:send', (id, text, images) => {
    noteMessage(agent.engineFor(id))
    return resources.submit(id, text, images?.length ? saveImages(id, images) : undefined)
  })
  // ---- resources ----
  resources.start({
    emit: (s) => send('resources:snapshot', s),
    notice: (workspaceId, level, text) => emitAgent({ type: 'notice', workspaceId, itemId: nanoid(8), level, text, createdAt: new Date().toISOString() }),
    stopTask: (workspaceId, taskId) => agent.stopTask(workspaceId, taskId),
    send: (workspaceId, text, images) => agent.sendMessage(workspaceId, text, emitAgent, emitPermission, images),
    busyCount: () => getStore().get().workspaces.filter((w) => agent.isBusy(w.id)).length,
    isBusy: (workspaceId) => agent.isBusy(workspaceId)
  })
  // ---- on call ----
  oncall.setEmitters(
    (s) => send('oncall:changed', s),
    (incidentId) => send('ui:openOnCall', { incidentId })
  )
  handle('oncall:state', () => oncall.state())
  handle('oncall:slackSetClient', (id, secret) => slack.setClient(id, secret))
  handle('oncall:slackConnect', () => slack.startAuth())
  handle('oncall:slackFinish', async (code) => {
    const c = await slack.finishAuth(code)
    oncall.reconcile()
    return c
  })
  handle('oncall:slackDisconnect', () => {
    const c = slack.disconnect()
    oncall.reconcile()
    return c
  })
  handle('oncall:slackClearClient', () => slack.clearClient())
  handle('oncall:slackChannels', (q) => slack.listChannels(q))
  handle('oncall:pollNow', () => oncall.pollOnce())
  handle('oncall:triage', (id) => oncall.enqueueTriage(id))
  handle('oncall:setStatus', (id, status) => oncall.setStatus(id, status))
  handle('oncall:setSeverity', (id, sev) => oncall.setSeverity(id, sev))
  handle('oncall:approve', (id, pid, text) => oncall.approve(id, pid, text))
  handle('oncall:dismissProposal', (id, pid) => oncall.dismissProposal(id, pid))
  handle('oncall:addProposal', (id, text) => oncall.addProposal(id, text))
  handle('oncall:ask', (id, q) => oncall.ask(id, q))
  handle('oncall:remove', (id) => oncall.remove(id))
  setTimeout(() => oncall.reconcile(), 5_000)

  // ---- workspace browser ----
  browser.setEmitters(
    (s) => send('browser:state', s),
    (workspaceId) => send('browser:agentActive', { workspaceId })
  )
  handle('browser:state', (id) => browser.snapshot(id))
  handle('browser:setBounds', (id, bounds) => browser.setBounds(id, bounds))
  handle('browser:open', (id, url) => {
    browser.newTab(id, url)
    return browser.snapshot(id)
  })
  handle('browser:navigate', (id, url) => void browser.activeTab(id).navigate(url).catch((err) => console.warn('[browser]', err)))
  handle('browser:tabAction', (id, action, tabId) => {
    if (action === 'new') browser.newTab(id)
    else if (action === 'select' && tabId) browser.selectTab(id, tabId)
    else if (action === 'close' && tabId) browser.closeTab(id, tabId)
    else {
      const t = browser.activeTab(id)
      if (action === 'back' && t.wc.navigationHistory.canGoBack()) t.wc.navigationHistory.goBack()
      if (action === 'forward' && t.wc.navigationHistory.canGoForward()) t.wc.navigationHistory.goForward()
      if (action === 'reload') t.wc.reload()
    }
    return browser.snapshot(id)
  })
  handle('browser:setPaused', (id, paused) => browser.setPaused(id, paused))
  handle('browser:suspend', (on) => browser.setSuspended(on))
  handle('resources:get', () => resources.current())
  handle('resources:stopTask', (workspaceId, taskId) => agent.stopTask(workspaceId, taskId))
  handle('resources:cancelWaiting', (workspaceId) => resources.cancelWaiting(workspaceId))
  handle('agent:interrupt', (id) => agent.interrupt(id))
  handle('agent:permission', (r) => interaction.answerPermission(r))
  handle('agent:answerQuestion', (r) => interaction.answerQuestion(r))

  // ---- vendor agents over ACP ----
  handle('acp:probe', (engine, accountId) => acp.probe(engine, accountId))
  handle('acp:probes', () => acp.probeCache)
  // ---- session notes ----
  notes.setNotesEmitter((workspaceId, list) => send('notes:changed', { workspaceId, notes: list }))
  handle('notes:list', (wsId) => notes.list(wsId))
  handle('notes:add', (wsId, text, kind) => notes.add(wsId, text, kind, 'user'))
  handle('notes:update', (wsId, id, patch) => notes.update(wsId, id, patch))
  handle('notes:remove', (wsId, id) => notes.remove(wsId, id))
  handle('crew:inventory', () => crewSuggest.inventory())
  handle('crew:suggest', (spaceId) => crewSuggest.suggest(spaceId))
  handle('acp:authenticate', (engine, methodId) => acp.authenticate(engine, methodId))
  // ---- model providers (native engine) ----
  handle('providers:add', (cfg) => providers.addProvider(cfg))
  handle('providers:update', (id, patch) => providers.updateProvider(id, patch))
  handle('providers:remove', (id) => providers.removeProvider(id))
  handle('providers:models', (id) => providers.fetchModels(id))
  handle('agent:unqueue', (id, mid) => agent.unqueue(id, mid, emitAgent))
  handle('sessions:list', (id, scope, q) => sessionsSvc.listResumable(id, scope, q))
  handle('sessions:resume', (id, sid) => sessionsSvc.resumeInto(id, sid))
  handle('workspaces:fork', async (id, name) => {
    const created = await sessionsSvc.forkWorkspace(id, name, emitScript)
    notes.copy(id, created.id)
    return created
  })
  handle('agent:reset', (id) => {
    agent.resetSession(id)
    clearTranscript(id)
  })
  handle('chat:load', (id) => {
    if (!agent.isBusy(id)) markInterrupted(id)
    return { items: getTranscript(id), busy: agent.isBusy(id) }
  })
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
    oncall.stop()
    browserHttp.stop()
    browser.closeAll()
    resources.stop()
    flushAllTranscripts()
    agent.closeAllSessions()
    terminal.disposeAllTerminals()
  })
  // keep runScript referenced for the archive path's typing
  void runScript
}
