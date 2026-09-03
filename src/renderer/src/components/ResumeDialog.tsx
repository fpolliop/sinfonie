import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Search, History } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { Badge, Button, Dialog } from './ui'
import { shortPath, timeAgo } from '@/lib/format'
import type { SessionSummary } from '@shared/types'

/** Like /resume in the CLI: pick a past Claude Code session and continue it in this workspace. */
export function ResumeDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const reload = useChat((s) => s.reload)
  const [scope, setScope] = useState<'workspace' | 'all'>('workspace')
  const [query, setQuery] = useState('')
  const [list, setList] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const t = window.setTimeout(() => {
      api
        .invoke('sessions:list', workspaceId, scope, query)
        .then((l) => !cancelled && setList(l))
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => !cancelled && setLoading(false))
    }, query ? 250 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [workspaceId, scope, query, setError])

  const resume = async (s: SessionSummary): Promise<void> => {
    setBusy(s.sessionId)
    try {
      await api.invoke('sessions:resume', workspaceId, s.sessionId)
      await reload(workspaceId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog title="Resume a session" onClose={onClose} width={640}>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-md border border-border bg-bg px-2 py-1.5">
          <Search size={13} className="text-muted" />
          <input autoFocus className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted" placeholder="Search by title, first message, folder or branch…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="flex rounded-md bg-panel p-0.5">
          {(['workspace', 'all'] as const).map((s) => (
            <button key={s} onClick={() => setScope(s)} className={clsx('rounded px-2.5 py-1 text-[12px]', scope === s ? 'bg-panel-2 text-text' : 'text-muted')}>
              {s === 'workspace' ? 'This workspace' : 'All projects'}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-2 text-[11px] text-muted">The chosen session's history replaces this chat's transcript and your next message continues it, with this workspace's worktrees in scope. The current session is kept on disk and stays listed here.</p>
      <div className="max-h-[52vh] overflow-auto rounded-lg border border-border">
        {loading && list.length === 0 && <div className="p-4 text-[12px] text-muted">Loading sessions…</div>}
        {!loading && list.length === 0 && <div className="p-4 text-[12px] text-muted">{scope === 'workspace' ? 'No sessions recorded in this workspace yet. Try "All projects".' : 'No sessions match.'}</div>}
        {list.map((s) => (
          <button key={s.sessionId} disabled={busy !== null} onClick={() => void resume(s)} className="flex w-full flex-col gap-0.5 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-panel-2">
            <div className="flex items-center gap-2">
              <History size={13} className="shrink-0 text-muted" />
              <span className="truncate text-[13px] font-medium">{s.title}</span>
              {s.inWorkspace && <Badge tone="accent">here</Badge>}
              <span className="ml-auto shrink-0 text-[11px] text-muted">{busy === s.sessionId ? 'Resuming…' : timeAgo(new Date(s.lastModified).toISOString())}</span>
            </div>
            <div className="flex items-center gap-2 truncate text-[11px] text-muted">
              <span className="truncate">{s.cwd ? shortPath(s.cwd) : ''}</span>
              {s.gitBranch && <span className="shrink-0">· {s.gitBranch}</span>}
              <span className="shrink-0">· {s.sessionId.slice(0, 8)}</span>
            </div>
          </button>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  )
}
