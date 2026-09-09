import React, { useCallback, useEffect, useState } from 'react'
import { Check, Download, FileJson, FolderOpen, Link2Off, RefreshCw, Share2, Trash2, Upload, Users2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Dialog, inputCls } from './ui'
import { shortPath } from '@/lib/format'
import { SPACE_FILE, type Space, type SpaceImportPreview, type SpaceImportResolution } from '@shared/types'

/**
 * Space → Repositories → Sharing: write the space to sinfonie.space.json in one of its repositories
 * so the team commits it, or follow one that a teammate wrote. Accounts, tokens and folders stay personal.
 */
export function SharedSpaceSection({ space }: { space: Space }): React.JSX.Element {
  const repos = useApp((s) => s.repos).filter((r) => r.spaceId === space.id)
  const setError = useApp((s) => s.setError)
  const [repoId, setRepoId] = useState(space.shared?.repoId ?? repos[0]?.id ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<'unknown' | 'current' | 'changed' | 'missing'>('unknown')
  const [done, setDone] = useState<string | null>(null)
  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  const check = useCallback(async (): Promise<void> => {
    if (!space.shared) return setStatus('unknown')
    const pending = await api.invoke('shared:pending').catch(() => [])
    const mine = pending.find((p) => p.spaceId === space.id)
    setStatus(!mine ? 'current' : mine.missing ? 'missing' : 'changed')
  }, [space.id, space.shared])
  useEffect(() => void check(), [check])

  return (
    <section className="mt-5">
      <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Sharing</div>
      <OrgShareCard space={space} />
      <div className="mb-2 mt-3 text-[11px] text-muted">Or as a file the team commits:</div>
      {space.shared ? (
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-center gap-2 text-[13px]">
            <FileJson size={14} className="text-muted" />
            <span className="font-medium">Follows {SPACE_FILE}</span>
            {status === 'current' && <Badge tone="ok">up to date</Badge>}
            {status === 'changed' && <Badge tone="warn">changed on disk</Badge>}
            {status === 'missing' && <Badge tone="danger">file missing</Badge>}
            <span className="ml-auto flex items-center gap-1">
              <Button size="sm" disabled={busy === 'check'} onClick={() => void run('check', check)} title="Look for changes">
                <RefreshCw size={12} />
              </Button>
              {status === 'changed' && (
                <Button size="sm" variant="primary" disabled={busy === 'apply'} onClick={() => void run('apply', () => api.invoke('shared:apply', space.id).then(check))}>
                  <Download size={12} /> Apply update
                </Button>
              )}
              <Button size="sm" disabled={busy === 'write'} onClick={() => void run('write', () => api.invoke('shared:export', space.id, space.shared?.repoId ?? repoId).then(check))} title="Write this space's current settings to the file">
                <Upload size={12} /> Write file
              </Button>
              <Button size="sm" variant="ghost" disabled={busy === 'unlink'} onClick={() => void run('unlink', () => api.invoke('shared:unlink', space.id))} title="Stop following the file; the space keeps everything">
                <Link2Off size={12} />
              </Button>
            </span>
          </div>
          <div className="mt-1 truncate text-[11px] text-muted">{shortPath(space.shared.file)} · applied {new Date(space.shared.appliedAt).toLocaleString()}</div>
          <p className="mt-2 text-[11px] text-muted">Commit the file with your normal flow. Teammates import it once; after a pull, "Apply update" brings in changes to repositories, crew, integrations and defaults.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 text-[12px] text-muted">
            Write this space to <code className="text-[11px]">{SPACE_FILE}</code> in one of its repositories. Repositories are listed by remote; crew, MCP servers (without keys), Jira site, Linear query, Google Cloud project, on-call channels and defaults travel with it. Accounts and tokens never do.
          </p>
          <div className="flex items-center gap-2">
            <select className={inputCls} value={repoId} onChange={(e) => setRepoId(e.target.value)} disabled={repos.length === 0}>
              {repos.length === 0 && <option value="">Add a repository to this space first</option>}
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <Button variant="primary" disabled={!repoId || busy === 'export'} onClick={() => void run('export', async () => setDone((await api.invoke('shared:export', space.id, repoId)).file))}>
              <Share2 size={13} /> Write file
            </Button>
          </div>
          {done && (
            <div className="mt-2 flex items-center gap-1 text-[12px] text-ok">
              <Check size={12} /> Written to {shortPath(done)}. Commit and push it; teammates import it from Settings → Spaces.
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * Share a space inside an organisation: the definition lives on sinfonie.dev under the organisation and
 * every member gets it. Shows the sync state, missing repositories to locate or clone, and stop-sharing.
 */
function OrgShareCard({ space }: { space: Space }): React.JSX.Element {
  const account = useApp((s) => s.settings.cloud?.account)
  const setError = useApp((s) => s.setError)
  const workspacesRoot = useApp((s) => s.settings.workspacesRoot)
  const orgs = account?.orgs ?? NO_ORGS
  const [orgId, setOrgId] = useState(space.orgId ?? orgs[0]?.id ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [missing, setMissing] = useState<{ remote: string; name: string }[]>([])
  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  const loadMissing = useCallback(async (): Promise<void> => {
    if (!space.orgSpace) return setMissing([])
    setMissing(await api.invoke('orgSpaces:missing', space.id).catch(() => []))
  }, [space.id, space.orgSpace])
  useEffect(() => void loadMissing(), [loadMissing])
  const org = orgs.find((o) => o.id === (space.orgId ?? orgId))
  if (!account) {
    return <div className="rounded-lg border border-border p-3 text-[12px] text-muted">Sign in under Plan to share this space with an organisation.</div>
  }
  if (space.orgSpace && org) {
    return (
      <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
        <div className="flex items-center gap-2 text-[13px]">
          <Users2 size={14} className="text-accent" />
          <span className="font-medium">Shared in {org.name}</span>
          <span className="text-[11px] text-muted">
            version {space.orgSpace.version}
            {space.orgSpace.updatedBy ? ` · by ${space.orgSpace.updatedBy}` : ''} · synced {new Date(space.orgSpace.syncedAt).toLocaleString()}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button size="sm" disabled={busy === 'sync'} onClick={() => void run('sync', () => api.invoke('orgSpaces:sync').then(loadMissing))} title="Pull the latest from the organisation">
              <RefreshCw size={12} />
            </Button>
            <Button size="sm" disabled={busy === 'push'} onClick={() => void run('push', () => api.invoke('orgSpaces:publish', space.id, org.id))} title="Push this space's current settings to the organisation">
              <Upload size={12} /> Push
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === 'unshare'} onClick={() => void run('unshare', () => api.invoke('orgSpaces:unshare', space.id, false))} title="Stop syncing; the space stays on this Mac">
              <Link2Off size={12} />
            </Button>
            {org.role === 'admin' && (
              <Button size="sm" variant="ghost" disabled={busy === 'delete'} onClick={() => window.confirm(`Remove this shared space from ${org.name} for everyone? Members keep their local copy.`) && void run('delete', () => api.invoke('orgSpaces:unshare', space.id, true))} title="Remove it from the organisation for everyone">
                <Trash2 size={12} />
              </Button>
            )}
          </span>
        </div>
        {missing.length > 0 && (
          <div className="mt-2 border-t border-border pt-2">
            <div className="mb-1 text-[11px] text-muted">Repositories in this space that are not on this Mac yet:</div>
            {missing.map((m) => (
              <div key={m.remote} className="flex items-center gap-2 text-[12px]">
                <span className="font-medium">{m.name}</span>
                <span className="truncate text-[11px] text-muted">{m.remote}</span>
                <span className="ml-auto flex gap-1">
                  <Button size="sm" onClick={() => void run(`loc:${m.remote}`, async () => {
                    const path = await api.invoke('dialog:pickFolder', 'Where is this repository checked out?')
                    if (path) await api.invoke('orgSpaces:resolve', space.id, [{ remote: m.remote, path }]).then(loadMissing)
                  })}>
                    Locate…
                  </Button>
                  <Button size="sm" onClick={() => void run(`clone:${m.remote}`, async () => {
                    const parent = await api.invoke('dialog:pickFolder', 'Clone into which folder?', workspacesRoot)
                    if (parent) await api.invoke('orgSpaces:resolve', space.id, [{ remote: m.remote, cloneInto: parent }]).then(loadMissing)
                  })}>
                    Clone…
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
        <GuidedReadiness space={space} />
        <p className="mt-2 text-[11px] text-muted">Repositories, crew, MCP servers without keys, Jira site, Linear query, Google Cloud project, on-call channels and defaults sync to every member. Edits here push automatically; the last write wins.</p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-2 text-[12px] text-muted">Share this space with an organisation: every member gets its repositories and setup, and edits sync both ways. Accounts, tokens and local folders never leave your Mac.</p>
      <div className="flex items-center gap-2">
        <select className={inputCls} value={orgId} onChange={(e) => setOrgId(e.target.value)} disabled={orgs.length === 0}>
          {orgs.length === 0 && <option value="">Create or join an organisation under Plan first</option>}
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <Button variant="primary" disabled={!orgId || busy === 'share'} onClick={() => void run('share', () => api.invoke('orgSpaces:publish', space.id, orgId))}>
          <Users2 size={13} /> Share in organisation
        </Button>
      </div>
    </div>
  )
}
const NO_ORGS: { id: string; name: string; role: 'admin' | 'member'; plan: 'free' | 'pro' | 'team'; seats: number }[] = []

/** Settings → Spaces → Join a shared space: pick a definition file, say where each repository is, import. */
export function ImportSpaceDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const openSettings = useApp((s) => s.openSettings)
  const workspacesRoot = useApp((s) => s.settings.workspacesRoot)
  const [preview, setPreview] = useState<SpaceImportPreview | null>(null)
  const [res, setRes] = useState<Record<string, SpaceImportResolution>>({})
  const [busy, setBusy] = useState(false)
  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err))

  const pick = async (): Promise<void> => {
    try {
      const file = await api.invoke('shared:pickFile')
      if (!file) return
      setPreview(await api.invoke('shared:preview', file))
      setRes({})
    } catch (err) {
      fail(err)
    }
  }
  useEffect(() => void pick(), [])
  const locate = async (remote: string): Promise<void> => {
    const path = await api.invoke('dialog:pickFolder', 'Where is this repository checked out?')
    if (path) setRes((r) => ({ ...r, [remote]: { remote, path } }))
  }
  const cloneInto = async (remote: string): Promise<void> => {
    const parent = await api.invoke('dialog:pickFolder', 'Clone into which folder?', workspacesRoot)
    if (parent) setRes((r) => ({ ...r, [remote]: { remote, cloneInto: parent } }))
  }
  const missing = preview?.repos.filter((r) => !r.match) ?? []
  const ready = preview !== null && missing.every((r) => res[r.remote])
  const doImport = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    try {
      const space = await api.invoke('shared:import', preview.file, Object.values(res))
      onClose()
      openSettings({ scope: 'space', spaceId: space.id, page: 'repos' })
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Join a shared space" onClose={onClose} width={560}>
      {!preview ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Button onClick={() => void pick()}>
            <FolderOpen size={13} /> Choose {SPACE_FILE}
          </Button>
          <span>Usually at the root of one of the team's repositories after a pull.</span>
        </div>
      ) : (
        <div>
          <div className="mb-3 text-[13px]">
            <span className="font-medium">{preview.definition.name}</span>
            <span className="text-muted"> · {preview.repos.length} repositor{preview.repos.length === 1 ? 'y' : 'ies'}</span>
            {preview.existingSpaceId && <Badge tone="accent">already followed, will be refreshed</Badge>}
          </div>
          <div className="mb-3 flex flex-col gap-1.5">
            {preview.repos.map((r) => {
              const chosen = res[r.remote]
              return (
                <div key={r.remote} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-[12px]">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{r.name}</div>
                    <div className="truncate text-[11px] text-muted">{r.remote}</div>
                    {r.match && <div className="truncate text-[11px] text-ok">Found at {shortPath(r.match.path)}</div>}
                    {chosen?.path && <div className="truncate text-[11px] text-ok">Use {shortPath(chosen.path)}</div>}
                    {chosen?.cloneInto && <div className="truncate text-[11px] text-ok">Clone into {shortPath(chosen.cloneInto)}/{r.name}</div>}
                  </div>
                  {!r.match && (
                    <>
                      <Button size="sm" onClick={() => void locate(r.remote)}>
                        Locate…
                      </Button>
                      <Button size="sm" onClick={() => void cloneInto(r.remote)}>
                        Clone…
                      </Button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => void pick()}>
              Choose another file
            </Button>
            <Button variant="primary" className="ml-auto" disabled={!ready || busy} onClick={() => void doImport()}>
              {busy ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

/** A checklist telling the tech lead whether guided-mode teammates can use this shared space yet. */
function GuidedReadiness({ space }: { space: Space }): React.JSX.Element {
  const repos = useApp((s) => s.repos).filter((r) => r.spaceId === space.id)
  const withRun = repos.filter((r) => r.config?.scripts?.run)
  const withPreview = repos.filter((r) => r.config?.preview)
  const rows: { ok: boolean; text: string }[] = [
    { ok: repos.length > 0, text: repos.length ? `${repos.length} app${repos.length === 1 ? '' : 's'} in the space` : 'No apps in the space yet' },
    { ok: repos.length > 0 && withRun.length === repos.length, text: withRun.length === repos.length ? 'Every app has a start command' : `${repos.length - withRun.length} app${repos.length - withRun.length === 1 ? '' : 's'} without a start command` },
    { ok: withPreview.length > 0, text: withPreview.length ? `${withPreview.length} app${withPreview.length === 1 ? '' : 's'} with a preview URL` : 'No preview URL set (the Preview tab needs one)' },
    { ok: (space.guided?.reviewers?.length ?? 0) > 0, text: space.guided?.reviewers?.length ? `Reviewers: ${space.guided.reviewers.join(', ')}` : 'No reviewers set (pull requests will have none)' }
  ]
  const ready = rows.every((r) => r.ok)
  return (
    <div className="mt-2 border-t border-border pt-2">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium">
        {ready ? <Check size={12} className="text-ok" /> : <span className="h-2 w-2 rounded-full bg-warn" />}
        {ready ? 'Ready for guided users' : 'Guided setup'}
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <div key={r.text} className="flex items-center gap-1.5 text-[11px] text-muted">
            {r.ok ? <Check size={11} className="text-ok" /> : <span className="h-[11px] w-[11px] shrink-0 rounded-full border border-border" />}
            <span>{r.text}</span>
          </div>
        ))}
      </div>
      <p className="mt-1 text-[10px] text-muted">Set each app’s start command, preview URL and check under its Guided setup, and the reviewers under the space’s General page.</p>
    </div>
  )
}
