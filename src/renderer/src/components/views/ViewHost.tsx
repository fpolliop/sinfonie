/**
 * Renders one generated view: feeds its sources into json-render state (/data, /meta, /context),
 * runs its actions with the tier the catalog fixes (confirm and outward ask first), and shows the
 * result of an action as a short notice. A render error shows a fallback instead of a blank pane.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { JSONUIProvider, Renderer, createStateStore } from '@json-render/react'
import type { Spec } from '@json-render/core'
import { ACTIONS, type ActionName } from '@shared/views/catalog'
import { SOURCES, isSourceId } from '@shared/views/sources'
import type { ScopedView, ViewSourceBinding } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useUsage, subscribeUsage } from '@/stores/usage'
import { useOnCall, subscribeOnCall } from '@/stores/oncall'
import { openInbox } from '@/stores/inbox'
import { openMaestro } from '@/stores/maestro'
import { Button, Dialog } from '@/components/ui'
import { registry, UnknownElement } from './registry'
import { enrich, liveRows, type LiveState } from './liveSources'

export interface ViewContextValues {
  spaceId?: string
  spaceName?: string
  workspaceId?: string
  workspaceName?: string
  branch?: string
}

type Pending = { name: ActionName; params: Record<string, unknown>; text: string; resolve: (ok: boolean) => void }

function useLive(): LiveState {
  const workspaces = useApp((s) => s.workspaces)
  const spaces = useApp((s) => s.spaces)
  const permissions = useChat((s) => s.permissions)
  const questions = useChat((s) => s.questions)
  const unseenDone = useChat((s) => s.unseenDone)
  const chats = useChat((s) => s.chats)
  const usage = useUsage((s) => s.snapshot)
  const oncall = useOnCall((s) => s.state)
  useEffect(() => {
    subscribeUsage()
    subscribeOnCall()
  }, [])
  const incidents = useMemo(() => oncall?.incidents ?? [], [oncall])
  // Busy flags only: chats changes on every streamed token, the flags rarely.
  const busyKey = Object.entries(chats)
    .filter(([, c]) => c.busy)
    .map(([id]) => id)
    .sort()
    .join(',')
  const busy = useMemo(() => Object.fromEntries(busyKey.split(',').filter(Boolean).map((id) => [id, true])), [busyKey])
  return useMemo(() => ({ workspaces, spaces, permissions, questions, unseenDone, busy, usage, incidents }), [workspaces, spaces, permissions, questions, unseenDone, busy, usage, incidents])
}

function describe(name: ActionName, p: Record<string, unknown>, wsName: (id: unknown) => string): string {
  switch (name) {
    case 'createWorkspaceFromTicket':
      return `Start a workspace for ${String(p.key)} "${String(p.title)}". It starts empty; the agent adds the repositories it needs.`
    case 'sendToAgent':
      return `Send this to the agent in ${wsName(p.workspaceId)}:\n\n${String(p.text)}`
    case 'fixWithAgent':
      return `Ask the agent in ${wsName(p.workspaceId)} to fix ${p.what ? String(p.what) : `the failing CI on PR #${String(p.number ?? '')}${p.repo ? ` (${String(p.repo)})` : ''}`}.`
    case 'runScript':
      return `Run the ${String(p.kind)} script of ${wsName(p.workspaceId)}.`
    case 'triageIncident':
      return 'Run the on-call agent over this incident: it reads the thread, logs and code, and writes a triage with proposals. Read-only, and it costs a few cents.'
    case 'rebaseAll':
      return `Fetch and rebase every repository of ${wsName(p.workspaceId)} onto its base branch. Repositories with uncommitted changes are skipped and conflicts are left as they were. Nothing is pushed.`
    case 'pushAll':
      return `Push every repository of ${wsName(p.workspaceId)} that has new commits to GitHub.`
    case 'openPrsAll':
      return `Open a ${p.draft ? 'draft ' : ''}pull request on GitHub in every repository of ${wsName(p.workspaceId)} that has commits and no PR yet (pushing first).`
    case 'mergePr':
      return `Merge ${String(p.repo)}#${String(p.number)} on GitHub (${String(p.method ?? 'squash')}).`
    default:
      return ACTIONS[name].description
  }
}

export function ViewHost({ view, context }: { view: ScopedView; context: ViewContextValues }): React.JSX.Element {
  const live = useLive()
  const settings = useApp((s) => s.settings)
  const store = useMemo(() => createStateStore({ data: {}, meta: {}, context: {}, ui: view.spec.state?.ui ?? {} }), [view.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const [mainRows, setMainRows] = useState<Record<string, unknown[]>>({})
  const [pending, setPending] = useState<Pending | null>(null)
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'danger' | 'muted' } | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const ctxRef = useRef(context)
  ctxRef.current = context
  const liveRef = useRef(live)
  liveRef.current = live

  const bindings = view.sources
  const bindingsKey = JSON.stringify(bindings)
  const ctxKey = JSON.stringify(context)

  // /context
  useEffect(() => {
    const full = settings.cloud?.account?.user.name ?? settings.cloud?.account?.user.login ?? ''
    const first = full.trim().split(/\s+/)[0] ?? ''
    const hour = new Date().getHours()
    const part = hour < 12 ? 'Good morning' : hour < 19 ? 'Good afternoon' : 'Good evening'
    store.set('/context', {
      ...context,
      userName: full,
      firstName: first,
      greeting: first ? `${part}, ${first}` : part,
      today: new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    })
  }, [store, ctxKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Renderer sources and enrichment of main rows, whenever the live stores change.
  useEffect(() => {
    for (const [name, b] of Object.entries(bindings)) {
      if (!isSourceId(b.source)) continue
      if (SOURCES[b.source].where === 'renderer') {
        const rows = liveRows(b.source, { ...(b.params ?? {}) }, live)
        store.set(`/data/${name}`, rows)
        store.set(`/meta/${name}`, { count: rows.length, loading: false })
      } else if (mainRows[name]) store.set(`/data/${name}`, enrich(b.source, mainRows[name], live))
    }
  }, [store, bindingsKey, live, mainRows]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(
    async (name: string, b: ViewSourceBinding, force: boolean): Promise<void> => {
      if (!isSourceId(b.source) || SOURCES[b.source].where !== 'main') return
      const prev = (store.get(`/meta/${name}`) as Record<string, unknown> | undefined) ?? {}
      store.set(`/meta/${name}`, { ...prev, loading: true })
      const r = await api.invoke('views:data', b, { spaceId: ctxRef.current.spaceId, workspaceId: ctxRef.current.workspaceId }, force).catch((err: unknown) => ({ rows: [], error: err instanceof Error ? err.message : String(err), fetchedAt: new Date().toISOString() }))
      setMainRows((m) => ({ ...m, [name]: r.rows }))
      store.set(`/data/${name}`, enrich(b.source, r.rows, liveRef.current))
      store.set(`/meta/${name}`, { count: r.rows.length, loading: false, error: r.error ?? '', fetchedAt: r.fetchedAt })
      setErrors((e) => {
        if ((e[name] ?? '') === (r.error ?? '')) return e
        const next = { ...e }
        if (r.error) next[name] = r.error
        else delete next[name]
        return next
      })
    },
    [store]
  )

  const refreshAll = useCallback(
    (force: boolean, only?: string) => {
      for (const [name, b] of Object.entries(bindings)) if (!only || only === name) void load(name, b, force)
    },
    [bindingsKey, load] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Main sources: load, then refresh on their interval while the window is visible, and on focus.
  useEffect(() => {
    refreshAll(false)
    const timers = Object.entries(bindings)
      .filter(([, b]) => isSourceId(b.source) && SOURCES[b.source].where === 'main')
      .map(([name, b]) => {
        const secs = Math.max(15, b.refreshSeconds ?? SOURCES[b.source as keyof typeof SOURCES].refreshSeconds)
        return setInterval(() => document.visibilityState === 'visible' && void load(name, b, false), secs * 1000)
      })
    const onFocus = (): void => refreshAll(false)
    window.addEventListener('focus', onFocus)
    return () => {
      timers.forEach(clearInterval)
      window.removeEventListener('focus', onFocus)
    }
  }, [bindingsKey, ctxKey, refreshAll]) // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = (name: ActionName, params: Record<string, unknown>): Promise<boolean> => {
    const wsName = (id: unknown): string => liveRef.current.workspaces.find((w) => w.id === id)?.name ?? 'this workspace'
    return new Promise((resolve) => setPending({ name, params, text: describe(name, params, wsName), resolve }))
  }

  const run = async (name: ActionName, params: Record<string, unknown>): Promise<void> => {
    const def = ACTIONS[name]
    const parsed = def.params.safeParse(params)
    if (!parsed.success) {
      setNotice({ text: `This button is misconfigured (${name}: ${parsed.error.issues[0]?.message}). Ask Maestro to fix the view.`, tone: 'danger' })
      return
    }
    const p = parsed.data as Record<string, unknown>
    if (def.tier !== 'navigate' && !(await confirm(name, p))) return
    const app = useApp.getState()
    try {
      switch (name) {
        case 'openWorkspace':
          app.select(String(p.workspaceId))
          return
        case 'openWorkspaceTab':
          app.select(String(p.workspaceId))
          app.setTab(p.tab as Parameters<typeof app.setTab>[0])
          return
        case 'openUrl':
          await api.invoke('shell:openExternal', String(p.url))
          return
        case 'refresh':
          refreshAll(true, p.source ? String(p.source) : undefined)
          return
        case 'askMaestro':
          void openMaestro({ fresh: true, prompt: String(p.prompt) })
          return
        case 'openIncident':
          useOnCall.getState().select(String(p.incidentId))
          openInbox({ key: `inc:${String(p.incidentId)}` })
          return
        case 'triageIncident':
          await api.invoke('oncall:triage', String(p.incidentId))
          setNotice({ text: 'Triage started; the incident updates when it finishes.', tone: 'ok' })
          return
        case 'newWorkspace':
          app.setShowNewWorkspace(true, p.spaceId ? String(p.spaceId) : ctxRef.current.spaceId)
          return
        case 'createWorkspaceFromTicket': {
          const title = String(p.title)
          const ws = await api.invoke('workspaces:create', {
            name: `${String(p.key)} ${title}`.slice(0, 80),
            repos: [],
            spaceId: p.spaceId ? String(p.spaceId) : ctxRef.current.spaceId,
            ...(p.provider === 'linear'
              ? { linear: { id: String(p.id ?? ''), identifier: String(p.key), title, url: String(p.url ?? '') } }
              : { jira: { key: String(p.key), summary: title, url: String(p.url ?? '') } })
          })
          app.select(ws.id)
          return
        }
        case 'sendToAgent':
          await useChat.getState().send(String(p.workspaceId), String(p.text))
          setNotice({ text: 'Sent to the agent.', tone: 'ok' })
          return
        case 'fixWithAgent': {
          const pr = p.number ? `PR #${String(p.number)}${p.repo ? ` in ${String(p.repo)}` : ''}` : 'the pull request'
          const text = p.what
            ? `Please fix this on ${pr}: ${String(p.what)}`
            : `CI is failing on ${pr}. Look at the failing checks (gh pr checks ${String(p.number ?? '')}${p.repo ? ` --repo ${String(p.repo)}` : ''}), find the cause, fix it, then commit and push.`
          await useChat.getState().send(String(p.workspaceId), text)
          app.select(String(p.workspaceId))
          return
        }
        case 'runScript':
          await api.invoke('workspaces:runScript', String(p.workspaceId), p.kind as 'setup' | 'run')
          app.select(String(p.workspaceId))
          app.setTab('run')
          return
        case 'rebaseAll':
        case 'pushAll':
        case 'openPrsAll':
        case 'mergePr': {
          setNotice({ text: 'Working…', tone: 'muted' })
          const out = await api.invoke('views:action', name, p, true)
          setNotice({ text: out, tone: /failed|conflict/i.test(out) ? 'danger' : 'ok' })
          refreshAll(true)
          return
        }
      }
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err), tone: 'danger' })
    }
  }
  const runRef = useRef(run)
  runRef.current = run
  const handlers = useMemo(() => Object.fromEntries(Object.keys(ACTIONS).map((n) => [n, (params: Record<string, unknown>) => runRef.current(n as ActionName, params ?? {})])), [])

  return (
    <div className="relative">
      {Object.keys(errors).length > 0 && (
        <div className="mb-3 flex flex-col gap-1 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-[12px]">
          {Object.entries(errors).map(([name, e]) => (
            <div key={name} className="flex items-center gap-2">
              <span className="font-medium text-warn">{name}:</span>
              <span className="min-w-0 flex-1 truncate text-muted" title={e}>
                {e}
              </span>
              <button className="shrink-0 text-accent hover:underline" onClick={() => refreshAll(true, name)}>
                Retry
              </button>
            </div>
          ))}
        </div>
      )}
      <ViewErrorBoundary key={view.updatedAt} viewId={view.id}>
        <JSONUIProvider registry={registry} store={store} handlers={handlers}>
          <Renderer spec={view.spec as unknown as Spec} registry={registry} fallback={UnknownElement} />
        </JSONUIProvider>
      </ViewErrorBoundary>
      {notice && (
        <div className={clsx('fixed bottom-4 left-1/2 z-40 max-w-[560px] -translate-x-1/2 whitespace-pre-wrap rounded-lg border bg-panel px-4 py-2 text-[12px] shadow-xl', notice.tone === 'danger' ? 'border-danger/40 text-danger' : notice.tone === 'ok' ? 'border-ok/40' : 'border-border text-muted')}>
          {notice.text}
          <button className="ml-3 text-muted hover:text-text" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {pending && (
        <Dialog
          title={ACTIONS[pending.name].tier === 'outward' ? 'This leaves your Mac' : 'Confirm'}
          onClose={() => {
            pending.resolve(false)
            setPending(null)
          }}
          width={460}
        >
          <div className="flex flex-col gap-4 p-4">
            <p className="whitespace-pre-wrap text-[13px]">{pending.text}</p>
            {ACTIONS[pending.name].tier === 'outward' && <p className="text-[12px] text-warn">Other people will see this on GitHub.</p>}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  pending.resolve(false)
                  setPending(null)
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                autoFocus
                onClick={() => {
                  pending.resolve(true)
                  setPending(null)
                }}
              >
                {ACTIONS[pending.name].tier === 'outward' ? 'Yes, do it' : 'Continue'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}

class ViewErrorBoundary extends React.Component<{ viewId: string; children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(err: unknown): { error: string } {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex flex-col items-start gap-2 rounded-lg border border-danger/40 bg-danger/5 p-4 text-[13px]">
        <div className="font-medium text-danger">This view could not be drawn.</div>
        <div className="font-mono text-[12px] text-muted">{this.state.error}</div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void api.invoke('views:undo', this.props.viewId).catch(() => undefined)}>
            Undo last change
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void openMaestro({ fresh: true, prompt: `My view ${this.props.viewId} fails to render: "${this.state.error}". Please fix it.` })}>
            Ask Maestro to fix it
          </Button>
        </div>
      </div>
    )
  }
}
