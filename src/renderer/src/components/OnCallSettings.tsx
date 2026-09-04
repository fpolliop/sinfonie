import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Plus, X, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Field, inputCls } from './ui'
import { ModelSelect } from './ModelSelect'
import { AccountPicker } from './AccountPicker'
import type { OnCallChannel, OnCallSettings as OnCallSettingsT } from '@shared/types'

const DEFAULTS: OnCallSettingsT = { enabled: false, channels: [], pollSeconds: 60, maxTriagesPerHour: 12, context: '' }

/** Application → On call: the Slack connection, which channels to watch, and how the triage agent runs. */
export function OnCallSettings(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const spaces = useApp((s) => s.spaces)
  const setError = useApp((s) => s.setError)
  const oc = { ...DEFAULTS, ...(settings.oncall ?? {}) }
  const slack = settings.slack ?? { connected: false, hasClient: false }
  const [clientId, setClientId] = useState(slack.clientId ?? '')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')
  const [q, setQ] = useState('')
  const [found, setFound] = useState<{ id: string; name: string; is_private: boolean; is_member: boolean }[] | null>(null)
  const [searching, setSearching] = useState(false)
  useEffect(() => setClientId(slack.clientId ?? ''), [slack.clientId])
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const update = (patch: Partial<OnCallSettingsT>): Promise<unknown> => api.invoke('settings:update', { oncall: { ...oc, ...patch } })
  const addChannel = (c: { id: string; name: string }, kind: OnCallChannel['kind']): void => {
    if (oc.channels.some((x) => x.id === c.id)) return
    void go(() => update({ channels: [...oc.channels, { id: c.id, name: c.name, kind }] }))
  }

  return (
    <div className="max-w-[760px]">
      <p className="mb-4 text-[12px] text-muted">The on-call agent watches Slack channels while Sinfonie is open. Every new request or alert becomes an incident, gets triaged by a read-only agent with your code at hand, and shows up in the On call view with a drafted reply you approve. Nothing is posted without you.</p>

      <label className="mb-4 flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={oc.enabled} onChange={(e) => go(() => update({ enabled: e.target.checked }))} />
        Watch the channels below
        {oc.enabled && !slack.connected && <span className="text-[11px] text-warn">Connect Slack first</span>}
        {oc.enabled && slack.connected && oc.channels.length === 0 && <span className="text-[11px] text-warn">Add a channel</span>}
      </label>

      <section className="mb-4 rounded-lg border border-border p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          Slack
          {slack.connected ? <Badge tone="ok">connected as {slack.userName} · {slack.teamName}</Badge> : <Badge tone="warn">not connected</Badge>}
        </div>
        {!slack.connected && (
          <>
            <p className="mb-2 text-[11px] text-muted">
              Slack requires a registered app for sign-in. Create one at api.slack.com/apps ("from scratch", your workspace), add the redirect URL <code className="rounded bg-panel-2 px-1">https://sinfonie.dev/oauth/slack/callback</code> under OAuth &amp; Permissions, add the user token scopes channels:history, channels:read, groups:history, groups:read, chat:write, search:read.public, users:read, then paste the client id and secret from Basic Information.
            </p>
            <div className="mb-2 grid grid-cols-2 gap-2">
              <input className={inputCls} placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
              <input className={inputCls} placeholder={slack.hasClient ? 'Client secret (stored)' : 'Client secret'} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" disabled={!clientId.trim() || (!secret.trim() && !slack.hasClient)} onClick={() => go(async () => {
                if (secret.trim()) await api.invoke('oncall:slackSetClient', clientId, secret)
                await api.invoke('oncall:slackConnect')
              })}>
                Sign in with Slack
              </Button>
              <span className="text-[11px] text-muted">Approve in the browser; Sinfonie reopens by itself.</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input className={clsx(inputCls, 'max-w-[360px]')} placeholder="If it did not come back: paste the code shown in the browser" value={code} onChange={(e) => setCode(e.target.value)} />
              <Button size="sm" disabled={!code.trim()} onClick={() => go(async () => (await api.invoke('oncall:slackFinish', code.trim()), setCode('')))}>
                Finish
              </Button>
            </div>
          </>
        )}
        {slack.connected && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted">Replies the agent drafts are sent as you, only after you approve them.</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => go(() => api.invoke('oncall:slackDisconnect'))}>
              Disconnect
            </Button>
          </div>
        )}
      </section>

      <section className="mb-4 rounded-lg border border-border p-3">
        <div className="mb-2 text-[13px] font-semibold">Channels</div>
        {oc.channels.length === 0 && <div className="mb-2 text-[11px] text-muted">No channels yet.</div>}
        {oc.channels.map((c) => (
          <div key={c.id} className="mb-1 flex items-center gap-2 text-[13px]">
            <span>#{c.name}</span>
            <select className="rounded-md border border-border bg-bg px-1.5 py-0.5 text-[11px]" value={c.kind} onChange={(e) => go(() => update({ channels: oc.channels.map((x) => (x.id === c.id ? { ...x, kind: e.target.value as OnCallChannel['kind'] } : x)) }))}>
              <option value="support">support requests</option>
              <option value="alerts">alerts</option>
            </select>
            <button className="rounded p-0.5 text-muted hover:text-danger" onClick={() => go(() => update({ channels: oc.channels.filter((x) => x.id !== c.id) }))} aria-label="Remove channel">
              <X size={12} />
            </button>
          </div>
        ))}
        <div className="mt-2 flex items-center gap-2">
          <input className={clsx(inputCls, 'max-w-[280px]')} placeholder="Find a channel, e.g. on-call" value={q} disabled={!slack.connected} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void go(async () => (setSearching(true), setFound(await api.invoke('oncall:slackChannels', q)), setSearching(false)))} />
          <Button size="sm" disabled={!slack.connected || searching} onClick={() => go(async () => (setSearching(true), setFound(await api.invoke('oncall:slackChannels', q)), setSearching(false)))}>
            <RefreshCw size={12} className={searching ? 'animate-spin' : ''} /> Search
          </Button>
        </div>
        {found && (
          <div className="mt-2 max-h-[180px] overflow-auto rounded-md border border-border">
            {found.length === 0 && <div className="px-2 py-1.5 text-[11px] text-muted">No channels match.</div>}
            {found.slice(0, 50).map((c) => (
              <div key={c.id} className="flex items-center gap-2 border-b border-border px-2 py-1 text-[12px] last:border-b-0">
                <span>#{c.name}</span>
                {c.is_private && <Badge>private</Badge>}
                {!c.is_member && <span className="text-[11px] text-warn">join it in Slack first</span>}
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" disabled={!c.is_member} onClick={() => addChannel(c, 'support')}>
                    <Plus size={11} /> support
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!c.is_member} onClick={() => addChannel(c, 'alerts')}>
                    <Plus size={11} /> alerts
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <Field label="Code the agent may read" hint="Repositories of this space are attached read-only, so stack traces and feature names lead somewhere.">
        <select className={inputCls} value={oc.spaceId ?? ''} onChange={(e) => go(() => update({ spaceId: e.target.value || undefined }))}>
          <option value="">All registered repositories</option>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Team context" hint="What the agent should know: services and owners, where runbooks live, what normal looks like, how to talk to customers.">
        <textarea className={clsx(inputCls, 'min-h-[96px]')} defaultValue={oc.context} onBlur={(e) => e.target.value !== oc.context && go(() => update({ context: e.target.value }))} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Model" hint="Claude Code model for triage runs.">
          <ModelSelect value={oc.model ?? ''} onChange={(model) => go(() => update({ model: model || undefined }))} allowDefault defaultLabel="App default" />
        </Field>
        <Field label="Account" hint="Which Claude login pays for triage.">
          <AccountPicker value={oc.claudeAccountId ?? ''} onChange={(id) => go(() => update({ claudeAccountId: id || undefined }))} always engine="claude-code" />
        </Field>
        <Field label="Check every (seconds)" hint="How often Slack is polled. 15 minimum.">
          <input type="number" min={15} className={inputCls} defaultValue={oc.pollSeconds} onBlur={(e) => go(() => update({ pollSeconds: Math.max(15, Number(e.target.value) || 60) }))} />
        </Field>
        <Field label="Triage runs per hour" hint="A cap on agent runs, so a noisy channel cannot burn through a budget.">
          <input type="number" min={1} className={inputCls} defaultValue={oc.maxTriagesPerHour} onBlur={(e) => go(() => update({ maxTriagesPerHour: Math.max(1, Number(e.target.value) || 12) }))} />
        </Field>
      </div>
    </div>
  )
}
