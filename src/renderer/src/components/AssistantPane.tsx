import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Sparkles, Send, Square, RotateCcw, ChevronRight, Check, X as XIcon } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { Markdown } from '@/lib/markdown'
import { QuestionCard } from './QuestionCard'
import { Button, Dialog, Spinner } from './ui'
import type { AssistantItem } from '@shared/types'

const SUGGESTIONS = [
  { label: 'Set up my crew', text: 'Help me set up my crew. Interview me about how we build, test, review and ship, then propose the agents.' },
  { label: 'Add my repositories', text: 'Find my git repositories and help me organise them into spaces.' },
  { label: 'Connect Slack, Linear and Google Cloud', text: 'Walk me through connecting Slack, Linear and Google Cloud.' },
  { label: 'Cut my token usage', text: 'My subscription is limited. Set the cost modes and crew so I use as few tokens as possible.' },
  { label: 'What is configured?', text: 'Show me what is configured right now and what looks incomplete.' }
]

/** Conversation with the settings assistant: it reads and changes Sinfonie's configuration through tools. */
export function AssistantPane({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [items, setItems] = useState<AssistantItem[]>([])
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [deltas, setDeltas] = useState<Record<string, string>>({})
  const setError = useApp((s) => s.setError)
  const allQuestions = useChat((s) => s.questions)
  const questions = useMemo(() => allQuestions.filter((q) => q.workspaceId === 'assistant'), [allQuestions])
  const scroller = useRef<HTMLDivElement>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    api
      .invoke('assistant:history')
      .then((h) => {
        setItems(h.items)
        setBusy(h.busy)
      })
      .catch((err) => setError(String(err)))
    return api.on('assistant:event', (e) => {
      if (e.type === 'item') {
        setItems((list) => (list.some((x) => x.id === e.item.id) ? list.map((x) => (x.id === e.item.id ? e.item : x)) : [...list, e.item]))
        setDeltas((d) => {
          if (!(e.item.id in d)) return d
          const next = { ...d }
          delete next[e.item.id]
          return next
        })
      } else if (e.type === 'delta') setDeltas((d) => ({ ...d, [e.id]: e.text }))
      else if (e.type === 'status') setBusy(e.busy)
      else if (e.type === 'reset') {
        setItems([])
        setDeltas({})
      }
    })
  }, [setError])
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [items, deltas, questions.length])
  const send = (text: string): void => {
    const t = text.trim()
    if (!t || busy) return
    setDraft('')
    api.invoke('assistant:send', t).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  return (
    <Dialog title="Setup assistant" onClose={onClose} width={780}>
      <div className="flex h-[70vh] flex-col">
        <div ref={scroller} className="flex-1 space-y-3 overflow-auto pr-1 text-[13px]">
          {items.length === 0 && !busy && (
            <div className="rounded-lg border border-border p-4">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <Sparkles size={14} className="text-accent" /> What do you want to set up?
              </div>
              <p className="mb-3 text-[12px] text-muted">The assistant can read and change everything under Settings: spaces, repositories, crews, cost modes, integrations and on-call. It asks before it changes anything, and opens the right page for things that need your hands, like sign-ins.</p>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button key={s.label} className="rounded-full border border-border px-2.5 py-1 text-[12px] hover:bg-panel-2" onClick={() => send(s.text)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {items.map((it) => (
            <Item key={it.id} item={it} streaming={deltas[it.id]} />
          ))}
          {questions.map((q) => (
            <QuestionCard key={q.requestId} req={q} />
          ))}
          {busy && !Object.keys(deltas).length && (
            <div className="flex items-center gap-2 text-[12px] text-muted">
              <Spinner /> Thinking…
            </div>
          )}
        </div>
        <div className="mt-3 flex items-end gap-2 border-t border-border pt-3">
          <textarea
            ref={ta}
            autoFocus
            rows={2}
            className="flex-1 resize-none rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
            placeholder={busy ? 'Answer above, or wait…' : 'Ask for a change, or describe what you want to set up…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(draft)
              }
            }}
          />
          {busy ? (
            <Button variant="ghost" onClick={() => void api.invoke('assistant:stop')} title="Stop the current answer">
              <Square size={13} /> Stop
            </Button>
          ) : (
            <Button variant="primary" disabled={!draft.trim()} onClick={() => send(draft)}>
              <Send size={13} /> Send
            </Button>
          )}
          <Button variant="ghost" title="Forget this conversation and start over" onClick={() => void api.invoke('assistant:reset')}>
            <RotateCcw size={13} />
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function Item({ item, streaming }: { item: AssistantItem; streaming?: string }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (item.role === 'user')
    return (
      <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-accent/15 px-3 py-2">{item.text}</div>
    )
  if (item.role === 'tool') {
    const t = item.tool!
    return (
      <div className="rounded-md border border-border text-[12px]">
        <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-panel-2" onClick={() => setOpen(!open)}>
          <ChevronRight size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
          {t.ok ? <Check size={12} className="text-ok" /> : <XIcon size={12} className="text-danger" />}
          <span className="font-mono">{t.name}</span>
          <span className="truncate text-muted">{summarize(t.input)}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted">{t.ms ? `${(t.ms / 1000).toFixed(1)}s` : ''}</span>
        </button>
        {open && <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border bg-bg px-2.5 py-2 font-mono text-[11px]">{item.text}</pre>}
      </div>
    )
  }
  if (item.role === 'system') return <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px]">{item.text}</div>
  const text = streaming ?? item.text
  if (!text) return null
  return (
    <div className="max-w-[92%] rounded-lg bg-panel px-3 py-2">
      <Markdown text={text} />
    </div>
  )
}

function summarize(input: Record<string, unknown>): string {
  const parts = Object.entries(input)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : Array.isArray(v) ? `[${v.length}]` : typeof v === 'object' ? '{…}' : String(v)}`)
  return parts.join(' ').slice(0, 120)
}
