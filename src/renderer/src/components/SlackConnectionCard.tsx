import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, inputCls } from './ui'
import type { SlackConnection } from '@shared/types'

/** The Slack sign-in card, shared by Integrations → Slack and the On call page. */
export function SlackConnectionCard({ connId = '', intro }: { connId?: string; intro?: string }): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const spaces = useApp((s) => s.spaces)
  const setError = useApp((s) => s.setError)
  const persisted = (connId ? spaces.find((x) => x.id === connId)?.slack : settings.slack) ?? { connected: false, hasClient: false, vendorClient: false }
  // vendorClient/hasClient are computed in main from the build and the secrets; the stored copy can be stale.
  const [live, setLive] = useState<SlackConnection | null>(null)
  useEffect(() => {
    api.invoke('slack:connection', connId).then(setLive).catch(() => undefined)
  }, [connId, persisted.connected, persisted.connectedAt])
  const slack = { ...persisted, ...(live ?? {}) }
  const [clientId, setClientId] = useState(slack.clientId ?? '')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')
  useEffect(() => setClientId(slack.clientId ?? ''), [slack.clientId])
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
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
              <Button size="sm" variant="primary" disabled={!slack.vendorClient && !slack.hasClient} onClick={() => go(() => api.invoke('oncall:slackConnect', connId))}>
                Sign in with Slack
              </Button>
              <span className="text-[11px] text-muted">{slack.vendorClient || slack.hasClient ? 'Approve in the browser; Sinfonie reopens by itself.' : 'This build has no Slack client registered yet; see Advanced.'}</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input className={clsx(inputCls, 'max-w-[360px]')} placeholder="If it did not come back: paste the code shown in the browser" value={code} onChange={(e) => setCode(e.target.value)} />
              <Button size="sm" disabled={!code.trim()} onClick={() => go(async () => (await api.invoke('oncall:slackFinish', code.trim(), connId), setCode('')))}>
                Finish
              </Button>
            </div>
            <details className="mt-3 text-[11px] text-muted">
              <summary className="cursor-pointer select-none">Advanced: use your own Slack OAuth client</summary>
              <p className="mb-2 mt-1">Slack does not allow apps to register themselves, so by default Sinfonie signs you in with its own registered client and exchanges the code on sinfonie.dev. If you would rather keep everything inside your workspace, register a client at api.slack.com/apps (from scratch, no bot), set the redirect URL <code className="rounded bg-panel-2 px-1">https://sinfonie.dev/oauth/slack/callback</code> and the user token scopes channels:history, channels:read, groups:history, groups:read, chat:write, search:read.public, users:read, then paste its client id and secret here. Tokens are then exchanged directly with Slack from this Mac.</p>
              <div className="mb-2 grid grid-cols-2 gap-2">
                <input className={inputCls} placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
                <input className={inputCls} placeholder={slack.hasClient ? 'Client secret (stored)' : 'Client secret'} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={!clientId.trim() || !secret.trim()} onClick={() => go(async () => (await api.invoke('oncall:slackSetClient', connId, clientId, secret).then(setLive), setSecret('')))}>
                  Save client
                </Button>
                {slack.hasClient && (
                  <Button size="sm" variant="ghost" onClick={() => go(() => api.invoke('oncall:slackClearClient', connId).then(setLive))}>
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
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => go(() => api.invoke('oncall:slackDisconnect', connId))}>
              Disconnect
            </Button>
          </div>
        )}
      </section>
  )
}
