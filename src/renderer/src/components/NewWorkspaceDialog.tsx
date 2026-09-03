import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Button, Dialog, Field, inputCls } from './ui'
import { shortPath } from '@/lib/format'

interface Pick {
  repoId: string
  baseBranch: string
  branches: string[]
}

export function NewWorkspaceDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { repos, select, setShowSettings, setError } = useApp()
  const [name, setName] = useState('')
  const [picks, setPicks] = useState<Record<string, Pick>>({})
  const [primary, setPrimary] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [lastUsed] = useState<string[]>(() => JSON.parse(localStorage.getItem('orchestra.lastRepos') ?? '[]'))

  useEffect(() => {
    // Preselect the repos used last time, so the common "frontend + backend" pair is one click.
    for (const id of lastUsed) if (repos.some((r) => r.id === id)) void toggle(id, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = async (repoId: string, on?: boolean): Promise<void> => {
    const isOn = on ?? !picks[repoId]
    if (!isOn) {
      setPicks((p) => {
        const n = { ...p }
        delete n[repoId]
        return n
      })
      if (primary === repoId) setPrimary('')
      return
    }
    const repo = repos.find((r) => r.id === repoId)!
    let branches: string[] = []
    try {
      branches = await api.invoke('repos:branches', repoId)
    } catch {
      /* ignore */
    }
    setPicks((p) => ({ ...p, [repoId]: { repoId, baseBranch: repo.defaultBranch, branches } }))
    setPrimary((cur) => cur || repoId)
  }

  const selected = Object.values(picks)
  const submit = async (): Promise<void> => {
    if (!name.trim() || selected.length === 0) return
    setBusy(true)
    try {
      localStorage.setItem('orchestra.lastRepos', JSON.stringify(selected.map((s) => s.repoId)))
      const ws = await api.invoke('workspaces:create', {
        name,
        repos: selected.map((s) => ({ repoId: s.repoId, baseBranch: s.baseBranch })),
        primaryRepoId: primary || selected[0].repoId
      })
      select(ws.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="New workspace" onClose={onClose} width={560}>
      <Field label="Name" hint="Becomes the branch name in every selected repo and the folder name on disk.">
        <input autoFocus className={inputCls} placeholder="e.g. checkout-redesign" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </Field>
      <div className="mb-1 text-[12px] font-medium text-muted">Repositories</div>
      {repos.length === 0 && (
        <div className="mb-3 rounded-md border border-border p-3 text-muted">
          No repositories added yet.{' '}
          <button className="text-accent" onClick={() => (onClose(), setShowSettings(true))}>
            Add one in Settings
          </button>
          .
        </div>
      )}
      <div className="mb-4 flex flex-col gap-1.5">
        {repos.map((r) => {
          const p = picks[r.id]
          return (
            <div key={r.id} className={clsx('rounded-lg border px-3 py-2', p ? 'border-accent/50 bg-accent/5' : 'border-border')}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={Boolean(p)} onChange={() => void toggle(r.id)} />
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{r.name}</div>
                  <div className="truncate text-[11px] text-muted">{shortPath(r.path)}</div>
                </div>
                {p && (
                  <div className="ml-auto flex items-center gap-2">
                    <label className="flex items-center gap-1 text-[11px] text-muted">
                      <input type="radio" name="primary" checked={primary === r.id} onChange={() => setPrimary(r.id)} /> primary
                    </label>
                    <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={p.baseBranch} onChange={(e) => setPicks((s) => ({ ...s, [r.id]: { ...p, baseBranch: e.target.value } }))}>
                      {(p.branches.length ? p.branches : [p.baseBranch]).map((b) => (
                        <option key={b} value={b}>
                          from {b}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="mb-4 text-[11px] text-muted">The primary repo is Claude Code's working directory; the others are added as extra directories. Setup scripts run in every repo after all worktrees exist.</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !name.trim() || selected.length === 0}>
          {busy ? 'Creating…' : `Create ${selected.length || ''} worktree${selected.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </Dialog>
  )
}
