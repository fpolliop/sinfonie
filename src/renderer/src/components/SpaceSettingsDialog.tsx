import React, { useState } from 'react'
import { Plus, Trash2, FolderGit2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Dialog, Field, inputCls } from './ui'
import { JiraSection } from './JiraSection'
import { shortPath } from '@/lib/format'
import { SPACE_COLORS } from '@shared/types'

/** Everything a space owns: its name and colour, its repositories, its Claude account, its Jira. */
export function SpaceSettingsDialog({ spaceId, onClose }: { spaceId: string; onClose: () => void }): React.JSX.Element | null {
  const { spaces, repos, workspaces, settings, setError } = useApp()
  const space = spaces.find((s) => s.id === spaceId)
  const [assign, setAssign] = useState('')
  if (!space) return null
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const mine = repos.filter((r) => r.spaceId === space.id)
  const others = repos.filter((r) => r.spaceId !== space.id)
  const inUse = (repoId: string): number => workspaces.filter((w) => w.status !== 'archived' && w.spaceId === space.id && w.repos.some((x) => x.repoId === repoId)).length
  return (
    <Dialog title={`Space: ${space.name}`} onClose={onClose} width={640}>
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <Field label="Name">
          <input className={inputCls} defaultValue={space.name} onBlur={(e) => e.target.value.trim() && e.target.value !== space.name && go(() => api.invoke('spaces:update', space.id, { name: e.target.value.trim() }))} />
        </Field>
        <Field label="Colour">
          <div className="flex h-[34px] items-center gap-1.5">
            {SPACE_COLORS.map((c) => (
              <button key={c} className="h-5 w-5 rounded-full border-2" style={{ background: c, borderColor: c === space.color ? '#fff' : 'transparent' }} onClick={() => go(() => api.invoke('spaces:update', space.id, { color: c }))} />
            ))}
          </div>
        </Field>
      </div>
      {settings.claudeAccounts.length > 1 && (
        <Field label="Claude account for new workspaces">
          <select className={inputCls} value={space.claudeAccountId ?? ''} onChange={(e) => go(() => api.invoke('spaces:update', space.id, { claudeAccountId: e.target.value || undefined }))}>
            <option value="">App default</option>
            {settings.claudeAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <section className="mt-2">
        <div className="mb-2 flex items-center">
          <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">Repositories</h3>
          <Button size="sm" variant="primary" className="ml-auto" onClick={() => go(() => api.invoke('repos:pickAndAdd', space.id))}>
            <Plus size={13} /> Add repository
          </Button>
        </div>
        {mine.length === 0 && <div className="mb-2 rounded-md border border-dashed border-border p-3 text-center text-[12px] text-muted">No repositories in this space yet. New workspaces here will offer these repos.</div>}
        <div className="mb-2 flex flex-col gap-1.5">
          {mine.map((r) => (
            <div key={r.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
              <FolderGit2 size={14} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  {r.name}
                  <Badge>{r.defaultBranch}</Badge>
                  {r.config?.scripts ? <Badge tone="ok">conductor.json</Badge> : null}
                </div>
                <div className="truncate text-[11px] text-muted">{shortPath(r.path)}</div>
              </div>
              <span className="text-[11px] text-muted">{inUse(r.id) ? `${inUse(r.id)} workspace${inUse(r.id) === 1 ? '' : 's'}` : ''}</span>
              <button title="Remove from this space (the repo stays in the app)" className="rounded p-1 text-muted hover:text-danger" onClick={() => go(() => api.invoke('repos:setSpace', r.id, null))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        {others.length > 0 && (
          <div className="flex gap-2">
            <select className={inputCls} value={assign} onChange={(e) => setAssign(e.target.value)}>
              <option value="">Move an existing repository here…</option>
              {others.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.spaceId ? ` (in ${spaces.find((s) => s.id === r.spaceId)?.name ?? 'another space'})` : ''}
                </option>
              ))}
            </select>
            <Button disabled={!assign} onClick={() => go(() => api.invoke('repos:setSpace', assign, space.id)).then(() => setAssign(''))}>
              Move
            </Button>
          </div>
        )}
      </section>

      <JiraSection connId={space.id} title="Jira for this space" intro="Connect the Jira site this space's tickets live in. Leave it disconnected to use the default connection from Settings." />
    </Dialog>
  )
}
