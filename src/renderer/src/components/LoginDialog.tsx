import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CheckCircle2, ChevronDown, ChevronRight, Download, ExternalLink, Loader2, PackageOpen, XCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { Button, Dialog } from './ui'
import type { AgentPrereq, LoginProgress } from '@shared/types'
import { useGuided } from '@/lib/guided'
import { friendlyError } from '@/lib/errors'
import { onThemeChange, terminalTheme } from '@/lib/theme'

/** Where to get each tool a vendor sign-in needs, and how to name it in each lens. */
export const PREREQS: Record<AgentPrereq, { url: string; expert: string; guided: string }> = {
  node: { url: 'https://nodejs.org/en/download', expert: 'Node.js (it provides npx, which runs the Codex sign-in)', guided: 'a free helper program from nodejs.org' },
  grok: { url: 'https://x.ai/build', expert: 'the Grok CLI (xAI’s Grok Build)', guided: 'xAI’s free Grok program' }
}

/** After this long still "starting", the tool is most likely asking a question in the terminal. */
const ASKING_AFTER_MS = 20_000

/**
 * Guided sign-in for one account. The vendor's CLI runs in the background and opens the browser;
 * the dialog shows where the flow is and finishes with "Signed in". The raw terminal stays under
 * Details in case the CLI asks a question (collapsed as "Show details" in guided mode). A failed run offers
 * Try again, which starts a fresh sign-in in the same dialog. When the tool the sign-in needs is not installed,
 * the dialog says so and offers to install it (or links to the download) and to check again.
 */
