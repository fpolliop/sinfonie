/**
 * Diff rendering and the commit / pull request dialogs, shared by Changes and All files (FilesPane). The old standalone
 * Changes pane lived here too; it was mounted nowhere and was removed.
 */
import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { api } from '@/lib/api'
import { changedNewLines, toSplitRows, type DiffFile, type DiffLine } from '@/lib/diff'
import { Button, Dialog, Field, inputCls } from './ui'
import { friendlyError, needsGitHub } from '@/lib/errors'
import { ConnectGitHubCard } from './ConnectGitHub'

export type ViewMode = 'unified' | 'split' | 'file'

/** `annotate` places extra rows (reviewer findings) under a line of the new side, in the unified view. */
export function DiffView({ file, view, workspaceId, worktreePath, annotate }: { file: DiffFile; view: ViewMode; workspaceId: string; worktreePath: string; annotate?: (newNo: number) => React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-b border-border">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5 font-mono text-[12px]">
        <span className="truncate">{file.path}</span>
        <span className="ml-auto text-ok">+{file.adds}</span>
        <span className="text-danger">−{file.dels}</span>
      </div>
      {view === 'split' ? <SplitView file={file} /> : view === 'file' ? <FileView file={file} workspaceId={workspaceId} worktreePath={worktreePath} /> : <UnifiedView file={file} annotate={annotate} />}
    </div>
  )
}

