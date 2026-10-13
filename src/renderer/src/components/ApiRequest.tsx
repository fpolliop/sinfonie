/**
 * API explorer, phase 2: the request editor, the response, request settings (environment, auth) and
 * history. Requests run in main and only reach this Mac (see services/api/requests.ts).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, Copy, Plus, Send, Trash2, X } from 'lucide-react'
import type { ApiAuth, ApiEndpoint, ApiEnv, ApiHistoryEntry, ApiRequest, ApiResponse, ApiSettings, ApiState } from '@shared/types'
import { api } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { timeAgo } from '@/lib/format'
import { useApp } from '@/stores/app'
import { Button, Dialog, Field, IconButton, Segmented, Spinner, inputCls } from './ui'

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
export const METHOD_TONE: Record<string, string> = {
  GET: 'bg-accent/15 text-accent',
  POST: 'bg-ok/15 text-ok',
  PUT: 'bg-warn/15 text-warn',
  PATCH: 'bg-warn/15 text-warn',
  DELETE: 'bg-danger/15 text-danger'
}
const withBody = (m: string) => !['GET', 'HEAD', 'OPTIONS'].includes(m)

/** `:id`, `*rest` and `{id}` in a route template. */
function paramsOf(template: string): string[] {
  return Array.from(template.matchAll(/[:*](\w+)|\{(\w+)\}/g)).map((m) => m[1] ?? m[2])
}
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/[:*](\w+)|\{(\w+)\}/g, (whole, a, b) => {
    const v = values[a ?? b]
    return v ? encodeURIComponent(v).replace(/%2F/gi, '/') : whole
  })
}

/** What the editor opens with: an endpoint from the list, a past request, or a blank one. */
export type Draft = { endpoint?: ApiEndpoint; request?: ApiRequest }

