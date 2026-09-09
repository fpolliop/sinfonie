import React, { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { ChevronDown, ExternalLink, Plus, Search, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Button } from './ui'
import { CaffeineButton } from './CaffeineButton'
import { ACP_ENGINES, type Engine } from '@shared/types'

const CLI_LABELS: Record<string, string> = { 'claude-code': 'Claude Code', ...Object.fromEntries(ACP_ENGINES.map((e) => [e.id, e.label.replace(/ \(.*\)$/, '')])) }

/**
 * Shells for a workspace. Each shell is an xterm instance plus a pty in the main process; both
 * outlive tab switches and workspace switches. The xterm is opened once, into a container we own,
 * and that container is moved into whatever pane is showing: xterm cannot be opened twice, and
 * cannot be opened inside a hidden element (it measures the font on open), which is why the old
 * pane painted nothing.
 */
interface Shell {
  id: string
  workspaceId: string
  /** null: the workspace root, where all worktrees sit side by side. */
  repoId: string | null
  /** Set when the pty runs a vendor CLI (claude, codex, …) instead of a plain shell. */
  agent?: Engine
  /** How the pty is started; the default is terminal:create. CLI mode uses cli:start, which resumes the chat's session. */
  starter?: (cols: number, rows: number) => Promise<string>
  /** CLI-mode shells live in the Chat tab, not in the Terminal tab's list. */
  chatMode?: boolean
  label: string
  container: HTMLDivElement
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  terminalId: string | null
  /** xterm's open() ran (it must run exactly once, in a visible element). */
  opened: boolean
  exited: boolean
  unsub: () => void
}
const shells = new Map<string, Shell>()
const opening = new Set<string>()
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((l) => l())
let counter = 0

function shellsOf(workspaceId: string): Shell[] {
  return [...shells.values()].filter((s) => s.workspaceId === workspaceId && !s.chatMode)
}

function spawnShell(workspaceId: string, repoId: string | null, label: string, agent?: Engine, extra: Partial<Pick<Shell, 'starter' | 'chatMode'>> = {}): Shell {
  const container = document.createElement('div')
  container.className = 'h-full w-full'
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    theme: { background: '#0b0d11', foreground: '#e6e8ec', cursor: '#7c9cff', selectionBackground: 'rgba(124,156,255,.3)', black: '#1b2030', brightBlack: '#5f6779' },
    cursorBlink: true,
    scrollback: 10000,
    macOptionIsMeta: true,
    allowProposedApi: true
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon((_e, uri) => void api.invoke('shell:openExternal', uri)))
  const id = `sh${++counter}`
  const shell: Shell = { id, workspaceId, repoId, agent, label, container, term, fit, search, terminalId: null, opened: false, exited: false, unsub: () => undefined, ...extra }
  const raw = (data: string): void => {
    if (shell.terminalId) void api.invoke('terminal:write', shell.terminalId, data)
  }
  // macOS habits: ⌘C copies the selection, ⌘K clears. ⌘V is left to xterm's own paste (see the paste
  // listener below), so text pastes exactly once.
  // ⌘↩ and ⇧↩ send a line feed, which agent CLIs (Claude Code, Codex) take as "new line, don't send";
  // ⌥↩ already reaches them as Meta+Enter. Plain ↩ stays the carriage return that submits.
  term.attachCustomKeyEventHandler((e) => {
    if (e.key === 'Enter' && (e.metaKey || e.shiftKey) && !e.altKey && !e.ctrlKey) {
      // Swallow the keypress that follows too, or xterm would add its own carriage return.
      if (e.type === 'keydown') raw('\n')
      return false
    }
    if (e.type !== 'keydown' || !e.metaKey) return true
    if (e.key === 'c' && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection())
      return false
    }
    if (e.key === 'k') {
      term.clear()
      return false
    }
    return true
  })
  // Paste: xterm pastes text on its own. An image cannot travel as text, so when the clipboard holds one we
  // stop xterm's paste and send ⌃V instead, which Claude Code and Codex answer by reading the image
  // themselves. Handled at the paste event so text is never pasted twice.
  container.addEventListener(
    'paste',
    (e) => {
      const items = e.clipboardData?.items
      const hasImage = items ? Array.from(items).some((it) => it.kind === 'file' && it.type.startsWith('image/')) : false
      if (hasImage) {
        e.preventDefault()
        e.stopPropagation()
        raw('\x16')
      }
    },
    true
  )
  // Files dropped on the terminal arrive as their paths, escaped the way Finder drops them into Terminal.app,
  // so an image or a document can be attached to a CLI prompt by dragging it in.
  container.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
  })
  container.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (!files.length) return
    e.preventDefault()
    const paths = files.map((f) => api.pathOf(f)).filter(Boolean)
    if (paths.length) term.paste(paths.map((p) => p.replace(/([ '"\\()[\]{}$&;|<>*?~`!#])/g, '\\$1')).join(' ') + ' ')
    term.focus()
  })
  shells.set(id, shell)
  term.onData((d) => {
    if (shell.exited) return closeShell(id)
    if (shell.terminalId) void api.invoke('terminal:write', shell.terminalId, d)
  })
  term.onResize(({ cols, rows }) => shell.terminalId && void api.invoke('terminal:resize', shell.terminalId, cols, rows))
  notify()
  return shell
}

/** Starts the pty once xterm has measured itself, at the right size, so the first prompt is drawn once. */
async function ensurePty(shell: Shell): Promise<void> {
  if (shell.terminalId || shell.exited) return
  shell.terminalId = 'starting'
  // Output can arrive before we know the pty's id (a command that fails at once): keep everything until then.
  const early: { terminalId: string; data: string }[] = []
  const earlyExit: { terminalId: string }[] = []
  const offEarly = api.on('terminal:data', (e) => void early.push(e))
  const offEarlyExit = api.on('terminal:exit', (e) => void earlyExit.push(e))
  const started = shell.starter ? shell.starter(shell.term.cols, shell.term.rows) : api.invoke('terminal:create', shell.workspaceId, shell.repoId, shell.term.cols, shell.term.rows, shell.agent)
  const terminalId = await started.catch((err) => {
    shell.terminalId = null
    shell.term.write(`\r\n\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`)
    return null
  })
  offEarly()
  offEarlyExit()
  if (!terminalId) return
  shell.terminalId = terminalId
  const onExit = (): void => {
    shell.exited = true
    shell.term.write('\r\n\x1b[90m[shell exited, press any key to close]\x1b[0m\r\n')
    notify()
  }
  for (const e of early) if (e.terminalId === terminalId) shell.term.write(e.data)
  if (earlyExit.some((e) => e.terminalId === terminalId)) onExit()
  const offData = api.on('terminal:data', (e) => e.terminalId === terminalId && shell.term.write(e.data))
  const offExit = api.on('terminal:exit', (e) => e.terminalId === terminalId && onExit())
  shell.unsub = () => {
    offData()
    offExit()
  }
}

function closeShell(id: string): void {
  const s = shells.get(id)
  if (!s) return
  s.unsub()
  if (s.chatMode) void api.invoke('cli:stop', s.workspaceId)
  else if (s.terminalId && s.terminalId !== 'starting') void api.invoke('terminal:dispose', s.terminalId)
  s.term.dispose()
  s.container.remove()
  shells.delete(id)
  notify()
}

function useShells(workspaceId: string): Shell[] {
  const [, tick] = useState(0)
  useEffect(() => {
    const l = (): void => tick((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  return shellsOf(workspaceId)
}

export function TerminalPane({ workspaceId, visible }: { workspaceId: string; visible: boolean }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const list = useShells(workspaceId)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const [finding, setFinding] = useState(false)
  const ready = ws?.status === 'ready'
  const active = list.find((s) => s.id === activeId) ?? list[list.length - 1] ?? null

  const [clis, setClis] = useState<Engine[]>([])
  useEffect(() => {
    if (menu) void api.invoke('terminal:clis').then(setClis).catch(() => setClis([]))
  }, [menu])
  const open = useCallback(
    async (repoId: string | null, agent?: Engine) => {
      if (!ws) return
      const repoName = repoId ? (ws.repos.find((r) => r.repoId === repoId)?.repoName ?? 'shell') : ws.name
      const name = agent ? `${CLI_LABELS[agent] ?? agent} · ${repoName}` : repoName
      const n = shellsOf(workspaceId).filter((s) => s.repoId === repoId && s.agent === agent).length
      const s = spawnShell(workspaceId, repoId, n ? `${name} ${n + 1}` : name, agent)
      setActiveId(s.id)
      setMenu(false)
    },
    [ws, workspaceId]
  )
  // Another part of the app asked for a CLI here (the workspace menu): open it once the pane is up.
  const pendingShell = useApp((s) => s.pendingShell)
  const setPendingShell = useApp((s) => s.setPendingShell)
  useEffect(() => {
    if (!pendingShell || pendingShell.workspaceId !== workspaceId || !ready) return
    setPendingShell(null)
    void open(pendingShell.repoId ?? ws?.primaryRepoId ?? null, pendingShell.agent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingShell, ready])
  // First visit: one shell in the primary repo, so the tab is never empty (guarded: effects can run twice).
  useEffect(() => {
    if (!visible || !ready || !ws || shellsOf(workspaceId).length > 0 || opening.has(workspaceId)) return
    opening.add(workspaceId)
    void open(ws.primaryRepoId).finally(() => opening.delete(workspaceId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, ready, list.length])

  if (!ws) return <div />
  if (!ready) return <div className="p-4 text-[12px] text-muted">The terminal opens once the workspace is ready.</div>
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        {list.map((s) => (
          <div key={s.id} className={clsx('group flex items-center gap-1 rounded-md pl-2.5 pr-1 py-0.5 text-[12px]', s.id === active?.id ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
            <button onClick={() => setActiveId(s.id)} className={clsx(s.exited && 'line-through')}>
              {s.label}
            </button>
            <button onClick={() => closeShell(s.id)} className="rounded p-0.5 text-muted opacity-0 hover:text-text group-hover:opacity-100" title="Close this shell">
              <X size={11} />
            </button>
          </div>
        ))}
        <div className="relative">
          <Button size="sm" variant="ghost" onClick={() => setMenu((m) => !m)} title="New shell or agent CLI">
            <Plus size={13} />
            <ChevronDown size={11} />
          </Button>
          {menu && (
            <div className="absolute left-0 top-full z-20 mt-1 min-w-[220px] rounded-md border border-border bg-panel p-1 shadow-xl" onMouseLeave={() => setMenu(false)}>
              <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Shell</div>
              {ws.repos.map((r) => (
                <button key={r.repoId} onClick={() => void open(r.repoId)} className="block w-full rounded px-2 py-1 text-left text-[12px] hover:bg-panel-2">
                  {r.repoName}
                </button>
              ))}
              <button onClick={() => void open(null)} className="block w-full rounded px-2 py-1 text-left text-[12px] hover:bg-panel-2">
                Workspace root
              </button>
              <div className="my-1 border-t border-border" />
              <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted" title="The vendor's own CLI, interactive, on this workspace's account. No harness in between.">
                Agent CLI
              </div>
              {clis.length === 0 && <div className="px-2 py-1 text-[11px] text-muted">Sign in to a vendor under Settings → Accounts.</div>}
              {clis.map((e) =>
                ws.repos.map((r) => (
                  <button key={`${e}:${r.repoId}`} onClick={() => void open(r.repoId, e)} className="block w-full rounded px-2 py-1 text-left text-[12px] hover:bg-panel-2" title={e === 'claude-code' && ws.repos.length > 1 ? 'Runs claude in this worktree with the other worktrees added (--add-dir)' : undefined}>
                    {CLI_LABELS[e] ?? e}
                    {ws.repos.length > 1 && <span className="text-muted"> · {r.repoName}</span>}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <span className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setFinding((f) => !f)} title="Find in output (⌘F)">
            <Search size={13} />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void api.invoke('workspaces:openIn', ws.id, 'terminal')} title="Open the workspace in Terminal.app">
            <ExternalLink size={13} />
          </Button>
          <span className="ml-1 text-[11px] text-muted">$SINFONIE_PORT={ws.port}</span>
        </span>
      </div>
      {finding && active && <FindBar shell={active} onClose={() => setFinding(false)} />}
      <div className="relative min-h-0 flex-1 bg-[#0b0d11]">{active && <Mount shell={active} visible={visible} onFind={() => setFinding(true)} />}</div>
    </div>
  )
}

/** Puts the shell's own container into the pane and sizes it; the container moves with the shell between mounts. */
function Mount({ shell, visible, onFind }: { shell: Shell; visible: boolean; onFind: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = ref.current
    if (!host) return
    host.appendChild(shell.container)
    const settle = (): void => {
      if (!visible || host.clientWidth === 0) return
      if (!shell.opened) {
        shell.term.open(shell.container)
        shell.opened = true
      }
      shell.fit.fit()
      void ensurePty(shell)
      shell.term.focus()
    }
    // Layout exists once the effect runs, so settle now; rAF and ResizeObserver are paused while the
    // window is occluded, so they alone would leave the pane blank until the window is uncovered.
    settle()
    const raf = requestAnimationFrame(settle)
    const ro = new ResizeObserver(() => settle())
    ro.observe(host)
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.key === 'f') {
        e.preventDefault()
        onFind()
      }
    }
    shell.container.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      shell.container.removeEventListener('keydown', onKey)
      if (shell.container.parentElement === host) host.removeChild(shell.container)
    }
  }, [shell, visible, onFind])
  return <div ref={ref} className="h-full w-full p-1" />
}

function FindBar({ shell, onClose }: { shell: Shell; onClose: () => void }): React.JSX.Element {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  const find = (dir: 1 | -1): void => {
    if (!q) return
    if (dir === 1) shell.search.findNext(q, { incremental: false })
    else shell.search.findPrevious(q)
  }
  return (
    <div className="flex items-center gap-1 border-b border-border bg-panel px-2 py-1">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          shell.search.findNext(e.target.value, { incremental: true })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') find(e.shiftKey ? -1 : 1)
          if (e.key === 'Escape') onClose()
        }}
        placeholder="Find in output"
        className="w-64 rounded-md border border-border bg-bg px-2 py-0.5 text-[12px] outline-none focus:border-accent"
      />
      <Button size="sm" variant="ghost" onClick={() => find(-1)}>
        Prev
      </Button>
      <Button size="sm" variant="ghost" onClick={() => find(1)}>
        Next
      </Button>
      <Button size="sm" variant="ghost" onClick={onClose} title="Close (Esc)">
        <X size={12} />
      </Button>
    </div>
  )
}

/** The Chat tab in CLI mode: the real claude in this workspace's primary worktree, on the chat's session. */
export function CliView({ workspaceId, prompt, onPromptConsumed, onBackToChat }: { workspaceId: string; prompt?: string; onPromptConsumed?: () => void; onBackToChat: () => void }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const [, tick] = useState(0)
  useEffect(() => {
    const l = (): void => tick((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  const key = `cli:${workspaceId}`
  const ready = ws?.status === 'ready'
  const [gen, setGen] = useState(0)
  // Spawn in an effect, not during render, and only while the workspace is still in CLI mode.
  useEffect(() => {
    if (!ready || shells.has(key)) return
    const w = useApp.getState().workspaces.find((x) => x.id === workspaceId)
    const sp = useApp.getState().spaces.find((x) => x.id === w?.spaceId)
    if ((w?.agentMode ?? sp?.agentMode ?? 'chat') !== 'cli') return
    const first = prompt?.trim() || undefined
    const shell = spawnShell(workspaceId, null, 'Claude Code', 'claude-code', {
      chatMode: true,
      starter: async (cols, rows) => {
        const st = await api.invoke('cli:start', workspaceId, { prompt: first, cols, rows })
        if (first) onPromptConsumed?.()
        if (!st.terminalId) throw new Error('The CLI did not start.')
        return st.terminalId
      }
    })
    shells.delete(shell.id)
    shell.id = key
    shells.set(key, shell)
    notify()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, workspaceId, key, gen])
  const shell = shells.get(key)
  const [finding, setFinding] = useState(false)
  const restart = (): void => {
    closeShell(key)
    void api.invoke('cli:stop', workspaceId).finally(() => setGen((g) => g + 1))
  }
  if (!ws) return <div />
  if (!ready) return <div className="p-4 text-[12px] text-muted">The CLI opens once the workspace is ready.</div>
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-[12px]">
        <span className="font-medium">Claude Code CLI</span>
        <span className="text-muted">{ws.sessionId ? `session ${ws.sessionId.slice(0, 8)}, shared with the chat` : 'new session'}</span>
        {shell?.exited && <span className="text-warn">exited</span>}
        <span className="ml-auto flex items-center gap-1">
          <CaffeineButton compact />
          <Button size="sm" variant="ghost" onClick={() => setFinding((f) => !f)} title="Find in output (⌘F)">
            <Search size={13} />
          </Button>
          {shell?.exited && (
            <Button size="sm" onClick={restart}>
              Start again
            </Button>
          )}
          <Button size="sm" onClick={onBackToChat} title="Continue this conversation in the chat; the CLI closes">
            Back to chat
          </Button>
        </span>
      </div>
      {finding && shell && <FindBar shell={shell} onClose={() => setFinding(false)} />}
      <div className="relative min-h-0 flex-1 bg-[#0b0d11]">{shell && <Mount shell={shell} visible onFind={() => setFinding(true)} />}</div>
    </div>
  )
}

/** Drops the CLI-mode shell of a workspace (the pty is stopped by cli:stop). */
export function closeCliView(workspaceId: string): void {
  closeShell(`cli:${workspaceId}`)
}
