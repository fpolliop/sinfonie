/**
 * A team's own workspace statuses (feedback #62: "add an In verification column"). The five built-in
 * stages stay, because Sinfonie moves workspaces through them (a PR opens: In review; it merges: Done).
 * Each custom status sits after one of them, on the board and in every picker, and is shared with the
 * space's team. Removing one moves its workspaces to the stage it sat after, after a confirmation.
 */
import React, { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Trash2 } from 'lucide-react'
import { WORKSPACE_STAGES, type BuiltinStage, type WorkspaceStatusDef } from '@shared/types'
import { api } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { useApp } from '@/stores/app'
import { STATUS_TONES, stageDot, useCustomStatuses } from '@/lib/stages'
import { Button, Dialog, IconButton, inputCls } from './ui'

type Draft = { id?: WorkspaceStatusDef['id']; label: string; tone?: string; after: BuiltinStage }

export function WorkspaceStatusesDialog({ spaceId, onClose }: { spaceId: string | undefined; onClose: () => void }): React.JSX.Element {
  const custom = useCustomStatuses(spaceId)
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId))
  const workspaces = useApp((s) => s.workspaces)
  const setError = useApp((s) => s.setError)
  const [label, setLabel] = useState('')
  const [after, setAfter] = useState<BuiltinStage>('in-review')
  const [tone, setTone] = useState('text-accent')
  const [removing, setRemoving] = useState<WorkspaceStatusDef | null>(null)

  const save = (next: Draft[]): Promise<boolean> =>
    api
      .invoke('workspaces:setStatuses', spaceId ?? null, next)
      .then(() => true)
      .catch((err) => {
        setError(friendlyError(err))
        return false
      })

  const add = (): void => {
    const l = label.trim()
    if (!l) return
    void save([...custom, { label: l, after, tone }]).then((ok) => ok && setLabel(''))
  }
  const using = (id: string): number => workspaces.filter((w) => w.stage === id && w.status !== 'archived').length
  const anchorLabel = (a: BuiltinStage): string => WORKSPACE_STAGES.find((b) => b.id === a)?.label ?? a
  const ordered = useMemo(() => WORKSPACE_STAGES.flatMap((b) => [{ builtin: b }, ...custom.filter((c) => c.after === b.id).map((c) => ({ custom: c }))]), [custom])

  return (
    <Dialog title="Workspace statuses" onClose={onClose} width={560}>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-[12px] text-muted">
          The five built-in stages always stay: Sinfonie moves workspaces through them, to In review when a pull request opens and to Done when it merges. Add your own after any of them. {space ? `They are shared with everyone in ${space.name}.` : 'These apply to workspaces outside a space.'}
        </p>
        <div className="rounded-lg border border-border">
          {ordered.map((row) =>
            'builtin' in row && row.builtin ? (
              <div key={row.builtin.id} className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[12px] text-muted last:border-b-0">
                <span className={clsx('h-1.5 w-1.5 rounded-full', stageDot(row.builtin.id))} />
                <span className="font-medium">{row.builtin.label}</span>
                <span className="ml-auto text-[11px]">built in</span>
              </div>
            ) : 'custom' in row && row.custom ? (
              <div key={row.custom.id} className="flex items-center gap-2 border-b border-border py-1.5 pl-6 pr-2 text-[12px] last:border-b-0">
                <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', stageDot(row.custom.id))} />
                <input
                  aria-label="Status name"
                  className="min-w-0 flex-1 bg-transparent font-medium outline-none focus:underline"
                  defaultValue={row.custom.label}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    const c = row.custom
                    if (v && v !== c.label) void save(custom.map((x) => (x.id === c.id ? { ...x, label: v } : x)))
                    else e.target.value = c.label
                  }}
                />
                <select aria-label="Colour" className="h-6 rounded-md border border-border bg-bg px-1 text-[11px]" value={row.custom.tone ?? 'text-accent'} onChange={(e) => void save(custom.map((x) => (x.id === row.custom.id ? { ...x, tone: e.target.value } : x)))}>
                  {STATUS_TONES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <select aria-label="Comes after" className="h-6 rounded-md border border-border bg-bg px-1 text-[11px]" value={row.custom.after} onChange={(e) => void save(custom.map((x) => (x.id === row.custom.id ? { ...x, after: e.target.value as BuiltinStage } : x)))}>
                  {WORKSPACE_STAGES.map((b) => (
                    <option key={b.id} value={b.id}>
                      after {b.label}
                    </option>
                  ))}
                </select>
                <IconButton label={`Remove ${row.custom.label}`} onClick={() => setRemoving(row.custom)}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
            ) : null
          )}
        </div>

        {removing ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-[12px]">
            <span className="min-w-0 flex-1">
              Remove “{removing.label}”?{' '}
              {using(removing.id) > 0 ? `${using(removing.id)} workspace${using(removing.id) === 1 ? '' : 's'} in it move${using(removing.id) === 1 ? 's' : ''} to ${anchorLabel(removing.after)}.` : 'No workspace is in it.'}
              {space ? ` It goes away for everyone in ${space.name}.` : ''}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
              Keep it
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                const gone = removing
                setRemoving(null)
                void save(custom.filter((x) => x.id !== gone.id))
              }}
            >
              Remove status
            </Button>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <input className={clsx(inputCls, 'min-w-[160px] flex-1')} placeholder="New status, e.g. In verification" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} aria-label="New status name" />
          <select aria-label="Comes after" className="h-[30px] rounded-md border border-border bg-bg px-2 text-[12px]" value={after} onChange={(e) => setAfter(e.target.value as BuiltinStage)}>
            {WORKSPACE_STAGES.map((b) => (
              <option key={b.id} value={b.id}>
                after {b.label}
              </option>
            ))}
          </select>
          <select aria-label="Colour" className="h-[30px] rounded-md border border-border bg-bg px-2 text-[12px]" value={tone} onChange={(e) => setTone(e.target.value)}>
            {STATUS_TONES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <Button variant="primary" disabled={!label.trim()} onClick={add}>
            Add status
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
