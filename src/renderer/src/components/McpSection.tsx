import React, { useState } from 'react'
import { Plus, Trash2, Download, Plug } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Field, inputCls } from './ui'
import type { McpServerSpec } from '@shared/types'

function parseKv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return Object.keys(out).length ? out : undefined
}
function kvText(o?: Record<string, string>): string {
  return Object.entries(o ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/**
 * Edits a list of MCP servers. Used in a space's settings (servers for that
 * space) and in app Settings (servers for every space).
 */
export function McpSection({ servers, onChange, title, intro, jira }: { servers: McpServerSpec[]; onChange: (s: McpServerSpec[]) => void; title: string; intro: string; jira?: { connected: boolean; exposed: boolean; onToggle: (v: boolean) => void } }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<McpServerSpec>({ id: '', name: '', transport: 'http', enabled: true })
  const [headersText, setHeadersText] = useState('')
  const [envText, setEnvText] = useState('')
  const [argsText, setArgsText] = useState('')
  const [importable, setImportable] = useState<McpServerSpec[] | null>(null)

  const save = (): void => {
    const name = draft.name.trim().replace(/\s+/g, '-')
    if (!name) return
    const spec: McpServerSpec = {
      id: draft.id || crypto.randomUUID().slice(0, 8),
      name,
      transport: draft.transport,
      enabled: true,
      ...(draft.transport === 'stdio'
        ? { command: draft.command?.trim(), args: argsText.trim() ? argsText.trim().split(/\s+/) : undefined, env: parseKv(envText) }
        : { url: draft.url?.trim(), headers: parseKv(headersText) })
    }
    if (spec.transport === 'stdio' ? !spec.command : !spec.url) return
    onChange([...servers.filter((s) => s.id !== spec.id), spec])
    setAdding(false)
    setDraft({ id: '', name: '', transport: 'http', enabled: true })
    setHeadersText('')
    setEnvText('')
    setArgsText('')
  }
  const loadImportable = async (): Promise<void> => {
    try {
      const list = await api.invoke('mcp:importable')
      setImportable(list.filter((s) => !servers.some((x) => x.name === s.name)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="mt-4">
      <div className="mb-1 flex items-center">
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">{title}</h3>
        <span className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={loadImportable} title="Import servers from ~/.claude.json">
            <Download size={12} /> Import from Claude Code
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={12} /> Add server
          </Button>
        </span>
      </div>
      <p className="mb-2 text-[11px] text-muted">{intro}</p>

      {jira && (
        <label className="mb-2 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[12px]">
          <input type="checkbox" checked={jira.exposed} disabled={!jira.connected} onChange={(e) => jira.onToggle(e.target.checked)} />
          <Plug size={13} className="text-muted" />
          <span className="flex-1">
            Atlassian MCP with this Jira login
            <span className="block text-[11px] text-muted">{jira.connected ? 'Claude gets Jira tools (search, read, create tickets) using the Jira connection above. No separate setup.' : 'Connect Jira above to enable this.'}</span>
          </span>
          {jira.connected && jira.exposed && <Badge tone="ok">on</Badge>}
        </label>
      )}

      <div className="flex flex-col gap-1.5">
        {servers.length === 0 && !adding && <div className="rounded-md border border-dashed border-border p-3 text-center text-[12px] text-muted">No MCP servers yet.</div>}
        {servers.map((s) => (
          <div key={s.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
            <input type="checkbox" checked={s.enabled} onChange={(e) => onChange(servers.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked } : x)))} title="Enabled" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                {s.name} <Badge>{s.transport}</Badge>
              </div>
              <div className="truncate font-mono text-[11px] text-muted">{s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url}</div>
            </div>
            <button
              className="rounded p-1 text-muted hover:text-text"
              title="Edit"
              onClick={() => {
                setDraft(s)
                setHeadersText(kvText(s.headers))
                setEnvText(kvText(s.env))
                setArgsText((s.args ?? []).join(' '))
                setAdding(true)
              }}
            >
              ✎
            </button>
            <button className="rounded p-1 text-muted hover:text-danger" title="Remove" onClick={() => onChange(servers.filter((x) => x.id !== s.id))}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      {importable && (
        <div className="mt-2 rounded-lg border border-border p-3">
          <div className="mb-1 text-[12px] font-medium">From Claude Code's config</div>
          {importable.length === 0 && <div className="text-[12px] text-muted">Nothing new to import.</div>}
          <div className="flex flex-wrap gap-1.5">
            {importable.map((s) => (
              <button
                key={s.name}
                className="rounded-full border border-border px-2 py-0.5 text-[12px] hover:bg-panel-2"
                onClick={() => {
                  onChange([...servers, s])
                  setImportable(importable.filter((x) => x.name !== s.name))
                }}
              >
                + {s.name} <span className="text-muted">({s.transport})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {adding && (
        <div className="mt-2 rounded-lg border border-accent/40 p-3">
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <Field label="Name">
              <input autoFocus className={inputCls} placeholder="e.g. linear" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Transport">
              <select className={inputCls} value={draft.transport} onChange={(e) => setDraft({ ...draft, transport: e.target.value as McpServerSpec['transport'] })}>
                <option value="http">http</option>
                <option value="sse">sse</option>
                <option value="stdio">stdio</option>
              </select>
            </Field>
          </div>
          {draft.transport === 'stdio' ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Command">
                  <input className={inputCls} placeholder="npx" value={draft.command ?? ''} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
                </Field>
                <Field label="Arguments">
                  <input className={inputCls} placeholder="-y @scope/server" value={argsText} onChange={(e) => setArgsText(e.target.value)} />
                </Field>
              </div>
              <Field label="Environment (KEY=value per line)">
                <textarea rows={2} className={inputCls} value={envText} onChange={(e) => setEnvText(e.target.value)} />
              </Field>
            </>
          ) : (
            <>
              <Field label="URL">
                <input className={inputCls} placeholder="https://mcp.example.com/mcp" value={draft.url ?? ''} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
              </Field>
              <Field label="Headers (KEY=value per line)" hint="e.g. Authorization=Bearer …">
                <textarea rows={2} className={inputCls} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
              </Field>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={save}>
              Save server
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
