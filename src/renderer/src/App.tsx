import React, { useEffect } from 'react'
import { useApp, spaceOrder } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useScripts } from '@/stores/scripts'
import { Sidebar } from './components/Sidebar'
import { WorkspaceView } from './components/WorkspaceView'
import { NewWorkspaceDialog } from './components/NewWorkspaceDialog'
import { SettingsWindow } from './components/SettingsWindow'
import { PermissionPrompt } from './components/PermissionPrompt'
import { BranchRenamePrompt } from './components/BranchRenamePrompt'
import { ReviewCockpit } from './components/ReviewCockpit'
import { FeedbackDialog } from './components/FeedbackDialog'
import { api } from '@/lib/api'
import logo from './assets/logo.svg'
import { Button } from './components/ui'

export default function App(): React.JSX.Element {
  const { loaded, load, selectedId, view, showNewWorkspace, settingsTarget, closeSettings, setShowNewWorkspace, setShowSettings, error, setError, stepSpace, setActiveSpace, feedbackDialog, setFeedbackDialog } = useApp()
  const subscribeChat = useChat((s) => s.subscribe)
  const subscribeScripts = useScripts((s) => s.subscribe)

  useEffect(() => {
    void load()
    subscribeChat()
    subscribeScripts()
  }, [load, subscribeChat, subscribeScripts])

  useEffect(() => api.on('ui:openFeedback', ({ tab }) => setFeedbackDialog(tab)), [setFeedbackDialog])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFeedbackDialog('feedback')
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setShowNewWorkspace(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
      }
      // Space switching, Arc style: ⌘⌥← / ⌘⌥→ step, ⌃1…9 jump.
      if (e.metaKey && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        stepSpace(e.key === 'ArrowRight' ? 1 : -1)
      }
      if (e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
        const { spaces, workspaces } = useApp.getState()
        const ids = spaceOrder(spaces.map((s) => s.id), workspaces.some((w) => w.status !== 'archived' && !w.spaceId))
        const target = ids[Number(e.key) - 1]
        if (target !== undefined) {
          e.preventDefault()
          setActiveSpace(target)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setShowNewWorkspace, setShowSettings, stepSpace, setActiveSpace, setFeedbackDialog])

  if (!loaded) return <div className="flex h-full items-center justify-center text-muted">Loading…</div>

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {view === 'reviews' ? <ReviewCockpit /> : selectedId ? <WorkspaceView key={selectedId} workspaceId={selectedId} /> : <EmptyState />}
      </main>
      {showNewWorkspace && <NewWorkspaceDialog onClose={() => setShowNewWorkspace(false)} />}
      {settingsTarget && <SettingsWindow target={settingsTarget} onClose={closeSettings} />}
      {feedbackDialog && <FeedbackDialog tab={feedbackDialog} onClose={() => setFeedbackDialog(null)} />}
      <PermissionPrompt />
      <BranchRenamePrompt />
      {error && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-danger/40 bg-panel px-4 py-2 text-[12px] shadow-xl">
          <span className="text-danger">{error}</span>
          <Button size="sm" variant="ghost" className="ml-3" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  )
}

function EmptyState(): React.JSX.Element {
  const { repos, setShowNewWorkspace, openSettings } = useApp()
  return (
    <div className="drag flex h-full flex-col items-center justify-center gap-3 text-center">
      <img src={logo} alt="" className="h-16 w-16 rounded-2xl shadow-[0_20px_60px_rgba(91,124,255,.25)]" />
      <div className="text-[18px] font-semibold">Sinfonie</div>
      <p className="max-w-md text-muted">
        One workspace, many repositories. Each workspace creates a worktree on the same branch in every repo you pick, so a full-stack feature lives in one place.
      </p>
      <div className="flex gap-2">
        {repos.length === 0 ? (
          <Button variant="primary" onClick={() => openSettings({ scope: 'app', page: 'repos' })}>
            Add your first repository
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setShowNewWorkspace(true)}>
            New workspace <kbd className="ml-1 rounded bg-black/30 px-1 text-[10px]">⇧⌘N</kbd>
          </Button>
        )}
      </div>
    </div>
  )
}
