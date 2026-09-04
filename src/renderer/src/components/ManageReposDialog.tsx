import React, { useEffect, useState } from 'react'
import { Plus, Trash2, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Dialog, inputCls } from './ui'
import { shortPath } from '@/lib/format'
import type { RepoSafety } from '@shared/types'

/** Add a repository's worktree to a live workspace, or remove one. */
export function ManageReposDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): React.JSX.Element | null {
  const { workspaces, repos, spaces, setError } = useApp()
  const ws = workspaces.find((w) => w.id === workspaceId)
  const [safety, setSafety] = useState<RepoSafety[]>([])
  const [addId, setAddId] = useState('')
  const [base, setBase] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    api.invoke('workspaces:safety', workspaceId).then(setSafety).catch(() => setSafety([]))
  }, [workspaceId, ws?.repos.length])

  useEffect(() => {
    if (!addId) return
    const repo = repos.find((r) => r.id === addId)
    setBase(repo?.defaultBranch ?? '')
    api.invoke('repos:branches', addId).then(setBranches).catch(() => setBranches([]))
  }, [addId, repos])

  if (!ws) return null
  const space = spaces.find((s) => s.id === ws.spaceId)
  const notIn = repos.filter((r) => !ws.repos.some((x) => x.repoId === r.id))
  const candidates = showAll || !space ? notIn : notIn.filter((r) => r.spaceId === space.id)
  const go = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Dialog title={`Repositories in "${ws.name}"`} onClose={onClose} width={560}>
      <p className="mb-3 text-[12px] text-muted">
        Every repository here has a worktree on branch <code className="rounded bg-panel-2 px-1">{ws.repos[0]?.branch ?? ws.slug}</code>. Adding one creates that worktree and runs its setup script; the chat picks up the new directory on the next message.
      </p>
      <div className="mb-4 flex flex-col gap-1.5">
        {ws.repos.map((wr) => {
          const s = safety.find((x) => x.repoId === wr.repoId)
          const risky = s && (s.uncommitted > 0 || s.unpushed > 0)
          return (
            <div key={wr.repoId} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  {wr.repoName}
                  {wr.repoId === ws.primaryRepoId && <Badge tone="accent">primary</Badge>}
                  {risky && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-warn">
                      <AlertTriangle size={12} /> {s.uncommitted ? `${s.uncommitted} uncommitted` : ''}
                      {s.uncommitted && s.unpushed ? ' · ' : ''}
                      {s.unpushed ? `${s.unpushed} unpushed` : ''}
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px] text-muted">{shortPath(wr.worktreePath)}</div>
              </div>
              <button
                title={ws.repos.length === 1 ? 'A workspace needs at least one repository' : risky ? 'Remove worktree (uncommitted or unpushed work will be lost)' : 'Remove worktree'}
                disabled={ws.repos.length === 1 || busy !== null}
                className="rounded p-1 text-muted hover:text-danger disabled:opacity-30"
                onClick={() => {
                  if (risky && !window.confirm(`${wr.repoName} has uncommitted or unpushed changes that will be lost. Remove it anyway?`)) return
                  void go(wr.repoId, () => api.invoke('workspaces:removeRepo', ws.id, wr.repoId, { deleteBranch: false }))
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="rounded-lg border border-border p-3">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-medium">
          <Plus size={13} /> Add a repository
          {space && notIn.some((r) => r.spaceId !== space.id) && (
            <label className="ml-auto flex items-center gap-1 text-[11px] font-normal text-muted">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show repos outside {space.name}
            </label>
          )}
        </div>
        {candidates.length === 0 ? (
          <div className="text-[12px] text-muted">Every registered repository{space && !showAll ? ` in ${space.name}` : ''} is already here.</div>
        ) : (
          <div className="flex gap-2">
            <select className={inputCls} value={addId} onChange={(e) => setAddId(e.target.value)}>
              <option value="">Pick a repository…</option>
              {candidates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            {addId && (
              <select className="max-w-[180px] rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={base} onChange={(e) => setBase(e.target.value)}>
                {(branches.length ? branches : [base]).map((b) => (
                  <option key={b} value={b}>
                    from {b}
                  </option>
                ))}
              </select>
            )}
            <Button variant="primary" disabled={!addId || busy !== null} onClick={() => go('add', () => api.invoke('workspaces:addRepo', ws.id, addId, base)).then(() => setAddId(''))}>
              {busy === 'add' ? 'Adding…' : 'Add'}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
