import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { X } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Button } from '../ui'

interface Stop {
  anchor: string
  title: string
  text: string
  /** Something to do before measuring, so the anchor exists or is visible. */
  prepare?: () => void
}

const STOPS: Stop[] = [
  { anchor: 'spaces', title: 'Spaces', text: 'Each dot is a space: its own repositories, workspaces, crew and settings. Personal, work, a client. ⌃1…9 jumps to one, ⌘⌥← and ⌘⌥→ step through them, and a two-finger swipe on the sidebar does too.' },
  { anchor: 'new-workspace', title: 'Workspaces', text: 'A workspace is one branch across every repo you pick. Sinfonie creates a git worktree per repo in its own folder, so a full-stack change lives in one place. ⇧⌘N opens this.' },
  { anchor: 'repos', title: 'The repos in a workspace', text: 'Every repo here is on the same branch. The dot shows its pull request state; click one to see the PR and review comments.' },
  { anchor: 'mode', title: 'Permission mode', text: 'How much the agent may do without asking. Plan only reads. Default asks before edits and commands. Auto-edit accepts edits. Auto also runs safe commands. Shift+Tab cycles.' },
  { anchor: 'activity', title: 'Crew activity', text: 'Who did what in this session: the orchestrator and every crew member it delegated to, on whatever vendor each runs. Click a running member to watch it.' },
  { anchor: 'reviews', title: 'Review cockpit', text: 'Your open pull requests across all repos in one list. AI review reads the diff, you approve the findings that matter, and it drafts the reply.', prepare: () => useApp.getState().setView('workspace') },
  { anchor: 'settings', title: 'Settings', text: 'Accounts for every vendor, model providers, the crew, MCP servers, Jira. Application-wide on the left, per space on the right. ⌘, opens it.' }
]

const PAD = 6

/** Spotlight tour over the live UI. Stops whose anchor is not on screen are skipped. */
export function Tour({ onClose }: { onClose: () => void }): React.JSX.Element | null {
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const settings = useApp((s) => s.settings)
  const finish = useCallback((): void => {
    void api.invoke('settings:update', { onboarding: { ...(settings.onboarding ?? {}), tourDoneAt: new Date().toISOString() } }).catch(() => undefined)
    onClose()
  }, [onClose, settings.onboarding])

  const find = (idx: number): Element | null => document.querySelector(`[data-tour="${STOPS[idx].anchor}"]`)
  const step = (dir: 1 | -1): void => {
    let n = i + dir
    while (n >= 0 && n < STOPS.length) {
      STOPS[n].prepare?.()
      if (find(n)) break
      n += dir
    }
    if (n < 0) return
    if (n >= STOPS.length) finish()
    else setI(n)
  }
  useLayoutEffect(() => {
    STOPS[i].prepare?.()
    const measure = (): void => {
      const el = find(i)
      if (!el) {
        // Anchor vanished (e.g. no workspace selected): move on.
        const next = STOPS.findIndex((_, k) => k > i && document.querySelector(`[data-tour="${STOPS[k].anchor}"]`))
        if (next === -1) finish()
        else setI(next)
        return
      }
      el.scrollIntoView({ block: 'nearest' })
      setRect(el.getBoundingClientRect())
    }
    measure()
    window.addEventListener('resize', measure)
    const t = setInterval(measure, 500)
    return () => {
      window.removeEventListener('resize', measure)
      clearInterval(t)
    }
  }, [i, finish])
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
  const stop = STOPS[i]
  const W = 320
  const vw = window.innerWidth
  const vh = window.innerHeight
  // Card to the right of the target when there is room, else left, else below.
  let left = rect.right + PAD + 12
  let top = Math.max(12, Math.min(rect.top - 8, vh - 200))
  if (left + W > vw - 12) left = rect.left - PAD - 12 - W
  if (left < 12) {
    left = Math.max(12, Math.min(rect.left, vw - W - 12))
    top = rect.bottom + PAD + 12
    if (top + 180 > vh) top = rect.top - PAD - 12 - 180
  }
  return (
    <div className="fixed inset-0 z-[70] no-drag" onMouseDown={(e) => e.target === e.currentTarget && step(1)}>
      <div className="pointer-events-none absolute rounded-lg ring-2 ring-accent/70 transition-all duration-200" style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2, boxShadow: '0 0 0 100vmax rgba(0,0,0,.55)' }} />
      <div className="absolute w-[320px] rounded-xl border border-border bg-panel p-4 shadow-2xl transition-all duration-200" style={{ left, top }}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted">
            {i + 1} of {STOPS.length}
          </span>
          <button className="ml-auto text-muted hover:text-text" onClick={finish} aria-label="End tour">
            <X size={14} />
          </button>
        </div>
        <div className="mt-1 text-[14px] font-semibold">{stop.title}</div>
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
              {i === STOPS.length - 1 ? 'Done' : 'Next'}
            </Button>
          </span>
        </div>
      </div>
    </div>
  )
}
