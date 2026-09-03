import React, { useState } from 'react'
import clsx from 'clsx'
import { Plus, Settings, Archive, GitBranch, Pencil, Folder, Code2, TerminalSquare, Trash2, GitPullRequest, Layers } from 'lucide-react'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { timeAgo } from '@/lib/format'
import { api } from '@/lib/api'
import { renameWorkspace } from '@/lib/rename'
import { Spinner } from './ui'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { InlineRename } from './InlineRename'
import { STAGE_DOT, stageLabel } from './StagePicker'
import type { Workspace } from '@shared/types'

export function Sidebar(): React.JSX.Element {
  const { workspaces, spaces, selectedId, select, setShowNewWorkspace, setShowSettings, showArchived, setShowArchived, view, setView, collapsedSpaces, toggleSpace, setError } = useApp()
  const chats = useChat((s) => s.chats)
  const [spaceMenu, setSpaceMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const byTime = (a: Workspace, b: Workspace): number => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt)
  const active = workspaces.filter((w) => w.status !== 'archived').sort(byTime)
  const archived = workspaces.filter((w) => w.status === 'archived')
  const run = (fn: () => Promise<unknown>): void => {
    fn().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  const groups: { id: string; name: string; color: string; items: Workspace[] }[] = [
    ...spaces.map((s) => ({ id: s.id, name: s.name, color: s.color, items: active.filter((w) => w.spaceId === s.id) })),
    { id: '', name: spaces.length ? 'No space' : 'Workspaces', color: '#8b93a1', items: active.filter((w) => !w.spaceId || !spaces.some((s) => s.id === w.spaceId)) }
  ].filter((g) => g.id !== '' || g.items.length > 0 || spaces.length === 0)

  const row = (w: Workspace): React.JSX.Element => <WorkspaceRow key={w.id} ws={w} selected={view === 'workspace' && w.id === selectedId} busy={Boolean(chats[w.id]?.busy)} onClick={() => select(w.id)} />

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-border bg-panel">
      <div className="drag flex h-[52px] items-center justify-end gap-1 pl-[80px] pr-2">
        <button className="no-drag rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" title="New workspace (⇧⌘N)" onClick={() => setShowNewWorkspace(true)}>
          <Plus size={16} />
        </button>
        <button className="no-drag rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" title="Settings (⌘,)" onClick={() => setShowSettings(true)}>
          <Settings size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-auto px-2 pb-2">
        <button onClick={() => setView('reviews')} className={clsx('mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium', view === 'reviews' ? 'bg-panel-2' : 'hover:bg-panel-2/60')}>
          <GitPullRequest size={14} className="text-accent" /> Review cockpit
        </button>
        {groups.map((g) => {
          const collapsed = Boolean(collapsedSpaces[g.id || '__none']) && g.id !== ''
          return (
            <div key={g.id || '__none'} className="mb-1">
              <div
                className="group flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted hover:text-text"
                onContextMenu={(e) => {
                  if (!g.id) return
                  e.preventDefault()
                  setSpaceMenu({ x: e.clientX, y: e.clientY, id: g.id })
                }}
              >
                <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => g.id && toggleSpace(g.id)} onDoubleClick={() => g.id && setRenaming(g.id)}>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: g.color }} />
                  {renaming === g.id ? (
                    <InlineRename
                      value={g.name}
                      className="normal-case tracking-normal"
                      onSave={(v) => {
                        setRenaming(null)
                        run(() => api.invoke('spaces:update', g.id, { name: v }))
                      }}
                      onCancel={() => setRenaming(null)}
                    />
                  ) : (
                    <span className="truncate">{g.name}</span>
                  )}
                  <span className="normal-case text-muted/70">{g.items.length}</span>
                  {g.id && <span className="ml-auto">{collapsed ? '▸' : '▾'}</span>}
                </button>
                <button className="rounded p-0.5 opacity-0 hover:bg-panel-2 group-hover:opacity-100" title={`New workspace in ${g.name}`} onClick={() => setShowNewWorkspace(true, g.id)}>
                  <Plus size={12} />
                </button>
              </div>
              {!collapsed && g.items.map(row)}
              {!collapsed && g.items.length === 0 && <div className="px-2 py-1.5 text-[12px] text-muted">{g.id ? 'No workspaces yet.' : 'No workspaces yet.'}</div>}
            </div>
          )
        })}
        <button className="mt-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-panel-2/60 hover:text-text" onClick={() => setShowSettings(true)}>
          <Plus size={12} /> New space
        </button>
        {archived.length > 0 && (
          <>
            <button className="mt-3 flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted hover:text-text" onClick={() => setShowArchived(!showArchived)}>
              <Archive size={12} /> Archived ({archived.length}) {showArchived ? '▾' : '▸'}
            </button>
            {showArchived && archived.map(row)}
          </>
        )}
      </div>
      {spaceMenu && (
        <ContextMenu
          x={spaceMenu.x}
          y={spaceMenu.y}
          onClose={() => setSpaceMenu(null)}
          entries={[
            { label: 'Rename space…', icon: <Pencil size={14} />, onClick: () => setRenaming(spaceMenu.id) },
            { label: 'New workspace here', icon: <Plus size={14} />, onClick: () => setShowNewWorkspace(true, spaceMenu.id) },
            { separator: true },
            {
              label: 'Delete space',
              icon: <Trash2 size={14} />,
              danger: true,
              onClick: () => run(() => api.invoke('spaces:delete', spaceMenu.id))
            }
          ]}
        />
      )}
    </aside>
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
