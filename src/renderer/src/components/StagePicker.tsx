import React from 'react'
import clsx from 'clsx'
import { WORKSPACE_STAGES, type WorkspaceStage } from '@shared/types'

export const STAGE_TONE: Record<WorkspaceStage, string> = {
  todo: 'text-muted bg-panel-2',
  'in-progress': 'text-accent bg-accent/15',
  'in-review': 'text-warn bg-warn/15',
  done: 'text-ok bg-ok/15'
}

export const STAGE_DOT: Record<WorkspaceStage, string> = {
  todo: 'bg-muted',
  'in-progress': 'bg-accent',
  'in-review': 'bg-warn',
  done: 'bg-ok'
}

export function stageLabel(stage: WorkspaceStage): string {
  return WORKSPACE_STAGES.find((s) => s.id === stage)?.label ?? stage
}

/** Coloured pill with a native select underneath, so it works with keyboard and screen readers. */
export function StagePicker({ stage, onChange, disabled }: { stage: WorkspaceStage; onChange: (s: WorkspaceStage) => void; disabled?: boolean }): React.JSX.Element {
  return (
    <label className={clsx('no-drag relative inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium', STAGE_TONE[stage], disabled && 'opacity-60')} title="Workspace stage">
      <span className={clsx('h-1.5 w-1.5 rounded-full', STAGE_DOT[stage])} />
      {stageLabel(stage)}
      <span className="opacity-60">▾</span>
      <select className="absolute inset-0 cursor-pointer opacity-0" value={stage} disabled={disabled} onChange={(e) => onChange(e.target.value as WorkspaceStage)}>
        {WORKSPACE_STAGES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  )
}
