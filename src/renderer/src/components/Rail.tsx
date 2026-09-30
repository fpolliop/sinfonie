/**
 * The rail: the app's top level, one column of five places (docs/design/README.md, "Information architecture").
 * Maestro is home for everyone; Build (Tasks in guided words) holds the work; Review, Notes and Team follow the
 * person's role. Badges count what is waiting on the person, never activity for its own sake.
 */
import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Wand2, Layers, CircleCheck, StickyNote, Users, Settings, Plus, Download } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp, spaceScope, type View } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useInboxBadge } from '@/stores/inbox'
import { useNotes } from '@/stores/notes'
import { useMaestro } from '@/stores/maestro'
import { useGuided, useWords, cap } from '@/lib/guided'
import { tokens } from '@/lib/theme'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { UpdateCard } from './UpdateCard'
import { useUpdates, updateNeedsYou } from '@/stores/updates'

/** Views that belong to each rail place, so the right item lights up wherever the person is. */
/** On macOS the window buttons sit at the top of the rail, so it is wide enough to hold them with a margin each side. */
const MAC = api.platform === 'darwin'
const BUILD_VIEWS: View[] = ['workspace', 'agents']
const REVIEW_VIEWS: View[] = ['reviews', 'oncall']

export function Rail(): React.JSX.Element {
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const select = useApp((s) => s.select)
  const openSettings = useApp((s) => s.openSettings)
  const account = useApp((s) => s.settings.cloud?.account)
  const guided = useGuided()
  const t = useWords()
  // Prompts from real workspaces only; Maestro's own questions ("maestro:<id>") are answered in its conversation.
  const waiting = useChat((s) => s.permissions.filter((p) => !p.workspaceId.startsWith('maestro:')).length + s.questions.filter((q) => !q.workspaceId.startsWith('maestro:')).length)
  // What waits on the person in the review inbox; guided people don't see Review, so nothing loads for them.
  const reviews = useInboxBadge(!guided)
  const maestroBusy = useMaestro((s) => Object.values(s.byId).some((c) => c.busy))
  // Only what is due: overdue or due today. A count of every open to-do (often 100+) says nothing.
  const due = useNotes((s) => {
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    let n = 0
    for (const list of Object.values(s.byWorkspace)) for (const x of list) if (x.due && x.due <= today && !x.done && !x.archived && x.kind !== 'decision' && x.kind !== 'rule') n += 1
    return n
  })
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
    <nav aria-label="Main" className={clsx('drag flex shrink-0', MAC ? 'w-[84px]' : 'w-[72px]', 'flex-col items-center gap-1 border-r border-border bg-panel pb-3 pt-[52px]')}>
      <RailItem tour="maestro" label="Maestro" hint="Maestro, your home (⌘J opens it on any screen)" active={view === 'maestro' || view === 'home'} maestro onClick={() => setView('maestro')} icon={<Wand2 size={19} />} dot={maestroBusy} />
      <RailItem tour="build" label={guided ? cap(t.workspaces) : 'Build'} hint={guided ? 'Your tasks' : 'Workspaces and agents'} active={BUILD_VIEWS.includes(view)} onClick={() => select(null)} icon={<Layers size={19} />} count={waiting} countLabel={`${waiting} waiting on you`} />
      {showReview && <RailItem tour="reviews" label="Review" hint="Reviews and on-call" active={REVIEW_VIEWS.includes(view)} onClick={() => setView('reviews')} icon={<CircleCheck size={19} />} count={reviews} countLabel={`${reviews} waiting on you`} />}
      <RailItem tour="notes-all" label="Notes" hint="To-dos, findings, decisions and rules" active={view === 'notes'} onClick={() => setView('notes')} icon={<StickyNote size={19} />} count={due} countLabel={`${due} due`} />
      {showTeam && <RailItem tour="team" label="Team" hint="Apps, people, guardrails, connections, plan" active={view === 'team'} onClick={() => setView('team')} icon={<Users size={19} />} />}
      <div className="flex-1" />
      <UpdateItem />
      <SpaceSwitcher />
      <RailItem tour="settings" label="Settings" hint="Your settings (⌘,)" active={false} onClick={() => openSettings({ scope: 'app', page: 'preferences' })} icon={<Settings size={19} />} quiet />
    </nav>
  )
}

