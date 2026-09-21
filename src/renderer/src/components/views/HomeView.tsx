/**
 * Home: the user's generated pages for the active space. Personal views and the space's shared ones
 * sit in tabs; a gallery of templates starts new ones, and Maestro changes them. Each view's header
 * says whose it is and offers undo, a personal copy of a team view, hide and delete.
 */
import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { LayoutDashboard, MoreHorizontal, Plus, Undo2, Users, User, Wand2 } from 'lucide-react'
import type { ScopedView } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { openMaestro } from '@/stores/maestro'
import { useGuided } from '@/lib/guided'
import { useCurrentSpaceId, visibleViews } from '@/lib/views'
import { Button, Dialog } from '@/components/ui'
import { ContextMenu, type MenuEntry } from '@/components/ContextMenu'
import { ViewHost } from './ViewHost'
import { ViewIcon } from './registry'

type TemplateMeta = Awaited<ReturnType<typeof window.sinfonie.invoke<'views:templates'>>>[number]

const errText = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))

export function HomeView(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const spaces = useApp((s) => s.spaces)
  const activeSpaceId = useCurrentSpaceId()
  const homeViewId = useApp((s) => s.homeViewId)
  const setHomeViewId = useApp((s) => s.setHomeViewId)
  const setError = useApp((s) => s.setError)
  const guided = useGuided()
  const space = spaces.find((s) => s.id === activeSpaceId)
  const views = useMemo(() => visibleViews('home', activeSpaceId || undefined, settings, spaces), [activeSpaceId, settings, spaces])
  const selected = views.find((v) => v.id === homeViewId) ?? views[0]
  const [gallery, setGallery] = useState(false)
  const showGallery = gallery || !selected

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-1 border-b border-border px-4">
        <LayoutDashboard size={15} className="mr-1 text-accent" />
        <span className="mr-3 text-[13px] font-semibold">Home</span>
        <nav className="no-drag flex min-w-0 items-center gap-1 overflow-x-auto">
          {views.map((v) => (
            <button
              key={v.id}
              onClick={() => {
                setHomeViewId(v.id)
                setGallery(false)
              }}
              className={clsx('flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium', !showGallery && v.id === selected?.id ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-text')}
              title={v.scope.kind === 'space' ? `Shared with ${space?.name ?? 'the space'}` : v.basedOn ? 'Your copy of a team view' : 'Only you see this'}
            >
              <ViewIcon name={v.icon} size={12} />
              {v.title}
              {v.scope.kind === 'space' && <Users size={10} className="opacity-60" />}
            </button>
          ))}
          <button onClick={() => setGallery(true)} className={clsx('flex h-[26px] shrink-0 items-center gap-1 rounded-md px-2 text-[12px]', showGallery ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-text')} title="Add a view">
            <Plus size={13} /> {views.length ? '' : 'Add a view'}
          </button>
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {showGallery ? (
          <Gallery
            spaceId={activeSpaceId || undefined}
            spaceName={space?.name}
            guided={guided}
            onInstalled={(v) => {
              setHomeViewId(v.id)
              setGallery(false)
            }}
            onError={setError}
          />
        ) : (
          <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-6 py-5">
            <ViewHeader view={selected} guided={guided} spaceName={space?.name} onDeleted={() => setHomeViewId(null)} onError={setError} />
            <ViewHost key={selected.id} view={selected} context={{ spaceId: activeSpaceId || undefined, spaceName: space?.name ?? 'Personal' }} />
          </div>
        )}
      </div>
    </div>
  )
}

export function ViewHeader({ view, guided, spaceName, onDeleted, onError, compact }: { view: ScopedView; guided: boolean; spaceName?: string; onDeleted?: () => void; onError: (e: string) => void; compact?: boolean }): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const act = (p: Promise<unknown>): void => void p.catch((err) => onError(errText(err)))
  const byMaestro = view.updatedBy === 'maestro' && Boolean(view.history?.length)
  const entries: MenuEntry[] = [
    ...(view.history?.length ? [{ label: 'Undo last change', icon: <Undo2 size={13} />, onClick: () => act(api.invoke('views:undo', view.id)) }] : []),
    ...(!guided ? [{ label: 'Change with Maestro', icon: <Wand2 size={13} />, onClick: () => void openMaestro({ fresh: true, prompt: `Change my "${view.title}" view (${view.id}): ` }) }] : []),
    { label: 'Move left', onClick: () => act(api.invoke('views:move', view.id, -1)) },
    { label: 'Move right', onClick: () => act(api.invoke('views:move', view.id, 1)) },
    { separator: true },
    ...(view.scope.kind === 'space'
      ? [
          { label: 'Make a personal copy', icon: <User size={13} />, onClick: () => act(api.invoke('views:fork', view.id)) },
          { label: 'Hide for me', onClick: () => act(api.invoke('views:setHidden', view.id, true)) }
        ]
      : []),
    ...(view.basedOn ? [{ label: 'Go back to the team version', icon: <Users size={13} />, onClick: () => act(api.invoke('views:resetToTeam', view.id)) }] : []),
    { label: view.scope.kind === 'space' ? 'Delete for the whole team…' : 'Delete…', danger: true, onClick: () => setConfirmDelete(true) }
  ]
  return (
    <div className={clsx('flex items-center gap-2', compact && 'text-[12px]')}>
      <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-px text-[10.5px] font-medium', view.scope.kind === 'space' ? 'bg-accent/15 text-accent' : 'bg-panel-2 text-muted')}>
        {view.scope.kind === 'space' ? <Users size={10} /> : <User size={10} />}
        {view.scope.kind === 'space' ? `Team · ${spaceName ?? 'space'}` : view.basedOn ? 'Your copy' : 'Personal'}
      </span>
      {byMaestro && (
        <span className="inline-flex items-center gap-1 text-[11.5px] text-muted">
          <Wand2 size={11} className="text-accent" /> Changed by Maestro
          <button className="ml-1 text-accent hover:underline" onClick={() => act(api.invoke('views:undo', view.id))}>
            Undo
          </button>
        </span>
      )}
      <div className="flex-1" />
      {!guided && (
        <Button size="sm" variant="ghost" onClick={() => void openMaestro({ fresh: true, prompt: `Change my "${view.title}" view (${view.id}): ` })}>
          <Wand2 size={12} /> Change with Maestro
        </Button>
      )}
      <button className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-text" onClick={(e) => setMenu({ x: e.clientX - 200, y: e.clientY + 8 })} aria-label="View menu">
        <MoreHorizontal size={15} />
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries} onClose={() => setMenu(null)} />}
      {confirmDelete && (
        <Dialog title={`Delete "${view.title}"?`} onClose={() => setConfirmDelete(false)} width={420}>
          <div className="flex flex-col gap-4 p-4 text-[13px]">
            <p>{view.scope.kind === 'space' ? `It goes away for everyone in ${spaceName ?? 'this space'}. "Hide for me" only removes it from your Home.` : 'It goes away for good.'}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmDelete(false)
                  act(api.invoke('views:delete', view.id).then(() => onDeleted?.()))
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}

function Gallery({ spaceId, spaceName, guided, onInstalled, onError }: { spaceId?: string; spaceName?: string; guided: boolean; onInstalled: (v: ScopedView) => void; onError: (e: string) => void }): React.JSX.Element {
  const [templates, setTemplates] = useState<TemplateMeta[]>([])
  useEffect(() => {
    void api.invoke('views:templates').then(setTemplates).catch(() => undefined)
  }, [])
  const install = (id: string, team: boolean): void => {
    void api
      .invoke('views:installTemplate', id, team && spaceId ? { kind: 'space', spaceId } : { kind: 'user' })
      .then((v) => {
        if (v.slot === 'home') onInstalled(v)
      })
      .catch((err) => onError(errText(err)))
  }
  const list = templates.filter((t) => !guided || t.guided)
  return (
    <div className="mx-auto flex max-w-[980px] flex-col gap-5 px-6 py-8">
      <div>
        <h1 className="text-[19px] font-semibold tracking-tight">Make Sinfonie yours</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-muted">
          Start from a view below{guided ? '' : ', or describe what you want to see and Maestro builds it'}. Views show live data from your workspaces, GitHub and tickets, and their buttons act on it.
        </p>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {!guided && (
          <button
            onClick={() => void openMaestro({ fresh: true, prompt: `I'd like a new view${spaceName ? ` for ${spaceName}` : ''} that shows ` })}
            className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-accent/50 bg-accent/5 p-4 text-left hover:bg-accent/10"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-accent">
              <Wand2 size={14} />
            </span>
            <span className="text-[13px] font-semibold">Describe your own</span>
            <span className="text-[12px] text-muted">Tell Maestro what you want on screen: "my PRs waiting on CI", "a board of this sprint", "what my agents are doing".</span>
          </button>
        )}
        {list.map((t) => (
          <div key={t.id} className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-panel-2 text-accent">
                <ViewIcon name={t.icon} size={14} />
              </span>
              <span className="text-[13px] font-semibold">{t.title}</span>
              <span className="ml-auto rounded-full bg-panel-2 px-2 py-px text-[10.5px] text-muted">{t.slot === 'home' ? 'Home page' : 'Workspace tab'}</span>
            </div>
            <p className="flex-1 text-[12px] text-muted">{t.description}</p>
            <div className="flex flex-wrap gap-2">
              {t.scope === 'space' && spaceId ? (
                <>
                  <Button size="sm" variant="primary" onClick={() => install(t.id, true)}>
                    <Users size={12} /> Add for {spaceName ?? 'the team'}
                  </Button>
                  <Button size="sm" onClick={() => install(t.id, false)}>
                    Just for me
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="primary" onClick={() => install(t.id, false)}>
                  <Plus size={12} /> Add
                </Button>
              )}
            </div>
            {t.slot === 'workspace-tab' && <p className="text-[11px] text-muted">Shows as a tab in every workspace.</p>}
          </div>
        ))}
      </div>
    </div>
  )
}
