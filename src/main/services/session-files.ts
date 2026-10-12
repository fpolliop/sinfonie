import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Workspace } from '@shared/types'
import { accountEnv } from './accounts'

/** Claude Code keeps sessions under <config>/projects/<cwd with every non [A-Za-z0-9-] char turned into '-'>/<id>.jsonl. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-')
}

export function claudeConfigDir(accountId: string | undefined): string {
  return accountEnv(accountId).CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

/** Where Claude runs for a workspace: the primary worktree, or the workspace root when it has no repositories. */
export function sessionCwd(ws: Workspace): string {
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  return primary?.worktreePath ?? ws.rootPath
}

/**
 * The CLI only resumes sessions that live in the current project's folder. A workspace's folder changes when its
 * first repository is added (root → primary worktree) or its primary changes, which strands the session in the old
 * folder ("No conversation found"). Copy it, with its subagent/tool-result folder, into the folder Claude will look in.
 * `hintCwd` is where the session was recorded, when known; otherwise every project folder is searched and the most
 * recently written copy wins. Returns false when no copy exists anywhere.
 */
export function makeResumable(ws: Workspace, sessionId: string, hintCwd?: string): boolean {
  const projects = join(claudeConfigDir(ws.claudeAccountId), 'projects')
  const destDir = join(projects, encodeProjectDir(sessionCwd(ws)))
  const dest = join(destDir, `${sessionId}.jsonl`)
  if (existsSync(dest)) return true
  let src = hintCwd ? join(projects, encodeProjectDir(hintCwd), `${sessionId}.jsonl`) : ''
  if (!src || !existsSync(src)) {
    src = ''
    let newest = -1
    if (existsSync(projects)) {
      for (const d of readdirSync(projects)) {
        const candidate = join(projects, d, `${sessionId}.jsonl`)
        if (!existsSync(candidate)) continue
        const mtime = statSync(candidate).mtimeMs
        if (mtime > newest) {
          newest = mtime
          src = candidate
        }
      }
    }
  }
  if (!src) return false
  mkdirSync(destDir, { recursive: true })
  cpSync(src, dest, { preserveTimestamps: true })
  const extras = src.replace(/\.jsonl$/, '')
  if (existsSync(extras)) cpSync(extras, join(destDir, sessionId), { recursive: true, preserveTimestamps: true })
  return true
}
