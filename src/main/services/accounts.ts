import { claudeBinary } from './claude-cli'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { nanoid } from 'nanoid'
import type { ClaudeAccount, Engine, LoginProgress, Settings, Vendor } from '@shared/types'
import { VENDORS } from '@shared/types'
import { getStore } from '../store'
import { createTerminal } from './terminal'
import { probe } from './acp/engine'

const exec = promisify(execFile)

export function vendorOfEngine(engine: Engine): Vendor | null {
  return VENDORS.find((v) => v.engine === engine)?.id ?? null
}

export function defaultAccountId(vendor: Vendor): string | undefined {
  const { settings } = getStore().get()
  if (vendor === 'anthropic') return settings.defaultClaudeAccountId
  return settings.defaultAccounts?.[vendor] ?? `${vendor}-default`
}

export function getAccount(id: string | undefined): ClaudeAccount {
  const { settings } = getStore().get()
  const list = settings.claudeAccounts
  return list.find((a) => a.id === id) ?? list.find((a) => a.id === settings.defaultClaudeAccountId) ?? list[0]
}

/** The account an engine should use for a workspace: the workspace's own if it belongs to that vendor, else the vendor default. */
export function accountForEngine(engine: Engine, workspaceAccountId: string | undefined): ClaudeAccount | undefined {
  const vendor = vendorOfEngine(engine)
  if (!vendor) return undefined
  const list = getStore().get().settings.claudeAccounts
  const own = list.find((a) => a.id === workspaceAccountId)
  if (own && (own.vendor ?? 'anthropic') === vendor) return own
  return list.find((a) => a.id === defaultAccountId(vendor)) ?? list.find((a) => (a.vendor ?? 'anthropic') === vendor)
}

/** Env additions that make a vendor's CLI use this account's credentials. */
export function envForAccount(acc: ClaudeAccount | undefined): NodeJS.ProcessEnv {
  if (!acc || !acc.configDir) return {}
  switch (acc.vendor ?? 'anthropic') {
    case 'anthropic':
      return { CLAUDE_CONFIG_DIR: acc.configDir }
    case 'openai':
      return { CODEX_HOME: acc.configDir }
    case 'google':
      // The Gemini CLI keeps its state under $HOME/.gemini; a private HOME isolates it.
      return { HOME: acc.configDir, GEMINI_CLI_HOME: acc.configDir }
    case 'xai':
      return { HOME: acc.configDir }
  }
}

/** Claude Code engine and review engine: env for a workspace's Anthropic account. */
export function accountEnv(id: string | undefined): NodeJS.ProcessEnv {
  return envForAccount(accountForEngine('claude-code', id))
}

/** Any engine: env for the account that engine should use in this workspace. */
export function accountEnvFor(engine: Engine, workspaceAccountId: string | undefined): NodeJS.ProcessEnv {
  return envForAccount(accountForEngine(engine, workspaceAccountId))
}

export function addAccount(name: string, vendor: Vendor = 'anthropic'): Settings {
  const id = nanoid(6)
  const dir = join(homedir(), '.sinfonie', 'accounts', vendor, id)
  mkdirSync(dir, { recursive: true })
  const label = VENDORS.find((v) => v.id === vendor)?.label ?? vendor
  return getStore().update((d) => {
    d.settings.claudeAccounts.push({ id, name: name.trim() || `${label} account`, vendor, configDir: dir })
  }).settings
}

export function removeAccount(id: string): Settings {
  return getStore().update((d) => {
    const acc = d.settings.claudeAccounts.find((a) => a.id === id)
    if (!acc || acc.configDir === null) return
    d.settings.claudeAccounts = d.settings.claudeAccounts.filter((a) => a.id !== id)
    if (d.settings.defaultClaudeAccountId === id) d.settings.defaultClaudeAccountId = 'default'
    for (const [v, def] of Object.entries(d.settings.defaultAccounts ?? {})) if (def === id) delete d.settings.defaultAccounts![v as Vendor]
    for (const w of d.workspaces) if (w.claudeAccountId === id) delete w.claudeAccountId
    for (const s of d.spaces) if (s.claudeAccountId === id) delete s.claudeAccountId
  }).settings
}

