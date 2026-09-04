import { create } from 'zustand'
import type { OnCallState } from '@shared/types'
import { api } from '@/lib/api'

interface OnCallStore {
  state: OnCallState | null
  selectedId: string | null
  filter: 'open' | 'all'
  select: (id: string | null) => void
  setFilter: (f: 'open' | 'all') => void
}
export const useOnCall = create<OnCallStore>((set) => ({
  state: null,
  selectedId: null,
  filter: 'open',
  select: (selectedId) => set({ selectedId }),
  setFilter: (filter) => set({ filter })
}))

let subscribed = false
export function subscribeOnCall(): void {
  if (subscribed) return
  subscribed = true
  api.invoke('oncall:state').then((state) => useOnCall.setState({ state })).catch(() => undefined)
  api.on('oncall:changed', (state) => useOnCall.setState({ state }))
}
