import React, { useEffect, useState } from 'react'
import { useApp, spaceOrder } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useScripts } from '@/stores/scripts'
import { Sidebar } from './components/Sidebar'
import { WorkspaceView } from './components/WorkspaceView'
import { OnCallView } from './components/OnCallView'
import { AgentsView } from './components/agents/AgentsView'
import { NotesView } from './components/NotesView'
import { AuthLinkDialog } from './components/AuthLinkDialog'
import type { AuthLink } from '@shared/types'
import { useOnCall } from './stores/oncall'
import { useReviews } from './stores/reviews'
import { NewWorkspaceDialog } from './components/NewWorkspaceDialog'
import { NewTaskDialog } from './components/NewTaskDialog'
import { useGuided } from '@/lib/guided'
import { yieldsToEditor } from '@/lib/keys'
import { SettingsWindow } from './components/SettingsWindow'
import { PermissionPrompt } from './components/PermissionPrompt'
import { BranchRenamePrompt } from './components/BranchRenamePrompt'
import { ReviewCockpit } from './components/ReviewCockpit'
import { FeedbackDialog } from './components/FeedbackDialog'
import { MaestroSide } from './components/maestro/MaestroSide'
import { Rail } from './components/Rail'
import { ReviewSwitch } from './components/ReviewSwitch'
import { MaestroHome } from './components/maestro/MaestroHome'
import { findView } from '@/lib/views'
import { useMaestro, openMaestro, toggleMaestroDock } from './stores/maestro'
import { SetupWizard } from './components/onboarding/SetupWizard'
import { Tour } from './components/onboarding/Tour'
import { GettingStarted } from './components/onboarding/GettingStarted'
import { api } from '@/lib/api'
import logo from './assets/logo.svg'
import { Button, hasOpenDialog } from './components/ui'
import { CommandPalette, ShortcutSheet } from './components/CommandPalette'

