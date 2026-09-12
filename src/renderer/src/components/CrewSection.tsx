import React, { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Bot, Sparkles, Users, ExternalLink } from 'lucide-react'
import { Badge, Button } from './ui'
import { type AgentSpec, type ProviderConfig } from '@shared/types'
import { CrewModelSelect, modelLabel } from './ModelSelect'
import { SuggestCrewDialog } from './SuggestCrewDialog'
import { useApp } from '@/stores/app'
import { api } from '@/lib/api'

const EMPTY_PROVIDERS: ProviderConfig[] = []

/**
 * Crew membership for the app defaults or one space: which library agents the orchestrator
 * may delegate to, and which model each runs on there. The agents themselves are edited
 * under Agents in the sidebar.
 */
export function CrewSection({ spaceId, title, intro, useCrew, orchestrator }: { spaceId?: string; title: string; intro: string; useCrew?: { value: boolean; onToggle: (v: boolean) => void }; /** The chat model, so Suggest can propose one for it too. */ orchestrator?: { value: string; label: string; onChange: (model: string) => void } }): React.JSX.Element {
  const agents = useApp((s) => s.agents)
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId))
  const providersRaw = useApp((s) => s.settings.providers)
  const providers = providersRaw ?? EMPTY_PROVIDERS
  const setView = useApp((s) => s.setView)
  const closeSettings = useApp((s) => s.closeSettings)
  const setError = useApp((s) => s.setError)
  const [suggesting, setSuggesting] = useState(false)
  const visible = useMemo(() => agents.filter((a) => !a.scope || a.scope === spaceId), [agents, spaceId])
  const off = useMemo(() => new Set(space?.crewDisabled ?? []), [space])
  const models = space?.crewModels ?? {}
  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err))

  const inCrew = (a: AgentSpec): boolean => a.enabled && !off.has(a.id)
  const toggle = (a: AgentSpec, on: boolean): void => {
    if (spaceId) {
      const next = on ? [...off].filter((id) => id !== a.id) : [...off, a.id]
      void api.invoke('spaces:update', spaceId, { crewDisabled: next }).catch(fail)
      if (on && !a.enabled) void api.invoke('agents:save', { ...a, enabled: true }).catch(fail)
    } else void api.invoke('agents:save', { ...a, enabled: on }).catch(fail)
  }
  const setModel = (a: AgentSpec, model: string): void => {
    if (spaceId) {
      const next = { ...models }
      if (!model || model === a.model) delete next[a.id]
      else next[a.id] = model
      void api.invoke('spaces:update', spaceId, { crewModels: next }).catch(fail)
    } else void api.invoke('agents:save', { ...a, model }).catch(fail)
  }
  const effective = (a: AgentSpec): AgentSpec => (spaceId && models[a.id] ? { ...a, model: models[a.id] } : a)
  const crew = visible.filter(inCrew).map(effective)

  return (
    <section className="mt-4">
      <div className="mb-1 flex items-center">
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">{title}</h3>
        <span className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setSuggesting(true)} title="Let Claude pick a model for the orchestrator and each agent from every model you can use">
            <Sparkles size={12} /> Suggest models
          </Button>
          <Button
            size="sm"
            onClick={() => {
              closeSettings()
              setView('agents')
            }}
            title="Create, edit, try and import agents"
          >
            <Bot size={12} /> Manage agents <ExternalLink size={10} />
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
            <span className="block text-[11px] text-muted">Off means the chat model does everything itself.</span>
          </span>
        </label>
      )}
      <div className="flex flex-col gap-1.5">
        {visible.length === 0 && <div className="rounded-md border border-dashed border-border px-3 py-3 text-[12px] text-muted">No agents in the library yet. Open Agents in the sidebar to create one.</div>}
        {visible.map((a) => {
          const on = inCrew(a)
          const model = spaceId ? (models[a.id] ?? '') : a.model
          return (
            <div key={a.id} className={clsx('flex items-center gap-2 rounded-lg border px-3 py-2', on ? 'border-border' : 'border-border/60 opacity-60')}>
              <input type="checkbox" checked={on} onChange={(e) => toggle(a, e.target.checked)} title={spaceId ? 'In this space’s crew' : 'In the crew'} />
              <span className="w-5 text-center text-[14px]">{a.icon || <Bot size={13} className="inline text-muted" />}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[13px] font-medium">
                  {a.name}
                  {a.scope && <Badge tone="accent">this space</Badge>}
                  {!a.enabled && <Badge tone="warn">off in library</Badge>}
                  {a.effort && <Badge>{a.effort}</Badge>}
                  <Badge>{a.tools?.length ? `${a.tools.length} tools` : 'all tools'}</Badge>
                </span>
                <span className="block truncate text-[11px] text-muted" title={a.description}>
                  {a.description}
                </span>
              </span>
              <span className="w-[230px] shrink-0">
                {spaceId ? (
                  <CrewModelSelect value={model} onChange={(m) => setModel(a, m)} allowDefault defaultLabel={`library default · ${modelLabel(a.model, providers)}`} />
                ) : (
                  <CrewModelSelect value={model} onChange={(m) => setModel(a, m)} />
                )}
              </span>
            </div>
          )
        })}
      </div>
      {suggesting && (
        <SuggestCrewDialog
          spaceId={spaceId}
          agents={crew}
          orchestrator={orchestrator ? { value: orchestrator.value, label: orchestrator.label } : undefined}
          onApply={(changes, orchestratorModel) => {
            for (const c of changes) {
              const a = visible.find((x) => x.id === c.id)
              if (!a) continue
              if (spaceId) setModel(a, c.model)
              else void api.invoke('agents:save', { ...a, model: c.model, ...(c.effort ? { effort: c.effort } : {}) }).catch(fail)
            }
            if (orchestratorModel && orchestrator) orchestrator.onChange(orchestratorModel)
          }}
          onClose={() => setSuggesting(false)}
        />
      )}
    </section>
  )
}
