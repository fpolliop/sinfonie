import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Plus, Database, Pencil, Trash2, PlugZap, Cloud, KeyRound, Server } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Dialog, Field, inputCls } from './ui'
import type { DbConnection, DbSecrets } from '@shared/types'

const blank = (): DbConnection => ({ id: '', name: '', kind: 'postgres', database: '', user: '', createdAt: '', tunnel: { kind: 'none' } })

/** Database connections of a space: list, add / edit form with Cloud SQL and SSH tunnels, test, remove. */
export function DatabasesSection({ spaceId }: { spaceId: string }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const [list, setList] = useState<DbConnection[]>([])
  const [editing, setEditing] = useState<DbConnection | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [testing, setTesting] = useState<Record<string, string>>({})
  const load = (): void => {
    api.invoke('db:list', spaceId).then(setList).catch((err) => setError(String(err)))
  }
  useEffect(load, [spaceId])
  const test = async (c: DbConnection): Promise<void> => {
    setTesting((t) => ({ ...t, [c.id]: 'Testing…' }))
    const r = await api.invoke('db:test', spaceId, c).catch((err) => ({ ok: false, message: String(err), ms: 0 }))
    setTesting((t) => ({ ...t, [c.id]: `${r.ok ? '✓' : '✗'} ${r.message} (${(r.ms / 1000).toFixed(1)}s)` }))
  }
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[14px] font-semibold">Databases for this space</div>
        <p className="mt-1 text-[12px] text-muted">Postgres, MySQL, SQLite, MongoDB and BigQuery: directly, through an SSH tunnel, or through Cloud SQL with your Google account. The Data tab of every workspace in this space can browse and query them, and agents get read-only tools. Passwords are stored in the macOS keychain.</p>
      </div>
      {list.length === 0 && <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">No connections yet.</div>}
      <div className="space-y-2">
        {list.map((c) => (
          <div key={c.id} className="rounded-lg border border-border px-3 py-2 text-[12px]">
            <div className="flex items-center gap-2">
              <Database size={14} className="text-muted" />
              <span className="font-medium">{c.name}</span>
              <Badge>{c.kind}</Badge>
              <span className="text-muted">{c.kind === 'sqlite' ? c.path : c.kind === 'bigquery' ? c.projectId || 'space project' : c.database}</span>
              {c.tunnel?.kind === 'cloudsql' && (
                <Badge tone="accent">
                  <Cloud size={10} /> {c.tunnel.instance}
                </Badge>
              )}
              {c.tunnel?.kind === 'ssh' && (
                <Badge tone="accent">
                  <KeyRound size={10} /> ssh {c.tunnel.sshHost}
                </Badge>
              )}
              {c.tunnel?.kind !== 'cloudsql' && c.tunnel?.kind !== 'ssh' && c.host && (
                <span className="text-muted">
                  <Server size={10} className="mr-0.5 inline" />
                  {c.host}:{c.port ?? (c.kind === 'postgres' ? 5432 : 3306)}
                </span>
              )}
              {c.allowWrites ? <Badge tone="warn">writes allowed</Badge> : <Badge tone="ok">read-only</Badge>}
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => void test(c)} title="Open a connection, run SELECT 1, close it">
                  <PlugZap size={12} /> Test
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                  <Pencil size={12} />
                </Button>
                {removing === c.id ? (
                  <>
                    <Button size="sm" variant="danger" onClick={() => api.invoke('db:remove', spaceId, c.id).then(load).catch((err) => setError(String(err)))}>
                      Remove
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(c.id)} title="Remove this connection">
                    <Trash2 size={12} />
                  </Button>
                )}
              </span>
            </div>
            {testing[c.id] && <div className={clsx('mt-1 text-[11px]', testing[c.id].startsWith('✓') ? 'text-ok' : testing[c.id].startsWith('✗') ? 'text-danger' : 'text-muted')}>{testing[c.id]}</div>}
          </div>
        ))}
      </div>
      <Button onClick={() => setEditing(blank())}>
        <Plus size={13} /> Add connection
      </Button>
      {editing && (
        <ConnectionForm
          spaceId={spaceId}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </div>
  )
}

