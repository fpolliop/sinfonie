import React, { useEffect, useState } from 'react'
import { ExternalLink, Copy, Check, Loader2, RotateCcw, XCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { Button, Dialog } from './ui'
import type { AuthLink } from '@shared/types'

const NAMES: Record<AuthLink['provider'], string> = { jira: 'Jira', linear: 'Linear', slack: 'Slack', cloud: 'GitHub' }

/** Starts the same sign-in over; main then presents a fresh link, which replaces this one. */
function restart(link: AuthLink): Promise<unknown> | null {
  const provider = link.label === 'Google' ? 'google' : 'github'
  if (link.provider === 'jira') return api.invoke('jira:authenticate', link.connId)
  if (link.provider === 'linear') return api.invoke('linear:authenticate', link.connId)
  if (link.provider === 'cloud') return link.addEmail ? api.invoke('cloud:addEmail', provider) : api.invoke('cloud:signIn', provider)
  return null
}

/**
 * A screen that shows the Sinfonie sign-in inline (the setup wizard's "My team already uses Sinfonie") registers here
 * while it is mounted; App then leaves the cloud sign-in to it instead of opening this dialog over it.
 */
let inlineCloud = 0
export function useInlineCloudSignIn(): void {
  useEffect(() => {
    inlineCloud += 1
    return () => {
      inlineCloud -= 1
    }
  }, [])
}
export const isInlineCloudSignIn = (): boolean => inlineCloud > 0

/**
 * A sign-in link: open it in the default browser, or copy it to paste into the browser that is logged in. While it
 * waits it says so and Cancel stops the sign-in; when it fails it says why in plain words and offers Start again.
 */
export function AuthLinkDialog({ link, failure, onClose }: { link: AuthLink; failure?: string | null; onClose: () => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  const name = link.label ?? NAMES[link.provider]
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(link.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  const again = (): void => {
    setRestartError(null)
    const p = restart(link)
    if (!p) return onClose()
    // Failures of the new attempt arrive through ui:authDone as well; this only catches a start that never got going.
    p.catch((err) => setRestartError(friendlyError(err, `The ${name} sign-in could not start. Try again in a moment.`)))
  }
  const failed = failure ?? restartError
  return (
    <Dialog title={link.provider === 'cloud' ? `Sign in to Sinfonie with ${name}` : `Sign in to ${name}`} onClose={onClose} width={480}>
      {failed ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5" role="alert">
          <XCircle size={16} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0 text-[13px]">
            <div className="font-medium">The sign-in did not finish</div>
            <div className="mt-0.5 text-muted">{failed}</div>
          </div>
        </div>
      ) : (
        <>
          <p className="mb-3 text-[13px] text-muted">
            {link.opened
              ? `Your browser opened ${name}'s page. Approve access there, then come back here. Didn't open, or the wrong browser? Copy the link and open it where you are signed in.`
              : `Approve access on ${name}'s site, then come back here. If your default browser is not the one signed in to ${name}, copy the link and open it where you are.`}
          </p>
          <div className="mb-4 max-h-[72px] overflow-auto rounded-md border border-border bg-bg px-2.5 py-2 font-mono text-[11px] text-muted break-all select-all" data-expert-ok>
            {link.url}
          </div>
        </>
      )}
      <div className="flex items-center gap-2">
        {failed ? (
          <>
            <Button variant="primary" onClick={again}>
              <RotateCcw size={13} /> Start again
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={() => void api.invoke('shell:openExternal', link.url)}>
              <ExternalLink size={13} /> {link.opened ? 'Open again' : 'Open in browser'}
            </Button>
            <Button onClick={() => void copy()}>
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy link'}
            </Button>
            <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted">
              <Loader2 size={11} className="animate-spin" /> Waiting for approval…
            </span>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </Dialog>
  )
}
