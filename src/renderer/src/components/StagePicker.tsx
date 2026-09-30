import React from 'react'
import clsx from 'clsx'
import { ChevronDown } from 'lucide-react'
import { WORKSPACE_STAGES, type WorkspaceStage } from '@shared/types'
import { chipCls } from './ui'
import { useGuided, stageLabel as label, stages } from '@/lib/guided'
import { useApp, useSelectedWorkspace } from '@/stores/app'

export const STAGE_TONE: Record<WorkspaceStage, string> = {
  todo: 'text-muted bg-panel-2',
  'in-progress': 'text-accent bg-accent/15',
  'on-hold': 'text-muted bg-warn/10',
  'in-review': 'text-warn bg-warn/15',
  done: 'text-ok bg-ok/15'
}

export const STAGE_DOT: Record<WorkspaceStage, string> = {
  todo: 'bg-muted',
  'in-progress': 'bg-accent',
  'on-hold': 'bg-warn/50',
  'in-review': 'bg-warn',
  done: 'bg-ok'
}

export function stageLabel(stage: WorkspaceStage): string {
  return WORKSPACE_STAGES.find((s) => s.id === stage)?.label ?? stage
}

/** Coloured pill with a native select underneath, so it works with keyboard and screen readers. */
export function StagePicker({ stage, onChange, disabled }: { stage: WorkspaceStage; onChange: (s: WorkspaceStage) => void; disabled?: boolean }): React.JSX.Element {
  const guided = useGuided()
  // Team guardrail (Team → Guardrails, "Require a review"): builders are stopped in the main process; experts get this chip.
  const ws = useSelectedWorkspace()
  const requireReview = useApp((s) => Boolean(s.spaces.find((sp) => sp.id === ws?.spaceId)?.rules?.requireReview))
  const unreviewed = !guided && requireReview && !ws?.reviewRequestedAt
  return (
    <>
      <label className={clsx(chipCls, 'no-drag relative shrink-0 cursor-pointer', STAGE_TONE[stage], disabled && 'opacity-60')} title={guided ? 'Where this task is' : 'Workspace stage'}>
        <span className={clsx('h-1.5 w-1.5 rounded-full', STAGE_DOT[stage])} />
        {label(stage, guided)}
        <ChevronDown size={11} className="-mr-0.5 opacity-60" />
        <select className="absolute inset-0 cursor-pointer opacity-0" value={stage} disabled={disabled} onChange={(e) => onChange(e.target.value as WorkspaceStage)}>
          {/* Guided: "Live" is set by the app once the change is out; it cannot be picked by hand. */}
          {stages(guided).map((s) => (
            <option key={s.id} value={s.id} disabled={guided && s.id === 'done' && stage !== 'done'}>
              {s.label}
              {guided && s.id === 'done' && stage !== 'done' ? ' (set automatically)' : ''}
            </option>
          ))}
        </select>
      </label>
      {unreviewed && stage === 'done' && (
        <span className={clsx(chipCls, 'shrink-0 bg-warn/15 text-warn')} title="Your team requires a review before work is done; no pull request was opened from this workspace.">
          Not reviewed
        </span>
      )}
    </>
  )
}
