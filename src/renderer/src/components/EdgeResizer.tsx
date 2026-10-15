/**
 * The resize handle on the left edge of a panel anchored to the right (the workspace panel, the Maestro dock):
 * a 1px line with a 24px hit area that sits above the panel's content. Drag it, or focus it and use ←/→ (Shift
 * for bigger steps); Home or a double-click resets. The pointer is captured, so letting go outside the window
 * still ends the drag, and the native preview page (which draws above the DOM and swallows pointer events) is
 * detached while dragging.
 */
import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { api } from '@/lib/api'

export function EdgeResizer({
  width,
  min,
  max,
  reset,
  label,
  onLive,
  onCommit,
  className
}: {
  width: number
  min: number
  max: number
  reset: number
  label: string
  /** Called on every move while dragging (apply it cheaply); onCommit gets the final width. */
  onLive?: (w: number) => void
  onCommit: (w: number) => void
  className?: string
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const start = useRef({ x: 0, w: width })
  const latest = useRef(width)
  const bounds = useRef({ min, max })
  bounds.current = { min, max }
  const clamp = (w: number): number => Math.round(Math.max(bounds.current.min, Math.min(bounds.current.max, w)))
  useEffect(() => {
    if (!dragging) return
    void api.invoke('browser:suspend', true)
    document.body.style.cursor = 'col-resize'
    return () => {
      void api.invoke('browser:suspend', false)
      document.body.style.cursor = ''
      onCommit(latest.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging])
  const onKey = (e: React.KeyboardEvent): void => {
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowLeft') onCommit(clamp(width + step))
    else if (e.key === 'ArrowRight') onCommit(clamp(width - step))
    else if (e.key === 'Home') onCommit(clamp(reset))
    else return
    e.preventDefault()
  }
  const end = (): void => setDragging(false)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={Math.max(min, max)}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize (or focus and use ← →). Double-click resets."
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: width }
        latest.current = width
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (!dragging) return
        // Anchored on the right: moving left widens.
        latest.current = clamp(start.current.w + (start.current.x - e.clientX))
        onLive?.(latest.current)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => onCommit(clamp(reset))}
      onKeyDown={onKey}
      className={clsx('no-drag group absolute inset-y-0 -left-3 z-30 flex w-6 cursor-col-resize justify-center outline-none', className)}
    >
      <span aria-hidden className={clsx('h-full w-px transition-colors group-hover:bg-accent/60 group-focus-visible:w-0.5 group-focus-visible:bg-accent', dragging ? 'bg-accent' : 'bg-transparent')} />
    </div>
  )
}
