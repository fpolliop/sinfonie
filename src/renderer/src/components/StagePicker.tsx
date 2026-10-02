import React, { useState } from 'react'
import clsx from 'clsx'
import { ChevronDown } from 'lucide-react'
import { type WorkspaceStage } from '@shared/types'
import { chipCls } from './ui'
import { useGuided, stageLabel as label } from '@/lib/guided'
import { useApp, useSelectedWorkspace } from '@/stores/app'
import { stageDot, stagePill, useStages } from '@/lib/stages'
import { WorkspaceStatusesDialog } from './WorkspaceStatusesDialog'

const EDIT = '__edit_statuses__'

export function stageLabel(stage: WorkspaceStage): string {
  return label(stage, false)
}

/** Coloured pill with a native select underneath, so it works with keyboard and screen readers. */
export function StagePicker({ stage, onChange, disabled }: { stage: WorkspaceStage; onChange: (s: WorkspaceStage) => void; disabled?: boolean }): React.JSX.Element {
  const guided = useGuided()
  // Team guardrail (Team → Guardrails, "Require a review"): builders are stopped in the main process; experts get this chip.
  const ws = useSelectedWorkspace()
  const requireReview = useApp((s) => Boolean(s.spaces.find((sp) => sp.id === ws?.spaceId)?.rules?.requireReview))
  const unreviewed = !guided && requireReview && !ws?.reviewRequestedAt
  const options = useStages(ws?.spaceId)
  const [editing, setEditing] = useState(false)
  return (
    <>
      <label className={clsx(chipCls, 'no-drag relative shrink-0 cursor-pointer', stagePill(stage), disabled && 'opacity-60')} title={guided ? 'Where this task is' : 'Workspace status'}>
        <span className={clsx('h-1.5 w-1.5 rounded-full', stageDot(stage))} />
        {label(stage, guided)}
        <ChevronDown size={11} className="-mr-0.5 opacity-60" />
        <select className="absolute inset-0 cursor-pointer opacity-0" value={stage} disabled={disabled} onChange={(e) => (e.target.value === EDIT ? setEditing(true) : onChange(e.target.value as WorkspaceStage))}>
          {/* Guided: "Live" is set by the app once the change is out; it cannot be picked by hand. */}
          {options.map((s) => (
            <option key={s.id} value={s.id} disabled={guided && s.id === 'done' && stage !== 'done'}>
              {s.builtin ? label(s.id, guided) : s.label}
              {guided && s.id === 'done' && stage !== 'done' ? ' (set automatically)' : ''}
            </option>
          ))}
          {!guided && <option value={EDIT}>Edit statuses…</option>}
        </select>
      </label>
      {unreviewed && stage === 'done' && (
        <span className={clsx(chipCls, 'shrink-0 bg-warn/15 text-warn')} title="Your team requires a review before work is done; no pull request was opened from this workspace.">
          Not reviewed
        </span>
      )}
      {editing && <WorkspaceStatusesDialog spaceId={ws?.spaceId} onClose={() => setEditing(false)} />}
    </>
  )
}
