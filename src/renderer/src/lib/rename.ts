import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { isGuided } from '@/lib/guided'
import { friendlyError } from '@/lib/errors'
import type { Workspace } from '@shared/types'

export function slugPreview(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace'
}

/**
 * Rename flow shared by the sidebar, the header and the menu: apply the new
 * name, and if it implies a different branch, ask whether to rename that too.
 * Guided mode never sees the branch question: the name changes and the branch stays put (the safe choice —
 * anything already sent for review keeps working).
 */
export async function renameWorkspace(ws: Workspace, newName: string): Promise<void> {
  const name = newName.trim()
  if (!name || name === ws.name) return
  const newSlug = slugPreview(name)
  const currentBranch = ws.repos[0]?.branch ?? ''
  if (!isGuided() && ws.status === 'ready' && newSlug !== currentBranch) {
    useApp.getState().setBranchPrompt({ workspaceId: ws.id, name, newSlug, currentBranch })
    return
  }
  try {
    await api.invoke('workspaces:rename', ws.id, name, { renameBranches: false })
  } catch (err) {
    useApp.getState().setError(friendlyError(err))
  }
}
