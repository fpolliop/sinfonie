import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { create } from 'zustand'
import { GitCompare, Database, ListChecks, TerminalSquare, Globe, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp, type Tab } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useGithub } from '@/stores/github'
import { useScripts } from '@/stores/scripts'
import { useBrowser } from '@/stores/browser'
import { useGuided } from '@/lib/guided'
import { visibleViews } from '@/lib/views'
import { ViewIcon } from './views/registry'
import { IconButton, hasOpenDialog } from './ui'
import { yieldsToEditor } from '@/lib/keys'

/**
 * The workspace's side panel (the inspector beside the conversation) and its tab strip. Five tools, each with a
 * live count or dot where the person would otherwise have to click to find out: Changes (with every file behind
 * it), Preview, Checks (pull requests and CI), Terminal (with the setup and run scripts) and Data, then any
 * generated views. ⌘1…⌘9 pick a tab in this order and expand the panel.
 */
export type Pane = 'changes' | 'preview' | 'checks' | 'terminal' | 'data' | `view:${string}`

interface PaneDef {
  id: Pane
  /** The tab a click on this pane selects; sub-views of a pane (Files, Scripts) are other tabs of the same pane. */
  tab: Tab
  label: string
  icon: React.ReactNode
  hint: string
}

const PANES: PaneDef[] = [
  { id: 'changes', tab: 'changes', label: 'Changes', icon: <GitCompare size={13} />, hint: 'What changed in every repository, file by file, and every file' },
  { id: 'preview', tab: 'browser', label: 'Preview', icon: <Globe size={13} />, hint: 'The app in a browser the agent can drive' },
  { id: 'checks', tab: 'prs', label: 'Checks', icon: <ListChecks size={13} />, hint: 'Pull requests, CI checks and review comments' },
  { id: 'terminal', tab: 'terminal', label: 'Terminal', icon: <TerminalSquare size={13} />, hint: 'Shells in the worktrees, and the setup and run scripts' },
  { id: 'data', tab: 'data', label: 'Data', icon: <Database size={13} />, hint: 'Databases of this space' }
]
/** Guided mode: look at the result. Everything else still runs underneath. */
const GUIDED_PANES: PaneDef[] = [{ id: 'preview', tab: 'browser', label: 'Preview', icon: <Globe size={13} />, hint: 'The app, as it looks with your changes' }]

/** Which pane a tab belongs to; null for 'chat', which is always on screen. */
export function paneOf(tab: Tab): Pane | null {
  switch (tab) {
    case 'changes':
    case 'code':
      return 'changes'
    case 'browser':
      return 'preview'
    case 'prs':
      return 'checks'
    case 'terminal':
    case 'run':
      return 'terminal'
    case 'data':
      return 'data'
    case 'chat':
      return null
    default:
      return tab
  }
}

/** The panel's tabs in a mode, in ⌘1…⌘n order (the command palette lists the same ones). */
export function tabsFor(guided: boolean): { id: Tab; label: string; hint: string }[] {
  return (guided ? GUIDED_PANES : PANES).map((p) => ({ id: p.tab, label: p.label, hint: p.hint }))
}

/** The panes a workspace shows in this mode, generated views included. */
export function usePanes(workspaceId: string): PaneDef[] {
  const guided = useGuided()
  const spaceId = useApp((s) => s.workspaces.find((w) => w.id === workspaceId)?.spaceId)
  const settings = useApp((s) => s.settings)
  const spaces = useApp((s) => s.spaces)
  return useMemo(() => {
    if (guided) return GUIDED_PANES
    const views = visibleViews('workspace-tab', spaceId, settings, spaces).map(
      (v): PaneDef => ({ id: `view:${v.id}`, tab: `view:${v.id}`, label: v.title, icon: <ViewIcon name={v.icon ?? 'layout-dashboard'} size={13} />, hint: v.scope.kind === 'space' ? 'A view shared with your team' : 'Your view' })
    )
    return [...PANES, ...views]
  }, [guided, spaceId, settings, spaces])
}

/** The Changes tab's own file count per workspace, published while it is on screen (so nothing polls twice). */
export const useChangesLive = create<Record<string, number>>(() => ({}))

/**
 * How many files changed: the Changes tab's list while it is mounted, otherwise git status (uncommitted files),
 * polled faster while the agent works and not at all while the window is hidden.
 */
