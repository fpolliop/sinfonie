import React, { useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Dialog, Field, inputCls } from './ui'
import { shortPath } from '@/lib/format'
import { PERMISSION_MODES } from '@shared/types'

function JiraSection(): React.JSX.Element {
  const { settings, setError } = useApp()
  const [token, setToken] = useState('')
  const [testing, setTesting] = useState<string | null>(null)
  const jira = settings.jira
  const save = async (patch: Partial<typeof jira>): Promise<void> => {
    try {
      await api.invoke('settings:update', { jira: { ...jira, ...patch } })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const saveToken = async (): Promise<void> => {
    try {
      await api.invoke('jira:saveToken', token)
      setToken('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const test = async (): Promise<void> => {
    setTesting('Testing…')
    try {
      const issues = await api.invoke('jira:search', '')
      setTesting(`Connected. ${issues.length} ticket${issues.length === 1 ? '' : 's'} match the default query.`)
    } catch (err) {
      setTesting(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <section className="mt-5">
      <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">Jira</h3>
      <p className="mb-3 text-[11px] text-muted">
        Lets "New workspace" start from a ticket and suggest a name. Uses a personal API token from{' '}
        <button className="text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', 'https://id.atlassian.com/manage-profile/security/api-tokens')}>
          id.atlassian.com
        </button>
        , stored encrypted on this Mac.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Site URL">
          <input className={inputCls} placeholder="https://your-team.atlassian.net" defaultValue={jira.siteUrl} onBlur={(e) => e.target.value !== jira.siteUrl && save({ siteUrl: e.target.value.trim() })} />
        </Field>
        <Field label="Email">
          <input className={inputCls} placeholder="you@company.com" defaultValue={jira.email} onBlur={(e) => e.target.value !== jira.email && save({ email: e.target.value.trim() })} />
        </Field>
      </div>
      <Field label={jira.hasToken ? 'API token (stored; paste a new one to replace)' : 'API token'}>
        <div className="flex gap-2">
          <input type="password" className={inputCls} value={token} onChange={(e) => setToken(e.target.value)} placeholder={jira.hasToken ? '••••••••' : ''} />
          <Button onClick={saveToken} disabled={!token.trim()}>
            Save
          </Button>
        </div>
      </Field>
      <Field label="Default ticket list (JQL)" hint="Shown when the search box is empty.">
        <input className={inputCls} defaultValue={jira.defaultJql} onBlur={(e) => e.target.value !== jira.defaultJql && save({ defaultJql: e.target.value })} />
      </Field>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={test} disabled={!jira.siteUrl || !jira.email || !jira.hasToken}>
          Test connection
        </Button>
        {testing && <span className="text-[12px] text-muted">{testing}</span>}
      </div>
    </section>
  )
}

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

      <JiraSection />
    </Dialog>
  )
}
