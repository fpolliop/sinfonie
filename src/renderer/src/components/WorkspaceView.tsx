import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ViewHost } from './views/ViewHost'
import { ViewHeader } from './views/HomeView'
import { findView } from '@/lib/views'
import { renameWorkspace } from '@/lib/rename'
import { friendlyError } from '@/lib/errors'
import { removeWithUndo } from '@/lib/undo'
import { repoLabel, workspaceLabel } from '@/lib/labels'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { InlineRename } from './InlineRename'
import { StagePicker } from './StagePicker'
import { SpacePicker } from './SpacePicker'
import { LabelPicker } from './LabelPicker'
import type { RepoSafety, Workspace } from '@shared/types'
import { ManageReposDialog } from './ManageReposDialog'
import clsx from 'clsx'
import { Folder, Code2, TerminalSquare, Archive, Trash2, MoreHorizontal, Pencil, GitBranch, ExternalLink, RefreshCw, AlertTriangle, SearchX, Play, Square, GitPullRequest, Layers, Sparkles, Globe } from 'lucide-react'
import { useGithub } from '@/stores/github'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useScripts } from '@/stores/scripts'
import { toggleMaestroDock } from '@/stores/maestro'
import { api } from '@/lib/api'
import { ChatPane } from './ChatPane'
import { PrDialog } from './ChangesPane'
import { Button, Dialog, Field, IconButton, chipCls, inputCls } from './ui'
import { shortPath } from '@/lib/format'
import { WorkspaceInspector } from './WorkspaceInspector'
import { useGuided, previewUrlFor } from '@/lib/guided'
import { SendForReviewButton, ReviewStatusLine } from './SendForReview'

/**
 * The workspace split view: one header (name, live status, branch, repositories, ticket; Ask Maestro, Run, pull
 * requests and the overflow menu), the conversation on the left and the inspector (Changes, Preview, Checks,
 * Terminal, Data) on the right.
 */
