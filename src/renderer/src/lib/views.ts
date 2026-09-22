import { useMemo } from 'react'
import { useApp, spaceOrder } from '@/stores/app'
import type { ScopedView, Settings, Space, ViewSlot } from '@shared/types'

/**
 * The views a user sees in a slot for a space: their personal ones, then the space's (shared) ones
 * they have not hidden or replaced. A personal copy of a space view shows only in that space.
 */
export function visibleViews(slot: ViewSlot, spaceId: string | undefined, settings: Settings, spaces: Space[]): ScopedView[] {
  const overrides = settings.viewOverrides ?? {}
  const spaceOfView = new Map(spaces.flatMap((s) => (s.views ?? []).map((v) => [v.id, s.id] as const)))
  const personal = (settings.views ?? [])
    .filter((v) => v.slot === slot && (!v.basedOn || !spaceOfView.has(v.basedOn) || spaceOfView.get(v.basedOn) === spaceId))
    .map((v): ScopedView => ({ ...v, scope: { kind: 'user' } }))
  const space = spaces.find((s) => s.id === spaceId)
  const shared = (space?.views ?? []).filter((v) => v.slot === slot && !overrides[v.id]).map((v): ScopedView => ({ ...v, scope: { kind: 'space', spaceId: space!.id } }))
  return [...personal, ...shared]
}

/** Every view by id, personal and in every space. */
export function findView(id: string, settings: Settings, spaces: Space[]): ScopedView | undefined {
  const mine = settings.views?.find((v) => v.id === id)
  if (mine) return { ...mine, scope: { kind: 'user' } }
  for (const s of spaces) {
    const v = s.views?.find((x) => x.id === id)
    if (v) return { ...v, scope: { kind: 'space', spaceId: s.id } }
  }
  return undefined
}

/** The space the sidebar shows (same fallback as the sidebar: the first space when none is set). */
export function useCurrentSpaceId(): string {
  const activeSpaceId = useApp((s) => s.activeSpaceId)
  const spaces = useApp((s) => s.spaces)
  const workspaces = useApp((s) => s.workspaces)
  return useMemo(() => {
    const ids = spaceOrder(
      spaces.map((s) => s.id),
      workspaces.some((w) => w.status !== 'archived' && (!w.spaceId || !spaces.some((s) => s.id === w.spaceId)))
    )
    return ids.includes(activeSpaceId) ? activeSpaceId : (ids[0] ?? '')
  }, [activeSpaceId, spaces, workspaces])
}
