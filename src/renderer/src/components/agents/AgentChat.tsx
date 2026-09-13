import React, { useEffect, useRef, useState } from 'react'
import { Send, Square, MessageSquare } from 'lucide-react'
import { useChat } from '@/stores/chat'
import { useApp } from '@/stores/app'
import { Message } from '../ChatPane'
import { Button, Spinner } from '../ui'
import { agentOwner, type AgentSpec } from '@shared/types'

/**
 * The agent's own conversation: no workspace, no orchestrator. Each message is one run of the
 * agent with the recent thread as context; scheduled runs land here too.
 */
export function AgentChat({ agent }: { agent: AgentSpec }): React.JSX.Element {
  const owner = agentOwner(agent.id)
  const chat = useChat((s) => s.chats[owner])
  const { load, send, interrupt, setDraft } = useChat()
  const setError = useApp((s) => s.setError)
  const [atBottom, setAtBottom] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const items = chat?.items ?? []
  const busy = chat?.busy ?? false
  const draft = chat?.draft ?? ''
  useEffect(() => {
    void load(owner).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [owner, load, setError])
  useEffect(() => {
    const el = scrollRef.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  }, [items, atBottom])
  const onScroll = (): void => {
    const el = scrollRef.current
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
  }
  const submit = (): void => {
    if (!draft.trim() || busy) return
    void send(owner, draft)
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto px-6 py-4">
        {items.length === 0 && (
          <div className="mx-auto mt-16 max-w-md text-center text-[12px] text-muted">
            <MessageSquare size={20} className="mx-auto mb-2 text-accent" />
            <p>Talk to {agent.icon ? `${agent.icon} ` : ''}{agent.name} directly. It runs without a workspace, with its own tools, and keeps the thread of this conversation. Scheduled runs show up here as well.</p>
          </div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {items.map((it) => (
            <Message key={it.id} item={it} />
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-[12px] text-muted">
              <Spinner /> {agent.name} is working…
            </div>
          )}
        </div>
      </div>
      {chat?.error && <div className="mx-6 mb-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-[12px] text-danger">{chat.error}</div>}
      <div className="border-t border-border px-6 py-3">
        <div className="mx-auto flex max-w-3xl flex-col rounded-xl border border-border bg-bg focus-within:border-accent">
          <textarea
            value={draft}
            rows={3}
            placeholder={busy ? `${agent.name} is running…` : `Message ${agent.name}… (Enter to send, Shift+Enter for newline)`}
            onChange={(e) => setDraft(owner, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            className="block min-h-[64px] w-full resize-none bg-transparent px-3 pt-3 text-[13px] outline-none placeholder:text-muted"
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            <span className="text-[10px] text-muted">
              {agent.tools?.length ? `Tools: ${agent.tools.join(', ')}` : 'All tools'} · {agent.model}
            </span>
            <span className="ml-auto" />
            {busy ? (
              <Button size="sm" variant="danger" onClick={() => void interrupt(owner)}>
                <Square size={12} /> Stop
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={submit}>
                <Send size={12} /> Send
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
