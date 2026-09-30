import React, { useEffect, useMemo, useState } from 'react'
import { Loader2, CheckCircle2, ExternalLink, Send, AlertTriangle, Check } from 'lucide-react'
import type { SendPreflight, VisualCheck, Workspace } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { composeFix } from '@/stores/builder'
import { useGithub } from '@/stores/github'
import { Button, Dialog, Field, inputCls } from './ui'
import { friendlyError, needsGitHub, rawMessage } from '@/lib/errors'
import { ConnectGitHubCard, FixPrerequisiteCard } from './ConnectGitHub'
import { AskTeammate } from './AskTeammate'

/** A problem this dialog explains itself, in plain words; shown as is. */
class PlainError extends Error {}

/**
 * Guided mode's one way out of a task: save what changed, send it to GitHub, open a pull request in every
 * app that changed, and move the task to "Waiting for review". Nothing here names a commit or a branch.
 */
export function SendForReviewButton({ ws }: { ws: Workspace }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  // The button only takes the primary colour once there is something to send, so a fresh task doesn't invite
  // sending nothing. Checked every 15 seconds; cheap (a status per app).
  const [hasChanges, setHasChanges] = useState(false)
  useEffect(() => {
    if (ws.status !== 'ready') return
    let alive = true
    const poll = (): void => {
      void api
        .invoke('workspaces:safety', ws.id)
        .then((rows) => alive && setHasChanges(rows.some((r) => !r.error && (r.uncommitted > 0 || r.unpushed > 0))))
        .catch(() => undefined)
    }
    poll()
    const t = setInterval(poll, 15_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [ws.id, ws.status])
  if (ws.status !== 'ready' || ws.repos.length === 0) return null
  return (
    <>
      <Button variant={hasChanges ? 'primary' : 'subtle'} className="no-drag" onClick={() => setOpen(true)} title={hasChanges ? 'Save your changes and ask a colleague to review them' : 'Nothing has changed yet. Describe what you want in the chat first.'}>
        <Send size={12} /> Send for review
      </Button>
      {open && <SendDialog ws={ws} onClose={() => setOpen(false)} />}
    </>
  )
}

type Phase = 'idle' | 'checking' | 'saving' | 'sending' | 'done' | 'publishing' | 'published'

function SendDialog({ ws, onClose }: { ws: Workspace; onClose: () => void }): React.JSX.Element {
  const space = useApp((s) => s.spaces.find((sp) => sp.id === ws.spaceId))
  const reviewers = space?.guided?.reviewers ?? []
  const [title, setTitle] = useState(ws.name)
  const [note, setNote] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  // What the person reads, and the raw text kept for a teammate who may need it.
  const [error, setError] = useState<{ text: string; raw: string } | null>(null)
  const [checkFail, setCheckFail] = useState<{ name: string; output: string }[] | null>(null)
  const [links, setLinks] = useState<{ repo: string; repoId: string; url: string }[]>([])
  const [confirmPublish, setConfirmPublish] = useState(false)
  const refresh = useGithub((s) => s.refresh)
  // Before anything is saved or sent: can this Mac send it at all (git, GitHub, the app on GitHub, rights, rules)?
  const [pre, setPre] = useState<SendPreflight | null>(null)
  const [preError, setPreError] = useState<string | null>(null)
  const [fixing, setFixing] = useState(false)
  const preflight = (): void => {
    setPreError(null)
    api
      .invoke('github:preflight', ws.id)
      .then(setPre)
      .catch((err) => setPreError(friendlyError(err, 'Sinfonie could not check whether this can be sent. Try again.')))
  }
  // Quick visual checks on the preview, run as the sheet opens: they inform, they never block sending.
  const [visual, setVisual] = useState<VisualCheck[] | null>(null)
  const [looking, setLooking] = useState(true)
  const look = (): void => {
    setLooking(true)
    api
      .invoke('preview:checks', ws.id)
      .then(setVisual)
      .catch(() => setVisual([{ id: 'loads', ok: false, title: 'The preview could not be checked', detail: 'You can still send it.' }]))
      .finally(() => setLooking(false))
  }
  useEffect(() => {
    look()
    preflight()
    // Closing the sheet stops the checks it started.
    return () => void api.invoke('preview:cancelChecks', ws.id).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.id])
  const issues = (visual ?? []).filter((c) => !c.ok)
  const solo = Boolean(pre?.solo)
  const fix = (c: VisualCheck): void => {
    if (!c.fix) return
    void useChat.getState().send(ws.id, composeFix(c.fix, c.evidence), c.fix)
    onClose()
  }
  const askMaestroToFixChecks = (): void => {
    if (!checkFail) return
    const detail = checkFail.map((c) => `${c.name}:\n${c.output}`).join('\n\n')
    void useChat.getState().send(ws.id, `The checks are failing, please fix them. Here is what they reported:\n\n\`\`\`\n${detail.slice(-3000)}\n\`\`\``, 'The checks are failing, please fix them.')
    onClose()
  }
  /** One fix from the preflight card; then look again. */
  const runFix = async (fn: () => Promise<unknown>): Promise<void> => {
    setFixing(true)
    setError(null)
    try {
      await fn()
      preflight()
    } catch (err) {
      setError({ text: friendlyError(err, 'That did not work. Try again, or ask a teammate.'), raw: rawMessage(err) })
    } finally {
      setFixing(false)
    }
  }
  const submit = async (): Promise<void> => {
    setError(null)
    setCheckFail(null)
    try {
      // Checks first: a failing build or test should not reach a reviewer.
      setPhase('checking')
      const checks = await api.invoke('workspaces:check', ws.id)
      const failed = checks.filter((c) => c.ran && !c.ok)
      if (failed.length) {
        setCheckFail(failed.map((c) => ({ name: c.name, output: c.output.slice(-1500) })))
        setPhase('idle')
        return
      }
      setPhase('saving')
      const safety = await api.invoke('workspaces:safety', ws.id)
      // Sinfonie could not even read what changed: say so, instead of "nothing has changed".
      const unreadable = safety.filter((x) => x.error)
      if (unreadable.length && unreadable.length === safety.length) throw new PlainError(`Sinfonie could not read the changes in ${unreadable.map((u) => u.repoName).join(', ')}. Ask Maestro to look at it, or ask a teammate.`)
      const status = await api.invoke('github:status', ws.id)
      const out: { repo: string; repoId: string; url: string }[] = []
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
        if (existing) out.push({ repo: r.repoName, repoId: r.repoId, url: existing.url })
        else {
          const url = await api.invoke('git:createPr', ws.id, r.repoId, title.trim() || ws.name, note.trim(), reviewers)
          out.push({ repo: r.repoName, repoId: r.repoId, url: /https?:\/\/\S+/.exec(url)?.[0] ?? url })
        }
      }
      if (out.length === 0) {
        if (unreadable.length) throw new PlainError(`Nothing new to send from the apps Sinfonie could read, and it could not read ${unreadable.map((u) => u.repoName).join(', ')}. Ask Maestro to look at it, or ask a teammate.`)
        throw new PlainError('Nothing has changed yet, so there is nothing to send. Describe what you want in the chat first.')
      }
      await api.invoke('workspaces:setStage', ws.id, 'in-review')
      void refresh(ws.id)
      setLinks(out)
      setPhase('done')
    } catch (err) {
      setPhase('idle')
      setError({ text: err instanceof PlainError ? err.message : friendlyError(err, 'Sending did not work. Try again, or ask a teammate.'), raw: rawMessage(err) })
      // A sign-in problem found late (the preflight passed): look again so the Connect GitHub card shows.
      if (needsGitHub(err)) preflight()
    }
  }
  const publish = async (): Promise<void> => {
    setPhase('publishing')
    setError(null)
    try {
      for (const l of links) await api.invoke('github:mergePr', ws.id, l.repoId, l.url)
      await api.invoke('workspaces:setStage', ws.id, 'done').catch(() => undefined)
      void refresh(ws.id)
      setPhase('published')
    } catch (err) {
      setPhase('done')
      setError({ text: friendlyError(err, 'Publishing did not work. Try again, or ask a teammate.'), raw: rawMessage(err) })
    }
  }
  const busy = phase === 'checking' || phase === 'saving' || phase === 'sending' || phase === 'publishing'
  const busyText = phase === 'checking' ? 'Checking your changes…' : phase === 'saving' ? 'Saving your changes…' : phase === 'publishing' ? 'Publishing…' : 'Sending…'
  const blocked = pre?.blocker
  if (phase === 'published') {
    return (
      <Dialog title="Published" onClose={onClose} width={520}>
        <div className="mb-4 flex items-center gap-2 text-[13px]">
          <CheckCircle2 size={16} className="text-ok" /> Published. Your changes are now part of {links.map((l) => l.repo).join(', ')}.
        </div>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </Dialog>
    )
  }
  return (
    <Dialog title={solo ? 'Save and publish' : 'Send for review'} onClose={onClose} width={560}>
      {phase === 'done' || phase === 'publishing' ? (
        <div>
          <div className="mb-2 flex items-center gap-2 text-[13px]">
            <CheckCircle2 size={16} className="text-ok" /> {solo ? 'Saved to GitHub. Look it over, then publish it when it is right.' : 'Sent. A colleague will review it and it goes live once approved.'}
          </div>
          <ul className="mb-4 flex flex-col gap-1 text-[12px]">
            {links.map((l) => (
              <li key={l.url}>
                <button className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', l.url)}>
                  {solo ? `See the changes to ${l.repo}` : l.repo} <ExternalLink size={10} />
                </button>
              </li>
            ))}
          </ul>
          {error && (
            <div role="alert" className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {error.text}
            </div>
          )}
          {solo && confirmPublish ? (
            <div className="rounded-md border border-warn/40 bg-warn/10 p-3 text-[13px]">
              <div>This makes your changes part of {links.map((l) => l.repo).join(', ')} for everyone who uses {links.length === 1 ? 'it' : 'them'}. Publish now?</div>
              <div className="mt-2 flex justify-end gap-2">
                <Button onClick={() => setConfirmPublish(false)} disabled={busy}>
                  Not yet
                </Button>
                <Button variant="primary" onClick={() => void publish()} disabled={busy}>
                  {busy ? <Loader2 size={12} className="animate-spin" /> : null} Yes, publish
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <Button variant={solo ? 'subtle' : 'primary'} onClick={onClose}>
                {solo ? 'Later' : 'Done'}
              </Button>
              {solo && (
                <Button variant="primary" onClick={() => setConfirmPublish(true)}>
                  Publish
                </Button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div>
          <p className="mb-4 text-[13px] text-muted">
            {solo ? 'Your changes are checked and saved to GitHub first. Then you look them over and publish them yourself.' : `Nothing goes live until someone approves it. Your changes are checked, then sent to the team for review${reviewers.length ? ` (${reviewers.join(', ')})` : ''}.`}
          </p>
          <section aria-labelledby="send-checks" className="mb-4">
            <h3 id="send-checks" className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Maestro checked the preview
            </h3>
            {looking ? (
              <div role="status" className="flex items-center gap-2 text-[13px] text-muted">
                <Loader2 size={13} className="animate-spin" aria-hidden /> Opening the page and looking for problems…
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {(visual ?? []).map((c) => (
                  <li key={c.id} className="flex items-start gap-2.5 text-[15px]">
                    {c.ok ? <Check size={16} className="mt-0.5 shrink-0 text-ok" aria-label="Passed" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" aria-label="Needs a look" />}
                    <span className="min-w-0 flex-1">
                      <span className="block">{c.title}</span>
                      {!c.ok && c.detail && <span className="block text-[13px] text-muted">{c.detail}</span>}
                    </span>
                    {!c.ok && c.fix && (
                      <Button size="sm" onClick={() => fix(c)} disabled={busy} title="Close this and ask Maestro to fix it">
                        Fix it
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!looking && issues.length > 0 && <p className="mt-2 text-[13px] text-muted">You can ask Maestro to fix {issues.length === 1 ? 'it' : 'them'} first, or send anyway and mention it in the note.</p>}
          </section>
          {checkFail && (
            <div className="mb-3 rounded-md border border-warn/40 bg-warn/10 p-2 text-[12px]">
              <div className="font-medium text-warn">Not ready yet: a check did not pass.</div>
              <div className="mt-0.5 text-muted">Maestro can look at what failed and fix it; then send again.</div>
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="primary" onClick={askMaestroToFixChecks}>
                  Ask Maestro to fix it
                </Button>
              </div>
              <details className="mt-2" data-expert-ok="">
                <summary className="w-fit cursor-pointer select-none text-[11px] text-muted hover:text-text">Show details</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted">{checkFail.map((c) => `${c.name}\n${c.output}`).join('\n\n')}</pre>
              </details>
            </div>
          )}
          <Field label="Title">
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
          </Field>
          {!solo && (
            <Field label="Note for the reviewer (optional)">
              <textarea className={`${inputCls} min-h-[72px]`} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} placeholder="What to look at, what you were not sure about…" />
            </Field>
          )}
          {error && (
            <div role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{error.text}</span>
              {error.text !== error.raw && (
                <AskTeammate workspaceId={ws.id} prefill={`I could not send "${title.trim() || ws.name}" for review. The error was: ${error.raw.slice(0, 400)}`} trigger={(open) => <Button size="sm" onClick={open}>Ask a teammate</Button>} />
              )}
            </div>
          )}
          {preError && (
            <div role="alert" className="mb-3 flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              <span className="min-w-0 flex-1">{preError}</span>
              <Button size="sm" onClick={preflight}>
                Try again
              </Button>
            </div>
          )}
          {pre && blocked ? (
            <SendBlockerCard ws={ws} pre={pre} busy={fixing} onFix={(fn) => void runFix(fn)} onRecheck={preflight} onClose={onClose} />
          ) : (
            <div className="flex items-center justify-end gap-2">
              {(busy || !pre) && (
                <span className="mr-auto inline-flex items-center gap-1 text-[12px] text-muted">
                  <Loader2 size={12} className="animate-spin" /> {busy ? busyText : 'Checking that it can be sent…'}
                </span>
              )}
              <Button onClick={onClose} disabled={busy}>
                Not yet
              </Button>
              <Button variant="primary" onClick={() => void submit()} disabled={busy || !pre || !title.trim()} title={looking ? 'The preview checks are still running; you can send without waiting.' : undefined}>
                {solo ? (issues.length ? 'Save anyway' : 'Save and review it yourself') : issues.length ? 'Send anyway' : reviewers.length === 1 ? `Send to ${reviewers[0]}` : 'Send for review'}
              </Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}

/**
 * What stands in the way of sending, found before anything is saved, with the one thing that fixes it. Replaces the
 * Send button until it is fixed.
 */
function SendBlockerCard({ ws, pre, busy, onFix, onRecheck, onClose }: { ws: Workspace; pre: SendPreflight; busy: boolean; onFix: (fn: () => Promise<unknown>) => void; onRecheck: () => void; onClose: () => void }): React.JSX.Element {
  const openSettings = useApp((s) => s.openSettings)
  const space = useApp((s) => s.spaces.find((sp) => sp.id === ws.spaceId))
  const admin = useApp((s) => Boolean(space?.orgId && s.settings.cloud?.account?.orgs?.some((o) => o.id === space.orgId && o.role === 'admin')))
  const b = pre.blocker
  const repos = pre.repos.filter((r) => r.blocker === b)
  const names = repos.map((r) => r.repoName).join(', ')
  const box = (children: React.ReactNode): React.JSX.Element => <div className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2.5 text-[13px]">{children}</div>
  if (b === 'needs-git') return <FixPrerequisiteCard what="xcode" onFixed={onRecheck} />
  if (b === 'needs-github') return <ConnectGitHubCard reason="Sending for review goes through your GitHub account. Connect it once and Sinfonie takes care of the rest." onConnected={onRecheck} />
  if (b === 'no-remote')
    return box(
      <>
        <div className="font-medium">{names} is not on GitHub yet</div>
        <p className="mt-0.5 text-[12px] text-muted">Sinfonie can put it on your GitHub account as a private app, so only people you invite can see it. Then you can send this.</p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onFix(async () => { for (const r of repos) await api.invoke('github:publishRepo', ws.id, r.repoId) })}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : null} Put this app on GitHub
          </Button>
        </div>
      </>
    )
  if (b === 'no-push')
    return box(
      <>
        <div className="font-medium">Your GitHub account cannot change {names}</div>
        <p className="mt-0.5 text-[12px] text-muted">
          Ask the app’s owner{repos[0]?.nameWithOwner ? ` (${repos[0].nameWithOwner.split('/')[0]})` : ''} to give {pre.connection.login ? `${pre.connection.login}` : 'your GitHub account'} access, then check again. Or make your own copy and send it from there; the owner still reviews it.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onFix(async () => { for (const r of repos) await api.invoke('github:forkRepo', ws.id, r.repoId) })}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : null} Make your own copy
          </Button>
          <Button size="sm" disabled={busy} onClick={onRecheck}>
            I have access now, check again
          </Button>
        </div>
      </>
    )
  if (b === 'not-github')
    return box(
      <>
        <div className="font-medium">{names} is not kept on GitHub</div>
        <p className="mt-0.5 text-[12px] text-muted">Sinfonie sends reviews through GitHub, and this app lives somewhere else. Ask Maestro or a teammate how your team shares changes to it.</p>
        <div className="mt-2 flex gap-2">
          <AskTeammate workspaceId={ws.id} prefill={`I want to send "${ws.name}" for review, but ${names} is not on GitHub. How do we share changes to it?`} trigger={(open) => <Button size="sm" onClick={open}>Ask a teammate</Button>} />
        </div>
      </>
    )
  // veto: a team rule. Always a way forward: the admin sets it up, anyone else asks.
  return box(
    <>
      <div>{pre.veto}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {admin && space ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              onClose()
              useApp.getState().setView('team')
            }}
          >
            Pick a reviewer in Team
          </Button>
        ) : (
          <AskTeammate workspaceId={ws.id} prefill={`I want to send "${ws.name}" for review, but: ${pre.veto ?? ''}`} trigger={(open) => <Button size="sm" onClick={open}>Ask a teammate</Button>} />
        )}
        {admin && space && (
          <Button size="sm" variant="ghost" onClick={() => openSettings({ scope: 'space', spaceId: space.id, page: 'general' })}>
            Team settings
          </Button>
        )}
      </div>
    </>
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
    if (open.some((p) => p.pr!.reviewDecision === 'CHANGES_REQUESTED' || p.threads.some((t) => !t.isResolved))) return { tone: 'warn', text: 'A reviewer asked for changes. Tell Maestro to address them, then send again.' }
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
