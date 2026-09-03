import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { api } from '@/lib/api'
import { Dialog } from './ui'

/** A modal shell already running `claude auth login` for one account. */
export function LoginTerminal({ accountId, accountName, onClose }: { accountId: string; accountName: string; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const term = new Terminal({ fontFamily: 'ui-monospace, SF Mono, Menlo, monospace', fontSize: 12, theme: { background: '#0b0d11', foreground: '#e6e8ec', cursor: '#7c9cff' }, cursorBlink: true })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    let tid: string | null = null
    let offData = (): void => undefined
    let offExit = (): void => undefined
    void api.invoke('accounts:loginTerminal', accountId).then((id) => {
      tid = id
      offData = api.on('terminal:data', (e) => e.terminalId === id && term.write(e.data))
      offExit = api.on('terminal:exit', (e) => e.terminalId === id && term.write('\r\n[shell exited]\r\n'))
      term.onData((d) => void api.invoke('terminal:write', id, d))
      term.onResize(({ cols, rows }) => void api.invoke('terminal:resize', id, cols, rows))
      requestAnimationFrame(() => {
        fit.fit()
        term.focus()
      })
    })
    const onResize = (): void => fit.fit()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      offData()
      offExit()
      if (tid) void api.invoke('terminal:dispose', tid)
      term.dispose()
    }
  }, [accountId])
  return (
    <Dialog title={`Log in: ${accountName}`} onClose={onClose} width={760}>
      <p className="mb-2 text-[12px] text-muted">This shell uses the account's own config directory. Follow the login prompts; the browser will open. Close this window when it says you are logged in, then click Check.</p>
      <div ref={ref} className="h-[380px] w-full rounded-md bg-[#0b0d11] p-1" />
    </Dialog>
  )
}
