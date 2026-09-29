/**
 * Maestro home: where everyone lands (docs/design/README.md, decision 3). A brief of what waits on the person, built
 * only from state the app already has, above Maestro's conversation; and the person's Home pages next to it.
 */
import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useReviews } from '@/stores/reviews'
import { useOnCall, subscribeOnCall } from '@/stores/oncall'
import { useGuided, useWords, cap } from '@/lib/guided'
import { workspaceLabel } from '@/lib/labels'
import { MaestroView } from './MaestroView'
import { HomeView } from '../views/HomeView'
import { GettingStarted } from '../onboarding/GettingStarted'
import { Button, Segmented } from '../ui'

const BRIEF_KEY = 'sinfonie.maestro.briefOpen'

export function MaestroHome({ tab }: { tab: 'maestro' | 'pages' }): React.JSX.Element {
  const setView = useApp((s) => s.setView)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4">
        <Segmented
          value={tab}
          onChange={(v) => setView(v === 'pages' ? 'home' : 'maestro')}
          options={[
            { id: 'maestro', label: 'Maestro' },
            { id: 'pages', label: 'Pages' }
          ]}
          className="no-drag"
        />
        <span className="text-[12px] text-muted">{tab === 'pages' ? 'Your pages and your team’s. Ask Maestro to build or change one.' : 'Asks before it changes anything.'}</span>
      </div>
      {tab === 'pages' ? (
        <div className="min-h-0 flex-1">
          <HomeView />
        </div>
      ) : (
        <>
          <Brief />
          <div className="min-h-0 flex-1">
            {/* First steps stay visible on the landing screen, beside the conversation, until done or dismissed. */}
            <MaestroView
              top={
                <div className="flex shrink-0 justify-center px-6 empty:hidden">
                  <GettingStarted />
                </div>
              }
            />
          </div>
        </>
      )}
    </div>
  )
}

interface Row {
  key: string
  tone: 'attn' | 'danger' | 'ok' | 'idle'
  pill: string
  text: string
  action: string
  run: () => void
}

/** What waits on the person right now, one line each with one action. Hidden when nothing does. */
function Brief(): React.JSX.Element | null {
  const guided = useGuided()
  const t = useWords()
  const workspaces = useApp((s) => s.workspaces)
  const select = useApp((s) => s.select)
  const setView = useApp((s) => s.setView)
  const permissions = useChat((s) => s.permissions)
  const questions = useChat((s) => s.questions)
  const unseenReviews = useReviews((s) => Object.keys(s.unseen).length)
  // Select the stable state object, then derive: a fresh [] from a selector would re-render forever.
  const onCall = useOnCall((s) => s.state)
  const incidents = onCall?.incidents ?? []
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(BRIEF_KEY) !== '0'
    } catch {
      return true
    }
  })
  useEffect(() => subscribeOnCall(), [])
  const toggle = (): void => {
    setOpen(!open)
    try {
      localStorage.setItem(BRIEF_KEY, open ? '0' : '1')
    } catch {
      /* the brief just opens next time */
    }
  }

  const nameOf = (id: string): string => {
    const ws = workspaces.find((w) => w.id === id)
    return ws ? workspaceLabel(ws, guided) : t.workspace
  }
  const rows: Row[] = []
  // Only real workspaces: Maestro's own questions carry a "maestro:<id>" workspace id and are answered in its conversation.
  const waitingIds = [...new Set([...permissions.map((p) => p.workspaceId), ...questions.map((q) => q.workspaceId)])].filter((id) => id && workspaces.some((w) => w.id === id))
  if (waitingIds.length) {
    const first = waitingIds[0]
    rows.push({
      key: 'waiting',
      tone: 'attn',
      pill: 'Needs you',
      text: waitingIds.length === 1 ? `${cap(nameOf(first))} is waiting for your answer.` : `${waitingIds.length} ${t.workspaces} are waiting for your answer, starting with ${nameOf(first)}.`,
      action: 'Open',
      run: () => select(first)
    })
  }
  const openIncidents = incidents.filter((i) => i.status === 'new' || i.status === 'open')
  if (!guided && openIncidents.length) {
    rows.push({ key: 'incidents', tone: 'danger', pill: 'Incident', text: openIncidents.length === 1 ? openIncidents[0].title : `${openIncidents.length} open incidents, the newest: ${openIncidents[0].title}`, action: 'Open', run: () => setView('oncall') })
  }
  const inReview = workspaces.filter((w) => w.status !== 'archived' && w.stage === 'in-review')
  if (inReview.length) {
    rows.push({
      key: 'review',
      tone: 'ok',
      pill: guided ? 'With a reviewer' : 'In review',
      text: inReview.length === 1 ? `${cap(nameOf(inReview[0].id))} is waiting for review.` : `${inReview.length} ${t.workspaces} are waiting for review.`,
      action: 'Show',
      run: () => select(inReview[0].id)
    })
  }
  if (!guided && unseenReviews) {
    rows.push({ key: 'reviews', tone: 'idle', pill: 'Reviews', text: `${unseenReviews} review${unseenReviews === 1 ? '' : 's'} finished since you last looked.`, action: 'Open', run: () => setView('reviews') })
  }
  if (rows.length === 0) return null

  return (
    <section aria-label="Brief" className="shrink-0 border-b border-border bg-panel/40 px-6 py-3">
      <div className="mx-auto max-w-3xl">
        <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-text">
          Right now · {rows.length}
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        {open && (
          <div className="mt-2 flex flex-col gap-1.5">
            {rows.map((r) => (
              <div key={r.key} className="flex items-center gap-3 text-[13px]">
                <span className={clsx('inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold', r.tone === 'attn' && 'bg-warn/15 text-warn', r.tone === 'danger' && 'bg-danger/15 text-danger', r.tone === 'ok' && 'bg-ok/15 text-ok', r.tone === 'idle' && 'bg-panel-2 text-muted')}>{r.pill}</span>
                <span className="min-w-0 flex-1 truncate">{r.text}</span>
                <Button size="sm" onClick={r.run}>
                  {r.action}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
