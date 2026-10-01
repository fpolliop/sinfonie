import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Spinner, inputCls } from './ui'
import { friendlyError } from '@/lib/errors'
import type { SlackConnection } from '@shared/types'

/** The Slack sign-in card, shared by Integrations → Slack and the On call page. */
export function SlackConnectionCard({ connId = '', intro }: { connId?: string; intro?: string }): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const spaces = useApp((s) => s.spaces)
  const setError = useApp((s) => s.setError)
  const persisted = (connId ? spaces.find((x) => x.id === connId)?.slack : settings.slack) ?? { connected: false, hasClient: false, vendorClient: false }
  // vendorClient/hasClient are computed in main from the build and the secrets; the stored copy can be stale.
  const [live, setLive] = useState<SlackConnection | null>(null)
  const [mcpTest, setMcpTest] = useState<{ ok: boolean; status: number; detail: string; scopes: string[] } | null>(null)
  useEffect(() => {
    api.invoke('slack:connection', connId).then(setLive).catch(() => undefined)
  }, [connId, persisted.connected, persisted.connectedAt])
  const slack = { ...persisted, ...(live ?? {}) }
  const [clientId, setClientId] = useState(slack.clientId ?? '')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')
  useEffect(() => setClientId(slack.clientId ?? ''), [slack.clientId])
  // Sign-in waits on the browser. Main listens for 5 minutes; after that the card says so instead of waiting forever.
  const [pending, setPending] = useState<'waiting' | 'expired' | null>(null)
  // Main says in plain words when the browser round trip failed (cancelled, no code, exchange refused).
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    if (slack.connected) {
      setPending(null)
      setFailed(null)
    }
  }, [slack.connected])
  useEffect(
    () =>
      api.on('slack:authFailed', (e) => {
        if (e.connId !== undefined && e.connId !== connId) return
        setPending(null)
        setFailed(e.message)
      }),
    [connId]
  )
  useEffect(() => {
    if (pending !== 'waiting') return
    const t = setTimeout(() => setPending('expired'), 5 * 60_000)
    return () => clearTimeout(t)
  }, [pending])
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(friendlyError(err))
    }
  }
  const signIn = (): void => {
    setFailed(null)
    setPending('waiting')
    api.invoke('oncall:slackConnect', connId).catch((err) => {
      setPending(null)
      setError(friendlyError(err))
    })
  }
  return (
    <section className="mb-4 rounded-lg border border-border p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          Slack
          {slack.connected ? <Badge tone="ok">connected as {slack.userName} · {slack.teamName}</Badge> : <Badge tone="warn">not connected</Badge>}
        </div>
        {!slack.connected && (
          <>
            <p className="mb-2 text-[11px] text-muted">{intro ?? 'Sinfonie talks to Slack through Slack\u2019s own MCP server. Sign in approves access for your Slack user in the browser; there is nothing to create or install.'} Replies the agent drafts are sent as you, only after you approve them.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" disabled={!slack.vendorClient && !slack.hasClient} title={!slack.vendorClient && !slack.hasClient ? 'Sign in is not available in this copy of Sinfonie yet' : undefined} onClick={signIn}>
                {pending === 'waiting' ? 'Sign in again' : 'Sign in with Slack'}
              </Button>
              <span className="text-[11px] text-muted">
                {!slack.vendorClient && !slack.hasClient
                  ? 'Sign in with Slack is not available in this copy of Sinfonie yet. You can still connect by adding your own Slack app under Advanced below.'
                  : pending === 'waiting'
                    ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Spinner /> Waiting for you to approve in the browser. Sinfonie picks it up by itself.
                        </span>
                      )
                    : pending === 'expired'
                      ? <span className="text-warn">The sign-in did not come back. Sign in again, or paste the code the browser showed below.</span>
                      : 'Approve in the browser; Sinfonie reopens by itself.'}
              </span>
            </div>
            {failed && (
              <div className="mt-2 flex items-center gap-2 text-[12px]" role="status">
                <span className="text-warn">{failed}</span>
                <Button size="sm" onClick={signIn}>
                  Try again
                </Button>
              </div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <input className={clsx(inputCls, 'max-w-[360px]')} aria-label="Code from the browser" placeholder="If it did not come back: paste the code shown in the browser" value={code} onChange={(e) => setCode(e.target.value)} />
              <Button size="sm" disabled={!code.trim()} onClick={() => go(async () => (await api.invoke('oncall:slackFinish', code.trim(), connId), setCode('')))}>
                Finish
              </Button>
            </div>
            <details className="mt-3 text-[11px] text-muted">
              <summary className="w-fit cursor-pointer select-none hover:text-text">Advanced: use your own Slack OAuth client</summary>
              <p className="mb-2 mt-1">Slack does not allow apps to register themselves, so by default Sinfonie signs you in with its own registered client and exchanges the code on sinfonie.dev. If you would rather keep everything inside your workspace, register a client at api.slack.com/apps (from scratch, no bot), set the redirect URL <code className="rounded bg-panel-2 px-1">https://sinfonie.dev/oauth/slack/callback</code> and the user token scopes channels:history, channels:read, groups:history, groups:read, chat:write, search:read.public, users:read, then paste its client id and secret here. Tokens are then exchanged directly with Slack from this Mac.</p>
              <div className="mb-2 grid grid-cols-2 gap-2">
                <input className={inputCls} aria-label="Client ID" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
                <input className={inputCls} aria-label="Client secret" placeholder={slack.hasClient ? 'Client secret (stored)' : 'Client secret'} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={!clientId.trim() || !secret.trim()} onClick={() => go(async () => (await api.invoke('oncall:slackSetClient', connId, clientId, secret).then(setLive), setSecret('')))}>
                  Save client
                </Button>
                {slack.hasClient && (
                  <Button size="sm" variant="ghost" onClick={() => window.confirm('Use Sinfonie’s Slack client instead? Your own client id and secret are removed from this Mac.') && go(() => api.invoke('oncall:slackClearClient', connId).then(setLive))}>
                    Use Sinfonie&apos;s client instead
                  </Button>
                )}
              </div>
            </details>
          </>
        )}
        {slack.connected && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted">Replies the agent drafts are sent as you, only after you approve them.</span>
            <Button size="sm" variant="ghost" className="ml-auto" title="Ask Slack's MCP server whether this sign-in is accepted, and show its exact answer" onClick={() => go(async () => setMcpTest(await api.invoke('slack:testMcp', connId)))}>
              Test MCP
            </Button>
            <Button size="sm" variant="ghost" onClick={() => window.confirm('Disconnect Slack? On-call stops watching Slack until you reconnect.') && go(async () => {
              await api.invoke('oncall:slackDisconnect', connId)
              setLive(null)
              setMcpTest(null)
            })}>
              Disconnect
            </Button>
          </div>
        )}
        {mcpTest && (
          <div className={`mt-2 rounded-md border px-3 py-2 text-[11px] ${mcpTest.ok ? 'border-ok/40' : 'border-danger/40'}`}>
            <div className="font-medium">{mcpTest.ok ? 'Slack MCP server accepted this sign-in.' : `Slack MCP server refused this sign-in (HTTP ${mcpTest.status}).`}</div>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted">{mcpTest.detail || '(empty answer)'}</pre>
            <div className="mt-1 text-muted">Token scopes: {mcpTest.scopes.length ? mcpTest.scopes.join(', ') : '(none reported)'}</div>
          </div>
        )}
      </section>
  )
}
