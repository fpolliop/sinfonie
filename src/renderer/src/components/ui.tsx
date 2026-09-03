import React, { useEffect } from 'react'
import clsx from 'clsx'

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'subtle'; size?: 'sm' | 'md' }

export function Button({ variant = 'subtle', size = 'md', className, ...rest }: BtnProps): React.JSX.Element {
  return (
    <button
      className={clsx(
        'no-drag inline-flex items-center gap-1.5 rounded-md font-medium transition-colors whitespace-nowrap',
        size === 'sm' ? 'px-2 py-1 text-[12px]' : 'px-3 py-1.5 text-[13px]',
        variant === 'primary' && 'bg-accent-2 text-white hover:bg-accent',
        variant === 'danger' && 'bg-danger/15 text-danger hover:bg-danger/25',
        variant === 'ghost' && 'text-muted hover:text-text hover:bg-panel-2',
        variant === 'subtle' && 'bg-panel-2 text-text hover:bg-border',
        className
      )}
      {...rest}
    />
  )
}

export function Dialog({ title, onClose, children, width = 520 }: { title: string; onClose: () => void; children: React.ReactNode; width?: number }): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 no-drag" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rounded-xl border border-border bg-panel shadow-2xl" style={{ width, maxWidth: '92vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <button className="text-muted hover:text-text" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="overflow-auto p-4">{children}</div>
      </div>
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }): React.JSX.Element {
  return (
    <label className="block mb-3">
      <div className="mb-1 text-[12px] font-medium text-muted">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-muted">{hint}</div>}
    </label>
  )
}

export const inputCls = 'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-accent'

export function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'danger' | 'accent' }): React.JSX.Element {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium',
        tone === 'muted' && 'bg-panel-2 text-muted',
        tone === 'ok' && 'bg-ok/15 text-ok',
        tone === 'warn' && 'bg-warn/15 text-warn',
        tone === 'danger' && 'bg-danger/15 text-danger',
        tone === 'accent' && 'bg-accent/15 text-accent'
      )}
    >
      {children}
    </span>
  )
}

export function Spinner(): React.JSX.Element {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-accent" />
}
