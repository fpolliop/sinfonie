import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronUp, TerminalSquare } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp, INSPECTOR_DEFAULT, INSPECTOR_MAX, INSPECTOR_MIN, type Tab } from '@/stores/app'
import { useScripts } from '@/stores/scripts'
import { useGuided } from '@/lib/guided'
import { ChangesTab } from './ChangesTab'
import { BrowserPane } from './BrowserPane'
import { PrsPane } from './PrsPane'
import { TerminalPane, useTerminalSummary } from './TerminalPane'
import { RunPane } from './RunPane'
import { DataPane } from './DataPane'
import { WorkspaceTabs, WorkspaceTabsRail, paneOf, usePanes, type Pane } from './WorkspaceTabs'
import { Segmented, hasOpenDialog } from './ui'
import { yieldsToEditor } from '@/lib/keys'

/** The conversation never gets narrower than this; the panel gives way first. */
const CHAT_MIN = 360
/** The collapsed panel's rail. */
const RAIL = 40
/** Narrower than this the panel is not useful beside the chat: it folds to its rail until there is room again. */
const FIT_MIN = 380

/** Workspaces whose terminal drawer is open, this session. Opening another workspace never starts a shell. */
const drawerOpen = new Set<string>()

/**
 * The right side of the workspace split: a tabbed inspector (Changes, Preview, Checks, Terminal, Data and any
 * generated views) that updates live, with a terminal strip along its bottom. Collapsed, or when the window is too
 * narrow for both, it is a rail of tab icons; from there it can show over the chat. `renderView` draws a generated
 * view tab, which lives with the workspace view.
 */
