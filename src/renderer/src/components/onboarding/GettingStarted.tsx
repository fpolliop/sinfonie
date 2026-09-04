import React, { useEffect, useState } from 'react'
import { CheckCircle2, Circle, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'

/** Six things a new install does, ticked from real state. Lives on the empty page until dismissed or done. */
export function GettingStarted(): React.JSX.Element | null {
  const { settings, spaces, repos, workspaces, openSettings, setShowNewWorkspace, setView, setOnboarding } = useApp()
  const [reviewed, setReviewed] = useState(false)
  useEffect(() => {
    api
      .invoke('reviews:runs')
      .then((r) => setReviewed(r.length > 0))
      .catch(() => undefined)
  }, [])
  if (settings.onboarding?.checklistDismissedAt) return null
  const items = [
    { done: settings.claudeAccounts.some((a) => a.loggedIn), text: 'Sign in to an agent', go: () => openSettings({ scope: 'app', page: 'accounts' }) },
    { done: spaces.length > 0, text: 'Create a space', go: () => openSettings({ scope: 'app', page: 'spaces' }) },
    { done: repos.length > 0, text: 'Add repositories to it', go: () => (spaces[0] ? openSettings({ scope: 'space', spaceId: spaces[0].id, page: 'repos' }) : openSettings({ scope: 'app', page: 'repos' })) },
    { done: workspaces.length > 0, text: 'Create a workspace', go: () => setShowNewWorkspace(true) },
    { done: workspaces.some((w) => w.sessionId || Object.keys(w).some((k) => k.startsWith('acp:'))), text: 'Send a first message', go: () => workspaces[0] && useApp.getState().select(workspaces[0].id) },
    { done: reviewed, text: 'Run an AI review on a pull request', go: () => setView('reviews') }
  ]
  const left = items.filter((i) => !i.done).length
  if (left === 0) return null
  const dismiss = (): void => {
    void api.invoke('settings:update', { onboarding: { ...(settings.onboarding ?? {}), checklistDismissedAt: new Date().toISOString() } }).catch(() => undefined)
  }
  return (
    <div className="no-drag mt-6 w-[360px] rounded-xl border border-border bg-panel/60 p-4 text-left">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-muted">Getting started</span>
        <span className="text-[11px] text-muted">
          {items.length - left} of {items.length}
        </span>
        <button className="ml-auto text-muted hover:text-text" onClick={dismiss} title="Hide this checklist">
          <X size={13} />
        </button>
      </div>
      <div className="mt-2 flex flex-col">
        {items.map((it) => (
          <button key={it.text} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-panel-2" onClick={() => !it.done && it.go()}>
            {it.done ? <CheckCircle2 size={15} className="shrink-0 text-ok" /> : <Circle size={15} className="shrink-0 text-muted" />}
            <span className={it.done ? 'text-muted line-through' : ''}>{it.text}</span>
          </button>
        ))}
      </div>
      <button className="mt-2 text-[12px] text-accent hover:underline" onClick={() => setOnboarding('tour')}>
        Take the tour
      </button>
    </div>
  )
}
