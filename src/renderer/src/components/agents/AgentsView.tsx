import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Bot, Plus, Sparkles, LayoutTemplate, FolderInput, FolderOutput, Copy, Trash2, Play, Square, RotateCcw, Check, ChevronDown, Loader2, AtSign } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Markdown } from '@/lib/markdown'
import { Badge, Button, Dialog, Field, Spinner, inputCls } from '../ui'
import { CrewModelSelect, modelLabel } from '../ModelSelect'
import { ContextMenu, type MenuEntry } from '../ContextMenu'
import { AGENT_TEMPLATES, AGENT_TOOL_NAMES, PERMISSION_MODES, classifyModel, type AgentDraft, type AgentRunEvent, type AgentSpec, type ProviderConfig, type SubagentStep } from '@shared/types'

const EMPTY_PROVIDERS: ProviderConfig[] = []
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const SELECTED_KEY = 'sinfonie.agents.selected'

function blank(scope?: string): AgentSpec {
  return { id: '', name: '', description: '', prompt: '', model: 'sonnet', effort: 'high', enabled: true, source: 'user', ...(scope ? { scope } : {}) }
}

function same(a: AgentSpec, b: AgentSpec): boolean {
  const norm = (x: AgentSpec): string => JSON.stringify({ ...x, updatedAt: undefined, createdAt: undefined, tools: x.tools ?? [], effort: x.effort ?? '', maxTurns: x.maxTurns ?? 0, permissionMode: x.permissionMode ?? '', icon: x.icon ?? '', scope: x.scope ?? '' })
  return norm(a) === norm(b)
}

/**
 * The agent library: every agent you can delegate to, @mention in a chat, or run from here.
 * Gallery on the left, the editor with a "Try it" pane on the right.
 */
