import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { MessageSquare, FolderTree, Database, GitPullRequest, TerminalSquare, Play, Globe } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp, type Tab } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useGithub } from '@/stores/github'
import { useScripts } from '@/stores/scripts'
import { useBrowser } from '@/stores/browser'
import { useGuided } from '@/lib/guided'

/**
 * The workspace's tab strip. Tabs read as tools rather than a text list: an icon with the label,
 * grouped by what they are for (talk · code · run), and a live count or dot where the
 * user would otherwise have to click to find out. ⌘1…⌘7 switch tabs; the order matches.
 */
const GROUPS: { id: Tab; label: string; icon: React.ReactNode; hint: string }[][] = [
  [{ id: 'chat', label: 'Chat', icon: <MessageSquare size={13} />, hint: 'Talk to the agent' }],
  [
    { id: 'code', label: 'Code', icon: <FolderTree size={13} />, hint: 'Files, editor, diffs; commit and push' },
    { id: 'prs', label: 'PRs', icon: <GitPullRequest size={13} />, hint: 'Pull requests for these branches' }
  ],
  [
    { id: 'terminal', label: 'Terminal', icon: <TerminalSquare size={13} />, hint: 'Shells in the worktrees' },
    { id: 'run', label: 'Run', icon: <Play size={13} />, hint: 'Setup and run scripts' },
    { id: 'browser', label: 'Browser', icon: <Globe size={13} />, hint: 'The app in a browser the agent can drive' },
    { id: 'data', label: 'Data', icon: <Database size={13} />, hint: 'Databases of this space' }
  ]
]
/** Guided mode: talk, and look at the result. Everything else still runs underneath. */
const GUIDED_GROUPS: typeof GROUPS = [
  [{ id: 'chat', label: 'Chat', icon: <MessageSquare size={13} />, hint: 'Talk to the assistant' }],
  [{ id: 'browser', label: 'Preview', icon: <Globe size={13} />, hint: 'The app, as it looks with your changes' }]
]

export function WorkspaceTabs({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const tab = useApp((s) => s.tab)
  const setTab = useApp((s) => s.setTab)
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const agentBusy = useChat((s) => s.chats[workspaceId]?.busy ?? false)
  const browserBusy = useBrowser((s) => s.states[workspaceId]?.agentBusy ?? false)
  const prRepos = useGithub((s) => s.byWorkspace[workspaceId]?.repos)
  const runs = useScripts((s) => s.runs)
  const openPrs = useMemo(() => (prRepos ?? []).filter((r) => r.pr && r.pr.state === 'OPEN').length, [prRepos])
  const running = useMemo(() => Object.entries(runs).some(([k, r]) => k.startsWith(`${workspaceId}:`) && r.running), [runs, workspaceId])
  const [changed, setChanged] = useState<number | null>(null)
  const guided = useGuided()
  const dock = useApp((s) => s.browserDock)
  // Docked, the browser rides along with the chat, so drop its standalone tab from the strip.
  const groups = useMemo(() => (guided ? GUIDED_GROUPS : GROUPS).map((g) => g.filter((t) => !(dock && t.id === 'browser'))).filter((g) => g.length), [guided, dock])
  const order = useMemo(() => groups.flat().map((t) => t.id), [groups])
  // A tab that guided mode does not show falls back to the chat.
  useEffect(() => {
    if (guided && !order.includes(tab)) setTab('chat')
  }, [guided, order, tab, setTab])

  // Changed-file count: cheap to ask, and it turns "did the agent touch anything?" into a glance.
  useEffect(() => {
    if (!ws || ws.status !== 'ready') return
    let alive = true
    const poll = (): void => {
      void api
        .invoke('git:status', workspaceId)
        .then((st) => alive && setChanged(st.reduce((n, r) => n + r.files.length, 0)))
        .catch(() => undefined)
    }
    poll()
    const t = setInterval(poll, agentBusy ? 5_000 : 30_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [workspaceId, ws?.status, agentBusy, tab])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= order.length) {
        e.preventDefault()
        setTab(order[n - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setTab, order])

  const badge = (id: Tab): React.ReactNode => {
    if (id === 'chat' && agentBusy) return <Dot pulse />
    if (id === 'code' && changed) return <Count n={changed} />
    if (id === 'prs' && openPrs) return <Count n={openPrs} />
    if (id === 'run' && running) return <Dot tone="ok" />
    if (id === 'browser' && browserBusy) return <Dot pulse />
    return null
  }

  return (
    <nav className="no-drag flex h-[34px] shrink-0 items-center gap-1 border-b border-border bg-bg px-2" aria-label="Workspace tabs">
      {groups.map((group, gi) => (
        <React.Fragment key={gi}>
          {gi > 0 && <span className="mx-1 h-4 w-px bg-border" />}
          {group.map((t) => {
            const idx = order.indexOf(t.id) + 1
            return (
              <button
                key={t.id}
                data-tour={t.id === 'data' ? 'tab-data' : t.id === 'browser' ? 'tab-browser' : undefined}
                onClick={() => setTab(t.id)}
                title={`${t.hint} (⌘${idx})`}
                className={clsx(
                  'flex h-[26px] items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium leading-none transition-colors',
                  tab === t.id ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-text'
                )}
              >
                {t.icon}
                <span>{t.label}</span>
                {badge(t.id)}
              </button>
            )
          })}
        </React.Fragment>
      ))}
    </nav>
  )
}

function Count({ n }: { n: number }): React.JSX.Element {
  return <span className="ml-0.5 rounded-full bg-panel-2 px-1.5 py-px text-[10px] font-semibold tabular-nums text-text">{n > 99 ? '99+' : n}</span>
}
function Dot({ pulse, tone = 'accent' }: { pulse?: boolean; tone?: 'accent' | 'ok' }): React.JSX.Element {
  return <span className={clsx('ml-0.5 h-1.5 w-1.5 rounded-full', tone === 'ok' ? 'bg-ok' : 'bg-accent', pulse && 'animate-pulse')} />
}
