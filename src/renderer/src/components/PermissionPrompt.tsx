import React from 'react'
import { useChat } from '@/stores/chat'
import { useApp } from '@/stores/app'
import { Button } from './ui'

/** Renders the oldest pending tool-permission request as a modal. */
export function PermissionPrompt(): React.JSX.Element | null {
  const req = useChat((s) => s.permissions[0])
  const answer = useChat((s) => s.answerPermission)
  const wsName = useApp((s) => s.workspaces.find((w) => w.id === req?.workspaceId)?.name)
  if (!req) return null
  const input = req.input as Record<string, unknown>
  const summary = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : JSON.stringify(input, null, 2)
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
          <Button variant="primary" autoFocus onClick={() => answer(req.requestId, 'allow')}>
            Allow once
          </Button>
        </div>
      </div>
    </div>
  )
}
