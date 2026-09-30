import React, { useState } from 'react'
import { LogIn } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { friendlyError } from '@/lib/errors'
import { Button } from '../ui'
import { LoginDialog } from '../LoginDialog'

/** Maestro answers through a Claude account. True when one is known to be signed in; null while unchecked. */
export function useClaudeSignedIn(): boolean | null {
  return useApp((s) => {
    const claude = s.settings.claudeAccounts.filter((a) => (a.vendor ?? 'anthropic') === 'anthropic')
    if (claude.some((a) => a.loggedIn)) return true
    if (claude.length && claude.every((a) => a.loggedIn === undefined)) return null
    return false
  })
}

/** An error from Maestro that means "the Claude account is not signed in" (expired, logged out, never set up). */
export const CLAUDE_SIGNED_OUT_RE = /not logged in|please run \/login|\/login|invalid api key|OAuth token (has )?expired|authentication_error|credit balance is too low|no (claude )?account|log ?in to claude/i

/**
 * "Sign in with Claude": Maestro needs a Claude account. Opens the same browser sign-in as Settings → Accounts
 * (LoginDialog) on the default Claude account, creating it first when there is none.
 */
export function ClaudeSignInCard({ reason, compact }: { reason?: string; compact?: boolean }): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const [login, setLogin] = useState<{ id: string; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const start = async (): Promise<void> => {
    setError(null)
    try {
      let acc = settings.claudeAccounts.find((a) => a.id === settings.defaultClaudeAccountId && (a.vendor ?? 'anthropic') === 'anthropic') ?? settings.claudeAccounts.find((a) => (a.vendor ?? 'anthropic') === 'anthropic')
      if (!acc) {
        const next = await api.invoke('accounts:add', 'Claude', 'anthropic')
        acc = next.claudeAccounts.filter((a) => (a.vendor ?? 'anthropic') === 'anthropic').at(-1)
      }
      if (acc) setLogin({ id: acc.id, name: acc.name })
    } catch (err) {
      setError(friendlyError(err, 'The Claude sign-in could not start. Try again in a moment.'))
    }
  }
  return (
    <div className={compact ? 'rounded-lg border border-maestro/30 bg-maestro/5 px-3 py-2.5' : 'rounded-xl border border-maestro/30 bg-maestro/5 px-4 py-3'}>
      <div className="text-[13px] font-semibold">Sign in with Claude</div>
      <p className="mt-0.5 text-[12px] text-muted">{reason ?? 'Maestro works through your Claude account (Pro or Max). Sign in once and it can answer here.'}</p>
      {error && (
        <p role="alert" className="mt-1 text-[12px] text-danger">
          {error}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => void start()}>
          <LogIn size={12} /> Sign in with Claude
        </Button>
        <button type="button" className="text-[12px] text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', 'https://claude.com/pricing')}>
          Don’t have a Claude plan? See plans
        </button>
      </div>
      {login && (
        <LoginDialog
          accountId={login.id}
          vendorLabel="Claude"
          accountName={login.name}
          onClose={() => {
            setLogin(null)
            void api.invoke('accounts:check', login.id).catch(() => undefined)
          }}
        />
      )}
    </div>
  )
}
