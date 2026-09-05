import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Siren, ExternalLink, RefreshCw, Send, Trash2, MessageSquare, Sparkles, Settings as SettingsIcon } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useOnCall, subscribeOnCall } from '@/stores/oncall'
import { Badge, Button, Spinner, inputCls } from './ui'
import { Markdown } from '@/lib/markdown'
import { timeAgo } from '@/lib/format'
import type { Incident, IncidentStatus, Severity } from '@shared/types'

const SEV: Record<Severity, { tone: 'muted' | 'ok' | 'warn' | 'danger' | 'accent'; label: string }> = {
  low: { tone: 'muted', label: 'low' },
  medium: { tone: 'accent', label: 'medium' },
  high: { tone: 'warn', label: 'high' },
  critical: { tone: 'danger', label: 'critical' }
}
const STATUSES: { id: IncidentStatus; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'triaging', label: 'Triaging' },
  { id: 'open', label: 'Open' },
  { id: 'waiting', label: 'Waiting on them' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'dismissed', label: 'Dismissed' }
]
const OPEN = new Set<IncidentStatus>(['new', 'triaging', 'open', 'waiting'])

export function OnCallView(): React.JSX.Element {
  const { state, selectedId, select, filter, setFilter } = useOnCall()
  const settings = useApp((s) => s.settings)
  const openSettings = useApp((s) => s.openSettings)
  const setError = useApp((s) => s.setError)
  useEffect(() => subscribeOnCall(), [])
  const [checking, setChecking] = useState(false)
  const checkNow = (): void => {
    setChecking(true)
    void go(() => api.invoke('oncall:pollNow')).finally(() => setChecking(false))
  }
  const incidents = useMemo(() => (state?.incidents ?? []).filter((i) => filter === 'all' || OPEN.has(i.status)), [state, filter])
  const selected = state?.incidents.find((i) => i.id === selectedId) ?? null
  const spaces = useApp((s) => s.spaces)
  const configured = (state?.activeSpaces.length ?? 0) > 0 || Boolean(settings.slack?.connected && (settings.oncall?.channels?.length ?? 0) > 0) || spaces.some((sp) => (sp.oncall?.channels?.length ?? 0) > 0)
  const spaceOf = (id: string): { name: string; color: string } | null => {
    const sp = spaces.find((x) => x.id === id)
    return sp ? { name: sp.name, color: sp.color } : null
  }
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full">
      <div className="flex w-[340px] shrink-0 flex-col border-r border-border">
        <div className="drag flex h-[52px] items-center gap-2 border-b border-border px-4">
          <Siren size={15} className="text-accent" />
          <span className="text-[13px] font-semibold">On call</span>
          <span className={clsx('ml-1 h-2 w-2 rounded-full', state?.running ? 'bg-ok' : 'bg-muted/50')} title={state?.running ? `Watching ${state.activeSpaces.map((id) => spaceOf(id)?.name ?? 'application').join(', ')}${state.lastPollAt ? `, last check ${timeAgo(state.lastPollAt)}` : ''}` : 'Not running'} />
          <div className="no-drag ml-auto flex items-center gap-1">
            <button className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-text disabled:opacity-40" title="Check Slack now" onClick={checkNow} disabled={!configured || checking}>
              <RefreshCw size={13} className={clsx(checking && 'animate-spin')} />
            </button>
            <button className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-text" title="On call settings" onClick={() => openSettings({ scope: 'app', page: 'oncall' })}>
              <SettingsIcon size={13} />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1 border-b border-border px-3 py-1.5 text-[11px]">
          {(['open', 'all'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={clsx('rounded px-2 py-0.5 capitalize', filter === f ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
              {f}
            </button>
          ))}
          <span className={clsx('ml-auto truncate', state?.lastError && !checking ? 'text-warn' : 'text-muted')} title={state?.lastError ?? ''}>
            {checking ? 'Checking Slack…' : state?.lastError ? state.lastError : state?.lastPollAt ? `Checked ${timeAgo(state.lastPollAt)}${state.nextPollAt ? `, next in ${Math.max(0, Math.round((new Date(state.nextPollAt).getTime() - Date.now()) / 1000))}s` : ''}` : state?.running ? 'Waiting for the first check…' : ''}
          </span>
        </div>
        {state?.running && <div className="border-b border-border bg-panel px-3 py-1 text-[10px] text-muted">Slack allows one channel or thread read per minute per app, so watched channels and open threads are checked in turn.</div>}
        <div className="flex-1 overflow-auto">
          {!configured && (
            <div className="p-4 text-[12px] text-muted">
              <p className="mb-2">The on-call agent watches Slack channels, turns requests and alerts into incidents, triages each one with the code at hand, and drafts replies you approve.</p>
              <Button size="sm" variant="primary" onClick={() => openSettings({ scope: 'app', page: 'oncall' })}>
                Set up on call
              </Button>
            </div>
          )}
          {configured && incidents.length === 0 && <div className="p-4 text-[12px] text-muted">{filter === 'open' ? 'Nothing open. New messages in the watched channels appear here within a minute.' : 'No incidents yet.'}</div>}
          {incidents.map((i) => (
            <button key={i.id} onClick={() => select(i.id)} className={clsx('block w-full border-b border-border px-3 py-2 text-left hover:bg-panel-2/60', i.id === selectedId && 'bg-panel-2')}>
              <div className="flex items-center gap-1.5 text-[11px] text-muted">
                {i.severity ? <Badge tone={SEV[i.severity].tone}>{SEV[i.severity].label}</Badge> : <Badge>{i.status === 'triaging' ? 'triaging' : 'untriaged'}</Badge>}
                {spaceOf(i.spaceId) && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: spaceOf(i.spaceId)!.color }} title={spaceOf(i.spaceId)!.name} />}
                <span>#{i.channelName}</span>
                <span className="ml-auto">{timeAgo(i.updatedAt)}</span>
              </div>
              <div className={clsx('mt-0.5 truncate text-[13px]', i.status === 'new' || i.status === 'open' ? 'font-medium' : 'text-muted')}>{i.title}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                <span>{STATUSES.find((s) => s.id === i.status)?.label}</span>
                {i.status === 'triaging' && <Spinner />}
                {i.proposals.some((p) => p.status === 'proposed') && <span className="text-accent">reply drafted</span>}
                {i.report?.needsHuman && <span className="text-warn">needs you</span>}
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">{selected ? <IncidentDetail inc={selected} go={go} /> : <div className="drag flex h-[52px]" />}</div>
    </div>
  )
}

function IncidentDetail({ inc, go }: { inc: Incident; go: (fn: () => Promise<unknown>) => Promise<void> }): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [asking, setAsking] = useState(false)
  const [newReply, setNewReply] = useState('')
  const r = inc.report
  return (
    <div className="flex h-full flex-col">
      <div className="drag flex h-[52px] items-center gap-2 border-b border-border px-5">
        <span className="truncate text-[14px] font-semibold">{inc.title}</span>
        <div className="no-drag ml-auto flex items-center gap-2">
          {inc.permalink && (
            <Button size="sm" variant="ghost" onClick={() => void api.invoke('shell:openExternal', inc.permalink!)}>
              <ExternalLink size={12} /> Open in Slack
            </Button>
          )}
          <Button size="sm" variant="ghost" title="Run the triage again with the current thread" onClick={() => go(() => api.invoke('oncall:triage', inc.id))} disabled={inc.status === 'triaging'}>
            <Sparkles size={12} /> Re-triage
          </Button>
          <button className="rounded p-1 text-muted hover:text-danger" title="Remove this incident from the list" onClick={() => go(() => api.invoke('oncall:remove', inc.id))}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2 text-[12px]">
        <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={inc.status} onChange={(e) => go(() => api.invoke('oncall:setStatus', inc.id, e.target.value as IncidentStatus))}>
          {STATUSES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={inc.severity ?? ''} onChange={(e) => e.target.value && go(() => api.invoke('oncall:setSeverity', inc.id, e.target.value as Severity))}>
          <option value="">severity…</option>
          {(Object.keys(SEV) as Severity[]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="text-muted">
          #{inc.channelName} · {inc.kind} · opened {timeAgo(inc.createdAt)}
          {inc.costUsd > 0 ? ` · $${inc.costUsd.toFixed(2)} spent` : ''}
        </span>
        {r && <Badge tone={r.confidence === 'high' ? 'ok' : r.confidence === 'medium' ? 'accent' : 'warn'}>{r.confidence} confidence</Badge>}
        {r?.category && <Badge>{r.category}</Badge>}
      </div>
      <div className="flex-1 space-y-4 overflow-auto px-5 py-4 text-[13px]">
        {inc.error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">Triage failed: {inc.error}</div>}
        {inc.status === 'triaging' && (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> Investigating…
          </div>
        )}
        {r && (
          <section className="rounded-lg border border-border p-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Triage</div>
            <p className="mb-2">{r.summary}</p>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Likely cause</div>
            <p className="mb-2">{r.likelyCause}</p>
            {r.evidence.length > 0 && (
              <>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Evidence</div>
                <ul className="mb-2 list-disc pl-5 text-[12px]">
                  {r.evidence.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </>
            )}
            {r.nextSteps.length > 0 && (
              <>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Next steps</div>
                <ol className="list-decimal pl-5 text-[12px]">
                  {r.nextSteps.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ol>
              </>
            )}
          </section>
        )}
        {inc.proposals.filter((p) => p.status !== 'dismissed').length > 0 && (
          <section className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Replies</div>
            {inc.proposals
              .filter((p) => p.status !== 'dismissed')
              .map((p) => (
                <div key={p.id} className={clsx('rounded-lg border p-3', p.status === 'sent' ? 'border-border' : 'border-accent/40 bg-accent/5')}>
                  {p.status === 'sent' ? (
                    <div className="text-[12px]">
                      <span className="text-muted">Sent {timeAgo(p.sentAt ?? p.createdAt)}: </span>
                      {p.text}
                    </div>
                  ) : (
                    <>
                      <textarea className={clsx(inputCls, 'mb-2 min-h-[72px]')} value={drafts[p.id] ?? p.text} onChange={(e) => setDrafts({ ...drafts, [p.id]: e.target.value })} />
                      <div className="flex gap-2">
                        <Button size="sm" variant="primary" onClick={() => go(() => api.invoke('oncall:approve', inc.id, p.id, drafts[p.id] ?? p.text))}>
                          <Send size={12} /> Send in thread as you
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => go(() => api.invoke('oncall:dismissProposal', inc.id, p.id))}>
                          Dismiss
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ))}
          </section>
        )}
        <section>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Thread</div>
          <div className="space-y-1.5">
            {inc.messages.map((m) => (
              <div key={m.ts} className="rounded-lg bg-panel px-3 py-2 text-[12px]">
                <span className="font-medium">{m.userName ?? m.user}</span> <span className="text-muted">{timeAgo(new Date(Number(m.ts) * 1000).toISOString())}</span>
                <div className="mt-0.5 whitespace-pre-wrap">{m.text}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input className={inputCls} placeholder="Write a reply to send in the thread…" value={newReply} onChange={(e) => setNewReply(e.target.value)} />
            <Button size="sm" disabled={!newReply.trim()} onClick={() => go(async () => (await api.invoke('oncall:addProposal', inc.id, newReply.trim()), setNewReply('')))}>
              Draft
            </Button>
          </div>
        </section>
        {inc.notes.length > 0 && (
          <section>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Notes and questions</div>
            <div className="space-y-2">
              {inc.notes.map((n, i) => (
                <div key={i} className={clsx('rounded-lg px-3 py-2 text-[12px]', n.role === 'user' ? 'bg-accent-2/20' : n.role === 'agent' ? 'border border-border' : 'text-muted')}>
                  {n.role === 'agent' ? <Markdown text={n.text} /> : n.text}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      <div className="border-t border-border px-5 py-3">
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="Ask about this incident… (the agent reads the code and Slack, never changes anything)"
            value={question}
            disabled={asking}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && question.trim() && !asking) {
                setAsking(true)
                const q = question.trim()
                setQuestion('')
                void go(() => api.invoke('oncall:ask', inc.id, q)).finally(() => setAsking(false))
              }
            }}
          />
          <Button size="sm" variant="primary" disabled={!question.trim() || asking} onClick={() => {
            setAsking(true)
            const q = question.trim()
            setQuestion('')
            void go(() => api.invoke('oncall:ask', inc.id, q)).finally(() => setAsking(false))
          }}>
            {asking ? <Spinner /> : <MessageSquare size={12} />} Ask
          </Button>
        </div>
      </div>
    </div>
  )
}
