import type { PermissionMode, Settings, Space, Workspace } from '@shared/types'

/**
 * The permission mode a session runs with: workspace, then space, then app default. In guided mode a person
 * never sees a command, so the classifier decides (Auto) whatever the expert settings say.
 */
export function effectivePermissionMode(ws: Pick<Workspace, 'permissionMode'>, space: Pick<Space, 'permissionMode'> | undefined, settings: Settings): PermissionMode {
  if (settings.mode === 'guided') return 'auto'
  return ws.permissionMode ?? space?.permissionMode ?? settings.permissionMode
}
