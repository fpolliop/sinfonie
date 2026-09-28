import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Search } from 'lucide-react'
import { useApp, type AppPage, type View } from '@/stores/app'
import { openMaestro } from '@/stores/maestro'
import { useGuided, words, cap } from '@/lib/guided'
import { workspaceLabel } from '@/lib/labels'
import { tabsFor } from './WorkspaceTabs'
import { Dialog } from './ui'

interface Command {
  id: string
  label: string
  group: string
  hint?: string
  run: () => void
}

/** Settings pages the palette offers, per mode. Guided only lists the pages guided mode has. */
const EXPERT_PAGES: [AppPage, string][] = [
  ['preferences', 'Preferences'],
  ['general', 'Agents & models'],
  ['accounts', 'Accounts'],
  ['providers', 'Model providers'],
  ['crew', 'Crew'],
  ['resources', 'Resources'],
  ['usage', 'Usage'],
  ['integrations', 'Integrations'],
  ['oncall', 'On call'],
  ['phone', 'Devices'],
  ['spaces', 'Spaces'],
  ['repos', 'Repositories'],
  ['plan', 'Plan'],
  ['feedback', 'Feedback & diagnostics'],
  ['about', 'About & updates']
]
const GUIDED_PAGES: [AppPage, string][] = [
  ['preferences', 'Preferences'],
  ['accounts', 'Sign-in'],
  ['plan', 'Account & team'],
  ['feedback', 'Feedback'],
  ['about', 'About & updates']
]

/** Loose match: every typed word appears in the label (or group), in any order. */
function matches(c: Command, q: string): boolean {
  const hay = `${c.label} ${c.group}`.toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w))
}

/**
 * ⌘K: every action by name. Mode-aware: guided mode lists only what guided mode shows, in its words. Type to
 * filter, ↑/↓ to move, Enter to run, Escape to close.
 */