export function setDefaultAccount(id: string): Settings {
  return getStore().update((d) => {
    const acc = d.settings.claudeAccounts.find((a) => a.id === id)
    if (!acc) return
    const vendor = acc.vendor ?? 'anthropic'
    if (vendor === 'anthropic') d.settings.defaultClaudeAccountId = id
    else d.settings.defaultAccounts = { ...(d.settings.defaultAccounts ?? {}), [vendor]: id }
  }).settings
}

/** Ask the vendor CLI whether this account is signed in, and record the answer. */
export async function checkAccount(id: string): Promise<Settings> {
  const acc = getAccount(id)
  const vendor = acc.vendor ?? 'anthropic'
  let loggedIn = false
  let detail = ''
  if (vendor === 'anthropic') {
    const env = { ...process.env, ...envForAccount(acc) }
    try {
      const { stdout } = await exec(claudeBinary(), ['auth', 'status', '--json'], { env, timeout: 20_000 })
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
      detail = (`${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || String(err)).split('\n')[0]
    }
  } else {
    const engine = VENDORS.find((v) => v.id === vendor)!.engine
    const p = await probe(engine, acc.id)
    loggedIn = p.signedIn
    detail = p.signedIn ? [p.agent, p.currentModel ? `model ${p.currentModel}` : ''].filter(Boolean).join(' · ') : p.error ?? (p.installed ? 'not signed in' : 'agent not installed')
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

const LOGIN_COMMANDS: Record<Vendor, string> = {
  get anthropic() {
    return `${JSON.stringify(claudeBinary())} auth login`
  },
  openai: 'npx -y @openai/codex@latest login',
  google: 'echo "Gemini signs in with the API key from Model providers → Google. Press Ctrl+D to close."',
  xai: 'grok login --oauth'
}

const SUCCESS_RE = /successfully logged in|logged in as|login successful|you are now logged in|logged in successfully|authentication successful|successfully authenticated|signed in as/i
const URL_RE = /https?:\/\/[^\s'"`)]+/

/**
 * Runs the vendor's sign-in for this account in a pty and reports progress: the sign-in URL once
 * the CLI prints it (the CLI opens the browser itself), then success or failure on exit. The pty
 * stays available to the renderer so an interactive prompt can still be answered.
 */
export function startLogin(id: string, onData: (tid: string, d: string) => void, onExit: (tid: string, code: number) => void, onProgress: (p: LoginProgress) => void): string {
  const acc = getAccount(id)
  const vendor = acc.vendor ?? 'anthropic'
  const env = { ...process.env, ...envForAccount(acc), PATH: `${homedir()}/.grok/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` }
  let url: string | undefined
  let succeeded = false
  let buffer = ''
  const tid = createTerminal(
    homedir(),
    env,
    (t, d) => {
      onData(t, d)
      buffer = (buffer + d.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(-8000)
      if (!url) {
        const m = buffer.match(URL_RE)
        if (m && !/localhost/.test(m[0])) {
          url = m[0]
          onProgress({ accountId: acc.id, terminalId: t, phase: 'browser', url })
        }
      }
      if (!succeeded && SUCCESS_RE.test(buffer)) {
        succeeded = true
        onProgress({ accountId: acc.id, terminalId: t, phase: 'success', url })
        void checkAccount(acc.id).catch(() => undefined)
      }
    },
    (t, code) => {
      onExit(t, code)
      if (succeeded) return
      if (code === 0) {
        succeeded = true
        onProgress({ accountId: acc.id, terminalId: t, phase: 'success', url })
        void checkAccount(acc.id).catch(() => undefined)
      } else {
        const lines = buffer.trim().split('\n').map((l) => l.trim()).filter(Boolean)
        onProgress({ accountId: acc.id, terminalId: t, phase: 'failed', url, message: lines.find((l) => /error/i.test(l)) ?? lines.at(-1) })
      }
    },
    LOGIN_COMMANDS[vendor]
  )
  onProgress({ accountId: acc.id, terminalId: tid, phase: 'starting' })
  return tid
}
