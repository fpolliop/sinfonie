import { create } from 'zustand'
import type { Incident, IncidentStatus, OnCallState, Severity } from '@shared/types'
import { api } from '@/lib/api'

/** Status views for the incident list. 'needs' = triage says a human is needed, or a reply is drafted. */
export type OnCallView = 'open' | 'new' | 'needs' | 'waiting' | 'resolved' | 'all'
export interface OnCallFilters {
  view: OnCallView
  channel: string
  severity: Severity | ''
  kind: '' | Incident['kind']
  spaceId: string
  q: string
}
const OPEN = new Set<IncidentStatus>(['new', 'triaging', 'open', 'waiting'])
export const DEFAULT_FILTERS: OnCallFilters = { view: 'open', channel: '', severity: '', kind: '', spaceId: '', q: '' }

export function matchesFilters(i: Incident, f: OnCallFilters): boolean {
  if (f.view === 'open' && !OPEN.has(i.status)) return false
  if (f.view === 'new' && i.status !== 'new' && i.status !== 'triaging') return false
  if (f.view === 'needs' && !(OPEN.has(i.status) && (i.report?.needsHuman || i.proposals.some((p) => p.status === 'proposed')))) return false
  if (f.view === 'waiting' && i.status !== 'waiting') return false
  if (f.view === 'resolved' && i.status !== 'resolved' && i.status !== 'dismissed') return false
  if (f.channel && i.channelId !== f.channel) return false
  if (f.severity && i.severity !== f.severity) return false
  if (f.kind && i.kind !== f.kind) return false
  if (f.spaceId && i.spaceId !== f.spaceId) return false
  if (f.q) {
    const q = f.q.toLowerCase()
    const hay = `${i.title} ${i.channelName} ${i.report?.summary ?? ''} ${i.report?.category ?? ''}`.toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

interface OnCallStore {
  state: OnCallState | null
  selectedId: string | null
  filters: OnCallFilters
  /** Incident ids ticked for a bulk action. */
  checked: string[]
  select: (id: string | null) => void
  setFilters: (patch: Partial<OnCallFilters>) => void
  toggleChecked: (id: string) => void
  setChecked: (ids: string[]) => void
}
export const useOnCall = create<OnCallStore>((set) => ({
  state: null,
  selectedId: null,
  filters: DEFAULT_FILTERS,
  checked: [],
  select: (selectedId) => set({ selectedId }),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch }, checked: [] })),
  toggleChecked: (id) => set((s) => ({ checked: s.checked.includes(id) ? s.checked.filter((x) => x !== id) : [...s.checked, id] })),
  setChecked: (checked) => set({ checked })
}))

let subscribed = false
export function subscribeOnCall(): void {
  if (subscribed) return
  subscribed = true
  api.invoke('oncall:state').then((state) => useOnCall.setState({ state })).catch(() => undefined)
  api.on('oncall:changed', (state) =>
    useOnCall.setState((s) => {
      // Drop ticks for incidents that no longer exist (deleted elsewhere).
      const ids = new Set(state.incidents.map((i) => i.id))
      return { state, checked: s.checked.filter((id) => ids.has(id)) }
    })
  )
}
