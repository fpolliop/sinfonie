/**
 * Workspace statuses in the renderer: the built-in stages plus a space's own (feedback #62), in board
 * order, with the label and colours each one shows. Every surface that lists or colours a stage
 * goes through here so a custom status looks the same everywhere.
 */
import { useMemo } from 'react'
import { anchorOf, isBuiltinStage, statusesFor, workspaceStages, type BuiltinStage, type StageInfo, type WorkspaceStage, type WorkspaceStatusDef } from '@shared/types'
import { useApp } from '@/stores/app'

/** The statuses a space's workspaces can be in, in board order. */
export function useStages(spaceId: string | undefined): StageInfo[] {
  const settings = useApp((s) => s.settings)
  const spaces = useApp((s) => s.spaces)
  return useMemo(() => workspaceStages(statusesFor(spaceId, { settings, spaces })), [spaceId, settings, spaces])
}

/** The space's own statuses (not the built-ins), as stored. */
export function useCustomStatuses(spaceId: string | undefined): WorkspaceStatusDef[] {
  const settings = useApp((s) => s.settings)
  const spaces = useApp((s) => s.spaces)
  return useMemo(() => statusesFor(spaceId, { settings, spaces }), [spaceId, settings, spaces])
}

/** A custom status by id, wherever it is defined (ids are unique across spaces). Read at render time. */
export function customStatus(id: string | undefined): WorkspaceStatusDef | undefined {
  if (!id || isBuiltinStage(id)) return undefined
  const { settings, spaces } = useApp.getState()
  return [...(settings.workspaceStatuses ?? []), ...spaces.flatMap((s) => s.workspaceStatuses ?? [])].find((c) => c.id === id)
}

/** The built-in stage a workspace's status belongs to (itself for a built-in). */
export function anchorStage(stage: WorkspaceStage | undefined, spaceId: string | undefined): BuiltinStage {
  const { settings, spaces } = useApp.getState()
  return anchorOf(stage, statusesFor(spaceId, { settings, spaces }))
}

const BUILTIN_PILL: Record<BuiltinStage, string> = {
  todo: 'text-muted bg-panel-2',
  'in-progress': 'text-accent bg-accent/15',
  'on-hold': 'text-muted bg-warn/10',
  'in-review': 'text-warn bg-warn/15',
  done: 'text-ok bg-ok/15'
}
const BUILTIN_DOT: Record<BuiltinStage, string> = {
  todo: 'bg-muted',
  'in-progress': 'bg-accent',
  'on-hold': 'bg-warn/50',
  'in-review': 'bg-warn',
  done: 'bg-ok'
}
const TONE_PILL: Record<string, string> = {
  'text-accent': 'text-accent bg-accent/15',
  'text-warn': 'text-warn bg-warn/15',
  'text-ok': 'text-ok bg-ok/15',
  'text-danger': 'text-danger bg-danger/15',
  'text-muted': 'text-muted bg-panel-2'
}
const TONE_DOT: Record<string, string> = { 'text-accent': 'bg-accent', 'text-warn': 'bg-warn', 'text-ok': 'bg-ok', 'text-danger': 'bg-danger', 'text-muted': 'bg-muted' }

/** Colours a custom status may take, in the order the editor offers them. */
export const STATUS_TONES: { id: string; label: string }[] = [
  { id: 'text-accent', label: 'Blue' },
  { id: 'text-warn', label: 'Amber' },
  { id: 'text-ok', label: 'Green' },
  { id: 'text-danger', label: 'Red' },
  { id: 'text-muted', label: 'Grey' }
]

/** Pill classes (text and background) for a stage. */
export function stagePill(stage: WorkspaceStage | undefined): string {
  if (isBuiltinStage(stage)) return BUILTIN_PILL[stage]
  return TONE_PILL[customStatus(stage)?.tone ?? 'text-accent'] ?? TONE_PILL['text-accent']
}

/** Dot class for a stage. */
export function stageDot(stage: WorkspaceStage | undefined): string {
  if (isBuiltinStage(stage)) return BUILTIN_DOT[stage]
  return TONE_DOT[customStatus(stage)?.tone ?? 'text-accent'] ?? 'bg-accent'
}
