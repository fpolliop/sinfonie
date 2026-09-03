import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

/** Text input that replaces a label: Enter saves, Escape cancels, blur saves. */
export function InlineRename({ value, onSave, onCancel, className }: { value: string; onSave: (v: string) => void; onCancel: () => void; className?: string }): React.JSX.Element {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = (): void => {
    if (v.trim() && v.trim() !== value) onSave(v.trim())
    else onCancel()
  }
  return (
    <input
      ref={ref}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={clsx('no-drag w-full rounded border border-accent bg-bg px-1 py-0 text-[13px] font-medium outline-none', className)}
    />
  )
}
