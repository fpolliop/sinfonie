import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, Database, Play, Square, RefreshCw, History, Copy, Settings as SettingsIcon, Table2, Eye, Key, X } from 'lucide-react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { sql, PostgreSQL, MySQL, type SQLNamespace } from '@codemirror/lang-sql'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Button, Spinner } from './ui'
import type { DbConnection, DbHistoryEntry, DbQueryResult, DbSchema, DbTable } from '@shared/types'

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: 'var(--color-text, #e5e7eb)', fontSize: '12.5px', height: '100%' },
    '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', caretColor: '#fff' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#6b7280', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(124,156,255,0.25)' },
    '.cm-tooltip': { backgroundColor: '#1f2430', border: '1px solid #2a2f3a', color: '#e5e7eb' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'rgba(124,156,255,0.3)' }
  },
  { dark: true }
)

const quoteIdent = (kind: DbConnection['kind'], s: string): string => (kind === 'postgres' ? `"${s.replace(/"/g, '""')}"` : `\`${s.replace(/`/g, '``')}\``)
const cellText = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
const csvEscape = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

/** Data tab: the space's database connections, a schema tree, a SQL editor and a virtualized result grid. */
export function DataPane({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const space = useApp((s) => s.spaces.find((x) => x.id === ws?.spaceId))
  const openSettings = useApp((s) => s.openSettings)
  const setError = useApp((s) => s.setError)
  const spaceId = ws?.spaceId ?? ''
  const connections = useMemo(() => space?.databases ?? [], [space])
  const [connId, setConnId] = useState<string>(() => localStorage.getItem(`sinfonie.db.conn.${spaceId}`) ?? '')
  const conn = connections.find((c) => c.id === connId) ?? connections[0]
  const [schema, setSchema] = useState<DbSchema | null>(null)
  const [schemaBusy, setSchemaBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [result, setResult] = useState<DbQueryResult | null>(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [maxRows, setMaxRows] = useState<number>(() => Number(localStorage.getItem('sinfonie.db.maxRows')) || 500)
  const [history, setHistory] = useState<DbHistoryEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [confirmWrite, setConfirmWrite] = useState<string | null>(null)
  const [cell, setCell] = useState<{ col: string; value: unknown } | null>(null)
  const [treeWidth, setTreeWidth] = useState(240)
  const editorHost = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const langConf = useRef(new Compartment())
  const runRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    if (conn) localStorage.setItem(`sinfonie.db.conn.${spaceId}`, conn.id)
  }, [conn, spaceId])

  const loadSchema = useCallback(
    (refresh = false) => {
      if (!conn) return
      setSchemaBusy(true)
      api
        .invoke('db:schema', spaceId, conn.id, refresh)
        .then(setSchema)
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSchemaBusy(false))
    },
    [conn, spaceId, setError]
  )
  useEffect(() => {
    setSchema(null)
    setResult(null)
    setRunError(null)
    loadSchema(false)
    if (conn) api.invoke('db:history', conn.id).then(setHistory).catch(() => undefined)
  }, [conn?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => api.on('db:history', ({ connectionId }) => conn && connectionId === conn.id && api.invoke('db:history', conn.id).then(setHistory).catch(() => undefined)), [conn])

  // Editor: one instance, dialect and schema swapped through a compartment.
  const langExt = useCallback(() => {
    const ns: SQLNamespace = {}
    for (const t of schema?.tables ?? []) {
      const cols = (t.columns ?? []).map((c) => c.name)
      ns[`${t.schema}.${t.name}`] = cols
      if (t.schema === 'public' || conn?.kind === 'mysql') ns[t.name] = cols
    }
    return sql({ dialect: conn?.kind === 'mysql' ? MySQL : PostgreSQL, schema: ns, upperCaseKeywords: true })
  }, [schema, conn?.kind])
  useEffect(() => {
    if (!editorHost.current || view.current) return
    const saved = localStorage.getItem(`sinfonie.db.sql.${spaceId}`) ?? ''
    view.current = new EditorView({
      state: EditorState.create({
        doc: saved,
        extensions: [
          keymap.of([{ key: 'Mod-Enter', run: () => (runRef.current(), true) }]),
          basicSetup,
          langConf.current.of(langExt()),
          theme,
          EditorView.updateListener.of((u) => u.docChanged && localStorage.setItem(`sinfonie.db.sql.${spaceId}`, u.state.doc.toString()))
        ]
      }),
      parent: editorHost.current
    })
    return () => {
      view.current?.destroy()
      view.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    view.current?.dispatch({ effects: langConf.current.reconfigure(langExt()) })
  }, [langExt])

  const setSql = (text: string): void => {
    const v = view.current
    if (!v) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
    v.focus()
  }
  const currentSql = (): string => {
    const v = view.current
    if (!v) return ''
    const sel = v.state.selection.main
    return sel.empty ? v.state.doc.toString() : v.state.sliceDoc(sel.from, sel.to)
  }
  const execute = async (text: string, allowWrite = false): Promise<void> => {
    if (!conn || running) return
    setRunning(true)
    setRunError(null)
    setCell(null)
    try {
      setResult(await api.invoke('db:query', spaceId, conn.id, text, { maxRows, allowWrite }))
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }
  const run = async (): Promise<void> => {
    const text = currentSql().trim()
    if (!text || !conn) return
    const cls = await api.invoke('db:classify', text).catch(() => ({ readOnly: true, statements: 1, first: '' }))
    if (!cls.readOnly && conn.allowWrites) {
      setConfirmWrite(text)
      return
    }
    void execute(text)
  }
  runRef.current = () => void run()
  const cancel = (): void => {
    if (conn) api.invoke('db:cancel', spaceId, conn.id).catch((err) => setError(String(err)))
  }
  const copy = (fmt: 'csv' | 'json'): void => {
    if (!result) return
    const text = fmt === 'json' ? JSON.stringify(result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c.name, r[i]]))), null, 2) : [result.columns.map((c) => csvEscape(c.name)).join(','), ...result.rows.map((r) => r.map((v) => csvEscape(cellText(v))).join(','))].join('\n')
    void navigator.clipboard.writeText(text)
  }
  const preview = (t: DbTable): void => {
    if (!conn) return
    const q = `SELECT * FROM ${quoteIdent(conn.kind, t.schema)}.${quoteIdent(conn.kind, t.name)} LIMIT 100`
    setSql(q)
    void execute(q)
  }

  // Tree
  const bySchema = useMemo(() => {
    const groups = new Map<string, DbTable[]>()
    const f = filter.trim().toLowerCase()
    for (const t of schema?.tables ?? []) {
      if (f && !`${t.schema}.${t.name}`.toLowerCase().includes(f) && !(t.columns ?? []).some((c) => c.name.toLowerCase().includes(f))) continue
      const list = groups.get(t.schema) ?? []
      list.push(t)
      groups.set(t.schema, list)
    }
    return Array.from(groups.entries()).sort(([a], [b]) => (a === 'public' ? -1 : b === 'public' ? 1 : a.localeCompare(b)))
  }, [schema, filter])
  const startResize = (e: React.MouseEvent): void => {
    const x0 = e.clientX
    const w0 = treeWidth
    const move = (ev: MouseEvent): void => setTreeWidth(Math.min(480, Math.max(160, w0 + ev.clientX - x0)))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  if (!ws) return <div />
  if (!connections.length)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-[13px] text-muted">
        <Database size={28} className="text-muted/60" />
        <div>No database connections in {space?.name ?? 'this space'} yet.</div>
        <Button onClick={() => spaceId && openSettings({ scope: 'space', spaceId, page: 'databases' })}>
          <SettingsIcon size={13} /> Add a connection
        </Button>
      </div>
    )
  return (
    <div className="flex h-full min-h-0 text-[12px]">
      {/* schema tree */}
      <div className="relative flex shrink-0 flex-col border-r border-border" style={{ width: treeWidth }}>
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <select className="min-w-0 flex-1 rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={conn?.id ?? ''} onChange={(e) => setConnId(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.kind}
              </option>
            ))}
          </select>
          <button className="rounded p-1 text-muted hover:bg-panel-2 hover:text-text" title="Reload schema" onClick={() => loadSchema(true)}>
            <RefreshCw size={12} className={schemaBusy ? 'animate-spin' : ''} />
          </button>
          <button className="rounded p-1 text-muted hover:bg-panel-2 hover:text-text" title="Manage connections" onClick={() => openSettings({ scope: 'space', spaceId, page: 'databases' })}>
            <SettingsIcon size={12} />
          </button>
        </div>
        <input className="mx-2 my-1.5 rounded-md border border-border bg-bg px-2 py-1 text-[12px] outline-none focus:border-accent" placeholder="Filter tables and columns" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
          {schemaBusy && !schema && (
            <div className="flex items-center gap-2 px-2 py-2 text-muted">
              <Spinner /> Reading schema…
            </div>
          )}
          {schema && !schema.tables.length && <div className="px-2 py-2 text-muted">No tables visible to this user.</div>}
          {bySchema.map(([schemaName, tables]) => (
            <div key={schemaName}>
              <div className="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
                {schemaName} <span className="font-normal">· {tables.length}</span>
              </div>
              {tables.map((t) => {
                const key = `${t.schema}.${t.name}`
                const isOpen = open[key] || Boolean(filter)
                return (
                  <div key={key}>
                    <div className="group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-panel-2">
                      <button className="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
                        <ChevronRight size={11} className={clsx('shrink-0 text-muted transition-transform', isOpen && 'rotate-90')} />
                        {t.kind === 'view' ? <Eye size={11} className="shrink-0 text-muted" /> : <Table2 size={11} className="shrink-0 text-muted" />}
                        <span className={clsx('truncate', t.readable === false && 'text-muted line-through decoration-muted/60')} title={t.readable === false ? 'This user has no SELECT privilege on it' : undefined}>
                          {t.name}
                        </span>
                        {t.rows !== undefined && <span className="ml-auto shrink-0 pl-1 text-[10px] text-muted">{t.rows >= 1_000_000 ? `${(t.rows / 1_000_000).toFixed(1)}M` : t.rows >= 1000 ? `${Math.round(t.rows / 1000)}k` : t.rows}</span>}
                      </button>
                      <button className="hidden rounded p-0.5 text-muted hover:text-text group-hover:block" title="SELECT * … LIMIT 100" onClick={() => preview(t)}>
                        <Play size={10} />
                      </button>
                    </div>
                    {isOpen &&
                      (t.columns ?? []).map((c) => (
                        <div key={c.name} className="flex items-center gap-1 rounded py-0.5 pl-7 pr-2 text-[11px] hover:bg-panel-2" title={`${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default ? ` default ${c.default}` : ''}`} onClick={() => view.current?.dispatch({ changes: { from: view.current.state.selection.main.head, insert: c.name }, selection: { anchor: view.current.state.selection.main.head + c.name.length } })}>
                          {c.pk ? <Key size={9} className="shrink-0 text-warn" /> : <span className="w-[9px] shrink-0" />}
                          <span className="truncate">{c.name}</span>
                          <span className="ml-auto shrink-0 pl-1 font-mono text-[10px] text-muted">{c.type}</span>
                        </div>
                      ))}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div onMouseDown={startResize} className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40" />
      </div>
      {/* editor + results */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
          {running ? (
            <Button size="sm" variant="danger" onClick={cancel}>
              <Square size={12} /> Cancel
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void run()} title="Run the query, or the selection (⌘↩)">
              <Play size={12} /> Run
            </Button>
          )}
          <select
            className="rounded-md border border-border bg-bg px-1.5 py-1 text-[11px]"
            value={maxRows}
            onChange={(e) => {
              setMaxRows(Number(e.target.value))
              localStorage.setItem('sinfonie.db.maxRows', e.target.value)
            }}
            title="Rows kept from the result"
          >
            {[100, 500, 2000, 5000].map((n) => (
              <option key={n} value={n}>
                {n} rows
              </option>
            ))}
          </select>
          <div className="relative">
            <Button size="sm" variant="ghost" onClick={() => setShowHistory((v) => !v)} title="Query history">
              <History size={12} /> History
            </Button>
            {showHistory && (
              <div className="absolute left-0 top-full z-20 mt-1 max-h-72 w-[520px] overflow-auto rounded-md border border-border bg-panel p-1 shadow-xl">
                {history.length === 0 && <div className="px-2 py-1.5 text-muted">Nothing yet.</div>}
                {history.slice(0, 40).map((h, i) => (
                  <button
                    key={i}
                    className="block w-full rounded px-2 py-1 text-left hover:bg-panel-2"
                    onClick={() => {
                      setSql(h.sql)
                      setShowHistory(false)
                    }}
                  >
                    <div className="truncate font-mono text-[11px]">{h.sql.replace(/\s+/g, ' ')}</div>
                    <div className="text-[10px] text-muted">
                      {new Date(h.at).toLocaleString()} · {h.error ? <span className="text-danger">{h.error.slice(0, 80)}</span> : `${h.rowCount ?? 0} rows · ${h.ms} ms`}
                      {h.source === 'agent' ? ' · agent' : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
            {conn?.allowWrites ? <span className="rounded bg-warn/15 px-1 py-px text-[10px] uppercase tracking-wide text-warn">writes allowed</span> : <span className="rounded bg-ok/15 px-1 py-px text-[10px] uppercase tracking-wide text-ok">read-only</span>}
            {result && (
              <>
                <Button size="sm" variant="ghost" onClick={() => copy('csv')} title="Copy result as CSV">
                  <Copy size={11} /> CSV
                </Button>
                <Button size="sm" variant="ghost" onClick={() => copy('json')} title="Copy result as JSON">
                  <Copy size={11} /> JSON
                </Button>
              </>
            )}
          </span>
        </div>
        <div ref={editorHost} className="h-[180px] shrink-0 overflow-hidden border-b border-border" />
        {confirmWrite && (
          <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-[12px]">
            This statement writes to {conn?.database}. Run it?
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                const t = confirmWrite
                setConfirmWrite(null)
                void execute(t, true)
              }}
            >
              Run write
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmWrite(null)}>
              Cancel
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-[11px] text-muted">
          {running ? (
            <>
              <Spinner /> Running…
            </>
          ) : runError ? (
            <span className="text-danger">{runError}</span>
          ) : result ? (
            <>
              <span>
                {result.columns.length ? `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}${result.truncated ? `, showing ${result.rows.length}` : ''}` : (result.command ?? 'OK')}
                {result.affected !== undefined ? ` · ${result.affected} affected` : ''}
              </span>
              <span>· {result.ms} ms</span>
              {!result.readOnly && <span className="text-warn">· write</span>}
            </>
          ) : (
            <span>⌘↩ runs the query or the selection. Click a table to preview it.</span>
          )}
        </div>
        <div className="min-h-0 flex-1">{result && result.columns.length > 0 ? <Grid result={result} onCell={setCell} /> : null}</div>
        {cell && (
          <div className="max-h-[35%] shrink-0 overflow-auto border-t border-border bg-bg px-3 py-2">
            <div className="mb-1 flex items-center text-[11px] text-muted">
              <span className="font-mono">{cell.col}</span>
              <button className="ml-auto rounded p-0.5 hover:text-text" onClick={() => setCell(null)}>
                <X size={12} />
              </button>
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">{cell.value === null || cell.value === undefined ? 'NULL' : typeof cell.value === 'object' ? JSON.stringify(cell.value, null, 2) : String(cell.value)}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

function Grid({ result, onCell }: { result: DbQueryResult; onCell: (c: { col: string; value: unknown }) => void }): React.JSX.Element {
  const parent = useRef<HTMLDivElement>(null)
  const rowVirt = useVirtualizer({ count: result.rows.length, getScrollElement: () => parent.current, estimateSize: () => 26, overscan: 12 })
  const widths = useMemo(() => result.columns.map((c, i) => Math.min(360, Math.max(80, 8 * Math.max(c.name.length, ...result.rows.slice(0, 50).map((r) => Math.min(45, cellText(r[i]).length)))))), [result])
  const total = widths.reduce((a, b) => a + b, 0) + 48
  return (
    <div ref={parent} className="h-full overflow-auto font-mono text-[11px]">
      <div style={{ width: total, minWidth: '100%' }}>
        <div className="sticky top-0 z-10 flex border-b border-border bg-panel">
          <div className="w-12 shrink-0 border-r border-border px-1 py-1 text-right text-muted">#</div>
          {result.columns.map((c, i) => (
            <div key={i} className="shrink-0 truncate border-r border-border px-2 py-1 font-semibold" style={{ width: widths[i] }} title={c.type}>
              {c.name} <span className="font-normal text-muted">{c.type}</span>
            </div>
          ))}
        </div>
        <div style={{ height: rowVirt.getTotalSize(), position: 'relative' }}>
          {rowVirt.getVirtualItems().map((v) => {
            const row = result.rows[v.index]
            return (
              <div key={v.key} className="absolute left-0 flex w-full border-b border-border/60 hover:bg-panel-2" style={{ top: v.start, height: v.size }}>
                <div className="w-12 shrink-0 border-r border-border px-1 py-1 text-right text-muted">{v.index + 1}</div>
                {row.map((val, i) => (
                  <div key={i} className={clsx('shrink-0 cursor-default truncate border-r border-border/60 px-2 py-1', val === null && 'italic text-muted')} style={{ width: widths[i] }} onClick={() => onCell({ col: result.columns[i].name, value: val })}>
                    {val === null ? 'NULL' : cellText(val)}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
