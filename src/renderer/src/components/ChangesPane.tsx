import React, { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { RefreshCw, GitCommit, Upload, GitPullRequest } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { parseUnifiedDiff, type DiffFile } from '@/lib/diff'
import { Badge, Button, Dialog, Field, inputCls } from './ui'
import type { RepoGitStatus } from '@shared/types'

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
      <div className="min-w-0 flex-1 overflow-auto">
        {diff.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted">{loading ? 'Loading…' : 'No changes'}</div>
        ) : (
          diff.map((f) => <DiffView key={f.path} file={f} />)
        )}
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

function DiffView({ file }: { file: DiffFile }): React.JSX.Element {
  return (
    <div className="border-b border-border">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5 font-mono text-[12px]">
        <span className="truncate">{file.path}</span>
        <span className="ml-auto text-ok">+{file.adds}</span>
        <span className="text-danger">−{file.dels}</span>
      </div>
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
    </div>
  )
}

function CommitDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (message: string) => Promise<void> }): React.JSX.Element {
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

function PrDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (title: string, body: string) => Promise<void> }): React.JSX.Element {
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