export function CommandPalette({ onClose, onShortcuts }: { onClose: () => void; onShortcuts: () => void }): React.JSX.Element {
  const guided = useGuided()
  const t = words(guided)
  const workspaces = useApp((s) => s.workspaces)
  const spaces = useApp((s) => s.spaces)
  const selectedId = useApp((s) => s.selectedId)
  const dock = useApp((s) => s.browserDock)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo<Command[]>(() => {
    const st = useApp.getState
    const view = (v: View): void => st().setView(v)
    const out: Command[] = [
      { id: 'new', label: `${t.newWorkspace}…`, group: 'Actions', hint: '⇧⌘N', run: () => st().setShowNewWorkspace(true, st().activeSpaceId || undefined) },
      { id: 'settings', label: 'Open settings', group: 'Actions', hint: '⌘,', run: () => st().setShowSettings(true) },
      { id: 'feedback', label: 'Send feedback…', group: 'Actions', hint: '⇧⌘F', run: () => st().setFeedbackDialog('feedback') },
      { id: 'tour', label: 'Take the tour', group: 'Help', run: () => st().setOnboarding('tour') },
      { id: 'setup', label: 'Run setup again', group: 'Help', run: () => st().setOnboarding('setup') },
      { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Help', hint: '⌘/', run: onShortcuts }
    ]
    if (!guided) {
      out.push(
        { id: 'maestro', label: 'Maestro', group: 'Go to', hint: '⇧⌘A', run: () => void openMaestro() },
        { id: 'notes', label: 'Todos & notes', group: 'Go to', run: () => view('notes') },
        { id: 'reviews', label: 'Review cockpit', group: 'Go to', run: () => view('reviews') },
        { id: 'agents', label: 'Agents', group: 'Go to', run: () => view('agents') },
        { id: 'errors', label: 'Feedback & diagnostics…', group: 'Actions', run: () => st().setFeedbackDialog('errors') }
      )
    }
    if (selectedId) {
      tabsFor(guided, dock).forEach((tab, i) =>
        out.push({
          id: `tab:${tab.id}`,
          label: `Show ${tab.label}`,
          group: `This ${t.workspace}`,
          hint: `⌘${i + 1}`,
          run: () => {
            st().setView('workspace')
            st().setTab(tab.id)
          }
        })
      )
    }
    const spaceName = (id?: string): string => spaces.find((s) => s.id === id)?.name ?? ''
    workspaces
      .filter((w) => w.status !== 'archived')
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))
      .forEach((w) => out.push({ id: `ws:${w.id}`, label: workspaceLabel(w, guided), group: cap(t.workspaces), hint: spaceName(w.spaceId), run: () => st().select(w.id) }))
    for (const [page, label] of guided ? GUIDED_PAGES : EXPERT_PAGES) {
      out.push({ id: `page:${page}`, label: `Settings: ${label}`, group: 'Settings', run: () => st().openSettings({ scope: 'app', page }) })
    }
    if (!guided) for (const sp of spaces) out.push({ id: `space:${sp.id}`, label: `Space settings: ${sp.name}`, group: 'Settings', run: () => st().openSettings({ scope: 'space', spaceId: sp.id, page: 'general' }) })
    return out
  }, [guided, t, workspaces, spaces, selectedId, dock, onShortcuts])

  const shown = useMemo(() => (query.trim() ? commands.filter((c) => matches(c, query)) : commands), [commands, query])
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (c: Command | undefined): void => {
    if (!c) return
    onClose()
    c.run()
  }
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(shown.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(shown[active])
    }
  }
  const listId = 'command-palette-list'
  let lastGroup = ''
  return (
    <Dialog title="Commands" onClose={onClose} width={560}>
      <div className="-mt-1 mb-2 flex items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5 focus-within:border-accent">
        <Search size={14} className="shrink-0 text-muted" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={shown[active] ? `cmd-${shown[active].id}` : undefined}
          aria-label="Search commands"
          className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted"
          placeholder={guided ? 'Search tasks and actions…' : 'Search workspaces, actions and settings…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label="Commands" className="max-h-[52vh] overflow-auto">
        {shown.length === 0 && <div className="px-2 py-4 text-center text-[12px] text-muted">Nothing matches “{query}”.</div>}
        {shown.map((c, i) => {
          const header = c.group !== lastGroup ? c.group : null
          lastGroup = c.group
          return (
            <React.Fragment key={c.id}>
              {header && <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted first:pt-0">{header}</div>}
              <div
                id={`cmd-${c.id}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => run(c)}
                className={clsx('flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px]', i === active ? 'bg-accent/15 text-text' : 'text-text')}
              >
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {c.hint && <span className="shrink-0 text-[11px] text-muted">{c.hint}</span>}
              </div>
            </React.Fragment>
          )
        })}
      </div>
      <div className="mt-2 flex items-center gap-3 border-t border-border pt-2 text-[11px] text-muted">
        <span>↑↓ to move</span>
        <span>↵ to run</span>
        <span>esc to close</span>
      </div>
    </Dialog>
  )
}

/** ⌘/: every keyboard shortcut, in the mode's words. The list mirrors the handlers in App, the sidebar and the tabs. */
export function ShortcutSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const guided = useGuided()
  const t = words(guided)
  const rows: [string, string][] = [
    ['⌘K', 'Command palette'],
    ['⌘/', 'Keyboard shortcuts'],
    ['⇧⌘N or ⌘T', `${t.newWorkspace}`],
    ['⌘↵', guided ? 'Start the task (in New task)' : 'Send or start (in dialogs that say so)'],
    ['⌘,', 'Settings'],
    ['⇧⌘F', 'Send feedback'],
    ['⌘1…⌘9', guided ? 'Switch between Chat and Preview' : 'Switch workspace tabs'],
    ['⌥⌘↑ / ⌥⌘↓', `Previous / next ${t.workspace}`],
    ['⌥⌘← / ⌥⌘→', `Previous / next ${t.space}`],
    ['⌃1…⌃9', `Jump to a ${t.space}`],
    ...(guided ? [] : ([['⇧⌘A', 'Maestro'], ['F2', 'Rename the focused workspace in the sidebar']] as [string, string][])),
    ['Esc', 'Close a dialog or menu']
  ]
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={460}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13px]">
        {rows.map(([keys, what]) => (
          <React.Fragment key={keys}>
            <dt>
              <kbd className="rounded border border-border bg-panel-2 px-1.5 py-0.5 font-sans text-[11px]">{keys}</kbd>
            </dt>
            <dd className="text-muted">{what}</dd>
          </React.Fragment>
        ))}
      </dl>
    </Dialog>
  )
}
