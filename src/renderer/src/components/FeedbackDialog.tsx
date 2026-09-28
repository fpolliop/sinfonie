import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { MessageSquarePlus, Bug, ChevronRight, Trash2, FolderOpen, Copy, Send, CheckCircle2, ImagePlus, X } from 'lucide-react'
import { imageFiles, prepareImage, type PendingImage } from '@/lib/images'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Dialog, Segmented, Toggle, inputCls } from './ui'
import type { ErrorEntry } from '@shared/types'
import { useGuided } from '@/lib/guided'
import { friendlyError } from '@/lib/errors'

export const ERRORS_SEEN_KEY = 'orchestra.errorsSeen'

type FeedbackTab = 'feedback' | 'errors'

/** Feedback, feature requests, bugs, and the captured error log, in one place. ⌘⇧F or the sidebar button. */
export function FeedbackDialog({ tab, onClose }: { tab: FeedbackTab; onClose: () => void }): React.JSX.Element {
  return (
    <Dialog title="Feedback and diagnostics" onClose={onClose} width={680}>
      <FeedbackPanel initialTab={tab} onClose={onClose} autoFocus />
    </Dialog>
  )
}

/**
 * The dialog's content, also embedded in Settings → Feedback. It owns the "Report this" prefill: the errors tab
 * unmounts when the form tab shows, so the error text has to live up here to reach the form.
 */
export function FeedbackPanel({ initialTab, onClose, autoFocus }: { initialTab: FeedbackTab; onClose?: () => void; autoFocus?: boolean }): React.JSX.Element {
  const guided = useGuided()
  const [tab, setTab] = useState<FeedbackTab>(initialTab)
  const [prefill, setPrefill] = useState<string | undefined>(undefined)
  return (
    <div>
      <Segmented
        className="mb-4"
        value={tab}
        onChange={setTab}
        options={[
          { id: 'feedback', label: <span className="flex items-center gap-1.5"><MessageSquarePlus size={13} /> Feedback and requests</span> },
          { id: 'errors', label: <span className="flex items-center gap-1.5"><Bug size={13} /> {guided ? 'Problems' : 'Errors'}</span> }
        ]}
      />
      {tab === 'feedback' ? (
        <FeedbackForm key={prefill ?? ''} prefill={prefill} onClose={onClose} autoFocus={autoFocus} />
      ) : (
        <ErrorsView
          onReport={(text) => {
            setPrefill(text)
            setTab('feedback')
          }}
        />
      )}
    </div>
  )
}

