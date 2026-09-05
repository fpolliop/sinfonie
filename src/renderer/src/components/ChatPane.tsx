import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, Square, RotateCcw, Send, ShieldCheck, XCircle, AlertTriangle, Info, History, Users, GitFork, ListTree, ArrowLeft, StickyNote, Paperclip, X } from 'lucide-react'
import { imageFiles } from '@/lib/images'
import type { ContextUsage, ChatTurnResult, AgentEvent, ChatImageRef, LimitAlternative } from '@shared/types'
import { NotesPanel } from './NotesPanel'
import { useNotes } from '@/stores/notes'
import { api } from '@/lib/api'
import { PERMISSION_MODES, type PermissionMode } from '@shared/types'
import { QuestionCard } from './QuestionCard'
import { ResumeDialog } from './ResumeDialog'
import { Dialog, Field, inputCls } from './ui'
import { useChat } from '@/stores/chat'
import { useApp } from '@/stores/app'
import { useResources, subscribeResources } from '@/stores/resources'
import { Markdown } from '@/lib/markdown'
import { Button, Spinner } from './ui'
import type { ChatBlock, ChatItem, ChatToolBlock } from '@shared/types'

/** Right panel state: closed, the activity overview, or one delegation's detail. */
type PanelView = { kind: 'closed' } | { kind: 'activity' } | { kind: 'delegation'; id: string } | { kind: 'notes' }
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
  const { send, interrupt, reset, setDraft, load, unqueue, addImages, removeImage } = useChat()

  useEffect(() => {
    void load(workspaceId)
  }, [workspaceId, load])
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const scrollRef = useRef<HTMLDivElement>(null)
  const items = chat?.items ?? []
  const busy = chat?.busy ?? false
  const draft = chat?.draft ?? ''
  const pendingImages = chat?.images ?? NO_IMAGES
  const fileInput = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [taHeight, setTaHeight] = useState<number>(() => Number(localStorage.getItem('sinfonie.composerHeight')) || 0)
  const queue = chat?.queue ?? []
  const disabled = ws?.status !== 'ready'
  const canSend = !disabled && (Boolean(draft.trim()) || pendingImages.length > 0)
  const settingsModel = useApp((s) => s.settings.model)
  const settingsMode = useApp((s) => s.settings.permissionMode)
  const budgetMode = useApp((s) => {
    const w = s.workspaces.find((x) => x.id === workspaceId)
    const sp = s.spaces.find((x) => x.id === w?.spaceId)
    return sp?.budgetMode ?? s.settings.budgetMode ?? false
  })
  const engineLabel = useApp((s) => {
    const sp = s.spaces.find((x) => x.id === ws?.spaceId)
    const e = sp?.engine ?? s.settings.engine ?? 'claude-code'
    return e === 'native' ? 'native' : e === 'claude-code' ? 'claude code' : e
  })
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
    if (!canSend) return
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
          {chat?.limit && <LimitCard workspaceId={workspaceId} ev={chat.limit} />}
          <CrewBar items={items} busy={busy} model={chat?.model ?? settingsModel} crewNames={crewNames} />
          <div
            className="rounded-xl border border-border bg-panel focus-within:border-accent"
            onDragOver={(e) => {
              if (imageFiles(e.dataTransfer).length) e.preventDefault()
            }}
            onDrop={(e) => {
              const files = imageFiles(e.dataTransfer)
              if (files.length) {
                e.preventDefault()
                void addImages(workspaceId, files)
              }
            }}
          >
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {pendingImages.map((img) => (
                  <div key={img.id} className="group relative">
                    <img src={img.preview} alt={img.name} className="h-16 w-16 rounded-md border border-border object-cover" />
                    <button className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-panel p-0.5 text-muted opacity-0 hover:text-danger group-hover:opacity-100" title="Remove" onClick={() => removeImage(workspaceId, img.id)}>
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input ref={fileInput} type="file" accept="image/*" multiple className="hidden" onChange={(e) => (e.target.files?.length && void addImages(workspaceId, Array.from(e.target.files)), (e.target.value = ''))} />
            <textarea
              value={draft}
              disabled={disabled}
              onChange={(e) => setDraft(workspaceId, e.target.value)}
              onPaste={(e) => {
                const files = imageFiles(e.clipboardData)
                if (files.length) {
                  e.preventDefault()
                  void addImages(workspaceId, files)
                }
              }}
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
              ref={taRef}
              style={taHeight ? { height: taHeight } : undefined}
              onMouseUp={() => {
                const h = taRef.current?.offsetHeight
                if (h && h !== taHeight) {
                  setTaHeight(h)
                  localStorage.setItem('sinfonie.composerHeight', String(h))
                }
              }}
              placeholder={disabled ? 'Workspace is not ready' : busy ? 'Type to queue a message for when this turn ends… (Enter to queue)' : 'Describe the change across your repos… (Enter to send, Shift+Enter for newline, paste or drop images)'}
              className="min-h-[64px] max-h-[60vh] w-full resize-y bg-transparent px-3 pt-3 text-[13px] outline-none placeholder:text-muted"
            />
            <div className="flex items-center gap-2 px-2 pb-2">
              <ModePicker mode={mode} onChange={changeMode} />
              <SessionPill workspaceId={workspaceId} engineLabel={engineLabel} budgetMode={budgetMode} model={chat?.model ?? settingsModel} contextTokens={chat?.contextTokens} contextWindow={chat?.contextWindow} cacheRead={chat?.contextCacheRead} history={chat?.contextHistory} result={chat?.lastResult} busy={busy} onNewSession={() => void reset(workspaceId)} />
              <span className="ml-auto" />
              <Button size="sm" variant="ghost" title="Attach images (or paste / drop them into the message)" onClick={() => fileInput.current?.click()} disabled={disabled}>
                <Paperclip size={13} />
              </Button>
              <NotesButton workspaceId={workspaceId} />
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
                  <Button size="sm" onClick={onSubmit} disabled={!canSend} title="Deliver when the current turn ends">
                    <Send size={12} /> Queue
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void interrupt(workspaceId)}>
                    <Square size={12} /> Stop
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="primary" onClick={onSubmit} disabled={!canSend}>
                  <Send size={12} /> Send
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
    <SubagentPanel items={items} model={chat?.model ?? settingsModel} workspaceId={workspaceId} />
    </div>
  )
}

