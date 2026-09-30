import React, { useState } from 'react'
import { Check, RotateCcw, Undo2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useBuilder, type ChangeCard as Card } from '@/stores/builder'
import { friendlyError } from '@/lib/errors'
import { Button, Dialog } from '../ui'

/**
 * A change Maestro made, in the conversation (docs/design/README.md §7, "A change": sentence plus before/after,
 * Undo). Before and after are pictures of the preview around the turn; they only appear when the preview was open.
 * "Undo this change" reverts the turn's saves; "Keep" just folds the actions away.
 */
export function ChangeCard({ card }: { card: Card }): React.JSX.Element {
  const busy = useChat((s) => s.chats[card.workspaceId]?.busy ?? false)
  const setCard = useBuilder((s) => s.setCard)
  const notify = useApp((s) => s.notify)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(false)
  const pictures = Boolean(card.before && card.after)
  const undo = async (): Promise<void> => {
    setError(null)
    setCard(card.workspaceId, card.id, { state: 'undoing' })
    try {
      await api.invoke('builder:undoChange', card.workspaceId, card.checkpoints)
      setCard(card.workspaceId, card.id, { state: 'undone' })
      useBuilder.setState((s) => ({ undoneSince: { ...s.undoneSince, [card.workspaceId]: true } }))
      void api.invoke('browser:tabAction', card.workspaceId, 'reload').catch(() => undefined)
      notify({ id: `undo:${card.id}`, kind: 'success', text: 'Undone. The preview is back to how it was before this change.' })
    } catch (err) {
      setCard(card.workspaceId, card.id, { state: 'open' })
      // The undo service's own refusals are written for the person already; friendlyError shows them as they are.
      setError(friendlyError(err, 'The change could not be undone. Ask Maestro to undo it instead.'))
    }
  }
  const askMaestro = (): void => {
    setError(null)
    void useChat.getState().send(card.workspaceId, 'Please undo your last change and put things back the way they were.')
  }
  const undone = card.state === 'undone'

  return (
    <section aria-label="What changed" className="rounded-xl border border-border bg-panel p-3.5 text-[15px]">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-muted">
        {undone ? <RotateCcw size={13} aria-hidden /> : <Check size={13} className="text-ok" aria-hidden />}
        {undone ? 'This change was undone' : `Changed ${card.apps.join(' and ')}`}
      </div>
      {pictures && (
        <button type="button" className={`mb-3 grid w-full grid-cols-2 gap-2 rounded-lg text-left ${undone ? 'opacity-60' : ''}`} onClick={() => setZoom(true)} aria-label="See the before and after pictures larger">
          <Shot label="Before" src={card.before!} />
          <Shot label="After" src={card.after!} />
        </button>
      )}
      <ul className="mb-3 flex flex-col gap-1 text-muted">
        {card.steps.map((s) => (
          <li key={s} className="flex items-start gap-2">
            <span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-muted" />
            <span>{s}</span>
          </li>
        ))}
      </ul>
      {error && (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[13px]">
          <span className="min-w-0 flex-1">{error}</span>
          <Button size="sm" onClick={askMaestro} disabled={busy}>
            Ask Maestro to undo it
          </Button>
        </div>
      )}
      {card.state === 'open' || card.state === 'undoing' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setCard(card.workspaceId, card.id, { state: 'kept' })} disabled={card.state === 'undoing'}>
            <Check size={13} aria-hidden /> Keep
          </Button>
          {card.checkpoints.length > 0 && (
            <Button variant="ghost" onClick={() => void undo()} disabled={busy || card.state === 'undoing'} title={busy ? 'Wait until Maestro has finished, then undo.' : 'Put the app back to how it was before this change.'}>
              <Undo2 size={13} aria-hidden /> {card.state === 'undoing' ? 'Undoing…' : 'Undo this change'}
            </Button>
          )}
        </div>
      ) : card.state === 'kept' ? (
        <div className="text-[13px] text-muted">Kept.</div>
      ) : null}
      {zoom && pictures && (
        <Dialog title="Before and after" onClose={() => setZoom(false)} width={1080}>
          <div className="grid grid-cols-2 gap-3">
            <Shot label="Before" src={card.before!} large />
            <Shot label="After" src={card.after!} large />
          </div>
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={() => setZoom(false)}>
              Close
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  )
}

function Shot({ label, src, large }: { label: string; src: string; large?: boolean }): React.JSX.Element {
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1">
      <figcaption className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</figcaption>
      <img src={src} alt={`The preview ${label.toLowerCase()} the change`} className={`w-full rounded-md border border-border bg-panel-2 object-cover object-top ${large ? 'max-h-[70vh] object-contain' : 'h-28'}`} />
    </figure>
  )
}