function ConnectionForm({ spaceId, initial, onClose, onSaved }: { spaceId: string; initial: DbConnection; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const [c, setC] = useState<DbConnection>({ ...initial, tunnel: initial.tunnel ?? { kind: 'none' } })
  const [secrets, setSecrets] = useState<DbSecrets>({})
  const [instances, setInstances] = useState<{ connectionName: string; name: string; engine: string; region: string }[] | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const tunnel = c.tunnel ?? { kind: 'none' as const }
  const set = (patch: Partial<DbConnection>): void => setC((x) => ({ ...x, ...patch }))
  const setTunnel = (patch: Partial<NonNullable<DbConnection['tunnel']>>): void => setC((x) => ({ ...x, tunnel: { ...(x.tunnel ?? { kind: 'none' }), ...patch } }))
  useEffect(() => {
    if (tunnel.kind !== 'cloudsql' || instances) return
    api
      .invoke('db:cloudSqlInstances', spaceId)
      .then(setInstances)
      .catch((err) => {
        setInstances([])
        setStatus(`Could not list Cloud SQL instances: ${err instanceof Error ? err.message : String(err)}`)
      })
  }, [tunnel.kind, instances, spaceId])
  const test = async (): Promise<void> => {
    setBusy('test')
    setStatus('Connecting…')
    const r = await api.invoke('db:test', spaceId, c, secrets).catch((err) => ({ ok: false, message: String(err), ms: 0 }))
    setStatus(`${r.ok ? '✓' : '✗'} ${r.message} (${(r.ms / 1000).toFixed(1)}s)`)
    setBusy(null)
  }
  const save = async (): Promise<void> => {
    if (c.kind === 'sqlite' && !(c.path ?? '').trim()) return setStatus('✗ Choose the database file.')
    if ((c.kind === 'postgres' || c.kind === 'mysql' || c.kind === 'mongodb') && !c.database.trim()) return setStatus('✗ Database name is required.')
    setBusy('save')
    try {
      await api.invoke('db:save', spaceId, { ...c, name: c.name.trim() || c.database || c.path?.split('/').pop() || c.projectId || c.kind }, secrets)
      onSaved()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }
  const defaultPort = c.kind === 'postgres' ? 5432 : c.kind === 'mongodb' ? 27017 : 3306
  const isSql = c.kind === 'postgres' || c.kind === 'mysql'
  const hasNetwork = isSql || c.kind === 'mongodb'
  return (
    <Dialog title={initial.id ? `Edit ${initial.name}` : 'New database connection'} onClose={onClose} width={640}>
      <div className="grid grid-cols-2 gap-3 text-[13px]">
        <Field label="Name">
          <input className={inputCls} placeholder={c.database || 'production'} value={c.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Engine">
          <select className={inputCls} value={c.kind} onChange={(e) => set({ kind: e.target.value as DbConnection['kind'], tunnel: e.target.value === 'mongodb' && c.tunnel?.kind === 'cloudsql' ? { kind: 'none' } : c.tunnel })}>
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL / MariaDB</option>
            <option value="sqlite">SQLite (file)</option>
            <option value="mongodb">MongoDB</option>
            <option value="bigquery">BigQuery</option>
          </select>
        </Field>
        {c.kind === 'sqlite' && (
          <div className="col-span-2">
            <Field label="Database file" hint="Opened read-only unless writes are allowed below; with writes on, a missing file is created.">
              <div className="flex gap-2">
                <input className={inputCls} placeholder="~/data/app.db" value={c.path ?? ''} onChange={(e) => set({ path: e.target.value })} />
                <Button variant="ghost" onClick={() => api.invoke('db:pickSqlite').then((p) => p && set({ path: p })).catch((err) => setError(String(err)))}>
                  Choose…
                </Button>
              </div>
            </Field>
          </div>
        )}
        {c.kind === 'bigquery' && (
          <>
            <Field label="Project" hint="Default: the space’s Google Cloud project.">
              <input className={inputCls} placeholder="my-project" value={c.projectId ?? ''} onChange={(e) => set({ projectId: e.target.value || undefined })} />
            </Field>
            <Field label="Location" hint="US, EU or a region; leave empty to let BigQuery pick.">
              <input className={inputCls} placeholder="US" value={c.location ?? ''} onChange={(e) => set({ location: e.target.value || undefined })} />
            </Field>
            <div className="col-span-2">
              <Field label="Google account" hint="Default: the space’s Google Cloud account. Queries are billed to the project.">
                <input className={inputCls} placeholder="you@example.com" value={c.account ?? ''} onChange={(e) => set({ account: e.target.value || undefined })} />
              </Field>
            </div>
          </>
        )}
        {hasNetwork && (
        <div className="col-span-2">
          <Field label="Connect through">
            <div className="flex rounded-md bg-bg p-0.5">
              {(
                [
                  ['none', 'Host and port'],
                  ['cloudsql', 'Cloud SQL'],
                  ['ssh', 'SSH tunnel']
                ] as const
              )
                .filter(([id]) => id !== 'cloudsql' || isSql)
                .map(([id, label]) => (
                  <button key={id} className={clsx('flex-1 rounded px-2 py-1 text-[12px]', tunnel.kind === id ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')} onClick={() => setTunnel({ kind: id })}>
                    {label}
                  </button>
                ))}
            </div>
          </Field>
        </div>
        )}
        {tunnel.kind === 'cloudsql' && (
          <>
            <div className="col-span-2">
              <Field label="Instance" hint={instances === null ? 'Loading instances from gcloud…' : instances.length ? 'From the space’s Google Cloud project. Type project:region:instance for another project.' : 'Type project:region:instance.'}>
                <input className={inputCls} list="cloudsql-instances" placeholder="project:region:instance" value={tunnel.instance ?? ''} onChange={(e) => setTunnel({ instance: e.target.value })} />
                <datalist id="cloudsql-instances">
                  {(instances ?? []).map((i) => (
                    <option key={i.connectionName} value={i.connectionName}>
                      {i.name} · {i.engine} · {i.region}
                    </option>
                  ))}
                </datalist>
              </Field>
            </div>
            <Field label="IP type">
              <select className={inputCls} value={tunnel.ipType ?? 'PUBLIC'} onChange={(e) => setTunnel({ ipType: e.target.value as 'PUBLIC' })}>
                <option value="PUBLIC">Public IP</option>
                <option value="PRIVATE">Private IP</option>
                <option value="PSC">Private Service Connect</option>
              </select>
            </Field>
            <Field label="Google account" hint="Default: the space’s Google Cloud account. Needs roles/cloudsql.client.">
              <input className={inputCls} placeholder="francisco@example.com" value={tunnel.account ?? ''} onChange={(e) => setTunnel({ account: e.target.value || undefined })} />
            </Field>
            <label className="col-span-2 flex items-start gap-2 text-[12px]">
              <input type="checkbox" className="mt-0.5" checked={Boolean(tunnel.iamAuth)} onChange={(e) => setTunnel({ iamAuth: e.target.checked })} />
              <span>
                IAM database authentication
                <span className="block text-[11px] text-muted">No password: the database user is the Google account (Postgres) or its local part (MySQL). The instance must have IAM auth on and the user created.</span>
              </span>
            </label>
          </>
        )}
        {tunnel.kind === 'ssh' && (
          <>
            <Field label="SSH host">
              <input className={inputCls} placeholder="bastion.example.com" value={tunnel.sshHost ?? ''} onChange={(e) => setTunnel({ sshHost: e.target.value })} />
            </Field>
            <Field label="SSH port">
              <input className={inputCls} type="number" placeholder="22" value={tunnel.sshPort ?? ''} onChange={(e) => setTunnel({ sshPort: Number(e.target.value) || undefined })} />
            </Field>
            <Field label="SSH user">
              <input className={inputCls} placeholder="ubuntu" value={tunnel.sshUser ?? ''} onChange={(e) => setTunnel({ sshUser: e.target.value })} />
            </Field>
            <Field label="Private key path" hint="Leave empty to use an SSH password.">
              <input className={inputCls} placeholder="~/.ssh/id_ed25519" value={tunnel.sshKeyPath ?? ''} onChange={(e) => setTunnel({ sshKeyPath: e.target.value || undefined })} />
            </Field>
            <Field label="Key passphrase">
              <input className={inputCls} type="password" placeholder={initial.id ? '(unchanged)' : ''} value={secrets.sshPassphrase ?? ''} onChange={(e) => setSecrets({ ...secrets, sshPassphrase: e.target.value })} />
            </Field>
            <Field label="SSH password">
              <input className={inputCls} type="password" placeholder={initial.id ? '(unchanged)' : ''} value={secrets.sshPassword ?? ''} onChange={(e) => setSecrets({ ...secrets, sshPassword: e.target.value })} />
            </Field>
          </>
        )}
        {hasNetwork && tunnel.kind !== 'cloudsql' && (
          <>
            <Field label={tunnel.kind === 'ssh' ? 'Database host (from the bastion)' : 'Host'}>
              <input className={inputCls} placeholder="127.0.0.1" value={c.host ?? ''} onChange={(e) => set({ host: e.target.value })} />
            </Field>
            <Field label="Port">
              <input className={inputCls} type="number" placeholder={String(defaultPort)} value={c.port ?? ''} onChange={(e) => set({ port: Number(e.target.value) || undefined })} />
            </Field>
          </>
        )}
        {hasNetwork && (
          <Field label="Database">
            <input className={inputCls} placeholder="app" value={c.database} onChange={(e) => set({ database: e.target.value })} />
          </Field>
        )}
        {hasNetwork && (
          <Field label="User" hint={tunnel.iamAuth ? 'Optional with IAM auth.' : c.kind === 'mongodb' ? 'Leave empty for an unauthenticated server.' : undefined}>
            <input className={inputCls} placeholder="readonly" value={c.user ?? ''} onChange={(e) => set({ user: e.target.value })} />
          </Field>
        )}
        {c.kind === 'mongodb' && (
          <>
            <Field label="Auth database" hint="authSource, usually admin.">
              <input className={inputCls} placeholder="admin" value={c.authSource ?? ''} onChange={(e) => set({ authSource: e.target.value || undefined })} />
            </Field>
            <Field label="Connection URI (optional)" hint="mongodb+srv://… overrides host, user and password. Stored in the keychain.">
              <input className={inputCls} type="password" placeholder={initial.hasPassword ? '(unchanged)' : 'mongodb+srv://user:pass@cluster/db'} value={secrets.uri ?? ''} onChange={(e) => setSecrets({ ...secrets, uri: e.target.value })} />
            </Field>
          </>
        )}
        {hasNetwork && !tunnel.iamAuth && (
          <Field label="Password" hint={initial.hasPassword ? 'Stored in the keychain; leave empty to keep it.' : 'Stored in the keychain.'}>
            <input className={inputCls} type="password" placeholder={initial.hasPassword ? '(unchanged)' : ''} value={secrets.password ?? ''} onChange={(e) => setSecrets({ ...secrets, password: e.target.value })} />
          </Field>
        )}
        {hasNetwork && tunnel.kind === 'none' && (
          <label className="flex items-center gap-2 self-end pb-2 text-[12px]">
            <input type="checkbox" checked={Boolean(c.ssl)} onChange={(e) => set({ ssl: e.target.checked })} /> Use TLS
          </label>
        )}
        <label className="col-span-2 flex items-start gap-2 text-[12px]">
          <input type="checkbox" className="mt-0.5" checked={Boolean(c.allowWrites)} onChange={(e) => set({ allowWrites: e.target.checked })} />
          <span>
            Allow writes
            <span className="block text-[11px] text-muted">Off: every statement runs in a read-only transaction and writes are refused. On: the Data tab asks before a write, and agents ask you through a permission card for each statement. A read-only database user is still the safer setup for production.</span>
          </span>
        </label>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button variant="ghost" disabled={busy !== null} onClick={() => void test()}>
          <PlugZap size={13} /> {busy === 'test' ? 'Connecting…' : 'Test connection'}
        </Button>
        {status && <span className={clsx('text-[12px]', status.startsWith('✓') ? 'text-ok' : status.startsWith('✗') ? 'text-danger' : 'text-muted')}>{status}</span>}
        <span className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy !== null} onClick={() => void save()}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
        </span>
      </div>
    </Dialog>
  )
}