function ModePicker({ mode, onChange }: { mode: PermissionMode; onChange: (m: PermissionMode) => void }): React.JSX.Element {
  const current = PERMISSION_MODES.find((m) => m.id === mode) ?? PERMISSION_MODES[0]
  const tone = mode === 'bypassPermissions' ? 'text-danger bg-danger/15' : mode === 'plan' ? 'text-warn bg-warn/15' : mode === 'default' ? 'text-muted bg-panel-2' : 'text-ok bg-ok/15'
  return (
    <label data-tour="mode" className={clsx('relative inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium', tone)} title={`${current.hint}. Shift+Tab cycles modes.`}>
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
    const images = item.blocks.filter((b): b is Extract<typeof b, { type: 'image' }> => b.type === 'image').map((b) => b.image)
    return (
      <div className="flex flex-col items-end gap-1.5">
        {images.length > 0 && (
          <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
            {images.map((img) => (
              <ChatImage key={img.id} image={img} />
            ))}
          </div>
        )}
        {text.trim() && <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent-2/25 px-3.5 py-2 text-[13px]">{text}</div>}
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
  if (block.type === 'image') return <ChatImage image={block.image} />
  return <ToolCall block={block} />
}

const NO_IMAGES: never[] = []

/** The session's vitals in one small pill; the details, the context window and Compact open on click. */
function SessionPill({ workspaceId, engineLabel, budgetMode, model, contextTokens, contextWindow, cacheRead, history, result, busy, onNewSession }: { workspaceId: string; engineLabel: string; budgetMode: boolean; model: string; contextTokens?: number; contextWindow?: number; cacheRead?: number; history?: number[]; result?: ChatTurnResult; busy: boolean; onNewSession: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [usage, setUsage] = useState<ContextUsage | null>(null)
  const [detail, setDetail] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const setError = useApp((s) => s.setError)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  useEffect(() => {
    if (!open) return
    api.invoke('agent:contextUsage', workspaceId).then(setUsage).catch(() => setUsage(null))
  }, [open, workspaceId, contextTokens])
  useEffect(() => {
    if (compacting && contextTokens !== undefined) setCompacting(false)
  }, [contextTokens, compacting])
  const window = usage?.maxTokens || contextWindow || 200_000
  const used = usage?.totalTokens ?? contextTokens ?? 0
  const pct = Math.min(100, (used / window) * 100)
  const tone = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok'
  const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
  const cacheShare = contextTokens && cacheRead ? Math.round((cacheRead / contextTokens) * 100) : null
  const compact = (): void => {
    setCompacting(true)
    api.invoke('agent:compact', workspaceId).catch((err) => {
      setCompacting(false)
      setError(err instanceof Error ? err.message : String(err))
    })
  }
  const usedCats = (usage?.categories ?? []).filter((c) => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const buffer = (usage?.categories ?? []).find((c) => c.kind === 'buffer')
  const byServer = Object.entries((usage?.mcpTools ?? []).reduce<Record<string, number>>((m, t) => ((m[t.serverName] = (m[t.serverName] ?? 0) + t.tokens), m), {})).sort((a, b) => b[1] - a[1])
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:bg-panel-2 hover:text-text" title="Session and context details">
        <span className="rounded bg-panel-2 px-1 py-px text-[10px] uppercase tracking-wide">{engineLabel}</span>
        {budgetMode && <span className="rounded bg-ok/15 px-1 py-px text-[10px] uppercase tracking-wide text-ok">budget</span>}
        <span className="font-mono">{shortModel(model)}</span>
        {contextTokens ? (
          <span className={clsx('inline-flex items-center gap-1 font-mono', tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : '')} title={`Context: ${contextTokens.toLocaleString()} of ${window.toLocaleString()} tokens`}>
            · <span className="inline-block h-1.5 w-8 overflow-hidden rounded-full bg-panel-2 align-middle"><span className={clsx('block h-full', tone === 'danger' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : 'bg-accent/70')} style={{ width: `${pct}%` }} /></span> {k(contextTokens)}
          </span>
        ) : null}
        {result && <span className="font-mono">· ${result.costUsd.toFixed(2)}</span>}
        <ChevronRight size={11} className={clsx('transition-transform', open ? '-rotate-90' : 'rotate-90')} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-[360px] rounded-lg border border-border bg-panel p-3 text-[12px] shadow-2xl">
          {/* context window */}
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-muted">Context window</span>
            <span className="font-mono text-[11px]">
              {k(used)} / {k(window)} · {Math.round(pct)}%
            </span>
          </div>
          <div className="mb-1.5 flex h-2 w-full overflow-hidden rounded-full bg-panel-2" title={usedCats.map((c) => `${c.name}: ${k(c.tokens)}`).join('\n')}>
            {usedCats.length > 0
              ? usedCats.map((c, i) => <span key={c.name} className={clsx('h-full', ['bg-accent', 'bg-accent/75', 'bg-accent/55', 'bg-accent/40', 'bg-accent/30', 'bg-accent/25'][i % 6])} style={{ width: `${(c.tokens / window) * 100}%` }} title={`${c.name}: ${k(c.tokens)}`} />)
              : <span className={clsx('h-full', tone === 'danger' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : 'bg-accent/70')} style={{ width: `${pct}%` }} />}
            {buffer && <span className="ml-auto h-full bg-border/60" style={{ width: `${(buffer.tokens / window) * 100}%` }} title={`${buffer.name}: ${k(buffer.tokens)} reserved for compaction`} />}
          </div>
          {usedCats.length > 0 && (
            <div className="mb-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
              {usedCats.slice(0, 6).map((c) => (
                <div key={c.name} className="flex justify-between gap-2">
                  <span className="truncate text-muted">{c.name}</span>
                  <span className="font-mono">{k(c.tokens)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
            {history && history.length > 1 && (
              <span className="inline-flex items-end gap-px" title="Context size over the last turns">
                {history.slice(-24).map((h, i) => (
                  <span key={i} className="w-[3px] rounded-sm bg-accent/60" style={{ height: `${Math.max(2, (h / Math.max(...history)) * 14)}px` }} />
                ))}
              </span>
            )}
            {cacheShare != null && <span title="Share of the context served from the prompt cache on the last call (cheaper than fresh input)">cache {cacheShare}%</span>}
            {history && history.length > 1 && <span>+{k(Math.max(0, history[history.length - 1] - history[history.length - 2]))} last turn</span>}
            {usage?.overLimit && <span className="text-danger">{k(usage.overLimit.tokensOver)} over the {usage.overLimit.kind === 'hard_limit' ? 'hard limit' : 'compaction window'}</span>}
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant={pct >= 60 ? 'primary' : 'subtle'} disabled={busy || compacting || !contextTokens} onClick={compact} title="Ask Claude Code to summarise the conversation so far in place. Detail becomes a summary; the work continues with a much smaller context.">
              {compacting ? <Spinner /> : <History size={12} />} {compacting ? 'Compacting…' : 'Compact conversation'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onNewSession} title="Start from an empty context">
              <RotateCcw size={12} /> New session
            </Button>
            {(byServer.length > 0 || (usage?.agents.length ?? 0) > 0 || (usage?.memoryFiles.length ?? 0) > 0) && (
              <button className="ml-auto text-[11px] text-accent hover:underline" onClick={() => setDetail(!detail)}>
                {detail ? 'Hide' : 'What fills it'}
              </button>
            )}
          </div>
          {detail && usage && (
            <div className="mb-2 max-h-[220px] overflow-auto rounded-md border border-border bg-bg p-2 text-[11px]">
              {byServer.length > 0 && (
                <>
                  <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted">MCP tool definitions</div>
                  {byServer.map(([srv, t]) => (
                    <div key={srv} className="flex justify-between">
                      <span>{srv}</span>
                      <span className="font-mono">{k(t)}</span>
                    </div>
                  ))}
                </>
              )}
              {usage.agents.length > 0 && (
                <>
                  <div className="mb-0.5 mt-1.5 text-[10px] uppercase tracking-wide text-muted">Crew and agents</div>
                  {usage.agents.map((a) => (
                    <div key={a.agentType} className="flex justify-between">
                      <span>{a.agentType}</span>
                      <span className="font-mono">{k(a.tokens)}</span>
                    </div>
                  ))}
                </>
              )}
              {usage.memoryFiles.length > 0 && (
                <>
                  <div className="mb-0.5 mt-1.5 text-[10px] uppercase tracking-wide text-muted">Memory and instructions</div>
                  {usage.memoryFiles.map((m) => (
                    <div key={m.path} className="flex justify-between gap-2">
                      <span className="truncate" title={m.path}>{m.path.split('/').slice(-2).join('/')}</span>
                      <span className="font-mono">{k(m.tokens)}</span>
                    </div>
                  ))}
                </>
              )}
              {usage.skills.length > 0 && (
                <>
                  <div className="mb-0.5 mt-1.5 text-[10px] uppercase tracking-wide text-muted">Skills</div>
                  {usage.skills.map((sk) => (
                    <div key={sk.name} className="flex justify-between">
                      <span>{sk.name}</span>
                      <span className="font-mono">{k(sk.tokens)}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
          {/* session */}
          <div className="border-t border-border pt-2">
            <Row k="Engine" v={engineLabel} />
            <Row k="Model" v={model} />
            {budgetMode && <Row k="Budget mode" v="Sonnet orchestrator, low effort, two subagents, per-turn cap" />}
            {result && (
              <>
                <Row k="Session cost" v={`$${result.costUsd.toFixed(2)}`} />
                <Row k="Last turn" v={`${(result.durationMs / 1000).toFixed(1)}s · ${result.numTurns} step${result.numTurns === 1 ? '' : 's'}`} />
                {result.byModel && result.byModel.length > 0 && (
                  <div className="mt-1.5">
                    <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted">By model</div>
                    {result.byModel.map((m) => (
                      <div key={m.model} className="flex justify-between font-mono text-[11px]">
                        <span>{shortModel(m.model)}</span>
                        <span>
                          ${m.costUsd.toFixed(2)} · {k(m.outputTokens)} out
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="mt-2 border-t border-border pt-2 text-[11px] text-muted">Every message re-reads the whole context. Compact when a task is done, or start a new session for the next one. Costs are estimates at list price.</div>
        </div>
      )}
    </div>
  )
}
function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }): React.JSX.Element {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="w-[88px] shrink-0 text-muted">{k}</span>
      <span className={clsx('min-w-0 flex-1', warn && 'text-warn')}>{v}</span>
    </div>
  )
}

/** Near or past a subscription limit: what happened and the ways forward, each one click. */
function LimitCard({ workspaceId, ev }: { workspaceId: string; ev: Extract<AgentEvent, { type: 'limit' }> }): React.JSX.Element {
  const [busyChoice, setBusyChoice] = useState<string | null>(null)
  const pick = (a: LimitAlternative): void => {
    setBusyChoice(a.kind + (a.id ?? ''))
    void api.invoke('usage:resolveLimit', workspaceId, ev.itemId, a).catch(() => setBusyChoice(null))
  }
  return (
    <div className={clsx('mb-2 rounded-xl border p-3 text-[12px]', ev.mode === 'hit' ? 'border-danger/40 bg-danger/10' : 'border-warn/40 bg-warn/10')}>
      <div className="mb-1 flex items-center gap-2 font-medium">
        <AlertTriangle size={14} className={ev.mode === 'hit' ? 'text-danger' : 'text-warn'} />
        {ev.mode === 'hit' ? 'Usage limit reached' : 'Low on usage'}
        {ev.utilization != null && ev.mode === 'preflight' && <span className="font-mono text-[11px] text-muted">{Math.round(ev.utilization * 100)}% used</span>}
      </div>
      <p className="mb-2 text-muted">{ev.text}</p>
      <div className="flex flex-wrap gap-1.5">
        {ev.alternatives.map((a) => (
          <button
            key={a.kind + (a.id ?? '')}
            disabled={busyChoice !== null}
            title={a.hint}
            onClick={() => pick(a)}
            className={clsx('rounded-md px-2 py-1 text-[11px]', a.kind === 'proceed' || (ev.mode === 'hit' && a.kind === 'account') ? 'bg-accent-2 text-white hover:bg-accent' : a.kind === 'cancel' ? 'text-muted hover:text-text' : 'border border-border hover:bg-panel-2', busyChoice === a.kind + (a.id ?? '') && 'opacity-60')}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** A stored image in the transcript; click to open it full size in the default viewer. */
function ChatImage({ image }: { image: ChatImageRef }): React.JSX.Element {
  return (
    <button className="overflow-hidden rounded-lg border border-border bg-bg" title={`${image.name} · click to open`} onClick={() => void api.invoke('shell:openExternal', `file://${image.path}`)}>
      <img src={image.url} alt={image.name} className="max-h-[240px] max-w-[320px] object-contain" />
    </button>
  )
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
      <button data-tour="activity" onClick={() => setPanel({ kind: 'activity' })} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted hover:text-text" title="Activity: who did what in this session">
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
function SubagentPanel({ items, model, workspaceId }: { items: ChatItem[]; model: string; workspaceId: string }): React.JSX.Element | null {
  const [view, setView] = usePanel()
  if (view.kind === 'closed') return null
  if (view.kind === 'notes') return <NotesPanel workspaceId={workspaceId} onClose={() => setView({ kind: 'closed' })} />
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
          {!block.done && <StopTaskButton workspaceId={workspaceId} toolUseId={block.toolUseId} />}
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

  // ---- activity tree ----
  return (
    <aside className="flex w-[440px] shrink-0 flex-col border-l border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ListTree size={14} className="text-accent" />
        <span className="text-[13px] font-semibold">Activity</span>
        <button className="ml-auto text-muted hover:text-text" onClick={() => setView({ kind: 'closed' })} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-auto p-2">
        <ActivityTree items={items} model={model} onOpen={(id) => setView({ kind: 'delegation', id })} />
      </div>
    </aside>
  )
}

/** Stop one running subagent through the governor; shown when the task is known to it. */
function StopTaskButton({ workspaceId, toolUseId }: { workspaceId: string; toolUseId: string }): React.JSX.Element | null {
  const snap = useResources((s) => s.snapshot)
  useEffect(() => subscribeResources(), [])
  const task = snap?.sessions.find((s) => s.workspaceId === workspaceId)?.tasks.find((t) => t.toolUseId === toolUseId)
  if (!task) return null
  return (
    <button className="ml-2 inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted hover:border-danger hover:text-danger" title="Stop this subagent; the orchestrator is told it was stopped" onClick={() => api.invoke('resources:stopTask', workspaceId, task.taskId).catch(() => undefined)}>
      <Square size={10} /> Stop
    </button>
  )
}

/**
 * Orchestrator → agents → tasks → steps, each level collapsible. Active tasks
 * start expanded so their live steps are visible; finished ones start closed.
 */
function ActivityTree({ items, model, onOpen }: { items: ChatItem[]; model: string; onOpen: (id: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const isOpen = (key: string, fallback: boolean): boolean => open[key] ?? fallback
  const toggle = (key: string, fallback: boolean): void => setOpen((o) => ({ ...o, [key]: !isOpen(key, fallback) }))

  const assistant = items.filter((it) => it.role === 'assistant')
  const allTools = assistant.flatMap((it) => it.blocks.filter((b): b is ChatToolBlock => b.type === 'tool'))
  const delegations = allTools.filter((b) => b.name === 'Agent' || b.name === 'Task')
  const own = allTools.filter((b) => !(b.name === 'Agent' || b.name === 'Task'))
  const thinking = assistant.reduce((n, it) => n + it.blocks.filter((b) => b.type === 'thinking').length, 0)
  const countBy = (names: string[]): [string, number][] => {
    const m = new Map<string, number>()
    for (const n of names) m.set(n, (m.get(n) ?? 0) + 1)
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }
  const byAgent = new Map<string, ChatToolBlock[]>()
  for (const d of delegations) byAgent.set(agentTypeOf(d), [...(byAgent.get(agentTypeOf(d)) ?? []), d])
  const descOf = (d: ChatToolBlock): string => {
    const i = (d.input ?? {}) as Record<string, unknown>
    return typeof i.description === 'string' ? i.description : 'task'
  }
  const Chevron = ({ on }: { on: boolean }): React.JSX.Element => <ChevronRight size={11} className={clsx('shrink-0 transition-transform', on && 'rotate-90')} />
  const Tags = ({ pairs }: { pairs: [string, number][] }): React.JSX.Element => (
    <div className="flex flex-wrap gap-1">
      {pairs.map(([n, c]) => (
        <span key={n} className="rounded bg-panel-2 px-1.5 py-px text-[10px] text-muted">
          {n.replace(/^mcp__/, '')} ×{c}
        </span>
      ))}
    </div>
  )

  const rootOpen = isOpen('root', true)
  return (
    <div className="text-[12px]">
      {/* root: orchestrator */}
      <button onClick={() => toggle('root', true)} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left hover:bg-panel-2">
        <Chevron on={rootOpen} />
        <Users size={12} className="shrink-0 text-accent" />
        <span className="font-medium">orchestrator</span>
        <span className="font-mono text-[10px] text-muted">{shortModel(model)}</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted">
          {assistant.length} turn{assistant.length === 1 ? '' : 's'} · think ×{thinking} · delegate ×{delegations.length}
        </span>
      </button>
      {rootOpen && (
        <div className="ml-3 border-l border-border pl-2">
          {own.length > 0 && (
            <div className="px-1.5 py-1">
              <Tags pairs={countBy(own.map((b) => b.name))} />
            </div>
          )}
          {byAgent.size === 0 && <div className="px-1.5 py-1 text-muted">No delegations yet in this session.</div>}
          {Array.from(byAgent.entries()).map(([name, list]) => {
            const key = `agent:${name}`
            const on = isOpen(key, true)
            const calls = list.reduce((n, d) => n + (d.sub?.toolCalls ?? 0), 0)
            const agentModel = list.find((d) => d.sub?.model)?.sub?.model
            const running = list.filter((d) => !d.done).length
            return (
              <div key={name}>
                <button onClick={() => toggle(key, true)} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left hover:bg-panel-2">
                  <Chevron on={on} />
                  <span className="font-medium">{name}</span>
                  {agentModel && <span className="font-mono text-[10px] text-muted">{shortModel(agentModel)}</span>}
                  <span className="ml-auto shrink-0 text-[11px] text-muted">
                    {list.length} task{list.length === 1 ? '' : 's'}
                    {running ? <span className="text-warn"> · {running} running</span> : ''} · {calls} calls
                  </span>
                </button>
                {on && (
                  <div className="ml-3 border-l border-border pl-2">
                    {list.map((d) => {
                      const tkey = `task:${d.toolUseId}`
                      const ton = isOpen(tkey, !d.done)
                      const steps = d.sub?.steps ?? []
                      const shown = ton ? steps.slice(-40) : []
                      return (
                        <div key={d.toolUseId}>
                          <div className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-panel-2">
                            <button onClick={() => toggle(tkey, !d.done)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                              <Chevron on={ton} />
                              {d.done ? <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', d.isError ? 'bg-danger' : 'bg-ok')} /> : <Spinner />}
                              <span className="min-w-0 flex-1 truncate" title={descOf(d)}>
                                {descOf(d)}
                              </span>
                            </button>
                            <span className="shrink-0 text-[11px] text-muted">{d.sub?.toolCalls ?? 0} calls</span>
                            <button className="shrink-0 text-[11px] text-accent hover:underline" onClick={() => onOpen(d.toolUseId)} title="Open full detail">
                              open
                            </button>
                          </div>
                          {ton && (
                            <div className="ml-3 mb-1 border-l border-border pl-2">
                              {steps.length > shown.length && (
                                <button className="px-1.5 py-0.5 text-[11px] text-muted hover:text-text" onClick={() => onOpen(d.toolUseId)}>
                                  … {steps.length - shown.length} earlier steps, open detail to see all
                                </button>
                              )}
                              {shown.length === 0 && <div className="px-1.5 py-0.5 text-[11px] text-muted">{d.done ? 'No recorded steps.' : 'Waiting for the first step…'}</div>}
                              {shown.map((st, i) =>
                                st.kind === 'tool' ? (
                                  <div key={i} className="flex items-baseline gap-1.5 px-1.5 py-px font-mono text-[11px]">
                                    <span className="shrink-0 text-accent">{st.name}</span>
                                    <span className="truncate text-muted" title={st.detail}>
                                      {st.detail}
                                    </span>
                                  </div>
                                ) : (
                                  <div key={i} className="truncate px-1.5 py-px text-[11px] text-muted" title={st.detail}>
                                    “{st.detail}”
                                  </div>
                                )
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
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

const NO_NOTES: never[] = []

/** Toggles the Notes panel; shows how many todos are open. */
function NotesButton({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [view, setView] = usePanel()
  const notes = useNotes((s) => s.byWorkspace[workspaceId]) ?? NO_NOTES
  const { load, subscribe } = useNotes()
  useEffect(() => {
    subscribe()
    void load(workspaceId)
  }, [workspaceId, load, subscribe])
  const open = notes.filter((n) => n.kind === 'todo' && !n.done).length
  const on = view.kind === 'notes'
  return (
    <Button size="sm" variant="ghost" data-tour="notes" title="Session notes and todos for this workspace (the agent can read and add to them)" onClick={() => setView(on ? { kind: 'closed' } : { kind: 'notes' })} className={on ? 'bg-panel-2 text-text' : ''}>
      <StickyNote size={13} /> Notes{open > 0 && <span className="rounded-full bg-accent/20 px-1.5 text-[10px] text-accent">{open}</span>}
    </Button>
  )
}