function FeedbackForm({ prefill, onClose, autoFocus }: { prefill?: string; onClose?: () => void; autoFocus?: boolean }): React.JSX.Element {
  const { settings, setError } = useApp()
  const guided = useGuided()
  const [kind, setKind] = useState<'feature' | 'bug' | 'feedback'>(prefill ? 'bug' : 'feature')
  const [message, setMessage] = useState(prefill ?? '')
  const [email, setEmail] = useState(() => localStorage.getItem('orchestra.feedbackEmail') ?? '')
  const [includeLogs, setIncludeLogs] = useState(Boolean(prefill))
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [sent, setSent] = useState<{ kind: typeof kind; withEmail: boolean } | null>(null)
  const [shots, setShots] = useState<PendingImage[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const MAX_SHOTS = 4
  // Screenshots are stored with the report, so keep them small: 1600 px, ~450 KB each.
  const addFiles = async (files: File[]): Promise<void> => {
    const room = MAX_SHOTS - shots.length
    if (room <= 0) return setFailure(`At most ${MAX_SHOTS} screenshots per report.`)
    setFailure(null)
    const prepared: PendingImage[] = []
    for (const f of files.slice(0, room)) {
      try {
        prepared.push(await prepareImage(f, f.name || 'screenshot', { maxSide: 1600, maxBytes: 450 * 1024 }))
      } catch (err) {
        setFailure(friendlyError(err, 'That image could not be added.'))
      }
    }
    if (prepared.length) setShots((s) => [...s, ...prepared])
  }
  const removeShot = (id: string): void => {
    setShots((s) => {
      const gone = s.find((x) => x.id === id)
      if (gone) URL.revokeObjectURL(gone.preview)
      return s.filter((x) => x.id !== id)
    })
  }
  const send = async (): Promise<void> => {
    if (!message.trim() || sending) return
    setSending(true)
    setFailure(null)
    localStorage.setItem('orchestra.feedbackEmail', email)
    try {
      const attachments = shots.map((s) => ({ name: s.name, mime: s.mimeType, data: s.data }))
      const r = await api.invoke('feedback:send', { kind, message, email: email || undefined, includeLogs, attachments: attachments.length ? attachments : undefined })
      if (r.ok) {
        setSent({ kind, withEmail: Boolean(email.trim()) })
        setMessage('')
        setIncludeLogs(false)
        shots.forEach((s) => URL.revokeObjectURL(s.preview))
        setShots([])
      } else setFailure(friendlyError(r.error ?? '', 'Try again in a moment.'))
    } catch (err) {
      setFailure(friendlyError(err, 'Try again in a moment.'))
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
        <div className="text-[15px] font-semibold">Thanks for the {what}</div>
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
      <Segmented
        size="sm"
        className="mb-2"
        value={kind}
        onChange={setKind}
        options={[
          { id: 'feature', label: 'Feature request' },
          { id: 'bug', label: guided ? 'Something is broken' : 'Bug' },
          { id: 'feedback', label: 'Feedback' }
        ]}
      />
      <div
        className={clsx('rounded-md', dragging && 'ring-2 ring-accent/60')}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          const files = imageFiles(e.dataTransfer)
          setDragging(false)
          if (!files.length) return
          e.preventDefault()
          void addFiles(files)
        }}
      >
        <textarea
          autoFocus={autoFocus}
          aria-label="Your message"
          rows={6}
          className={inputCls}
          placeholder={kind === 'bug' ? 'What happened, what did you expect, and how to reproduce it? Paste or drop screenshots here.' : kind === 'feature' ? 'What would you like Sinfonie to do?' : 'Anything at all.'}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData)
            if (!files.length) return
            e.preventDefault()
            void addFiles(files)
          }}
        />
      </div>
      {shots.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {shots.map((s) => (
            <div key={s.id} className="group relative h-16 w-24 overflow-hidden rounded-md border border-border bg-bg" title={s.name}>
              <img src={s.preview} alt={s.name} className="h-full w-full object-cover" />
              <button type="button" onClick={() => removeShot(s.id)} className="reveal-on-focus absolute right-0.5 top-0.5 rounded-full opacity-0 group-hover:opacity-100 bg-black/70 p-0.5 text-white" aria-label={`Remove screenshot ${s.name}`} title="Remove">
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/'))
          e.target.value = ''
          void addFiles(files)
        }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input className={clsx(inputCls, 'max-w-[260px]')} aria-label="Email for a reply (optional)" placeholder="Email for a reply (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <span title={guided ? 'Adds the details of the last 30 problems Sinfonie noticed. No chat content.' : 'Attaches the last 30 captured errors. No chat content.'}>
          <Toggle checked={includeLogs} onChange={setIncludeLogs} label={guided ? 'Attach recent problems' : 'Attach error log'} />
        </span>
        <Button size="sm" variant="ghost" disabled={shots.length >= MAX_SHOTS} onClick={() => fileInput.current?.click()} title="Add screenshots (or paste / drop them in the text box)">
          <ImagePlus size={12} /> {shots.length ? `${shots.length}/${MAX_SHOTS} screenshots` : 'Screenshot'}
        </Button>
        <span className="ml-auto flex items-center gap-2">
          {failure && <span className="text-[12px] text-danger">Could not send: {failure}</span>}
          <Button variant="primary" disabled={!message.trim() || sending} onClick={send}>
            <Send size={13} /> {sending ? 'Sending…' : 'Send'}
          </Button>
        </span>
      </div>
      <div className="mt-4 flex flex-col gap-3 rounded-md border border-border px-3 py-3">
        <Toggle
          checked={settings.usageStats !== false}
          onChange={(v) => void api.invoke('settings:update', { usageStats: v }).catch((err) => setError(friendlyError(err)))}
          label="Share anonymous usage statistics"
          hint={guided ? 'Once a day: a random install id, the app and macOS versions, and how many tasks and messages. No content, no account, no app names.' : 'Once a day: a random install id, app version, macOS version, which engines were used, and how many workspaces and messages. No content, no account, no repo names.'}
        />
        <Toggle
          checked={settings.crashReports !== false}
          onChange={(v) => void api.invoke('settings:update', { crashReports: v }).catch((err) => setError(friendlyError(err)))}
          label="Send crash reports automatically"
          hint={guided ? 'The technical details of a crash, and the app and macOS versions, at most once an hour per problem. Never chat content, file names or passwords.' : 'Error message, stack trace, app version and macOS version, once per distinct error per hour. Never chat content, repo paths or tokens.'}
        />
      </div>
    </div>
  )
}

function ErrorsView({ onReport }: { onReport: (prefill: string) => void }): React.JSX.Element {
  const guided = useGuided()
  const [entries, setEntries] = useState<ErrorEntry[]>([])
  const [open, setOpen] = useState<string | null>(null)
  // Guided: the technical side (where, raw message, stack, logs folder) is one deliberate click away.
  const [technical, setTechnical] = useState(!guided)
  const load = (): void => {
    api.invoke('logs:list').then(setEntries).catch(() => setEntries([]))
  }
  useEffect(() => {
    load()
    localStorage.setItem(ERRORS_SEEN_KEY, new Date().toISOString())
    return api.on('errors:new', () => load())
  }, [])
  const noun = guided ? 'problem' : 'error'
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[12px] text-muted">
        <span>{entries.length === 0 ? `No ${noun}s captured.` : `${entries.length} captured ${noun}${entries.length === 1 ? '' : 's'}, newest first.`}</span>
        <span className="ml-auto flex gap-1.5">
          {guided && entries.length > 0 && (
            <Button size="sm" variant="ghost" aria-expanded={technical} onClick={() => setTechnical(!technical)}>
              <ChevronRight size={12} className={clsx('transition-transform', technical && 'rotate-90')} /> {technical ? 'Hide technical details' : 'Show technical details'}
            </Button>
          )}
          {technical && (
            <Button size="sm" variant="ghost" onClick={() => void api.invoke('logs:open')}>
              <FolderOpen size={12} /> Logs folder
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={entries.length === 0} onClick={() => window.confirm(`Clear the ${noun} list? The captured ${noun}s are gone and can no longer be attached to feedback.`) && api.invoke('logs:clear').then(load)}>
            <Trash2 size={12} /> Clear
          </Button>
        </span>
      </div>
      <div className="flex max-h-[52vh] flex-col gap-1 overflow-auto" {...(guided && technical ? { 'data-expert-ok': '' } : {})}>
        {entries.map((e) => {
          const isOpen = open === e.id
          const shown = technical ? e.message : friendlyError(e.message, 'Something went wrong.', true)
          return (
            <div key={e.id} className="rounded-md border border-border">
              <button aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : e.id)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-panel-2">
                <ChevronRight size={12} className={clsx('shrink-0 transition-transform', isOpen && 'rotate-90')} />
                {technical && <Badge tone={/renderer/.test(e.where) ? 'warn' : 'danger'}>{e.where}</Badge>}
                <span className={clsx('min-w-0 flex-1 truncate', technical && 'font-mono')}>{shown}</span>
                <span className="shrink-0 text-[11px] text-muted">{e.ts ? new Date(e.ts).toLocaleString() : ''}</span>
              </button>
              {isOpen && (
                <div className="border-t border-border bg-bg px-2.5 py-2 text-[11px]">
                  {technical ? (
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono">{e.message}{e.stack ? '\n' + e.stack : ''}{e.extra ? '\n' + e.extra : ''}</pre>
                  ) : (
                    <p className="text-[12px] text-muted">Report it and the details go along with your note, so nobody has to ask you for them.</p>
                  )}
                  <div className="mt-2 flex gap-1.5">
                    {technical && (
                      <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(`${e.ts} [${e.where}] ${e.message}\n${e.stack ?? ''}\n${e.extra ?? ''}`)}>
                        <Copy size={12} /> Copy
                      </Button>
                    )}
                    <Button size="sm" onClick={() => onReport(guided ? `Problem: ${shown}\n\nWhat I was doing:\n` : `Error: ${e.message}\n\nWhat I was doing:\n`)}>
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
