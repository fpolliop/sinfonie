import { create } from 'zustand'
import type { UsageSnapshot } from '@shared/types'
import { api } from '@/lib/api'

interface UsageStore {
  snapshot: UsageSnapshot | null
}
export const useUsage = create<UsageStore>(() => ({ snapshot: null }))

let subscribed = false
export function subscribeUsage(): void {
  if (subscribed) return
  subscribed = true
  api.invoke('usage:get').then((snapshot) => useUsage.setState({ snapshot })).catch(() => undefined)
  api.on('usage:changed', (snapshot) => useUsage.setState({ snapshot }))
}

export const windowLabel = (t: string): string => (t === 'five_hour' ? '5-hour' : t === 'seven_day' ? 'weekly' : t === 'seven_day_opus' ? 'weekly Opus' : t === 'seven_day_sonnet' ? 'weekly Sonnet' : t.replace(/_/g, ' '))
export const clock = (iso?: string): string => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
export const fmtTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
