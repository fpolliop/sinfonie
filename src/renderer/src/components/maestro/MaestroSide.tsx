import React, { useEffect, useRef, useState } from 'react'
import { Wand2, Plus, Maximize2, Minus, ChevronDown, Brain } from 'lucide-react'
import { MaestroMemory } from './MaestroMemory'
import { useMaestro } from '@/stores/maestro'
import { useApp } from '@/stores/app'
import { MaestroConversation } from './MaestroConversation'

/** Maestro docked at the right edge, over whatever the main pane shows. Resizable; expands to full screen. */
export function MaestroSide(): React.JSX.Element | null {
  const { open, width, activeId, conversations, listLoaded, setOpen, setWidth, setShape, select, newConversation, loadList, subscribe } = useMaestro()
  const setView = useApp((s) => s.setView)
  const dragging = useRef(false)
  const [memory, setMemory] = useState(false)
  useEffect(() => {
    subscribe()
    if (!listLoaded) void loadList()
  }, [subscribe, loadList, listLoaded])
  useEffect(() => {
    if (!open || !listLoaded) return
    if (activeId) void select(activeId)
    else if (conversations.length) void select(conversations[0].id)
    else void newConversation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, listLoaded])
  if (!open) return null
  const active = conversations.find((c) => c.id === activeId)
  const recent = conversations.filter((c) => !c.archivedAt).slice(0, 12)
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startW = width
    const move = (ev: MouseEvent): void => {
      if (dragging.current) setWidth(startW + (startX - ev.clientX))
    }
    const up = (): void => {
      dragging.current = false
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return (
    <aside className="no-drag fixed right-0 top-0 z-40 flex h-full flex-col border-l border-border bg-panel shadow-2xl" style={{ width }}>
      <div className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40" onMouseDown={startResize} title="Drag to resize" />
      <div className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Wand2 size={14} />
        </span>
        <div className="no-drag relative min-w-0 flex-1">
          <select className="w-full appearance-none truncate rounded-md bg-transparent py-1 pl-1 pr-6 text-[13px] font-semibold outline-none hover:bg-panel-2" value={activeId ?? ''} onChange={(e) => void select(e.target.value)} title="Switch conversation">
            {recent.map((c) => (
              <option key={c.id} value={c.id}>
                {c.pinnedAt ? '📌 ' : ''}
                {c.title}
              </option>
            ))}
            {active && !recent.some((c) => c.id === active.id) && <option value={active.id}>{active.title}</option>}
          </select>
          <ChevronDown size={12} className="pointer-events-none absolute right-1.5 top-2 text-muted" />
        </div>
        <button className="no-drag rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" title="New conversation" onClick={() => void newConversation()}>
          <Plus size={15} />
        </button>
        <button className="no-drag rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" title="Memory and autonomy" onClick={() => setMemory(true)}>
          <Brain size={14} />
        </button>
        <button
          className="no-drag rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text"
          title="Full screen"
          onClick={() => {
            setShape('full')
            setOpen(false)
            setView('maestro')
          }}
        >
          <Maximize2 size={14} />
        </button>
        <button className="no-drag rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" title="Minimise; the conversation stays (⇧⌘A)" onClick={() => setOpen(false)}>
          <Minus size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1">{activeId ? <MaestroConversation id={activeId} compact /> : null}</div>
      {memory && <MaestroMemory onClose={() => setMemory(false)} />}
    </aside>
  )
}
