import { spawn, type ChildProcess } from 'child_process'
import type { Workspace, Repo, ScriptOutputEvent } from '@shared/types'

type Emit = (event: ScriptOutputEvent) => void

const running = new Map<string, ChildProcess>()
/** When each running script started, for the Running list. */
const startedAt = new WeakMap<ChildProcess, string>()

function key(workspaceId: string, repoId: string, kind: string): string {
  return `${workspaceId}:${repoId}:${kind}`
}

/**
 * Env vars injected into every script and terminal. Both CONDUCTOR_* and
 * SINFONIE_* names are set, so conductor.json files keep working unchanged.
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
    env[`SINFONIE_${k}`] = v
  }
  // Give each repo inside the workspace its own port slot within the block of 10.
  const idx = ws.repos.findIndex((r) => r.repoId === repo.id)
  if (idx > 0) {
    env.CONDUCTOR_PORT = String(ws.port + idx)
    env.SINFONIE_PORT = String(ws.port + idx)
  }
  return env
}

/** How long a setup or archive script may run before it is stopped, so a workspace never stays "setting up" forever. */
export const SCRIPT_TIMEOUT_MS: Partial<Record<'setup' | 'run' | 'archive', number>> = { setup: 20 * 60_000, archive: 5 * 60_000 }
/** Check scripts (build, tests, lint) before Send for review. */
export const CHECK_TIMEOUT_MS = 10 * 60_000

/**
 * Starts a script and resolves with its exit code when it ends. The child is spawned synchronously, so a caller that
 * only needs it started can skip awaiting. Stdin is closed (a script that prompts gets EOF instead of hanging), and
 * setup/archive scripts are stopped after SCRIPT_TIMEOUT_MS.
 */
export function runScript(
  ws: Workspace,
  repo: Repo,
  worktreePath: string,
  kind: 'setup' | 'run' | 'archive',
  command: string,
  emit: Emit,
  opts: { timeoutMs?: number } = {}
): Promise<number | null> {
  const k = key(ws.id, repo.id, kind)
  stopScript(ws.id, repo.id, kind)
  return new Promise((resolve) => {
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd: worktreePath,
      env: workspaceEnv(ws, repo, worktreePath),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    running.set(k, child)
    startedAt.set(child, new Date().toISOString())
    emit({ workspaceId: ws.id, repoId: repo.id, kind, data: `$ ${command}\r\n` })
    const limit = opts.timeoutMs ?? SCRIPT_TIMEOUT_MS[kind]
    const timer = limit
      ? setTimeout(() => {
          if (running.get(k) !== child) return
          emit({ workspaceId: ws.id, repoId: repo.id, kind, data: `\r\n[stopped: the ${kind} script ran longer than ${Math.round(limit / 60_000)} minutes]\r\n` })
          child.kill('SIGTERM')
          setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5_000).unref()
        }, limit)
      : null
    timer?.unref()
    child.stdout?.on('data', (d: Buffer) =>
      emit({ workspaceId: ws.id, repoId: repo.id, kind, data: d.toString().replace(/\n/g, '\r\n') })
    )
    child.stderr?.on('data', (d: Buffer) =>
      emit({ workspaceId: ws.id, repoId: repo.id, kind, data: d.toString().replace(/\n/g, '\r\n') })
    )
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (running.get(k) === child) running.delete(k)
      emit({ workspaceId: ws.id, repoId: repo.id, kind, data: `\r\n[exit ${code}]\r\n`, done: true, exitCode: code })
      resolve(code)
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      if (running.get(k) === child) running.delete(k)
      emit({ workspaceId: ws.id, repoId: repo.id, kind, data: `\r\n[error] ${err.message}\r\n`, done: true, exitCode: -1 })
      resolve(-1)
    })
  })
}

/**
 * Runs a command once to completion, capturing its output. Not tracked in the run/setup registry. Stdin is closed and
 * the command is stopped after `timeoutMs` (a check that waits for input or never exits would hang Send for review).
 */
export function runCommandOnce(ws: Workspace, repo: Repo, worktreePath: string, command: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<{ code: number | null; output: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    const child = spawn('/bin/zsh', ['-lc', command], { cwd: worktreePath, env: workspaceEnv(ws, repo, worktreePath), stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      timedOut = true
      output += `\n[stopped after ${Math.round(timeoutMs / 60_000)} minutes]`
      child.kill('SIGTERM')
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5_000).unref()
    }, timeoutMs)
    timer.unref()
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: timedOut ? -1 : code, output: output.slice(-20_000), ...(timedOut ? { timedOut } : {}) })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, output: output + `\n${err.message}` })
    })
  })
}

/** True while a script of this kind is running for the repo in the workspace. */
/** Every script running now, for the Running list. */
export function runningScripts(): { workspaceId: string; repoId: string; kind: string; startedAt: string }[] {
  return Array.from(running, ([k, child]) => {
    const [workspaceId, repoId, kind] = k.split(':')
    return { workspaceId, repoId, kind, startedAt: startedAt.get(child) ?? new Date().toISOString() }
  })
}

export function isScriptRunning(workspaceId: string, repoId: string, kind: string): boolean {
  return running.has(key(workspaceId, repoId, kind))
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