export function AgentsView(): React.JSX.Element {
  const agents = useApp((s) => s.agents)
  const spaces = useApp((s) => s.spaces)
  const activeSpaceId = useApp((s) => s.activeSpaceId)
  const setError = useApp((s) => s.setError)
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem(SELECTED_KEY))
  const [draft, setDraft] = useState<AgentSpec | null>(null)
  const [describe, setDescribe] = useState(false)
  const [templates, setTemplates] = useState(false)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const selected = useMemo(() => agents.find((a) => a.id === selectedId) ?? null, [agents, selectedId])
  // A stored agent loads into the editor; a new one keeps its unsaved draft until saved or discarded.
  useEffect(() => {
    if (selected) setDraft((d) => (d && d.id === selected.id ? d : { ...selected }))
    else if (selectedId && selectedId !== 'new') setDraft(null)
  }, [selected, selectedId])
  const pick = (id: string | null): void => {
    setSelectedId(id)
    if (id) localStorage.setItem(SELECTED_KEY, id)
    else localStorage.removeItem(SELECTED_KEY)
    if (id !== 'new') setDraft(id ? ({ ...agents.find((a) => a.id === id) } as AgentSpec) : null)
  }
  const startNew = (spec: AgentSpec): void => {
    setDraft(spec)
    setSelectedId('new')
  }
  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err))

  const save = async (): Promise<void> => {
    if (!draft) return
    setBusy('save')
    try {
      const saved = await api.invoke('agents:save', draft)
      setDraft({ ...saved })
      pick(saved.id)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }
  const remove = async (a: AgentSpec): Promise<void> => {
    if (!window.confirm(`Delete the agent "${a.name}"? Spaces that delegate to it lose it.`)) return
    try {
      await api.invoke('agents:remove', a.id)
      if (selectedId === a.id) pick(null)
    } catch (err) {
      fail(err)
    }
  }
  const duplicate = async (a: AgentSpec): Promise<void> => {
    try {
      const copy = await api.invoke('agents:duplicate', a.id)
      pick(copy.id)
    } catch (err) {
      fail(err)
    }
  }
  const importDir = async (): Promise<void> => {
    const dir = await api.invoke('dialog:pickFolder', 'Import agents from a folder (it or its .claude/agents subfolder)')
    if (!dir) return
    setBusy('import')
    try {
      const done = await api.invoke('agents:importDir', dir, activeSpaceId || undefined)
      if (done[0]) pick(done[0].id)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }
  const exportOne = async (a: AgentSpec): Promise<void> => {
    const dir = await api.invoke('dialog:pickFolder', `Export "${a.name}" as a Claude Code agent file into…`)
    if (!dir) return
    try {
      await api.invoke('agents:export', a.id, dir)
    } catch (err) {
      fail(err)
    }
  }
  const resetBuiltins = async (): Promise<void> => {
    if (!window.confirm('Restore explorer, implementer, tester and reviewer to their defaults? Your edits to those four are lost; other agents are untouched.')) return
    try {
      await api.invoke('agents:resetBuiltins')
    } catch (err) {
      fail(err)
    }
  }

  const q = filter.trim().toLowerCase()
  const shown = agents.filter((a) => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
  const dirty = draft !== null && (draft.id === '' || !selected || !same(draft, selected))

  const newMenu: MenuEntry[] = [
    { label: 'Blank agent', icon: <Plus size={13} />, onClick: () => startNew(blank()) },
    { label: 'Describe it… (Claude drafts it)', icon: <Sparkles size={13} />, onClick: () => setDescribe(true) },
    { label: 'From a template…', icon: <LayoutTemplate size={13} />, onClick: () => setTemplates(true) },
    { label: 'Import from a folder… (.claude/agents)', icon: <FolderInput size={13} />, onClick: () => void importDir() }
  ]

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[340px] shrink-0 flex-col border-r border-border">
        <div className="drag flex h-[52px] items-center gap-2 border-b border-border px-4">
          <Bot size={16} className="text-accent" />
          <span className="text-[13px] font-semibold">Agents</span>
          <span className="text-[11px] text-muted">{agents.length}</span>
          <div className="no-drag ml-auto flex items-center gap-1">
            <NewAgentButton entries={newMenu} busy={busy === 'import'} />
          </div>
        </div>
        <div className="border-b border-border px-3 py-2">
          <input className={inputCls} placeholder="Filter agents…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="flex-1 overflow-auto p-2">
          {shown.length === 0 && <div className="px-2 py-6 text-center text-[12px] text-muted">{agents.length === 0 ? 'No agents yet. Create one with New agent.' : 'Nothing matches.'}</div>}
          {shown.map((a) => (
            <AgentCard key={a.id} agent={a} selected={a.id === selectedId} spaceName={a.scope ? spaces.find((s) => s.id === a.scope)?.name : undefined} onClick={() => pick(a.id)} onToggle={(enabled) => {
                if (a.id === selectedId) setDraft((d) => (d ? { ...d, enabled } : d))
                void api.invoke('agents:save', { ...a, enabled }).catch(fail)
              }} onDuplicate={() => void duplicate(a)} onExport={() => void exportOne(a)} onDelete={() => void remove(a)} />
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-muted">
          <span className="flex-1">Mention one in any chat with @name.</span>
          <button className="hover:text-text" onClick={() => void resetBuiltins()} title="Restore the four built-in agents to their defaults">
            <RotateCcw size={11} className="mr-1 inline" />
            Reset built-ins
          </button>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {draft ? (
          <Editor key={selectedId ?? 'none'} draft={draft} stored={selected} dirty={dirty} saving={busy === 'save'} onChange={setDraft} onSave={() => void save()} onDiscard={() => (draft.id ? setDraft({ ...selected! }) : pick(null))} />
        ) : (
          <Empty onNew={() => startNew(blank())} onDescribe={() => setDescribe(true)} onTemplates={() => setTemplates(true)} onImport={() => void importDir()} />
        )}
      </div>
      {describe && (
        <DescribeDialog
          spaceId={activeSpaceId || undefined}
          onClose={() => setDescribe(false)}
          onUse={(d) => {
            setDescribe(false)
            startNew({ ...blank(), name: d.name, description: d.description, prompt: d.prompt, model: d.model, effort: d.effort, tools: d.tools, maxTurns: d.maxTurns, icon: d.icon })
          }}
        />
      )}
      {templates && (
        <TemplatesDialog
          onClose={() => setTemplates(false)}
          onPick={async (name) => {
            setTemplates(false)
            try {
              const a = await api.invoke('agents:fromTemplate', name, undefined)
              pick(a.id)
            } catch (err) {
              fail(err)
            }
          }}
        />
      )}
    </div>
  )
}

function NewAgentButton({ entries, busy }: { entries: MenuEntry[]; busy: boolean }): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setMenu({ x: r.left, y: r.bottom + 4 })
        }}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} New agent <ChevronDown size={11} />
      </Button>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries} onClose={() => setMenu(null)} />}
    </>
  )
}

