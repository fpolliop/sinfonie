import React, { useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Dialog, Field, inputCls } from './ui'
import { shortPath } from '@/lib/format'
import { PERMISSION_MODES } from '@shared/types'

export function SettingsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { repos, settings, setError, workspaces } = useApp()
  const [busy, setBusy] = useState(false)
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const update = (patch: Partial<typeof settings>): Promise<unknown> => api.invoke('settings:update', patch)

  return (
    <Dialog title="Settings" onClose={onClose} width={600}>
      <section className="mb-5">
        <div className="mb-2 flex items-center">
          <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">Repositories</h3>
          <Button size="sm" variant="primary" className="ml-auto" disabled={busy} onClick={() => go(() => api.invoke('repos:pickAndAdd'))}>
            <Plus size={13} /> Add repository
          </Button>
        </div>
        {repos.length === 0 && <div className="rounded-md border border-dashed border-border p-4 text-center text-muted">Add the root folder of each git repository you want to combine in workspaces.</div>}
        <div className="flex flex-col gap-1.5">
          {repos.map((r) => {
            const inUse = workspaces.filter((w) => w.status !== 'archived' && w.repos.some((x) => x.repoId === r.id)).length
            return (
              <div key={r.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-medium">
                    {r.name}
                    <Badge>{r.defaultBranch}</Badge>
                    {r.config?.scripts ? <Badge tone="ok">conductor.json</Badge> : <Badge tone="warn">no conductor.json</Badge>}
                  </div>
                  <div className="truncate text-[11px] text-muted">{shortPath(r.path)}</div>
                </div>
                <button title="Reload conductor.json" className="rounded p-1 text-muted hover:text-text" onClick={() => go(() => api.invoke('repos:reloadConfig', r.id))}>
                  <RefreshCw size={13} />
                </button>
                <button title={inUse ? `Used by ${inUse} workspace(s)` : 'Remove'} disabled={inUse > 0} className="rounded p-1 text-muted hover:text-danger disabled:opacity-30" onClick={() => go(() => api.invoke('repos:remove', r.id))}>
                  <Trash2 size={13} />
                </button>
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">Workspaces</h3>
        <Field label="Workspaces folder" hint="Each workspace becomes <folder>/<name>/<repo> so all worktrees of a feature sit together.">
          <input className={inputCls} defaultValue={settings.workspacesRoot} onBlur={(e) => e.target.value !== settings.workspacesRoot && go(() => update({ workspacesRoot: e.target.value }))} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Base port" hint="Each workspace gets a block of 10 ports starting here.">
            <input type="number" className={inputCls} defaultValue={settings.basePort} onBlur={(e) => go(() => update({ basePort: Number(e.target.value) || 55000 }))} />
          </Field>
          <Field label="Model" hint="Claude model alias or full id for new sessions.">
            <input className={inputCls} defaultValue={settings.model} onBlur={(e) => e.target.value !== settings.model && go(() => update({ model: e.target.value }))} />
          </Field>
        </div>
        <Field label="Default permission mode" hint="Used for new workspaces. Each chat can switch its own mode from the composer or with Shift+Tab.">
          <select className={inputCls} value={settings.permissionMode} onChange={(e) => go(() => update({ permissionMode: e.target.value as typeof settings.permissionMode }))}>
            {PERMISSION_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.hint}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-[11px] text-muted">Model and permission mode apply to sessions started after the change. Use "New session" in a chat to restart one.</p>
      </section>
    </Dialog>
  )
}
