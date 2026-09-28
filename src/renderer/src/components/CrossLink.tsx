import React from 'react'
import { ArrowRight } from 'lucide-react'

/** A one-line jump to a related settings page, e.g. from Slack sign-in to the On call channels. */
export function CrossLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={onClick}>
      {children} <ArrowRight size={11} />
    </button>
  )
}
