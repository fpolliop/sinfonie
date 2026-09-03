import React, { useRef, useState } from 'react'
import clsx from 'clsx'
import { Plus, Settings, Archive, GitBranch, Pencil, Folder, Code2, TerminalSquare, Trash2, GitPullRequest, Layers, ListTree, CalendarClock, ArrowDownWideNarrow, ArrowUpNarrowWide } from 'lucide-react'
import { WORKSPACE_STAGES } from '@shared/types'
import { useApp, spaceOrder } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { timeAgo } from '@/lib/format'
import { api } from '@/lib/api'
import { renameWorkspace } from '@/lib/rename'
import { Spinner } from './ui'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { InlineRename } from './InlineRename'
import { SpaceSettingsDialog } from './SpaceSettingsDialog'
import { STAGE_DOT, stageLabel } from './StagePicker'
import type { Workspace } from '@shared/types'

export function Sidebar(): React.JSX.Element {
  const { workspaces, spaces, selectedId, select, setShowNewWorkspace, setShowSettings, showArchived, setShowArchived, view, setView, setError, activeSpaceId, setActiveSpace, stepSpace, sidebarView, sidebarDateDir, collapsedStages, setSidebarView, setSidebarDateDir, toggleStage } = useApp()
  const chats = useChat((s) => s.chats)
  const [spaceMenu, setSpaceMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [spaceSettings, setSpaceSettings] = useState<string | null>(null)
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
  const items = currentId ? active.filter((w) => w.spaceId === currentId) : active.filter(isUngrouped)
  const archived = workspaces.filter((w) => w.status === 'archived').filter((w) => (currentId ? w.spaceId === currentId : isUngrouped(w)))
  const run = (fn: () => Promise<unknown>): void => {
    fn().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  const row = (w: Workspace): React.JSX.Element => <WorkspaceRow key={w.id} ws={w} selected={view === 'workspace' && w.id === selectedId} busy={Boolean(chats[w.id]?.busy)} onClick={() => select(w.id)} />

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
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-border bg-panel" onWheel={onWheel}>
      <div className="drag flex h-[52px] items-center justify-end gap-1 pl-[80px] pr-2">
        <button className="no-drag rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" title="New workspace (⇧⌘N)" onClick={() => setShowNewWorkspace(true, currentId)}>
          <Plus size={16} />
        </button>
        <button className="no-drag rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" title="Settings (⌘,)" onClick={() => setShowSettings(true)}>
          <Settings size={16} />
        </button>
      </div>
      <div className="px-2">
        <button onClick={() => setView('reviews')} className={clsx('mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium', view === 'reviews' ? 'bg-panel-2' : 'hover:bg-panel-2/60')}>
          <GitPullRequest size={14} className="text-accent" /> Review cockpit
        </button>
      </div>
      <div key={currentId} className="space-enter flex-1 overflow-auto px-2 pb-2">
        <div
          className="group flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted"
          onContextMenu={(e) => {
            if (!currentId) return
            e.preventDefault()
            setSpaceMenu({ x: e.clientX, y: e.clientY, id: currentId })
          }}
          onDoubleClick={() => currentId && setRenaming(currentId)}
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: currentColor }} />
          {renaming === currentId && currentId ? (
            <InlineRename
              value={currentName}
              className="normal-case tracking-normal"
              onSave={(v) => {
                setRenaming(null)
                run(() => api.invoke('spaces:update', currentId, { name: v }))
              }}
              onCancel={() => setRenaming(null)}
            />
          ) : (
            <span className="truncate">{currentName}</span>
          )}
          <span className="normal-case text-muted/70">{items.length}</span>
          {currentId && (
            <button className="ml-auto rounded p-0.5 opacity-0 hover:bg-panel-2 hover:text-text group-hover:opacity-100" title="Space settings" onClick={() => setSpaceSettings(currentId)}>
              <Settings size={12} />
            </button>
          )}
        </div>
        <div className="mb-1 flex items-center gap-1 px-1">
          <div className="flex rounded-md bg-bg p-0.5">
            <button onClick={() => setSidebarView('status')} title="Group by status" className={clsx('rounded px-1.5 py-0.5', sidebarView === 'status' ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
              <ListTree size={12} />
            </button>
            <button onClick={() => setSidebarView('date')} title="List by start date" className={clsx('rounded px-1.5 py-0.5', sidebarView === 'date' ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
              <CalendarClock size={12} />
            </button>
          </div>
          <span className="text-[11px] text-muted">{sidebarView === 'status' ? 'By status' : 'By start date'}</span>
          {sidebarView === 'date' && (
            <button onClick={() => setSidebarDateDir(sidebarDateDir === 'desc' ? 'asc' : 'desc')} title={sidebarDateDir === 'desc' ? 'Newest first. Click for oldest first.' : 'Oldest first. Click for newest first.'} className="ml-auto rounded p-0.5 text-muted hover:text-text">
              {sidebarDateDir === 'desc' ? <ArrowDownWideNarrow size={12} /> : <ArrowUpNarrowWide size={12} />}
            </button>
          )}
        </div>
        {sidebarView === 'status'
          ? WORKSPACE_STAGES.map((st) => {
              const group = items.filter((w) => w.stage === st.id)
              const collapsed = Boolean(collapsedStages[st.id])
              return (
                <div key={st.id} className="mb-1">
                  <button onClick={() => toggleStage(st.id)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-muted hover:text-text">
                    <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', STAGE_DOT[st.id])} />
                    {st.label}
                    <span className="text-muted/70">{group.length}</span>
                    <span className="ml-auto">{collapsed ? '▸' : '▾'}</span>
                  </button>
                  {!collapsed && group.map(row)}
                  {!collapsed && group.length === 0 && <div className="px-3 pb-1 text-[11px] text-muted/60">—</div>}
                </div>
              )
            })
          : items.map(row)}
        {items.length === 0 && (
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
            {showArchived && archived.map(row)}
          </>
        )}
      </div>
      <SpaceDots ids={ids} currentId={currentId} onPick={setActiveSpace} onAdd={() => setShowSettings(true)} />
      {spaceSettings && <SpaceSettingsDialog spaceId={spaceSettings} onClose={() => setSpaceSettings(null)} />}
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

/** Arc-style dot bar: one dot per space, the current one stretched into a pill with its name. */
function SpaceDots({ ids, currentId, onPick, onAdd }: { ids: string[]; currentId: string; onPick: (id: string) => void; onAdd: () => void }): React.JSX.Element {
  const spaces = useApp((s) => s.spaces)
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-t border-border px-3">
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

function WorkspaceRow({ ws, selected, busy, onClick }: { ws: Workspace; selected: boolean; busy: boolean; onClick: () => void }): React.JSX.Element {
  const branch = ws.repos[0]?.branch
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const { setError, setShowArchived } = useApp()
  const run = (fn: () => Promise<unknown>): void => {
    fn().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  const entries: MenuEntry[] = [
    { label: 'Rename…', icon: <Pencil size={14} />, onClick: () => setEditing(true) },
    { label: 'Move to space…', icon: <Layers size={14} />, onClick: () => window.dispatchEvent(new CustomEvent('orchestra:moveSpace', { detail: ws.id })) },
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
              window.dispatchEvent(new CustomEvent('orchestra:archive', { detail: { id: ws.id, mode: 'archive' } }))
            }
          },
          {
            label: 'Delete…',
            icon: <Trash2 size={14} />,
            danger: true,
            onClick: () => {
              onClick()
              window.dispatchEvent(new CustomEvent('orchestra:archive', { detail: { id: ws.id, mode: 'delete' } }))
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
        className={clsx('mb-0.5 flex w-full cursor-default flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors', selected ? 'bg-panel-2' : 'hover:bg-panel-2/60', ws.status === 'archived' && 'opacity-60')}
      >
        <div className="flex items-center gap-2">
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
            <span className="truncate text-[13px] font-medium" title="Double-click to rename">
              {ws.name}
            </span>
          )}
          <span className="ml-auto shrink-0">
            {busy || ws.status === 'creating' || ws.status === 'archiving' ? <Spinner /> : ws.status === 'error' ? <span className="inline-block h-2 w-2 rounded-full bg-danger" /> : null}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          <GitBranch size={11} />
          <span className="truncate">{branch}</span>
          <span className="ml-auto shrink-0">
            {ws.repos.length} repo{ws.repos.length === 1 ? '' : 's'} · {timeAgo(ws.lastMessageAt ?? ws.createdAt)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', STAGE_DOT[ws.stage])} />
          <span className="text-muted">{stageLabel(ws.stage)}</span>
          {ws.jira && (
            <span className="ml-auto flex min-w-0 items-center gap-1 text-muted" title={`${ws.jira.key}: ${ws.jira.summary}`}>
              <span className="shrink-0 text-accent">{ws.jira.key}</span>
              {ws.jiraStatus && <span className="truncate rounded bg-panel-2 px-1 py-px">{ws.jiraStatus}</span>}
            </span>
          )}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries} onClose={() => setMenu(null)} />}
    </>
  )
}