export function WorkspaceView({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const { setTab, setError } = useApp()
  const allRepos = useApp((s) => s.repos)
  const space = useApp((s) => s.spaces.find((sp) => sp.id === ws?.spaceId))
  const guided = useGuided()
  // An agent started a burst of browsing: bring the preview forward so the user sees it happen.
  useEffect(
    () =>
      api.on('browser:agentActive', ({ workspaceId: id }) => {
        if (id !== workspaceId) return
        const st = useApp.getState()
        if (st.tab !== 'browser' || !st.inspectorOpen) setTab('browser')
      }),
    [workspaceId, setTab]
  )
  // Opening (or refocusing on) a workspace here means you've seen it — clear its phone notifications.
  useEffect(() => {
    const seen = (): void => void api.invoke('remote:seen', workspaceId).catch(() => undefined)
    seen()
    window.addEventListener('focus', seen)
    return () => window.removeEventListener('focus', seen)
  }, [workspaceId])
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // Clicking ⋯ while the menu is open: the menu's outside-click closes it first; don't reopen it on the same click.
  const menuClosedAt = useRef(0)
  const [archiveDlg, setArchiveDlg] = useState<null | 'archive' | 'delete'>(null)
  const [moveDlg, setMoveDlg] = useState(false)
  const [reposDlg, setReposDlg] = useState(false)
  const [renameDlg, setRenameDlg] = useState<null | 'branch'>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const prs = useGithub((s) => s.byWorkspace[workspaceId]?.repos)
  const prsFetchedAt = useGithub((s) => s.byWorkspace[workspaceId]?.fetchedAt)
  useEffect(() => {
    // The sidebar's context menu asks the open workspace view to show its archive dialog.
    const onArchive = (e: Event): void => {
      const d = (e as CustomEvent<{ id: string; mode: 'archive' | 'delete' }>).detail
      if (d.id === workspaceId) setArchiveDlg(d.mode)
    }
    const onMove = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === workspaceId) setMoveDlg(true)
    }
    window.addEventListener('sinfonie:archive', onArchive)
    window.addEventListener('sinfonie:moveSpace', onMove)
    return () => {
      window.removeEventListener('sinfonie:archive', onArchive)
      window.removeEventListener('sinfonie:moveSpace', onMove)
    }
  }, [workspaceId])
  const jiraKey = ws?.jira?.key
  const jiraStatusAt = ws?.jiraStatusAt
  const linearKey = ws?.linear?.identifier
  const linearStatusAt = ws?.linearStatusAt
  useEffect(() => {
    if (!linearKey) return
    if (linearStatusAt && Date.now() - new Date(linearStatusAt).getTime() < 5 * 60 * 1000) return
    api.invoke('workspaces:refreshLinear', workspaceId).catch(() => undefined)
  }, [workspaceId, linearKey, linearStatusAt])
  useEffect(() => {
    // Refresh the ticket status when the workspace opens, unless it was checked in the last five minutes.
    if (!jiraKey) return
    if (jiraStatusAt && Date.now() - new Date(jiraStatusAt).getTime() < 5 * 60 * 1000) return
    api.invoke('workspaces:refreshJira', workspaceId).catch(() => undefined)
  }, [workspaceId, jiraKey, jiraStatusAt])
  // The header's pull request button and repository dots read GitHub; refresh it when older than five minutes.
  const hasRepos = Boolean(ws?.repos.length)
  const isReady = ws?.status === 'ready'
  useEffect(() => {
    if (guided || !isReady || !hasRepos) return
    if (prsFetchedAt && Date.now() - new Date(prsFetchedAt).getTime() < 5 * 60 * 1000) return
    void useGithub.getState().refresh(workspaceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, guided, isReady, hasRepos])
  if (!ws) return <MissingWorkspace guided={guided} />

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(friendlyError(err))
    }
  }
  const title = workspaceLabel(ws, guided)
  /** Archived rows leave the list at once; the delete itself waits for the Undo window. */
  const removeFromList = (): void => {
    const id = ws.id
    removeWithUndo(id, `Removed “${title}” from the list.`, () => api.invoke('workspaces:delete', id))
  }
  const finishing: MenuEntry[] =
    ws.status !== 'archived'
      ? [
          { label: guided ? 'Finish task…' : 'Archive workspace…', icon: <Archive size={14} />, onClick: () => setArchiveDlg('archive') },
          { label: guided ? 'Delete task…' : 'Delete workspace…', icon: <Trash2 size={14} />, danger: true, onClick: () => setArchiveDlg('delete') }
        ]
      : [{ label: 'Remove from list', icon: <Trash2 size={14} />, danger: true, onClick: removeFromList }]
  const tickets: MenuEntry[] = [
    ...(ws.jira ? [{ label: `Refresh ${ws.jira.key} status`, icon: <RefreshCw size={14} />, onClick: () => void run(() => api.invoke('workspaces:refreshJira', ws.id)) }] : []),
    ...(ws.linear ? [{ label: `Refresh ${ws.linear.identifier} state`, icon: <RefreshCw size={14} />, onClick: () => void run(() => api.invoke('workspaces:refreshLinear', ws.id)) }] : [])
  ]
  const menuEntries: MenuEntry[] = guided
    ? [{ label: 'Rename task…', icon: <Pencil size={14} />, onClick: () => setEditingTitle(true) }, ...(tickets.length ? [{ separator: true }, ...tickets] : []), { separator: true }, ...finishing]
    : [
        { label: 'Reveal in Finder', icon: <Folder size={14} />, onClick: () => void run(() => api.invoke('workspaces:openIn', ws.id, 'finder')) },
        { label: 'Open in VS Code', icon: <Code2 size={14} />, onClick: () => void run(() => api.invoke('workspaces:openIn', ws.id, 'vscode')) },
        { label: 'Open in Cursor', icon: <Code2 size={14} />, onClick: () => void run(() => api.invoke('workspaces:openIn', ws.id, 'cursor')) },
        { label: 'Open in Terminal', icon: <TerminalSquare size={14} />, onClick: () => void run(() => api.invoke('workspaces:openIn', ws.id, 'terminal')) },
        {
          label: 'Claude Code CLI in Terminal tab',
          icon: <TerminalSquare size={14} />,
          disabled: ws.status !== 'ready',
          onClick: () => {
            useApp.getState().setPendingShell({ workspaceId: ws.id, repoId: ws.primaryRepoId, agent: 'claude-code' })
            setTab('terminal')
          }
        },
        { separator: true },
        { label: 'Manage repositories…', icon: <Folder size={14} />, disabled: ws.status !== 'ready', onClick: () => setReposDlg(true) },
        { label: 'Rename workspace…', icon: <Pencil size={14} />, onClick: () => setEditingTitle(true) },
        { label: 'Rename branch only (all repos)…', icon: <GitBranch size={14} />, disabled: ws.status !== 'ready', onClick: () => setRenameDlg('branch') },
        { label: 'Move to space…', icon: <Layers size={14} />, onClick: () => setMoveDlg(true) },
        ...(tickets.length ? [{ separator: true }, ...tickets] : []),
        { separator: true },
        ...finishing
      ]
  const branch = ws.repos[0]?.branch

  return (
    <div className="flex h-full flex-col">
      {/*
        One row that never overlaps: the header is a size container, and as it narrows the chips drop in order
        (ticket, label, repositories, branch, space) and the actions on the right fold to icons with their labels
        kept as accessible names and tooltips. Everything left of the actions can shrink and truncate.
      */}
      <header className="drag @container flex h-[48px] shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {!guided && space && (
            <span className="flex min-w-0 max-w-[140px] shrink items-center gap-2 text-[13px] text-muted @max-[700px]:hidden" title={`Space: ${space.name}`}>
              <span className="truncate">{space.name}</span>
              <span aria-hidden>/</span>
            </span>
          )}
          {editingTitle ? (
            <div className="no-drag w-72 min-w-[120px] shrink">
              <InlineRename
                value={ws.name}
                className="text-[15px] font-semibold"
                onSave={(v) => {
                  setEditingTitle(false)
                  void renameWorkspace(ws, v)
                }}
                onCancel={() => setEditingTitle(false)}
              />
            </div>
          ) : (
            <h1 className="no-drag min-w-[64px] max-w-[280px] shrink cursor-text truncate text-[15px] font-semibold leading-none" title={`${title} · double-click to rename`} onDoubleClick={() => setEditingTitle(true)}>
              {title}
            </h1>
          )}
          <LiveStatus ws={ws} guided={guided} />
          <StagePicker stage={ws.stage} disabled={ws.status === 'archived'} onChange={(stage) => run(() => api.invoke('workspaces:setStage', ws.id, stage))} />
          {!guided && (
            <span className="contents @max-[1040px]:hidden">
              <LabelPicker ws={ws} />
            </span>
          )}
          <div data-tour="repos" className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden @max-[780px]:hidden">
            {!guided && (
              <span className={clsx(chipCls, 'min-w-[48px] shrink border border-border bg-panel font-mono text-muted')} title={branch ? `Branch in every repository: ${branch}` : 'No repositories yet'}>
                <GitBranch size={11} className="shrink-0" aria-hidden />
                <span className="truncate">{branch ?? `${ws.slug} · no repositories yet`}</span>
              </span>
            )}
            {ws.repos.map((r) => {
              const repoPr = prs?.find((p) => p.repoId === r.repoId)
              const pr = repoPr?.pr
              const open = repoPr?.threads.filter((t) => !t.isResolved).length ?? 0
              const dot = pr && <span aria-hidden className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', pr.state === 'MERGED' ? 'bg-accent' : pr.state === 'CLOSED' ? 'bg-danger' : pr.reviewDecision === 'CHANGES_REQUESTED' || open > 0 ? 'bg-warn' : 'bg-ok')} />
              if (guided) {
                const appName = repoLabel(allRepos.find((x) => x.id === r.repoId) ?? { name: r.repoName })
                return (
                  <span key={r.repoId} className={clsx(chipCls, 'min-w-0 shrink border border-border bg-panel text-muted @max-[900px]:hidden')} title={pr ? pr.title : appName}>
                    <span className="truncate">{appName}</span>
                    {dot}
                  </span>
                )
              }
              return (
                <button
                  key={r.repoId}
                  title={pr ? `${pr.title} (#${pr.number}): open Checks` : `${shortPath(r.worktreePath)}: open Checks`}
                  onClick={() => setTab('prs')}
                  className={clsx(chipCls, 'no-drag min-w-0 shrink border bg-panel @max-[900px]:hidden', r.repoId === ws.primaryRepoId ? 'border-accent/40 text-accent' : 'border-border text-muted hover:text-text')}
                >
                  <span className="truncate">{r.repoName}</span>
                  {dot}
                  {open > 0 && <span className="text-warn">{open}</span>}
                </button>
              )
            })}
            {ws.jira && <TicketChip id={ws.jira.key} title={ws.jira.summary} url={ws.jira.url} status={ws.jiraStatus} checkedAt={ws.jiraStatusAt} kind="Jira status" />}
            {ws.linear && <TicketChip id={ws.linear.identifier} title={ws.linear.title} url={ws.linear.url} status={ws.linearStatus} checkedAt={ws.linearStatusAt} kind="Linear state" />}
          </div>
          {guided && (
            <span className="min-w-0 shrink @max-[900px]:hidden">
              <ReviewStatusLine workspaceId={ws.id} />
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className="no-drag inline-flex min-h-6 min-w-6 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-medium text-maestro transition-colors hover:bg-maestro/10"
            onClick={() => void toggleMaestroDock()}
            aria-label="Ask Maestro"
            title={guided ? 'Ask Maestro about this task (⌘J)' : 'Ask Maestro about this workspace (⌘J)'}
            aria-keyshortcuts="Meta+J"
          >
            <Sparkles size={13} aria-hidden className="hidden @max-[860px]:block" />
            <span className="@max-[860px]:hidden">Ask Maestro</span> <kbd className="font-sans text-[11px] opacity-70 @max-[860px]:hidden">⌘J</kbd>
          </button>
          {!guided && <RunButton ws={ws} />}
          {!guided && <PrButton ws={ws} />}
          {guided && <SendForReviewButton ws={ws} />}
          <div className="no-drag relative">
            <IconButton
              label="More actions"
              aria-haspopup="menu"
              aria-expanded={menu !== null}
              className="p-1.5"
              onClick={(e) => {
                if (menu || Date.now() - menuClosedAt.current < 250) return setMenu(null)
                const r = e.currentTarget.getBoundingClientRect()
                setMenu({ x: r.right - 224, y: r.bottom + 4 })
              }}
            >
              <MoreHorizontal size={16} />
            </IconButton>
            {menu && <ContextMenu x={menu.x} y={menu.y} label={guided ? 'Task actions' : 'Workspace actions'} entries={menuEntries} onClose={() => ((menuClosedAt.current = Date.now()), setMenu(null))} />}
          </div>
        </div>
      </header>

      {ws.status === 'error' && (
        <div role="alert" className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-[12px] text-danger">
          {guided ? friendlyError(ws.error ?? '', 'This task could not be set up. Try starting it again, or ask a teammate.', true) : ws.error}
        </div>
      )}
      <HealthBanner workspaceId={ws.id} />

      <div className="relative flex min-h-0 flex-1">
        <section aria-label={guided ? 'Conversation with Maestro' : 'Conversation'} className="@container h-full min-w-[360px] flex-1">
          <ChatPane workspaceId={ws.id} />
        </section>
        <WorkspaceInspector workspaceId={ws.id} renderView={(viewId) => <WorkspaceViewTab workspaceId={ws.id} viewId={viewId} />} />
      </div>

      {archiveDlg && <ArchiveDialog workspaceId={ws.id} name={title} mode={archiveDlg} guided={guided} onClose={() => setArchiveDlg(null)} />}
      {reposDlg && <ManageReposDialog workspaceId={ws.id} onClose={() => setReposDlg(false)} />}
      {moveDlg && (
        <Dialog title="Move to space" onClose={() => setMoveDlg(false)} width={380}>
          <SpacePicker
            value={ws.spaceId ?? ''}
            onChange={(id) => {
              run(() => api.invoke('workspaces:setSpace', ws.id, id || null))
              setMoveDlg(false)
            }}
          />
        </Dialog>
      )}
      {renameDlg && <BranchDialog initial={ws.repos[0]?.branch ?? ''} onClose={() => setRenameDlg(null)} onSubmit={(v) => run(() => api.invoke('workspaces:renameBranch', ws.id, v))} />}
    </div>
  )
}

