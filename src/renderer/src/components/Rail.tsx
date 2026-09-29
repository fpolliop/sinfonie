/**
 * The rail: the app's top level, one column of five places (docs/design/README.md, "Information architecture").
 * Maestro is home for everyone; Build (Tasks in guided words) holds the work; Review, Notes and Team follow the
 * person's role. Badges count what is waiting on the person, never activity for its own sake.
 */
import React, { useEffect } from 'react'
import clsx from 'clsx'
import { Wand2, Layers, CircleCheck, StickyNote, Users, Settings } from 'lucide-react'
import { useApp, type View } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useReviews } from '@/stores/reviews'
import { useNotes } from '@/stores/notes'
import { useMaestro } from '@/stores/maestro'
import { useGuided, useWords, cap } from '@/lib/guided'

/** Views that belong to each rail place, so the right item lights up wherever the person is. */
const BUILD_VIEWS: View[] = ['workspace', 'agents']
const REVIEW_VIEWS: View[] = ['reviews', 'oncall']

export function Rail(): React.JSX.Element {
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const openSettings = useApp((s) => s.openSettings)
  const account = useApp((s) => s.settings.cloud?.account)
  const guided = useGuided()
  const t = useWords()
  const waiting = useChat((s) => s.permissions.length + s.questions.length)
  const reviews = useReviews((s) => Object.keys(s.unseen).length)
  const maestroBusy = useMaestro((s) => Object.values(s.byId).some((c) => c.busy))
  const todos = useNotes((s) => Object.values(s.byWorkspace).reduce((n, list) => n + list.filter((x) => x.kind === 'todo' && !x.done).length, 0))
  const { loadAll, subscribe } = useNotes()
  useEffect(() => {
    subscribe()
    void loadAll().catch(() => undefined)
  }, [loadAll, subscribe])

  // Review and Team follow the role. Until team roles exist, experts review, and Team shows to experts and to
  // team admins in either mode.
  const isAdmin = Boolean(account?.orgs?.some((o) => o.role === 'admin'))
  const showReview = !guided
  const showTeam = !guided || isAdmin

  return (
    <nav aria-label="Main" className="drag flex w-[72px] shrink-0 flex-col items-center gap-1 border-r border-border bg-panel pb-3 pt-[52px]">
      <RailItem tour="maestro" label="Maestro" hint="Maestro, your home (⌘J opens it on any screen)" active={view === 'maestro' || view === 'home'} maestro onClick={() => setView('maestro')} icon={<Wand2 size={19} />} dot={maestroBusy} />
      <RailItem tour="build" label={guided ? cap(t.workspaces) : 'Build'} hint={guided ? 'Your tasks' : 'Workspaces and agents'} active={BUILD_VIEWS.includes(view)} onClick={() => setView('workspace')} icon={<Layers size={19} />} count={waiting} countLabel={`${waiting} waiting on you`} />
      {showReview && <RailItem tour="reviews" label="Review" hint="Reviews and on-call" active={REVIEW_VIEWS.includes(view)} onClick={() => setView('reviews')} icon={<CircleCheck size={19} />} count={reviews} countLabel={`${reviews} new`} />}
      <RailItem tour="notes-all" label="Notes" hint="To-dos, findings, decisions and rules" active={view === 'notes'} onClick={() => setView('notes')} icon={<StickyNote size={19} />} count={todos} countLabel={`${todos} open to-dos`} quiet />
      {showTeam && <RailItem tour="team" label="Team" hint="Apps, people, connections, plan" active={false} onClick={() => openSettings({ scope: 'app', page: guided ? 'plan' : 'spaces' })} icon={<Users size={19} />} />}
      <div className="flex-1" />
      <RailItem tour="settings" label="Settings" hint="Your settings (⌘,)" active={false} onClick={() => openSettings({ scope: 'app', page: 'preferences' })} icon={<Settings size={19} />} quiet />
    </nav>
  )
}

function RailItem({ label, hint, icon, active, onClick, count = 0, countLabel, quiet, maestro, dot, tour }: { label: string; hint: string; icon: React.ReactNode; active: boolean; onClick: () => void; count?: number; countLabel?: string; quiet?: boolean; maestro?: boolean; dot?: boolean; tour?: string }): React.JSX.Element {
  return (
    <button
      type="button"
      data-tour={tour}
      title={hint}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={clsx(
        'no-drag relative flex w-[60px] flex-col items-center gap-1 rounded-lg py-2 text-[11px] font-medium transition-colors',
        active ? (maestro ? 'bg-maestro/15 text-maestro' : 'bg-panel-2 text-text') : maestro ? 'text-maestro hover:bg-maestro/10' : 'text-muted hover:bg-panel-2/60 hover:text-text'
      )}
    >
      {icon}
      {label}
      {count > 0 && (
        <span aria-label={countLabel} className={clsx('absolute right-2 top-1 min-w-4 rounded-full px-1 text-center text-[11px] font-bold leading-4', quiet ? 'bg-panel-2 text-muted' : 'bg-warn text-[#1b1300]')}>
          {count > 99 ? '99+' : count}
        </span>
      )}
      {dot && <span aria-label="Maestro is working" className="absolute right-3 top-1.5 h-2 w-2 animate-pulse rounded-full bg-maestro" />}
    </button>
  )
}
