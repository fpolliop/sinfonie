import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Send, Square, ChevronRight, Check, X as XIcon, Wand2, ListTodo, Briefcase, Bot, Siren, Settings2 } from 'lucide-react'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useMaestro } from '@/stores/maestro'
import { Markdown } from '@/lib/markdown'
import { QuestionCard } from '../QuestionCard'
import { Button, Spinner } from '../ui'
import type { AssistantItem, MaestroSuggestion } from '@shared/types'

const KIND_ICON: Record<MaestroSuggestion['kind'], React.ReactNode> = {
  todos: <ListTodo size={13} />,
  workspace: <Briefcase size={13} />,
  agent: <Bot size={13} />,
  oncall: <Siren size={13} />,
  setup: <Settings2 size={13} />
}

/** The transcript and composer of one Maestro conversation; the same in the side panel and full screen. */
export function MaestroConversation({ id, compact }: { id: string; compact?: boolean }): React.JSX.Element {
  const loaded = useMaestro((s) => s.byId[id])
  const suggestions = useMaestro((s) => s.suggestions)
  const { send, stop, setDraft, loadSuggestions } = useMaestro()
  const setError = useApp((s) => s.setError)
  const allQuestions = useChat((s) => s.questions)
  const questions = useMemo(() => allQuestions.filter((q) => q.workspaceId === `maestro:${id}`), [allQuestions, id])
  const scroller = useRef<HTMLDivElement>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const items = loaded?.items ?? []
  const deltas = loaded?.deltas ?? {}
  const busy = loaded?.busy ?? false
  const draft = loaded?.draft ?? ''
  useEffect(() => {
    if (items.length === 0) void loadSuggestions()
  }, [id, items.length, loadSuggestions])
  useEffect(() => {
    if (atBottom) scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [items, deltas, questions.length, atBottom])
  useEffect(() => {
    ta.current?.focus()
  }, [id])
  const onScroll = (): void => {
    const el = scroller.current
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
  }
  const submit = (text: string): void => {
    if (!text.trim() || busy) return
    setAtBottom(true)
    send(id, text).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  const grouped = useMemo(() => groupActivity(items), [items])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} onScroll={onScroll} className={clsx('flex-1 overflow-auto', compact ? 'px-3 py-3' : 'px-6 py-4')}>
        <div className={clsx('mx-auto flex flex-col gap-3 text-[13px]', compact ? '' : 'max-w-3xl')}>
          {items.length === 0 && !busy && (
            <div className="mt-6">
              <div className="mb-1 flex items-center gap-2 text-[15px] font-semibold">
                <Wand2 size={16} className="text-accent" /> Maestro
              </div>
              <p className="mb-4 text-[12px] text-muted">I know your spaces, workspaces, agents, notes and integrations, and I can act on all of them. Ask anything, or pick up where things are:</p>
              <div className="flex flex-col gap-1.5">
                {suggestions.map((s) => (
                  <button key={s.label + s.text} onClick={() => submit(s.text)} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-left hover:border-accent/60 hover:bg-panel-2">
                    <span className="text-accent">{KIND_ICON[s.kind]}</span>
                    <span className="font-medium">{s.label}</span>
                    <span className="ml-auto truncate text-[11px] text-muted">{s.text.length > 60 ? `${s.text.slice(0, 60)}…` : s.text}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {grouped.map((g) => (g.kind === 'activity' ? <Activity key={g.key} items={g.items} /> : <Item key={g.item.id} item={g.item} streaming={deltas[g.item.id]} />))}
          {questions.map((q) => (
            <QuestionCard key={q.requestId} req={q} />
          ))}
          {busy && !Object.keys(deltas).length && (
            <div className="flex items-center gap-2 text-[12px] text-muted">
              <Spinner /> Thinking…
            </div>
          )}
        </div>
      </div>
      <div className={clsx('border-t border-border', compact ? 'px-3 py-2' : 'px-6 py-3')}>
        <div className={clsx('mx-auto flex flex-col rounded-xl border border-border bg-bg focus-within:border-accent', compact ? '' : 'max-w-3xl')}>
          <textarea
            ref={ta}
            rows={compact ? 2 : 3}
            className="block w-full resize-none bg-transparent px-3 pt-2.5 text-[13px] outline-none placeholder:text-muted"
            placeholder={busy ? 'Answer above, or wait…' : 'Ask Maestro anything… (Enter to send, Shift+Enter for a new line)'}
            value={draft}
            onChange={(e) => setDraft(id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit(draft)
              }
            }}
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            <span className="text-[10px] text-muted">Confirms before changing anything. Links in answers open the thing they name.</span>
            <span className="ml-auto" />
            {busy ? (
              <Button size="sm" variant="danger" onClick={() => void stop(id)} title="Stop the current answer">
                <Square size={12} /> Stop
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={() => submit(draft)}>
                <Send size={12} /> Send
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

type Group = { kind: 'item'; item: AssistantItem } | { kind: 'activity'; key: string; items: AssistantItem[] }
/** Consecutive tool calls collapse into one activity card. */
function groupActivity(items: AssistantItem[]): Group[] {
  const out: Group[] = []
  for (const it of items) {
    const last = out[out.length - 1]
    if (it.role === 'tool') {
      if (last && last.kind === 'activity') last.items.push(it)
      else out.push({ kind: 'activity', key: it.id, items: [it] })
    } else out.push({ kind: 'item', item: it })
  }
  return out
}

function Item({ item, streaming }: { item: AssistantItem; streaming?: string }): React.JSX.Element | null {
  if (item.role === 'user') return <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent/15 px-3.5 py-2">{item.text}</div>
  if (item.role === 'system') return <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px]">{item.text}</div>
  const text = streaming ?? item.text
  if (!text) return null
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
        <Wand2 size={12} />
      </span>
      <div className="min-w-0 max-w-[92%] rounded-2xl rounded-tl-md bg-panel px-3.5 py-2">
        <Markdown text={text} />
      </div>
    </div>
  )
}

function Activity({ items }: { items: AssistantItem[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const changed = items.filter((it) => WRITE_RE.test(it.tool?.name ?? '')).length
  const failed = items.filter((it) => it.tool && !it.tool.ok).length
  const summary = items.length === 1 ? `${verb(items[0].tool!.name)} ${summarize(items[0].tool!.input)}`.trim() : `${items.length} steps${changed ? `, ${changed} change${changed === 1 ? '' : 's'}` : ''}${failed ? `, ${failed} failed` : ''}`
  return (
    <div className="ml-8 rounded-lg border border-border text-[12px]">
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-panel-2" onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
        {failed ? <XIcon size={12} className="text-danger" /> : <Check size={12} className="text-ok" />}
        <span className="truncate text-muted">{summary}</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted">{(items.reduce((n, it) => n + (it.tool?.ms ?? 0), 0) / 1000).toFixed(1)}s</span>
      </button>
      {open && (
        <div className="border-t border-border">
          {items.map((it) => {
            const t = it.tool!
            const isOpen = openId === it.id
            return (
              <div key={it.id} className="border-b border-border/60 last:border-b-0">
                <button className="flex w-full items-center gap-2 px-2.5 py-1 text-left hover:bg-panel-2" onClick={() => setOpenId(isOpen ? null : it.id)}>
                  {t.ok ? <Check size={11} className="shrink-0 text-ok" /> : <XIcon size={11} className="shrink-0 text-danger" />}
                  <span className="font-mono">{t.name}</span>
                  <span className="truncate text-muted">{summarize(t.input)}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted">{t.ms ? `${(t.ms / 1000).toFixed(1)}s` : ''}</span>
                </button>
                {isOpen && <pre className="max-h-64 overflow-auto whitespace-pre-wrap bg-bg px-2.5 py-2 font-mono text-[11px]">{it.text}</pre>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const WRITE_RE = /^(set_|update_|create_|delete_|add_|move_|configure_|reset_|save_|notes_add|notes_update|notes_remove|send_to|run_agent|connect_)/
function verb(name: string): string {
  const map: Record<string, string> = { get_overview: 'Looked at everything', list_workspaces: 'Listed workspaces', workspace_transcript: 'Read a workspace', notes_list: 'Read notes', list_agents: 'Listed agents', get_agent: 'Read an agent', integration_status: 'Checked integrations', scan_repos: 'Scanned repositories', get_crew: 'Read the crew' }
  return map[name] ?? name.replace(/_/g, ' ')
}
function summarize(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? (v.length > 40 ? `${v.slice(0, 40)}…` : v) : Array.isArray(v) ? `[${v.length}]` : typeof v === 'object' ? '{…}' : String(v)}`)
    .join(' ')
    .slice(0, 120)
}