/**
 * What the workspace is doing right now, as a word: needs you, running, failed, setting up, archived. Nothing
 * when it is simply idle; the stage next to it says where the work stands.
 */
function LiveStatus({ ws, guided }: { ws: Workspace; guided: boolean }): React.JSX.Element | null {
  const busy = useChat((s) => s.chats[ws.id]?.busy ?? false)
  const failed = useChat((s) => {
    const c = s.chats[ws.id]
    return Boolean(c && !c.busy && (c.error || c.lastResult?.isError))
  })
  const needsYou = useChat((s) => s.permissions.some((p) => p.workspaceId === ws.id) || s.questions.some((q) => q.workspaceId === ws.id))
  const state: { tone: 'attn' | 'run' | 'danger' | 'idle'; text: string } | null =
    ws.status === 'creating'
      ? { tone: 'attn', text: guided ? 'Getting ready' : 'Setting up' }
      : ws.status === 'error'
        ? { tone: 'danger', text: guided ? 'Something went wrong' : 'Setup failed' }
        : ws.status === 'archiving'
          ? { tone: 'idle', text: guided ? 'Finishing' : 'Archiving' }
          : ws.status === 'archived'
            ? { tone: 'idle', text: guided ? 'Finished' : 'Archived' }
            : needsYou
              ? { tone: 'attn', text: guided ? 'Waiting for you' : 'Needs you' }
              : busy
                ? { tone: 'run', text: guided ? 'Working' : 'Running' }
                : failed
                  ? { tone: 'danger', text: guided ? 'Hit a problem' : 'Stopped with an error' }
                  : null
  if (!state) return null
  return (
    <span
      role="status"
      title={state.text}
      className={clsx(
        chipCls,
        'min-w-[28px] shrink',
        state.tone === 'attn' && 'bg-warn/15 text-warn',
        state.tone === 'run' && 'bg-accent/15 text-accent',
        state.tone === 'danger' && 'bg-danger/15 text-danger',
        state.tone === 'idle' && 'bg-panel-2 text-muted'
      )}
    >
      <span aria-hidden className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', state.tone === 'attn' ? 'bg-warn' : state.tone === 'run' ? 'animate-pulse bg-accent' : state.tone === 'danger' ? 'bg-danger' : 'bg-muted')} />
      <span className="truncate">{state.text}</span>
    </span>
  )
}

