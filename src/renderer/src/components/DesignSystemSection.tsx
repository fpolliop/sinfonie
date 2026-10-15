/**
 * Claude Design, phase 2: a space's design system (Settings → a space → Design system).
 *
 * Where the space's component library lives, which claude.ai design-system project it syncs to, and a
 * Sync button that asks a workspace's agent to run the design-sync flow. Nothing is written to Claude
 * Design until the person approves the agent's plan in that chat (DesignSync's finalize_plan).
 */
import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { CheckCircle2, Copy, RefreshCw } from 'lucide-react'
import type { DesignSystemProbe, Space, SpaceDesignSystem } from '@shared/types'
import { api } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { timeAgo } from '@/lib/format'
import { useApp } from '@/stores/app'
import { Button, Field, Spinner, inputCls } from './ui'

export function DesignSystemSection({ space }: { space: Space }): React.JSX.Element {
  const repos = useApp((s) => s.repos)
  const allWorkspaces = useApp((s) => s.workspaces)
  const select = useApp((s) => s.select)
  const closeSettings = useApp((s) => s.closeSettings)
  const notify = useApp((s) => s.notify)
  const ds = space.designSystem ?? {}
  const spaceRepos = repos.filter((r) => r.spaceId === space.id)
  const [probe, setProbe] = useState<DesignSystemProbe | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [folder, setFolder] = useState(ds.folder ?? '')
  const [wsId, setWsId] = useState('')
  useEffect(() => {
    void api
      .invoke('designSystem:last')
      .then((p) => p && setProbe(p))
      .catch(() => undefined)
  }, [])
  const candidates = allWorkspaces.filter((w) => w.spaceId === space.id && !w.archivedAt && w.status === 'ready' && (!ds.repoId || w.repos.some((r) => r.repoId === ds.repoId)))

  const save = (patch: SpaceDesignSystem): void => {
    setError(null)
    void api.invoke('designSystem:save', space.id, patch).catch((err) => setError(friendlyError(err)))
  }
  const check = (): void => {
    setChecking(true)
    setError(null)
    void api
      .invoke('designSystem:probe', true)
      .then(setProbe)
      .catch((err) => setError(friendlyError(err)))
      .finally(() => setChecking(false))
  }
  const sync = (): void => {
    const target = wsId || candidates[0]?.id
    if (!target) return
    void api
      .invoke('designSystem:sync', space.id, target)
      .then(() => {
        notify({ kind: 'success', text: 'Sync started. Approve the plan in the workspace chat before anything is written.' })
        select(target)
        closeSettings()
      })
      .catch((err) => setError(friendlyError(err)))
  }

  return (
    <div className="max-w-[72ch] space-y-5">
      <p className="text-[13px] text-muted">
        Sync this space&apos;s components to a Claude Design design system, so the designs the team makes there use the real components and can be built as drawn. The sync runs in a workspace&apos;s chat: the agent proposes which files to write, and nothing is written until you approve it.
      </p>

      <section className="rounded-lg border border-border bg-panel p-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold">Claude Design on this Mac</span>
          <span className="ml-auto" />
          <Button size="sm" variant="ghost" onClick={check} disabled={checking}>
            {checking ? <Spinner /> : <RefreshCw size={12} aria-hidden />} Check
          </Button>
        </div>
        {!probe && !checking && <p className="mt-2 text-[12px] text-muted">Check whether Claude Design is authorized and which design-system projects you can sync to. It runs a short, read-only request with your Claude account.</p>}
        {checking && <p className="mt-2 text-[12px] text-muted">Asking Claude Design…</p>}
        {probe && probe.authorized && (
          <div className="mt-2 text-[12px]">
            <p className="flex items-center gap-1 text-ok">
              <CheckCircle2 size={13} aria-hidden /> Authorized, checked {timeAgo(probe.checkedAt)}.
            </p>
            <p className="mt-1 text-muted">{probe.projects.length ? `${probe.projects.length} design-system project${probe.projects.length === 1 ? '' : 's'} you can sync to.` : 'No design-system projects yet: the first sync creates one named after this space.'}</p>
          </div>
        )}
        {probe && !probe.authorized && (
          <div className="mt-2 space-y-2 text-[12px]">
            <p className="text-warn">{probe.error ?? 'Claude Design is not authorized on this Mac yet.'}</p>
            <p className="text-muted">Authorize it once: in a terminal (or Sinfonie&apos;s Terminal tab) run <code>claude</code>, then type the command below. Sinfonie&apos;s agents use that authorization from then on.</p>
            <div className="flex items-center gap-2">
              <code className="rounded border border-border bg-bg px-2 py-1">/design-login</code>
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText('/design-login').then(() => notify({ kind: 'success', text: 'Copied /design-login' }))}>
                <Copy size={12} aria-hidden /> Copy
              </Button>
            </div>
          </div>
        )}
      </section>

      <Field label="Design-system project" hint={probe?.authorized ? undefined : 'Check Claude Design above to list your projects.'}>
        <select
          className={clsx(inputCls)}
          value={ds.projectId ?? ''}
          onChange={(e) => {
            const p = probe?.projects.find((x) => x.id === e.target.value)
            save({ projectId: p?.id, projectName: p?.name })
          }}
        >
          <option value="">{`Create a new one named "${space.name}"`}</option>
          {ds.projectId && !probe?.projects.some((p) => p.id === ds.projectId) && <option value={ds.projectId}>{ds.projectName ?? ds.projectId}</option>}
          {probe?.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Repository with the component library">
        <select className={inputCls} value={ds.repoId ?? ''} onChange={(e) => save({ repoId: e.target.value || undefined })}>
          <option value="">Pick a repository</option>
          {spaceRepos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Folder of the components" hint="Inside that repository, e.g. packages/ui/src or src/components. Leave empty to let the agent find it.">
        <input className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value)} onBlur={() => folder !== (ds.folder ?? '') && save({ folder: folder.trim() || undefined })} placeholder="packages/ui/src" />
      </Field>

      <Field label="Run the sync in" hint={candidates.length ? 'A workspace that includes the component repository. Its agent does the sync in its chat.' : 'Create a workspace with the component repository first; the sync runs in its chat.'}>
        <select className={inputCls} value={wsId || candidates[0]?.id || ''} onChange={(e) => setWsId(e.target.value)} disabled={!candidates.length}>
          {candidates.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </Field>

      {error && (
        <div role="alert" className="text-[12px] text-danger">
          {error}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={sync} disabled={!ds.repoId || !candidates.length}>
          Sync design system
        </Button>
        {ds.lastSyncAt && <span className="text-[12px] text-muted">Last sync started {timeAgo(ds.lastSyncAt)}</span>}
      </div>
    </div>
  )
}
