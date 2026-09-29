import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { isGuided } from '@/lib/guided'
import { Button, IconButton } from '../ui'

interface Stop {
  anchor: string
  title: string
  text: string
  /** Something to do before measuring, so the anchor exists or is visible. */
  prepare?: () => void
}

/** The workspace view with a workspace in it: the one selected, else the most recent live one. Nothing to do when there is none. */
const prepareWorkspace = (): void => {
  const app = useApp.getState()
  if (app.view !== 'workspace') app.setView('workspace')
  if (app.selectedId && app.workspaces.some((w) => w.id === app.selectedId)) return
  const next = app.workspaces
    .filter((w) => w.status !== 'archived')
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))[0]
  if (next) app.select(next.id)
}

const prepareView = (): void => {
  if (useApp.getState().view !== 'workspace') useApp.getState().setView('workspace')
}

/** Review lives on its own screen now (the rail's Review). */
const prepareReview = (): void => {
  if (useApp.getState().view !== 'reviews') useApp.getState().setView('reviews')
}

const STOPS: Stop[] = [
  { anchor: 'maestro', title: 'Maestro', text: 'Your companion. It knows everything in Sinfonie: your spaces, workspaces and what happened in them, your agents, your notes and todos, your integrations. Ask it anything, have it set things up, send tasks to workspaces, run agents, or sweep Slack for you. It confirms before every change. It is your home screen, and ⌘J opens it beside whatever you are looking at, knowing what that screen shows.' },
  { anchor: 'spaces', title: 'Spaces', text: 'Each dot is a space: its own repositories, workspaces, crew and settings. Personal, work, a client. ⌃1…9 jumps to one, ⌘⌥← and ⌘⌥→ step through them, and a two-finger swipe on the sidebar does too.', prepare: prepareView },
  { anchor: 'new-workspace', title: 'Workspaces', text: 'A workspace is one branch across every repo you pick. Sinfonie creates a git worktree per repo in its own folder, so a full-stack change lives in one place. ⇧⌘N opens this.', prepare: prepareView },
  { anchor: 'repos', title: 'The repos in a workspace', text: 'Every repo here is on the same branch. The dot shows its pull request state; click one to see the PR and review comments.', prepare: prepareWorkspace },
  { anchor: 'session', title: 'Session, context and cost mode', text: 'Engine and model, how full the context window is, the cost of this session, and the cost mode: Standard, Budget or Lean. Lean runs one Sonnet agent with no crew and capped turns, for tight subscriptions. Compact or start a new session from here.', prepare: prepareWorkspace },
  { anchor: 'mode', title: 'Permission mode', text: 'How much the agent may do without asking. Plan only reads. Default asks before edits and commands. Auto-edit accepts edits. Auto also runs safe commands. Shift+Tab cycles.', prepare: prepareWorkspace },
  { anchor: 'notes', title: 'Notes', text: 'Notes, reminders and todos for this workspace. The orchestrator reads them, adds follow-ups it finds, and ticks todos it completes. Ask it to “remember” something and it lands here.', prepare: prepareWorkspace },
  { anchor: 'notes-all', title: 'Notes', text: 'Every todo and note across workspaces, spaces and the app, as a board or a list; agents file into it.' },
  { anchor: 'tab-data', title: 'Data', text: 'Your databases: Postgres, MySQL, SQLite, MongoDB and BigQuery, directly, through SSH, or through Cloud SQL with your Google login. Schema tree, SQL editor, ERD, inline editing, CSV import and export. Read-only by default, for you and for the agents.', prepare: prepareWorkspace },
  { anchor: 'tab-browser', title: 'Browser', text: 'A browser the agent can drive: check the app on localhost, read documentation, operate consoles you are signed into. Sensitive sites always ask you first.', prepare: prepareWorkspace },
  { anchor: 'activity', title: 'Crew activity', text: 'Who did what in this session: the orchestrator and every crew member it delegated to, on whatever vendor each runs. Click a running member to watch it.', prepare: prepareWorkspace },
  { anchor: 'reviews', title: 'Review', text: 'Your open pull requests across all repos in one list. AI review reads the diff, you approve the findings that matter, and it drafts the reply.', prepare: prepareReview },
  { anchor: 'oncall', title: 'On call', text: 'Watches your Slack alert and support channels, triages each incident against your code and your Google Cloud logs, proposes replies you approve, and opens a draft PR with the fix when it is sure of the cause.', prepare: prepareReview },
  { anchor: 'agents', title: 'Agents', text: 'Your agent library. Each agent is a role with its own instructions, model and tools. The four built-ins, explorer, implementer, tester and reviewer, are the default crew (under the Crew tab). Describe one in a sentence and it is drafted for you, try it on a workspace right there, and call one directly in any chat with @name. Agents you create are standalone unless you put them in the crew.', prepare: prepareView },
  { anchor: 'settings', title: 'Settings', text: 'Accounts for every vendor, model providers, the crew, usage, resources, and the integrations: Jira, Linear, Slack, Google Cloud, databases, MCP servers. Application-wide on the left, per space on the right. ⌘, opens it; ⌘K runs any command and ⌘/ lists the shortcuts.' }
]

