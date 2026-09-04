/**
 * Apps launched from Finder get launchd's minimal PATH, so gh, gcloud, npx and friends from Homebrew
 * or nvm are "not found" even though they work in the terminal. Ask the login shell for its PATH once
 * at startup and adopt it, with the usual tool folders appended as a safety net.
 */
import { execFile } from 'child_process'
import { homedir } from 'os'

const EXTRA = [`${homedir()}/.local/bin`, `${homedir()}/.grok/bin`, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

export async function adoptShellPath(): Promise<void> {
  if (process.platform === 'win32') return
  const shell = process.env.SHELL || '/bin/zsh'
  const fromShell = await new Promise<string>((resolve) => {
    execFile(shell, ['-ilc', 'printf "__SP__%s__SP__" "$PATH"'], { timeout: 5000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } }, (err, out) => resolve(err ? '' : (/__SP__(.*?)__SP__/s.exec(String(out))?.[1] ?? '')))
  })
  const parts = [...fromShell.split(':'), ...(process.env.PATH ?? '').split(':'), ...EXTRA].map((p) => p.trim()).filter(Boolean)
  process.env.PATH = Array.from(new Set(parts)).join(':')
}
