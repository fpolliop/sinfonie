import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { nanoid } from 'nanoid'
import type { ClaudeAccount, Settings } from '@shared/types'
import { getStore } from '../store'
import { createTerminal, writeTerminal } from './terminal'

const exec = promisify(execFile)

export function getAccount(id: string | undefined): ClaudeAccount {
  const { settings } = getStore().get()
  return settings.claudeAccounts.find((a) => a.id === id) ?? settings.claudeAccounts.find((a) => a.id === settings.defaultClaudeAccountId) ?? settings.claudeAccounts[0]
}

/** Env additions that make the CLI / SDK use this account's credentials. */
export function accountEnv(id: string | undefined): NodeJS.ProcessEnv {
  const acc = getAccount(id)
  return acc.configDir ? { CLAUDE_CONFIG_DIR: acc.configDir } : {}
}

export function addAccount(name: string): Settings {
  const id = nanoid(6)
  const dir = join(homedir(), '.sinfonie', 'claude-accounts', id)
  mkdirSync(dir, { recursive: true })
  return getStore().update((d) => {
    d.settings.claudeAccounts.push({ id, name: name.trim() || `Account ${d.settings.claudeAccounts.length + 1}`, configDir: dir })
  }).settings
}

export function removeAccount(id: string): Settings {
  return getStore().update((d) => {
    if (id === 'default') return
    d.settings.claudeAccounts = d.settings.claudeAccounts.filter((a) => a.id !== id)
    if (d.settings.defaultClaudeAccountId === id) d.settings.defaultClaudeAccountId = 'default'
    for (const w of d.workspaces) if (w.claudeAccountId === id) delete w.claudeAccountId
  }).settings
}

export function setDefaultAccount(id: string): Settings {
  return getStore().update((d) => {
    d.settings.defaultClaudeAccountId = id
  }).settings
}

/** Runs `claude auth status` with the account's config dir and records the answer. */
export async function checkAccount(id: string): Promise<Settings> {
  const acc = getAccount(id)
  const env = { ...process.env, ...accountEnv(id) }
  let loggedIn = false
  let detail = ''
  try {
    const { stdout } = await exec('claude', ['auth', 'status', '--json'], { env, timeout: 20_000 })
    try {
      const j = JSON.parse(stdout) as Record<string, unknown>
      loggedIn = Boolean(j.loggedIn ?? j.logged_in ?? j.authenticated)
      detail = [j.email, j.subscriptionType ?? j.subscription, j.authMethod ?? j.method].filter(Boolean).join(' · ')
    } catch {
      loggedIn = /logged in/i.test(stdout) && !/not logged in/i.test(stdout)
      detail = stdout.trim().split('\n')[0] ?? ''
    }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || String(err)
    loggedIn = false
    detail = text.split('\n')[0]
  }
  return getStore().update((d) => {
    const a = d.settings.claudeAccounts.find((x) => x.id === acc.id)
    if (a) {
      a.loggedIn = loggedIn
      a.detail = detail
      a.checkedAt = new Date().toISOString()
    }
  }).settings
}

/** Opens an in-app shell already running `claude auth login` for this account. */
export function loginTerminal(id: string, onData: (tid: string, d: string) => void, onExit: (tid: string, code: number) => void): string {
  const env = { ...process.env, ...accountEnv(id) }
  const tid = createTerminal(homedir(), env, onData, onExit)
  // Give the shell a moment to start, then run the login.
  setTimeout(() => writeTerminal(tid, 'claude auth login\r'), 400)
  return tid
}
