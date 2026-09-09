import React, { useEffect, useMemo, useState } from 'react'
import { Loader2, CheckCircle2, ExternalLink, Send } from 'lucide-react'
import type { Workspace } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useGithub } from '@/stores/github'
import { Button, Dialog, Field, inputCls } from './ui'

/**
 * Guided mode's one way out of a task: save what changed, send it to GitHub, open a pull request in every
 * app that changed, and move the task to "Waiting for review". Nothing here names a commit or a branch.
 */
export function SendForReviewButton({ ws }: { ws: Workspace }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (ws.status !== 'ready' || ws.repos.length === 0) return null
  return (
    <>
      <Button size="sm" variant="primary" className="no-drag" onClick={() => setOpen(true)} title="Save your changes and ask a colleague to review them">
        <Send size={12} /> Send for review
      </Button>
      {open && <SendDialog ws={ws} onClose={() => setOpen(false)} />}
    </>
  )
}

type Phase = 'idle' | 'saving' | 'sending' | 'done'

function SendDialog({ ws, onClose }: { ws: Workspace; onClose: () => void }): React.JSX.Element {
  const [title, setTitle] = useState(ws.name)
  const [note, setNote] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [links, setLinks] = useState<{ repo: string; url: string }[]>([])
  const refresh = useGithub((s) => s.refresh)
  const submit = async (): Promise<void> => {
    setError(null)
    try {
      setPhase('saving')
      const safety = await api.invoke('workspaces:safety', ws.id)
      const status = await api.invoke('github:status', ws.id)
      const out: { repo: string; url: string }[] = []
      for (const r of ws.repos) {
        const s = safety.find((x) => x.repoId === r.repoId)
        if (!s || s.error) continue
        if (s.uncommitted > 0) await api.invoke('git:commit', ws.id, r.repoId, title.trim() || ws.name)
        const existing = status.find((x) => x.repoId === r.repoId)?.pr
        // Something to send: new edits, or commits GitHub has not got (ahead of the base when the branch was never pushed).
        const changed = s.uncommitted > 0 || s.unpushed > 0
        if (!changed && !existing) continue
        setPhase('sending')
        if (changed) await api.invoke('git:push', ws.id, r.repoId)
        if (existing) out.push({ repo: r.repoName, url: existing.url })
        else {
          const url = await api.invoke('git:createPr', ws.id, r.repoId, title.trim() || ws.name, note.trim())
          out.push({ repo: r.repoName, url })
        }
      }
      if (out.length === 0) throw new Error('Nothing has changed yet, so there is nothing to send. Describe what you want in the chat first.')
      await api.invoke('workspaces:setStage', ws.id, 'in-review')
      void refresh(ws.id)
      setLinks(out)
      setPhase('done')
    } catch (err) {
      setPhase('idle')
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const busy = phase === 'saving' || phase === 'sending'
  return (
    <Dialog title="Send for review" onClose={onClose} width={460}>
      {phase === 'done' ? (
        <div>
          <div className="mb-2 flex items-center gap-2 text-[13px]">
            <CheckCircle2 size={16} className="text-ok" /> Sent. A colleague will review it and it goes live once approved.
          </div>
          <ul className="mb-4 flex flex-col gap-1 text-[12px]">
            {links.map((l) => (
              <li key={l.url}>
                <button className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', l.url)}>
                  {l.repo} <ExternalLink size={10} />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <p className="mb-3 text-[12px] text-muted">Your changes are saved and sent to the team for review. Give it a short title and, if you like, a note for the reviewer.</p>
          <Field label="Title">
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
          </Field>
          <Field label="Note for the reviewer (optional)">
            <textarea className={`${inputCls} min-h-[72px]`} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} placeholder="What to look at, what you were not sure about…" />
          </Field>
          {error && <div className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
          <div className="flex items-center justify-end gap-2">
            {busy && (
              <span className="mr-auto inline-flex items-center gap-1 text-[12px] text-muted">
                <Loader2 size={12} className="animate-spin" /> {phase === 'saving' ? 'Saving your changes…' : 'Sending…'}
              </span>
            )}
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy || !title.trim()}>
              Send
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

/** One line under the task title: where the review stands, in words. */
export function ReviewStatusLine({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const prs = useGithub((s) => s.byWorkspace[workspaceId]?.repos)
  const refresh = useGithub((s) => s.refresh)
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  useEffect(() => {
    if (ws?.status === 'ready') void refresh(workspaceId)
  }, [workspaceId, ws?.status, refresh])
  const text = useMemo(() => {
    const withPr = (prs ?? []).filter((p) => p.pr)
    if (withPr.length === 0) return null
    if (withPr.every((p) => p.pr!.state === 'MERGED')) return { tone: 'ok', text: 'Approved and live.' }
    const open = withPr.filter((p) => p.pr!.state === 'OPEN')
    if (open.some((p) => p.pr!.reviewDecision === 'CHANGES_REQUESTED' || p.threads.some((t) => !t.isResolved))) return { tone: 'warn', text: 'A reviewer asked for changes. Tell the assistant to address them, then send again.' }
    if (open.some((p) => p.pr!.reviewDecision === 'APPROVED')) return { tone: 'ok', text: 'Approved. It goes live when the team merges it.' }
    if (open.length) return { tone: 'muted', text: 'Waiting for a reviewer.' }
    return { tone: 'muted', text: 'The review was closed without going live.' }
  }, [prs])
  if (!text) return null
  const url = (prs ?? []).find((p) => p.pr)?.pr?.url
  return (
    <div className={`flex min-w-0 items-center gap-1.5 text-[11px] leading-none ${text.tone === 'ok' ? 'text-ok' : text.tone === 'warn' ? 'text-warn' : 'text-muted'}`}>
      <span className="truncate">{text.text}</span>
      {url && (
        <button className="no-drag inline-flex items-center gap-1 text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', url)} title="Open the review on GitHub">
          Open <ExternalLink size={10} />
        </button>
      )}
    </div>
  )
}
