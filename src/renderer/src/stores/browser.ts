import { create } from 'zustand'
import type { BrowserState } from '@shared/types'
import { api } from '@/lib/api'

interface BrowserStore {
  states: Record<string, BrowserState>
}
export const useBrowser = create<BrowserStore>(() => ({ states: {} }))

let subscribed = false
export function subscribeBrowser(): void {
  if (subscribed) return
  subscribed = true
  api.on('browser:state', (s) => useBrowser.setState((st) => ({ states: { ...st.states, [s.workspaceId]: s } })))
}
export function loadBrowserState(workspaceId: string): void {
  api.invoke('browser:state', workspaceId).then((s) => useBrowser.setState((st) => ({ states: { ...st.states, [workspaceId]: s } }))).catch(() => undefined)
}
