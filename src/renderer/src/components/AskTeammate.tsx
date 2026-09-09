import React, { useState } from 'react'
import { LifeBuoy, CheckCircle2, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Button, Dialog, inputCls } from './ui'

/**
 * Guided mode: when the person is stuck (or the assistant hit something it may not do), send a short note to
 * the team's Slack channel. The channel is set by the tech lead on the space; without it, this explains that.
 */
export function AskTeammate({ workspaceId, prefill, trigger }: { workspaceId: string; prefill?: string; trigger: (open: () => void) => React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      {trigger(() => setOpen(true))}
      {open && <AskDialog workspaceId={workspaceId} prefill={prefill} onClose={() => setOpen(false)} />}
    </>
  )
}

function AskDialog({ workspaceId, prefill, onClose }: { workspaceId: string; prefill?: string; onClose: () => void }): React.JSX.Element {
  const [text, setText] = useState(prefill ?? '')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<{ url?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const send = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.invoke('guided:askTeammate', workspaceId, text)
      setSent({ url: r.url })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title="Ask a teammate" onClose={onClose} width={440}>
      {sent ? (
        <div>
          <div className="mb-3 flex items-center gap-2 text-[13px]">
            <CheckCircle2 size={16} className="text-ok" /> Sent to your team.
          </div>
          {sent.url && (
            <button className="mb-3 inline-flex items-center gap-1 text-[12px] text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', sent.url as string)}>
              See it in Slack <ExternalLink size={10} />
            </button>
          )}
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <p className="mb-2 text-[12px] text-muted">This goes to your team's Slack channel, with the task name. Say what you are trying to do and where you are stuck.</p>
          <textarea autoFocus className={`${inputCls} mb-3 min-h-[100px]`} placeholder="e.g. I asked for a bigger checkout button but it looks the same. Can someone take a look?" value={text} onChange={(e) => setText(e.target.value)} />
          {error && <div className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || !text.trim()} onClick={() => void send()}>
              {busy ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

/** The ghost button used in the guided chat composer. */
export function AskTeammateButton({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const guided = useApp((s) => s.settings.mode === 'guided')
  if (!guided) return null
  return (
    <AskTeammate
      workspaceId={workspaceId}
      trigger={(open) => (
        <Button size="sm" variant="ghost" title="Send a question to your team" onClick={open}>
          <LifeBuoy size={13} />
        </Button>
      )}
    />
  )
}
