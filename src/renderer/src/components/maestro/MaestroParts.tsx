/**
 * Small Maestro pieces shared by the dock and full screen: a failed turn with the ways forward, the empty pane when no
 * conversation is open, and the conversation list's load failure.
 */
import React, { useState } from 'react'
import { Plus, RotateCw, Wand2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useMaestro } from '@/stores/maestro'
import { useGuided } from '@/lib/guided'
import { friendlyError } from '@/lib/errors'
import { LoginDialog } from '../LoginDialog'
import { Button } from '../ui'
import type { AssistantItem, MaestroTurnError } from '@shared/types'

/** What a failed turn says, per cause, in the guided lens. The expert lens shows main's sentence. */
const GUIDED_SAY: Record<MaestroTurnError['code'], string> = {
  auth: 'Maestro needs you to sign in with Claude before it can answer.',
  limit: 'Maestro has hit its usage limit for now.',
  billing: 'The Claude account Maestro uses has a billing problem.',
  busy: 'Claude is busy right now, so Maestro could not answer.',
  other: 'Maestro could not answer that.'
}

/**
 * A system item from a failed (or at-risk) turn: a plain sentence, the raw error behind "Show details", and the
 * actions that get the person moving again. Actions only show on the latest one; older failures are history.
 */
export function TurnError({ conversationId, item, latest }: { conversationId: string; item: AssistantItem & { error: MaestroTurnError }; latest: boolean }): React.JSX.Element {
  const guided = useGuided()
  const openSettings = useApp((s) => s.openSettings)
  const setError = useApp((s) => s.setError)
  const accounts = useApp((s) => s.settings.claudeAccounts)
  const retry = useMaestro((s) => s.retry)
  const busy = useMaestro((s) => s.byId[conversationId]?.busy ?? false)
  const [login, setLogin] = useState(false)
  const e = item.error
  const account = accounts.find((a) => a.id === e.accountId) ?? accounts.find((a) => (a.vendor ?? 'anthropic') === 'anthropic')
  const run = (fn: () => Promise<void>): void => void fn().catch((err) => setError(err))
  const text = e.preflight ? item.text : guided ? GUIDED_SAY[e.code] : item.text
  return (
    <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px]" role="status">
      <div>{text}</div>
      {e.detail && e.code !== 'other' && (
        <details className="mt-1" data-expert-ok="">
          <summary className="w-fit cursor-pointer select-none text-[11px] text-muted hover:text-text">Show details</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted">{e.detail}</pre>
        </details>
      )}
      {latest && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {e.code === 'auth' && account && (
            <Button size="sm" variant="primary" onClick={() => setLogin(true)}>
              Sign in with Claude
            </Button>
          )}
          {e.other && (
            <Button size="sm" variant={e.code === 'auth' ? 'subtle' : 'primary'} onClick={() => run(() => retry(conversationId, e.retryText ?? lastUserText(conversationId), e.other!.id))} disabled={busy || (!e.retryText && !lastUserText(conversationId))}>
              Continue on {e.other.name}
            </Button>
          )}
          {!e.preflight && e.retryText && (
            <Button size="sm" disabled={busy} onClick={() => run(() => retry(conversationId, e.retryText!))}>
              <RotateCw size={12} /> Try again
            </Button>
          )}
          {(e.code === 'auth' || e.code === 'billing') && (
            <Button size="sm" variant="ghost" onClick={() => openSettings({ scope: 'app', page: 'accounts' })}>
              {guided ? 'Open Sign-in settings' : 'Open Settings → Accounts'}
            </Button>
          )}
          {e.code === 'limit' && !guided && (
            <Button size="sm" variant="ghost" onClick={() => openSettings({ scope: 'app', page: 'usage' })}>
              See usage
            </Button>
          )}
        </div>
      )}
      {login && account && <LoginDialog accountId={account.id} vendorLabel="Claude" accountName={account.name} onClose={() => {
            setLogin(false)
            // Re-read the sign-in so the accounts (and this card's actions) reflect it at once.
            void api.invoke('accounts:check', account.id).catch(() => undefined)
          }} />}
    </div>
  )
}

function lastUserText(conversationId: string): string {
  const items = useMaestro.getState().byId[conversationId]?.items ?? []
  return [...items].reverse().find((i) => i.role === 'user')?.text ?? ''
}

/** No conversation is open (the open one was deleted, or none exist yet): start one. */
export function NoConversation(): React.JSX.Element {
  const newConversation = useMaestro((s) => s.newConversation)
  const setError = useApp((s) => s.setError)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-muted">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-maestro/15 text-maestro">
        <Wand2 size={16} />
      </span>
      <span>No conversation is open.</span>
      <Button size="sm" variant="primary" onClick={() => void newConversation().catch((err) => setError(err))}>
        <Plus size={12} /> New conversation
      </Button>
    </div>
  )
}

/** The conversation list could not be read. */
export function ListError(): React.JSX.Element | null {
  const listError = useMaestro((s) => s.listError)
  const loadList = useMaestro((s) => s.loadList)
  const [trying, setTrying] = useState(false)
  if (!listError) return null
  return (
    <div className="m-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px]" role="status">
      <div>{friendlyError(listError, 'Maestro’s conversations could not be loaded.')}</div>
      <Button
        size="sm"
        className="mt-1.5"
        disabled={trying}
        onClick={() => {
          setTrying(true)
          void loadList()
            .catch(() => undefined)
            .finally(() => setTrying(false))
        }}
      >
        <RotateCw size={12} /> Try again
      </Button>
    </div>
  )
}