type Rows = [string, string][]
function RowsEditor({ rows, onChange, keyLabel, valueLabel }: { rows: Rows; onChange: (r: Rows) => void; keyLabel: string; valueLabel: string }): React.JSX.Element {
  return (
    <div className="space-y-1">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-1">
          <input className={clsx(inputCls, 'h-[26px] w-2/5! py-0 font-mono text-[12px]')} value={k} placeholder={keyLabel} aria-label={`${keyLabel} ${i + 1}`} onChange={(e) => onChange(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <input className={clsx(inputCls, 'h-[26px] w-auto! min-w-0 flex-1 py-0 font-mono text-[12px]')} value={v} placeholder={valueLabel} aria-label={`${valueLabel} ${i + 1}`} onChange={(e) => onChange(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          <IconButton label={`Remove ${k || 'row'}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <X size={12} />
          </IconButton>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange([...rows, ['', '']])}>
        <Plus size={12} aria-hidden /> Add
      </Button>
    </div>
  )
}

function statusTone(s: number): string {
  if (s >= 500) return 'bg-danger/15 text-danger'
  if (s >= 400) return 'bg-warn/15 text-warn'
  if (s >= 300) return 'bg-accent/15 text-accent'
  return 'bg-ok/15 text-ok'
}
function sizeOf(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}
function pretty(body: string, headers: [string, string][]): string {
  const ct = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
  if (!/json/.test(ct) && !/^\s*[[{]/.test(body)) return body
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

function ResponseView({ res }: { res: ApiResponse }): React.JSX.Element {
  const [tab, setTab] = useState<'body' | 'headers'>('body')
  const text = useMemo(() => pretty(res.body, res.headers), [res])
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[12px]">
        <span className={clsx('rounded px-1.5 font-mono text-[12px] font-semibold', statusTone(res.status))}>
          {res.status} {res.statusText}
        </span>
        <span className="text-muted">
          {res.ms} ms · {sizeOf(res.bytes)}
          {res.truncated ? ' · showing the first 2 MB' : ''}
        </span>
        <span className="ml-auto" />
        <Segmented size="sm" value={tab} onChange={setTab} options={[{ id: 'body', label: 'Body' }, { id: 'headers', label: `Headers (${res.headers.length})` }]} />
        <IconButton label="Copy response body" onClick={() => void navigator.clipboard.writeText(res.body)}>
          <Copy size={12} />
        </IconButton>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[12px]">
        {tab === 'body' ? text || '(empty body)' : res.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}
      </pre>
    </div>
  )
}

export function RequestEditor({ workspaceId, draft, state, onBack, onSent }: { workspaceId: string; draft: Draft; state: ApiState; onBack: () => void; onSent: () => void }): React.JSX.Element {
  const notify = useApp((s) => s.notify)
  const initial = useMemo(() => {
    const r = draft.request
    if (r) {
      const [p, qs] = r.path.split('?')
      return { method: r.method, template: p, query: Array.from(new URLSearchParams(qs ?? '').entries()) as Rows, headers: r.headers, body: r.body ?? '', env: r.env }
    }
    const e = draft.endpoint
    const method = !e || e.method === 'ANY' ? 'GET' : e.method
    return { method, template: e?.path ?? '/', query: [] as Rows, headers: [] as Rows, body: withBody(method) ? '{}' : '', env: state.settings.env }
  }, [draft, state.settings.env])
  const [method, setMethod] = useState(initial.method)
  const [template, setTemplate] = useState(initial.template)
  const [values, setValues] = useState<Record<string, string>>({})
  const [query, setQuery] = useState<Rows>(initial.query)
  const [headers, setHeaders] = useState<Rows>(initial.headers)
  const [body, setBody] = useState(initial.body)
  const [env, setEnv] = useState<ApiEnv>(initial.env)
  const [tab, setTab] = useState<'params' | 'headers' | 'body'>(withBody(initial.method) ? 'body' : 'params')
  const [sending, setSending] = useState(false)
  const [res, setRes] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sendRef = useRef<() => void>(() => undefined)
  const rootRef = useRef<HTMLDivElement>(null)

  const params = paramsOf(template)
  const qs = new URLSearchParams(query.filter(([k]) => k.trim())).toString()
  const path = fill(template, values) + (qs ? `?${qs}` : '')
  const request = (): ApiRequest => ({ method, path, headers: headers.filter(([k]) => k.trim()), body: withBody(method) ? body : undefined, env, endpointId: draft.endpoint?.id ?? draft.request?.endpointId })
  const missing = params.filter((p) => !values[p])
  const base = state.bases[env]

  const send = (): void => {
    if (sending) return
    setSending(true)
    setError(null)
    void api
      .invoke('api:send', workspaceId, request())
      .then(setRes)
      .catch((err) => {
        setRes(null)
        setError(friendlyError(err))
      })
      .finally(() => {
        setSending(false)
        onSent()
      })
  }
  sendRef.current = send
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Only while focus is in this editor: ⌘↵ elsewhere (the agent chat) belongs to that box.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && rootRef.current?.contains(document.activeElement)) {
        e.preventDefault()
        sendRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const copyCurl = (): void => {
    void api
      .invoke('api:curl', workspaceId, request())
      .then((c) => navigator.clipboard.writeText(c))
      .then(() => notify({ kind: 'success', text: state.settings.hasSecret ? 'Copied as curl, with your auth' : 'Copied as curl' }))
      .catch((err) => setError(friendlyError(err)))
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <IconButton label="Back to endpoints" onClick={onBack}>
          <ArrowLeft size={14} />
        </IconButton>
        <div className="min-w-0 flex-1 truncate text-[12px] text-muted">{draft.endpoint?.summary ?? draft.endpoint?.group ?? (draft.request ? 'From history' : 'New request')}</div>
        <Segmented size="sm" value={env} onChange={setEnv} options={[{ id: 'workspace', label: 'This workspace' }, { id: 'local', label: 'Local' }]} />
      </div>
      <div className="flex items-center gap-1">
        <select className={clsx(inputCls, 'h-[30px] w-[92px]! shrink-0 py-0 font-mono text-[12px] font-semibold')} value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method">
          {METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-border bg-bg">
          <span className="max-w-[45%] shrink-0 truncate pl-2 font-mono text-[12px] text-muted" title={base ?? undefined}>{base ?? (env === 'workspace' ? 'no port yet' : 'set a local URL')}</span>
          <input className="h-[28px] min-w-0 flex-1 bg-transparent px-1 font-mono text-[12px] outline-none" value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Path" spellCheck={false} />
        </div>
        <Button variant="primary" onClick={send} disabled={sending || !base} title="Send (⌘↵)">
          {sending ? <Spinner /> : <Send size={13} aria-hidden />} Send
        </Button>
        <IconButton label="Copy as curl" onClick={copyCurl} disabled={!base}>
          <Copy size={13} />
        </IconButton>
      </div>
      {missing.length > 0 && <div className="text-[11px] text-muted">Fill in {missing.map((m) => `:${m}`).join(', ')} below, or the placeholder is sent as written.</div>}
      <div className="rounded-lg border border-border bg-panel p-2">
        <Segmented
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { id: 'params', label: `Params${params.length + query.length ? ` (${params.length + query.length})` : ''}` },
            { id: 'headers', label: `Headers${headers.length ? ` (${headers.length})` : ''}` },
            { id: 'body', label: 'Body' }
          ]}
        />
        <div className="mt-2 max-h-[30vh] overflow-auto">
          {tab === 'params' && (
            <div className="space-y-2">
              {params.map((p) => (
                <label key={p} className="flex items-center gap-2">
                  <code className="w-2/5 truncate text-[12px] text-muted">:{p}</code>
                  <input className={clsx(inputCls, 'h-[26px] w-auto! min-w-0 flex-1 py-0 font-mono text-[12px]')} value={values[p] ?? ''} onChange={(e) => setValues({ ...values, [p]: e.target.value })} aria-label={`Path parameter ${p}`} />
                </label>
              ))}
              <div className="text-[11px] font-medium text-muted">Query</div>
              <RowsEditor rows={query} onChange={setQuery} keyLabel="Name" valueLabel="Value" />
            </div>
          )}
          {tab === 'headers' && (
            <>
              <RowsEditor rows={headers} onChange={setHeaders} keyLabel="Header" valueLabel="Value" />
              <div className="mt-1 text-[11px] text-muted">{state.settings.auth.kind === 'none' ? 'No auth is added. Set it up in Request settings.' : `Auth from Request settings is added unless you set the header here.`}</div>
            </>
          )}
          {tab === 'body' &&
            (withBody(method) ? (
              <textarea className={clsx(inputCls, 'h-40 w-full resize-y font-mono text-[12px]')} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Request body" spellCheck={false} />
            ) : (
              <div className="text-[12px] text-muted">{method} requests have no body.</div>
            ))}
        </div>
      </div>
      {error && (
        <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}
      {res && <ResponseView res={res} />}
    </div>
  )
}

export function HistoryList({ history, onOpen, onClear }: { history: ApiHistoryEntry[]; onOpen: (h: ApiHistoryEntry) => void; onClear: () => void }): React.JSX.Element {
  if (!history.length) return <div className="py-10 text-center text-[12px] text-muted">No requests yet. Pick an endpoint and press Send.</div>
  return (
    <div>
      <div className="mb-1 flex items-center">
        <span className="text-[11px] font-medium text-muted">Last {history.length} requests</span>
        <span className="ml-auto" />
        <Button size="sm" variant="ghost" onClick={onClear}>
          <Trash2 size={12} aria-hidden /> Clear history
        </Button>
      </div>
      <ul className="rounded-lg border border-border bg-panel">
        {history.map((h) => (
          <li key={h.id}>
            <button type="button" className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-panel-2" onClick={() => onOpen(h)}>
              <span className={clsx('w-14 shrink-0 rounded px-1 text-center font-mono text-[11px] font-semibold', METHOD_TONE[h.request.method] ?? 'bg-panel-2 text-muted')}>{h.request.method}</span>
              <code className="min-w-0 flex-1 truncate text-[12px]" title={h.url}>
                {h.request.path}
              </code>
              {h.status ? <span className={clsx('rounded px-1 font-mono text-[11px]', statusTone(h.status))}>{h.status}</span> : <span className="max-w-[30%] truncate text-[11px] text-danger">{h.error ?? 'failed'}</span>}
              <span className="w-16 shrink-0 text-right text-[11px] text-muted">{timeAgo(h.at)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const AUTH_LABEL: Record<ApiAuth['kind'], string> = { none: 'None', bearer: 'Bearer token', basic: 'Basic', header: 'API key header' }

export function RequestSettings({ workspaceId, state, onClose, onSaved }: { workspaceId: string; state: ApiState; onClose: () => void; onSaved: (s: ApiState) => void }): React.JSX.Element {
  const [settings, setSettings] = useState<ApiSettings>(state.settings)
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const kind = settings.auth.kind
  const save = (): void => {
    void api
      .invoke('api:setSettings', workspaceId, settings, secret ? secret : undefined)
      .then((s) => {
        onSaved(s)
        onClose()
      })
      .catch((err) => setError(friendlyError(err)))
  }
  return (
    <Dialog title="Request settings" onClose={onClose} width={460}>
      <Field label="Default environment" hint={state.bases.workspace ? `This workspace is ${state.bases.workspace}.` : 'This workspace has no port yet.'}>
        <Segmented value={settings.env} onChange={(env) => setSettings({ ...settings, env })} options={[{ id: 'workspace', label: 'This workspace' }, { id: 'local', label: 'Local' }]} />
      </Field>
      <Field label="Local base URL" hint="Another app on this Mac, e.g. a backend you run outside Sinfonie. Only localhost addresses for now.">
        <input className={clsx(inputCls, 'w-full font-mono text-[12px]')} placeholder="http://localhost:3001" value={settings.localBase ?? ''} onChange={(e) => setSettings({ ...settings, localBase: e.target.value })} />
      </Field>
      <Field label="Auth">
        <select className={clsx(inputCls, 'w-full')} value={kind} onChange={(e) => setSettings({ ...settings, auth: { kind: e.target.value as ApiAuth['kind'], name: undefined } })}>
          {(Object.keys(AUTH_LABEL) as ApiAuth['kind'][]).map((k) => (
            <option key={k} value={k}>
              {AUTH_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      {(kind === 'basic' || kind === 'header') && (
        <Field label={kind === 'basic' ? 'User name' : 'Header name'}>
          <input className={clsx(inputCls, 'w-full font-mono text-[12px]')} placeholder={kind === 'header' ? 'x-api-key' : ''} value={settings.auth.name ?? ''} onChange={(e) => setSettings({ ...settings, auth: { ...settings.auth, name: e.target.value } })} />
        </Field>
      )}
      {kind !== 'none' && (
        <Field label={kind === 'basic' ? 'Password' : kind === 'bearer' ? 'Token' : 'Key'} hint="Stored encrypted on this Mac, never shared with the team or kept in history.">
          <input type="password" className={clsx(inputCls, 'w-full font-mono text-[12px]')} placeholder={state.settings.hasSecret ? 'Saved. Type to replace it.' : ''} value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
        </Field>
      )}
      {error && (
        <div role="alert" className="mb-3 text-[12px] text-danger">
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save}>
          Save settings
        </Button>
      </div>
    </Dialog>
  )
}
