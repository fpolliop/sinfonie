import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, Square, RotateCcw, Send, ShieldCheck, XCircle, AlertTriangle, Info, History, Users, GitFork, ListTree, ArrowLeft } from 'lucide-react'
import { api } from '@/lib/api'
import { PERMISSION_MODES, type PermissionMode } from '@shared/types'
import { QuestionCard } from './QuestionCard'
import { ResumeDialog } from './ResumeDialog'
import { Dialog, Field, inputCls } from './ui'
import { useChat } from '@/stores/chat'
import { useApp } from '@/stores/app'
import { Markdown } from '@/lib/markdown'
import { Button, Spinner } from './ui'
import type { ChatBlock, ChatItem, ChatToolBlock } from '@shared/types'

/** Right panel state: closed, the activity overview, or one delegation's detail. */
type PanelView = { kind: 'closed' } | { kind: 'activity' } | { kind: 'delegation'; id: string }
const usePanel = (() => {
  let listeners: (() => void)[] = []
  let current: PanelView = { kind: 'closed' }
  const set = (v: PanelView): void => {
    current = v
    listeners.forEach((l) => l())
  }
  return (): [PanelView, (v: PanelView) => void] => {
    const [, force] = useState(0)
    useEffect(() => {
      const l = (): void => force((n) => n + 1)
      listeners.push(l)
      return () => {
        listeners = listeners.filter((x) => x !== l)
      }
    }, [])
    return [current, set]
  }
})()

