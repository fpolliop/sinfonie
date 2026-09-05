import React, { useState } from 'react'
import { ExternalLink, Copy, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { Button, Dialog } from './ui'
import type { AuthLink } from '@shared/types'

const NAMES: Record<AuthLink['provider'], string> = { jira: 'Jira', linear: 'Linear', slack: 'Slack' }

/** A sign-in link: open it in the default browser, or copy it to paste into the browser that is logged in. */
export function AuthLinkDialog({ link, onClose }: { link: AuthLink; onClose: () => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const name = NAMES[link.provider]
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(link.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Dialog title={`Sign in to ${name}`} onClose={onClose} width={480}>
      <p className="mb-3 text-[13px] text-muted">Approve access on {name}'s site, then come back here. If your default browser is not the one signed in to {name}, copy the link and open it where you are.</p>
      <div className="mb-4 max-h-[72px] overflow-auto rounded-md border border-border bg-bg px-2.5 py-2 font-mono text-[11px] text-muted break-all select-all">{link.url}</div>
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => void api.invoke('shell:openExternal', link.url)}>
          <ExternalLink size={13} /> Open in browser
        </Button>
        <Button onClick={() => void copy()}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy link'}
        </Button>
        <span className="ml-auto text-[11px] text-muted">Waiting for approval…</span>
      </div>
    </Dialog>
  )
}
