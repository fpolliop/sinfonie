import React, { useEffect } from 'react'
import clsx from 'clsx'
import { Check, Crosshair, Monitor, Smartphone } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useBrowser } from '@/stores/browser'
import { useBuilder, type Device } from '@/stores/builder'
import { hasOpenDialog } from '../ui'
import { BrowserPane } from '../BrowserPane'
import { ChatPane } from '../ChatPane'

/**
 * The builder's task screen (guided mode, docs/design/README.md: "My product is the canvas"): the preview is the
 * canvas on the left, the conversation with Maestro a narrower column on the right. The preview's toolbar switches
 * between desktop and phone widths and has "Point at something".
 */
export function TaskScreen({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const device = useBuilder((s) => s.device[workspaceId] ?? 'desktop')
  useEffect(() => useBuilder.getState().subscribe(), [])
  // A small picture of the preview for the task's card on the builder home, shortly after each page load (and after
  // each change, stores/builder). Not on leaving: by then the preview is being taken off screen.
  const loading = useBrowser((s) => {
    const st = s.states[workspaceId]
    const t = st?.tabs.find((x) => x.id === st.activeId)
    return t ? t.loading || t.failed || !t.url : true
  })
  useEffect(() => {
    if (loading) return
    const t = setTimeout(() => void keepThumb(workspaceId), 1500)
    return () => clearTimeout(t)
  }, [loading, workspaceId])
  return (
    <div className="flex min-h-0 flex-1">
      <section aria-label="Preview of your app" className="flex min-w-0 flex-1 flex-col bg-panel-2">
        <BrowserPane workspaceId={workspaceId} visible frame={device} leading={<PreviewTools workspaceId={workspaceId} device={device} />} />
      </section>
      <section aria-label="Conversation with Maestro" className="guided-comfy @container flex h-full shrink-0 flex-col border-l border-border bg-panel" style={{ width: 'clamp(360px, 34%, 500px)' }}>
        <ChatPane workspaceId={workspaceId} />
      </section>
    </div>
  )
}

function keepThumb(workspaceId: string): Promise<void> {
  return api
    .invoke('preview:capture', workspaceId)
    .then((shot) => void (shot && useBuilder.setState((s) => ({ thumbs: { ...s.thumbs, [workspaceId]: shot } }))))
    .catch(() => undefined)
}

/** Desktop or phone width, and "Point at something" (Esc cancels, from the preview or from anywhere in the app). */
function PreviewTools({ workspaceId, device }: { workspaceId: string; device: Device }): React.JSX.Element {
  const picking = useBuilder((s) => Boolean(s.picking[workspaceId]))
  const startPick = useBuilder((s) => s.startPick)
  const cancelPick = useBuilder((s) => s.cancelPick)
  const setDevice = useBuilder((s) => s.setDevice)
  const state = useBrowser((s) => s.states[workspaceId])
  const active = state?.tabs.find((t) => t.id === state.activeId)
  const canPick = Boolean(active?.url && active.url !== 'about:blank' && !active.failed)
  useEffect(() => {
    if (!picking) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !hasOpenDialog()) {
        e.preventDefault()
        cancelPick(workspaceId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picking, workspaceId, cancelPick])
  // A dialog hides the preview; stop waiting for a click that cannot come.
  useEffect(() => () => void (useBuilder.getState().picking[workspaceId] && useBuilder.getState().cancelPick(workspaceId)), [workspaceId])
  return (
    // data-tour="tab-browser": the guided tour's Preview stop points here on the builder task screen.
    <div data-tour="tab-browser" className="flex shrink-0 items-center gap-2 pr-1">
      <div role="radiogroup" aria-label="Preview width" className="inline-flex rounded-md border border-border bg-bg p-0.5">
        {(
          [
            { id: 'desktop', label: 'Desktop', icon: <Monitor size={13} aria-hidden /> },
            { id: 'phone', label: 'Phone', icon: <Smartphone size={13} aria-hidden /> }
          ] as { id: Device; label: string; icon: React.ReactNode }[]
        ).map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={device === o.id}
            onClick={() => setDevice(workspaceId, o.id)}
            className={clsx('inline-flex min-h-7 items-center gap-1.5 rounded px-2.5 text-[13px] font-medium transition-colors', device === o.id ? 'bg-panel text-text shadow-sm ring-1 ring-border' : 'text-muted hover:text-text')}
          >
            {o.icon}
            {o.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-pressed={picking}
        disabled={!canPick && !picking}
        onClick={() => void startPick(workspaceId)}
        title={picking ? 'Click the part of the page you mean, or press Esc to cancel' : 'Point at a part of the page, then tell Maestro what to change about it'}
        className={clsx('no-drag inline-flex min-h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium transition-colors', picking ? 'border-primary bg-primary text-white' : 'border-accent/50 text-accent hover:bg-accent/10')}
      >
        <Crosshair size={14} aria-hidden /> {picking ? 'Click the part you mean · Esc to cancel' : 'Point at something'}
      </button>
    </div>
  )
}

/**
 * Where the task stands, as four steps: Describe, Preview, Review, Live. Taken from the conversation and the task's
 * stage; nothing is guessed.
 */
export function TaskSteps({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const stage = useApp((s) => s.workspaces.find((w) => w.id === workspaceId)?.stage)
  const described = useChat((s) => (s.chats[workspaceId]?.items ?? []).some((it) => it.role === 'user'))
  const current = stage === 'done' ? 3 : stage === 'in-review' ? 2 : described ? 1 : 0
  const steps = ['Describe', 'Preview', 'Review', 'Live']
  return (
    <ol aria-label="Progress" className="flex items-center gap-1.5 text-[13px]">
      {steps.map((label, i) => {
        const done = i < current || (i === 3 && current === 3)
        const here = i === current && !done
        return (
          <li key={label} className="flex items-center gap-1.5" aria-current={here ? 'step' : undefined}>
            {i > 0 && <span aria-hidden className="mx-0.5 h-px w-4 bg-border" />}
            <span
              aria-hidden
              className={clsx(
                'inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px] font-semibold',
                done ? 'bg-ok/15 text-ok' : here ? 'bg-primary text-white' : 'border border-border text-muted'
              )}
            >
              {done ? <Check size={11} /> : i + 1}
            </span>
            <span className={clsx(done ? 'text-ok' : here ? 'font-semibold text-text' : 'text-muted')}>
              {label}
              {done && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
