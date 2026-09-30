/**
 * Apps launched from Finder get launchd's minimal PATH, so gh, gcloud, npx and friends from Homebrew
 * or nvm are "not found" even though they work in the terminal. Ask the login shell for its PATH once
 * at startup and adopt it, with the usual tool folders appended as a safety net.
 */
import { app } from 'electron'
import { execFile } from 'child_process'
import { accessSync, constants, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const EXTRA = [`${homedir()}/.local/bin`, `${homedir()}/.grok/bin`, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

/** How long an answer from the login shell is reused: long enough to be cheap, short enough to see a new install. */
const SHELL_PATH_TTL_MS = 60_000

/** The login shell's PATH (`$SHELL -ilc 'echo $PATH'`), cached for a minute. */
let shellPathCache: { at: number; value: Promise<string> } | null = null
export function loginShellPath(): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve(process.env.PATH ?? '')
  if (shellPathCache && Date.now() - shellPathCache.at < SHELL_PATH_TTL_MS) return shellPathCache.value
  const value = new Promise<string>((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    execFile(shell, ['-ilc', 'printf "__SP__%s__SP__" "$PATH"'], { timeout: 5000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } }, (err, out) => resolve(err ? '' : (/__SP__(.*?)__SP__/s.exec(String(out))?.[1] ?? '')))
  })
  shellPathCache = { at: Date.now(), value }
  return value
}

/**
 * Adopts the login shell's PATH (again, when the cached answer is older than a minute). Sinfonie's own tools folder
 * (prereqs.ensureToolsOnPath) always stays last, after the usual tool folders, so the person's own tools win.
 */
export async function adoptShellPath(): Promise<void> {
  if (process.platform === 'win32') return
  const fromShell = await loginShellPath()
  const own = join(app.getPath('userData'), 'tools', 'bin')
  const all = [...fromShell.split(':'), ...(process.env.PATH ?? '').split(':'), ...EXTRA].map((p) => p.trim()).filter(Boolean)
  const hasOwn = all.includes(own)
  const parts = all.filter((p) => p !== own)
  process.env.PATH = [...Array.from(new Set(parts)), ...(hasOwn ? [own] : [])].join(':')
}

/** Where `bin` lives on the adopted PATH (plus the usual tool folders), or null when it is not installed. No shell is spawned. */
export function whichSync(bin: string): string | null {
  const dirs = [...(process.env.PATH ?? '').split(':'), ...EXTRA].filter(Boolean)
  for (const d of new Set(dirs)) {
    const p = join(d, bin)
    try {
      if (!statSync(p).isFile()) continue
      accessSync(p, constants.X_OK)
      return p
    } catch {
      // not here
    }
  }
  return null
}

/** Same as whichSync, after adopting the login shell's PATH afresh (at most a minute old), so a tool installed since launch is found too. */
export async function which(bin: string): Promise<string | null> {
  await adoptShellPath()
  return whichSync(bin)
}
