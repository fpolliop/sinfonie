import React, { useEffect, useRef } from 'react'
import clsx from 'clsx'

export interface MenuEntry {
  label?: string
  icon?: React.ReactNode
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  /** A keyboard shortcut shown at the right edge, e.g. "⌃1". */
  hint?: string
  /** Marks the entry that is already in effect (the current space). */
  current?: boolean
  /** A tooltip; for a disabled entry, why it is disabled. */
  title?: string
}

/**
 * A small positioned menu for right-clicks and ⋯ buttons. Closes on outside click, Escape, or selection. Keyboard:
 * focus lands on the first item, ↑/↓ (and Home/End) move, Enter/Space picks, Tab closes; focus returns to
 * whatever had it before the menu opened.
 */
export function ContextMenu({ x, y, entries, onClose, label }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void; label?: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
    return () => {
      if (before && document.contains(before)) before.focus()
    }
  }, [])
  const onMenuKey = (e: React.KeyboardEvent): void => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])
    if (!items.length) return
    const i = items.indexOf(document.activeElement as HTMLElement)
    const go = (n: number): void => {
      e.preventDefault()
      items[(n + items.length) % items.length].focus()
    }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? items.length - 1 : i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
    else if (e.key === 'Tab') {
      e.preventDefault()
      onClose()
    }
  }
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Escape closes the menu only, not a dialog or pane behind it.
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, { capture: true })
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, { capture: true })
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  // Keep the menu on screen.
  const left = Math.min(x, window.innerWidth - 240)
  const top = Math.min(y, window.innerHeight - entries.length * 30 - 16)
  return (
    <div ref={ref} className="no-drag fixed z-50 w-56 rounded-lg border border-border bg-panel p-1 shadow-xl" style={{ left, top }} role="menu" aria-label={label} onKeyDown={onMenuKey} onContextMenu={(e) => e.preventDefault()}>
      {entries.map((m, i) =>
        m.separator ? (
          <div key={i} role="separator" className="my-1 border-t border-border" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={m.disabled}
            title={m.title}
            aria-current={m.current ? 'true' : undefined}
            onClick={() => {
              onClose()
              m.onClick?.()
            }}
            className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-panel-2 focus:bg-panel-2 focus:outline-none disabled:opacity-40', m.danger ? 'text-danger' : 'text-text', m.current && 'font-semibold')}
          >
            {m.icon} <span className="min-w-0 flex-1 truncate">{m.label}</span>
            {m.hint && <span className="shrink-0 text-[11px] text-muted">{m.hint}</span>}
          </button>
        )
      )}
    </div>
  )
}
