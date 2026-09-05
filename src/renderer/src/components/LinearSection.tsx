import React, { useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Field, inputCls } from './ui'

/** Linear connection for the app default ('') or one space. */
export function LinearSection({ connId, title, intro }: { connId: string; title?: string; intro?: string }): React.JSX.Element {
  const { settings, spaces, setError } = useApp()
  const space = spaces.find((s) => s.id === connId)
  const linear = (connId ? space?.linear : settings.linear) ?? { connected: false, defaultQuery: '' }
  const [authing, setAuthing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const save = async (patch: Partial<typeof linear>): Promise<void> => {
    try {
      await api.invoke('linear:updateSettings', connId, patch)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const authenticate = async (): Promise<void> => {
    setAuthing(true)
    setStatus('Waiting for you to approve access in the browser…')
    try {
      await api.invoke('linear:authenticate', connId)
      setStatus('Connected.')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setAuthing(false)
    }
  }
  const test = async (): Promise<void> => {
    setStatus('Testing…')
    try {
      const issues = await api.invoke('linear:search', connId, '')
      setStatus(`Connected. ${issues.length} issue${issues.length === 1 ? '' : 's'} match the default list.`)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <section className="mt-5">
      <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">{title ?? 'Linear'}</h3>
      <p className="mb-3 text-[11px] text-muted">{intro ?? 'Lets "New workspace" start from a Linear issue and suggest a name, shows the issue state on the workspace, and gives agents Linear tools.'}</p>
      <div className="mb-3 flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          {linear.connected ? (
            <>
              <div className="flex items-center gap-2 text-[13px] font-medium">
                Connected <Badge tone="ok">OAuth</Badge>
              </div>
              <div className="truncate text-[11px] text-muted">{[linear.userName, linear.orgName].filter(Boolean).join(' · ') || 'Linear MCP'}</div>
            </>
          ) : (
            <>
              <div className="text-[13px] font-medium">Not connected</div>
              <div className="text-[11px] text-muted">Opens Linear in your browser; approve once and Sinfonie keeps a refresh token, encrypted on this Mac. Nothing to register.</div>
            </>
          )}
        </div>
        {linear.connected ? (
          <Button size="sm" onClick={() => void api.invoke('linear:disconnect', connId).then(() => setStatus(null)).catch((e) => setError(String(e)))}>
            Disconnect
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={authenticate} disabled={authing}>
            {authing ? 'Waiting…' : 'Connect Linear'}
          </Button>
        )}
      </div>
      <Field label="Default issue list" hint="Search text used when the picker's box is empty. Leave empty for your open issues.">
        <input className={inputCls} placeholder="e.g. team:ENG or a project name" defaultValue={linear.defaultQuery} onBlur={(e) => e.target.value !== linear.defaultQuery && save({ defaultQuery: e.target.value })} />
      </Field>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={test} disabled={!linear.connected}>
          Test connection
        </Button>
        {status && <span className="text-[12px] text-muted">{status}</span>}
      </div>
    </section>
  )
}
