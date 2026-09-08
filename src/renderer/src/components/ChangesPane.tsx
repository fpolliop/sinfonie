import React, { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { RefreshCw, GitCommit, Upload, GitPullRequest } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { parseUnifiedDiff, toSplitRows, changedNewLines, type DiffFile, type DiffLine } from '@/lib/diff'
import { Badge, Button, Dialog, Field, inputCls } from './ui'
import type { RepoGitStatus } from '@shared/types'

export type ViewMode = 'unified' | 'split' | 'file'
const VIEW_KEY = 'sinfonie.changesView'
const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: 'unified', label: 'Unified' },
  { id: 'split', label: 'Split' },
  { id: 'file', label: 'File' }
]
function loadViewMode(): ViewMode {
  const v = localStorage.getItem(VIEW_KEY)
  return v === 'split' || v === 'file' ? v : 'unified'
}

export function ChangesPane({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const setError = useApp((s) => s.setError)
  const [statuses, setStatuses] = useState<RepoGitStatus[]>([])
  const [repoId, setRepoId] = useState<string>(ws?.primaryRepoId ?? '')
  const [file, setFile] = useState<string | undefined>()
  const [diff, setDiff] = useState<DiffFile[]>([])
  const [loading, setLoading] = useState(false)
  const [commitDlg, setCommitDlg] = useState(false)
  const [prDlg, setPrDlg] = useState(false)
  const [view, setView] = useState<ViewMode>(loadViewMode)

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view)
  }, [view])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const s = await api.invoke('git:status', workspaceId)
      setStatuses(s)
      if (repoId) setDiff(parseUnifiedDiff(await api.invoke('git:diff', workspaceId, repoId, file)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workspaceId, repoId, file, setError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!ws) return <div />
  const current = statuses.find((s) => s.repoId === repoId)
  const worktreePath = ws.repos.find((r) => r.repoId === repoId)?.worktreePath ?? ''
  const act = async (fn: () => Promise<string>): Promise<void> => {
    try {
      const out = await fn()
      if (out) setError(out)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Repositories</span>
          <button className="ml-auto rounded p-1 text-muted hover:text-text" onClick={() => void refresh()} title="Refresh">
            <RefreshCw size={13} className={clsx(loading && 'animate-spin')} />
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {ws.repos.map((r) => {
            const st = statuses.find((s) => s.repoId === r.repoId)
            const active = r.repoId === repoId
            return (
              <div key={r.repoId} className="border-b border-border">
                <button
                  onClick={() => {
                    setRepoId(r.repoId)
                    setFile(undefined)
                  }}
                  className={clsx('flex w-full items-center gap-2 px-2 py-1.5 text-left', active ? 'bg-panel-2' : 'hover:bg-panel')}
                >
                  <span className="truncate text-[13px] font-medium">{r.repoName}</span>
                  <span className="ml-auto flex shrink-0 gap-1">
                    {st && st.files.length > 0 && <Badge tone="warn">{st.files.length}</Badge>}
                    {st && st.ahead > 0 && <Badge tone="accent">↑{st.ahead}</Badge>}
                    {st && st.behind > 0 && <Badge>↓{st.behind}</Badge>}
                  </span>
                </button>
                {active &&
                  st?.files.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => setFile(f.path === file ? undefined : f.path)}
                      className={clsx('flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-[11px]', f.path === file ? 'bg-accent/10 text-text' : 'text-muted hover:text-text')}
                    >
                      <span className={clsx('w-3 shrink-0 font-bold', f.status === 'M' ? 'text-warn' : f.status === 'A' || f.status === '?' ? 'text-ok' : f.status === 'D' ? 'text-danger' : '')}>{f.status}</span>
                      <span className="truncate">{f.path}</span>
                    </button>
                  ))}
                {active && st && st.files.length === 0 && <div className="px-3 py-1.5 text-[11px] text-muted">Clean</div>}
              </div>
            )
          })}
        </div>
        <div className="flex flex-wrap gap-1.5 border-t border-border p-2">
          <Button size="sm" onClick={() => setCommitDlg(true)} disabled={!current || current.files.length === 0}>
            <GitCommit size={13} /> Commit
          </Button>
          <Button size="sm" onClick={() => act(() => api.invoke('git:push', workspaceId, repoId))} disabled={!current}>
            <Upload size={13} /> Push
          </Button>
          <Button size="sm" onClick={() => setPrDlg(true)} disabled={!current}>
            <GitPullRequest size={13} /> PR
          </Button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
          <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">{file ?? 'All changes'}</span>
          <div className="ml-auto inline-flex shrink-0 rounded-md border border-border bg-panel-2 p-0.5" role="tablist" aria-label="View mode">
            {VIEW_MODES.map((m) => (
              <button
                key={m.id}
                role="tab"
                aria-selected={view === m.id}
                onClick={() => setView(m.id)}
                className={clsx('rounded px-2 py-0.5 text-[11px] font-medium', view === m.id ? 'bg-panel text-text' : 'text-muted hover:text-text')}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-auto">
          {diff.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted">{loading ? 'Loading…' : 'No changes'}</div>
          ) : (
            diff.map((f) => <DiffView key={f.path} file={f} view={view} workspaceId={workspaceId} worktreePath={worktreePath} />)
          )}
        </div>
      </div>
      {commitDlg && (
        <CommitDialog
          onClose={() => setCommitDlg(false)}
          onSubmit={(msg) => act(async () => {
            const sha = await api.invoke('git:commit', workspaceId, repoId, msg)
            return `Committed ${sha.slice(0, 8)}`
          })}
        />
      )}
      {prDlg && <PrDialog onClose={() => setPrDlg(false)} onSubmit={(t, b) => act(() => api.invoke('git:createPr', workspaceId, repoId, t, b))} />}
    </div>
  )
}

