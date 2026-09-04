/**
 * Per-workspace browser tabs, shown in the Browser pane and driven by agents. Only the active tab of
 * the selected workspace is attached to the window, at the bounds the renderer reports.
 */
import { BrowserWindow, type Rectangle } from 'electron'
import { nanoid } from 'nanoid'
import { BrowserTab } from './driver'
import { getWorkspace } from '../workspaces'
import type { BrowserState } from '@shared/types'

interface WsBrowser {
  tabs: BrowserTab[]
  activeId: string | null
  bounds: Rectangle | null
  attachedId: string | null
  agentOps: number
  lastAgentAt: number
  paused: boolean
}

const state = new Map<string, WsBrowser>()
let mainWindow: BrowserWindow | null = null
let emitState: ((s: BrowserState) => void) | null = null
let emitAgentActive: ((workspaceId: string) => void) | null = null

export function setWindow(win: BrowserWindow): void {
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
}
export function setEmitters(onState: (s: BrowserState) => void, onAgentActive: (workspaceId: string) => void): void {
  emitState = onState
  emitAgentActive = onAgentActive
}

function get(workspaceId: string): WsBrowser {
  let s = state.get(workspaceId)
  if (!s) state.set(workspaceId, (s = { tabs: [], activeId: null, bounds: null, attachedId: null, agentOps: 0, lastAgentAt: 0, paused: false }))
  return s
}
function partitionFor(workspaceId: string): string {
  try {
    const ws = getWorkspace(workspaceId)
    return `persist:browser-${ws.spaceId || 'default'}`
  } catch {
    return 'persist:browser-default'
  }
}

export function snapshot(workspaceId: string): BrowserState {
  const s = get(workspaceId)
  return {
    workspaceId,
    tabs: s.tabs.map((t) => ({ id: t.id, url: t.url(), title: t.title() || t.url() || 'New tab', loading: !t.wc.isDestroyed() && t.wc.isLoading() })),
    activeId: s.activeId,
    agentBusy: s.agentOps > 0 || Date.now() - s.lastAgentAt < 1500,
    paused: s.paused
  }
}
function publish(workspaceId: string): void {
  emitState?.(snapshot(workspaceId))
}

/** Attach the active tab's view at the reported bounds; detach everything else. */
function sync(workspaceId: string): void {
  const win = mainWindow
  const s = get(workspaceId)
  if (!win || win.isDestroyed()) return
  const active = s.tabs.find((t) => t.id === s.activeId) ?? null
  for (const t of s.tabs) {
    const show = t === active && s.bounds && s.bounds.width > 0 && s.bounds.height > 0
    if (show) {
      if (s.attachedId !== t.id) {
        win.contentView.addChildView(t.view)
        s.attachedId = t.id
      }
      t.view.setBounds(s.bounds!)
    } else if (s.attachedId === t.id) {
      win.contentView.removeChildView(t.view)
      s.attachedId = null
    }
  }
  if (s.attachedId && !s.tabs.some((t) => t.id === s.attachedId)) s.attachedId = null
}

export function newTab(workspaceId: string, url?: string): BrowserTab {
  const s = get(workspaceId)
  const tab = new BrowserTab(nanoid(6), partitionFor(workspaceId), (u) => void newTab(workspaceId, u).navigate(u))
  tab.onChange = () => publish(workspaceId)
  s.tabs.push(tab)
  s.activeId = tab.id
  sync(workspaceId)
  publish(workspaceId)
  if (url) void tab.navigate(url).catch(() => publish(workspaceId))
  return tab
}
export function selectTab(workspaceId: string, tabId: string): void {
  const s = get(workspaceId)
  if (s.tabs.some((t) => t.id === tabId)) s.activeId = tabId
  sync(workspaceId)
  publish(workspaceId)
}
export function closeTab(workspaceId: string, tabId: string): void {
  const s = get(workspaceId)
  const i = s.tabs.findIndex((t) => t.id === tabId)
  if (i < 0) return
  const [tab] = s.tabs.splice(i, 1)
  if (s.attachedId === tab.id && mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(tab.view)
  if (s.attachedId === tab.id) s.attachedId = null
  tab.destroy()
  if (s.activeId === tabId) s.activeId = s.tabs[Math.min(i, s.tabs.length - 1)]?.id ?? null
  sync(workspaceId)
  publish(workspaceId)
}
export function setBounds(workspaceId: string, bounds: Rectangle | null): void {
  const s = get(workspaceId)
  s.bounds = bounds ? { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) } : null
  sync(workspaceId)
}
/** Hide every workspace's view (e.g. a modal dialog is open) without forgetting bounds. */
export function hideAll(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  for (const [id, s] of state) {
    if (s.attachedId) {
      const t = s.tabs.find((x) => x.id === s.attachedId)
      if (t) mainWindow.contentView.removeChildView(t.view)
      s.attachedId = null
    }
    void id
  }
}

export function activeTab(workspaceId: string): BrowserTab {
  const s = get(workspaceId)
  return s.tabs.find((t) => t.id === s.activeId) ?? newTab(workspaceId)
}
export function tabById(workspaceId: string, tabId?: string): BrowserTab {
  if (!tabId) return activeTab(workspaceId)
  const t = get(workspaceId).tabs.find((x) => x.id === tabId)
  if (!t) throw new Error(`No tab ${tabId}. Use browser_tabs to list them.`)
  return t
}

export function setPaused(workspaceId: string, paused: boolean): void {
  get(workspaceId).paused = paused
  publish(workspaceId)
}

/**
 * Run one agent action: waits while the user has paused agent control, marks the pane busy, and
 * tells the renderer when a burst of activity starts so it can bring the Browser tab forward.
 */
export async function agentOp<T>(workspaceId: string, fn: (tab: BrowserTab) => Promise<T>, tabId?: string): Promise<T> {
  const s = get(workspaceId)
  const start = Date.now()
  while (s.paused) {
    if (Date.now() - start > 5 * 60_000) throw new Error('The user paused agent control of the browser and did not resume within 5 minutes.')
    await new Promise((r) => setTimeout(r, 500))
  }
  if (Date.now() - s.lastAgentAt > 30_000) emitAgentActive?.(workspaceId)
  s.agentOps++
  s.lastAgentAt = Date.now()
  publish(workspaceId)
  try {
    return await fn(tabById(workspaceId, tabId))
  } finally {
    s.agentOps--
    s.lastAgentAt = Date.now()
    publish(workspaceId)
    setTimeout(() => publish(workspaceId), 1600)
  }
}

export function closeWorkspace(workspaceId: string): void {
  const s = state.get(workspaceId)
  if (!s) return
  for (const t of [...s.tabs]) closeTab(workspaceId, t.id)
  state.delete(workspaceId)
}
export function closeAll(): void {
  for (const id of Array.from(state.keys())) closeWorkspace(id)
}
