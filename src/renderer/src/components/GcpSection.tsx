import React, { useEffect, useState } from 'react'
import { RefreshCw, LogIn, PlugZap } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Field, inputCls } from './ui'
import type { GcpSettings, GcpStatus } from '@shared/types'

/** Google Cloud for the app ('' connId) or for one space: local gcloud login, project, default region, tool exposure. */
export function GcpSection({ connId, title, intro }: { connId: string; title?: string; intro?: string }): React.JSX.Element {
  const { settings, spaces, setError } = useApp()
  const space = spaces.find((s) => s.id === connId)
  const cfg: GcpSettings = (connId ? space?.gcp : settings.gcp) ?? { projectId: '' }
  const inherited = connId && !space?.gcp?.projectId ? settings.gcp : undefined
  const [status, setStatus] = useState<GcpStatus | null>(null)
  const [projects, setProjects] = useState<{ projectId: string; name: string }[]>([])
  const [busy, setBusy] = useState<'status' | 'login' | 'projects' | 'test' | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  const account = cfg.account || status?.accounts.find((a) => a.active)?.account
  const load = (force = false): void => {
    setBusy('status')
    api
      .invoke('gcp:status', force)
      .then(setStatus)
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(null))
  }
  useEffect(() => load(), [])
  useEffect(() => {
    if (!status?.installed || !status.accounts.length) return
    setBusy('projects')
    api
      .invoke('gcp:projects', account, false)
      .then(setProjects)
      .catch(() => setProjects([]))
      .finally(() => setBusy((b) => (b === 'projects' ? null : b)))
  }, [status?.installed, status?.accounts.length, account])
  const save = async (patch: Partial<GcpSettings>): Promise<void> => {
    const next = { ...cfg, ...patch }
    try {
      if (connId) await api.invoke('spaces:update', connId, { gcp: next.projectId ? next : undefined })
      else await api.invoke('settings:update', { gcp: next.projectId ? next : undefined })
    } catch (err) {
      setError(String(err))
    }
  }
  const login = (): void => {
    setBusy('login')
    api
      .invoke('gcp:login')
      .then(setStatus)
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(null))
  }
  const test = (): void => {
    setBusy('test')
    setTestResult(null)
    api
      .invoke('gcp:test', connId)
      .then(setTestResult)
      .catch((err) => setTestResult(`Failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(null))
  }
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[14px] font-semibold">{title ?? 'Google Cloud'}</div>
        <p className="mt-1 text-[12px] text-muted">{intro ?? 'Sinfonie uses your local gcloud login. Sessions and the on-call agent get read-only tools: Cloud Logging, Cloud Run, Error Reporting, and any list / describe gcloud command. Nothing can change infrastructure.'}</p>
      </div>
      <div className="rounded-lg border border-border p-3 text-[12px]">
        <div className="flex items-center gap-2">
          <span className="font-medium">gcloud</span>
          {status === null ? <Badge>checking…</Badge> : status.installed ? <Badge tone="ok">installed{status.version ? ` · ${status.version}` : ''}</Badge> : <Badge tone="danger">not installed</Badge>}
          {status?.error && <span className="text-danger">{status.error}</span>}
          <span className="ml-auto flex gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => load(true)}>
              <RefreshCw size={12} className={busy === 'status' ? 'animate-spin' : ''} /> Refresh
            </Button>
            <Button size="sm" disabled={busy !== null || status?.installed === false} onClick={login}>
              <LogIn size={12} /> {busy === 'login' ? 'Waiting for the browser…' : status?.accounts.length ? 'Sign in with another account' : 'Sign in'}
            </Button>
          </span>
        </div>
        {status && !status.installed && (
          <p className="mt-2 text-muted">
            Install the Google Cloud SDK, then come back: <code className="rounded bg-bg px-1">brew install --cask google-cloud-sdk</code>
          </p>
        )}
        {status?.installed && status.accounts.length === 0 && <p className="mt-2 text-muted">No Google account is signed in yet. Sign in opens the browser; the login stays in gcloud, not in Sinfonie.</p>}
        {status?.installed && status.accounts.length > 0 && (
          <p className="mt-2 text-muted">
            Signed in as {status.accounts.map((a) => a.account).join(', ')}
            {status.defaultProject ? ` · gcloud default project ${status.defaultProject}` : ''}
          </p>
        )}
      </div>
      {inherited?.projectId && <p className="text-[12px] text-muted">This space inherits the application project {inherited.projectId}. Pick a project below to override it.</p>}
      <Field label="Account" hint="Which signed-in Google account runs the commands.">
        <select className={inputCls} value={cfg.account ?? ''} onChange={(e) => void save({ account: e.target.value || undefined })}>
          <option value="">gcloud active account{status?.accounts.find((a) => a.active) ? ` (${status.accounts.find((a) => a.active)!.account})` : ''}</option>
          {(status?.accounts ?? []).map((a) => (
            <option key={a.account} value={a.account}>
              {a.account}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Project" hint={busy === 'projects' ? 'Loading your projects…' : projects.length ? 'Projects the account can see. Type an id if yours is missing.' : 'Type the project id.'}>
        <div className="flex gap-2">
          <input className={inputCls} list={`gcp-projects-${connId || 'app'}`} placeholder="my-project-id" defaultValue={cfg.projectId} onBlur={(e) => e.target.value.trim() !== cfg.projectId && void save({ projectId: e.target.value.trim() })} />
          <datalist id={`gcp-projects-${connId || 'app'}`}>
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name}
              </option>
            ))}
          </datalist>
        </div>
      </Field>
      <Field label="Default region" hint="Used for Cloud Run describe / revisions when the agent gives none. Optional.">
        <input className={inputCls} placeholder="us-central1" defaultValue={cfg.region ?? ''} onBlur={(e) => (e.target.value.trim() || undefined) !== cfg.region && void save({ region: e.target.value.trim() || undefined })} />
      </Field>
      {connId && (
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={space?.exposeGcpMcp !== false} onChange={(e) => api.invoke('spaces:update', connId, { exposeGcpMcp: e.target.checked }).catch((err) => setError(String(err)))} />
          <span>
            Give sessions in this space the Google Cloud tools
            <span className="block text-[11px] text-muted">Read-only. The on-call agent uses them regardless when a project is set.</span>
          </span>
        </label>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" disabled={busy !== null || !(cfg.projectId || inherited?.projectId)} onClick={test}>
          <PlugZap size={12} /> {busy === 'test' ? 'Testing…' : 'Test: read the newest error log'}
        </Button>
        {testResult && <span className="text-[12px] text-muted">{testResult}</span>}
      </div>
    </div>
  )
}