export default function App(): React.JSX.Element {
  const { loaded, load, selectedId, view, showNewWorkspace, settingsTarget, closeSettings, setShowNewWorkspace, setShowSettings, error, setError, stepSpace, setActiveSpace, feedbackDialog, setFeedbackDialog, onboarding, setOnboarding, assistantOpen, setAssistantOpen, openSettings } = useApp()
  const subscribeChat = useChat((s) => s.subscribe)
  const subscribeScripts = useScripts((s) => s.subscribe)

  useEffect(() => {
    void load()
    subscribeChat()
    subscribeScripts()
  }, [load, subscribeChat, subscribeScripts])

  const [authLink, setAuthLink] = useState<AuthLink | null>(null)
  /** ⌘K palette and ⌘/ shortcut sheet; each toggles, and neither opens over another dialog. */
  const [overlay, setOverlay] = useState<null | 'palette' | 'shortcuts'>(null)
  const overlayRef = React.useRef(overlay)
  overlayRef.current = overlay
  useEffect(() => api.on('ui:authLink', setAuthLink), [])
  useEffect(
    () =>
      api.on('cloud:invite', ({ token, kind }) => {
        useApp.getState().setPendingInvite({ token, kind })
        useApp.getState().openSettings({ scope: 'app', page: 'plan' })
      }),
    []
  )
  useEffect(() => api.on('ui:authDone', (d) => setAuthLink((cur) => (cur && cur.provider === d.provider ? null : cur))), [])
  useEffect(() => api.on('ui:openFeedback', ({ tab }) => setFeedbackDialog(tab)), [setFeedbackDialog])
  useEffect(() => api.on('ui:openSettings', (t) => openSettings(t as Parameters<typeof openSettings>[0])), [openSettings])
  useEffect(() => api.on('ui:openOnboarding', ({ kind }) => setOnboarding(kind)), [setOnboarding])
  useEffect(() => api.on('ui:openWorkspace', ({ workspaceId }) => useApp.getState().select(workspaceId)), [])
  useEffect(
    () =>
      api.on('ui:openMaestro', () => void toggleMaestroDock()),
    []
  )
  useEffect(
    () =>
      api.on('ui:openView', ({ viewId, workspaceId }) => {
        const app = useApp.getState()
        const v = findView(viewId, app.settings, app.spaces)
        if (!v) return
        if (v.slot === 'home') {
          if (v.scope.kind === 'space' && app.activeSpaceId !== v.scope.spaceId) app.setActiveSpace(v.scope.spaceId)
          app.setHomeViewId(v.id)
          app.setView('home')
          return
        }
        const target = workspaceId ?? app.selectedId
        if (!target) return
        app.select(target)
        app.setTab(`view:${v.id}`)
      }),
    []
  )
  useEffect(() => api.on('ui:newWorkspace', () => useApp.getState().setShowNewWorkspace(true, useApp.getState().activeSpaceId || undefined)), [])
  useEffect(
    () =>
      api.on('ui:openAgent', ({ agentId }) => {
        useApp.getState().setOpenAgentId(agentId)
        useApp.getState().setView('agents')
      }),
    []
  )
  useEffect(
    () =>
      api.on('ui:openReview', ({ key }) => {
        useApp.getState().setView('reviews')
        useReviews.getState().select(key)
      }),
    []
  )
  useEffect(
    () =>
      api.on('ui:openOnCall', ({ incidentId }) => {
        useApp.getState().setView('oncall')
        if (incidentId) useOnCall.getState().select(incidentId)
      }),
    []
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === 'k' || e.key === '/')) {
        // Editors keep their own ⌘K / ⌘/, and the setup wizard sits above the palette.
        if (yieldsToEditor(e) || useApp.getState().onboarding) return
        const want = e.key === '/' ? 'shortcuts' : 'palette'
        if (overlayRef.current === want) {
          e.preventDefault()
          setOverlay(null)
        } else if (!hasOpenDialog() || overlayRef.current) {
          e.preventDefault()
          setOverlay(want)
        }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFeedbackDialog('feedback')
      }
      // ⌘J (and the older ⇧⌘A): the Maestro dock on this screen, in both modes. Editors keep their own ⌘J.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && ((!e.shiftKey && e.key.toLowerCase() === 'j') || (e.shiftKey && e.key.toLowerCase() === 'a'))) {
        if (yieldsToEditor(e)) return
        e.preventDefault()
        void toggleMaestroDock()
      }
      if ((e.metaKey || e.ctrlKey) && ((e.shiftKey && e.key.toLowerCase() === 'n') || (!e.shiftKey && !e.altKey && e.key.toLowerCase() === 't'))) {
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
  }, [setShowNewWorkspace, setShowSettings, stepSpace, setActiveSpace, setFeedbackDialog, setAssistantOpen])

  const guided = useGuided()
  const dockOpen = useMaestro((s) => s.open)
  const dockWidth = useMaestro((s) => s.width)
  useEffect(() => {
    if (!assistantOpen) return
    setAssistantOpen(false)
    // The setup wizard's hand-off seeds a fresh conversation; everything else resumes the last one.
    const seed = useApp.getState().maestroSeed
    if (seed) {
      useApp.getState().setMaestroSeed(null)
      void openMaestro({ fresh: true, prompt: seed })
    } else void openMaestro()
  }, [assistantOpen, setAssistantOpen])

  if (!loaded) return <div className="flex h-full items-center justify-center text-muted">Loading…</div>

  return (
    // The Maestro dock is a column, not an overlay: the screen makes room for it instead of hiding under it.
    <div className="flex h-full" style={{ paddingRight: dockOpen && view !== 'maestro' ? dockWidth : 0 }}>
      <Rail />
      {(view === 'workspace' || view === 'agents') && <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col">
        {view === 'reviews' || view === 'oncall' ? <ReviewSwitch /> : null}
        {view === 'reviews' ? <ReviewCockpit /> : view === 'oncall' ? <OnCallView /> : view === 'agents' ? <AgentsView /> : view === 'notes' ? <NotesView /> : view === 'maestro' ? <MaestroHome tab="maestro" /> : view === 'home' ? <MaestroHome tab="pages" /> : selectedId ? <WorkspaceView key={selectedId} workspaceId={selectedId} /> : <EmptyState />}
      </main>
      {showNewWorkspace && (guided ? <NewTaskDialog onClose={() => setShowNewWorkspace(false)} /> : <NewWorkspaceDialog onClose={() => setShowNewWorkspace(false)} />)}
      {settingsTarget && <SettingsWindow target={settingsTarget} onClose={closeSettings} />}
      {feedbackDialog && <FeedbackDialog tab={feedbackDialog} onClose={() => setFeedbackDialog(null)} />}
      <MaestroSide />
      <PermissionPrompt />
      <BranchRenamePrompt />
      {onboarding === 'setup' && <SetupWizard onClose={() => setOnboarding(null)} />}
      {authLink && <AuthLinkDialog link={authLink} onClose={() => setAuthLink(null)} />}
      {onboarding === 'tour' && <Tour onClose={() => setOnboarding(null)} />}
      {error && (
        <div role="alert" className="fixed bottom-4 left-1/2 z-[80] flex max-w-[640px] -translate-x-1/2 items-center gap-3 rounded-lg border border-danger/40 bg-panel px-4 py-2 text-[12px] shadow-xl">
          <span className="text-danger">{error}</span>
          <Button size="sm" variant="ghost" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}
      <NoticeToast />
      {overlay === 'palette' && <CommandPalette onClose={() => setOverlay(null)} onShortcuts={() => setOverlay('shortcuts')} />}
      {overlay === 'shortcuts' && <ShortcutSheet onClose={() => setOverlay(null)} />}
    </div>
  )
}

/** Success and undo toasts. Undo runs the callback; every notice closes itself after six seconds. */
function NoticeToast(): React.JSX.Element | null {
  const notice = useApp((s) => s.notice)
  const notify = useApp((s) => s.notify)
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => notify(null), 6000)
    return () => clearTimeout(t)
  }, [notice, notify])
  if (!notice) return null
  return (
    <div role="status" className="fixed bottom-4 left-1/2 z-[80] flex max-w-[640px] -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-panel px-4 py-2 text-[12px] shadow-xl">
      <span className={notice.kind === 'success' ? 'text-ok' : 'text-text'}>{notice.text}</span>
      {notice.link && (
        <Button size="sm" onClick={() => void window.sinfonie.invoke('shell:openExternal', notice.link!.url)}>
          {notice.link.label}
        </Button>
      )}
      {notice.undo && (
        <Button
          size="sm"
          onClick={() => {
            notice.undo?.()
            notify(null)
          }}
        >
          Undo
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => notify(null)}>
        Dismiss
      </Button>
    </div>
  )
}

