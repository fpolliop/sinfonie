import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { MessageSquarePlus, Bug, ChevronRight, Trash2, FolderOpen, Copy, Send, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Dialog, inputCls } from './ui'
import type { ErrorEntry } from '@shared/types'

export const ERRORS_SEEN_KEY = 'orchestra.errorsSeen'

/** Feedback, feature requests, bugs, and the captured error log, in one place. ⌘⇧F or the sidebar button. */
export function FeedbackDialog({ tab: initial, onClose }: { tab: 'feedback' | 'errors'; onClose: () => void }): React.JSX.Element {
  const [tab, setTab] = useState(initial)
  return (
    <Dialog title="Feedback and diagnostics" onClose={onClose} width={680}>
      <div className="mb-4 flex rounded-md bg-bg p-0.5 text-[12px]">
        <button onClick={() => setTab('feedback')} className={clsx('flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5', tab === 'feedback' ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
          <MessageSquarePlus size={13} /> Feedback and requests
        </button>
        <button onClick={() => setTab('errors')} className={clsx('flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5', tab === 'errors' ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
          <Bug size={13} /> Errors
        </button>
      </div>
      {tab === 'feedback' ? <FeedbackForm onClose={onClose} /> : <ErrorsView onReport={() => setTab('feedback')} />}
    </Dialog>
  )
}

function FeedbackForm({ prefill, onClose }: { prefill?: string; onClose?: () => void }): React.JSX.Element {
  const { settings, setError } = useApp()
  const [kind, setKind] = useState<'feature' | 'bug' | 'feedback'>(prefill ? 'bug' : 'feature')
  const [message, setMessage] = useState(prefill ?? '')
  const [email, setEmail] = useState(() => localStorage.getItem('orchestra.feedbackEmail') ?? '')
  const [includeLogs, setIncludeLogs] = useState(Boolean(prefill))
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [sent, setSent] = useState<{ kind: typeof kind; withEmail: boolean } | null>(null)
  const send = async (): Promise<void> => {
    if (!message.trim() || sending) return
    setSending(true)
    setFailure(null)
    localStorage.setItem('orchestra.feedbackEmail', email)
    try {
      const r = await api.invoke('feedback:send', { kind, message, email: email || undefined, includeLogs })
      if (r.ok) {
        setSent({ kind, withEmail: Boolean(email.trim()) })
        setMessage('')
        setIncludeLogs(false)
      } else setFailure(r.error ?? 'Unknown error')
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }
  if (sent) {
    const what = sent.kind === 'bug' ? 'bug report' : sent.kind === 'feature' ? 'feature request' : 'feedback'
    return (
      <div className="flex flex-col items-center px-6 py-10 text-center">
        <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-ok/15 text-ok">
          <CheckCircle2 size={26} />
        </span>
        <div className="text-[16px] font-semibold">Thanks for the {what}</div>
        <p className="mt-1 max-w-sm text-[13px] text-muted">
          It's in the queue and will be read. {sent.withEmail ? 'If there is anything to say back, it goes to the email you left.' : 'Add an email next time if you want a reply.'}
        </p>
        <div className="mt-5 flex gap-2">
          <Button onClick={() => setSent(null)}>
            <MessageSquarePlus size={13} /> Send more feedback
          </Button>
          {onClose && (
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>
    )
  }
  return (
    <div>
      <div className="mb-2 flex gap-1.5">
        {(
          [
            ['feature', 'Feature request'],
            ['bug', 'Bug'],
            ['feedback', 'Feedback']
          ] as const
        ).map(([id, label]) => (
          <button key={id} onClick={() => setKind(id)} className={clsx('rounded-full border px-2.5 py-0.5 text-[12px]', kind === id ? 'border-accent/60 bg-accent/15 text-accent' : 'border-border text-muted hover:text-text')}>
            {label}
          </button>
        ))}
      </div>
      <textarea autoFocus rows={6} className={inputCls} placeholder={kind === 'bug' ? 'What happened, what did you expect, and how to reproduce it?' : kind === 'feature' ? 'What would you like Sinfonie to do?' : 'Anything at all.'} value={message} onChange={(e) => setMessage(e.target.value)} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input className={clsx(inputCls, 'max-w-[260px]')} placeholder="Email for a reply (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="flex items-center gap-1.5 text-[12px] text-muted" title="Attaches the last 30 captured errors. No chat content.">
          <input type="checkbox" checked={includeLogs} onChange={(e) => setIncludeLogs(e.target.checked)} /> attach error log
        </label>
        <span className="ml-auto flex items-center gap-2">
          {failure && <span className="text-[12px] text-danger">Could not send: {failure}</span>}
          <Button variant="primary" disabled={!message.trim() || sending} onClick={send}>
            <Send size={13} /> {sending ? 'Sending…' : 'Send'}
          </Button>
        </span>
      </div>
      <label className="mt-4 flex items-start gap-2 rounded-md border border-border px-3 py-2 text-[12px]">
        <input type="checkbox" className="mt-0.5" checked={settings.crashReports !== false} onChange={(e) => api.invoke('settings:update', { crashReports: e.target.checked }).catch((err) => setError(String(err)))} />
        <span>
          Send crash reports automatically
          <span className="block text-[11px] text-muted">Error message, stack trace, app version and macOS version, once per distinct error per hour. Never chat content, repo paths or tokens.</span>
        </span>
      </label>
    </div>
  )
}

function ErrorsView({ onReport }: { onReport: () => void }): React.JSX.Element {
  const [entries, setEntries] = useState<ErrorEntry[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [prefill, setPrefill] = useState<string | null>(null)
  const load = (): void => {
    api.invoke('logs:list').then(setEntries).catch(() => setEntries([]))
  }
  useEffect(() => {
    load()
    localStorage.setItem(ERRORS_SEEN_KEY, new Date().toISOString())
    return api.on('errors:new', () => load())
  }, [])
  if (prefill !== null) return <FeedbackForm prefill={prefill} />
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[12px] text-muted">
        <span>{entries.length === 0 ? 'No errors captured.' : `${entries.length} captured error${entries.length === 1 ? '' : 's'}, newest first.`}</span>
        <span className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void api.invoke('logs:open')}>
            <FolderOpen size={12} /> Logs folder
          </Button>
          <Button size="sm" variant="ghost" disabled={entries.length === 0} onClick={() => api.invoke('logs:clear').then(load)}>
            <Trash2 size={12} /> Clear
          </Button>
        </span>
      </div>
      <div className="flex max-h-[52vh] flex-col gap-1 overflow-auto">
        {entries.map((e) => {
          const isOpen = open === e.id
          return (
            <div key={e.id} className="rounded-md border border-border">
              <button onClick={() => setOpen(isOpen ? null : e.id)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-panel-2">
                <ChevronRight size={12} className={clsx('shrink-0 transition-transform', isOpen && 'rotate-90')} />
                <Badge tone={/renderer/.test(e.where) ? 'warn' : 'danger'}>{e.where}</Badge>
                <span className="min-w-0 flex-1 truncate font-mono">{e.message}</span>
                <span className="shrink-0 text-[11px] text-muted">{e.ts ? new Date(e.ts).toLocaleString() : ''}</span>
              </button>
              {isOpen && (
                <div className="border-t border-border bg-bg px-2.5 py-2 font-mono text-[11px]">
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{e.message}{e.stack ? '\n' + e.stack : ''}{e.extra ? '\n' + e.extra : ''}</pre>
                  <div className="mt-2 flex gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(`${e.ts} [${e.where}] ${e.message}\n${e.stack ?? ''}\n${e.extra ?? ''}`)}>
                      <Copy size={12} /> Copy
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setPrefill(`Error: ${e.message}\n\nWhat I was doing:\n`)
                        onReport()
                      }}
                    >
                      <Bug size={12} /> Report this
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