function RailItem({ label, hint, icon, active, onClick, count = 0, countLabel, quiet, maestro, dot, dotLabel, tour }: { label: string; hint: string; icon: React.ReactNode; active: boolean; onClick: () => void; count?: number; countLabel?: string; quiet?: boolean; maestro?: boolean; dot?: boolean; dotLabel?: string; tour?: string }): React.JSX.Element {
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
        <span aria-label={countLabel} className={clsx('absolute right-2 top-1 min-w-4 rounded-full px-1 text-center text-[11px] font-bold leading-4', quiet ? 'bg-panel-2 text-muted' : 'bg-warn text-on-warn')}>
          {count > 99 ? '99+' : count}
        </span>
      )}
      {dot && <span aria-label={dotLabel ?? 'Maestro is working'} className={clsx('absolute right-3 top-1.5 h-2 w-2 rounded-full', maestro ? 'animate-pulse bg-maestro' : 'bg-warn')} />}
    </button>
  )
}

/**
 * The space on every screen: its colour dot and short name above Settings, opening a menu of spaces with their
 * ⌃1…⌃9 shortcuts. Guided people see it only when they belong to more than one team.
 */
function SpaceSwitcher(): React.JSX.Element | null {
  const guided = useGuided()
  const t = useWords()
  const spaces = useApp((s) => s.spaces)
  const setActiveSpace = useApp((s) => s.setActiveSpace)
  const openSettings = useApp((s) => s.openSettings)
  // Only the ids and the current one: a new array from the selector would re-render on every store change.
  const idsKey = useApp((s) => spaceScope(s).ids.join('\u0000'))
  const currentId = useApp((s) => spaceScope(s).currentId)
  const ids = idsKey.split('\u0000')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLButtonElement>(null)
  if (guided && ids.length < 2) return null
  const nameOf = (id: string): string => spaces.find((s) => s.id === id)?.name ?? (spaces.length ? `No ${t.space}` : cap(t.spaces))
  const colorOf = (id: string): string => spaces.find((s) => s.id === id)?.color ?? tokens.muted
  const name = nameOf(currentId)
  const entries: MenuEntry[] = ids.map((id, i) => ({
    label: nameOf(id),
    icon: <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorOf(id) }} />,
    hint: i < 9 ? `⌃${i + 1}` : undefined,
    current: id === currentId,
    onClick: () => setActiveSpace(id)
  }))
  if (!guided) entries.push({ separator: true }, { label: 'New space…', icon: <Plus size={14} />, onClick: () => openSettings({ scope: 'app', page: 'spaces' }) })
  const toggle = (): void => {
    if (menu) return setMenu(null)
    const r = ref.current?.getBoundingClientRect()
    if (r) setMenu({ x: r.right + 6, y: r.top })
  }
  return (
    <>
      <button
        ref={ref}
        type="button"
        data-tour="space-switcher"
        aria-label={`${cap(t.space)}: ${name}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        title={`${cap(t.space)}: ${name} (⌃1…⌃9 to switch)`}
        // Pressing while the menu is open would close it on mousedown and reopen it on click; swallow that press.
        onMouseDown={(e) => menu && e.stopPropagation()}
        onClick={toggle}
        className={clsx('no-drag mx-1.5 flex flex-col items-center gap-1 self-stretch rounded-lg px-1 py-2 text-[11px] font-medium transition-colors', menu ? 'bg-panel-2 text-text' : 'text-muted hover:bg-panel-2/60 hover:text-text')}
      >
        <span aria-hidden className="h-3 w-3 rounded-full ring-2 ring-panel-2" style={{ background: colorOf(currentId) }} />
        <span className="max-w-full truncate">{name}</span>
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} label={cap(t.spaces)} entries={entries} onClose={() => setMenu(null)} />}
    </>
  )
}

/** A new release that needs the person (download, restart, or a failure): one Rail item opening the update card. */
function UpdateItem(): React.JSX.Element | null {
  const info = useUpdates((s) => s.info)
  const dismissed = useUpdates((s) => s.dismissed)
  const subscribe = useUpdates((s) => s.subscribe)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => subscribe(), [subscribe])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  if (!info || (!updateNeedsYou(info, dismissed) && !open)) return null
  const label = info.state === 'ready' ? 'Restart' : info.state === 'error' ? 'Update failed' : info.state === 'downloading' ? `${info.percent ?? 0}%` : 'Update'
  const hint = info.state === 'ready' ? `Sinfonie ${info.version} is ready: restart to update` : info.state === 'error' ? `Sinfonie ${info.version} could not be installed` : `Sinfonie ${info.version} is available`
  return (
    <div ref={ref} className="relative">
      <RailItem label={label} hint={hint} active={open} onClick={() => setOpen(!open)} icon={<Download size={19} />} dot={info.state === 'ready' || info.state === 'error'} dotLabel={hint} />
      {open && (
        <div role="dialog" aria-label="Sinfonie update" className="no-drag fixed bottom-16 z-50 w-[300px] rounded-lg bg-panel shadow-xl" style={{ left: MAC ? 90 : 78 }}>
          <UpdateCard info={info} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}
