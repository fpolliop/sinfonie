/**
 * The last line of defence for the whole window. Without it, an error React cannot recover from
 * (a render throw, an update loop) unmounts the app and leaves a blank window. With it, the user
 * gets a short explanation and a Reload button, and the crash report carries the component stack.
 */
import React from 'react'
import { Button } from './ui'
import { friendlyError } from '@/lib/errors'

/** Written to the console in the shape main's crash forwarding picks up ("Uncaught …"). */
export function reportRenderError(kind: 'uncaught' | 'caught', thrown: unknown, componentStack?: string): void {
  const message = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)
  const stack = (componentStack ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join(' < ')
  console.error(`Uncaught render error (${kind}): ${message}${stack ? ` | components: ${stack}` : ''}`)
}

export class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: unknown }> {
  state = { error: null as unknown }
  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error }
  }
  render(): React.ReactNode {
    if (this.state.error === null) return this.props.children
    const detail = friendlyError(this.state.error, 'The screen hit an error it could not recover from.')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-[15px] font-semibold">Something went wrong on this screen</div>
        <p className="max-w-md text-[13px] text-muted">Your workspaces, chats and files are safe. Reload the window to carry on; the error was reported so it can be fixed.</p>
        <p className="max-w-lg text-[12px] text-muted">{detail}</p>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload window
        </Button>
      </div>
    )
  }
}
