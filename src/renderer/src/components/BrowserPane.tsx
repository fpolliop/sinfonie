import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, ArrowRight, RotateCw, Plus, X, Globe, Pause, Play, ExternalLink, ShieldAlert, Download } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useBrowser, subscribeBrowser, loadBrowserState } from '@/stores/browser'
import type { PermissionRequest } from '@shared/types'

/**
 * The workspace browser. The page itself is a native view the main process places over this pane,
 * so this component owns the chrome (tabs, address bar, agent controls) and reports its bounds.
 */
export function BrowserPane({ workspaceId, visible }: { workspaceId: string; visible: boolean }): React.JSX.Element {
  const state = useBrowser((s) => s.states[workspaceId])
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const engine = useApp((s) => s.settings.engine ?? 'claude-code')
  const space = useApp((s) => s.spaces.find((sp) => sp.id === ws?.spaceId))
  const host = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [pending, setPending] = useState<PermissionRequest | null>(null)
  useEffect(() => {
    subscribeBrowser()
    loadBrowserState(workspaceId)
  }, [workspaceId])
  const active = state?.tabs.find((t) => t.id === state.activeId) ?? null
  useEffect(() => {
    if (!editing) setAddress(active?.url && active.url !== 'about:blank' ? active.url : '')
  }, [active?.url, editing])

  // Report where the page should be drawn; null while this pane is hidden.
  useLayoutEffect(() => {
    const el = host.current
    if (!visible || !el) {
      void api.invoke('browser:setBounds', workspaceId, null)
      return
    }
    const report = (): void => {
      const r = el.getBoundingClientRect()
      void api.invoke('browser:setBounds', workspaceId, { x: r.left, y: r.top, width: r.width, height: r.height })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      void api.invoke('browser:setBounds', workspaceId, null)
    }
  }, [visible, workspaceId, state?.tabs.length === 0])

  // Sensitive-origin approvals for browser tools land here, since the chat pane is hidden behind the page.
  useEffect(
    () =>
      api.on('agent:permission', (req) => {
        if (req.workspaceId === workspaceId && /browser/.test(req.toolName)) setPending(req)
      }),
    [workspaceId]
  )
  const answer = (decision: 'allow' | 'always' | 'deny'): void => {
    if (!pending) return
    void api.invoke('agent:permission', { requestId: pending.requestId, decision })
    setPending(null)
  }

  const act = (action: 'new' | 'select' | 'close' | 'back' | 'forward' | 'reload', tabId?: string): void => void api.invoke('browser:tabAction', workspaceId, action, tabId)
  const go = (url: string): void => {
    setEditing(false)
    if (!url.trim()) return
    void api.invoke(state?.tabs.length ? 'browser:navigate' : 'browser:open', workspaceId, url.trim())
  }
  const localUrl = ws ? `http://localhost:${ws.port}` : ''
  const engineLabel = (space?.engine ?? engine) === 'claude-code' ? 'Claude' : 'The agent'

  return (
    <div className="flex h-full flex-col">
      <div className={clsx('flex items-center gap-1 border-b border-border px-2 py-1', state?.agentBusy && 'bg-accent/5')}>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {state?.tabs.map((t) => (
            <div key={t.id} onClick={() => act('select', t.id)} className={clsx('group flex max-w-[180px] shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-[12px]', t.id === state.activeId ? 'bg-panel-2 text-text' : 'text-muted hover:bg-panel-2/60')} title={t.url}>
              {t.loading ? <span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> : <Globe size={11} className="shrink-0 opacity-60" />}
              <span className="truncate">{t.title}</span>
              <button className="rounded p-0.5 opacity-0 hover:bg-bg group-hover:opacity-100" onClick={(e) => (e.stopPropagation(), act('close', t.id))} aria-label="Close tab">
                <X size={11} />
              </button>
            </div>
          ))}
          <button className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-text" title="New tab" onClick={() => act('new')}>
            <Plus size={13} />
          </button>
        </div>
        {state?.agentBusy && !state.paused && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> {engineLabel} is browsing
          </span>
        )}
        {state?.paused ? (
          <button className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warn/50 bg-warn/10 px-2 py-0.5 text-[11px] text-warn hover:bg-warn/20" title="Agent actions are waiting. Click to hand control back." onClick={() => void api.invoke('browser:setPaused', workspaceId, false)}>
            <Play size={11} /> You have control · resume agent
          </button>
        ) : (
          <button className="shrink-0 rounded-md p-1 text-muted hover:bg-panel-2 hover:text-text" title="Pause agent control: its next browser action waits until you resume (e.g. to sign in yourself)" onClick={() => void api.invoke('browser:setPaused', workspaceId, true)}>
            <Pause size={13} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <button className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-text disabled:opacity-40" onClick={() => act('back')} disabled={!active} title="Back">
          <ArrowLeft size={14} />
        </button>
        <button className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-text disabled:opacity-40" onClick={() => act('forward')} disabled={!active} title="Forward">
          <ArrowRight size={14} />
        </button>
        <button className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-text disabled:opacity-40" onClick={() => act('reload')} disabled={!active} title="Reload">
          <RotateCw size={13} />
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            go(address)
          }}
        >
          <input
            className="w-full rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] outline-none focus:border-accent"
            placeholder={localUrl ? `${localUrl}, a URL, or a search` : 'URL or search'}
            value={address}
            onFocus={(e) => (setEditing(true), e.target.select())}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck={false}
          />
        </form>
        {state && state.downloads.length > 0 && (
          <button className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-text" title={state.downloads.map((d) => `${d.state}: ${d.name}`).join('\n')} onClick={() => void api.invoke('shell:openExternal', `file://${state.downloads[0].path.replace(/\/[^/]*$/, '')}`)}>
            <Download size={12} className={state.downloads.some((d) => d.state === 'progressing') ? 'animate-pulse' : ''} /> {state.downloads.length}
          </button>
        )}
        {active?.url && (
          <button className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-text" title="Open in your default browser" onClick={() => void api.invoke('shell:openExternal', active.url)}>
            <ExternalLink size={13} />
          </button>
        )}
      </div>
      {pending && (
        <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-[12px]">
          <ShieldAlert size={14} className="shrink-0 text-warn" />
          <span className="min-w-0 flex-1 truncate">
            {engineLabel} wants to <code className="rounded bg-bg px-1">{pending.toolName.replace(/^mcp__browser__/, '')}</code> on <span className="font-medium">{(() => { try { return new URL(String(pending.input.url)).hostname } catch { return 'this site' } })()}</span>, a sensitive origin.
          </span>
          <button className="rounded-md bg-accent-2 px-2 py-0.5 text-[11px] text-white hover:bg-accent" onClick={() => answer('allow')}>
            Allow once
          </button>
          <button className="rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-panel-2" onClick={() => answer('always')}>
            Allow on this site
          </button>
          <button className="rounded-md border border-border px-2 py-0.5 text-[11px] text-danger hover:bg-panel-2" onClick={() => answer('deny')}>
            Deny
          </button>
        </div>
      )}
      <div ref={host} className="relative min-h-0 flex-1 bg-bg">
        {(!state || state.tabs.length === 0) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[13px] text-muted">
            <Globe size={28} className="opacity-40" />
            <div>A browser for this workspace. Agents can use it too: they navigate, read pages and click by accessibility handles.</div>
            <div className="flex gap-2">
              {localUrl && (
                <button className="rounded-md bg-accent-2 px-3 py-1 text-[12px] text-white hover:bg-accent" onClick={() => go(localUrl)}>
                  Open {localUrl}
                </button>
              )}
              <button className="rounded-md border border-border px-3 py-1 text-[12px] hover:bg-panel-2" onClick={() => act('new')}>
                New tab
              </button>
            </div>
            <div className="max-w-[460px] text-center text-[11px]">Logins persist per space. Actions on infrastructure consoles ask you first; use Pause to take over, for example to sign in.</div>
          </div>
        )}
      </div>
    </div>
  )
}
