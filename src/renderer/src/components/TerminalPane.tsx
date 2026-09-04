import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'

interface Live {
  term: Terminal
  fit: FitAddon
  terminalId: string
  unsub: () => void
}

/** Terminals survive tab switches: instances live here, keyed by workspace + repo. */
const live = new Map<string, Live>()

export function TerminalPane({ workspaceId, visible }: { workspaceId: string; visible: boolean }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const [repoId, setRepoId] = useState(ws?.primaryRepoId ?? '')
  if (!ws) return <div />
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        {ws.repos.map((r) => (
          <button key={r.repoId} onClick={() => setRepoId(r.repoId)} className={clsx('rounded-md px-2.5 py-1 text-[12px]', r.repoId === repoId ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
            {r.repoName}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-muted">$SINFONIE_PORT is set</span>
      </div>
      <div className="min-h-0 flex-1 bg-[#0b0d11]">
        {ws.repos.map((r) => (
          <div key={r.repoId} className={clsx('h-full', r.repoId !== repoId && 'hidden')}>
            <Xterm workspaceId={workspaceId} repoId={r.repoId} active={visible && r.repoId === repoId} disabled={ws.status !== 'ready'} />
          </div>
        ))}
      </div>
    </div>
  )
}

function Xterm({ workspaceId, repoId, active, disabled }: { workspaceId: string; repoId: string; active: boolean; disabled: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const key = `${workspaceId}:${repoId}`

  useEffect(() => {
    const el = ref.current
    if (!el || disabled) return
    let entry = live.get(key)
    let cancelled = false
    const attach = async (): Promise<void> => {
      if (!entry) {
        const term = new Terminal({
          fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
          fontSize: 12,
          theme: { background: '#0b0d11', foreground: '#e6e8ec', cursor: '#7c9cff' },
          cursorBlink: true,
          scrollback: 5000,
          allowProposedApi: true
        })
        const fit = new FitAddon()
        term.loadAddon(fit)
        const terminalId = await api.invoke('terminal:create', workspaceId, repoId)
        if (cancelled) {
          void api.invoke('terminal:dispose', terminalId)
          term.dispose()
          return
        }
        const offData = api.on('terminal:data', (e) => e.terminalId === terminalId && term.write(e.data))
        const offExit = api.on('terminal:exit', (e) => {
          if (e.terminalId === terminalId) {
            term.write('\r\n[shell exited]\r\n')
            live.delete(key)
          }
        })
        term.onData((d) => void api.invoke('terminal:write', terminalId, d))
        term.onResize(({ cols, rows }) => void api.invoke('terminal:resize', terminalId, cols, rows))
        entry = { term, fit, terminalId, unsub: () => (offData(), offExit()) }
        live.set(key, entry)
      }
      entry.term.open(el)
      requestAnimationFrame(() => entry?.fit.fit())
    }
    void attach()
    return () => {
      cancelled = true
    }
  }, [key, workspaceId, repoId, disabled])

  useEffect(() => {
    if (!active) return
    const entry = live.get(key)
    const onResize = (): void => entry?.fit.fit()
    requestAnimationFrame(onResize)
    window.addEventListener('resize', onResize)
    entry?.term.focus()
    return () => window.removeEventListener('resize', onResize)
  }, [active, key])

  if (disabled) return <div className="p-4 text-muted">Terminal opens once the workspace is ready.</div>
  return <div ref={ref} className="h-full w-full p-1" />
}
