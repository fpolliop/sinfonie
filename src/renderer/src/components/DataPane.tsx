import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, Database, Play, Square, RefreshCw, History, Copy, Settings as SettingsIcon, Table2, Eye, Key, X, Plus, Link2, Upload, Download, Network, FileSearch, Pencil } from 'lucide-react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { sql, PostgreSQL, MySQL, SQLite, StandardSQL, type SQLNamespace } from '@codemirror/lang-sql'
import { json } from '@codemirror/lang-json'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Button, Spinner } from './ui'
import { ErdView } from './ErdView'
import { ImportCsvDialog } from './ImportCsvDialog'
import { InlineRename } from './InlineRename'
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

interface QueryTab {
  id: string
  title: string
  sql: string
}
export const cellText = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
const csvEscape = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
const quoteIdent = (kind: DbConnection['kind'], s: string): string => (kind === 'mysql' || kind === 'bigquery' ? `\`${s.replace(/`/g, '``')}\`` : `"${s.replace(/"/g, '""')}"`)
export function previewSql(conn: DbConnection, t: DbTable): string {
  switch (conn.kind) {
    case 'mongodb':
      return JSON.stringify({ collection: t.name, find: {}, sort: { _id: -1 }, limit: 100 }, null, 2)
    case 'sqlite':
      return `SELECT * FROM ${quoteIdent('sqlite', t.name)} LIMIT 100`
    case 'bigquery':
      return `SELECT * FROM \`${conn.projectId ?? ''}.${t.schema}.${t.name}\` LIMIT 100`
    default:
      return `SELECT * FROM ${quoteIdent(conn.kind, t.schema)}.${quoteIdent(conn.kind, t.name)} LIMIT 100`
  }
}
const fmtRows = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** Data tab: the space's database connections, a schema tree with foreign keys, tabbed SQL / Mongo editors, an editable result grid, ERD, import and export. */
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
  const [tabs, setTabs] = useState<QueryTab[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [renamingTab, setRenamingTab] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, DbQueryResult>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const [maxRows, setMaxRows] = useState<number>(() => Number(localStorage.getItem('sinfonie.db.maxRows')) || 500)
  const [history, setHistory] = useState<DbHistoryEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [confirmWrite, setConfirmWrite] = useState<string | null>(null)
  const [panel, setPanel] = useState<{ title: string; text: string } | null>(null)
  const [view, setView] = useState<'query' | 'diagram'>('query')
  const [importFor, setImportFor] = useState<DbTable | null>(null)
  const [pendingEdit, setPendingEdit] = useState<{ tabId: string; rowIndex: number; colIndex: number; value: unknown; preview: string; req: { table: { schema: string; name: string }; pk: Record<string, unknown>; set: Record<string, unknown> } } | null>(null)
  const [treeWidth, setTreeWidth] = useState(240)
  const [notice, setNotice] = useState<string | null>(null)
  const editorHost = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langConf = useRef(new Compartment())
  const runRef = useRef<() => void>(() => undefined)
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const active = tabs.find((t) => t.id === activeId)
  const result = active ? results[active.id] : undefined
  const runError = active ? errors[active.id] : undefined

  useEffect(() => {
    if (conn) localStorage.setItem(`sinfonie.db.conn.${spaceId}`, conn.id)
  }, [conn, spaceId])

  // ---- tabs, persisted per connection ----
  const tabsKey = conn ? `sinfonie.db.tabs.${conn.id}` : ''
  useEffect(() => {
    if (!conn) return
    let saved: QueryTab[] = []
    try {
      saved = JSON.parse(localStorage.getItem(tabsKey) ?? '[]') as QueryTab[]
    } catch {
      saved = []
    }
    if (!saved.length) saved = [{ id: Math.random().toString(36).slice(2, 8), title: 'Query 1', sql: '' }]
    setTabs(saved)
    setActiveId(localStorage.getItem(`${tabsKey}.active`) ?? saved[0].id)
    setResults({})
    setErrors({})
    setPanel(null)
  }, [conn?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tabsKey && tabs.length) localStorage.setItem(tabsKey, JSON.stringify(tabs))
  }, [tabs, tabsKey])
  useEffect(() => {
    if (tabsKey && activeId) localStorage.setItem(`${tabsKey}.active`, activeId)
  }, [activeId, tabsKey])
  const newTab = (sqlText = ''): void => {
    const t: QueryTab = { id: Math.random().toString(36).slice(2, 8), title: `Query ${tabs.length + 1}`, sql: sqlText }
    setTabs((list) => [...list, t])
    setActiveId(t.id)
  }
  const closeTab = (id: string): void => {
    setTabs((list) => {
      const next = list.filter((t) => t.id !== id)
      if (!next.length) next.push({ id: Math.random().toString(36).slice(2, 8), title: 'Query 1', sql: '' })
      if (activeRef.current === id) setActiveId(next[Math.max(0, list.findIndex((t) => t.id === id) - 1)]?.id ?? next[0].id)
      return next
    })
  }

  // ---- schema + history ----
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
    loadSchema(false)
    if (conn) api.invoke('db:history', conn.id).then(setHistory).catch(() => undefined)
  }, [conn?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => api.on('db:history', ({ connectionId }) => conn && connectionId === conn.id && api.invoke('db:history', conn.id).then(setHistory).catch(() => undefined)), [conn])

  // ---- editor: one instance; language and doc swap ----
  const langExt = useCallback(() => {
    if (conn?.kind === 'mongodb') return json()
    const ns: SQLNamespace = {}
    for (const t of schema?.tables ?? []) {
      const cols = (t.columns ?? []).map((c) => c.name)
      ns[`${t.schema}.${t.name}`] = cols
      if (t.schema === 'public' || t.schema === 'main' || conn?.kind === 'mysql') ns[t.name] = cols
    }
    const dialect = conn?.kind === 'mysql' ? MySQL : conn?.kind === 'sqlite' ? SQLite : conn?.kind === 'bigquery' ? StandardSQL : PostgreSQL
    return sql({ dialect, schema: ns, upperCaseKeywords: true })
  }, [schema, conn?.kind])
  useEffect(() => {
    if (!editorHost.current || viewRef.current) return
    viewRef.current = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          keymap.of([{ key: 'Mod-Enter', run: () => (runRef.current(), true) }]),
          basicSetup,
          langConf.current.of(langExt()),
          theme,
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            const text = u.state.doc.toString()
            setTabs((list) => list.map((t) => (t.id === activeRef.current ? { ...t, sql: text } : t)))
          })
        ]
      }),
      parent: editorHost.current
    })
    return () => {
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    viewRef.current?.dispatch({ effects: langConf.current.reconfigure(langExt()) })
  }, [langExt])
  // Swap the document when the active tab changes.
  useEffect(() => {
    const v = viewRef.current
    if (!v || !active) return
    if (v.state.doc.toString() !== active.sql) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: active.sql } })
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const setSql = (text: string): void => {
    const v = viewRef.current
    if (!v) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
    v.focus()
  }
  const currentSql = (): string => {
    const v = viewRef.current
    if (!v) return ''
    const sel = v.state.selection.main
    return sel.empty ? v.state.doc.toString() : v.state.sliceDoc(sel.from, sel.to)
  }
  const execute = async (text: string, allowWrite = false, tabId = activeId): Promise<void> => {
    if (!conn || running) return
    setRunning(true)
    setErrors((e) => ({ ...e, [tabId]: '' }))
    setPanel(null)
    setPendingEdit(null)
    try {
      const r = await api.invoke('db:query', spaceId, conn.id, text, { maxRows, allowWrite })
      setResults((m) => ({ ...m, [tabId]: r }))
      if (!r.readOnly) loadSchema(true)
    } catch (err) {
      setErrors((e) => ({ ...e, [tabId]: err instanceof Error ? err.message : String(err) }))
    } finally {
      setRunning(false)
    }
  }
  const run = async (): Promise<void> => {
    const text = currentSql().trim()
    if (!text || !conn) return
    const cls = await api.invoke('db:classify', spaceId, conn.id, text).catch(() => ({ readOnly: true, statements: 1, first: '' }))
    if (!cls.readOnly && conn.allowWrites) {
      setConfirmWrite(text)
      return
    }
    void execute(text)
  }
  runRef.current = () => void run()
  const explain = async (): Promise<void> => {
    const text = currentSql().trim()
    if (!text || !conn) return
    try {
      setPanel({ title: 'Explain', text: await api.invoke('db:explain', spaceId, conn.id, text) })
    } catch (err) {
      setPanel({ title: 'Explain', text: err instanceof Error ? err.message : String(err) })
    }
  }
  const cancel = (): void => {
    if (conn) api.invoke('db:cancel', spaceId, conn.id).then((m) => setNotice(m)).catch((err) => setError(String(err)))
  }
  const copy = (fmt: 'csv' | 'json'): void => {
    if (!result) return
    const text = fmt === 'json' ? JSON.stringify(result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c.name, r[i]]))), null, 2) : [result.columns.map((c) => csvEscape(c.name)).join(','), ...result.rows.map((r) => r.map((v) => csvEscape(cellText(v))).join(','))].join('\n')
    void navigator.clipboard.writeText(text)
    setNotice(`Copied ${result.rows.length} rows as ${fmt.toUpperCase()}.`)
    setShowExport(false)
  }
  const exportFile = async (fmt: 'csv' | 'json'): Promise<void> => {
    if (!conn || !active?.sql.trim()) return
    setShowExport(false)
    try {
      const r = await api.invoke('db:export', spaceId, conn.id, currentSql().trim(), fmt)
      if (r) setNotice(`Exported ${r.rows} rows to ${r.path}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const preview = (t: DbTable): void => {
    if (!conn) return
    const q = previewSql(conn, t)
    setView('query')
    setSql(q)
    void execute(q)
  }
  useEffect(() => {
    if (!notice) return
    const h = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(h)
  }, [notice])

  // ---- editing: SELECT from one table whose primary key is in the result ----
  const editable = useMemo(() => {
    if (!conn?.allowWrites || !result || !schema || !active) return null
    let table: DbTable | undefined
    if (conn.kind === 'mongodb') {
      try {
        const cmd = JSON.parse(active.sql) as { collection?: string; find?: unknown }
        if (cmd.collection && cmd.find !== undefined) table = schema.tables.find((t) => t.name === cmd.collection)
      } catch {
        return null
      }
    } else {
      const m = active.sql.replace(/\s+/g, ' ').match(/^\s*select\b(?![\s\S]*\b(join|union|group by|distinct)\b)[\s\S]*?\bfrom\s+([`"\w.]+)/i)
      if (!m) return null
      const parts = m[2].split('.').map((p) => p.replace(/^[`"]|[`"]$/g, ''))
      const name = parts[parts.length - 1]
      const sch = parts.length >= 2 ? parts[parts.length - 2] : undefined
      table = schema.tables.find((t) => t.name === name && (!sch || t.schema === sch)) ?? (parts.length === 1 ? schema.tables.find((t) => t.name === name) : undefined)
    }
    if (!table) return null
    const pk = (table.columns ?? []).filter((c) => c.pk).map((c) => c.name)
    if (!pk.length || !pk.every((k) => result.columns.some((c) => c.name === k))) return null
    return { table, pk }
  }, [conn, result, schema, active])
  const startEdit = async (rowIndex: number, colIndex: number, value: unknown): Promise<void> => {
    if (!editable || !result || !conn || !active) return
    const col = result.columns[colIndex].name
    if (editable.pk.includes(col)) return setNotice('Primary key columns are not edited here.')
    const row = result.rows[rowIndex]
    const pk = Object.fromEntries(editable.pk.map((k) => [k, row[result.columns.findIndex((c) => c.name === k)]]))
    const req = { table: { schema: editable.table.schema, name: editable.table.name }, pk, set: { [col]: value } }
    const previewText = await api.invoke('db:updatePreview', spaceId, conn.id, req).catch(() => JSON.stringify(req))
    setPendingEdit({ tabId: active.id, rowIndex, colIndex, value, preview: previewText, req })
  }
  const applyEdit = async (): Promise<void> => {
    if (!pendingEdit || !conn) return
    const e = pendingEdit
    setPendingEdit(null)
    try {
      const r = await api.invoke('db:update', spaceId, conn.id, e.req)
      setResults((m) => {
        const cur = m[e.tabId]
        if (!cur) return m
        const rows = cur.rows.map((row, i) => (i === e.rowIndex ? row.map((v, j) => (j === e.colIndex ? e.value : v)) : row))
        return { ...m, [e.tabId]: { ...cur, rows } }
      })
      setNotice(`${r.affected} row${r.affected === 1 ? '' : 's'} updated.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // ---- tree ----
  const bySchema = useMemo(() => {
    const groups = new Map<string, DbTable[]>()
    const f = filter.trim().toLowerCase()
    for (const t of schema?.tables ?? []) {
      if (f && !`${t.schema}.${t.name}`.toLowerCase().includes(f) && !(t.columns ?? []).some((c) => c.name.toLowerCase().includes(f))) continue
      const list = groups.get(t.schema) ?? []
      list.push(t)
      groups.set(t.schema, list)
    }
    return Array.from(groups.entries()).sort(([a], [b]) => (a === 'public' || a === 'main' ? -1 : b === 'public' || b === 'main' ? 1 : a.localeCompare(b)))
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
  const isMongo = conn?.kind === 'mongodb'
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
          <button className={clsx('rounded p-1 hover:bg-panel-2 hover:text-text', view === 'diagram' ? 'text-accent' : 'text-muted')} title="Entity relationship diagram" onClick={() => setView(view === 'diagram' ? 'query' : 'diagram')}>
            <Network size={12} />
          </button>
          <button className="rounded p-1 text-muted hover:bg-panel-2 hover:text-text" title="Manage connections" onClick={() => openSettings({ scope: 'space', spaceId, page: 'databases' })}>
            <SettingsIcon size={12} />
          </button>
        </div>
        <input className="mx-2 my-1.5 rounded-md border border-border bg-bg px-2 py-1 text-[12px] outline-none focus:border-accent" placeholder={isMongo ? 'Filter collections and fields' : 'Filter tables and columns'} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
          {schemaBusy && !schema && (
            <div className="flex items-center gap-2 px-2 py-2 text-muted">
              <Spinner /> Reading schema…
            </div>
          )}
          {schema && !schema.tables.length && <div className="px-2 py-2 text-muted">Nothing visible to this user.</div>}
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
                        {t.rows !== undefined && <span className="ml-auto shrink-0 pl-1 text-[10px] text-muted">{fmtRows(t.rows)}</span>}
                      </button>
                      {conn?.allowWrites && t.kind === 'table' && (
                        <button className="hidden rounded p-0.5 text-muted hover:text-text group-hover:block" title="Import a CSV into this table" onClick={() => setImportFor(t)}>
                          <Upload size={10} />
                        </button>
                      )}
                      <button className="hidden rounded p-0.5 text-muted hover:text-text group-hover:block" title="Preview: first 100 rows" onClick={() => preview(t)}>
                        <Play size={10} />
                      </button>
                    </div>
                    {isOpen &&
                      (t.columns ?? []).map((c) => (
                        <div key={c.name} className="flex items-center gap-1 rounded py-0.5 pl-7 pr-2 text-[11px] hover:bg-panel-2" title={`${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default ? ` default ${c.default}` : ''}${c.fk ? `\n→ ${c.fk.table}.${c.fk.column}` : ''}`} onClick={() => viewRef.current?.dispatch({ changes: { from: viewRef.current.state.selection.main.head, insert: c.name }, selection: { anchor: viewRef.current.state.selection.main.head + c.name.length } })}>
                          {c.pk ? <Key size={9} className="shrink-0 text-warn" /> : c.fk ? <Link2 size={9} className="shrink-0 text-accent" /> : <span className="w-[9px] shrink-0" />}
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
      {/* right side */}
      <div className="flex min-w-0 flex-1 flex-col">
        {view === 'diagram' && conn && schema ? (
          <ErdView schema={schema} kind={conn.kind} onPreview={preview} onClose={() => setView('query')} />
        ) : (
          <>
            {/* tabs */}
            <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border px-1 pt-1">
              {tabs.map((t) => (
                <div key={t.id} className={clsx('group flex shrink-0 items-center gap-1 rounded-t-md px-2 py-1 text-[11px]', t.id === activeId ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
                  {renamingTab === t.id ? (
                    <InlineRename
                      value={t.title}
                      className="text-[11px]"
                      onSave={(v) => {
                        setRenamingTab(null)
                        if (v.trim()) setTabs((list) => list.map((x) => (x.id === t.id ? { ...x, title: v.trim() } : x)))
                      }}
                      onCancel={() => setRenamingTab(null)}
                    />
                  ) : (
                    <button onClick={() => setActiveId(t.id)} onDoubleClick={() => setRenamingTab(t.id)} title="Double-click to rename">
                      {t.title}
                    </button>
                  )}
                  <button className="rounded p-0.5 text-muted opacity-0 hover:text-text group-hover:opacity-100" onClick={() => closeTab(t.id)}>
                    <X size={10} />
                  </button>
                </div>
              ))}
              <button className="rounded p-1 text-muted hover:text-text" title="New query tab" onClick={() => newTab()}>
                <Plus size={12} />
              </button>
            </div>
            {/* toolbar */}
            <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
              {running ? (
                <Button size="sm" variant="danger" onClick={cancel}>
                  <Square size={12} /> Cancel
                </Button>
              ) : (
                <Button size="sm" variant="primary" onClick={() => void run()} title="Run the statement, or the selection (⌘↩)">
                  <Play size={12} /> Run
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void explain()} title={conn?.kind === 'bigquery' ? 'Dry run: bytes that would be processed' : 'Query plan without running it'}>
                <FileSearch size={12} /> Explain
              </Button>
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
                {editable && (
                  <span className="rounded bg-accent/15 px-1 py-px text-[10px] uppercase tracking-wide text-accent" title={`Double-click a cell to edit; rows are keyed by ${editable.pk.join(', ')}`}>
                    editable
                  </span>
                )}
                <div className="relative">
                  <Button size="sm" variant="ghost" onClick={() => setShowExport((v) => !v)} title="Export or copy the result">
                    <Download size={11} /> Export
                  </Button>
                  {showExport && (
                    <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-border bg-panel p-1 shadow-xl">
                      <button className="block w-full rounded px-2 py-1 text-left hover:bg-panel-2" onClick={() => void exportFile('csv')}>
                        Save as CSV… <span className="text-muted">(full result)</span>
                      </button>
                      <button className="block w-full rounded px-2 py-1 text-left hover:bg-panel-2" onClick={() => void exportFile('json')}>
                        Save as JSON… <span className="text-muted">(full result)</span>
                      </button>
                      <button className="block w-full rounded px-2 py-1 text-left hover:bg-panel-2 disabled:opacity-50" disabled={!result} onClick={() => copy('csv')}>
                        <Copy size={10} className="mr-1 inline" /> Copy shown rows as CSV
                      </button>
                      <button className="block w-full rounded px-2 py-1 text-left hover:bg-panel-2 disabled:opacity-50" disabled={!result} onClick={() => copy('json')}>
                        <Copy size={10} className="mr-1 inline" /> Copy shown rows as JSON
                      </button>
                    </div>
                  )}
                </div>
              </span>
            </div>
            <div ref={editorHost} className="h-[180px] shrink-0 overflow-hidden border-b border-border" />
            {confirmWrite && (
              <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-[12px]">
                This statement writes to {conn?.database || conn?.name}. Run it?
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
            {pendingEdit && (
              <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-[12px]">
                <Pencil size={12} className="shrink-0" />
                <code className="min-w-0 flex-1 truncate font-mono text-[11px]" title={pendingEdit.preview}>
                  {pendingEdit.preview}
                </code>
                <Button size="sm" variant="danger" onClick={() => void applyEdit()}>
                  Apply
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPendingEdit(null)}>
                  Discard
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
                    {result.columns.length && result.command && conn?.kind === 'bigquery' ? ` · ${result.command}` : ''}
                  </span>
                  <span>· {result.ms} ms</span>
                  {!result.readOnly && <span className="text-warn">· write</span>}
                </>
              ) : (
                <span>{isMongo ? '⌘↩ runs the command. Click a collection to preview it; commands are JSON: {"collection": "…", "find": {…}}' : '⌘↩ runs the statement or the selection. Click a table to preview it.'}</span>
              )}
              {notice && <span className="ml-auto text-ok">{notice}</span>}
            </div>
            <div className="min-h-0 flex-1">{result && result.columns.length > 0 ? <Grid result={result} editable={Boolean(editable)} pkCols={editable?.pk ?? []} onCell={(c) => setPanel({ title: c.col, text: c.value === null || c.value === undefined ? 'NULL' : typeof c.value === 'object' ? JSON.stringify(c.value, null, 2) : String(c.value) })} onEdit={startEdit} /> : null}</div>
            {panel && (
              <div className="max-h-[35%] shrink-0 overflow-auto border-t border-border bg-bg px-3 py-2">
                <div className="mb-1 flex items-center text-[11px] text-muted">
                  <span className="font-mono">{panel.title}</span>
                  <button className="ml-auto rounded p-0.5 hover:text-text" onClick={() => setPanel(null)}>
                    <X size={12} />
                  </button>
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">{panel.text}</pre>
              </div>
            )}
          </>
        )}
      </div>
      {importFor && conn && <ImportCsvDialog spaceId={spaceId} connection={conn} table={importFor} onClose={() => setImportFor(null)} onDone={(n) => {
        setImportFor(null)
        setNotice(`${n} rows imported into ${importFor.name}.`)
        loadSchema(true)
      }} />}
    </div>
  )
}

function Grid({ result, editable, pkCols, onCell, onEdit }: { result: DbQueryResult; editable: boolean; pkCols: string[]; onCell: (c: { col: string; value: unknown }) => void; onEdit: (rowIndex: number, colIndex: number, value: unknown) => void }): React.JSX.Element {
  const parent = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState<{ row: number; col: number; text: string } | null>(null)
  const rowVirt = useVirtualizer({ count: result.rows.length, getScrollElement: () => parent.current, estimateSize: () => 26, overscan: 12 })
  const widths = useMemo(() => result.columns.map((c, i) => Math.min(360, Math.max(80, 8 * Math.max(c.name.length, ...result.rows.slice(0, 50).map((r) => Math.min(45, cellText(r[i]).length)))))), [result])
  const total = widths.reduce((a, b) => a + b, 0) + 48
  const commit = (): void => {
    if (!editing) return
    const original = result.rows[editing.row][editing.col]
    const raw = editing.text
    let value: unknown = raw
    if (raw === '' || raw.toUpperCase() === 'NULL') value = null
    else if (typeof original === 'number' && raw.trim() !== '' && !isNaN(Number(raw))) value = Number(raw)
    else if (typeof original === 'boolean' && /^(true|false)$/i.test(raw)) value = raw.toLowerCase() === 'true'
    else if (original !== null && typeof original === 'object') {
      try {
        value = JSON.parse(raw)
      } catch {
        value = raw
      }
    }
    setEditing(null)
    if (value !== original) onEdit(editing.row, editing.col, value)
  }
  return (
    <div ref={parent} className="h-full overflow-auto font-mono text-[11px]">
      <div style={{ width: total, minWidth: '100%' }}>
        <div className="sticky top-0 z-10 flex border-b border-border bg-panel">
          <div className="w-12 shrink-0 border-r border-border px-1 py-1 text-right text-muted">#</div>
          {result.columns.map((c, i) => (
            <div key={i} className="shrink-0 truncate border-r border-border px-2 py-1 font-semibold" style={{ width: widths[i] }} title={c.type}>
              {pkCols.includes(c.name) && <Key size={9} className="mr-1 inline text-warn" />}
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
                {row.map((val, i) =>
                  editing && editing.row === v.index && editing.col === i ? (
                    <input
                      key={i}
                      autoFocus
                      className="shrink-0 border-r border-accent bg-bg px-2 py-0.5 font-mono text-[11px] outline-none"
                      style={{ width: widths[i] }}
                      value={editing.text}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                      onBlur={commit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commit()
                        if (e.key === 'Escape') setEditing(null)
                      }}
                    />
                  ) : (
                    <div
                      key={i}
                      className={clsx('shrink-0 cursor-default truncate border-r border-border/60 px-2 py-1', val === null && 'italic text-muted', editable && !pkCols.includes(result.columns[i].name) && 'hover:ring-1 hover:ring-inset hover:ring-accent/40')}
                      style={{ width: widths[i] }}
                      onClick={() => onCell({ col: result.columns[i].name, value: val })}
                      onDoubleClick={() => editable && !pkCols.includes(result.columns[i].name) && setEditing({ row: v.index, col: i, text: val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val) })}
                    >
                      {val === null ? 'NULL' : cellText(val)}
                    </div>
                  )
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
