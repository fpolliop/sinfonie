import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Loader2, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Dialog } from './ui'
import { modelLabel } from './ModelSelect'
import type { CrewPriority, AgentSpec, CrewSuggestion, ProviderConfig } from '@shared/types'

const EMPTY_PROVIDERS: ProviderConfig[] = []

/**
 * Asks Claude to assign a model to the orchestrator and every crew member from all the
 * user's models, shows the proposal with reasons, and applies the ticked rows.
 */
export function SuggestCrewDialog({ spaceId, agents, orchestrator, onApply, onClose }: { spaceId?: string; agents: AgentSpec[]; orchestrator?: { value: string; label: string }; onApply: (agents: AgentSpec[], orchestratorModel?: string) => void; onClose: () => void }): React.JSX.Element {
  const providersRaw = useApp((s) => s.settings.providers)
  const providers = providersRaw ?? EMPTY_PROVIDERS
  const [result, setResult] = useState<CrewSuggestion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [priority, setPriority] = useState<CrewPriority>('balanced')
  const [refining, setRefining] = useState(false)
  const [refined, setRefined] = useState(false)
  useEffect(() => {
    let alive = true
    setResult(null)
    setError(null)
    setRefined(false)
    // The rule-based preset shows at once; the model-based pass refines it with the exact inventory.
    api
      .invoke('crew:preset', spaceId, priority)
      .then((r) => {
        if (!alive || !r) return
        setResult((cur) => cur ?? r)
        setPicked(new Set(['orchestrator', ...r.agents.map((a) => a.id)]))
      })
      .catch(() => undefined)
    setRefining(true)
    api
      .invoke('crew:suggest', spaceId, priority)
      .then((r) => {
        if (!alive) return
        setResult(r)
        setRefined(true)
        setPicked(new Set(['orchestrator', ...r.agents.map((a) => a.id)]))
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setRefining(false))
    return () => {
      alive = false
    }
  }, [spaceId, priority])
  const toggle = (id: string): void =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const apply = (): void => {
    if (!result) return
    const next = agents.map((a) => {
      const s = result.agents.find((x) => x.id === a.id)
      return s && picked.has(a.id) ? { ...a, model: s.model, ...(s.effort ? { effort: s.effort } : {}) } : a
    })
    onApply(next, orchestrator && picked.has('orchestrator') && result.orchestrator.model !== orchestrator.value ? result.orchestrator.model : undefined)
    onClose()
  }
  const rows = result
    ? [
        ...(orchestrator ? [{ id: 'orchestrator', name: 'orchestrator', current: orchestrator.value || orchestrator.label, model: result.orchestrator.model, effort: undefined as AgentSpec['effort'], why: result.orchestrator.why }] : []),
        ...result.agents.map((s) => ({ id: s.id, name: s.name, current: agents.find((a) => a.id === s.id)?.model ?? '', model: s.model, effort: s.effort, why: s.why }))
      ]
    : []
  return (
    <Dialog title="Suggested models for your crew" onClose={onClose} width={760}>
      <div className="mb-3 flex items-center gap-2 text-[12px]">
        <span className="text-muted">Optimise for</span>
        <div className="flex rounded-md bg-panel p-0.5">
          {(
            [
              ['cost', 'Cost', 'Stretch a subscription: Sonnet orchestrator, Haiku for the busy roles, low effort.'],
              ['balanced', 'Balanced', 'Strong where judgment matters, cheap where volume matters.'],
              ['quality', 'Quality', 'Best result regardless of cost: Opus or Fable at the top, careful review.']
            ] as const
          ).map(([id, label, hint]) => (
            <button key={id} title={hint} onClick={() => setPriority(id)} className={clsx('rounded px-2.5 py-0.5', priority === id ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {!result && !error && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-bg px-4 py-4 text-[13px]">
          <Loader2 size={18} className="animate-spin text-accent" />
          <div>
            <div className="font-medium">Looking at every model you can use…</div>
            <div className="text-[12px] text-muted">Your Claude login, signed-in vendor agents and API providers. This takes a few seconds.</div>
          </div>
        </div>
      )}
      {error && <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-[12px] text-danger">{result ? `Claude could not refine the suggestion (${error}); the preset below still applies.` : error}</div>}
      {result && (
        <>
          <p className="mb-3 flex items-center gap-2 text-[12px] text-muted">
            Tick the rows to apply. Each choice explains itself; nothing changes until you click Apply.
            {refining && (
              <span className="ml-auto inline-flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin text-accent" /> Claude is refining with your exact inventory…
              </span>
            )}
            {!refining && refined && <span className="ml-auto text-ok">Refined by Claude</span>}
            {!refining && !refined && <span className="ml-auto">Preset</span>}
          </p>
          <div className="flex flex-col gap-1.5">
            {rows.map((r) => {
              const same = r.current === r.model
              return (
                <label key={r.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2">
                  <input type="checkbox" className="mt-1" checked={picked.has(r.id) && !same} disabled={same} onChange={() => toggle(r.id)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="font-medium">{r.name}</span>
                      {r.id === 'orchestrator' && <Badge>chat model</Badge>}
                      <span className="text-muted">{modelLabel(r.current, providers) || 'none'}</span>
                      <span className="text-muted">→</span>
                      <Badge tone={same ? undefined : 'accent'}>{modelLabel(r.model, providers)}</Badge>
                      {r.effort && <Badge>{r.effort}</Badge>}
                      {same && <span className="text-[11px] text-muted">unchanged</span>}
                    </div>
                    <div className="mt-0.5 text-[12px] text-muted">{r.why}</div>
                  </div>
                </label>
              )
            })}
          </div>
          {result.notes && <p className="mt-3 text-[12px] text-muted">{result.notes}</p>}
        </>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!result || rows.every((r) => !picked.has(r.id) || r.current === r.model)} onClick={apply}>
          <Sparkles size={12} /> Apply
        </Button>
      </div>
    </Dialog>
  )
}