function UnifiedView({ file, annotate }: { file: DiffFile; annotate?: (newNo: number) => React.ReactNode }): React.JSX.Element {
  return (
    <table className="w-full border-collapse font-mono text-[12px] leading-[18px]">
      <tbody>
        {file.lines.map((l, i) => {
          const extra = annotate && l.newNo !== undefined && l.kind !== 'del' ? annotate(l.newNo) : null
          return (
            <React.Fragment key={i}>
              <tr className={clsx(l.kind === 'add' && 'bg-ok/10', l.kind === 'del' && 'bg-danger/10', l.kind === 'hunk' && 'bg-accent/10 text-accent', l.kind === 'meta' && 'text-muted')}>
                <td className="w-10 select-none pr-1 text-right text-muted">{l.oldNo ?? ''}</td>
                <td className="w-10 select-none pr-2 text-right text-muted">{l.newNo ?? ''}</td>
                <td className={clsx('w-3 select-none', l.kind === 'add' && 'text-ok', l.kind === 'del' && 'text-danger')}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</td>
                <td className="whitespace-pre-wrap break-words pr-3">{l.text}</td>
              </tr>
              {extra && (
                <tr>
                  <td colSpan={4} className="px-3 py-1.5">
                    <div className="flex flex-col gap-2">{extra}</div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function SplitCell({ line, side }: { line?: DiffLine; side: 'old' | 'new' }): React.JSX.Element {
  const changed = line && (side === 'old' ? line.kind === 'del' : line.kind === 'add')
  const tint = changed ? (side === 'old' ? 'bg-danger/10' : 'bg-ok/10') : !line ? 'bg-panel-2/40' : ''
  return (
    <>
      <td className={clsx('w-10 select-none pr-2 text-right align-top text-muted', tint)}>{line ? (side === 'old' ? line.oldNo : line.newNo) ?? '' : ''}</td>
      <td className={clsx('w-3 select-none align-top', tint, changed && (side === 'old' ? 'text-danger' : 'text-ok'))}>{changed ? (side === 'old' ? '−' : '+') : ''}</td>
      <td className={clsx('whitespace-pre-wrap break-words pr-3 align-top', tint)}>{line?.text ?? ''}</td>
    </>
  )
}

function SplitView({ file }: { file: DiffFile }): React.JSX.Element {
  const rows = useMemo(() => toSplitRows(file), [file])
  return (
    <table className="w-full table-fixed border-collapse font-mono text-[12px] leading-[18px]">
      <colgroup>
        <col className="w-10" />
        <col className="w-3" />
        <col />
        <col className="w-10" />
        <col className="w-3" />
        <col />
      </colgroup>
      <tbody>
        {rows.map((r, i) =>
          r.kind === 'pair' ? (
            <tr key={i}>
              <SplitCell line={r.left} side="old" />
              <SplitCell line={r.right} side="new" />
            </tr>
          ) : (
            <tr key={i} className={clsx(r.kind === 'hunk' ? 'bg-accent/10 text-accent' : 'text-muted')}>
              <td colSpan={6} className="whitespace-pre-wrap break-words px-3">
                {r.text}
              </td>
            </tr>
          )
        )}
      </tbody>
    </table>
  )
}

type FileContent = { state: 'loading' } | { state: 'deleted' } | { state: 'binary' } | { state: 'error'; message: string } | { state: 'ok'; lines: string[]; truncated: boolean }

function FileView({ file, workspaceId, worktreePath }: { file: DiffFile; workspaceId: string; worktreePath: string }): React.JSX.Element {
  const [content, setContent] = useState<FileContent>({ state: 'loading' })
  const deleted = file.lines.some((l) => l.kind === 'meta' && l.text.startsWith('deleted file'))
  const marks = useMemo(() => changedNewLines(file), [file])

  useEffect(() => {
    let cancelled = false
    if (deleted) {
      setContent({ state: 'deleted' })
      return
    }
    // A refresh of the same file keeps what is on screen until the new content arrives.
    setContent((c) => (c.state === 'ok' ? c : { state: 'loading' }))
    api
      .invoke('fs:read', workspaceId, `${worktreePath}/${file.path}`)
      .then((r) => {
        if (cancelled) return
        if (r.binary) setContent({ state: 'binary' })
        else {
          const lines = r.text.split('\n')
          if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
          setContent({ state: 'ok', lines, truncated: r.truncated })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setContent({ state: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
    // `file` changes identity whenever the diff is re-read, so the file view follows edits as they land.
  }, [workspaceId, worktreePath, file, deleted])

  if (content.state !== 'ok') {
    const msg =
      content.state === 'loading' ? 'Loading…' : content.state === 'deleted' ? 'This file was deleted; switch to Unified or Split to see its former contents.' : content.state === 'binary' ? 'Binary file' : content.message
    return <div className={clsx('px-3 py-2 text-[12px]', content.state === 'error' ? 'text-danger' : 'text-muted')}>{msg}</div>
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse font-mono text-[12px] leading-[18px]">
        <tbody>
          {content.lines.map((text, i) => {
            const no = i + 1
            const added = marks.added.has(no)
            const removedBefore = marks.deletedBefore.has(no)
            return (
              <tr key={i} className={clsx(added && 'bg-ok/10', removedBefore && 'border-t border-danger/60')}>
                <td className="w-10 select-none pr-2 text-right text-muted">{no}</td>
                <td className={clsx('w-3 select-none', added && 'text-ok')}>{added ? '+' : ''}</td>
                <td className="whitespace-pre pr-3">{text}</td>
              </tr>
            )
          })}
          {marks.deletedBefore.has(content.lines.length + 1) && (
            <tr>
              <td colSpan={3} className="border-t border-danger/60" />
            </tr>
          )}
        </tbody>
      </table>
      {content.truncated && <div className="px-3 py-1.5 text-[11px] text-muted">File truncated — only the first 512 KB is shown.</div>}
    </div>
  )
}

/** A push or pull request failed because git or gh has no GitHub sign-in (see classifyGitError in main/services/git.ts). */
export const needsGitHubSignIn = (error: string | null): boolean => Boolean(error && (needsGitHub(error) || /Connect GitHub|no saved sign-in|refused your SSH key/i.test(error)))

/** The error under a push or pull request dialog, with Connect GitHub (which retries once connected) when that fixes it. */
function DialogError({ error, onRetry }: { error: string | null; onRetry: () => void }): React.JSX.Element | null {
  if (!error) return null
  return (
    <div className="mb-3 flex flex-col gap-2">
      <div role="alert" className="whitespace-pre-wrap rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">
        {error}
      </div>
      {needsGitHubSignIn(error) && <ConnectGitHubCard reason="Connect GitHub so Sinfonie can push this branch and open pull requests." onConnected={onRetry} />}
    </div>
  )
}

/** Runs a dialog's submit, keeping the dialog open with the error shown when it fails. */
function useSubmit(fn: () => Promise<void>, onClose: () => void): { busy: boolean; error: string | null; submit: () => Promise<void> } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onClose()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, submit }
}

export function CommitDialog({ onClose, onSubmit, repoName }: { onClose: () => void; onSubmit: (message: string) => Promise<void>; repoName?: string }): React.JSX.Element {
  const [msg, setMsg] = useState('')
  const { busy, error, submit } = useSubmit(() => onSubmit(msg), onClose)
  return (
    <Dialog title={repoName ? `Commit all changes in ${repoName}` : 'Commit all changes in this repository'} onClose={onClose} width={480}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (msg.trim() && !busy) void submit()
        }}
      >
        <Field label="Message">
          <textarea
            autoFocus
            rows={4}
            className={inputCls}
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && msg.trim() && !busy) {
                e.preventDefault()
                void submit()
              }
            }}
          />
        </Field>
        {error && <div role="alert" className="mb-3 whitespace-pre-wrap rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!msg.trim() || busy} title="Commit (⌘↵)">
            {busy ? 'Committing…' : 'Commit'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/**
 * Opens a pull request. Main pushes the branch first when it was never pushed or is ahead, and explains "no commits
 * yet" and GitHub's refusals; a missing GitHub sign-in shows Connect GitHub, which retries once connected.
 */
export function PrDialog({ onClose, onSubmit, defaultTitle = '', hint = 'The branch is pushed first if needed. Links to the sibling branches in this workspace are appended automatically.' }: { onClose: () => void; onSubmit: (title: string, body: string) => Promise<void>; defaultTitle?: string; hint?: string }): React.JSX.Element {
  const [title, setTitle] = useState(defaultTitle)
  const [body, setBody] = useState('')
  const { busy, error, submit } = useSubmit(() => onSubmit(title, body), onClose)
  return (
    <Dialog title="Open pull request" onClose={onClose} width={520}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (title.trim() && !busy) void submit()
        }}
      >
        <Field label="Title">
          <input autoFocus className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Body" hint={hint}>
          <textarea rows={6} className={inputCls} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <DialogError error={error} onRetry={() => void submit()} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || busy}>
            {busy ? 'Opening…' : 'Open pull request'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** Confirms a push: which branch goes where, and how many commits. */
export function PushDialog({ repoName, branch, ahead, hasUpstream, onClose, onConfirm }: { repoName: string; branch?: string; ahead?: number; hasUpstream?: boolean; onClose: () => void; onConfirm: () => Promise<void> }): React.JSX.Element {
  const { busy, error, submit } = useSubmit(onConfirm, onClose)
  const what = ahead === undefined ? 'its commits' : ahead === 0 ? 'no new commits' : `${ahead} commit${ahead === 1 ? '' : 's'}`
  return (
    <Dialog title={`Push ${repoName}`} onClose={onClose} width={440}>
      <p className="mb-3 text-[13px]">
        Push {what} on <code className="rounded bg-panel-2 px-1 font-mono text-[12px]">{branch || 'the current branch'}</code> to the remote{hasUpstream === false ? ', creating the branch there' : ''}.
      </p>
      <DialogError error={error} onRetry={() => void submit()} />
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Pushing…' : 'Push'}
        </Button>
      </div>
    </Dialog>
  )
}