/** The ticket this workspace is for, with its status; opens the ticket. Refreshing lives in the ⋯ menu. */
function TicketChip({ id, title, url, status, checkedAt, kind }: { id: string; title: string; url: string; status?: string; checkedAt?: string; kind: string }): React.JSX.Element {
  return (
    <button
      className={clsx(chipCls, 'no-drag min-w-0 shrink border border-border bg-panel text-text hover:bg-panel-2 @max-[1180px]:hidden')}
      title={`${title}${checkedAt ? ` · ${kind}, checked ${new Date(checkedAt).toLocaleTimeString()}` : ''}. Opens in the browser.`}
      onClick={() => void api.invoke('shell:openExternal', url)}
    >
      <span className="shrink-0">{id}</span>
      {status && <span className="truncate text-muted">· {status}</span>}
      <ExternalLink size={10} className="opacity-60" aria-hidden />
    </button>
  )
}

/**
 * Run · :port. Starts every repository's run script and shows the app in Preview; while it runs, the button
 * opens Preview and a second button stops it. With no run script anywhere it opens the scripts, which explain
 * how to add one.
 */
function RunButton({ ws }: { ws: Workspace }): React.JSX.Element {
  const runs = useScripts((s) => s.runs)
  const repos = useApp((s) => s.repos)
  const setTab = useApp((s) => s.setTab)
  const setError = useApp((s) => s.setError)
  const running = ws.repos.some((r) => runs[`${ws.id}:${r.repoId}:run`]?.running)
  const hasScript = ws.repos.some((r) => Boolean(repos.find((x) => x.id === r.repoId)?.config?.scripts?.run))
  const ready = ws.status === 'ready'
  const showPreview = async (): Promise<void> => {
    const st = await api.invoke('browser:state', ws.id).catch(() => null)
    if (!st?.tabs.length) await api.invoke('browser:open', ws.id, previewUrlFor(ws))
    setTab('browser')
  }
  const start = async (): Promise<void> => {
    try {
      if (!hasScript) {
        setTab('run')
        return
      }
      await api.invoke('workspaces:runScript', ws.id, 'run')
      setTab('browser')
      // Give the server a moment to bind before the first load; Preview has a reload button.
      window.setTimeout(() => void showPreview().catch(() => undefined), 1500)
    } catch (err) {
      setError(friendlyError(err))
    }
  }
  if (running) {
    return (
      <span className="inline-flex items-center">
        <Button size="sm" variant="ghost" className="rounded-r-none" onClick={() => void showPreview().catch((e) => setError(friendlyError(e)))} aria-label={`Running on port ${ws.port}: show it in Preview`} title={`Running on port ${ws.port}. Show it in Preview.`}>
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ok" />
          <Globe size={12} aria-hidden className="hidden @max-[860px]:block" />
          <span className="@max-[860px]:hidden">Running · :{ws.port}</span>
        </Button>
        <IconButton label="Stop the run scripts" className="h-[26px] rounded-l-none hover:text-danger" onClick={() => void api.invoke('workspaces:stopScript', ws.id, 'run').catch((e) => setError(friendlyError(e)))}>
          <Square size={11} />
        </IconButton>
      </span>
    )
  }
  return (
    <Button size="sm" variant="ghost" disabled={!ready} onClick={() => void start()} aria-label={`Run on port ${ws.port}`} title={hasScript ? `Run: start the run script of every repository on port ${ws.port} and open Preview` : 'Run: no run script yet, see how to add one'}>
      <Play size={12} aria-hidden /> <span className="@max-[860px]:hidden">Run · :{ws.port}</span>
    </Button>
  )
}

