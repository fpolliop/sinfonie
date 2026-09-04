import { create } from 'zustand'
import type { ResourceSnapshot } from '@shared/types'
import { api } from '@/lib/api'

interface ResourcesState {
  snapshot: ResourceSnapshot | null
}
export const useResources = create<ResourcesState>(() => ({ snapshot: null }))

let subscribed = false
/** Start following the governor's samples; safe to call from several components. */
export function subscribeResources(): void {
  if (subscribed) return
  subscribed = true
  api.invoke('resources:get').then((snapshot) => useResources.setState({ snapshot })).catch(() => undefined)
  api.on('resources:snapshot', (snapshot) => useResources.setState({ snapshot }))
}

export function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