export function ChatPane({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const chat = useChat((s) => s.chats[workspaceId])
  const allQuestions = useChat((s) => s.questions)
  // Filter outside the selector: a selector that returns a fresh array re-renders forever.
  const questions = useMemo(() => allQuestions.filter((q) => q.workspaceId === workspaceId), [allQuestions, workspaceId])
  const { send, interrupt, reset, setDraft, load, unqueue } = useChat()

  useEffect(() => {
    void load(workspaceId)
  }, [workspaceId, load])
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const scrollRef = useRef<HTMLDivElement>(null)
  const items = chat?.items ?? []
  const busy = chat?.busy ?? false
  const draft = chat?.draft ?? ''
  const queue = chat?.queue ?? []
  const disabled = ws?.status !== 'ready'
  const settingsModel = useApp((s) => s.settings.model)
  const settingsMode = useApp((s) => s.settings.permissionMode)
  // Select stable references, derive outside the selector (a fresh array per read loops React).
  const space = useApp((s) => s.spaces.find((x) => x.id === ws?.spaceId))
  const defaultAgents = useApp((s) => s.settings.agents)
  const crewNames = useMemo(() => {
    if (space?.useCrew === false) return []
    return (space?.agents ?? defaultAgents).filter((a) => a.enabled).map((a) => `${a.name} (${a.model})`)
  }, [space, defaultAgents])
  const setError = useApp((s) => s.setError)
  const mode: PermissionMode = ws?.permissionMode ?? settingsMode
  const [resumeDlg, setResumeDlg] = useState(false)
  const [forkDlg, setForkDlg] = useState(false)
  // Follow new output only while the view is already at the bottom; scrolling up detaches.
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(false)
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    setAtBottom(near)
    if (near) setUnseen(false)
  }
  const jumpToLatest = (): void => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setAtBottom(true)
    setUnseen(false)
  }

  const changeMode = (next: PermissionMode): void => {
    api.invoke('agent:setMode', workspaceId, next).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  const cycleMode = (): void => {
    const i = PERMISSION_MODES.findIndex((m) => m.id === mode)
    changeMode(PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length].id)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (atBottom) el.scrollTop = el.scrollHeight
    else setUnseen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, questions.length])

  // While a turn runs, Enter queues the message; main delivers it when the turn ends.
  const onSubmit = (): void => {
    if (disabled || !draft.trim()) return
    void send(workspaceId, draft)
  }

  return (
    <div className="flex h-full">
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {resumeDlg && <ResumeDialog workspaceId={workspaceId} onClose={() => setResumeDlg(false)} />}
      {forkDlg && ws && <ForkDialog wsId={ws.id} wsName={ws.name} branch={ws.repos[0]?.branch ?? ''} onClose={() => setForkDlg(false)} />}
      <div ref={scrollRef} onScroll={onScroll} className="relative flex-1 overflow-auto px-6 py-4">
        {items.length === 0 && (
          <div className="mx-auto mt-16 max-w-md text-center text-muted">
            <p className="mb-2">Claude Code runs here with every worktree of this workspace in scope.</p>
            <p className="text-[12px]">
              {ws?.repos.map((r) => r.repoName).join(' · ')}
              {ws?.sessionId && <span className="block mt-1">Previous session will be resumed.</span>}
            </p>
          </div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {items.map((it) => (
            <Message key={it.id} item={it} />
          ))}
          {questions.map((q) => (
            <QuestionCard key={q.requestId} req={q} />
          ))}
          {busy && questions.length === 0 && items[items.length - 1]?.role === 'user' && (
            <div className="flex items-center gap-2 text-muted">
              <Spinner /> Thinking…
            </div>
          )}
          {chat?.error && <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger whitespace-pre-wrap">{chat.error}</div>}
        </div>
      </div>
      <div className="relative border-t border-border px-4 py-3">
        {!atBottom && (
          <button onClick={jumpToLatest} className={clsx('absolute -top-9 left-1/2 z-10 -translate-x-1/2 rounded-full border px-3 py-1 text-[12px] shadow-lg', unseen ? 'border-accent/50 bg-accent-2 text-white' : 'border-border bg-panel text-muted hover:text-text')}>
            ↓ {unseen ? 'New output below' : 'Jump to latest'}
          </button>
        )}
        <div className="mx-auto max-w-3xl">
          {queue.length > 0 && (
            <div className="mb-2 flex flex-col gap-1">
              {queue.map((m) => (
                <div key={m.id} className="flex items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-1 text-[12px] text-muted">
                  <span className="shrink-0 text-[10px] uppercase tracking-wide">queued</span>
                  <span className="truncate">{m.text}</span>
                  <button className="ml-auto shrink-0 hover:text-danger" title="Remove from queue" onClick={() => void unqueue(workspaceId, m.id)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <CrewBar items={items} busy={busy} model={chat?.model ?? settingsModel} crewNames={crewNames} />
          <div className="rounded-xl border border-border bg-panel focus-within:border-accent">
            <textarea
              value={draft}
              disabled={disabled}
              onChange={(e) => setDraft(workspaceId, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  onSubmit()
                } else if (e.key === 'Tab' && e.shiftKey) {
                  e.preventDefault()
                  cycleMode()
                }
              }}
              rows={3}
              placeholder={disabled ? 'Workspace is not ready' : busy ? 'Type to queue a message for when this turn ends… (Enter to queue)' : 'Describe the change across your repos… (Enter to send, Shift+Enter for newline)'}
              className="w-full resize-none bg-transparent px-3 pt-3 text-[13px] outline-none placeholder:text-muted"
            />
            <div className="flex items-center gap-2 px-2 pb-2">
              <ModePicker mode={mode} onChange={changeMode} />
              <span className="text-[11px] text-muted">
                {chat?.model ?? `model: ${settingsModel}`}
                {chat?.lastResult && (
                  <>
                    {' '}
                    · session ${chat.lastResult.costUsd.toFixed(2)} · {(chat.lastResult.durationMs / 1000).toFixed(1)}s
                    {chat.lastResult.byModel && chat.lastResult.byModel.length > 1 && (
                      <span title="Cost split by model for this session"> ({chat.lastResult.byModel.map((m) => `${shortModel(m.model)} $${m.costUsd.toFixed(2)}`).join(', ')})</span>
                    )}
                  </>
                )}
              </span>
              <span className="ml-auto" />
              <Button size="sm" variant="ghost" title="New workspace with a copy of this conversation (like /fork)" onClick={() => setForkDlg(true)} disabled={busy || disabled}>
                <GitFork size={13} /> Fork
              </Button>
              <Button size="sm" variant="ghost" title="Continue a past Claude Code session here (like /resume)" onClick={() => setResumeDlg(true)} disabled={busy}>
                <History size={13} /> Resume
              </Button>
              <Button size="sm" variant="ghost" title="Start a fresh session" onClick={() => void reset(workspaceId)} disabled={busy}>
                <RotateCcw size={13} /> New session
              </Button>
              {busy ? (
                <>
                  <Button size="sm" onClick={onSubmit} disabled={disabled || !draft.trim()} title="Deliver when the current turn ends">
                    <Send size={12} /> Queue
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void interrupt(workspaceId)}>
                    <Square size={12} /> Stop
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="primary" onClick={onSubmit} disabled={disabled || !draft.trim()}>
                  <Send size={12} /> Send
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
    <SubagentPanel items={items} model={chat?.model ?? settingsModel} />
    </div>
  )
}

function ModePicker({ mode, onChange }: { mode: PermissionMode; onChange: (m: PermissionMode) => void }): React.JSX.Element {
  const current = PERMISSION_MODES.find((m) => m.id === mode) ?? PERMISSION_MODES[0]
  const tone = mode === 'bypassPermissions' ? 'text-danger bg-danger/15' : mode === 'plan' ? 'text-warn bg-warn/15' : mode === 'default' ? 'text-muted bg-panel-2' : 'text-ok bg-ok/15'
  return (
    <label className={clsx('relative inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium', tone)} title={`${current.hint}. Shift+Tab cycles modes.`}>
      <ShieldCheck size={12} />
      <span>{current.label}</span>
      <span className="opacity-60">▾</span>
      <select className="absolute inset-0 cursor-pointer opacity-0" value={mode} onChange={(e) => onChange(e.target.value as PermissionMode)}>
        {PERMISSION_MODES.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} — {m.hint}
          </option>
        ))}
      </select>
    </label>
  )
}

function Message({ item }: { item: ChatItem }): React.JSX.Element {
  if (item.role === 'system') {
    const text = item.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    const level = item.level ?? 'info'
    return (
      <div className={clsx('flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]', level === 'error' ? 'border-danger/40 bg-danger/10 text-danger' : level === 'warn' ? 'border-warn/40 bg-warn/10 text-warn' : 'border-border bg-panel text-muted')}>
        {level === 'error' ? <XCircle size={14} className="mt-0.5 shrink-0" /> : level === 'warn' ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> : <Info size={14} className="mt-0.5 shrink-0" />}
        <span className="whitespace-pre-wrap">{text}</span>
      </div>
    )
  }
  if (item.role === 'user') {
    const text = item.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent-2/25 px-3.5 py-2 text-[13px]">{text}</div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {item.blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  )
}

function Block({ block }: { block: ChatBlock }): React.JSX.Element | null {
  if (block.type === 'text') return block.text.trim() ? <Markdown text={block.text} /> : null
  if (block.type === 'thinking') return block.text.trim() ? <Collapsible label="Thinking" muted body={block.text} /> : null
  return <ToolCall block={block} />
}

/** Who is doing what: the orchestrator, delegations in flight, and how many are done. */
function agentTypeOf(d: ChatToolBlock): string {
  const i = (d.input ?? {}) as Record<string, unknown>
  return typeof i.subagent_type === 'string' ? i.subagent_type : typeof i.description === 'string' ? i.description.slice(0, 30) : 'agent'
}

function CrewBar({ items, busy, model, crewNames }: { items: ChatItem[]; busy: boolean; model: string; crewNames: string[] }): React.JSX.Element | null {
  const [, setPanel] = usePanel()
  const openPanel = (id: string): void => setPanel({ kind: 'delegation', id })
  const delegations = items.flatMap((it) => (it.role === 'assistant' ? it.blocks.filter((b): b is ChatToolBlock => b.type === 'tool' && (b.name === 'Agent' || b.name === 'Task')) : []))
  const running = delegations.filter((d) => !d.done)
  const done = delegations.filter((d) => d.done).length
  if (!busy && delegations.length === 0 && crewNames.length === 0) return null
  const typeOf = agentTypeOf
  return (
    <div className="relative flex flex-wrap items-center gap-1.5 px-1 pb-2 text-[11px]">
      <span className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5', busy ? 'border-accent/50 text-accent' : 'border-border text-muted')} title="The model you are talking to. It plans, delegates and integrates.">
        {busy && running.length === 0 ? <Spinner /> : <Users size={11} />}
        orchestrator <span className="font-mono opacity-70">{shortModel(model)}</span>
      </span>
      {running.map((d) => (
        <button key={d.toolUseId} onClick={() => openPanel(d.toolUseId)} className="inline-flex items-center gap-1.5 rounded-full border border-warn/50 bg-warn/10 px-2 py-0.5 text-warn hover:bg-warn/20" title="Click to watch this subagent">
          <Spinner /> {typeOf(d)}
          {d.sub?.model && <span className="font-mono opacity-70">{shortModel(d.sub.model)}</span>}
          {d.sub && <span className="opacity-70">{d.sub.toolCalls} calls{d.sub.lastTool ? ` · ${d.sub.lastTool}` : ''}</span>}
        </button>
      ))}
      <button onClick={() => setPanel({ kind: 'activity' })} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted hover:text-text" title="Activity: who did what in this session">
        <ListTree size={11} /> Activity{done > 0 ? ` · ${done} done` : ''}
      </button>
      {crewNames.length > 0 && running.length === 0 && (
        <span className="ml-auto text-muted" title="Crew available to the orchestrator this session">
          crew: {crewNames.join(', ')}
        </span>
      )}
    </div>
  )
}

function ForkDialog({ wsId, wsName, branch, onClose }: { wsId: string; wsName: string; branch: string; onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState(`${wsName} fork`)
  const [busy, setBusy] = useState(false)
  const select = useApp((s) => s.select)
  const setError = useApp((s) => s.setError)
  const submit = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const ws = await api.invoke('workspaces:fork', wsId, name.trim())
      select(ws.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title="Fork this conversation" onClose={onClose} width={460}>
      <p className="mb-3 text-[12px] text-muted">
        Creates a new workspace with a worktree per repo, each on a new branch cut from <code className="rounded bg-panel-2 px-1">{branch}</code> as it is now, and a forked copy of the Claude session so the new chat keeps this context. Uncommitted changes stay here.
      </p>
      <Field label="New workspace name" hint="Also the new branch name.">
        <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
          <GitFork size={13} /> {busy ? 'Forking…' : 'Fork'}
        </Button>
      </div>
    </Dialog>
  )
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/\[.*\]$/, '')
}

function SubagentSteps({ block, compact }: { block: ChatToolBlock; compact?: boolean }): React.JSX.Element {
  const steps = block.sub?.steps ?? []
  const input = (block.input ?? {}) as Record<string, unknown>
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!compact) endRef.current?.scrollIntoView({ block: 'end' })
  }, [steps.length, compact])
  return (
    <div className="flex flex-col gap-2">
      {typeof input.prompt === 'string' && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">Brief from the orchestrator</div>
          <div className={clsx('whitespace-pre-wrap rounded-md border border-border bg-bg p-2 text-[12px]', compact && 'max-h-32 overflow-auto')}>{input.prompt}</div>
        </div>
      )}
      <div>
        <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">
          Activity · {steps.filter((s) => s.kind === 'tool').length} tool call{steps.filter((s) => s.kind === 'tool').length === 1 ? '' : 's'}
          {!block.done && <span className="ml-2 inline-flex items-center gap-1 text-warn"><Spinner /> running</span>}
        </div>
        <div className={clsx('flex flex-col gap-0.5 rounded-md border border-border bg-bg p-2', compact && 'max-h-64 overflow-auto')}>
          {steps.length === 0 && <div className="text-[12px] text-muted">Waiting for the first step…</div>}
          {steps.map((s, i) =>
            s.kind === 'tool' ? (
              <div key={i} className="flex items-baseline gap-2 font-mono text-[11px]">
                <span className="shrink-0 text-accent">{s.name}</span>
                <span className="truncate text-muted" title={s.detail}>{s.detail}</span>
              </div>
            ) : (
              <div key={i} className="whitespace-pre-wrap py-0.5 text-[12px]">{s.detail}</div>
            )
          )}
          <div ref={endRef} />
        </div>
      </div>
      {block.done && block.result !== undefined && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">Result returned to the orchestrator</div>
          <div className={clsx('rounded-md border border-border bg-bg p-2', compact && 'max-h-48 overflow-auto')}>
            <Markdown text={block.result.slice(0, 20_000)} />
          </div>
        </div>
      )}
    </div>
  )
}

/** Per-actor summary and delegation history, or one delegation's live detail. */
function SubagentPanel({ items, model }: { items: ChatItem[]; model: string }): React.JSX.Element | null {
  const [view, setView] = usePanel()
  if (view.kind === 'closed') return null
  const assistant = items.filter((it) => it.role === 'assistant')
  const allTools = assistant.flatMap((it) => it.blocks.filter((b): b is ChatToolBlock => b.type === 'tool'))
  const delegations = allTools.filter((b) => b.name === 'Agent' || b.name === 'Task')

  if (view.kind === 'delegation') {
    const block = delegations.find((b) => b.toolUseId === view.id)
    if (!block) return null
    return (
      <aside className="flex w-[440px] shrink-0 flex-col border-l border-border bg-panel">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <button className="text-muted hover:text-text" onClick={() => setView({ kind: 'activity' })} title="Back to activity">
            <ArrowLeft size={14} />
          </button>
          <Users size={14} className="text-accent" />
          <span className="text-[13px] font-semibold">{agentTypeOf(block)}</span>
          {block.sub?.model && <span className="rounded bg-panel-2 px-1 py-px font-mono text-[10px] text-muted">{shortModel(block.sub.model)}</span>}
          <span className="ml-auto text-[11px]">{block.done ? (block.isError ? <span className="text-danger">error</span> : <span className="text-ok">done</span>) : <span className="inline-flex items-center gap-1 text-warn"><Spinner /> running</span>}</span>
          <button className="ml-1 text-muted hover:text-text" onClick={() => setView({ kind: 'closed' })} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto p-3">
          <SubagentSteps block={block} />
        </div>
      </aside>
    )
  }

  // ---- activity overview ----
  const countBy = (names: string[]): [string, number][] => {
    const m = new Map<string, number>()
    for (const n of names) m.set(n, (m.get(n) ?? 0) + 1)
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }
  const orchestratorTools = countBy(allTools.filter((b) => !(b.name === 'Agent' || b.name === 'Task')).map((b) => b.name))
  const thinking = assistant.reduce((n, it) => n + it.blocks.filter((b) => b.type === 'thinking').length, 0)
  const byAgent = new Map<string, ChatToolBlock[]>()
  for (const d of delegations) byAgent.set(agentTypeOf(d), [...(byAgent.get(agentTypeOf(d)) ?? []), d])
  const active = delegations.filter((d) => !d.done)
  const history = delegations.filter((d) => d.done).reverse()
  const verbFor = (d: ChatToolBlock): string => {
    const desc = (d.input as Record<string, unknown>)?.description
    return typeof desc === 'string' ? desc : 'task'
  }
  const Row = ({ d }: { d: ChatToolBlock }): React.JSX.Element => (
    <button onClick={() => setView({ kind: 'delegation', id: d.toolUseId })} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-panel-2">
      {d.done ? <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', d.isError ? 'bg-danger' : 'bg-ok')} /> : <Spinner />}
      <span className="shrink-0 text-[12px] font-medium">{agentTypeOf(d)}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={verbFor(d)}>{verbFor(d)}</span>
      {d.sub?.model && <span className="shrink-0 font-mono text-[10px] text-muted">{shortModel(d.sub.model)}</span>}
      <span className="shrink-0 text-[11px] text-muted">{d.sub?.toolCalls ?? 0} calls</span>
    </button>
  )
  return (
    <aside className="flex w-[440px] shrink-0 flex-col border-l border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ListTree size={14} className="text-accent" />
        <span className="text-[13px] font-semibold">Activity</span>
        <button className="ml-auto text-muted hover:text-text" onClick={() => setView({ kind: 'closed' })} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Who did what</div>
        <div className="mb-4 flex flex-col gap-1.5">
          <div className="rounded-lg border border-border px-3 py-2">
            <div className="flex items-center gap-2 text-[12px]">
              <Users size={12} className="text-accent" />
              <span className="font-medium">orchestrator</span>
              <span className="font-mono text-[10px] text-muted">{shortModel(model)}</span>
              <span className="ml-auto text-[11px] text-muted">{assistant.length} turn{assistant.length === 1 ? '' : 's'}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted">
              {thinking > 0 && <span className="rounded bg-panel-2 px-1.5 py-px">think ×{thinking}</span>}
              {delegations.length > 0 && <span className="rounded bg-panel-2 px-1.5 py-px">delegate ×{delegations.length}</span>}
              {orchestratorTools.map(([n, c]) => (
                <span key={n} className="rounded bg-panel-2 px-1.5 py-px">
                  {n} ×{c}
                </span>
              ))}
            </div>
          </div>
          {Array.from(byAgent.entries()).map(([name, list]) => {
            const calls = list.reduce((n, d) => n + (d.sub?.toolCalls ?? 0), 0)
            const model = list.find((d) => d.sub?.model)?.sub?.model
            const running = list.filter((d) => !d.done).length
            const failed = list.filter((d) => d.done && d.isError).length
            return (
              <div key={name} className="rounded-lg border border-border px-3 py-2">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="font-medium">{name}</span>
                  {model && <span className="font-mono text-[10px] text-muted">{shortModel(model)}</span>}
                  <span className="ml-auto text-[11px] text-muted">
                    {list.length} delegation{list.length === 1 ? '' : 's'}
                    {running ? ` · ${running} running` : ''}
                    {failed ? ` · ${failed} failed` : ''}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted">{calls} tool call{calls === 1 ? '' : 's'} in total</div>
              </div>
            )
          })}
          {delegations.length === 0 && <div className="text-[12px] text-muted">No delegations yet in this session.</div>}
        </div>
        {active.length > 0 && (
          <>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-warn">Active</div>
            <div className="mb-4 flex flex-col">
              {active.map((d) => (
                <Row key={d.toolUseId} d={d} />
              ))}
            </div>
          </>
        )}
        {history.length > 0 && (
          <>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">History</div>
            <div className="flex flex-col">
              {history.map((d) => (
                <Row key={d.toolUseId} d={d} />
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

function ToolCall({ block }: { block: ChatToolBlock }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [, setPanel] = usePanel()
  const openPanel = (id: string): void => setPanel({ kind: 'delegation', id })
  const input = (block.input ?? {}) as Record<string, unknown>
  const isAgent = block.name === 'Agent' || block.name === 'Task'
  const headline =
    typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : typeof input.pattern === 'string' ? input.pattern : typeof input.description === 'string' ? input.description : ''
  const agentType = typeof input.subagent_type === 'string' ? input.subagent_type : 'agent'
  return (
    <div className={clsx('rounded-md border text-[12px]', block.isError ? 'border-danger/40' : isAgent ? 'border-accent/40' : 'border-border')}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-panel">
        <ChevronRight size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
        {isAgent ? (
          <>
            <Users size={12} className="shrink-0 text-accent" />
            <span className="font-medium text-accent">{agentType}</span>
            {block.sub?.model && <span className="rounded bg-panel-2 px-1 py-px font-mono text-[10px] text-muted">{shortModel(block.sub.model)}</span>}
            <span className="truncate text-muted">{headline}</span>
            <span className="ml-auto shrink-0 text-muted">
              {block.sub ? `${block.sub.toolCalls} tool call${block.sub.toolCalls === 1 ? '' : 's'}${!block.done && block.sub.lastTool ? ` · ${block.sub.lastTool}` : ''}` : ''}
            </span>
          </>
        ) : (
          <>
            <span className="font-medium">{block.name}</span>
            <span className="truncate font-mono text-muted">{headline}</span>
          </>
        )}
        <span className="ml-2 shrink-0">{block.done ? (block.isError ? <span className="text-danger">error</span> : <span className="text-ok">done</span>) : <Spinner />}</span>
      </button>
      {open && isAgent && (
        <div className="border-t border-border px-2.5 py-2 text-[12px]">
          <button className="mb-2 text-accent hover:underline" onClick={() => openPanel(block.toolUseId)}>
            Open activity panel →
          </button>
          <SubagentSteps block={block} compact />
        </div>
      )}
      {open && !isAgent && (
        <div className="border-t border-border bg-bg px-2.5 py-2 font-mono text-[11px]">
          <div className="mb-1 text-muted">input</div>
          <pre className="mb-2 max-h-60 overflow-auto whitespace-pre-wrap">{JSON.stringify(block.input, null, 2)}</pre>
          {block.result !== undefined && (
            <>
              <div className="mb-1 text-muted">result</div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap">{block.result.slice(0, 20_000)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Collapsible({ label, body, muted }: { label: string; body: string; muted?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={clsx('text-[12px]', muted && 'text-muted')}>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 hover:text-text">
        <ChevronRight size={12} className={clsx('transition-transform', open && 'rotate-90')} /> {label}
      </button>
      {open && <pre className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-bg p-2 font-sans text-[12px]">{body}</pre>}
    </div>
  )
}