function AgentCard({ agent: a, selected, spaceName, onClick, onToggle, onDuplicate, onExport, onDelete }: { agent: AgentSpec; selected: boolean; spaceName?: string; onClick: () => void; onToggle: (v: boolean) => void; onDuplicate: () => void; onExport: () => void; onDelete: () => void }): React.JSX.Element {
  const providersRaw = useApp((s) => s.settings.providers)
  const providers = providersRaw ?? EMPTY_PROVIDERS
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const entries: MenuEntry[] = [
    { label: 'Duplicate', icon: <Copy size={13} />, onClick: onDuplicate },
    { label: 'Export as .md…', icon: <FolderOutput size={13} />, onClick: onExport },
    { label: 'Delete', icon: <Trash2 size={13} />, danger: true, onClick: onDelete }
  ]
  return (
    <div
      className={clsx('group mb-1 flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2', selected ? 'border-accent/60 bg-panel-2' : 'border-transparent hover:bg-panel-2/60', !a.enabled && 'opacity-60')}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg text-[15px]">{a.icon || <Bot size={14} className="text-muted" />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{a.name || <span className="text-muted">unnamed</span>}</span>
          {a.source === 'builtin' && <Badge>built-in</Badge>}
          {a.source === 'imported' && <Badge>imported</Badge>}
          {spaceName && <Badge tone="accent">{spaceName}</Badge>}
        </div>
        <div className="truncate text-[11px] text-muted" title={a.description}>
          {a.description || 'No description yet'}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted">
          <span className="rounded bg-bg px-1 py-px font-mono">{modelLabel(a.model, providers)}</span>
          {a.effort && <span>{a.effort}</span>}
          <span>{a.tools?.length ? `${a.tools.length} tools` : 'all tools'}</span>
        </div>
      </div>
      <label className="mt-1 flex items-center" title={a.enabled ? 'In the crew: orchestrators can delegate to it' : 'Off: kept in the library, not offered to orchestrators'} onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={a.enabled} onChange={(e) => onToggle(e.target.checked)} />
      </label>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries} onClose={() => setMenu(null)} />}
    </div>
  )
}

function Empty({ onNew, onDescribe, onTemplates, onImport }: { onNew: () => void; onDescribe: () => void; onTemplates: () => void; onImport: () => void }): React.JSX.Element {
  const tile = (icon: React.ReactNode, title: string, text: string, onClick: () => void): React.JSX.Element => (
    <button onClick={onClick} className="flex w-[220px] flex-col items-start gap-1.5 rounded-xl border border-border bg-panel/60 p-4 text-left hover:border-accent/60 hover:bg-panel-2">
      <span className="text-accent">{icon}</span>
      <span className="text-[13px] font-medium">{title}</span>
      <span className="text-[11px] text-muted">{text}</span>
    </button>
  )
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
      <div>
        <Bot size={28} className="mx-auto mb-2 text-accent" />
        <div className="text-[15px] font-semibold">Your agents</div>
        <p className="mx-auto mt-1 max-w-md text-[12px] text-muted">
          An agent is a role with its own instructions, model and tools. The orchestrator delegates to the ones in its crew, you can call one directly with <span className="font-mono">@name</span> in any chat, and you can try one right here. Pick an agent on the left, or start a new one.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        {tile(<Sparkles size={18} />, 'Describe it', 'One sentence; Claude drafts the name, instructions, tools and model.', onDescribe)}
        {tile(<LayoutTemplate size={18} />, 'From a template', 'Docs writer, security reviewer, release notes, migration checker, debugger.', onTemplates)}
        {tile(<Plus size={18} />, 'Blank', 'Write it yourself.', onNew)}
        {tile(<FolderInput size={18} />, 'Import', 'Claude Code agent files from a repo’s .claude/agents folder.', onImport)}
      </div>
    </div>
  )
}

// ---------- editor ----------

