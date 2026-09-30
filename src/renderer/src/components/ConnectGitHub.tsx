import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { CheckCircle2, Copy, ExternalLink, Loader2, RefreshCw, Wrench } from 'lucide-react'
import { api } from '@/lib/api'
import { useGitHubConnection } from '@/lib/github'
import { Button } from './ui'

/**
 * One card for everything between this Mac and GitHub, in plain words and one action at a time:
 * Apple's developer tools missing → install them; no GitHub account → create one; not connected → Connect GitHub
 * (the one-time code is shown here with Copy, and github.com opens); connected → `onConnected` runs once.
 *
 * Reuse anywhere: <ConnectGitHubCard reason="…so Sinfonie can download your app." onConnected={retry} />.
 */
export function ConnectGitHubCard({ reason, onConnected, className }: { reason?: string; onConnected?: () => void; className?: string }): React.JSX.Element | null {
  const { connection, state, loading, connect, cancel, refresh } = useGitHubConnection()
  const [signup, setSignup] = useState(false)
  const [copied, setCopied] = useState(false)
  // onConnected runs once, when a connect finished while this card was up (never just because it mounted connected,
  // so a retry that fails again cannot loop).
  const startPhase = useRef(state.phase)
  const firedRef = useRef(false)
  const connected = Boolean(connection?.signedIn && connection.git === 'ok')
  useEffect(() => {
    if (state.phase !== 'done') startPhase.current = state.phase
    else if (startPhase.current !== 'done' && connected && !firedRef.current) {
      firedRef.current = true
      onConnected?.()
    }
  }, [connected, state.phase, onConnected])

  if (!connection) {
    return (
      <Card className={className}>
        <div role="status" className="flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={13} className="animate-spin" aria-hidden /> Checking your GitHub connection…
        </div>
      </Card>
    )
  }
  if (connection.git !== 'ok' || state.missing === 'xcode') return <FixPrerequisiteCard what="xcode" className={className} onFixed={() => void connect()} />

  if (connected) {
    return (
      <Card className={clsx('border-ok/40 bg-ok/5', className)}>
        <div className="flex items-center gap-2 text-[13px]">
          <CheckCircle2 size={15} className="shrink-0 text-ok" /> GitHub is connected{connection.login ? ` as ${connection.login}` : ''}.
          {onConnected && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void connect()} title="Sign in to GitHub again, then try once more">
              Connect again
            </Button>
          )}
        </div>
      </Card>
    )
  }

  const busy = ['checking', 'installing', 'starting', 'code', 'finishing'].includes(state.phase)
  const copyAndOpen = async (): Promise<void> => {
    if (state.code) await navigator.clipboard.writeText(state.code).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
    await api.invoke('shell:openExternal', state.url ?? 'https://github.com/login/device')
  }

  return (
    <Card className={className}>
      <div className="text-[13px] font-semibold">Connect your GitHub account</div>
      <p className="mt-0.5 text-[12px] text-muted">{reason ?? 'Sinfonie uses your GitHub account to download your app and send your changes for review.'}</p>

      {state.phase === 'code' && state.code ? (
        <div className="mt-3">
          <p className="text-[12px] text-muted">On the GitHub page that opens, enter this code:</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span aria-label={`Code ${state.code.split('').join(' ')}`} className="rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-[18px] font-semibold tracking-[0.2em]">
              {state.code}
            </span>
            <Button variant="primary" onClick={() => void copyAndOpen()}>
              {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />} {copied ? 'Copied, opening GitHub…' : 'Copy code and open GitHub'}
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[12px] text-muted">
            <Loader2 size={12} className="animate-spin" aria-hidden /> Waiting for you on GitHub…
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void cancel()}>
              Cancel
            </Button>
          </div>
        </div>
      ) : busy ? (
        <div role="status" className="mt-3 flex items-center gap-2 text-[12px] text-muted">
          <Loader2 size={12} className="animate-spin" aria-hidden />
          {state.phase === 'installing' ? 'Getting GitHub ready on this Mac. This takes a moment the first time…' : state.phase === 'finishing' ? 'Finishing up…' : 'Starting…'}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void cancel()}>
            Cancel
          </Button>
        </div>
      ) : (
        <>
          {state.phase === 'failed' && state.message && (
            <p role="alert" className="mt-2 text-[12px] text-danger">
              {state.message}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={loading} onClick={() => void connect()}>
              {state.phase === 'failed' ? 'Try again' : signup ? 'I’ve created it, continue' : 'Connect GitHub'}
            </Button>
            {!signup && (
              <button
                type="button"
                className="text-[12px] text-accent hover:underline"
                onClick={() => {
                  setSignup(true)
                  void api.invoke('shell:openExternal', 'https://github.com/signup')
                }}
              >
                Don’t have a GitHub account? Create one (free)
              </button>
            )}
            <span className="ml-auto" />
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()} title="Check the connection again">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Check again
            </Button>
          </div>
        </>
      )}
    </Card>
  )
}

/**
 * A missing piece of this Mac with its one fix. Today: Apple's developer tools (which bring git). The install runs in
 * Apple's own window; "I've installed them, check again" looks again and calls `onFixed` when they are there.
 */
export function FixPrerequisiteCard({ what, onFixed, className }: { what: 'xcode'; onFixed?: () => void; className?: string }): React.JSX.Element {
  const { refresh } = useGitHubConnection()
  const [started, setStarted] = useState(false)
  const [checking, setChecking] = useState(false)
  const [stillMissing, setStillMissing] = useState(false)
  void what
  const install = async (): Promise<void> => {
    setStarted(true)
    await api.invoke('github:installXcodeTools').catch(() => undefined)
  }
  const check = async (): Promise<void> => {
    setChecking(true)
    const c = await refresh()
    setChecking(false)
    if (c?.git === 'ok') onFixed?.()
    else setStillMissing(true)
  }
  return (
    <Card className={className}>
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <Wrench size={14} className="text-accent" aria-hidden /> Install Apple’s developer tools
      </div>
      <p className="mt-0.5 text-[12px] text-muted">Sinfonie needs Apple’s free developer tools to download and save your app. A window from Apple asks to install them; it takes a few minutes.</p>
      {stillMissing && <p className="mt-2 text-[12px] text-warn">They are not installed yet. Finish the install in Apple’s window, then check again.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {started ? (
          <Button variant="primary" disabled={checking} onClick={() => void check()}>
            {checking ? <Loader2 size={13} className="animate-spin" /> : null} I’ve installed them, check again
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void install()}>
            Install Apple’s developer tools
          </Button>
        )}
        {started && (
          <Button size="sm" variant="ghost" onClick={() => void install()}>
            <ExternalLink size={12} /> Open the installer again
          </Button>
        )}
      </div>
    </Card>
  )
}

function Card({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <div className={clsx('rounded-xl border border-border bg-panel/40 px-4 py-3', className)}>{children}</div>
}
