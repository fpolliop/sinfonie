import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Wand2, Plus, Minimize2, Pin, PinOff, Archive, ArchiveRestore, Trash2, Pencil, Search, Brain } from 'lucide-react'
import { MaestroMemory } from './MaestroMemory'
import { useMaestro } from '@/stores/maestro'
import { useApp } from '@/stores/app'
import { MaestroConversation } from './MaestroConversation'
import { ContextMenu, type MenuEntry } from '../ContextMenu'
import { InlineRename } from '../InlineRename'
import { inputCls } from '../ui'
import type { MaestroConversationMeta } from '@shared/types'

/** Maestro full screen: the conversation list on the left, the conversation on the right. */
export function MaestroView(): React.JSX.Element {
  const { activeId, conversations, listLoaded, select, newConversation, loadList, subscribe, setShape, setOpen, rename, pin, archive, remove } = useMaestro()
  const setView = useApp((s) => s.setView)
  const setError = useApp((s) => s.setError)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [memory, setMemory] = useState(false)
  useEffect(() => {
    subscribe()
    if (!listLoaded) void loadList()
  }, [subscribe, loadList, listLoaded])
  useEffect(() => {
    if (!listLoaded) return
    if (activeId) void select(activeId)
    else if (conversations.length) void select(conversations.find((c) => !c.archivedAt)?.id ?? conversations[0].id)
    else void newConversation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listLoaded])
  const q = query.trim().toLowerCase()
  const shown = useMemo(() => conversations.filter((c) => (showArchived ? Boolean(c.archivedAt) : !c.archivedAt) && (!q || c.title.toLowerCase().includes(q) || (c.preview ?? '').toLowerCase().includes(q))), [conversations, showArchived, q])
  const pinned = shown.filter((c) => c.pinnedAt)
  const rest = shown.filter((c) => !c.pinnedAt)
  const go = (fn: () => Promise<void>): void => {
    fn().catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  const entriesFor = (c: MaestroConversationMeta): MenuEntry[] => [
    { label: 'Rename', icon: <Pencil size={13} />, onClick: () => setRenaming(c.id) },
    c.pinnedAt ? { label: 'Unpin', icon: <PinOff size={13} />, onClick: () => go(() => pin(c.id, false)) } : { label: 'Pin', icon: <Pin size={13} />, onClick: () => go(() => pin(c.id, true)) },
    c.archivedAt ? { label: 'Restore', icon: <ArchiveRestore size={13} />, onClick: () => go(() => archive(c.id, false)) } : { label: 'Archive', icon: <Archive size={13} />, onClick: () => go(() => archive(c.id, true)) },
    { separator: true },
    { label: 'Delete', icon: <Trash2 size={13} />, danger: true, onClick: () => window.confirm(`Delete "${c.title}"? Maestro forgets this conversation.`) && go(() => remove(c.id)) }
  ]
  const row = (c: MaestroConversationMeta): React.JSX.Element => (
    <div
      key={c.id}
      onClick={() => void select(c.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ id: c.id, x: e.clientX, y: e.clientY })
      }}
      className={clsx('group mb-0.5 cursor-pointer rounded-lg px-3 py-2', c.id === activeId ? 'bg-panel-2' : 'hover:bg-panel-2/60')}
    >
      {renaming === c.id ? (
        <InlineRename value={c.title} onSave={(v) => (setRenaming(null), go(() => rename(c.id, v)))} onCancel={() => setRenaming(null)} />
      ) : (
        <div className="flex items-center gap-1.5 text-[13px] font-medium">
          {c.pinnedAt && <Pin size={11} className="shrink-0 text-muted" />}
          <span className="truncate">{c.title}</span>
          {c.busy && <span className="ml-auto h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
        </div>
      )}
      <div className="truncate text-[11px] text-muted">{c.preview ?? 'Empty'}</div>
      <div className="text-[10px] text-muted">{when(c.updatedAt)}</div>
    </div>
  )
  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[300px] shrink-0 flex-col border-r border-border">
        <div className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-accent">
            <Wand2 size={14} />
          </span>
          <span className="text-[13px] font-semibold">Maestro</span>
          <div className="no-drag ml-auto flex items-center gap-1">
            <button className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" title="New conversation" onClick={() => void newConversation()}>
              <Plus size={15} />
            </button>
            <button
              className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text"
              title="Dock to the side"
              onClick={() => {
                setShape('side')
                setOpen(true)
                setView('workspace')
              }}
            >
              <Minimize2 size={14} />
            </button>
          </div>
        </div>
        <div className="border-b border-border px-3 py-2">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-2.5 text-muted" />
            <input className={clsx(inputCls, 'pl-7')} placeholder="Search conversations…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {pinned.length > 0 && <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Pinned</div>}
          {pinned.map(row)}
          {pinned.length > 0 && rest.length > 0 && <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Recent</div>}
          {rest.map(row)}
          {shown.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-muted">{showArchived ? 'Nothing archived.' : 'No conversations yet.'}</div>}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-muted">
          <button className="hover:text-text" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? 'Show recent' : `Archived · ${conversations.filter((c) => c.archivedAt).length}`}
          </button>
          <button className="ml-auto inline-flex items-center gap-1 hover:text-text" title="What Maestro remembers, and how much it may do on its own" onClick={() => setMemory(true)}>
            <Brain size={12} /> Memory
          </button>
        </div>
      </div>
      <div className="min-w-0 flex-1">{activeId ? <MaestroConversation id={activeId} /> : null}</div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={entriesFor(conversations.find((c) => c.id === menu.id)!)} onClose={() => setMenu(null)} />}
      {memory && <MaestroMemory onClose={() => setMemory(false)} />}
    </div>
  )
}

function when(iso: string): string {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