export function WorkspaceInspector({ workspaceId, renderView }: { workspaceId: string; renderView: (viewId: string) => React.ReactNode }): React.JSX.Element {
  const guided = useGuided()
  const tab = useApp((s) => s.tab)
  const open = useApp((s) => s.inspectorOpen)
  const width = useApp((s) => s.inspectorWidth)
  const panes = usePanes(workspaceId)
  // The tab on screen: the one asked for when this workspace and mode show it, else the first pane.
  const asked = paneOf(tab)
  const def = panes.find((p) => p.id === asked) ?? panes[0]
  const pane: Pane = def.id
  const shownTab: Tab = asked === pane ? tab : def.tab
  const asideRef = useRef<HTMLElement>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)

  // The split's real width (window, sidebar and Maestro dock all take from it), measured live.
  const [room, setRoom] = useState<number | null>(null)
  useLayoutEffect(() => {
    const box = anchorRef.current?.parentElement
    if (!box) return
    const measure = (): void => setRoom(box.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    return () => ro.disconnect()
  }, [])
  // What the panel can have without squeezing the chat below its minimum; the saved width is never changed here.
  const maxFit = room === null ? INSPECTOR_MAX : room - CHAT_MIN
  const fits = Math.min(width, maxFit)
  const cramped = open && fits < FIT_MIN
  // Folded for lack of room, the panel can still be shown on demand: over the chat, next to its rail.
  const [peek, setPeek] = useState(false)
  const peeking = peek && cramped
  const reveal = useApp((s) => s.inspectorReveal)
  const lastReveal = useRef(reveal)
  useEffect(() => {
    if (reveal === lastReveal.current) return
    lastReveal.current = reveal
    if (cramped) setPeek(true)
  }, [reveal, cramped])
  useEffect(() => {
    if (!cramped) setPeek(false)
  }, [cramped])
  useEffect(() => {
    if (!peeking) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !hasOpenDialog()) setPeek(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [peeking])
  const shown = open && (!cramped || peeking)
  const panelWidth = peeking ? Math.max(300, Math.min(width, (room ?? width) - RAIL - 48)) : fits

  // The terminal drawer under the current tab, per workspace for this session.
  const [drawer, setDrawerState] = useState(() => drawerOpen.has(workspaceId))
  const setDrawer = (v: boolean): void => {
    if (v) drawerOpen.add(workspaceId)
    else drawerOpen.delete(workspaceId)
    setDrawerState(v)
  }
  const hasStrip = !guided && pane !== 'terminal'
  // ⌃` from anywhere in the workspace: on the Terminal tab it focuses the shell; otherwise it opens the panel if
  // needed and toggles the drawer. Editors keep the key, and so does an open dialog.
  const keyState = useRef({ shown, pane, drawer, cramped, guided })
  keyState.current = { shown, pane, drawer, cramped, guided }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || (e.key !== '`' && e.code !== 'Backquote')) return
      if (hasOpenDialog() || yieldsToEditor(e)) return
      const st = keyState.current
      if (st.guided) return
      e.preventDefault()
      const app = useApp.getState()
      if (st.pane === 'terminal') {
        if (!st.shown) app.setTab(app.tab)
        requestAnimationFrame(() => document.querySelector<HTMLElement>('#ws-inspector-panel .xterm-helper-textarea')?.focus())
        return
      }
      if (!st.shown) {
        if (st.cramped) setPeek(true)
        else app.setInspectorOpen(true)
        setDrawer(true)
        return
      }
      setDrawer(!st.drawer)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  return (
    <>
      <span ref={anchorRef} hidden />
      {shown && !peeking && <SplitDivider target={asideRef} width={fits} max={maxFit} />}
      {/* The aside stays mounted while collapsed so the preview's agent hooks keep listening; hidden, it draws nothing. */}
      <aside
        ref={asideRef}
        className={clsx('@container flex h-full min-w-0 shrink-0 flex-col border-l border-border bg-panel', !shown && 'hidden', peeking && 'absolute bottom-0 top-0 z-20 shadow-2xl')}
        style={{ width: panelWidth, ...(peeking ? { right: RAIL } : {}) }}
        aria-label={guided ? 'Preview' : 'Workspace panel'}
      >
        {shown && <WorkspaceTabs workspaceId={workspaceId} current={pane} panes={panes} onCollapse={peeking ? () => setPeek(false) : undefined} />}
        <div id="ws-inspector-panel" role="tabpanel" aria-labelledby={`ws-tab-${pane}`} className="relative min-h-0 flex-1">
          {shown && pane === 'changes' && <ChangesTab workspaceId={workspaceId} tab={shownTab} visible={shown} />}
          <div className={clsx('h-full', pane !== 'preview' && 'hidden')}>
            <BrowserPane workspaceId={workspaceId} visible={shown && pane === 'preview'} />
          </div>
          {shown && pane === 'checks' && <PrsPane workspaceId={workspaceId} />}
          {shown && pane === 'terminal' && <TerminalTab workspaceId={workspaceId} tab={shownTab} />}
          {shown && pane === 'data' && <DataPane workspaceId={workspaceId} />}
          {shown && pane.startsWith('view:') && renderView(pane.slice(5))}
        </div>
        {shown && hasStrip && <TerminalStrip workspaceId={workspaceId} open={drawer} onToggle={() => setDrawer(!drawer)} />}
      </aside>
      {!shown || peeking ? <WorkspaceTabsRail workspaceId={workspaceId} panes={panes} cramped={cramped} quiet={peeking} onShow={() => setPeek(true)} /> : null}
    </>
  )
}

/**
 * The divider between the conversation and the panel: a 1px line with a 24px hit area. Drag it, or focus it and
 * use ←/→ (Shift for bigger steps); Home or a double-click resets. Widths are clamped to the room the chat leaves.
 * The width is applied straight to the panel while dragging and saved on release; the pointer is captured, so
 * letting go outside the window still ends the drag.
 */
