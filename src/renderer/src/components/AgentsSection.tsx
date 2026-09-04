import React, { useState } from 'react'
import clsx from 'clsx'
import { Plus, Trash2, Users, RotateCcw, ChevronRight, Sparkles } from 'lucide-react'
import { Badge, Button, Field, inputCls } from './ui'
import { DEFAULT_CREW, PERMISSION_MODES, type AgentSpec, type ProviderConfig } from '@shared/types'
import { CrewModelSelect, modelLabel } from './ModelSelect'
import { SuggestCrewDialog } from './SuggestCrewDialog'
import { useApp } from '@/stores/app'

const EMPTY_PROVIDERS: ProviderConfig[] = []

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Edits a crew: the subagents the orchestrator can delegate to. Used for the app
 * defaults in Settings and, per space, in the space settings.
 */
export function AgentsSection({ agents, onChange, title, intro, inherited, onResetToDefaults, useCrew, engine: engineProp, spaceId, orchestrator }: { agents: AgentSpec[]; onChange: (a: AgentSpec[]) => void; title: string; intro: string; inherited?: boolean; onResetToDefaults?: () => void; useCrew?: { value: boolean; onToggle: (v: boolean) => void }; engine?: string; spaceId?: string; /** The chat model, so Suggest can propose one for it too. */ orchestrator?: { value: string; label: string; onChange: (model: string) => void } }): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const defaultEngine = useApp((s) => s.settings.engine ?? 'claude-code')
  const providersRaw = useApp((s) => s.settings.providers)
  const providers = providersRaw ?? EMPTY_PROVIDERS
  const engine = engineProp ?? defaultEngine
  void engine
  const update = (id: string, patch: Partial<AgentSpec>): void => onChange(agents.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  const add = (): void => {
    const id = crypto.randomUUID().slice(0, 8)
    onChange([...agents, { id, name: `agent-${agents.length + 1}`, description: '', prompt: '', model: 'sonnet', effort: 'high', enabled: true }])
    setOpen(id)
  }
  return (
    <section className="mt-4">
      <div className="mb-1 flex items-center">
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">{title}</h3>
        <span className="ml-auto flex gap-1.5">
          {onResetToDefaults && (
            <Button size="sm" variant="ghost" onClick={onResetToDefaults} title="Replace with the built-in crew">
              <RotateCcw size={12} /> Reset to defaults
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSuggesting(true)} title="Let Claude pick a model for the orchestrator and each agent from every model you can use">
            <Sparkles size={12} /> Suggest models
          </Button>
          <Button size="sm" onClick={add}>
            <Plus size={12} /> Add agent
          </Button>
        </span>
      </div>
      <p className="mb-2 text-[11px] text-muted">{intro}</p>
      {useCrew && (
        <label className="mb-2 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[12px]">
          <input type="checkbox" checked={useCrew.value} onChange={(e) => useCrew.onToggle(e.target.checked)} />
          <Users size={13} className="text-muted" />
          <span className="flex-1">
            Give the orchestrator a crew
            <span className="block text-[11px] text-muted">Off means the chat model does everything itself, as before.</span>
          </span>
        </label>
      )}
      {inherited && <div className="mb-2 rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-muted">Using the app defaults. Editing any agent here gives this space its own copy.</div>}
      <div className="flex flex-col gap-1.5">
        {agents.map((a) => {
          const isOpen = open === a.id
          return (
            <div key={a.id} className={clsx('rounded-lg border', a.enabled ? 'border-border' : 'border-border/60 opacity-60')}>
              <div className="flex items-center gap-2 px-3 py-2">
                <input type="checkbox" checked={a.enabled} onChange={(e) => update(a.id, { enabled: e.target.checked })} title="Enabled" />
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(isOpen ? null : a.id)}>
                  <ChevronRight size={12} className={clsx('shrink-0 transition-transform', isOpen && 'rotate-90')} />
                  <span className="text-[13px] font-medium">{a.name}</span>
                  <Badge tone="accent">{modelLabel(a.model, providers)}</Badge>
                  {a.effort && <Badge>{a.effort}</Badge>}
                  {a.tools?.length ? <Badge>{a.tools.length} tools</Badge> : <Badge>all tools</Badge>}
                  <span className="truncate text-[11px] text-muted">{a.description}</span>
                </button>
                <button className="rounded p-1 text-muted hover:text-danger" title="Remove" onClick={() => onChange(agents.filter((x) => x.id !== a.id))}>
                  <Trash2 size={13} />
                </button>
              </div>
              {isOpen && (
                <div className="border-t border-border px-3 py-3">
                  <div className="grid grid-cols-[1fr_220px_120px] gap-3">
                    <Field label="Name" hint="Also the type the orchestrator uses to call it.">
                      <input className={inputCls} value={a.name} onChange={(e) => update(a.id, { name: e.target.value.replace(/\s+/g, '-').toLowerCase() })} />
                    </Field>
                    <Field label="Model" hint="Any vendor: Claude, a signed-in agent, or an API provider.">
                      <CrewModelSelect value={a.model} onChange={(model) => update(a.id, { model })} />
                    </Field>
                    <Field label="Effort">
                      <select className={inputCls} value={a.effort ?? ''} onChange={(e) => update(a.id, { effort: (e.target.value || undefined) as AgentSpec['effort'] })}>
                        <option value="">default</option>
                        {EFFORTS.map((e) => (
                          <option key={e} value={e}>
                            {e}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="When to use it" hint="The orchestrator reads this to decide whether to delegate.">
                    <input className={inputCls} value={a.description} onChange={(e) => update(a.id, { description: e.target.value })} />
                  </Field>
                  <Field label="Instructions" hint="The subagent's own system prompt.">
                    <textarea rows={4} className={inputCls} value={a.prompt} onChange={(e) => update(a.id, { prompt: e.target.value })} />
                  </Field>
                  <div className="grid grid-cols-[1fr_140px_120px] gap-3">
                    <Field label="Allowed tools" hint="Comma-separated. Empty = everything. Patterns like Bash(git diff:*) work.">
                      <input className={inputCls} value={(a.tools ?? []).join(', ')} onChange={(e) => update(a.id, { tools: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} />
                    </Field>
                    <Field label="Permission mode">
                      <select className={inputCls} value={a.permissionMode ?? ''} onChange={(e) => update(a.id, { permissionMode: (e.target.value || undefined) as AgentSpec['permissionMode'] })}>
                        <option value="">inherit</option>
                        {PERMISSION_MODES.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Max turns">
                      <input type="number" className={inputCls} value={a.maxTurns ?? ''} onChange={(e) => update(a.id, { maxTurns: Number(e.target.value) || undefined })} />
                    </Field>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {agents.length === 0 && <div className="rounded-md border border-dashed border-border p-3 text-center text-[12px] text-muted">No agents. The chat model works alone.</div>}
      </div>
      {suggesting && (
        <SuggestCrewDialog
          spaceId={spaceId}
          agents={agents}
          orchestrator={orchestrator ? { value: orchestrator.value, label: orchestrator.label } : undefined}
          onApply={(next, orchestratorModel) => {
            onChange(next)
            if (orchestratorModel && orchestrator) orchestrator.onChange(orchestratorModel)
          }}
          onClose={() => setSuggesting(false)}
        />
      )}
    </section>
  )
}

export { DEFAULT_CREW }