/**
 * Open PRs, or the pull requests' state once they exist. One repository opens the pull request dialog right
 * away; several go to Checks, where each repository has its own.
 */
function PrButton({ ws }: { ws: Workspace }): React.JSX.Element | null {
  const prs = useGithub((s) => s.byWorkspace[ws.id]?.repos)
  const refresh = useGithub((s) => s.refresh)
  const setTab = useApp((s) => s.setTab)
  const notify = useApp((s) => s.notify)
  const [dlg, setDlg] = useState(false)
  const fetched = useGithub((s) => Boolean(s.byWorkspace[ws.id]?.fetchedAt))
  const withPr = useMemo(() => (prs ?? []).filter((p) => p.pr), [prs])
  if (ws.repos.length === 0) return null
  // Until GitHub has answered (or when it could not), don't guess: the button just leads to Checks.
  if (!fetched || (prs ?? []).some((p) => p.error)) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setTab('prs')} aria-label="Pull requests" title="Pull requests, checks and review comments">
        <GitPullRequest size={12} aria-hidden /> <span className="@max-[860px]:hidden">Pull requests</span>
      </Button>
    )
  }
  const missing = ws.repos.filter((r) => !withPr.some((p) => p.repoId === r.repoId))
  if (withPr.length === 0 || missing.length > 0) {
    const n = missing.length
    const label = withPr.length ? `Open ${n} more PR${n === 1 ? '' : 's'}` : n === 1 ? 'Open PR' : `Open ${n} PRs`
    return (
      <>
        <Button
          size="sm"
          disabled={ws.status !== 'ready'}
          onClick={() => (n === 1 ? setDlg(true) : setTab('prs'))}
          aria-label={label}
          title={n === 1 ? `${label}: a pull request for ${missing[0].repoName}` : `${label}: one per repository, in Checks`}
        >
          <GitPullRequest size={12} aria-hidden /> <span className="@max-[860px]:hidden">{label}</span>
        </Button>
        {dlg && missing[0] && (
          <PrDialog
            onClose={() => setDlg(false)}
            defaultTitle={ws.jira ? `${ws.jira.key}: ${ws.jira.summary}` : ws.linear ? `${ws.linear.identifier}: ${ws.linear.title}` : ws.name}
            hint="The ticket link and the sibling branches of this workspace are appended automatically."
            onSubmit={async (t, b) => {
              const out = await api.invoke('git:createPr', ws.id, missing[0].repoId, t, b)
              const url = /https?:\/\/\S+/.exec(out ?? '')?.[0]
              notify({ kind: 'success', text: 'Pull request opened', link: url ? { label: 'View on GitHub', url } : undefined })
              void refresh(ws.id)
            }}
          />
        )}
      </>
    )
  }
  const open = withPr.filter((p) => p.pr!.state === 'OPEN')
  const failing = open.some((p) => p.pr!.checks.some((c) => c.status === 'failure'))
  const changes = open.some((p) => p.pr!.reviewDecision === 'CHANGES_REQUESTED' || p.threads.some((t) => !t.isResolved))
  const merged = withPr.every((p) => p.pr!.state === 'MERGED')
  const text = merged ? 'Merged' : failing ? 'Checks failing' : changes ? 'Changes requested' : open.length ? (withPr.length === 1 ? `PR #${withPr[0].pr!.number}` : `${open.length} PRs open`) : 'PRs closed'
  return (
    <Button size="sm" variant="ghost" onClick={() => setTab('prs')} aria-label={text} title={`${text}: pull requests, checks and review comments`}>
      <span aria-hidden className={clsx('h-1.5 w-1.5 rounded-full', merged ? 'bg-accent' : failing ? 'bg-danger' : changes ? 'bg-warn' : open.length ? 'bg-ok' : 'bg-muted')} />
      <GitPullRequest size={12} aria-hidden /> <span className="@max-[860px]:hidden">{text}</span>
    </Button>
  )
}

