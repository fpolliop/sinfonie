/**
 * API explorer: the request editor, the response, request settings (environments, auth), history and
 * the space's saved requests. Requests run in main (see services/api/requests.ts); one that goes to
 * staging or production is shown in full and confirmed first, since it leaves the Mac.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, Bookmark, Copy, Download, Pencil, Plus, Send, Trash2, Upload, X } from 'lucide-react'
import { API_REMOTE_ENVS, type ApiAuth, type ApiEndpoint, type ApiEnv, type ApiEnvDef, type ApiHistoryEntry, type ApiPreview, type ApiRemoteEnv, type ApiRequest, type ApiResponse, type ApiSavedRequest, type ApiSettings, type ApiState } from '@shared/types'
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

/** What the editor opens with: an endpoint from the list, a past or saved request, or a blank one. */
export type Draft = { endpoint?: ApiEndpoint; request?: ApiRequest; saved?: ApiSavedRequest }

export const ENV_LABEL: Record<ApiEnv, string> = { workspace: 'This workspace', local: 'Local', staging: 'Staging', production: 'Production' }
const isRemote = (env: ApiEnv): env is ApiRemoteEnv => (API_REMOTE_ENVS as string[]).includes(env)

/** The environments this workspace can send to: the local two, plus the space's staging and production once set. */
function envOptions(state: ApiState): { id: ApiEnv; label: string }[] {
  return (['workspace', 'local', ...API_REMOTE_ENVS] as ApiEnv[]).filter((e) => !isRemote(e) || state.bases[e]).map((id) => ({ id, label: ENV_LABEL[id] }))
}