export function LoginDialog({ accountId, vendorLabel, accountName, onClose }: { accountId: string; vendorLabel: string; accountName: string; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [progress, setProgress] = useState<LoginProgress | null>(null)
  const [details, setDetails] = useState(false)
  const [asking, setAsking] = useState(false)
  const fitRef = useRef<FitAddon | null>(null)
  /** Bumped by Try again: tears the previous run down and starts a new one. */
  const [attempt, setAttempt] = useState(0)
  /** A one-step install of the missing tool: running, finished (then the sign-in starts again) or failed. */
  const [install, setInstall] = useState<{ tid: string | null; state: 'running' | 'failed' | 'none' } | null>(null)
  const guided = useGuided()

  // One terminal for the dialog's lifetime: sign-in runs and installs write into it.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const term = new Terminal({ fontFamily: 'ui-monospace, SF Mono, Menlo, monospace', fontSize: 12, theme: terminalTheme(), cursorBlink: true })
    const fit = new FitAddon()
    fitRef.current = fit
    termRef.current = term
    term.loadAddon(fit)
    term.open(el)
    const off = onThemeChange(() => (term.options.theme = terminalTheme()))
    return () => {
      off()
      termRef.current = null
      term.dispose()
    }
  }, [])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    let tid: string | null = null
    let cancelled = false
    const offs: Array<() => void> = []
    setAsking(false)
    offs.push(api.on('accounts:loginProgress', (p) => p.accountId === accountId && (tid === null || p.terminalId === tid) && setProgress(p)))
    // StrictMode mounts twice in dev: make sure a run started before the first cleanup is torn down, or the browser opens twice.
    api
      .invoke('accounts:login', accountId)
      .then((id) => {
        if (!id) return // Could not start (a tool is missing): the progress event already said why.
        if (cancelled) {
          void api.invoke('terminal:dispose', id)
          return
        }
        tid = id
        offs.push(api.on('terminal:data', (e) => e.terminalId === id && term.write(e.data)))
        const d1 = term.onData((d) => void api.invoke('terminal:write', id, d))
        const d2 = term.onResize(({ cols, rows }) => void api.invoke('terminal:resize', id, cols, rows))
        offs.push(() => (d1.dispose(), d2.dispose()))
      })
      .catch((err) => {
        if (!cancelled) setProgress({ accountId, terminalId: '', phase: 'failed', message: friendlyError(err, `The ${vendorLabel} sign-in could not start. Try again, or ask a teammate.`) })
      })
    return () => {
      cancelled = true
      offs.forEach((f) => f())
      if (tid) void api.invoke('terminal:dispose', tid)
    }
  }, [accountId, attempt, vendorLabel])

  const phase = progress?.phase ?? 'starting'

  // Still starting after a while: the tool is probably asking something (a terms prompt, a choice), so show it.
  useEffect(() => {
    if (phase !== 'starting') return
    const t = setTimeout(() => {
      setAsking(true)
      setDetails(true)
    }, ASKING_AFTER_MS)
    return () => clearTimeout(t)
  }, [phase, attempt])

  useEffect(() => {
    if (details) requestAnimationFrame(() => fitRef.current?.fit())
  }, [details])

  // The install's output streams into the same terminal; a clean exit starts the sign-in again by itself.
  useEffect(() => {
    const tid = install?.tid
    const term = termRef.current
    if (!tid || !term || install?.state !== 'running') return
    const offs = [
      api.on('terminal:data', (e) => e.terminalId === tid && term.write(e.data)),
      api.on('terminal:exit', (e) => {
        if (e.terminalId !== tid) return
        if (e.exitCode === 0) {
          setInstall(null)
          retry()
        } else setInstall({ tid: null, state: 'failed' })
      })
    ]
    const d = term.onData((data) => void api.invoke('terminal:write', tid, data))
    return () => {
      offs.forEach((f) => f())
      d.dispose()
    }
  }, [install])

  const retry = (): void => {
    setProgress(null)
    setAttempt((n) => n + 1)
  }
  const missing = phase === 'failed' ? progress?.missing : undefined
  const prereq = missing ? PREREQS[missing] : null
  const startInstall = async (): Promise<void> => {
    if (!missing) return
    try {
      const tid = await api.invoke('accounts:install', missing)
      if (!tid) return setInstall({ tid: null, state: 'none' })
      termRef.current?.clear()
      setDetails(true)
      setInstall({ tid, state: 'running' })
    } catch {
      setInstall({ tid: null, state: 'failed' })
    }
  }

  const title = `Sign in to ${vendorLabel}`
  return (
    <Dialog title={title} onClose={onClose} width={560}>
      {prereq ? (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-bg px-4 py-3" role="status">
          {install?.state === 'running' ? <Loader2 size={22} className="mt-0.5 shrink-0 animate-spin text-accent" /> : <PackageOpen size={22} className="mt-0.5 shrink-0 text-warn" />}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">{install?.state === 'running' ? 'Installing…' : `One more thing to install first`}</div>
            <div className="mt-0.5 text-[12px] text-muted">
              {install?.state === 'running'
                ? 'This takes a minute or two. The sign-in starts again by itself when it is done.'
                : `Signing in to ${vendorLabel} needs ${guided ? prereq.guided : prereq.expert}, and it is not on this Mac yet.`}
            </div>
            {install?.state === 'failed' && <div className="mt-1 text-[12px] text-danger">The install did not finish. Download it from the website instead, then check again.</div>}
            {install?.state === 'none' && <div className="mt-1 text-[12px] text-muted">Sinfonie cannot install it for you on this Mac. Download it from the website, install it, then check again.</div>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {/* Only Node.js has a one-step install (Homebrew); the Grok CLI is downloaded from xAI's page. */}
              {missing !== 'grok' && install?.state !== 'running' && install?.state !== 'none' && install?.state !== 'failed' && (
                <Button size="sm" variant="primary" onClick={() => void startInstall()}>
                  <Download size={12} /> Install it for me
                </Button>
              )}
              <Button size="sm" onClick={() => void api.invoke('shell:openExternal', prereq.url)}>
                <ExternalLink size={12} /> Open the download page
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-bg px-4 py-3">
          {phase === 'success' ? <CheckCircle2 size={22} className="mt-0.5 shrink-0 text-ok" /> : phase === 'failed' ? <XCircle size={22} className="mt-0.5 shrink-0 text-danger" /> : <Loader2 size={22} className="mt-0.5 shrink-0 animate-spin text-accent" />}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">
              {phase === 'starting' && (asking ? 'The sign-in is asking something' : 'Starting the sign-in…')}
              {phase === 'browser' && 'Finish signing in in your browser'}
              {phase === 'success' && 'Signed in'}
              {phase === 'failed' && 'Sign-in did not complete'}
            </div>
            <div className="mt-0.5 text-[12px] text-muted">
              {phase === 'starting' && (asking ? 'Answer below. Use the arrow keys and Return to choose, the same as in a terminal.' : `Your browser will open with the ${vendorLabel} sign-in page.`)}
              {phase === 'browser' && (guided ? 'Come back here when the browser says you are done. This window updates by itself.' : `Come back here when the browser says you are done. The account “${accountName}” will be updated automatically.`)}
              {phase === 'success' && (guided ? `Your ${vendorLabel} account is ready to use.` : `“${accountName}” is ready to use.`)}
              {phase === 'failed' && (guided ? 'The sign-in was not finished. Try again; if it keeps failing, ask a teammate.' : (progress?.message ?? 'See Details for what the tool reported.'))}
            </div>
            {phase === 'browser' && progress?.url && (
              <button className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', progress.url!)}>
                <ExternalLink size={12} /> Browser did not open? Open the sign-in page
              </button>
            )}
          </div>
        </div>
      )}
      <button type="button" aria-expanded={details} className="mt-3 inline-flex items-center gap-1 text-[12px] text-muted hover:text-text" onClick={() => setDetails((d) => !d)}>
        {details ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {guided ? (details ? 'Hide details' : 'Show details') : 'Details'}{' '}
        {!guided && phase !== 'success' && phase !== 'failed' && <span className="text-muted">· if the tool asks a question, answer it here</span>}
      </button>
      <div ref={ref} data-expert-ok className="mt-2 w-full rounded-md bg-sunken p-1" style={{ height: details ? 300 : 0, overflow: 'hidden', opacity: details ? 1 : 0 }} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant={phase === 'success' ? 'primary' : 'ghost'} onClick={onClose}>
          {phase === 'success' ? 'Done' : 'Cancel'}
        </Button>
        {phase === 'failed' && install?.state !== 'running' && (
          <Button variant="primary" onClick={() => (setInstall(null), retry())}>
            {prereq ? 'I’ve installed it, check again' : 'Try again'}
          </Button>
        )}
      </div>
    </Dialog>
  )
}