function ArchiveDialog({ workspaceId, name, mode, onClose, guided }: { workspaceId: string; name: string; mode: 'archive' | 'delete'; onClose: () => void; guided?: boolean }): React.JSX.Element {
  const [deleteBranches, setDeleteBranches] = useState(mode === 'delete')
  const [busy, setBusy] = useState(false)
  const [safety, setSafety] = useState<RepoSafety[] | null>(null)
  const [ack, setAck] = useState(false)
  const setError = useApp((s) => s.setError)
  const select = useApp((s) => s.select)

  useEffect(() => {
    api
      .invoke('workspaces:safety', workspaceId)
      .then(setSafety)
      .catch((err) => setSafety([{ repoId: '', repoName: 'check failed', uncommitted: 0, unpushed: 0, hasUpstream: false, error: err instanceof Error ? err.message : String(err) }]))
  }, [workspaceId])

  const risky = (safety ?? []).filter((r) => r.uncommitted > 0 || r.unpushed > 0 || r.error)
  const hasRisk = risky.length > 0
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      const out = await api.invoke('workspaces:archive', workspaceId, { deleteBranches, forget: mode === 'delete' })
      if (!out) select(null)
      onClose()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title={`${mode === 'delete' ? 'Delete' : guided ? 'Finish' : 'Archive'} "${name}"`} onClose={onClose} width={480}>
      <p className="mb-3 text-muted">
        {guided
          ? mode === 'delete'
            ? 'Removes this task and its conversation. Anything already sent for review stays with the team.'
            : 'Puts this task away. Its conversation stays in the Finished list, and anything already sent for review stays with the team.'
          : mode === 'delete'
            ? 'Removes every worktree and the workspace folder from disk, runs each repo\'s archive script first, and forgets the workspace and its chat.'
            : 'Removes every worktree and the workspace folder from disk and runs each repo\'s archive script first. The workspace stays in the archived list with its chat.'}
      </p>

      <div className="mb-3 rounded-lg border border-border">
        <div className="border-b border-border px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">What would be lost</div>
        {safety === null && <div className="px-3 py-2 text-[12px] text-muted">{guided ? 'Checking…' : 'Checking worktrees…'}</div>}
        {safety?.map((r) => {
          const bad = r.uncommitted > 0 || r.unpushed > 0 || r.error
          return (
            <div key={r.repoId} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
              {bad ? <AlertTriangle size={13} className="shrink-0 text-warn" /> : <span className="inline-block h-[13px] w-[13px] shrink-0 text-center text-ok">✓</span>}
              <span className="font-medium">{r.repoName}</span>
              <span className={clsx('ml-auto text-right', bad ? 'text-warn' : 'text-muted')}>
                {r.error
                  ? r.error
                  : bad
                    ? guided
                      ? 'changes not sent for review'
                      : [r.uncommitted > 0 && `${r.uncommitted} uncommitted file${r.uncommitted === 1 ? '' : 's'}`, r.unpushed > 0 && `${r.unpushed} commit${r.unpushed === 1 ? '' : 's'} not pushed${r.hasUpstream ? '' : ' (branch never pushed)'}`].filter(Boolean).join(' · ')
                    : guided
                      ? 'nothing unsent'
                      : 'clean and pushed'}
              </span>
            </div>
          )
        })}
      </div>

      {hasRisk && (
        <label className="mb-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 p-3 text-[12px]">
          <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>
            {guided ? (
              <>
                I understand the changes I have not sent for review will be <strong>permanently lost</strong>. Send them for review first if you want to keep them.
              </>
            ) : (
              <>
                I understand the changes listed above will be <strong>permanently lost</strong>. Commit and push first if you want to keep them.
              </>
            )}
          </span>
        </label>
      )}

      {!guided && (
        <label className="mb-4 flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={deleteBranches} onChange={(e) => setDeleteBranches(e.target.checked)} /> Also delete the local branches
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={submit} disabled={busy || safety === null || (hasRisk && !ack)}>
          {busy ? (mode === 'delete' ? 'Deleting…' : guided ? 'Finishing…' : 'Archiving…') : mode === 'delete' ? (guided ? 'Delete task' : 'Delete workspace') : guided ? 'Finish' : 'Archive'}
        </Button>
      </div>
    </Dialog>
  )
}

function BranchDialog({ initial, onClose, onSubmit }: { initial: string; onClose: () => void; onSubmit: (v: string) => Promise<void> }): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title="Rename branch in every repo" onClose={onClose} width={440}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            await onSubmit(value)
            onClose()
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Branch name" hint="Applies to every repo in this workspace. Branches already on GitHub are renamed there too. The workspace name stays as it is.">
          <input autoFocus className={inputCls} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !value.trim() || value.trim() === initial}>
            {busy ? 'Renaming…' : 'Rename'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}