/** The guided tour: only what guided mode shows, in its own words. */
export const GUIDED_STOPS: Stop[] = [
  { anchor: 'maestro', title: 'Maestro', text: 'Your home. Tell Maestro what you want in plain words; it knows your apps and tasks, and it always shows you a change before making it. ⌘J opens it on any screen.' },
  { anchor: 'new-workspace', title: 'Tasks', text: 'A task is one thing you want built or changed in your app. Start one here and describe it in plain words; Maestro takes it from there. ⇧⌘N opens this.', prepare: prepareView },
  { anchor: 'repos', title: 'Your apps in this task', text: 'The apps this task touches. Each task works on its own copy of them, so nothing changes for anyone else until it is reviewed.', prepare: prepareWorkspace },
  { anchor: 'tab-browser', title: 'Preview', text: 'See the app while Maestro works on it, on your Mac, before anyone else does.', prepare: prepareWorkspace },
  { anchor: 'settings', title: 'Settings', text: 'Your sign-in and your team. ⌘, opens it; ⌘K finds any task or action.' }
]

const PAD = 6

/** Spotlight tour over the live UI. Stops whose anchor is not on screen are skipped. */
export function Tour({ onClose }: { onClose: () => void }): React.JSX.Element | null {
  const stops = useMemo(() => (isGuided() ? GUIDED_STOPS : STOPS), [])
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  // The parent passes a fresh onClose every render; keep finish stable so the layout effect below
  // does not re-run on every store change (that looped: prepare → store set → parent render → effect…).
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const finish = useCallback((): void => {
    const { settings } = useApp.getState()
    void api.invoke('settings:update', { onboarding: { ...(settings.onboarding ?? {}), tourDoneAt: new Date().toISOString() } }).catch(() => undefined)
    onCloseRef.current()
  }, [])

  /**
   * Indices of the stops the tour can show right now: the anchor is in the DOM, or the stop can
   * bring it there (a prepare) and there is a workspace to show. The counter runs over these.
   */
  const reachable = useCallback((): number[] => {
    const hasWorkspace = useApp.getState().workspaces.some((w) => w.status !== 'archived')
    // A stop can be shown when its anchor is on screen, or its prepare can bring it there: switching screens always
    // can; opening a workspace only when there is one.
    return stops.flatMap((s, k) => (document.querySelector(`[data-tour="${s.anchor}"]`) || (s.prepare && (s.prepare !== prepareWorkspace || hasWorkspace)) ? [k] : []))
  }, [stops])
  const [reach, setReach] = useState<number[]>(reachable)

  /** The anchor element, if it is in the DOM and actually visible. */
  const find = (idx: number): Element | null => {
    const el = document.querySelector(`[data-tour="${stops[idx].anchor}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 ? el : null
  }
  const step = (dir: 1 | -1): void => {
    let n = i + dir
    while (n >= 0 && n < stops.length) {
      // A stop that switches screens is measured after the switch renders (the layout effect below).
      if (stops[n].prepare || find(n)) break
      n += dir
    }
    if (n < 0) return
    if (n >= stops.length) finish()
    else setI(n)
  }
  useLayoutEffect(() => {
    stops[i].prepare?.()
    setReach((prev) => {
      const next = reachable()
      return prev.length === next.length && prev.every((v, k) => v === next[k]) ? prev : next
    })
    let retried = false
    const measure = (): void => {
      const el = find(i)
      if (!el && !retried && stops[i].prepare) {
        // The prepare just switched screens; give React a moment to render it before giving up on this stop.
        retried = true
        window.setTimeout(measure, 120)
        return
      }
      if (!el) {
        // Anchor vanished (e.g. no workspace selected): move on.
        const next = stops.findIndex((_, k) => k > i && find(k))
        if (next === -1) finish()
        else setI(next)
        return
      }
      const r = el.getBoundingClientRect()
      setRect((prev) => (prev && prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height ? prev : r))
    }
    measure()
    window.addEventListener('resize', measure)
    const t = setInterval(measure, 500)
    return () => {
      window.removeEventListener('resize', measure)
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish()
      if (e.key === 'ArrowRight' || e.key === 'Enter') step(1)
      if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  if (!rect) return null
  const stop = stops[i]
  const at = reach.indexOf(i)
  const shown = at === -1 ? reach.filter((k) => k < i).length + 1 : at + 1
  const total = Math.max(reach.length, shown)
  const last = at === -1 ? !reach.some((k) => k > i) : at === reach.length - 1
  const W = 320
  const vw = window.innerWidth
  const vh = window.innerHeight
  const lowerHalf = rect.top + rect.height / 2 > vh / 2
  // Beside the target when there is room (right, else left), otherwise below or above it.
  // Vertically the card hangs from the edge nearest the middle of the screen, so it never runs off.
  const pos: React.CSSProperties = { width: W }
  const right = rect.right + PAD + 12
  const leftSide = rect.left - PAD - 12 - W
  if (right + W <= vw - 12 || leftSide >= 12) {
    pos.left = right + W <= vw - 12 ? right : leftSide
    if (lowerHalf) pos.bottom = Math.max(12, vh - (rect.bottom + PAD))
    else pos.top = Math.max(12, rect.top - PAD)
  } else {
    pos.left = Math.max(12, Math.min(rect.left, vw - W - 12))
    if (lowerHalf) pos.bottom = Math.max(12, vh - rect.top + PAD + 12)
    else pos.top = rect.bottom + PAD + 12
  }
  return (
    <div className="fixed inset-0 z-[70] no-drag" onMouseDown={(e) => e.target === e.currentTarget && step(1)}>
      <div className="pointer-events-none absolute rounded-lg ring-2 ring-accent/70 transition-all duration-200" style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2, boxShadow: '0 0 0 100vmax rgba(0,0,0,.55)' }} />
      <div className="absolute rounded-xl border border-border bg-panel p-4 shadow-2xl transition-all duration-200" style={pos}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted">
            {shown} of {total}
          </span>
          <IconButton label="End tour" className="ml-auto" onClick={finish}>
            <X size={14} />
          </IconButton>
        </div>
        <div className="mt-1 text-[15px] font-semibold">{stop.title}</div>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">{stop.text}</p>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={finish}>
            Skip tour
          </Button>
          <span className="ml-auto flex gap-1.5">
            <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => step(-1)}>
              Back
            </Button>
            <Button size="sm" variant="primary" onClick={() => step(1)}>
              {last ? 'Done' : 'Next'}
            </Button>
          </span>
        </div>
      </div>
    </div>
  )
}