export function useChangedCount(workspaceId: string, enabled = true): number | null {
  const ready = useApp((s) => s.workspaces.find((w) => w.id === workspaceId)?.status === 'ready')
  const agentBusy = useChat((s) => s.chats[workspaceId]?.busy ?? false)
  const live = useChangesLive((s) => s[workspaceId])
  const polling = enabled && live === undefined
  const [changed, setChanged] = useState<number | null>(null)
  useEffect(() => {
    if (!ready || !polling) return
    let alive = true
    let busy = false
    const poll = (): void => {
      if (busy || document.hidden) return
      busy = true
      void api
        .invoke('git:status', workspaceId)
        .then((st) => alive && setChanged(st.reduce((n, r) => n + r.files.length, 0)))
        .catch(() => undefined)
        .finally(() => (busy = false))
    }
    poll()
    const t = setInterval(poll, agentBusy ? 5_000 : 30_000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      alive = false
      clearInterval(t)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [workspaceId, ready, agentBusy, polling])
  return live ?? changed
}

/**
 * The panel's tab strip, an ARIA tablist: ←/→ (and Home/End) move between tabs, and the collapse button folds
 * the panel into a rail. `current` is the pane on screen.
 */
export function WorkspaceTabs({ workspaceId, current, panes, onCollapse }: { workspaceId: string; current: Pane; panes: PaneDef[]; onCollapse?: () => void }): React.JSX.Element {
  const setTab = useApp((s) => s.setTab)
  const setOpen = useApp((s) => s.setInspectorOpen)
  const guided = useGuided()
  const badges = usePaneBadges(workspaceId)
  const listRef = useRef<HTMLDivElement>(null)
  useTabShortcuts(panes)

  const onKey = (e: React.KeyboardEvent): void => {
    const i = panes.findIndex((p) => p.id === current)
    const go = (n: number): void => {
      const p = panes[(n + panes.length) % panes.length]
      setTab(p.tab)
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-pane="${CSS.escape(p.id)}"]`)?.focus())
    }
    if (e.key === 'ArrowRight') go(i + 1)
    else if (e.key === 'ArrowLeft') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(panes.length - 1)
    else return
    e.preventDefault()
  }

  return (
    <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-border px-2">
      <div ref={listRef} role="tablist" aria-label={guided ? 'Task views' : 'Workspace panel'} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" onKeyDown={onKey}>
        {panes.map((p, idx) => {
          const on = p.id === current
          return (
            <button
              key={p.id}
              role="tab"
              id={`ws-tab-${p.id}`}
              aria-selected={on}
              aria-controls="ws-inspector-panel"
              tabIndex={on ? 0 : -1}
              data-pane={p.id}
              data-tour={p.id === 'data' ? 'tab-data' : p.id === 'preview' ? 'tab-browser' : undefined}
              aria-keyshortcuts={idx < 9 ? `Meta+${idx + 1}` : undefined}
              title={idx < 9 ? `${p.hint} (⌘${idx + 1})` : p.hint}
              onClick={() => setTab(on && paneOf(useApp.getState().tab) === p.id ? useApp.getState().tab : p.tab)}
              className={clsx(
                'flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium leading-none transition-colors',
                on ? 'bg-panel-2 text-text' : 'text-muted hover:bg-panel-2 hover:text-text'
              )}
            >
              {p.icon}
              {/* A narrow panel keeps the icons; the name stays for screen readers and in the tooltip. */}
              <span className="@max-[470px]:sr-only">{p.label}</span>
              {badges[p.id]}
            </button>
          )
        })}
      </div>
      <IconButton label={onCollapse ? (guided ? 'Hide the preview (Esc)' : 'Hide the side panel (Esc)') : guided ? 'Hide the preview' : 'Collapse the side panel'} className="shrink-0" onClick={() => (onCollapse ? onCollapse() : setOpen(false))}>
        <PanelRightClose size={14} />
      </IconButton>
    </div>
  )
}

/** The collapsed panel: a thin rail with one button per tab, so every tool stays one click away. */
export function WorkspaceTabsRail({ workspaceId, panes, cramped, quiet, onShow }: { workspaceId: string; panes: PaneDef[]; cramped?: boolean; quiet?: boolean; onShow?: () => void }): React.JSX.Element {
  const setTab = useApp((s) => s.setTab)
  const setOpen = useApp((s) => s.setInspectorOpen)
  const guided = useGuided()
  // `quiet`: the panel is showing over the chat and its own tab strip owns the shortcuts and the live counts.
  const badges = usePaneBadges(workspaceId, !quiet)
  useTabShortcuts(panes, !quiet)
  return (
    <nav aria-label={guided ? 'Show a task view' : 'Open the side panel'} className="flex w-10 shrink-0 flex-col items-center gap-1 border-l border-border bg-panel py-1.5">
      <IconButton
        label={guided ? 'Show the preview' : cramped ? 'Show the side panel over the chat (the window is too narrow for both)' : 'Expand the side panel'}
        className="h-7 w-7"
        onClick={() => (cramped && onShow ? onShow() : setOpen(true))}
      >
        <PanelRightOpen size={14} />
      </IconButton>
      <span className="my-0.5 h-px w-5 bg-border" aria-hidden />
      {panes.map((p, idx) => (
        <IconButton key={p.id} label={`${p.label}${idx < 9 ? ` (⌘${idx + 1})` : ''}`} data-tour={p.id === 'data' ? 'tab-data' : p.id === 'preview' ? 'tab-browser' : undefined} className="relative h-7 w-7" onClick={() => setTab(p.tab)}>
          {p.icon}
          {badges[p.id] && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
        </IconButton>
      ))}
    </nav>
  )
}

/** ⌘1…⌘9 select the panel's tabs in order. */
function useTabShortcuts(panes: PaneDef[], enabled = true): void {
  const setTab = useApp((s) => s.setTab)
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey || hasOpenDialog() || yieldsToEditor(e)) return
      const n = Number(e.key)
      if (n >= 1 && n <= Math.min(9, panes.length)) {
        e.preventDefault()
        setTab(panes[n - 1].tab)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setTab, panes, enabled])
}

/** Live counts and dots per pane: changed files, open pull requests, a running script, the agent in the browser. */
function usePaneBadges(workspaceId: string, enabled = true): Partial<Record<Pane, React.ReactNode>> {
  const browserBusy = useBrowser((s) => s.states[workspaceId]?.agentBusy ?? false)
  const prRepos = useGithub((s) => s.byWorkspace[workspaceId]?.repos)
  const runs = useScripts((s) => s.runs)
  const openPrs = useMemo(() => (prRepos ?? []).filter((r) => r.pr && r.pr.state === 'OPEN').length, [prRepos])
  const failing = useMemo(() => (prRepos ?? []).some((r) => r.pr?.state === 'OPEN' && r.pr.checks.some((c) => c.status === 'failure')), [prRepos])
  const running = useMemo(() => Object.entries(runs).some(([k, r]) => k.startsWith(`${workspaceId}:`) && r.running), [runs, workspaceId])
  const changed = useChangedCount(workspaceId, enabled)
  return {
    changes: changed ? <Count n={changed} label={`${changed} changed file${changed === 1 ? '' : 's'}`} /> : null,
    checks: failing ? <Dot tone="danger" label="A check is failing" /> : openPrs ? <Count n={openPrs} label={`${openPrs} open pull request${openPrs === 1 ? '' : 's'}`} /> : null,
    terminal: running ? <Dot tone="ok" label="A script is running" /> : null,
    preview: browserBusy ? <Dot pulse label="The agent is using the browser" /> : null
  }
}

function Count({ n, label }: { n: number; label: string }): React.JSX.Element {
  return (
    <span className="ml-0.5 rounded-full bg-bg px-1.5 py-px text-[11px] font-semibold tabular-nums text-text" aria-label={label}>
      {n > 99 ? '99+' : n}
    </span>
  )
}
function Dot({ pulse, tone = 'accent', label }: { pulse?: boolean; tone?: 'accent' | 'ok' | 'danger'; label: string }): React.JSX.Element {
  return <span role="img" aria-label={label} className={clsx('ml-0.5 h-1.5 w-1.5 rounded-full', tone === 'ok' ? 'bg-ok' : tone === 'danger' ? 'bg-danger' : 'bg-accent', pulse && 'animate-pulse')} />
}