function EmptyState(): React.JSX.Element {
  const { repos, setShowNewWorkspace, openSettings, openSetupAt } = useApp()
  const hasTeam = useApp((s) => Boolean(s.settings.cloud?.account?.orgs?.length))
  const guided = useGuided()
  if (guided) {
    return (
      <div className="drag flex h-full flex-col items-center justify-center gap-3 text-center">
        <img src={logo} alt="" className="h-16 w-16 rounded-2xl shadow-[0_20px_60px_rgba(91,124,255,.25)]" />
        <div className="text-[18px] font-semibold">Sinfonie</div>
        <p className="max-w-md text-muted">A task is one thing you want built or changed in your app. Start one and describe it in plain words.</p>
        <p className="text-[11px] text-muted">
          <kbd className="rounded border border-border px-1">⌘K</kbd> finds any task or action
        </p>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setShowNewWorkspace(true)}>
            Start a task <kbd className="ml-1 rounded bg-black/30 px-1 text-[11px]">⇧⌘N</kbd>
          </Button>
          {repos.length === 0 ? <Button onClick={() => openSetupAt(2)}>Add your app</Button> : !hasTeam && <Button onClick={() => openSettings({ scope: 'app', page: 'plan' })}>Join your team</Button>}
        </div>
        <GettingStarted />
      </div>
    )
  }
  return (
    <div className="drag flex h-full flex-col items-center justify-center gap-3 text-center">
      <img src={logo} alt="" className="h-16 w-16 rounded-2xl shadow-[0_20px_60px_rgba(91,124,255,.25)]" />
      <div className="text-[18px] font-semibold">Sinfonie</div>
      <p className="max-w-md text-muted">
        One workspace, many repositories. Each workspace creates a worktree on the same branch in every repo you pick, so a full-stack feature lives in one place.
      </p>
      <p className="text-[11px] text-muted">
        <kbd className="rounded border border-border px-1">⌘K</kbd> commands · <kbd className="rounded border border-border px-1">⌘/</kbd> shortcuts
      </p>
      <div className="flex gap-2">
        {repos.length === 0 ? (
          <Button variant="primary" onClick={() => openSettings({ scope: 'app', page: 'repos' })}>
            Add your first repository
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setShowNewWorkspace(true)}>
            New workspace <kbd className="ml-1 rounded bg-black/30 px-1 text-[11px]">⇧⌘N</kbd>
          </Button>
        )}
      </div>
      <GettingStarted />
    </div>
  )
}


