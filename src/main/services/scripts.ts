import { spawn, type ChildProcess } from 'child_process'
import type { Workspace, Repo, ScriptOutputEvent } from '@shared/types'

type Emit = (event: ScriptOutputEvent) => void

const running = new Map<string, ChildProcess>()

function key(workspaceId: string, repoId: string, kind: string): string {
  return `${workspaceId}:${repoId}:${kind}`
}

/**
 * Env vars injected into every script and terminal. Both CONDUCTOR_* and
 * ORCHESTRA_* names are set, so conductor.json files keep working unchanged.
 */
export function workspaceEnv(ws: Workspace, repo: Repo, worktreePath: string): NodeJS.ProcessEnv {
  const vars = {
    PORT: String(ws.port),
    ROOT_PATH: repo.path,
    WORKSPACE_NAME: ws.slug,
    WORKSPACE_PATH: worktreePath,
    WORKSPACE_ROOT: ws.rootPath
  }
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(vars)) {
    env[`CONDUCTOR_${k}`] = v
    env[`ORCHESTRA_${k}`] = v
  }
  // Give each repo inside the workspace its own port slot within the block of 10.
  const idx = ws.repos.findIndex((r) => r.repoId === repo.id)
  if (idx > 0) {
    env.CONDUCTOR_PORT = String(ws.port + idx)
    env.ORCHESTRA_PORT = String(ws.port + idx)
  }
  return env
}

export function runScript(
  ws: Workspace,
  repo: Repo,
  worktreePath: string,
  kind: 'setup' | 'run' | 'archive',
  command: string,
  emit: Emit
): Promise<number | null> {
  const k = key(ws.id, repo.id, kind)
  stopScript(ws.id, repo.id, kind)
  return new Promise((resolve) => {
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd: worktreePath,
      env: workspaceEnv(ws, repo, worktreePath)
    })
    running.set(k, child)
    emit({ workspaceId: ws.id, repoId: repo.id, kind, data: `$ ${command}\r\n` })
    child.stdout.on('data', (d: Buffer) =>
      emit({ workspaceId: ws.id, repoId: repo.id, kind, data: d.toString().replace(/\n/g, '\r\n') })
    )
    child.stderr.on('data', (d: Buffer) =>
      emit({ workspaceId: ws.id, repoId: repo.id, kind, data: d.toString().replace(/\n/g, '\r\n') })
    )
    child.on('close', (code) => {
      running.delete(k)
      emit({ workspaceId: ws.id, repoId: repo.id, kind, data: `\r\n[exit ${code}]\r\n`, done: true, exitCode: code })
      resolve(code)
    })
    child.on('error', (err) => {
      running.delete(k)
      emit({ workspaceId: ws.id, repoId: repo.id, kind, data: `\r\n[error] ${err.message}\r\n`, done: true, exitCode: -1 })
      resolve(-1)
    })
  })
}

export function stopScript(workspaceId: string, repoId: string, kind: string): void {
  const child = running.get(key(workspaceId, repoId, kind))
  if (child) {
    child.kill('SIGTERM')
    running.delete(key(workspaceId, repoId, kind))
  }
}

export function stopAllScripts(workspaceId: string): void {
  for (const [k, child] of running) {
    if (k.startsWith(`${workspaceId}:`)) {
      child.kill('SIGTERM')
      running.delete(k)
    }
  }
}
