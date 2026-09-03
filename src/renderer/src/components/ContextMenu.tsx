import React, { useEffect, useRef } from 'react'
import clsx from 'clsx'

export interface MenuEntry {
  label?: string
  icon?: React.ReactNode
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
}

/** A small positioned menu for right-clicks. Closes on outside click, Escape, or selection. */
export function ContextMenu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  // Keep the menu on screen.
  const left = Math.min(x, window.innerWidth - 240)
  const top = Math.min(y, window.innerHeight - entries.length * 30 - 16)
  return (
    <div ref={ref} className="no-drag fixed z-50 w-56 rounded-lg border border-border bg-panel p-1 shadow-xl" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      {entries.map((m, i) =>
        m.separator ? (
          <div key={i} className="my-1 border-t border-border" />
        ) : (
          <button
            key={i}
            disabled={m.disabled}
            onClick={() => {
              onClose()
              m.onClick?.()
            }}
            className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-panel-2 disabled:opacity-40', m.danger ? 'text-danger' : 'text-text')}
          >
            {m.icon} {m.label}
          </button>
        )
      )}
    </div>
  )
}
