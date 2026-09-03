import React, { useEffect } from 'react'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useScripts } from '@/stores/scripts'
import { Sidebar } from './components/Sidebar'
import { WorkspaceView } from './components/WorkspaceView'
import { NewWorkspaceDialog } from './components/NewWorkspaceDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { PermissionPrompt } from './components/PermissionPrompt'
import { BranchRenamePrompt } from './components/BranchRenamePrompt'
import { Button } from './components/ui'

export default function App(): React.JSX.Element {
  const { loaded, load, selectedId, showNewWorkspace, showSettings, setShowNewWorkspace, setShowSettings, error, setError } = useApp()
  const subscribeChat = useChat((s) => s.subscribe)
  const subscribeScripts = useScripts((s) => s.subscribe)

  useEffect(() => {
    void load()
    subscribeChat()
    subscribeScripts()
  }, [load, subscribeChat, subscribeScripts])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setShowNewWorkspace(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setShowNewWorkspace, setShowSettings])

  if (!loaded) return <div className="flex h-full items-center justify-center text-muted">Loading…</div>

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {selectedId ? <WorkspaceView key={selectedId} workspaceId={selectedId} /> : <EmptyState />}
      </main>
      {showNewWorkspace && <NewWorkspaceDialog onClose={() => setShowNewWorkspace(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
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
  const { repos, setShowNewWorkspace, setShowSettings } = useApp()
  return (
    <div className="drag flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="text-[18px] font-semibold">Orchestra</div>
      <p className="max-w-md text-muted">
        One workspace, many repositories. Each workspace creates a worktree on the same branch in every repo you pick, so a full-stack feature lives in one place.
      </p>
      <div className="flex gap-2">
        {repos.length === 0 ? (
          <Button variant="primary" onClick={() => setShowSettings(true)}>
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
