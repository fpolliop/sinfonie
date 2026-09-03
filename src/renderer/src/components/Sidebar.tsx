import React from 'react'
import clsx from 'clsx'
import { Plus, Settings, Archive, GitBranch } from 'lucide-react'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { timeAgo } from '@/lib/format'
import { Spinner } from './ui'
import type { Workspace } from '@shared/types'

export function Sidebar(): React.JSX.Element {
  const { workspaces, selectedId, select, setShowNewWorkspace, setShowSettings, showArchived, setShowArchived } = useApp()
  const chats = useChat((s) => s.chats)
  const active = workspaces.filter((w) => w.status !== 'archived').sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))
  const archived = workspaces.filter((w) => w.status === 'archived')

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
        <SectionLabel>Workspaces</SectionLabel>
        {active.length === 0 && <div className="px-2 py-3 text-[12px] text-muted">No workspaces yet.</div>}
        {active.map((w) => (
          <WorkspaceRow key={w.id} ws={w} selected={w.id === selectedId} busy={Boolean(chats[w.id]?.busy)} onClick={() => select(w.id)} />
        ))}
        {archived.length > 0 && (
          <>
            <button className="mt-3 flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted hover:text-text" onClick={() => setShowArchived(!showArchived)}>
              <Archive size={12} /> Archived ({archived.length}) {showArchived ? '▾' : '▸'}
            </button>
            {showArchived && archived.map((w) => <WorkspaceRow key={w.id} ws={w} selected={w.id === selectedId} busy={false} onClick={() => select(w.id)} />)}
          </>
        )}
      </div>
    </aside>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted">{children}</div>
}

function WorkspaceRow({ ws, selected, busy, onClick }: { ws: Workspace; selected: boolean; busy: boolean; onClick: () => void }): React.JSX.Element {
  const branch = ws.repos[0]?.branch
  return (
    <button
      onClick={onClick}
      className={clsx('mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors', selected ? 'bg-panel-2' : 'hover:bg-panel-2/60', ws.status === 'archived' && 'opacity-60')}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-[13px] font-medium">{ws.name}</span>
        <span className="ml-auto shrink-0">
          {busy || ws.status === 'creating' || ws.status === 'archiving' ? <Spinner /> : ws.status === 'error' ? <span className="h-2 w-2 rounded-full bg-danger inline-block" /> : null}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        <GitBranch size={11} />
        <span className="truncate">{branch}</span>
        <span className="ml-auto shrink-0">{ws.repos.length} repo{ws.repos.length === 1 ? '' : 's'} · {timeAgo(ws.lastMessageAt ?? ws.createdAt)}</span>
      </div>
    </button>
  )
}
