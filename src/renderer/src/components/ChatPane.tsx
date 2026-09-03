import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, Square, RotateCcw, Send, ArrowDownToLine, ShieldCheck, XCircle, AlertTriangle, Info } from 'lucide-react'
import { api } from '@/lib/api'
import { PERMISSION_MODES, type PermissionMode } from '@shared/types'
import { QuestionCard } from './QuestionCard'
import { useChat } from '@/stores/chat'
import { useApp } from '@/stores/app'
import { Markdown } from '@/lib/markdown'
import { Button, Spinner } from './ui'
import type { ChatBlock, ChatItem, ChatToolBlock } from '@shared/types'

const AUTOSCROLL_KEY = 'orchestra.autoscroll'

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
  const setError = useApp((s) => s.setError)
  const mode: PermissionMode = ws?.permissionMode ?? settingsMode
  const [autoScroll, setAutoScroll] = useState(() => localStorage.getItem(AUTOSCROLL_KEY) !== 'off')

  const toggleAutoScroll = (): void => {
    const next = !autoScroll
    setAutoScroll(next)
    localStorage.setItem(AUTOSCROLL_KEY, next ? 'on' : 'off')
    if (next && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }

  const changeMode = (next: PermissionMode): void => {
    api.invoke('agent:setMode', workspaceId, next).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  const cycleMode = (): void => {
    const i = PERMISSION_MODES.findIndex((m) => m.id === mode)
    changeMode(PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length].id)
  }

  // Follow the conversation while it streams. Off means the view stays where the user put it.
  useEffect(() => {
    const el = scrollRef.current
    if (el && autoScroll) el.scrollTop = el.scrollHeight
  }, [items, autoScroll, questions.length])

  // While a turn runs, Enter queues the message; main delivers it when the turn ends.
  const onSubmit = (): void => {
    if (disabled || !draft.trim()) return
    void send(workspaceId, draft)
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-auto px-6 py-4">
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
      <div className="border-t border-border px-4 py-3">
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
              <button
                onClick={toggleAutoScroll}
                title={autoScroll ? 'Auto-scroll on: follows new output. Click to turn off.' : 'Auto-scroll off: view stays put. Click to turn on.'}
                className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px]', autoScroll ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text')}
              >
                <ArrowDownToLine size={12} /> Auto-scroll
              </button>
              <span className="text-[11px] text-muted">
                {chat?.model ?? `model: ${settingsModel}`}
                {chat?.lastResult && <> · last turn ${chat.lastResult.costUsd.toFixed(3)} · {(chat.lastResult.durationMs / 1000).toFixed(1)}s</>}
              </span>
              <span className="ml-auto" />
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
  if (block.type === 'thinking') return <Collapsible label="Thinking" muted body={block.text} />
  return <ToolCall block={block} />
}

function ToolCall({ block }: { block: ChatToolBlock }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const input = (block.input ?? {}) as Record<string, unknown>
  const headline =
    typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : typeof input.pattern === 'string' ? input.pattern : typeof input.description === 'string' ? input.description : ''
  return (
    <div className={clsx('rounded-md border text-[12px]', block.isError ? 'border-danger/40' : 'border-border')}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-panel">
        <ChevronRight size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="font-medium">{block.name}</span>
        <span className="truncate font-mono text-muted">{headline}</span>
        <span className="ml-auto shrink-0">{block.done ? (block.isError ? <span className="text-danger">error</span> : <span className="text-ok">done</span>) : <Spinner />}</span>
      </button>
      {open && (
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
