import React from 'react'
import { useChat } from '@/stores/chat'
import { useApp } from '@/stores/app'
import { Button } from './ui'
import { api } from '@/lib/api'
import { useGuided } from '@/lib/guided'

/** Renders the oldest pending tool-permission request as a modal. */
export function PermissionPrompt(): React.JSX.Element | null {
  const req = useChat((s) => s.permissions[0])
  const answer = useChat((s) => s.answerPermission)
  const wsName = useApp((s) => s.workspaces.find((w) => w.id === req?.workspaceId)?.name)
  const guided = useGuided()
  const [details, setDetails] = React.useState(false)
  // Native browser pages draw above the DOM, so an open prompt would be hidden behind them and
  // unanswerable. Detach the browser view (ref-counted) while any request is waiting.
  React.useEffect(() => {
    if (!req) return
    void api.invoke('browser:suspend', true)
    return () => void api.invoke('browser:suspend', false)
  }, [!req])
  if (!req) return null
  const input = req.input as Record<string, unknown>
  const summary = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : JSON.stringify(input, null, 2)
  const allowAll = async (): Promise<void> => {
    // Switch the workspace to Auto (a classifier approves the rest), then let this call through.
    try {
      await api.invoke('agent:setMode', req.workspaceId, 'auto')
    } catch (err) {
      useApp.getState().setError(err instanceof Error ? err.message : String(err))
    }
    await answer(req.requestId, 'allow')
  }
  // Guided mode runs on Auto, so a prompt only arrives when the classifier would not decide alone. It is
  // put in words; the raw command stays behind "Show details" for a colleague looking over the shoulder.
  if (guided) {
    const what = req.blockedPath
      ? `It wants to change something outside this task (${req.blockedPath}).`
      : typeof input.file_path === 'string'
        ? `It wants to change ${input.file_path}.`
        : 'It wants to run something that needs your OK.'
    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 pb-8 no-drag">
        <div className="w-[520px] max-w-[92vw] rounded-xl border border-warn/40 bg-panel p-4 shadow-2xl">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-warn">The assistant needs your OK · {wsName}</div>
          <div className="mb-1 text-[14px] font-semibold">{what}</div>
          <p className="mb-3 text-[12px] text-muted">If you are not sure, say no and ask a colleague. Nothing happens until you answer.</p>
          {details && <pre className="mb-3 max-h-40 overflow-auto rounded-md border border-border bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap">{summary}</pre>}
          <div className="flex items-center gap-2">
            <button className="text-[12px] text-muted hover:text-text" onClick={() => setDetails(!details)}>
              {details ? 'Hide details' : 'Show details'}
            </button>
            <span className="ml-auto" />
            <Button variant="danger" onClick={() => answer(req.requestId, 'deny')}>
              No
            </Button>
            <Button variant="primary" autoFocus onClick={() => answer(req.requestId, 'allow')}>
              Go ahead
            </Button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 pb-8 no-drag">
      <div className="w-[560px] max-w-[92vw] rounded-xl border border-warn/40 bg-panel p-4 shadow-2xl">
        <div className="mb-1 text-[11px] uppercase tracking-wide text-warn">Permission needed · {wsName}</div>
        <div className="mb-2 text-[14px] font-semibold">
          Allow <code className="rounded bg-bg px-1">{req.toolName}</code>?
        </div>
        <pre className="mb-3 max-h-48 overflow-auto rounded-md border border-border bg-bg p-2 font-mono text-[12px] whitespace-pre-wrap">{summary}</pre>
        {req.blockedPath && <div className="mb-3 text-[12px] text-muted">Touches a path outside the workspace: {req.blockedPath}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="danger" onClick={() => answer(req.requestId, 'deny')}>
            Deny
          </Button>
          {req.canAlwaysAllow && <Button onClick={() => answer(req.requestId, 'always')}>Always allow</Button>}
          <Button onClick={allowAll} title="Approve this and switch the workspace to Auto mode for the rest of the session">
            Allow all · Auto
          </Button>
          <Button variant="primary" autoFocus onClick={() => answer(req.requestId, 'allow')}>
            Allow once
          </Button>
        </div>
      </div>
    </div>
  )
}