/** Everything a request to staging or production will send, before it leaves the Mac. */
function ConfirmSend({ env, preview, onCancel, onConfirm }: { env: ApiRemoteEnv; preview: ApiPreview; onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(preview.method)
  return (
    <Dialog title={`Send to ${ENV_LABEL[env].toLowerCase()}?`} onClose={onCancel} width={560}>
      <p className="mb-3 text-[13px]">
        This request leaves your Mac and goes to <strong>{new URL(preview.url).host}</strong>.{' '}
        {env === 'production' && write ? 'It can change real data in production.' : write ? 'It can change data on that server.' : 'It only reads.'}
      </p>
      <pre className="mb-3 max-h-[40vh] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-bg p-3 font-mono text-[12px]">
        {[`${preview.method} ${preview.url}`, ...preview.headers.map(([k, v]) => `${k}: ${v}`), ...(preview.body ? ['', preview.body] : [])].join('\n')}
      </pre>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Don't send
        </Button>
        <Button variant={env === 'production' && write ? 'danger' : 'primary'} onClick={onConfirm} autoFocus>
          Send to {ENV_LABEL[env].toLowerCase()}
        </Button>
      </div>
    </Dialog>
  )
}

/** Name a request (and optionally a folder) to keep it in the space's shared collection. */
function SaveDialog({ initial, onCancel, onSave }: { initial: { name: string; folder?: string }; onCancel: () => void; onSave: (name: string, folder: string) => void }): React.JSX.Element {
  const [name, setName] = useState(initial.name)
  const [folder, setFolder] = useState(initial.folder ?? '')
  return (
    <Dialog title="Save request" onClose={onCancel} width={420}>
      <Field label="Name">
        <input className={clsx(inputCls, 'w-full')} value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSave(name, folder)} />
      </Field>
      <Field label="Folder" hint="Optional. Saved requests are shared with your team; tokens and auth headers are never saved.">
        <input className={clsx(inputCls, 'w-full')} value={folder} placeholder="e.g. Orders" onChange={(e) => setFolder(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => onSave(name, folder)} disabled={!name.trim()}>
          Save request
        </Button>
      </div>
    </Dialog>
  )
}

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

export function RequestEditor({ workspaceId, draft, state, onBack, onSent, onState }: { workspaceId: string; draft: Draft; state: ApiState; onBack: () => void; onSent: () => void; onState: (s: ApiState) => void }): React.JSX.Element {
  const notify = useApp((s) => s.notify)
  const initial = useMemo(() => {
    const r = draft.saved?.request ?? draft.request
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
  const [confirm, setConfirm] = useState<{ env: ApiRemoteEnv; preview: ApiPreview } | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedId, setSavedId] = useState(draft.saved?.id)
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
    setError(null)
    // Off this Mac: show exactly what goes out, and send only after the person confirms.
    if (isRemote(env)) {
      void api
        .invoke('api:preview', workspaceId, request())
        .then((preview) => setConfirm({ env, preview }))
        .catch((err) => setError(friendlyError(err)))
      return
    }
    dispatch(request())
  }
  const dispatch = (req: ApiRequest): void => {
    setSending(true)
    setError(null)
    void api
      .invoke('api:send', workspaceId, req)
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

  const hasAuth = isRemote(env) ? Boolean(state.envs[env]?.hasSecret) : Boolean(state.settings.hasSecret)
  const copyCurl = (): void => {
    void api
      .invoke('api:curl', workspaceId, request())
      .then((c) => navigator.clipboard.writeText(c))
      .then(() => notify({ kind: 'success', text: hasAuth ? 'Copied as curl, with your auth' : 'Copied as curl' }))
      .catch((err) => setError(friendlyError(err)))
  }
  const save = (name: string, folder: string): void => {
    const { confirmed: _c, ...req } = request()
    void _c
    void api
      .invoke('api:saveRequest', workspaceId, { id: savedId, name, folder, request: req })
      .then((s) => {
        onState(s)
        setSavedId(s.saved.find((x) => x.name === name.trim() && (x.folder ?? '') === folder.trim())?.id ?? savedId)
        setSaving(false)
        notify({ kind: 'success', text: `Saved "${name.trim()}" for your team` })
      })
      .catch((err) => setError(friendlyError(err)))
  }
  const savedNow = state.saved.find((x) => x.id === savedId)
  const authHint = isRemote(env)
    ? state.envs[env]?.auth.kind && state.envs[env]?.auth.kind !== 'none'
      ? `The ${ENV_LABEL[env].toLowerCase()} auth from Request settings is added unless you set the header here.`
      : `No auth is added for ${ENV_LABEL[env].toLowerCase()}. Set it up in Request settings.`
    : state.settings.auth.kind === 'none'
      ? 'No auth is added. Set it up in Request settings.'
      : 'Auth from Request settings is added unless you set the header here.'

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col gap-2 p-3">
      {confirm && (
        <ConfirmSend
          env={confirm.env}
          preview={confirm.preview}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null)
            dispatch({ ...request(), confirmed: true })
          }}
        />
      )}
      {saving && <SaveDialog initial={{ name: savedNow?.name ?? draft.endpoint?.summary ?? `${method} ${template}`, folder: savedNow?.folder ?? draft.endpoint?.group }} onCancel={() => setSaving(false)} onSave={save} />}
      <div className="flex items-center gap-2">
        <IconButton label="Back" onClick={onBack}>
          <ArrowLeft size={14} />
        </IconButton>
        <div className="min-w-0 flex-1 truncate text-[12px] text-muted">{savedNow ? `${savedNow.folder ? `${savedNow.folder} / ` : ''}${savedNow.name}` : (draft.endpoint?.summary ?? draft.endpoint?.group ?? (draft.request ? 'From history' : 'New request'))}</div>
        <Segmented size="sm" value={env} onChange={setEnv} options={envOptions(state)} />
      </div>
      <div className="flex items-center gap-1">
        <select className={clsx(inputCls, 'h-[30px] w-[92px]! shrink-0 py-0 font-mono text-[12px] font-semibold')} value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method">
          {METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-border bg-bg">
          <span className="max-w-[45%] shrink-0 truncate pl-2 font-mono text-[12px] text-muted" title={base ?? undefined}>{base ?? (env === 'workspace' ? 'no port yet' : env === 'local' ? 'set a local URL' : `set the ${ENV_LABEL[env].toLowerCase()} URL`)}</span>
          <input className="h-[28px] min-w-0 flex-1 bg-transparent px-1 font-mono text-[12px] outline-none" value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Path" spellCheck={false} />
        </div>
        <Button variant="primary" onClick={send} disabled={sending || !base} title={isRemote(env) ? `Review and send to ${ENV_LABEL[env].toLowerCase()} (⌘↵)` : 'Send (⌘↵)'}>
          {sending ? <Spinner /> : <Send size={13} aria-hidden />} {isRemote(env) ? 'Send…' : 'Send'}
        </Button>
        <IconButton label={savedNow ? `Update the saved request "${savedNow.name}"` : 'Save request for your team'} onClick={() => setSaving(true)}>
          <Bookmark size={13} className={clsx(savedNow && 'fill-current')} />
        </IconButton>
        <IconButton label="Copy as curl" onClick={copyCurl} disabled={!base}>
          <Copy size={13} />
        </IconButton>
      </div>
      {isRemote(env) && <div className="text-[11px] text-muted">{ENV_LABEL[env]} is off this Mac: you see the full request and confirm it before it is sent.</div>}
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
              <div className="mt-1 text-[11px] text-muted">{authHint}</div>
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
              {h.by === 'agent' && (
                <span className="shrink-0 rounded border border-border px-1 text-[11px] text-muted" title="Sent by this workspace's agent">
                  agent
                </span>
              )}
              {h.status ? <span className={clsx('rounded px-1 font-mono text-[11px]', statusTone(h.status))}>{h.status}</span> : <span className="max-w-[30%] truncate text-[11px] text-danger">{h.error ?? 'failed'}</span>}
              <span className="w-16 shrink-0 text-right text-[11px] text-muted">{timeAgo(h.at)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The space's saved requests, by folder, with import and export. Deleting asks: the collection is the team's. */
export function SavedList({ workspaceId, saved, onOpen, onState }: { workspaceId: string; saved: ApiSavedRequest[]; onOpen: (s: ApiSavedRequest) => void; onState: (s: ApiState) => void }): React.JSX.Element {
  const notify = useApp((s) => s.notify)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<ApiSavedRequest | null>(null)
  const [deleting, setDeleting] = useState<ApiSavedRequest | null>(null)
  const folders = useMemo(() => {
    const m = new Map<string, ApiSavedRequest[]>()
    for (const s of [...saved].sort((a, b) => (a.folder ?? '').localeCompare(b.folder ?? '') || a.name.localeCompare(b.name))) m.set(s.folder ?? '', [...(m.get(s.folder ?? '') ?? []), s])
    return Array.from(m)
  }, [saved])
  const importFile = (): void => {
    setError(null)
    void api
      .invoke('api:import', workspaceId)
      .then((r) => {
        if (!r) return
        onState(r.state)
        notify({ kind: 'success', text: `Imported ${r.added} request${r.added === 1 ? '' : 's'} from ${r.format}${r.skipped ? ` (${r.skipped} already saved)` : ''}` })
      })
      .catch((err) => setError(friendlyError(err)))
  }
  const exportAs = (what: 'postman' | 'openapi'): void => {
    setError(null)
    void api
      .invoke('api:export', workspaceId, what)
      .then((p) => p && notify({ kind: 'success', text: `Exported to ${p.split('/').pop()}` }))
      .catch((err) => setError(friendlyError(err)))
  }
  return (
    <div>
      {renaming && (
        <SaveDialog
          initial={{ name: renaming.name, folder: renaming.folder }}
          onCancel={() => setRenaming(null)}
          onSave={(name, folder) =>
            void api
              .invoke('api:renameSaved', workspaceId, renaming.id, name, folder)
              .then((s) => {
                onState(s)
                setRenaming(null)
              })
              .catch((err) => setError(friendlyError(err)))
          }
        />
      )}
      {deleting && (
        <Dialog title="Delete saved request?" onClose={() => setDeleting(null)} width={420}>
          <p className="mb-4 text-[13px]">
            “{deleting.name}” is removed from the collection for everyone in this space.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                void api
                  .invoke('api:deleteSaved', workspaceId, deleting.id)
                  .then((s) => {
                    onState(s)
                    setDeleting(null)
                  })
                  .catch((err) => setError(friendlyError(err)))
              }
            >
              Delete for the team
            </Button>
          </div>
        </Dialog>
      )}
      <div className="mb-2 flex flex-wrap items-center gap-1">
        <span className="text-[11px] font-medium text-muted">{saved.length ? `${saved.length} saved, shared with your team` : 'Shared with your team'}</span>
        <span className="ml-auto" />
        <Button size="sm" variant="ghost" onClick={importFile}>
          <Upload size={12} aria-hidden /> Import
        </Button>
        <Button size="sm" variant="ghost" onClick={() => exportAs('postman')} disabled={!saved.length} title="Save these requests as a Postman v2.1 collection">
          <Download size={12} aria-hidden /> Postman
        </Button>
        <Button size="sm" variant="ghost" onClick={() => exportAs('openapi')} title="Save the discovered endpoints as an OpenAPI 3 document">
          <Download size={12} aria-hidden /> OpenAPI
        </Button>
      </div>
      {error && (
        <div role="alert" className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}
      {!saved.length && <div className="py-10 text-center text-[12px] text-muted">No saved requests yet. Open an endpoint and save it, or import a Postman collection or an OpenAPI file.</div>}
      {folders.map(([folder, list]) => (
        <section key={folder || '.'} className="mb-3">
          {folder && <div className="mb-1 text-[11px] font-medium text-muted">{folder}</div>}
          <ul className="rounded-lg border border-border bg-panel">
            {list.map((s) => (
              <li key={s.id} className="group flex items-center gap-2 px-3 py-1 hover:bg-panel-2">
                <span className={clsx('w-14 shrink-0 rounded px-1 text-center font-mono text-[11px] font-semibold', METHOD_TONE[s.request.method] ?? 'bg-panel-2 text-muted')}>{s.request.method}</span>
                <button type="button" className="flex min-w-0 flex-1 items-baseline gap-2 text-left" onClick={() => onOpen(s)} title={`Open ${s.name}`}>
                  <span className="truncate text-[12px]">{s.name}</span>
                  <code className="min-w-0 truncate text-[11px] text-muted">{s.request.path}</code>
                </button>
                {isRemote(s.request.env) && <span className="shrink-0 rounded border border-border px-1 text-[11px] text-muted">{ENV_LABEL[s.request.env].toLowerCase()}</span>}
                <IconButton label={`Rename ${s.name}`} className="reveal-on-focus opacity-0 group-hover:opacity-100" onClick={() => setRenaming(s)}>
                  <Pencil size={12} />
                </IconButton>
                <IconButton label={`Delete ${s.name}`} className="reveal-on-focus opacity-0 group-hover:opacity-100" onClick={() => setDeleting(s)}>
                  <Trash2 size={12} />
                </IconButton>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

const AUTH_LABEL: Record<ApiAuth['kind'], string> = { none: 'None', bearer: 'Bearer token', basic: 'Basic', header: 'API key header' }

type EnvForm = { baseUrl: string; auth: ApiAuth; secret: string }
const envFormOf = (state: ApiState, env: ApiRemoteEnv): EnvForm => ({ baseUrl: state.envs[env]?.baseUrl ?? '', auth: state.envs[env]?.auth ?? { kind: 'none' }, secret: '' })

/** Auth kind, its name (user or header) and the secret: the same fields for local, staging and production. */
function AuthFields({ auth, onAuth, secret, onSecret, hasSecret }: { auth: ApiAuth; onAuth: (a: ApiAuth) => void; secret: string; onSecret: (s: string) => void; hasSecret: boolean }): React.JSX.Element {
  const kind = auth.kind
  return (
    <>
      <Field label="Auth">
        <select className={clsx(inputCls, 'w-full')} value={kind} onChange={(e) => onAuth({ kind: e.target.value as ApiAuth['kind'], name: undefined })}>
          {(Object.keys(AUTH_LABEL) as ApiAuth['kind'][]).map((k) => (
            <option key={k} value={k}>
              {AUTH_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      {(kind === 'basic' || kind === 'header') && (
        <Field label={kind === 'basic' ? 'User name' : 'Header name'}>
          <input className={clsx(inputCls, 'w-full font-mono text-[12px]')} placeholder={kind === 'header' ? 'x-api-key' : ''} value={auth.name ?? ''} onChange={(e) => onAuth({ ...auth, name: e.target.value })} />
        </Field>
      )}
      {kind !== 'none' && (
        <Field label={kind === 'basic' ? 'Password' : kind === 'bearer' ? 'Token' : 'Key'} hint="Stored encrypted on this Mac, never shared with the team or kept in history.">
          <input type="password" className={clsx(inputCls, 'w-full font-mono text-[12px]')} placeholder={hasSecret ? 'Saved. Type to replace it.' : ''} value={secret} onChange={(e) => onSecret(e.target.value)} autoComplete="off" />
        </Field>
      )}
    </>
  )
}

export function RequestSettings({ workspaceId, state, onClose, onSaved }: { workspaceId: string; state: ApiState; onClose: () => void; onSaved: (s: ApiState) => void }): React.JSX.Element {
  const [settings, setSettings] = useState<ApiSettings>(state.settings)
  const [secret, setSecret] = useState('')
  const [tab, setTab] = useState<'local' | ApiRemoteEnv>('local')
  const [envs, setEnvs] = useState<Record<ApiRemoteEnv, EnvForm>>({ staging: envFormOf(state, 'staging'), production: envFormOf(state, 'production') })
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    try {
      let next = await api.invoke('api:setSettings', workspaceId, settings, secret ? secret : undefined)
      // Only environments that changed are written: each write updates the team's shared definition.
      for (const env of API_REMOTE_ENVS) {
        const f = envs[env]
        const before = envFormOf(state, env)
        const changed = f.baseUrl.trim() !== before.baseUrl || f.auth.kind !== before.auth.kind || (f.auth.name ?? '') !== (before.auth.name ?? '') || f.secret
        if (!changed) continue
        const def: ApiEnvDef | null = f.baseUrl.trim() ? { baseUrl: f.baseUrl.trim(), auth: f.auth } : null
        next = await api.invoke('api:setEnvironment', workspaceId, env, def, f.secret ? f.secret : undefined)
      }
      onSaved(next)
      onClose()
    } catch (err) {
      setError(friendlyError(err))
    }
  }
  const setEnv = (env: ApiRemoteEnv, patch: Partial<EnvForm>) => setEnvs({ ...envs, [env]: { ...envs[env], ...patch } })
  return (
    <Dialog title="Request settings" onClose={onClose} width={480}>
      <Segmented className="mb-3" value={tab} onChange={setTab} options={[{ id: 'local', label: 'On this Mac' }, { id: 'staging', label: 'Staging' }, { id: 'production', label: 'Production' }]} />
      {tab === 'local' ? (
        <>
          <Field label="Default environment" hint={state.bases.workspace ? `This workspace is ${state.bases.workspace}.` : 'This workspace has no port yet.'}>
            <Segmented value={settings.env} onChange={(env) => setSettings({ ...settings, env })} options={[{ id: 'workspace', label: 'This workspace' }, { id: 'local', label: 'Local' }]} />
          </Field>
          <Field label="Local base URL" hint="Another app on this Mac, e.g. a backend you run outside Sinfonie. Only localhost addresses.">
            <input className={clsx(inputCls, 'w-full font-mono text-[12px]')} placeholder="http://localhost:3001" value={settings.localBase ?? ''} onChange={(e) => setSettings({ ...settings, localBase: e.target.value })} />
          </Field>
          <AuthFields auth={settings.auth} onAuth={(auth) => setSettings({ ...settings, auth })} secret={secret} onSecret={setSecret} hasSecret={Boolean(state.settings.hasSecret)} />
        </>
      ) : (
        <>
          <p className="mb-3 text-[12px] text-muted">
            {ENV_LABEL[tab]} is shared with everyone in this space; your token stays on this Mac. Every request to it is shown in full and confirmed before it is sent. The agent cannot call it.
          </p>
          <Field label={`${ENV_LABEL[tab]} base URL`} hint="Leave empty to remove it for the team.">
            <input className={clsx(inputCls, 'w-full font-mono text-[12px]')} placeholder={tab === 'staging' ? 'https://api.staging.example.com' : 'https://api.example.com'} value={envs[tab].baseUrl} onChange={(e) => setEnv(tab, { baseUrl: e.target.value })} />
          </Field>
          <AuthFields auth={envs[tab].auth} onAuth={(auth) => setEnv(tab, { auth })} secret={envs[tab].secret} onSecret={(s) => setEnv(tab, { secret: s })} hasSecret={Boolean(state.envs[tab]?.hasSecret)} />
        </>
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
        <Button variant="primary" onClick={() => void save()}>
          Save settings
        </Button>
      </div>
    </Dialog>
  )
}
