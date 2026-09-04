import * as pty from 'node-pty'
import { nanoid } from 'nanoid'

type DataHandler = (terminalId: string, data: string) => void
type ExitHandler = (terminalId: string, exitCode: number) => void

const terminals = new Map<string, pty.IPty>()

export function createTerminal(
  cwd: string,
  env: NodeJS.ProcessEnv,
  onData: DataHandler,
  onExit: ExitHandler,
  command?: string
): string {
  const id = nanoid(10)
  const shell = process.env.SHELL || '/bin/zsh'
  const term = pty.spawn(shell, command ? ['-lc', command] : ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: env as Record<string, string>
  })
  terminals.set(id, term)
  term.onData((d) => onData(id, d))
  term.onExit(({ exitCode }) => {
    terminals.delete(id)
    onExit(id, exitCode)
  })
  return id
}

export function writeTerminal(id: string, data: string): void {
  terminals.get(id)?.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const t = terminals.get(id)
  if (t && cols > 0 && rows > 0) t.resize(cols, rows)
}

export function disposeTerminal(id: string): void {
  const t = terminals.get(id)
  if (t) {
    t.kill()
    terminals.delete(id)
  }
}

export function disposeAllTerminals(): void {
  for (const id of Array.from(terminals.keys())) disposeTerminal(id)
}
