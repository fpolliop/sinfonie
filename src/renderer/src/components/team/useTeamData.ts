/**
 * Team console data from the main process: each app's key in the look-only list (its remote, else its name), and
 * today's spend in the space on this Mac (local day). Both refresh when the store or the usage ledger changes.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useUsage, subscribeUsage } from '@/stores/usage'
import type { Repo, Space } from '@shared/types'

export function useAppKeys(spaceId: string | undefined): Record<string, string> {
  const repoCount = useApp((s) => s.repos.length)
  const [keys, setKeys] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!spaceId) return
    let live = true
    api
      .invoke('team:appKeys', spaceId)
      .then((k) => live && setKeys(k))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [spaceId, repoCount])
  return keys
}

/** Whether builders may only look at this app, by the same keys the main process uses. */
export function isLookOnly(space: Space, repo: Repo, keys: Record<string, string>): boolean {
  const list = space.rules?.builderReadOnly ?? []
  return list.includes(repo.name) || Boolean(keys[repo.id] && list.includes(keys[repo.id]))
}

interface SpendStatus {
  spent: number
  limit?: number
  lifted: boolean
  day: string
}
export function useSpend(space: Space | undefined): SpendStatus | null {
  const snap = useUsage((s) => s.snapshot)
  const [status, setStatus] = useState<SpendStatus | null>(null)
  useEffect(() => subscribeUsage(), [])
  useEffect(() => {
    if (!space) return setStatus(null)
    let live = true
    api
      .invoke('team:spend', space.id)
      .then((st) => live && setStatus(st))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [space, snap])
  return status
}
