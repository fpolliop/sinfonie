import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Plus, Settings, Archive, Pencil, Folder, Code2, TerminalSquare, Trash2, GitPullRequest, Layers, ArrowDownWideNarrow, ArrowUpNarrowWide, Filter, ChevronRight, MessageSquarePlus } from 'lucide-react'
import { ERRORS_SEEN_KEY } from './FeedbackDialog'
import { useResources, subscribeResources, gb } from '@/stores/resources'
import { WORKSPACE_STAGES } from '@shared/types'
import { LabelChip, labelsFor } from './LabelPicker'
import { useApp, spaceOrder } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { timeAgo } from '@/lib/format'
import { api } from '@/lib/api'
import { renameWorkspace } from '@/lib/rename'
import { Spinner } from './ui'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { InlineRename } from './InlineRename'
import { STAGE_DOT, stageLabel } from './StagePicker'
import type { UpdateInfo, Workspace } from '@shared/types'

const DEFAULT_SIDEBAR_WIDTH = 260
const clampSidebar = (w: number): number => Math.min(520, Math.max(200, Math.round(w)))

export function Sidebar(): React.JSX.Element {
  const { workspaces, spaces, labels, labelFilter, toggleLabelFilter, clearLabelFilter, selectedId, select, setShowNewWorkspace, setShowSettings, showArchived, setShowArchived, view, setView, setError, activeSpaceId, setActiveSpace, stepSpace, sidebarView, sidebarDateDir, collapsedStages, setSidebarView, setSidebarDateDir, toggleStage } = useApp()
  const chats = useChat((s) => s.chats)
  const [spaceMenu, setSpaceMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const openSettings = useApp((s) => s.openSettings)
  const [sidebarWidth, setSidebarWidthState] = useState(() => clampSidebar(Number(localStorage.getItem('sinfonie.sidebarWidth')) || DEFAULT_SIDEBAR_WIDTH))
  const widthRef = useRef(sidebarWidth)
  const setSidebarWidth = (w: number): void => {
    const c = clampSidebar(w)
    widthRef.current = c
    setSidebarWidthState(c)
    localStorage.setItem('sinfonie.sidebarWidth', String(c))
  }
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = widthRef.current
    const move = (ev: MouseEvent): void => setSidebarWidth(startW + ev.clientX - startX)
    const up = (): void => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }
  const setSpaceSettings = (id: string | null): void => {
    if (id) openSettings({ scope: 'space', spaceId: id, page: 'general' })
  }
  const [showFilter, setShowFilter] = useState(() => (labelFilter[activeSpaceId] ?? []).length > 0)
  const swipe = useRef({ acc: 0, lockedUntil: 0 })
  const byActivity = (a: Workspace, b: Workspace): number => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt)
  const byStart = (a: Workspace, b: Workspace): number => (sidebarDateDir === 'desc' ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt))
  const active = workspaces.filter((w) => w.status !== 'archived').sort(sidebarView === 'date' ? byStart : byActivity)
  const isUngrouped = (w: Workspace): boolean => !w.spaceId || !spaces.some((s) => s.id === w.spaceId)
  const ids = spaceOrder(
    spaces.map((s) => s.id),
    active.some(isUngrouped)
  )
  const currentId = ids.includes(activeSpaceId) ? activeSpaceId : ids[0] ?? ''
  const current = spaces.find((s) => s.id === currentId)
  const currentName = current?.name ?? (spaces.length ? 'Other' : 'Workspaces')
  const currentColor = current?.color ?? '#8b93a1'
  const spaceLabels = labelsFor(labels, currentId || undefined)
  const selectedLabels = (labelFilter[currentId] ?? []).filter((id) => spaceLabels.some((l) => l.id === id))
  const matchesLabels = (w: Workspace): boolean => selectedLabels.every((id) => w.labelIds?.includes(id))
  const inSpace = currentId ? active.filter((w) => w.spaceId === currentId) : active.filter(isUngrouped)
  const items = inSpace.filter(matchesLabels)
  const archived = workspaces.filter((w) => w.status === 'archived').filter((w) => (currentId ? w.spaceId === currentId : isUngrouped(w)))
  const run = (fn: () => Promise<unknown>): void => {
    fn().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  const row = (w: Workspace, grouped: boolean): React.JSX.Element => <WorkspaceRow key={w.id} ws={w} grouped={grouped} selected={view === 'workspace' && w.id === selectedId} busy={Boolean(chats[w.id]?.busy)} onClick={() => select(w.id)} />

  // Two-finger horizontal swipe switches spaces, with a short lock so one gesture moves one step.
  const onWheel = (e: React.WheelEvent): void => {
    if (ids.length < 2 || Math.abs(e.deltaX) < Math.abs(e.deltaY)) return
    const now = Date.now()
    if (now < swipe.current.lockedUntil) return
    swipe.current.acc += e.deltaX
    if (Math.abs(swipe.current.acc) > 120) {
      stepSpace(swipe.current.acc > 0 ? 1 : -1)
      swipe.current.acc = 0
      swipe.current.lockedUntil = now + 500
    }
  }

  return (
    <aside className="relative flex shrink-0 flex-col border-r border-border bg-panel" style={{ width: sidebarWidth }} onWheel={onWheel}>
      <div onMouseDown={startResize} onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)} className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-accent/40 active:bg-accent/60" title="Drag to resize · double-click to reset" />
      <div className="drag flex h-[52px] items-center justify-end gap-1 pl-[80px] pr-2">
        <button data-tour="new-workspace" className="no-drag rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" title="New workspace (⇧⌘N)" onClick={() => setShowNewWorkspace(true, currentId)}>
          <Plus size={16} />
        </button>
        <FeedbackButton />
        <button data-tour="settings" className="no-drag rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" title="Settings (⌘,)" onClick={() => setShowSettings(true)}>
          <Settings size={16} />
        </button>
      </div>
      <div className="px-2">
        <button data-tour="reviews" onClick={() => setView('reviews')} className={clsx('mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium', view === 'reviews' ? 'bg-panel-2' : 'hover:bg-panel-2/60')}>
          <GitPullRequest size={14} className="text-accent" /> Review cockpit
        </button>
      </div>
      <div key={currentId} className="space-enter flex-1 overflow-auto px-2 pb-2">
        <div
          className="group flex h-8 items-center gap-2 px-2"
          onContextMenu={(e) => {
            if (!currentId) return
            e.preventDefault()
            setSpaceMenu({ x: e.clientX, y: e.clientY, id: currentId })
          }}
          onDoubleClick={() => currentId && setRenaming(currentId)}
        >
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: currentColor }} />
          {renaming === currentId && currentId ? (
            <InlineRename
              value={currentName}
              onSave={(v) => {
                setRenaming(null)
                run(() => api.invoke('spaces:update', currentId, { name: v }))
              }}
              onCancel={() => setRenaming(null)}
            />
          ) : (
            <span className="truncate text-[13px] font-semibold">{currentName}</span>
          )}
          <span className="text-[12px] text-muted">{inSpace.length}</span>
          {currentId && (
            <button className="ml-auto rounded p-1 text-muted opacity-0 hover:bg-panel-2 hover:text-text group-hover:opacity-100" title="Space settings" onClick={() => setSpaceSettings(currentId)}>
              <Settings size={13} />
            </button>
          )}
        </div>
        <div className="mb-2 flex items-center gap-1 px-2">
          <div className="flex rounded-md bg-bg p-0.5 text-[11px]">
            <button onClick={() => setSidebarView('status')} className={clsx('rounded px-2 py-0.5', sidebarView === 'status' ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
              Status
            </button>
            <button onClick={() => setSidebarView('date')} className={clsx('rounded px-2 py-0.5', sidebarView === 'date' ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
              Date
            </button>
          </div>
          {sidebarView === 'date' && (
            <button onClick={() => setSidebarDateDir(sidebarDateDir === 'desc' ? 'asc' : 'desc')} title={sidebarDateDir === 'desc' ? 'Newest first' : 'Oldest first'} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:bg-panel-2 hover:text-text">
              {sidebarDateDir === 'desc' ? <ArrowDownWideNarrow size={12} /> : <ArrowUpNarrowWide size={12} />}
              {sidebarDateDir === 'desc' ? 'newest' : 'oldest'}
            </button>
          )}
          {spaceLabels.length > 0 && (
            <button onClick={() => setShowFilter(!showFilter)} className={clsx('ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]', selectedLabels.length ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-text')} title="Filter by label">
              <Filter size={12} />
              {selectedLabels.length ? selectedLabels.length : ''}
            </button>
          )}
        </div>
        {showFilter && spaceLabels.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1 rounded-md border border-border bg-bg p-2">
            {spaceLabels.map((l) => {
              const on = selectedLabels.includes(l.id)
              return (
                <button key={l.id} onClick={() => toggleLabelFilter(currentId, l.id)} className={clsx('rounded-full transition-opacity', on ? 'opacity-100' : 'opacity-45 hover:opacity-90')} title={on ? 'Remove from filter' : 'Show only workspaces with this label'}>
                  <LabelChip label={l} small />
                </button>
              )
            })}
            {selectedLabels.length > 0 && (
              <button className="ml-auto text-[11px] text-muted hover:text-text" onClick={() => clearLabelFilter(currentId)}>
                Clear
              </button>
            )}
          </div>
        )}
        {sidebarView === 'status'
          ? WORKSPACE_STAGES.filter((st) => items.some((w) => w.stage === st.id)).map((st) => {
              const group = items.filter((w) => w.stage === st.id)
              const collapsed = Boolean(collapsedStages[st.id])
              return (
                <div key={st.id} className="mb-2">
                  <button onClick={() => toggleStage(st.id)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted hover:text-text">
                    <ChevronRight size={11} className={clsx('shrink-0 transition-transform', !collapsed && 'rotate-90')} />
                    <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', STAGE_DOT[st.id])} />
                    {st.label}
                    <span className="normal-case text-muted/60">{group.length}</span>
                  </button>
                  {!collapsed && group.map((w) => row(w, true))}
                </div>
              )
            })
          : items.map((w) => row(w, false))}
        {items.length === 0 && inSpace.length > 0 && <div className="px-2 py-3 text-[12px] text-muted">No workspaces match the selected labels.</div>}
        {inSpace.length === 0 && (
          <div className="px-2 py-3 text-[12px] text-muted">
            No workspaces in {currentName} yet.{' '}
            <button className="text-accent hover:underline" onClick={() => setShowNewWorkspace(true, currentId)}>
              Create one
            </button>
          </div>
        )}
        {archived.length > 0 && (
          <>
            <button className="mt-3 flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted hover:text-text" onClick={() => setShowArchived(!showArchived)}>
              <Archive size={12} /> Archived ({archived.length}) {showArchived ? '▾' : '▸'}
            </button>
            {showArchived && archived.map((w) => row(w, false))}
          </>
        )}
      </div>
      <UpdateBanner />
      <MemoryGauge onOpen={() => openSettings({ scope: 'app', page: 'resources' })} />
      <SpaceDots ids={ids} currentId={currentId} onPick={setActiveSpace} onAdd={() => openSettings({ scope: 'app', page: 'spaces' })} />
      {spaceMenu && (
        <ContextMenu
          x={spaceMenu.x}
          y={spaceMenu.y}
          onClose={() => setSpaceMenu(null)}
          entries={[
            { label: 'Space settings…', icon: <Settings size={14} />, onClick: () => setSpaceSettings(spaceMenu.id) },
            { label: 'Rename space…', icon: <Pencil size={14} />, onClick: () => setRenaming(spaceMenu.id) },
            { label: 'New workspace here', icon: <Plus size={14} />, onClick: () => setShowNewWorkspace(true, spaceMenu.id) },
            { separator: true },
            { label: 'Delete space', icon: <Trash2 size={14} />, danger: true, onClick: () => run(() => api.invoke('spaces:delete', spaceMenu.id)) }
          ]}
        />
      )}
    </aside>
  )
}

/** Feedback entry point; shows a dot when errors were captured since the Errors tab was last opened. */
function FeedbackButton(): React.JSX.Element {
  const setFeedbackDialog = useApp((s) => s.setFeedbackDialog)
  const feedbackDialog = useApp((s) => s.feedbackDialog)
  const [unseen, setUnseen] = useState(0)
  useEffect(() => {
    const seen = localStorage.getItem(ERRORS_SEEN_KEY) ?? ''
    api.invoke('logs:list').then((list) => setUnseen(list.filter((e) => e.ts > seen).length)).catch(() => undefined)
    return api.on('errors:new', () => setUnseen((n) => n + 1))
  }, [feedbackDialog])
  return (
    <button className="no-drag relative rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" title={unseen ? `Feedback · ${unseen} new error${unseen === 1 ? '' : 's'} captured (⇧⌘F)` : 'Feedback and requests (⇧⌘F)'} onClick={() => setFeedbackDialog(unseen ? 'errors' : 'feedback')}>
      <MessageSquarePlus size={16} />
      {unseen > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-danger ring-2 ring-panel" />}
    </button>
  )
}

/** Shown when a newer release exists on GitHub. Unsigned builds update by download. */
function UpdateBanner(): React.JSX.Element | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(() => localStorage.getItem('orchestra.dismissedUpdate'))
  const setError = useApp((s) => s.setError)
  useEffect(() => api.on('update:available', setInfo), [])
  useEffect(() => {
    // Pick up an update found before this component mounted.
    api.invoke('updates:check').then((u) => u && setInfo(u)).catch(() => undefined)
  }, [])
  if (!info) return null
  if (dismissed === info.version && info.state === 'available') return null
  const later = (): void => {
    localStorage.setItem('orchestra.dismissedUpdate', info.version)
    setDismissed(info.version)
    if (info.state === 'ready') setInfo(null) // installs on quit anyway
  }
  const download = (): void => {
    api.invoke('updates:download').catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  return (
    <div className="mx-2 mb-2 rounded-lg border border-accent/40 bg-accent/10 p-2 text-[12px]">
      {info.state === 'available' && (
        <>
          <div className="mb-1 font-medium">Sinfonie {info.version} is available</div>
          <div className="mb-2 text-[11px] text-muted">You have {info.current}. The update downloads in the background; you restart when it is ready.</div>
          <div className="flex gap-2">
            <button className="rounded-md bg-accent-2 px-2 py-1 text-[11px] text-white hover:bg-accent" onClick={download}>
              Download and install
            </button>
            <button className="text-[11px] text-muted hover:text-text" onClick={() => void api.invoke('shell:openExternal', info.releaseUrl)}>
              What's new
            </button>
            <button className="ml-auto text-[11px] text-muted hover:text-text" onClick={later}>
              Later
            </button>
          </div>
        </>
      )}
      {info.state === 'downloading' && (
        <>
          <div className="mb-1 font-medium">Downloading Sinfonie {info.version}…</div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
            <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${info.percent ?? 0}%` }} />
          </div>
          <div className="mt-1 text-[11px] text-muted">{info.percent ?? 0}%</div>
        </>
      )}
      {info.state === 'ready' && (
        <>
          <div className="mb-1 font-medium">Sinfonie {info.version} is ready</div>
          <div className="mb-2 text-[11px] text-muted">Restart to start using it. Running sessions resume from their saved transcripts.</div>
          <div className="flex gap-2">
            <button className="rounded-md bg-accent-2 px-2 py-1 text-[11px] text-white hover:bg-accent" onClick={() => void api.invoke('updates:install')}>
              Restart now
            </button>
            <button className="ml-auto text-[11px] text-muted hover:text-text" onClick={later} title="The update installs the next time you quit">
              On next quit
            </button>
          </div>
        </>
      )}
      {info.state === 'error' && (
        <>
          <div className="mb-1 font-medium">Could not download {info.version}</div>
          <div className="mb-2 break-words text-[11px] text-muted">{info.error}</div>
          <div className="flex gap-2">
            <button className="rounded-md bg-accent-2 px-2 py-1 text-[11px] text-white hover:bg-accent" onClick={download}>
              Try again
            </button>
            <button className="text-[11px] text-muted hover:text-text" onClick={() => void api.invoke('shell:openExternal', info.releaseUrl)}>
              Download manually
            </button>
            <button className="ml-auto text-[11px] text-muted hover:text-text" onClick={() => setInfo(null)}>
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Slim memory gauge: what Sinfonie's processes use against the budget. Click for the Resources page. */
function MemoryGauge({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const snap = useResources((s) => s.snapshot)
  useEffect(() => subscribeResources(), [])
  if (!snap || (snap.sessions.length === 0 && snap.level === 'normal')) return null
  const pct = Math.min(100, (snap.appRss / snap.budget) * 100)
  const running = snap.sessions.reduce((n, s) => n + s.tasks.length, 0)
  const color = snap.level === 'critical' ? 'bg-danger' : snap.level === 'warn' ? 'bg-warn' : 'bg-accent'
  const text = snap.level === 'critical' ? 'text-danger' : snap.level === 'warn' ? 'text-warn' : 'text-muted'
  return (
    <button onClick={onOpen} className="group mx-2 mb-1 rounded-md px-1.5 py-1 text-left hover:bg-panel-2" title={`Sinfonie uses ${gb(snap.appRss)} of a ${gb(snap.budget)} budget · macOS pressure ${snap.osPressure} · ${snap.sessions.length} agent${snap.sessions.length === 1 ? '' : 's'}, ${running} subagent${running === 1 ? '' : 's'} running. Click for details.`}>
      <div className={clsx('flex items-center justify-between text-[10px]', text)}>
        <span>Memory {gb(snap.appRss)}</span>
        <span>
          {snap.sessions.length} agent{snap.sessions.length === 1 ? '' : 's'}
          {running ? ` · ${running} sub` : ''}
          {snap.waiting.length ? ` · ${snap.waiting.length} waiting` : ''}
        </span>
      </div>
      <div className="mt-0.5 h-[3px] w-full overflow-hidden rounded-full bg-panel-2">
        <div className={clsx('h-full rounded-full transition-all duration-500', color)} style={{ width: `${pct}%` }} />
      </div>
    </button>
  )
}

/** Arc-style dot bar: one dot per space, the current one stretched into a pill with its name. */
function SpaceDots({ ids, currentId, onPick, onAdd }: { ids: string[]; currentId: string; onPick: (id: string) => void; onAdd: () => void }): React.JSX.Element {
  const spaces = useApp((s) => s.spaces)
  return (
    <div data-tour="spaces" className="flex h-10 shrink-0 items-center gap-1.5 border-t border-border px-3">
      {ids.map((id, i) => {
        const sp = spaces.find((s) => s.id === id)
        const name = sp?.name ?? (spaces.length ? 'Other' : 'Workspaces')
        const color = sp?.color ?? '#8b93a1'
        const isCurrent = id === currentId
        return (
          <button
            key={id || '__none'}
            onClick={() => onPick(id)}
            title={`${name} (⌃${i + 1})`}
            className={clsx('flex h-5 items-center gap-1.5 rounded-full transition-all duration-200', isCurrent ? 'bg-panel-2 px-2' : 'w-2.5 justify-center hover:scale-125')}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color, opacity: isCurrent ? 1 : 0.7 }} />
            {isCurrent && <span className="max-w-[120px] truncate text-[11px] font-medium text-text">{name}</span>}
          </button>
        )
      })}
      <button onClick={onAdd} className="ml-auto rounded-full p-1 text-muted hover:bg-panel-2 hover:text-text" title="New space">
        <Plus size={12} />
      </button>
    </div>
  )
}

function WorkspaceRow({ ws, grouped, selected, busy, onClick }: { ws: Workspace; grouped: boolean; selected: boolean; busy: boolean; onClick: () => void }): React.JSX.Element {
  const branch = ws.repos[0]?.branch
  const allLabels = useApp((s) => s.labels)
  const rowLabels = (ws.labelIds ?? []).map((id) => allLabels.find((l) => l.id === id)).filter((l): l is NonNullable<typeof l> => Boolean(l))
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const { setError, setShowArchived } = useApp()
  const run = (fn: () => Promise<unknown>): void => {
    fn().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  const entries: MenuEntry[] = [
    { label: 'Rename…', icon: <Pencil size={14} />, onClick: () => setEditing(true) },
    { label: 'Move to space…', icon: <Layers size={14} />, onClick: () => window.dispatchEvent(new CustomEvent('sinfonie:moveSpace', { detail: ws.id })) },
    { separator: true },
    { label: 'Reveal in Finder', icon: <Folder size={14} />, onClick: () => run(() => api.invoke('workspaces:openIn', ws.id, 'finder')), disabled: ws.status === 'archived' },
    { label: 'Open in VS Code', icon: <Code2 size={14} />, onClick: () => run(() => api.invoke('workspaces:openIn', ws.id, 'vscode')), disabled: ws.status === 'archived' },
    { label: 'Open in Cursor', icon: <Code2 size={14} />, onClick: () => run(() => api.invoke('workspaces:openIn', ws.id, 'cursor')), disabled: ws.status === 'archived' },
    { label: 'Open in Terminal', icon: <TerminalSquare size={14} />, onClick: () => run(() => api.invoke('workspaces:openIn', ws.id, 'terminal')), disabled: ws.status === 'archived' },
    { separator: true },
    ...(ws.status === 'archived'
      ? [{ label: 'Remove from list', icon: <Trash2 size={14} />, danger: true, onClick: () => run(() => api.invoke('workspaces:delete', ws.id)) }]
      : [
          {
            label: 'Archive…',
            icon: <Archive size={14} />,
            onClick: () => {
              onClick()
              window.dispatchEvent(new CustomEvent('sinfonie:archive', { detail: { id: ws.id, mode: 'archive' } }))
            }
          },
          {
            label: 'Delete…',
            icon: <Trash2 size={14} />,
            danger: true,
            onClick: () => {
              onClick()
              window.dispatchEvent(new CustomEvent('sinfonie:archive', { detail: { id: ws.id, mode: 'delete' } }))
            }
          }
        ])
  ]
  void setShowArchived
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onDoubleClick={() => setEditing(true)}
        onContextMenu={(e) => {
          e.preventDefault()
          onClick()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        onKeyDown={(e) => e.key === 'Enter' && onClick()}
        className={clsx('group/row mb-0.5 flex w-full cursor-default flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors', selected ? 'bg-panel-2' : 'hover:bg-panel-2/60', ws.status === 'archived' && 'opacity-60')}
      >
        <div className="flex items-center gap-2">
          {!grouped && <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', STAGE_DOT[ws.stage])} title={stageLabel(ws.stage)} />}
          {editing ? (
            <InlineRename
              value={ws.name}
              onSave={(v) => {
                setEditing(false)
                void renameWorkspace(ws, v)
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <span className="truncate text-[13px] font-medium" title={`${ws.name}\nbranch: ${branch}`}>
              {ws.name}
            </span>
          )}
          <span className="ml-auto shrink-0">
            {busy || ws.status === 'creating' || ws.status === 'archiving' ? <Spinner /> : ws.status === 'error' ? <span className="inline-block h-2 w-2 rounded-full bg-danger" title={ws.error} /> : null}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          {ws.jira && (
            <span className="shrink-0 text-accent" title={`${ws.jira.key}: ${ws.jira.summary}${ws.jiraStatus ? ` · ${ws.jiraStatus}` : ''}`}>
              {ws.jira.key}
            </span>
          )}
          {rowLabels.slice(0, 2).map((l) => (
            <LabelChip key={l.id} label={l} small />
          ))}
          {rowLabels.length > 2 && <span>+{rowLabels.length - 2}</span>}
          <span className="ml-auto shrink-0">
            {ws.repos.length} repo{ws.repos.length === 1 ? '' : 's'} · {timeAgo(ws.lastMessageAt ?? ws.createdAt)}
          </span>
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries} onClose={() => setMenu(null)} />}
    </>
  )
}
