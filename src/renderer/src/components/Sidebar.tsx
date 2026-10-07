import React, { useEffect, useRef, useState } from 'react'
import { yieldsToEditor } from '@/lib/keys'
import clsx from 'clsx'
import { Mail, Plus, Settings, Archive, Pencil, Folder, Code2, TerminalSquare, Trash2, Layers, ArrowDownWideNarrow, ArrowUpNarrowWide, Filter, ChevronRight, MessageSquarePlus, Activity, Users2, LayoutDashboard } from 'lucide-react'
import { ERRORS_SEEN_KEY } from './FeedbackDialog'
import { useResources, subscribeResources, gb } from '@/stores/resources'
import { useUsage, subscribeUsage, windowLabel, clock } from '@/stores/usage'
import { type TeammateWorkspace } from '@shared/types'
import { LabelChip, labelsFor } from './LabelPicker'
import { useApp, spaceOrder } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { timeAgo } from '@/lib/format'
import { api } from '@/lib/api'
import { renameWorkspace } from '@/lib/rename'
import { friendlyError } from '@/lib/errors'
import { removeWithUndo } from '@/lib/undo'
import { repoLabel, workspaceLabel } from '@/lib/labels'
import { IconButton, Segmented, Spinner } from './ui'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { useGuided, stageLabel as guidedStageLabel, words, cap } from '@/lib/guided'
import { InlineRename } from './InlineRename'
import { anchorOf } from '@shared/types'
import { stageDot, useStages } from '@/lib/stages'
import type { Workspace } from '@shared/types'
import { tokens } from '@/lib/theme'

const DEFAULT_SIDEBAR_WIDTH = 260
const clampSidebar = (w: number): number => Math.min(520, Math.max(200, Math.round(w)))

