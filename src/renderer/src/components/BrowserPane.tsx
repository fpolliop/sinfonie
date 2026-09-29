import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, ArrowRight, RotateCw, Plus, X, Globe, Pause, Play, ExternalLink, ShieldAlert, Download, KeyRound } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useGuided, previewUrlFor } from '@/lib/guided'
import { useBrowser, subscribeBrowser, loadBrowserState } from '@/stores/browser'
import { useScripts } from '@/stores/scripts'
import { useChat } from '@/stores/chat'
import { Button, IconButton } from './ui'
import { ImportLogins } from './ImportLogins'
import type { PermissionRequest } from '@shared/types'

/** Workspaces whose run script guided mode already kicked off, so switching tabs does not restart it. */
const started = new Set<string>()

/**
 * The workspace browser. The page itself is a native view the main process places over this pane,
 * so this component owns the chrome (tabs, address bar, agent controls) and reports its bounds.
 */
export function BrowserPane({ workspaceId, visible }: { workspaceId: string; visible: boolean }): React.JSX.Element {
  const guided = useGuided()
  const state = useBrowser((s) => s.states[workspaceId])
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const engine = useApp((s) => s.settings.engine ?? 'claude-code')
  const space = useApp((s) => s.spaces.find((sp) => sp.id === ws?.spaceId))
  const host = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [pending, setPending] = useState<PermissionRequest | null>(null)
  const [showImport, setShowImport] = useState(false)
  useEffect(() => {
    subscribeBrowser()
    loadBrowserState(workspaceId)
  }, [workspaceId])
  const active = state?.tabs.find((t) => t.id === state.activeId) ?? null
  useEffect(() => {
    if (!editing) setAddress(active?.url && active.url !== 'about:blank' ? active.url : '')
  }, [active?.url, editing])

  // Guided mode: start the app and open its preview the first time this workspace's Preview is shown.
  const runs = useScripts((s) => s.runs)
  useEffect(() => useScripts.getState().subscribe(), [])
  const previewUrl = guided ? previewUrlFor(ws ?? undefined) : ''
  useEffect(() => {
    if (!guided || !visible || !ws || ws.status !== 'ready') return
    if (started.has(workspaceId)) return
    started.add(workspaceId)
    void api.invoke('workspaces:runScript', workspaceId, 'run').catch(() => undefined)
    // Give the server a moment to bind before the first navigation; a reload button is always there.
    const t = setTimeout(() => void api.invoke(state?.tabs.length ? 'browser:navigate' : 'browser:open', workspaceId, previewUrl), 1500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guided, visible, ws?.status, workspaceId])
  /** The end of the failed run's output, for Maestro to read when asked to fix it. */
  const failedOutput = (): string =>
    Object.entries(runs)
      .filter(([k, r]) => k.startsWith(`${workspaceId}:`) && k.endsWith(':run') && (r.exitCode ?? 0) !== 0)
      .map(([, r]) => r.output.trim().slice(-2000))
      .filter(Boolean)
      .join('\n\n')
  const askToFix = (): void => {
    const out = failedOutput()
    const text = `The app did not start in the preview. Please find out why and fix it, then start it again.${out ? `\n\nWhat it printed:\n\n\`\`\`\n${out}\n\`\`\`` : ''}`
    // The conversation sits beside the preview, so the request shows up there at once.
    void useChat.getState().send(workspaceId, text)
  }
  const runState = ((): 'starting' | 'running' | 'failed' | null => {
    if (!guided || !ws) return null
    const mine = Object.entries(runs).filter(([k]) => k.startsWith(`${workspaceId}:`) && k.endsWith(':run'))
    if (mine.some(([, r]) => r.running)) return active?.url ? 'running' : 'starting'
    // The run script failing only matters when the preview can't load: Maestro may have started the app another way.
    const pageUp = Boolean(active?.url && !active.loading && !active.failed)
    if (mine.length && mine.every(([, r]) => (r.exitCode ?? 0) !== 0)) return pageUp ? null : 'failed'
    return null
  })()

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
        if (req.workspaceId === workspaceId && /browser/.test(req.toolName)) {
          setPending(req)
          // Make sure this banner is on screen to be answered, even if the user stepped away from the pane.
          const st = useApp.getState()
          if (st.tab !== 'browser' || !st.inspectorOpen) st.setTab('browser')
        }
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
  const engineLabel = guided ? 'Maestro' : (space?.engine ?? engine) === 'claude-code' ? 'Claude' : 'The agent'
  const pendingHost = ((): string => {
    try {
      return new URL(String(pending?.input.url)).hostname
    } catch {
      return 'this site'
    }
  })()

  return (
    <div className="flex h-full flex-col">
      <div className={clsx('flex items-center gap-1 border-b border-border px-2 py-1', state?.agentBusy && 'bg-accent/5')}>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {guided && active && (
            <span className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-[12px] text-text">
              {active.loading ? <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" aria-label="Loading" /> : <Globe size={11} className="shrink-0 opacity-60" />}
              <span className="truncate">{active.title}</span>
            </span>
          )}
          {!guided && state?.tabs.map((t) => (
            <div key={t.id} className={clsx('group flex max-w-[180px] shrink-0 items-center gap-0.5 rounded-md pl-2 pr-0.5 text-[12px]', t.id === state.activeId ? 'bg-panel-2 text-text' : 'text-muted hover:bg-panel-2/60')} title={guided ? t.title : t.url}>
              <button className="flex min-w-0 items-center gap-1.5 py-1" aria-current={t.id === state.activeId ? 'page' : undefined} onClick={() => act('select', t.id)}>
                {t.loading ? <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" aria-label="Loading" /> : <Globe size={11} className="shrink-0 opacity-60" />}
                <span className="truncate">{t.title}</span>
              </button>
              <IconButton label={`Close ${t.title}`} className="reveal-on-focus opacity-0 group-hover:opacity-100" onClick={() => act('close', t.id)}>
                <X size={11} />
              </IconButton>
            </div>
          ))}
          {!guided && (
            <IconButton label="New tab" onClick={() => act('new')}>
              <Plus size={13} />
            </IconButton>
          )}
        </div>
        {state?.agentBusy && !state.paused && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> {guided ? 'Maestro is using the preview' : `${engineLabel} is browsing`}
          </span>
        )}
        {guided && (
          <IconButton label="Refresh the preview" className="shrink-0" disabled={!active} onClick={() => act('reload')}>
            <RotateCw size={13} />
          </IconButton>
        )}
        {state?.paused ? (
          <button className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warn/50 bg-warn/10 px-2 py-0.5 text-[11px] text-warn hover:bg-warn/20" title="Agent actions are waiting. Click to hand control back." onClick={() => void api.invoke('browser:setPaused', workspaceId, false)}>
            <Play size={11} /> {guided ? 'You have the preview · give it back' : 'You have control · resume agent'}
          </button>
        ) : (
          <IconButton className="shrink-0" label={guided ? 'Take over the preview, for example to sign in yourself; Maestro waits until you give it back' : 'Pause agent control: its next browser action waits until you resume (e.g. to sign in yourself)'} onClick={() => void api.invoke('browser:setPaused', workspaceId, true)}>
            <Pause size={13} />
          </IconButton>
        )}
      </div>
      {!guided && (
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <IconButton label="Back" className="disabled:opacity-40" onClick={() => act('back')} disabled={!active}>
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton label="Forward" className="disabled:opacity-40" onClick={() => act('forward')} disabled={!active}>
          <ArrowRight size={14} />
        </IconButton>
        <IconButton label="Reload" className="disabled:opacity-40" onClick={() => act('reload')} disabled={!active}>
          <RotateCw size={13} />
        </IconButton>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            go(address)
          }}
        >
          <input
            aria-label="Address"
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
        <IconButton label="Import your logins from Chrome, Arc, Brave or Edge so this browser is already signed in" aria-pressed={showImport} className={clsx(showImport && 'text-accent')} onClick={() => setShowImport((v) => !v)}>
          <KeyRound size={13} />
        </IconButton>
        {active?.url && (
          <IconButton label="Open in your default browser" onClick={() => void api.invoke('shell:openExternal', active.url)}>
            <ExternalLink size={13} />
          </IconButton>
        )}
      </div>
      )}
      {showImport && (
        <div className="flex items-center gap-3 border-b border-border bg-panel/40 px-3 py-2 text-[12px]">
          <span className="text-muted">Bring your existing logins into this space's browser:</span>
          <div className="min-w-0 flex-1">
            <ImportLogins spaceId={ws?.spaceId} alwaysShow onImported={() => act('reload')} />
          </div>
          <IconButton label="Hide" onClick={() => setShowImport(false)}>
            <X size={13} />
          </IconButton>
        </div>
      )}
      {runState && (
        <div className={clsx('flex items-center gap-2 border-b px-3', runState === 'failed' ? 'border-danger/30 bg-danger/10 py-2 text-[13px]' : 'border-border bg-panel/40 py-1 text-[11px] text-muted')}>
          {runState === 'failed' ? (
            <>
              <span role="alert" className="min-w-0 flex-1">
                <span className="font-medium text-danger">The app did not start.</span>{' '}
                <span className="text-muted">{guided ? 'Often the latest change broke something; Maestro can usually fix it.' : 'The run script exited with an error; see Terminal › Setup and run scripts for its output.'}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => { started.delete(workspaceId); void api.invoke('workspaces:runScript', workspaceId, 'run') }}>
                Try again
              </Button>
              <Button size="sm" variant="primary" onClick={askToFix}>
                Ask Maestro to fix it
              </Button>
            </>
          ) : runState === 'starting' ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> Starting the app…
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-ok" /> Preview is live. It updates as Maestro works.
            </>
          )}
        </div>
      )}
      {pending && (
        <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-[12px]">
          <ShieldAlert size={14} className="shrink-0 text-warn" />
          <span className="min-w-0 flex-1 truncate" role="alert">
            {guided ? (
              <>
                Maestro wants to open <span className="font-medium">{pendingHost}</span>.
              </>
            ) : (
              <>
                {engineLabel} wants to <code className="rounded bg-bg px-1">{pending.toolName.replace(/^mcp__browser__/, '')}</code> on <span className="font-medium">{pendingHost}</span>, a sensitive origin.
              </>
            )}
          </span>
          <Button size="sm" variant="danger" onClick={() => answer('deny')}>
            {guided ? 'No' : 'Deny'}
          </Button>
          <Button size="sm" onClick={() => answer('always')} title={`Allow on ${pendingHost} from now on, without asking`}>
            {guided ? 'Always on this site' : 'Allow on this site'}
          </Button>
          <Button size="sm" variant="primary" onClick={() => answer('allow')}>
            {guided ? 'Go ahead' : 'Allow once'}
          </Button>
        </div>
      )}
      <div ref={host} className="relative min-h-0 flex-1 bg-bg">
        {(!state || state.tabs.length === 0) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[13px] text-muted">
            <Globe size={28} className="opacity-40" />
            {guided ? (
              <div>Your app, running on your Mac with your changes.</div>
            ) : (
              <div>A browser for this workspace. Agents can use it too: they navigate, read pages and click by accessibility handles.</div>
            )}
            <div className="flex gap-2">
              {guided ? (
                <Button variant="primary" onClick={() => { started.add(workspaceId); void api.invoke('workspaces:runScript', workspaceId, 'run'); go(previewUrl || localUrl) }}>
                  Open the preview
                </Button>
              ) : (
                <>
                  {localUrl && (
                    <Button variant="primary" size="sm" onClick={() => go(localUrl)}>
                      Open {localUrl}
                    </Button>
                  )}
                  <Button size="sm" onClick={() => act('new')}>
                    New tab
                  </Button>
                </>
              )}
            </div>
            {!guided && <ImportLogins spaceId={ws?.spaceId} onImported={() => act('reload')} />}
            <div className="max-w-[460px] text-center text-[11px]">{guided ? 'Nobody else sees it until you send for review. Sign-ins are remembered.' : 'Logins persist per space. Actions on infrastructure consoles ask you first; use Pause to take over, for example to sign in.'}</div>
          </div>
        )}
      </div>
    </div>
  )
}
