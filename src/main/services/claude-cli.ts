/**
 * Where the Claude Code binary is. Sinfonie ships the Agent SDK, and the SDK ships a native
 * `claude` for this platform, so nothing has to be installed on the Mac. A system install is
 * used only as a fallback. GUI apps get a minimal PATH, so well-known locations are checked too.
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { app } from 'electron'

let cached: { bundled: string | null; any: string } | null = null

function resolve(): { bundled: string | null; any: string } {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const candidates: string[] = []
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    candidates.push(require.resolve(`${pkg}/claude`))
  } catch {
    /* not resolvable from here */
  }
  if (app.isPackaged) candidates.push(join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', pkg, 'claude'))
  else candidates.push(join(app.getAppPath(), 'node_modules', pkg, 'claude'))
  // Inside the asar the file exists but cannot run; the unpacked copy is the one to use.
  const bundled = candidates.map((p) => p.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')).find((p) => existsSync(p)) ?? null
  const system = [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find((p) => existsSync(p))
  return { bundled, any: bundled ?? system ?? 'claude' }
}

/** The binary to run for CLI commands such as `claude auth login`. Prefers the bundled one. */
export function claudeBinary(): string {
  cached ??= resolve()
  return cached.any
}
/** Option to pin Agent SDK sessions to the bundled binary; empty when it could not be found. */
export function claudeExecutableOption(): { pathToClaudeCodeExecutable?: string } {
  cached ??= resolve()
  return cached.bundled ? { pathToClaudeCodeExecutable: cached.bundled } : {}
}
