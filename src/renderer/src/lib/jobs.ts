/** Polls the Running list (feedback #65) while something on screen needs it. */
import { useCallback, useEffect, useState } from 'react'
import type { Job } from '@shared/types'
import { api } from '@/lib/api'

export function useJobs(intervalMs = 3000): { jobs: Job[]; refresh: () => void } {
  const [jobs, setJobs] = useState<Job[]>([])
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api
        .invoke('jobs:list')
        .then((j) => alive && setJobs(j))
        .catch(() => undefined)
    }
    // Always read once on open; after that, only poll while the window is visible, and catch up when it shows again.
    load()
    const t = window.setInterval(() => document.visibilityState === 'visible' && load(), intervalMs)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [intervalMs, nonce])
  return { jobs, refresh }
}

/** "4m", "1h 12m": how long something has run. */
export function elapsed(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** "in 25m", "at 14:30": when a scheduled run starts. */
export function untilText(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const m = Math.round((new Date(iso).getTime() - now) / 60000)
  if (m <= 0) return 'now'
  if (m < 60) return `in ${m}m`
  return `at ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}
