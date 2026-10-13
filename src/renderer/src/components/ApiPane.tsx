/**
 * API explorer, phase 1 (feedback #42): the workspace's HTTP endpoints, found without a collection.
 * Grouped by repository, service and controller; filter by method, path or name; copy a request
 * as curl or open the file that defines it. Sending requests comes in phase 2.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Copy, ExternalLink, RefreshCw, Search } from 'lucide-react'
import type { ApiDiscovery, ApiEndpoint } from '@shared/types'
import { api } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { timeAgo } from '@/lib/format'
import { useApp } from '@/stores/app'
import { Button, IconButton, Spinner, inputCls } from './ui'

const METHOD_TONE: Record<string, string> = {
  GET: 'bg-accent/15 text-accent',
  POST: 'bg-ok/15 text-ok',
  PUT: 'bg-warn/15 text-warn',
  PATCH: 'bg-warn/15 text-warn',
  DELETE: 'bg-danger/15 text-danger'
}
const SOURCE_LABEL: Record<ApiEndpoint['source'], string> = { openapi: 'OpenAPI file', running: 'running app', nestjs: 'NestJS', nextjs: 'Next.js', fastapi: 'FastAPI', express: 'Express' }

function curlFor(e: ApiEndpoint, port: number): string {
  const url = `http://localhost:${port}${e.path.replace(/:(\w+)/g, '{$1}')}`
  const method = e.method === 'ANY' ? 'GET' : e.method
  return `curl -X ${method} '${url}'${e.hasBody || ['POST', 'PUT', 'PATCH'].includes(method) ? ` -H 'Content-Type: application/json' -d '{}'` : ''}`
}

export function ApiPane({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const notify = useApp((s) => s.notify)
  const [data, setData] = useState<ApiDiscovery | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const load = useCallback(
    (force: boolean) => {
      setLoading(true)
      setError(null)
      void api
        .invoke('api:discover', workspaceId, force)
        .then(setData)
        .catch((err) => setError(friendlyError(err)))
        .finally(() => setLoading(false))
    },
    [workspaceId]
  )
  useEffect(() => load(false), [load])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = data?.endpoints ?? []
    if (!needle) return list
    return list.filter((e) => `${e.method} ${e.path} ${e.summary ?? ''} ${e.group ?? ''} ${e.service}`.toLowerCase().includes(needle))
  }, [data, q])

  // repo → service → group
  const tree = useMemo(() => {
    const out = new Map<string, Map<string, Map<string, ApiEndpoint[]>>>()
    for (const e of shown) {
      const r = out.get(e.repoName) ?? new Map<string, Map<string, ApiEndpoint[]>>()
      const svc = r.get(e.service) ?? new Map<string, ApiEndpoint[]>()
      const g = e.group || (e.file ? e.file.split('/').slice(-1)[0] : 'Other')
      svc.set(g, [...(svc.get(g) ?? []), e])
      r.set(e.service, svc)
      out.set(e.repoName, r)
    }
    return out
  }, [shown])

  const copy = (e: ApiEndpoint): void => {
    void navigator.clipboard.writeText(curlFor(e, data?.port ?? 3000)).then(() => notify({ kind: 'success', text: `Copied curl for ${e.method} ${e.path}` }))
  }
  const openFile = (e: ApiEndpoint): void => {
    if (e.file) void api.invoke('fs:open', workspaceId, e.file).catch((err) => setError(friendlyError(err)))
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">API</span>
        {data && <span className="text-[11px] text-muted">· {data.endpoints.length} endpoints · scanned {timeAgo(data.scannedAt)}</span>}
        <span className="ml-auto" />
        <label className="relative flex items-center">
          <Search size={12} className="pointer-events-none absolute left-2 text-muted" aria-hidden />
          <input className={clsx(inputCls, 'h-[26px] w-48 py-0 pl-6 text-[12px]')} placeholder="Filter: GET /orders, login" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter endpoints" />
        </label>
        <Button size="sm" variant="ghost" onClick={() => load(true)} disabled={loading}>
          <RefreshCw size={13} className={clsx(loading && 'animate-spin')} aria-hidden /> Rescan
        </Button>
      </div>
      {error && (
        <div role="alert" className="border-b border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!data && loading && (
          <div className="flex items-center gap-2 py-10 text-[12px] text-muted">
            <Spinner /> Looking for endpoints: OpenAPI files, the running app, NestJS, Next.js, FastAPI and Express routes…
          </div>
        )}
        {data && data.endpoints.length === 0 && (
          <div className="py-10 text-center text-[12px] text-muted">No endpoints found. Sinfonie looks for OpenAPI files, the running app's spec, NestJS controllers, Next.js route handlers, FastAPI and Express or Fastify routes.</div>
        )}
        {data &&
          Array.from(tree.entries()).map(([repoName, services]) => {
            const info = data.repos.find((r) => r.repoName === repoName)
            return (
              <section key={repoName} className="mb-4">
                <h3 className="mb-1 flex flex-wrap items-baseline gap-x-2 text-[12px] font-semibold">
                  {repoName}
                  <span className="text-[11px] font-normal text-muted">
                    {info?.sources.map((s) => SOURCE_LABEL[s]).join(', ')}
                    {info?.runningDoc ? ` · live spec from ${info.runningDoc.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}` : ''}
                  </span>
                </h3>
                {Array.from(services.entries()).map(([service, groups]) => (
                  <details key={service || '.'} open={shown.length < 200 || Boolean(q)} className="mb-1.5 rounded-lg border border-border bg-panel">
                    <summary className="cursor-pointer select-none px-3 py-1.5 text-[12px] font-medium">
                      {service || 'repository root'} <span className="font-normal text-muted">· {Array.from(groups.values()).reduce((n, l) => n + l.length, 0)}</span>
                    </summary>
                    {Array.from(groups.entries()).map(([group, list]) => (
                      <div key={group} className="border-t border-border">
                        <div className="px-3 pt-1.5 text-[11px] font-medium text-muted">{group}</div>
                        <ul>
                          {list.map((e) => (
                            <li key={e.id} className="group flex items-center gap-2 px-3 py-1 hover:bg-panel-2">
                              <span className={clsx('w-14 shrink-0 rounded px-1 text-center font-mono text-[11px] font-semibold', METHOD_TONE[e.method] ?? 'bg-panel-2 text-muted')}>{e.method}</span>
                              <code className="min-w-0 flex-1 truncate text-[12px]" title={e.path}>
                                {e.path}
                              </code>
                              {e.summary && <span className="hidden max-w-[40%] truncate text-[11px] text-muted @md:inline">{e.summary}</span>}
                              <span className="shrink-0 text-[11px] text-muted">{SOURCE_LABEL[e.source]}</span>
                              <IconButton label={`Copy curl for ${e.method} ${e.path}`} className="reveal-on-focus opacity-0 group-hover:opacity-100" onClick={() => copy(e)}>
                                <Copy size={12} />
                              </IconButton>
                              {e.file && (
                                <IconButton label={`Open ${e.file.split('/').slice(-1)[0]}${e.line ? ` at line ${e.line}` : ''}`} className="reveal-on-focus opacity-0 group-hover:opacity-100" onClick={() => openFile(e)}>
                                  <ExternalLink size={12} />
                                </IconButton>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </details>
                ))}
              </section>
            )
          })}
      </div>
    </div>
  )
}