export function DiffView({ file, view, workspaceId, worktreePath }: { file: DiffFile; view: ViewMode; workspaceId: string; worktreePath: string }): React.JSX.Element {
  return (
    <div className="border-b border-border">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5 font-mono text-[12px]">
        <span className="truncate">{file.path}</span>
        <span className="ml-auto text-ok">+{file.adds}</span>
        <span className="text-danger">−{file.dels}</span>
      </div>
      {view === 'split' ? <SplitView file={file} /> : view === 'file' ? <FileView file={file} workspaceId={workspaceId} worktreePath={worktreePath} /> : <UnifiedView file={file} />}
    </div>
  )
}

function UnifiedView({ file }: { file: DiffFile }): React.JSX.Element {
  return (
    <table className="w-full border-collapse font-mono text-[11.5px] leading-[18px]">
      <tbody>
        {file.lines.map((l, i) => (
          <tr key={i} className={clsx(l.kind === 'add' && 'bg-ok/10', l.kind === 'del' && 'bg-danger/10', l.kind === 'hunk' && 'bg-accent/10 text-accent', l.kind === 'meta' && 'text-muted')}>
            <td className="w-10 select-none pr-1 text-right text-muted/70">{l.oldNo ?? ''}</td>
            <td className="w-10 select-none pr-2 text-right text-muted/70">{l.newNo ?? ''}</td>
            <td className={clsx('w-3 select-none', l.kind === 'add' && 'text-ok', l.kind === 'del' && 'text-danger')}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</td>
            <td className="whitespace-pre-wrap break-all pr-3">{l.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SplitCell({ line, side }: { line?: DiffLine; side: 'old' | 'new' }): React.JSX.Element {
  const changed = line && (side === 'old' ? line.kind === 'del' : line.kind === 'add')
  const tint = changed ? (side === 'old' ? 'bg-danger/10' : 'bg-ok/10') : !line ? 'bg-panel-2/40' : ''
  return (
    <>
      <td className={clsx('w-10 select-none pr-2 text-right align-top text-muted/70', tint)}>{line ? (side === 'old' ? line.oldNo : line.newNo) ?? '' : ''}</td>
      <td className={clsx('w-3 select-none align-top', tint, changed && (side === 'old' ? 'text-danger' : 'text-ok'))}>{changed ? (side === 'old' ? '−' : '+') : ''}</td>
      <td className={clsx('whitespace-pre-wrap break-all pr-3 align-top', tint)}>{line?.text ?? ''}</td>
    </>
  )
}

function SplitView({ file }: { file: DiffFile }): React.JSX.Element {
  const rows = useMemo(() => toSplitRows(file), [file])
  return (
    <table className="w-full table-fixed border-collapse font-mono text-[11.5px] leading-[18px]">
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
              <td colSpan={6} className="whitespace-pre-wrap break-all px-3">
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
    setContent({ state: 'loading' })
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
  }, [workspaceId, worktreePath, file.path, deleted])

  if (content.state !== 'ok') {
    const msg =
      content.state === 'loading' ? 'Loading…' : content.state === 'deleted' ? 'This file was deleted; switch to Unified or Split to see its former contents.' : content.state === 'binary' ? 'Binary file' : content.message
    return <div className={clsx('px-3 py-2 text-[12px]', content.state === 'error' ? 'text-danger' : 'text-muted')}>{msg}</div>
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse font-mono text-[11.5px] leading-[18px]">
        <tbody>
          {content.lines.map((text, i) => {
            const no = i + 1
            const added = marks.added.has(no)
            const removedBefore = marks.deletedBefore.has(no)
            return (
              <tr key={i} className={clsx(added && 'bg-ok/10', removedBefore && 'border-t border-danger/60')}>
                <td className="w-10 select-none pr-2 text-right text-muted/70">{no}</td>
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

export function CommitDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (message: string) => Promise<void> }): React.JSX.Element {
  const [msg, setMsg] = useState('')
  return (
    <Dialog title="Commit all changes in this repo" onClose={onClose} width={480}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!msg.trim()) return
          await onSubmit(msg)
          onClose()
        }}
      >
        <Field label="Message">
          <textarea autoFocus rows={4} className={inputCls} value={msg} onChange={(e) => setMsg(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!msg.trim()}>
            Commit
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function PrDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (title: string, body: string) => Promise<void> }): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  return (
    <Dialog title="Create pull request (gh)" onClose={onClose} width={520}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          await onSubmit(title, body)
          onClose()
        }}
      >
        <Field label="Title">
          <input autoFocus className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Body" hint="Links to the sibling branches in this workspace are appended automatically.">
          <textarea rows={6} className={inputCls} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim()}>
            Create PR
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
