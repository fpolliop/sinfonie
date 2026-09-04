import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Loader2, XCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { Button, Dialog } from './ui'
import type { LoginProgress } from '@shared/types'

/**
 * Guided sign-in for one account. The vendor's CLI runs in the background and opens the browser;
 * the dialog shows where the flow is and finishes with "Signed in". The raw terminal stays under
 * Details in case the CLI asks a question.
 */
export function LoginDialog({ accountId, vendorLabel, accountName, onClose }: { accountId: string; vendorLabel: string; accountName: string; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [progress, setProgress] = useState<LoginProgress | null>(null)
  const [details, setDetails] = useState(false)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const term = new Terminal({ fontFamily: 'ui-monospace, SF Mono, Menlo, monospace', fontSize: 12, theme: { background: '#0b0d11', foreground: '#e6e8ec', cursor: '#7c9cff' }, cursorBlink: true })
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.open(el)
    let tid: string | null = null
    let cancelled = false
    const offs: Array<() => void> = []
    offs.push(api.on('accounts:loginProgress', (p) => p.accountId === accountId && (tid === null || p.terminalId === tid) && setProgress(p)))
    // StrictMode mounts twice in dev: make sure a run started before the first cleanup is torn down, or the browser opens twice.
    void api.invoke('accounts:login', accountId).then((id) => {
      if (cancelled) {
        void api.invoke('terminal:dispose', id)
        return
      }
      tid = id
      offs.push(api.on('terminal:data', (e) => e.terminalId === id && term.write(e.data)))
      term.onData((d) => void api.invoke('terminal:write', id, d))
      term.onResize(({ cols, rows }) => void api.invoke('terminal:resize', id, cols, rows))
    })
    return () => {
      cancelled = true
      offs.forEach((f) => f())
      if (tid) void api.invoke('terminal:dispose', tid)
      term.dispose()
    }
  }, [accountId])

  useEffect(() => {
    if (details) requestAnimationFrame(() => fitRef.current?.fit())
  }, [details])

  const phase = progress?.phase ?? 'starting'
  const title = `Sign in to ${vendorLabel}`
  return (
    <Dialog title={title} onClose={onClose} width={560}>
      <div className="flex items-start gap-3 rounded-lg border border-border bg-bg px-4 py-3">
        {phase === 'success' ? <CheckCircle2 size={22} className="mt-0.5 shrink-0 text-ok" /> : phase === 'failed' ? <XCircle size={22} className="mt-0.5 shrink-0 text-danger" /> : <Loader2 size={22} className="mt-0.5 shrink-0 animate-spin text-accent" />}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">
            {phase === 'starting' && 'Starting the sign-in…'}
            {phase === 'browser' && 'Finish signing in in your browser'}
            {phase === 'success' && 'Signed in'}
            {phase === 'failed' && 'Sign-in did not complete'}
          </div>
          <div className="mt-0.5 text-[12px] text-muted">
            {phase === 'starting' && `Your browser will open with the ${vendorLabel} sign-in page.`}
            {phase === 'browser' && `Come back here when the browser says you are done. The account “${accountName}” will be updated automatically.`}
            {phase === 'success' && `“${accountName}” is ready to use.`}
            {phase === 'failed' && (progress?.message ?? 'See Details for what the tool reported.')}
          </div>
          {phase === 'browser' && progress?.url && (
            <button className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', progress.url!)}>
              <ExternalLink size={12} /> Browser did not open? Open the sign-in page
            </button>
          )}
        </div>
      </div>
      <button className="mt-3 inline-flex items-center gap-1 text-[12px] text-muted hover:text-text" onClick={() => setDetails((d) => !d)}>
        {details ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Details {phase !== 'success' && phase !== 'failed' && <span className="text-muted/70">· if the tool asks a question, answer it here</span>}
      </button>
      <div ref={ref} className="mt-2 w-full rounded-md bg-[#0b0d11] p-1" style={{ height: details ? 300 : 0, overflow: 'hidden', opacity: details ? 1 : 0 }} />
      <div className="mt-4 flex justify-end">
        <Button variant={phase === 'success' ? 'primary' : 'ghost'} onClick={onClose}>
          {phase === 'success' ? 'Done' : 'Cancel'}
        </Button>
      </div>
    </Dialog>
  )
}