function SplitDivider({ target, width, max }: { target: React.RefObject<HTMLElement | null>; width: number; max: number }): React.JSX.Element {
  const setWidth = useApp((s) => s.setInspectorWidth)
  const [dragging, setDragging] = useState(false)
  const latest = useRef(width)
  const maxRef = useRef(max)
  maxRef.current = max
  const clamp = (w: number): number => Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, maxRef.current, w))
  useEffect(() => {
    if (!dragging) return
    // The native preview page draws above the DOM and swallows pointer events; detach it while dragging.
    void api.invoke('browser:suspend', true)
    document.body.style.cursor = 'col-resize'
    return () => {
      void api.invoke('browser:suspend', false)
      document.body.style.cursor = ''
      setWidth(latest.current)
    }
  }, [dragging, setWidth])
  const onKey = (e: React.KeyboardEvent): void => {
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowLeft') setWidth(clamp(width + step))
    else if (e.key === 'ArrowRight') setWidth(clamp(width - step))
    else if (e.key === 'Home') setWidth(clamp(INSPECTOR_DEFAULT))
    else return
    e.preventDefault()
  }
  const end = (): void => setDragging(false)
  return (
    <div className="relative z-10 w-0 shrink-0">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the side panel"
        aria-valuemin={INSPECTOR_MIN}
        aria-valuemax={Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, max))}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize (or focus and use ← →). Double-click resets."
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          latest.current = width
          setDragging(true)
        }}
        onPointerMove={(e) => {
          if (!dragging) return
          const el = target.current
          const box = el?.parentElement?.getBoundingClientRect()
          if (!el || !box) return
          latest.current = clamp(box.right - e.clientX)
          el.style.width = `${latest.current}px`
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={() => setWidth(clamp(INSPECTOR_DEFAULT))}
        onKeyDown={onKey}
        className="group absolute inset-y-0 -left-3 flex w-6 cursor-col-resize justify-center outline-none"
      >
        <span aria-hidden className={clsx('h-full w-px transition-colors group-hover:bg-accent/60 group-focus-visible:w-0.5 group-focus-visible:bg-accent', dragging ? 'bg-accent' : 'bg-transparent')} />
      </div>
    </div>
  )
}

/** Terminal tab: the shells, and the setup and run scripts (what the Run button starts), one switch apart. */
function TerminalTab({ workspaceId, tab }: { workspaceId: string; tab: Tab }): React.JSX.Element {
  const setTab = useApp((s) => s.setTab)
  const sub = tab === 'run' ? 'scripts' : 'shells'
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[34px] shrink-0 items-center border-b border-border px-2">
        <Segmented
          size="sm"
          value={sub}
          onChange={(v) => setTab(v === 'scripts' ? 'run' : 'terminal')}
          options={[
            { id: 'shells', label: 'Shells' },
            { id: 'scripts', label: 'Setup and run scripts' }
          ]}
        />
      </div>
      <div className="min-h-0 flex-1">{sub === 'shells' ? <TerminalPane workspaceId={workspaceId} visible /> : <RunPane workspaceId={workspaceId} />}</div>
    </div>
  )
}

/**
 * The collapsed terminal along the bottom of the panel: the shell on screen and its latest line. It opens a
 * terminal drawer under the current tab (⌃`). The drawer's shell only starts once the drawer is open.
 */
function TerminalStrip({ workspaceId, open, onToggle }: { workspaceId: string; open: boolean; onToggle: () => void }): React.JSX.Element {
  const summary = useTerminalSummary(workspaceId)
  const ready = useApp((s) => s.workspaces.find((w) => w.id === workspaceId)?.status === 'ready')
  const runs = useScripts((s) => s.runs)
  const scriptRunning = Object.entries(runs).some(([k, r]) => k.startsWith(`${workspaceId}:`) && r.running)
  return (
    <>
      {open && (
        <div className="h-[40%] min-h-[160px] shrink-0 border-t border-border">
          <TerminalPane workspaceId={workspaceId} visible />
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-keyshortcuts="Control+`"
        disabled={!ready}
        onClick={onToggle}
        title={open ? 'Close the terminal (⌃`)' : 'Open the terminal here (⌃`)'}
        className="flex h-8 w-full shrink-0 items-center gap-2 border-t border-border px-3 text-left text-[12px] hover:bg-panel-2 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <TerminalSquare size={12} className="shrink-0 text-muted" aria-hidden />
        <span className="shrink-0 text-muted">Terminal</span>
        {summary ? (
          <span className="min-w-0 truncate font-mono text-[11px]">
            <span className="text-muted">{summary.label} ›</span> {summary.exited ? 'exited' : summary.line || 'ready'}
          </span>
        ) : (
          <span className="min-w-0 truncate text-muted">{ready ? 'No shell open yet' : 'Opens once the workspace is ready'}</span>
        )}
        {summary && summary.count > 1 && <span className="shrink-0 text-[11px] text-muted">+{summary.count - 1}</span>}
        {scriptRunning && <span role="img" aria-label="A script is running" className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted">
          <kbd className="font-sans text-[11px]">⌃`</kbd>
          <ChevronUp size={12} className={clsx('transition-transform', open && 'rotate-180')} aria-hidden />
        </span>
      </button>
    </>
  )
}
