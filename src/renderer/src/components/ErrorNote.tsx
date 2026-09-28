import React from 'react'
import clsx from 'clsx'
import { rawMessage } from '@/lib/errors'

/**
 * A failure on an expert surface: a human sentence first, then the raw text. Short raw text sits inline; long or
 * multi-line text folds behind "Details" so a stack trace never takes over the layout.
 */
export function ErrorNote({ summary, detail, className, tone = 'danger' }: { summary: string; detail?: unknown; className?: string; tone?: 'danger' | 'warn' }): React.JSX.Element {
  const raw = detail === undefined || detail === null || detail === '' ? '' : rawMessage(detail)
  const long = raw.length > 140 || raw.includes('\n')
  return (
    <div className={clsx('min-w-0 text-[12px]', tone === 'danger' ? 'text-danger' : 'text-warn', className)} role="status">
      <span>{summary}</span>
      {raw && !long && <span className="ml-1 break-words font-mono text-[11px] text-muted">{raw}</span>}
      {raw && long && (
        <details className="mt-1" data-expert-ok="">
          <summary className="w-fit cursor-pointer select-none text-[11px] text-muted hover:text-text">Details</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[11px] text-muted">{raw}</pre>
        </details>
      )}
    </div>
  )
}
