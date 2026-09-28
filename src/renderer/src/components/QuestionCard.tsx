import React, { useState } from 'react'
import clsx from 'clsx'
import { HelpCircle, Send } from 'lucide-react'
import { useChat } from '@/stores/chat'
import { cap, useGuided, useWords } from '@/lib/guided'
import { friendlyError } from '@/lib/errors'
import { Button, Badge, inputCls } from './ui'
import type { QuestionRequest } from '@shared/types'

const OTHER = '__other__'

/** Claude's clarifying questions, answered inline. Options are radios or checkboxes, plus an "Other" free-text choice. */
export function QuestionCard({ req }: { req: QuestionRequest }): React.JSX.Element {
  const answer = useChat((s) => s.answerQuestion)
  // question text -> selected labels (or [OTHER])
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guided = useGuided()
  const agent = useWords().agent
  /** Sends one answer; the card stays (with the error) when it fails, so nothing typed is lost. */
  const deliver = async (response: Parameters<typeof answer>[0]): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await answer(response)
    } catch (err) {
      setError(friendlyError(err, 'Your answer did not go through. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (q: string, label: string, multi: boolean): void => {
    setPicked((p) => {
      const cur = p[q] ?? []
      if (!multi) return { ...p, [q]: [label] }
      return { ...p, [q]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })
  }
  const complete = req.questions.every((q) => {
    const sel = picked[q.question] ?? []
    if (sel.length === 0) return false
    if (sel.includes(OTHER) && !(other[q.question] ?? '').trim()) return false
    return true
  })
  const submit = async (): Promise<void> => {
    if (busy) return
    const answers: Record<string, string> = {}
    for (const q of req.questions) {
      const sel = (picked[q.question] ?? []).map((l) => (l === OTHER ? (other[q.question] ?? '').trim() : l)).filter(Boolean)
      answers[q.question] = sel.join(', ')
    }
    await deliver({ requestId: req.requestId, answers })
  }
  const sendReply = async (): Promise<void> => {
    if (!reply.trim() || busy) return
    await deliver({ requestId: req.requestId, answers: {}, response: reply.trim() })
  }

  return (
    <div className="rounded-xl border border-accent/40 bg-panel p-4">
      <div className="mb-3 flex items-center gap-2 text-[12px] font-medium text-accent">
        <HelpCircle size={14} /> {guided ? cap(agent) : 'Claude'} has {req.questions.length === 1 ? 'a question' : `${req.questions.length} questions`}
      </div>
      <div className="flex flex-col gap-4">
        {req.questions.map((q) => {
          const sel = picked[q.question] ?? []
          return (
            <div key={q.question}>
              <div className="mb-1.5 flex items-start gap-2">
                <Badge tone="accent">{q.header}</Badge>
                <div className="text-[13px]">{q.question}</div>
              </div>
              <div className="flex flex-col gap-1">
                {q.options.map((o) => {
                  const on = sel.includes(o.label)
                  return (
                    <label key={o.label} className={clsx('flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5', on ? 'border-accent/60 bg-accent/10' : 'border-border hover:bg-panel-2')}>
                      <input type={q.multiSelect ? 'checkbox' : 'radio'} name={q.question} className="mt-0.5" checked={on} onChange={() => toggle(q.question, o.label, q.multiSelect)} />
                      <span className="min-w-0">
                        <span className="text-[13px] font-medium">{o.label}</span>
                        {o.description && <span className="block text-[12px] text-muted">{o.description}</span>}
                        {o.preview && (guided ? <span className="mt-1 block whitespace-pre-wrap rounded bg-bg p-2 text-[12px] text-muted">{o.preview}</span> : <pre className="mt-1 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-muted">{o.preview}</pre>)}
                      </span>
                    </label>
                  )
                })}
                <label className={clsx('flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5', sel.includes(OTHER) ? 'border-accent/60 bg-accent/10' : 'border-border hover:bg-panel-2')}>
                  <input type={q.multiSelect ? 'checkbox' : 'radio'} name={q.question} className="mt-0.5" checked={sel.includes(OTHER)} onChange={() => toggle(q.question, OTHER, q.multiSelect)} />
                  <span className="min-w-0 flex-1">
                    <span className="text-[13px] font-medium">Other</span>
                    {sel.includes(OTHER) && <input autoFocus className={clsx(inputCls, 'mt-1')} placeholder="Type your answer" value={other[q.question] ?? ''} onChange={(e) => setOther({ ...other, [q.question]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && complete && void submit()} />}
                  </span>
                </label>
              </div>
            </div>
          )
        })}
      </div>
      {error && (
        <div role="alert" className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}
      <div className="mt-4 flex items-center gap-2">
        <input className={clsx(inputCls, 'flex-1')} placeholder="Or reply in your own words instead…" value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void sendReply()} />
        <Button variant="ghost" size="sm" disabled={busy || !reply.trim()} onClick={sendReply}>
          Reply
        </Button>
        <Button variant="primary" disabled={busy || !complete} onClick={submit}>
          <Send size={13} /> {busy ? 'Sending…' : 'Answer'}
        </Button>
      </div>
    </div>
  )
}
