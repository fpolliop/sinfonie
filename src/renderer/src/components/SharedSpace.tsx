import React, { useCallback, useEffect, useState } from 'react'
import { Check, Download, FileJson, FolderOpen, Link2Off, RefreshCw, Share2, Upload } from 'lucide-react'
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
