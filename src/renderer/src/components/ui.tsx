import React, { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import clsx from 'clsx'

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'subtle'; size?: 'sm' | 'md' }

export function Button({ variant = 'subtle', size = 'md', className, ...rest }: BtnProps): React.JSX.Element {
  return (
    <button
      className={clsx(
        'no-drag inline-flex items-center gap-1.5 rounded-md font-medium transition-colors whitespace-nowrap',
        size === 'sm' ? 'px-2 py-1 text-[12px]' : 'px-3 py-1.5 text-[13px]',
        variant === 'primary' && 'bg-primary text-white hover:bg-primary-hover',
        variant === 'danger' && 'bg-danger/15 text-danger hover:bg-danger/25',
        variant === 'ghost' && 'text-muted hover:text-text hover:bg-panel-2',
        variant === 'subtle' && 'bg-panel-2 text-text hover:bg-border',
        className
      )}
      {...rest}
    />
  )
}

/**
 * Modal stack: every open Dialog counts itself so window-level Escape handlers (SettingsWindow, panes) can step
 * aside while one is up. Dialog handles Escape in the capture phase and stops it from reaching anyone else.
 */
let dialogDepth = 0
export const pushModal = (): void => {
  dialogDepth += 1
}
export const popModal = (): void => {
  dialogDepth = Math.max(0, dialogDepth - 1)
}
export const hasOpenDialog = (): boolean => dialogDepth > 0

export function Dialog({ title, onClose, children, width = 520 }: { title: string; onClose: () => void; children: React.ReactNode; width?: number }): React.JSX.Element {
  // Native browser pages draw above the DOM; hide them while a modal is open.
  useEffect(() => {
    pushModal()
    void window.sinfonie.invoke('browser:suspend', true)
    return () => {
      popModal()
      void window.sinfonie.invoke('browser:suspend', false)
    }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      onClose()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])
  const titleId = useId()
  const boxRef = useRef<HTMLDivElement>(null)
  useFocusTrap(boxRef)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 no-drag" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="rounded-xl border border-border bg-panel shadow-2xl outline-none"
        style={{ width, maxWidth: '92vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id={titleId} className="text-[15px] font-semibold">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
        <div className="overflow-auto p-4">{children}</div>
      </div>
    </div>
  )
}

/**
 * Focus moves into `ref` on mount (first field, else the box itself), Tab and Shift+Tab wrap inside it, and focus
 * returns to where it was on unmount. Every modal surface uses this.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const box = ref.current
    const first = box?.querySelector<HTMLElement>('[autofocus], input:not([type=hidden]), textarea, select, button:not([aria-label="Close"])')
    ;(first ?? box)?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !box) return
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null)
      if (items.length === 0) return
      const [head, tail] = [items[0], items[items.length - 1]]
      if (e.shiftKey && (document.activeElement === head || document.activeElement === box)) {
        tail.focus()
        e.preventDefault()
      } else if (!e.shiftKey && document.activeElement === tail) {
        head.focus()
        e.preventDefault()
      }
    }
    box?.addEventListener('keydown', onKey)
    return () => {
      box?.removeEventListener('keydown', onKey)
      before?.focus?.()
    }
  }, [ref])
}

const FOCUSABLE = 'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])'

/**
 * A button that shows only an icon. `label` is required: it becomes both the accessible name and the tooltip,
 * and the hit area is at least 24px square.
 */
export function IconButton({ label, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx('no-drag inline-flex min-h-6 min-w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-panel-2 hover:text-text', className)}
      {...rest}
    >
      {children}
    </button>
  )
}

/** Segmented control: one row of mutually exclusive options, as an ARIA tablist. */
export function Segmented<T extends string>({ value, options, onChange, size = 'md', className }: { value: T; options: { id: T; label: React.ReactNode }[]; onChange: (v: T) => void; size?: 'sm' | 'md'; className?: string }): React.JSX.Element {
  return (
    <div role="tablist" className={clsx('inline-flex rounded-md border border-border bg-bg p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={o.id === value}
          onClick={() => onChange(o.id)}
          className={clsx('rounded px-2.5 font-medium transition-colors', size === 'sm' ? 'py-0.5 text-[11px]' : 'py-1 text-[12px]', o.id === value ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** On/off switch with a visible label. */
export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; hint?: React.ReactNode; disabled?: boolean }): React.JSX.Element {
  return (
    <label className={clsx('flex cursor-pointer items-start gap-3', disabled && 'cursor-not-allowed opacity-50')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx('relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors', checked ? 'bg-primary' : 'bg-border')}
      >
        <span className={clsx('absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all', checked ? 'left-3.5' : 'left-0.5')} />
      </button>
      <span className="flex flex-col gap-0.5">
        <span className="text-[13px]">{label}</span>
        {hint && <span className="text-[11px] text-muted">{hint}</span>}
      </span>
    </label>
  )
}

/** The one heading style for a group inside a page. */
export function SectionHeader({ children, action }: { children: React.ReactNode; action?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-2 mt-5 flex items-center justify-between first:mt-0">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</h3>
      {action}
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

/** Header chip: one height, radius and type size for every pill in the workspace header. */
export const chipCls = 'inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[11px] font-medium leading-none'

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