function Editor({ draft, stored, dirty, saving, onChange, onSave, onDiscard }: { draft: AgentSpec; stored: AgentSpec | null; dirty: boolean; saving: boolean; onChange: (a: AgentSpec) => void; onSave: () => void; onDiscard: () => void }): React.JSX.Element {
  const spaces = useApp((s) => s.spaces)
  const set = (patch: Partial<AgentSpec>): void => onChange({ ...draft, ...patch })
  const kind = classifyModel(draft.model).kind
  const [customTool, setCustomTool] = useState('')
  const tools = draft.tools ?? []
  const toggleTool = (name: string): void => set({ tools: tools.includes(name) ? tools.filter((t) => t !== name) : [...tools, name] })
  const nameOk = /^[a-z0-9][a-z0-9-_]*$/i.test(draft.name)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-5">
        <span className="text-[15px]">{draft.icon || <Bot size={16} className="text-muted" />}</span>
        <span className="text-[13px] font-semibold">{draft.name || 'New agent'}</span>
        {stored?.source === 'builtin' && <Badge>built-in</Badge>}
        {stored?.filePath && (
          <span className="truncate text-[11px] text-muted" title={stored.filePath}>
            from {stored.filePath}
          </span>
        )}
        <div className="no-drag ml-auto flex items-center gap-2">
          {dirty && (
            <Button size="sm" variant="ghost" onClick={onDiscard}>
              {draft.id ? 'Discard changes' : 'Discard'}
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!dirty || saving || !draft.name.trim() || !nameOk} onClick={onSave} title={!nameOk && draft.name ? 'Letters, digits, dashes and underscores only' : undefined}>
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {draft.id ? 'Save' : 'Create'}
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto px-5 py-4">
          <div className="grid max-w-[720px] grid-cols-[64px_1fr] gap-3">
            <Field label="Icon">
              <input className={clsx(inputCls, 'text-center')} value={draft.icon ?? ''} maxLength={4} placeholder="🤖" onChange={(e) => set({ icon: [...e.target.value][0] ?? '' })} />
            </Field>
            <Field label="Name" hint="How the orchestrator and @mentions address it. Letters, digits, dashes.">
              <input className={clsx(inputCls, draft.name && !nameOk && 'border-danger')} value={draft.name} placeholder="security-reviewer" onChange={(e) => set({ name: e.target.value.replace(/\s+/g, '-') })} />
            </Field>
          </div>
          <div className="mt-3 flex max-w-[720px] flex-col gap-3">
            <Field label="Description" hint="Written for the orchestrator: what to send this agent and what comes back.">
              <textarea rows={2} className={inputCls} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
            </Field>
            <Field label="Instructions" hint="The agent's own system prompt: how to work and what its report must contain.">
              <textarea rows={8} className={clsx(inputCls, 'font-mono text-[12px]')} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Model">
                <CrewModelSelect value={draft.model} onChange={(model) => set({ model, ...(classifyModel(model).kind !== 'claude' ? { effort: undefined } : {}) })} />
              </Field>
              <Field label="Effort" hint={kind === 'claude' ? undefined : 'Claude models only'}>
                <select className={inputCls} disabled={kind !== 'claude'} value={draft.effort ?? ''} onChange={(e) => set({ effort: (e.target.value || undefined) as AgentSpec['effort'] })}>
                  <option value="">default</option>
                  {EFFORTS.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Max turns" hint="Tool calls before it must report.">
                <input type="number" className={inputCls} value={draft.maxTurns ?? ''} placeholder="40" onChange={(e) => set({ maxTurns: Number(e.target.value) || undefined })} />
              </Field>
            </div>
            <Field label="Tools" hint={tools.length ? `${tools.length} allowed; everything else is refused.` : 'None ticked: the agent gets every tool the orchestrator has.'}>
              <div className="flex flex-wrap gap-1.5">
                {AGENT_TOOL_NAMES.map((t) => (
                  <button key={t.name} type="button" title={t.hint} onClick={() => toggleTool(t.name)} className={clsx('rounded-md border px-2 py-0.5 font-mono text-[11px]', tools.includes(t.name) ? 'border-accent/60 bg-accent/15 text-text' : 'border-border text-muted hover:text-text', !t.readOnly && tools.includes(t.name) && 'border-warn/60 bg-warn/10')}>
                    {t.name}
                  </button>
                ))}
                {tools
                  .filter((t) => !AGENT_TOOL_NAMES.some((k) => k.name === t))
                  .map((t) => (
                    <button key={t} type="button" onClick={() => toggleTool(t)} className="rounded-md border border-accent/60 bg-accent/15 px-2 py-0.5 font-mono text-[11px]">
                      {t} ×
                    </button>
                  ))}
                <input
                  className="h-[22px] w-40 rounded-md border border-dashed border-border bg-transparent px-2 font-mono text-[11px] outline-none focus:border-accent"
                  placeholder="add: Bash(pnpm test:*)"
                  value={customTool}
                  onChange={(e) => setCustomTool(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customTool.trim()) {
                      e.preventDefault()
                      if (!tools.includes(customTool.trim())) set({ tools: [...tools, customTool.trim()] })
                      setCustomTool('')
                    }
                  }}
                />
              </div>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Permission mode" hint="Overrides the workspace's mode.">
                <select className={inputCls} value={draft.permissionMode ?? ''} onChange={(e) => set({ permissionMode: (e.target.value || undefined) as AgentSpec['permissionMode'] })}>
                  <option value="">inherit</option>
                  {PERMISSION_MODES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Available in" hint="One space, or everywhere.">
                <select className={inputCls} value={draft.scope ?? ''} onChange={(e) => set({ scope: e.target.value || undefined })}>
                  <option value="">every space</option>
                  {spaces.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Crew">
                <label className="flex h-[34px] items-center gap-2 text-[12px]">
                  <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                  Orchestrators may delegate to it
                </label>
              </Field>
            </div>
          </div>
        </div>
        <TryIt draft={draft} dirty={dirty} />
      </div>
    </div>
  )
}

// ---------- Try it ----------

function TryIt({ draft, dirty }: { draft: AgentSpec; dirty: boolean }): React.JSX.Element {
  const workspaces = useApp((s) => s.workspaces)
  const selectedWs = useApp((s) => s.selectedId)
  const live = useMemo(() => workspaces.filter((w) => w.status !== 'archived'), [workspaces])
  const [wsId, setWsId] = useState<string>(() => localStorage.getItem('sinfonie.agents.tryWs') || selectedWs || '')
  const [prompt, setPrompt] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [steps, setSteps] = useState<{ step: SubagentStep; model?: string }[]>([])
  const [report, setReport] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const ws = live.find((w) => w.id === wsId) ?? live[0]
  useEffect(
    () =>
      api.on('agents:run', (e: AgentRunEvent) => {
        if (e.runId !== runId) return
        if (e.type === 'step') setSteps((s) => [...s, { step: e.step, model: e.model }].slice(-400))
        else if (e.type === 'done') {
          setReport(e.report)
          setDurationMs(e.durationMs)
          setRunId(null)
        } else {
          setError(e.message)
          setRunId(null)
        }
      }),
    [runId]
  )
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [steps.length])
  const run = async (): Promise<void> => {
    if (!ws || !prompt.trim() || runId) return
    setSteps([])
    setReport(null)
    setError(null)
    setDurationMs(null)
    try {
      const id = await api.invoke('agents:run', draft.id, ws.id, prompt.trim(), draft)
      setRunId(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const stop = (): void => {
    if (runId) void api.invoke('agents:cancelRun', runId)
  }
  const model = steps.find((s) => s.model)?.model
  return (
    <div className="flex w-[380px] shrink-0 flex-col border-l border-border">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-[12px] font-medium">
        <Play size={12} className="text-accent" /> Try it
        {dirty && <span className="text-[10px] font-normal text-muted">runs with your unsaved edits</span>}
      </div>
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <select
          className={inputCls}
          value={ws?.id ?? ''}
          onChange={(e) => {
            setWsId(e.target.value)
            localStorage.setItem('sinfonie.agents.tryWs', e.target.value)
          }}
        >
          {live.length === 0 && <option value="">No workspace yet</option>}
          {live.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} · {w.repos.map((r) => r.repoName).join(', ')}
            </option>
          ))}
        </select>
        <textarea rows={3} className={inputCls} placeholder={`A task for ${draft.name || 'this agent'} in that workspace…`} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void run()} />
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted">⌘↵ runs. Permissions ask like a delegation would.</span>
          <span className="ml-auto" />
          {runId ? (
            <Button size="sm" variant="danger" onClick={stop}>
              <Square size={11} /> Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabled={!ws || !prompt.trim() || !draft.name.trim()} onClick={() => void run()}>
              <Play size={11} /> Run
            </Button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {steps.length === 0 && !report && !error && !runId && <div className="text-[12px] text-muted">The agent's tool calls and its report show here.</div>}
        {(steps.length > 0 || runId) && (
          <div className="mb-3">
            <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted">
              Activity · {steps.filter((s) => s.step.kind === 'tool').length} tool calls
              {model && <span className="rounded bg-panel-2 px-1 py-px font-mono text-[10px] normal-case">{model.replace(/^claude-/, '')}</span>}
              {runId && (
                <span className="inline-flex items-center gap-1 text-warn">
                  <Spinner /> running
                </span>
              )}
            </div>
            <div className="flex flex-col gap-0.5 rounded-md border border-border bg-bg p-2">
              {steps.length === 0 && <div className="text-[12px] text-muted">Waiting for the first step…</div>}
              {steps.map((s, i) =>
                s.step.kind === 'tool' ? (
                  <div key={i} className="flex items-baseline gap-2 font-mono text-[11px]">
                    <span className="shrink-0 text-accent">{s.step.name}</span>
                    <span className="truncate text-muted" title={s.step.detail}>
                      {s.step.detail}
                    </span>
                  </div>
                ) : (
                  <div key={i} className="whitespace-pre-wrap py-0.5 text-[12px]">
                    {s.step.detail}
                  </div>
                )
              )}
              <div ref={endRef} />
            </div>
          </div>
        )}
        {error && <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
        {report !== null && (
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">
              Report{durationMs !== null && <span className="ml-2 normal-case">{(durationMs / 1000).toFixed(1)} s</span>}
            </div>
            <div className="rounded-md border border-border bg-bg p-2 text-[12px]">
              <Markdown text={report.slice(0, 40_000)} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- dialogs ----------

function DescribeDialog({ spaceId, onClose, onUse }: { spaceId?: string; onClose: () => void; onUse: (d: AgentDraft) => void }): React.JSX.Element {
  const providersRaw = useApp((s) => s.settings.providers)
  const providers = providersRaw ?? EMPTY_PROVIDERS
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<AgentDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const go = async (): Promise<void> => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      setDraft(await api.invoke('agents:draft', text.trim(), spaceId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title="Describe the agent" onClose={onClose} width={640}>
      <p className="mb-2 text-[12px] text-muted">One or two sentences on what it should do. Claude writes the name, description, instructions, tool list and picks a model from everything you can use. You edit before saving.</p>
      <textarea
        rows={3}
        autoFocus
        className={inputCls}
        placeholder="e.g. reviews SQL migrations for Postgres safety: locks, backfills, missing indexes"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void go()
          }
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        {error && <span className="text-[12px] text-danger">{error}</span>}
        <span className="ml-auto" />
        <Button size="sm" variant={draft ? 'subtle' : 'primary'} disabled={!text.trim() || busy} onClick={() => void go()}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} {draft ? 'Draft again' : 'Draft it'}
        </Button>
      </div>
      {busy && !draft && <div className="mt-3 text-[12px] text-muted">Looking at your models and writing the agent… a few seconds.</div>}
      {draft && (
        <div className="mt-3 rounded-lg border border-border bg-bg p-3 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="text-[15px]">{draft.icon}</span>
            <span className="text-[13px] font-semibold">{draft.name}</span>
            <Badge tone="accent">{modelLabel(draft.model, providers)}</Badge>
            {draft.effort && <Badge>{draft.effort}</Badge>}
            <Badge>{draft.tools?.length ? `${draft.tools.length} tools` : 'all tools'}</Badge>
          </div>
          <p className="mt-1 text-muted">{draft.description}</p>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border p-2 font-mono text-[11px]">{draft.prompt}</pre>
          {draft.tools?.length ? <div className="mt-2 font-mono text-[11px] text-muted">{draft.tools.join(', ')}</div> : null}
          <p className="mt-2 text-[11px] text-muted">Model: {draft.why}</p>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!draft} onClick={() => draft && onUse(draft)}>
          Use this draft
        </Button>
      </div>
    </Dialog>
  )
}

function TemplatesDialog({ onClose, onPick }: { onClose: () => void; onPick: (name: string) => void }): React.JSX.Element {
  const providersRaw = useApp((s) => s.settings.providers)
  const providers = providersRaw ?? EMPTY_PROVIDERS
  return (
    <Dialog title="Start from a template" onClose={onClose} width={620}>
      <div className="flex flex-col gap-1.5">
        {AGENT_TEMPLATES.map((t) => (
          <button key={t.name} onClick={() => onPick(t.name)} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2 text-left hover:border-accent/60 hover:bg-panel-2">
            <span className="mt-0.5 text-[16px]">{t.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[13px] font-medium">
                {t.name}
                <Badge>{modelLabel(t.model, providers)}</Badge>
                <Badge>{t.tools?.length ? `${t.tools.length} tools` : 'all tools'}</Badge>
              </span>
              <span className="block text-[12px] text-muted">{t.blurb}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted">
        <AtSign size={11} /> The four built-ins (explorer, implementer, tester, reviewer) are already in the library.
      </p>
    </Dialog>
  )
}
