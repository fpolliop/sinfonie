/**
 * The vendor's own CLI, interactive, inside a workspace terminal: `claude` in the worktree with the
 * other worktrees added, or `codex`, `gemini`, `grok`. No harness in between: the user gets the CLI's
 * native UI, slash commands, hooks and plugins, on the same account and permission mode the workspace
 * uses for its chats. Some people prefer that to a wrapper; Orca and Superset only work this way.
 */
import { existsSync } from 'fs'
import { getStore } from '../store'
import { accountForEngine, envForAccount } from './accounts'
import { claudeBinary } from './claude-cli'
import { apiKeyForKind } from './providers'
import type { Engine, Workspace } from '@shared/types'

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Which CLIs can be opened: an engine is listed when an account exists for its vendor that is not
 * known to be signed out (unchecked accounts count: the CLI shows its own login screen if it must).
 * Claude Code is always offered when the claude binary is installed, as with the default account.
 */
export function availableClis(): Engine[] {
  const accounts = getStore().get().settings.claudeAccounts
  const has = (vendor: string): boolean => accounts.some((a) => (a.vendor ?? 'anthropic') === vendor && a.loggedIn !== false)
  const out: Engine[] = []
  if (has('anthropic') || existsSync(claudeBinary())) out.push('claude-code')
  if (has('openai')) out.push('codex')
  if (has('google') || apiKeyForKind('google')) out.push('gemini')
  if (has('xai')) out.push('grok')
  return out
}

/** The shell command and environment that start the CLI for this workspace, in `cwd` (one of its worktrees). */
export function cliLaunch(engine: Engine, ws: Workspace, cwd: string): { command: string; env: NodeJS.ProcessEnv; label: string } {
  const { spaces, settings } = getStore().get()
  const space = spaces.find((s) => s.id === ws.spaceId)
  const env: NodeJS.ProcessEnv = { ...envForAccount(accountForEngine(engine, ws.claudeAccountId)) }
  const others = ws.repos.map((r) => r.worktreePath).filter((p) => p !== cwd)
  switch (engine) {
    case 'claude-code': {
      const mode = ws.permissionMode ?? space?.permissionMode ?? settings.permissionMode
      const args = [...others.flatMap((p) => ['--add-dir', q(p)])]
      if (mode === 'acceptEdits' || mode === 'plan' || mode === 'bypassPermissions') args.push('--permission-mode', mode)
      return { command: [q(claudeBinary()), ...args].join(' '), env, label: 'Claude Code' }
    }
    case 'codex':
      // The installed CLI when there is one, else the npm package on the fly.
      return { command: `if command -v codex >/dev/null 2>&1; then codex; else npx -y @openai/codex@latest; fi`, env, label: 'Codex' }
    case 'gemini': {
      if (!env.GEMINI_API_KEY) {
        const key = apiKeyForKind('google')
        if (key) env.GEMINI_API_KEY = key
      }
      return { command: `gemini ${others.map((p) => `--include-directories ${q(p)}`).join(' ')}`.trim(), env, label: 'Gemini CLI' }
    }
    case 'grok':
      return { command: 'grok', env, label: 'Grok' }
    default:
      throw new Error(`${engine} has no interactive CLI. Use the chat.`)
  }
}