export function Sidebar(): React.JSX.Element {
  const { workspaces: allWorkspaces, pendingRemoval, spaces, labels, labelFilter, toggleLabelFilter, clearLabelFilter, selectedId, select, setShowNewWorkspace, setShowSettings, showArchived, setShowArchived, view, setView, setError, activeSpaceId, setActiveSpace, stepSpace, sidebarView, sidebarDateDir, collapsedStages, setSidebarView, setSidebarDateDir, toggleStage } = useApp()
  const chats = useChat((s) => s.chats)
  // Rows waiting out an Undo window are already gone from the person's point of view.
  const workspaces = pendingRemoval.length ? allWorkspaces.filter((w) => !pendingRemoval.includes(w.id)) : allWorkspaces
  const guided = useGuided()
  const t = words(guided)
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
  const byOrder = (a: Workspace, b: Workspace): number => (a.order ?? 1e9) - (b.order ?? 1e9) || b.createdAt.localeCompare(a.createdAt)
  const active = workspaces.filter((w) => w.status !== 'archived').sort(sidebarView === 'date' ? byStart : sidebarView === 'manual' ? byOrder : byActivity)
  // Manual order: drag a row onto another; the list of ids in the new order is saved.
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const dropOn = (targetId: string): void => {
    if (!dragId || dragId === targetId) return
    const list = active.filter((w) => (currentId ? w.spaceId === currentId : isUngrouped(w))).map((w) => w.id)
    const from = list.indexOf(dragId)
    const to = list.indexOf(targetId)
    if (from < 0 || to < 0) return
    list.splice(from, 1)
    list.splice(to, 0, dragId)
    void api.invoke('workspaces:setOrder', list).catch((err) => setError(friendlyError(err)))
  }
  const draggableRow = (w: Workspace): React.JSX.Element => (
    <div
      key={w.id}
      draggable
      onDragStart={() => setDragId(w.id)}
      onDragEnd={() => (setDragId(null), setOverId(null))}
      onDragOver={(e) => {
        e.preventDefault()
        setOverId(w.id)
      }}
      onDrop={(e) => {
        e.preventDefault()
        dropOn(w.id)
        setDragId(null)
        setOverId(null)
      }}
      className={clsx(overId === w.id && dragId && dragId !== w.id && 'border-t-2 border-accent')}
    >
      {row(w, false)}
    </div>
  )
  const isUngrouped = (w: Workspace): boolean => !w.spaceId || !spaces.some((s) => s.id === w.spaceId)
  const ids = spaceOrder(
    spaces.map((s) => s.id),
    active.some(isUngrouped)
  )
  const currentId = ids.includes(activeSpaceId) ? activeSpaceId : ids[0] ?? ''
  const current = spaces.find((s) => s.id === currentId)
  const currentName = current?.name ?? ungroupedName(spaces.length > 0, guided)
  const currentColor = current?.color ?? tokens.muted
  const spaceLabels = labelsFor(labels, currentId || undefined)
  // Guided mode has no label filter UI, so a filter persisted from expert mode is ignored: tasks never vanish.
  const selectedLabels = guided ? [] : (labelFilter[currentId] ?? []).filter((id) => spaceLabels.some((l) => l.id === id))
  const matchesLabels = (w: Workspace): boolean => selectedLabels.every((id) => w.labelIds?.includes(id))
  const inSpace = currentId ? active.filter((w) => w.spaceId === currentId) : active.filter(isUngrouped)
  const items = inSpace.filter(matchesLabels)
  const archived = workspaces.filter((w) => w.status === 'archived').filter((w) => (currentId ? w.spaceId === currentId : isUngrouped(w)))
  const run = (fn: () => Promise<unknown>): void => {
    fn().catch((err) => setError(friendlyError(err)))
  }
  // ⌥⌘↑ / ⌥⌘↓: previous / next workspace in the order the sidebar shows them (stage groups first in Status view).
  const stageList = useStages(currentId || undefined)
  // A status this space does not have (a workspace moved in from another space) shows under the stage it sat after.
  const groupOf = (w: Workspace): string => (stageList.some((st) => st.id === w.stage) ? w.stage : anchorOf(w.stage, stageList.filter((st) => !st.builtin).map((st) => ({ id: st.id as `custom:${string}`, label: st.label, after: st.anchor }))))
  const displayed = sidebarView === 'status' || guided ? stageList.flatMap((st) => items.filter((w) => groupOf(w) === st.id)) : items
  const displayedRef = useRef(displayed)
  displayedRef.current = displayed
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || !e.altKey || e.shiftKey || e.ctrlKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      if (yieldsToEditor(e)) return
      const list = displayedRef.current
      if (!list.length) return
      e.preventDefault()
      const st = useApp.getState()
      const i = list.findIndex((w) => w.id === st.selectedId)
      const next = i < 0 ? (e.key === 'ArrowDown' ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))
      if (list[next].id !== st.selectedId || st.view !== 'workspace') st.select(list[next].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const unseenDone = useChat((s) => s.unseenDone)
  const row = (w: Workspace, grouped: boolean): React.JSX.Element => <WorkspaceRow key={w.id} ws={w} grouped={grouped} selected={view === 'workspace' && w.id === selectedId} busy={Boolean(chats[w.id]?.busy)} done={Boolean(unseenDone[w.id])} onClick={() => select(w.id)} />

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
      <div className="drag flex h-[52px] items-center justify-end gap-1 px-2">
        <IconButton data-tour="new-workspace" className="p-1.5" label={`${t.newWorkspace} (⌘T)`} onClick={() => setShowNewWorkspace(true, currentId)}>
          <Plus size={16} />
        </IconButton>
        <FeedbackButton />
        <IconButton data-tour="settings" className="p-1.5" label="Settings (⌘,)" onClick={() => setShowSettings(true)}>
          <Settings size={16} />
        </IconButton>
      </div>
      {!guided && (
        <div className="no-drag px-3 pb-2">
          {/* Build holds the work: workspaces and the agents that run in them (the rest of the app is on the rail). */}
          <Segmented
            size="sm"
            value={view === 'agents' ? 'agents' : 'workspaces'}
            onChange={(v) => setView(v === 'agents' ? 'agents' : 'workspace')}
            options={[
              { id: 'workspaces', label: 'Workspaces' },
              { id: 'agents', label: <span data-tour="agents">Agents</span> }
            ]}
            className="w-full [&>button]:flex-1"
          />
        </div>
      )}
      <div key={currentId} className="space-enter flex-1 overflow-auto px-2 pb-2">
        {inSpace.length > 0 && <OverviewRow active={view === 'workspace' && !selectedId} spaceIds={inSpace.map((w) => w.id)} onClick={() => select(null)} guided={guided} />}
        <div
          className="group flex h-8 items-center gap-2 px-2"
          onContextMenu={(e) => {
            if (!currentId || guided) return
            e.preventDefault()
            setSpaceMenu({ x: e.clientX, y: e.clientY, id: currentId })
          }}
          onDoubleClick={() => currentId && !guided && setRenaming(currentId)}
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
          <OwnerChip spaceId={currentId} />
          {currentId && !guided && (
            <IconButton label="Space settings" className="reveal-on-focus ml-auto p-1 opacity-0 group-hover:opacity-100" onClick={() => setSpaceSettings(currentId)}>
              <Settings size={13} />
            </IconButton>
          )}
        </div>
        {!guided && (
        <div className="mb-2 flex items-center gap-1 px-2">
          <div className="flex rounded-md bg-bg p-0.5 text-[11px]">
            <button onClick={() => setSidebarView('status')} className={clsx('rounded px-2 py-0.5', sidebarView === 'status' ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
              Status
            </button>
            <button onClick={() => setSidebarView('activity')} className={clsx('rounded px-2 py-0.5', sidebarView === 'activity' ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')} title="Latest response first">
              Latest
            </button>
            <button onClick={() => setSidebarView('date')} className={clsx('rounded px-2 py-0.5', sidebarView === 'date' ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')} title="By creation date">
              Date
            </button>
            <button onClick={() => setSidebarView('manual')} className={clsx('rounded px-2 py-0.5', sidebarView === 'manual' ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')} title="Your own order: drag rows">
              Manual
            </button>
          </div>
          {sidebarView === 'date' && (
            <button onClick={() => setSidebarDateDir(sidebarDateDir === 'desc' ? 'asc' : 'desc')} title={sidebarDateDir === 'desc' ? 'Newest first' : 'Oldest first'} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:bg-panel-2 hover:text-text">
              {sidebarDateDir === 'desc' ? <ArrowDownWideNarrow size={12} /> : <ArrowUpNarrowWide size={12} />}
              {sidebarDateDir === 'desc' ? 'newest' : 'oldest'}
            </button>
          )}
          {spaceLabels.length > 0 && (
            <button onClick={() => setShowFilter(!showFilter)} aria-expanded={showFilter} aria-label={selectedLabels.length ? `Filter by label (${selectedLabels.length} selected)` : 'Filter by label'} className={clsx('ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]', selectedLabels.length ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-text')} title="Filter by label">
              <Filter size={12} />
              {selectedLabels.length ? selectedLabels.length : ''}
            </button>
          )}
        </div>
        )}
        {!guided && showFilter && spaceLabels.length > 0 && (
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
        {sidebarView === 'status' || guided
          ? stageList.filter((st) => items.some((w) => groupOf(w) === st.id)).map((st) => {
              const group = items.filter((w) => groupOf(w) === st.id)
              const collapsed = Boolean(collapsedStages[st.id])
              return (
                <div key={st.id} className="mb-2">
                  <button onClick={() => toggleStage(st.id)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted hover:text-text">
                    <ChevronRight size={11} className={clsx('shrink-0 transition-transform', !collapsed && 'rotate-90')} />
                    <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', stageDot(st.id))} />
                    {guidedStageLabel(st.id, guided)}
                    <span className="normal-case text-muted">{group.length}</span>
                  </button>
                  {!collapsed && group.map((w) => row(w, true))}
                </div>
              )
            })
          : sidebarView === 'manual'
            ? items.map(draggableRow)
            : items.map((w) => row(w, false))}
        {items.length === 0 && inSpace.length > 0 && (
          <div className="px-2 py-3 text-[12px] text-muted">
            No workspaces match the selected labels.{' '}
            <button className="text-accent hover:underline" onClick={() => clearLabelFilter(currentId)}>
              Clear filter
            </button>
          </div>
        )}
        {inSpace.length === 0 && (
          <div className="px-2 py-3 text-[12px] text-muted">
            No {t.workspaces} in {currentName} yet.{' '}
            <button className="text-accent hover:underline" onClick={() => setShowNewWorkspace(true, currentId)}>
              Create one
            </button>
          </div>
        )}
        {archived.length > 0 && (
          <>
            <button aria-expanded={showArchived} className="mt-3 flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted hover:text-text" onClick={() => setShowArchived(!showArchived)}>
              <Archive size={12} /> {guided ? 'Finished' : 'Archived'} ({archived.length}) {showArchived ? '▾' : '▸'}
            </button>
            {showArchived && archived.map((w) => row(w, false))}
          </>
        )}
        <Teammates spaceId={currentId} guided={guided} />
      </div>
      <UsageBadge onOpen={() => (guided ? undefined : openSettings({ scope: 'app', page: 'usage' }))} />
      {!guided && <MemoryGauge onOpen={() => openSettings({ scope: 'app', page: 'resources' })} />}
      <SpaceDots ids={ids} currentId={currentId} guided={guided} onPick={setActiveSpace} onAdd={guided ? undefined : () => openSettings({ scope: 'app', page: 'spaces' })} />
      {spaceMenu && (
        <ContextMenu
          x={spaceMenu.x}
          y={spaceMenu.y}
          onClose={() => setSpaceMenu(null)}
          label="Space"
          entries={[
            { label: 'Space settings…', icon: <Settings size={14} />, onClick: () => setSpaceSettings(spaceMenu.id) },
            { label: 'Rename space…', icon: <Pencil size={14} />, onClick: () => setRenaming(spaceMenu.id) },
            { label: 'New workspace here', icon: <Plus size={14} />, onClick: () => setShowNewWorkspace(true, spaceMenu.id) },
            { separator: true },
            {
              label: 'Delete space',
              icon: <Trash2 size={14} />,
              danger: true,
              onClick: () => {
                const name = spaces.find((s) => s.id === spaceMenu.id)?.name ?? 'this space'
                if (window.confirm(`Delete space "${name}"? Its workspaces and repositories move to "No space"; its crew overrides, on-call channels and integrations are lost.`)) void run(() => api.invoke('spaces:delete', spaceMenu.id))
              }
            }
          ]}
        />
      )}
    </aside>
  )
}

/** Back to mission control (Build's overview): highlighted when no workspace is open, with what waits on the person. */
function OverviewRow({ active, spaceIds, onClick, guided }: { active: boolean; spaceIds: string[]; onClick: () => void; guided: boolean }): React.JSX.Element {
  const waiting = useChat((s) => new Set([...s.permissions, ...s.questions].map((p) => p.workspaceId).filter((id) => spaceIds.includes(id))).size)
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={guided ? 'Everything in this team at a glance' : 'Mission control: what needs you, what is running, what is in review'}
      className={clsx('mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors', active ? 'bg-panel-2 text-text' : 'text-muted hover:bg-panel-2/60 hover:text-text')}
    >
      <LayoutDashboard size={14} className="shrink-0" />
      Overview
      {waiting > 0 && (
        <span aria-label={`${waiting} waiting on you`} className="ml-auto min-w-4 rounded-full bg-warn/15 px-1.5 text-center text-[11px] font-semibold leading-4 text-warn">
          {waiting}
        </span>
      )}
    </button>
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
    <IconButton className="relative p-1.5" label={unseen ? `Feedback · ${unseen} new error${unseen === 1 ? '' : 's'} captured (⇧⌘F)` : 'Feedback and requests (⇧⌘F)'} onClick={() => setFeedbackDialog(unseen ? 'errors' : 'feedback')}>
      <MessageSquarePlus size={16} />
      {unseen > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-danger ring-2 ring-panel" />}
    </IconButton>
  )
}

/** Shown only when a Claude window is filling up: which account, how full, when it resets. */
function UsageBadge({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const snap = useUsage((s) => s.snapshot)
  useEffect(() => subscribeUsage(), [])
  if (!snap) return null
  const worst = snap.accounts
    .flatMap((a) => a.limits.filter((l) => !l.resetsAt || new Date(l.resetsAt).getTime() > Date.now()).map((l) => ({ ...l, account: a.name })))
    .sort((a, b) => b.utilization - a.utilization)[0]
  if (!worst || worst.utilization < 0.8) return null
  const pct = Math.round(worst.utilization * 100)
  const danger = worst.utilization >= 0.95
  return (
    <button onClick={onOpen} className={clsx('mx-2 mb-1 flex items-center gap-2 rounded-md border px-2 py-1 text-left text-[11px]', danger ? 'border-danger/40 bg-danger/10 text-danger' : 'border-warn/40 bg-warn/10 text-warn')} title={`${worst.account}: ${pct}% of the ${windowLabel(worst.type)} window used${worst.resetsAt ? `, resets ${clock(worst.resetsAt)}` : ''}. Click for details.`}>
      <Activity size={12} />
      <span className="truncate">
        {worst.account} · {windowLabel(worst.type)} {pct}%
      </span>
      {worst.resetsAt && <span className="ml-auto shrink-0 opacity-80">resets {clock(worst.resetsAt)}</span>}
    </button>
  )
}

/** Slim memory gauge: what Sinfonie's processes use against the budget. Click for the Resources page. */
function MemoryGauge({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const snap = useResources((s) => s.snapshot)
  useEffect(() => subscribeResources(), [])
  // Always shown once there is a reading: the Mac's own memory is worth a glance even when no agent runs.
  if (!snap) return null
  const pct = Math.min(100, (snap.appRss / snap.budget) * 100)
  const running = snap.sessions.reduce((n, s) => n + s.tasks.length, 0)
  // The bar is Sinfonie against its own budget; the Mac's pressure is a separate note, so one is never mistaken for the other.
  const own = snap.appLevel ?? snap.level
  const color = own === 'critical' ? 'bg-danger' : own === 'warn' ? 'bg-warn' : 'bg-accent'
  const text = own === 'critical' ? 'text-danger' : own === 'warn' ? 'text-warn' : 'text-muted'
  const macBusy = snap.osPressure !== 'normal'
  const others = (snap.topOthers ?? []).map((o) => `${o.name} ${gb(o.rss)}`).join(', ')
  const macUse = snap.mac ? ` · Your Mac: ${gb(snap.mac.used)} of ${gb(snap.totalMem)} in use` : ''
  const macNote = macBusy ? ` · Your Mac is low on memory (macOS: ${snap.osPressure}, swap ${gb(snap.swapUsed)})${others ? `; biggest apps: ${others}` : ''}` : ''
  return (
    <button onClick={onOpen} className="group mx-2 mb-1 rounded-md px-1.5 py-1 text-left hover:bg-panel-2" title={`Sinfonie uses ${gb(snap.appRss)} of a ${gb(snap.budget)} budget${macUse}${macNote} · ${snap.sessions.length} agent${snap.sessions.length === 1 ? '' : 's'}, ${running} subagent${running === 1 ? '' : 's'} running. Click for details.`}>
      <div className={clsx('flex items-center justify-between text-[11px]', text)}>
        <span>
          Memory {gb(snap.appRss)}
          {snap.mac ? (
            <span className={snap.osPressure === 'critical' ? 'text-danger' : macBusy ? 'text-warn' : undefined}>
              {' '}· Mac {(snap.mac.used / 1024 ** 3).toFixed(0)}/{(snap.totalMem / 1024 ** 3).toFixed(0)} GB
            </span>
          ) : (
            macBusy && <span className={snap.osPressure === 'critical' ? 'text-danger' : 'text-warn'}> · Mac busy</span>
          )}
        </span>
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

/** Who owns the space: an organisation's name when it is shared there, nothing for personal spaces. */
function OwnerChip({ spaceId }: { spaceId: string }): React.JSX.Element | null {
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId))
  const orgs = useApp((s) => s.settings.cloud?.account?.orgs)
  if (!space?.orgId) return null
  const org = orgs?.find((o) => o.id === space.orgId)
  return (
    <span className="ml-1 inline-flex max-w-[110px] shrink-0 items-center gap-1 truncate rounded-full border border-accent/40 px-1.5 text-[11px] text-accent" title={`Shared in ${org?.name ?? 'an organisation'}${space.orgSpace ? `, version ${space.orgSpace.version}` : ''}`}>
      <Users2 size={9} /> {org?.name ?? 'Organisation'}
    </span>
  )
}

/**
 * What teammates are working on in a shared space: their live workspaces with branch, stage and
 * time. "Open here" recreates one on this Mac on the same branch, checked out from origin when pushed.
 */
function Teammates({ spaceId, guided }: { spaceId: string; guided?: boolean }): React.JSX.Element | null {
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId))
  const select = useApp((s) => s.select)
  const setError = useApp((s) => s.setError)
  const repos = useApp((s) => s.repos)
  const [list, setList] = useState<TeammateWorkspace[] | null>(null)
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const shared = Boolean(space?.orgSpace)
  useEffect(() => {
    if (!shared) return setList(null)
    let alive = true
    const load = (): void => {
      void api
        .invoke('orgSpaces:teammates', spaceId)
        .then((l) => alive && setList(l))
        .catch(() => undefined)
    }
    load()
    const t = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [spaceId, shared])
  if (!shared || !list) return null
  const byUser = new Map<string, TeammateWorkspace[]>()
  for (const w of list) byUser.set(w.user.id, [...(byUser.get(w.user.id) ?? []), w])
  const openHere = async (w: TeammateWorkspace): Promise<void> => {
    setBusy(w.id)
    try {
      const ws = await api.invoke('orgSpaces:openTeammate', spaceId, w)
      select(ws.id)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="mt-3">
      <button aria-expanded={open} className="flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted hover:text-text" onClick={() => setOpen(!open)}>
        <Users2 size={12} /> Teammates ({list.length}) {open ? '▾' : '▸'}
      </button>
      {open && list.length === 0 && <div className="px-2 py-1 text-[12px] text-muted">Nobody else is working on something here right now.</div>}
      {open &&
        [...byUser.entries()].map(([uid, items]) => (
          <div key={uid} className="mb-1">
            <div className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] text-muted">
              {items[0].user.avatarUrl ? <img src={items[0].user.avatarUrl} alt="" className="h-4 w-4 rounded-full" /> : <span className="h-4 w-4 rounded-full bg-panel-2" />}
              {items[0].user.name || items[0].user.login}
            </div>
            {items.map((w) => (
              <div key={w.id} className="group flex items-center gap-2 rounded-md px-2 py-1 text-[12px] hover:bg-panel-2/60" title={guided ? w.name : `${w.repos.map((r) => `${r.name} on ${r.branch}`).join(', ')}${w.ticket ? ` · ${w.ticket}` : ''}`}>
                <div className="min-w-0 flex-1">
                  <div className="truncate">{w.name}</div>
                  <div className="truncate text-[11px] text-muted">
                    {w.stage ? guidedStageLabel(w.stage, Boolean(guided)) : ''}
                    {w.stage ? ' · ' : ''}
                    {guided ? w.repos.map((r) => repoLabel(repos.find((x) => x.spaceId === spaceId && x.name === r.name) ?? r)).join(', ') : `${w.repos.length} repo${w.repos.length === 1 ? '' : 's'}`}
                    {w.lastActivityAt ? ` · ${timeAgo(w.lastActivityAt)}` : ''}
                  </div>
                </div>
                {!guided && (
                  <button className="reveal-on-focus rounded px-1.5 py-0.5 text-[11px] text-accent opacity-0 hover:bg-panel-2 group-hover:opacity-100 disabled:opacity-40" disabled={busy === w.id} onClick={() => void openHere(w)} title="Create the same workspace here, on their branch">
                    {busy === w.id ? '…' : 'Open here'}
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
    </div>
  )
}

/** Arc-style dot bar: one dot per space, the current one stretched into a pill with its name. */
function SpaceDots({ ids, currentId, guided, onPick, onAdd }: { ids: string[]; currentId: string; guided: boolean; onPick: (id: string) => void; onAdd?: () => void }): React.JSX.Element {
  const spaces = useApp((s) => s.spaces)
  const orgs = useApp((s) => s.settings.cloud?.account?.orgs)
  return (
    <div data-tour="spaces" className="flex h-10 shrink-0 items-center gap-1.5 border-t border-border px-3">
      {ids.map((id, i) => {
        const sp = spaces.find((s) => s.id === id)
        const name = sp?.name ?? ungroupedName(spaces.length > 0, guided)
        const color = sp?.color ?? tokens.muted
        const isCurrent = id === currentId
        return (
          <button
            key={id || '__none'}
            onClick={() => onPick(id)}
            aria-label={name}
            aria-current={isCurrent ? 'true' : undefined}
            title={`${name}${sp?.orgId ? ` · ${orgs?.find((o) => o.id === sp.orgId)?.name ?? 'organisation'}` : ''} (⌃${i + 1})`}
            className={clsx('flex h-5 items-center gap-1.5 rounded-full transition-all duration-200', isCurrent ? 'bg-panel-2 px-2' : 'w-2.5 justify-center hover:scale-125')}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color, opacity: isCurrent ? 1 : 0.7 }} />
            {isCurrent && <span className="max-w-[120px] truncate text-[11px] font-medium text-text">{name}</span>}
          </button>
        )
      })}
      {onAdd && (
        <IconButton label="New space" onClick={onAdd} className="ml-auto rounded-full p-1">
          <Plus size={12} />
        </IconButton>
      )}
    </div>
  )
}

function WorkspaceRow({ ws, grouped, selected, busy, done, onClick }: { ws: Workspace; grouped: boolean; selected: boolean; busy: boolean; done?: boolean; onClick: () => void }): React.JSX.Element {
  const branch = ws.repos[0]?.branch
  const allLabels = useApp((s) => s.labels)
  const rowLabels = (ws.labelIds ?? []).map((id) => allLabels.find((l) => l.id === id)).filter((l): l is NonNullable<typeof l> => Boolean(l))
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const { setError, setShowArchived } = useApp()
  const guided = useGuided()
  const run = (fn: () => Promise<unknown>): void => {
    fn().catch((err) => setError(friendlyError(err)))
  }
  const t = words(guided)
  const finishing: MenuEntry[] = ws.status === 'archived'
    ? [{ label: 'Remove from list', icon: <Trash2 size={14} />, danger: true, onClick: () => removeWithUndo(ws.id, `Removed “${workspaceLabel(ws, guided)}” from the list.`, () => api.invoke('workspaces:delete', ws.id)) }]
    : [
        {
          label: guided ? 'Finish task…' : 'Archive workspace…',
          icon: <Archive size={14} />,
          onClick: () => {
            onClick()
            window.dispatchEvent(new CustomEvent('sinfonie:archive', { detail: { id: ws.id, mode: 'archive' } }))
          }
        },
        {
          label: `Delete ${t.workspace}…`,
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: () => {
            onClick()
            window.dispatchEvent(new CustomEvent('sinfonie:archive', { detail: { id: ws.id, mode: 'delete' } }))
          }
        }
      ]
  // Feedback #72: keep a chat marked unread to come back to it. (Right-click opens the row, which reads it, so
  // there is no "Mark as read" to offer; opening it again clears the mark.)
  const unread: MenuEntry = { label: 'Mark as unread', icon: <Mail size={14} />, onClick: () => useChat.getState().markUnread(ws.id), disabled: ws.status === 'archived' }
  const entries: MenuEntry[] = guided ? [{ label: 'Rename task…', icon: <Pencil size={14} />, onClick: () => setEditing(true) }, unread, { separator: true }, ...finishing] : [
    { label: 'Rename workspace…', icon: <Pencil size={14} />, onClick: () => setEditing(true) },
    unread,
    { label: 'Move to space…', icon: <Layers size={14} />, onClick: () => window.dispatchEvent(new CustomEvent('sinfonie:moveSpace', { detail: ws.id })) },
    { separator: true },
    { label: 'Reveal in Finder', icon: <Folder size={14} />, onClick: () => run(() => api.invoke('workspaces:openIn', ws.id, 'finder')), disabled: ws.status === 'archived' },
    { label: 'Open in VS Code', icon: <Code2 size={14} />, onClick: () => run(() => api.invoke('workspaces:openIn', ws.id, 'vscode')), disabled: ws.status === 'archived' },
    { label: 'Open in Cursor', icon: <Code2 size={14} />, onClick: () => run(() => api.invoke('workspaces:openIn', ws.id, 'cursor')), disabled: ws.status === 'archived' },
    { label: 'Open in Terminal', icon: <TerminalSquare size={14} />, onClick: () => run(() => api.invoke('workspaces:openIn', ws.id, 'terminal')), disabled: ws.status === 'archived' },
    { separator: true },
    ...finishing
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
        aria-current={selected ? 'page' : undefined}
        onKeyDown={(e) => {
          // Keys typed into the inline rename field belong to it, not to the row.
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onClick()
          } else if (e.key === 'F2') setEditing(true)
          else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.left + 16, y: r.bottom })
          }
        }}
        className={clsx('group/row mb-0.5 flex w-full cursor-default flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors', selected ? 'bg-panel-2' : 'hover:bg-panel-2/60', ws.status === 'archived' && 'opacity-60')}
      >
        <div className="flex items-center gap-2">
          {!grouped && <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', stageDot(ws.stage))} title={guidedStageLabel(ws.stage, guided)} />}
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
            <span className="truncate text-[13px] font-medium" title={guided ? workspaceLabel(ws, true) : `${ws.name}\nbranch: ${branch}`}>
              {workspaceLabel(ws, guided)}
            </span>
          )}
          <span className="ml-auto shrink-0">
            {busy || ws.status === 'creating' || ws.status === 'archiving' ? <Spinner /> : ws.status === 'error' ? <span className="inline-block h-2 w-2 rounded-full bg-danger" title={guided ? 'Something went wrong; open the task to see' : ws.error} /> : done ? <span className="inline-block h-2 w-2 rounded-full bg-accent" title={guided ? 'Ready to look at' : 'Unread: finished since you last looked, or marked unread'} /> : null}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          {ws.jira && (
            <span className="shrink-0 text-accent" title={`${ws.jira.key}: ${ws.jira.summary}${ws.jiraStatus ? ` · ${ws.jiraStatus}` : ''}`}>
              {ws.jira.key}
            </span>
          )}
          {ws.linear && (
            <span className="shrink-0 text-accent" title={`${ws.linear.identifier}: ${ws.linear.title}${ws.linearStatus ? ` · ${ws.linearStatus}` : ''}`}>
              {ws.linear.identifier}
            </span>
          )}
          {!guided &&
            rowLabels.slice(0, 2).map((l) => (
              <LabelChip key={l.id} label={l} small />
            ))}
          {!guided && rowLabels.length > 2 && <span>+{rowLabels.length - 2}</span>}
          <span className="ml-auto shrink-0">
            {guided ? '' : `${ws.repos.length} repo${ws.repos.length === 1 ? '' : 's'} · `}
            {timeAgo(ws.lastMessageAt ?? ws.createdAt)}
          </span>
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} label={cap(t.workspace)} entries={entries} onClose={() => setMenu(null)} />}
    </>
  )
}

/** The bucket for workspaces outside every space: the same "No space" label as the space picker. */
function ungroupedName(hasSpaces: boolean, guided: boolean): string {
  const t = words(guided)
  return hasSpaces ? `No ${t.space}` : cap(t.workspaces)
}