/** Worktrees recorded for the workspace that are gone from disk, with a one-click repair. */
function HealthBanner({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const guided = useGuided()
  const [missing, setMissing] = useState<{ repoName: string; worktreePath: string; branch: string }[]>([])
  const [busy, setBusy] = useState(false)
  const setError = useApp((s) => s.setError)
  const status = useApp((s) => s.workspaces.find((w) => w.id === workspaceId)?.status)
  useEffect(() => {
    let alive = true
    api
      .invoke('workspaces:health', workspaceId)
      .then((h) => alive && setMissing(h.missing))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [workspaceId, status])
  if (missing.length === 0) return null
  const repair = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.invoke('workspaces:repair', workspaceId)
      const h = await api.invoke('workspaces:health', workspaceId)
      setMissing(h.missing)
    } catch (err) {
      setError(friendlyError(err, 'The fix did not work. Try again, or ask a teammate.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-3 border-b border-warn/40 bg-warn/10 px-4 py-2 text-[12px]">
      <AlertTriangle size={14} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        {guided ? (
          'This task needs a quick fix before it can continue.'
        ) : (
          <>
            {missing.length === 1 ? 'A worktree is' : `${missing.length} worktrees are`} missing on disk: {missing.map((m) => `${m.repoName} (${m.branch})`).join(', ')}. The agent cannot run here until they are back.
          </>
        )}
      </span>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => void repair()} title={guided ? undefined : 'Recreate the missing worktrees from their branches'}>
        <RefreshCw size={12} className={clsx(busy && 'animate-spin')} /> {busy ? (guided ? 'Fixing…' : 'Repairing…') : guided ? 'Fix it' : 'Repair'}
      </Button>
    </div>
  )
}

/** The selected workspace is gone (deleted elsewhere, or a stale selection): say so and offer a way back. */
function MissingWorkspace({ guided }: { guided: boolean }): React.JSX.Element {
  const select = useApp((s) => s.select)
  return (
    <div className="drag flex h-full flex-col items-center justify-center gap-3 text-center">
      <SearchX size={28} className="text-muted" />
      <div className="text-[15px] font-semibold">{guided ? 'This task no longer exists' : 'This workspace no longer exists'}</div>
      <p className="max-w-sm text-[13px] text-muted">{guided ? 'It may have been finished or deleted.' : 'It may have been archived, deleted or removed on another window.'}</p>
      <Button className="no-drag" onClick={() => select(null)}>
        Back to {guided ? 'tasks' : 'workspaces'}
      </Button>
    </div>
  )
}

/** A generated view shown as a workspace tab, with the workspace as its context. */
function WorkspaceViewTab({ workspaceId, viewId }: { workspaceId: string; viewId: string }): React.JSX.Element | null {
  const settings = useApp((s) => s.settings)
  const spaces = useApp((s) => s.spaces)
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const setError = useApp((s) => s.setError)
  const view = useMemo(() => findView(viewId, settings, spaces), [viewId, settings, spaces])
  if (!view || !ws) return null
  const space = spaces.find((s) => s.id === ws.spaceId)
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-6 py-5">
        <ViewHeader view={view} guided={false} spaceName={space?.name} onError={setError} compact />
        <ViewHost key={`${view.id}:${ws.id}`} view={view} context={{ spaceId: ws.spaceId, spaceName: space?.name ?? 'Personal', workspaceId: ws.id, workspaceName: ws.name, branch: ws.repos[0]?.branch ?? '' }} />
      </div>
    </div>
  )
}
