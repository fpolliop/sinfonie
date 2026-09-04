import React, { useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Field, inputCls } from './ui'

export function JiraSection({ connId, title, intro }: { connId: string; title?: string; intro?: string }): React.JSX.Element {
  const { settings, spaces, setError } = useApp()
  const space = spaces.find((s) => s.id === connId)
  const [token, setToken] = useState('')
  const [authing, setAuthing] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [showToken, setShowToken] = useState(false)
  const jira = connId ? space?.jira ?? { connected: false, siteUrl: '', email: '', hasToken: false, defaultJql: settings.jira.defaultJql } : settings.jira
  const save = async (patch: Partial<typeof jira>): Promise<void> => {
    try {
      await api.invoke('jira:updateSettings', connId, patch)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const authenticate = async (): Promise<void> => {
    setAuthing(true)
    setTesting('Waiting for you to approve access in the browser…')
    try {
      await api.invoke('jira:authenticate', connId)
      setTesting('Connected.')
    } catch (err) {
      setTesting(err instanceof Error ? err.message : String(err))
    } finally {
      setAuthing(false)
    }
  }
  const disconnect = async (): Promise<void> => {
    try {
      await api.invoke('jira:disconnect', connId)
      setTesting(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const saveToken = async (): Promise<void> => {
    try {
      await api.invoke('jira:saveToken', connId, token)
      setToken('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const test = async (): Promise<void> => {
    setTesting('Testing…')
    try {
      const issues = await api.invoke('jira:search', connId, '')
      setTesting(`Connected. ${issues.length} ticket${issues.length === 1 ? '' : 's'} match the default query.`)
    } catch (err) {
      setTesting(err instanceof Error ? err.message : String(err))
    }
  }
  const tokenReady = Boolean(jira.siteUrl && jira.email && jira.hasToken)
  return (
    <section className="mt-5">
      <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">{title ?? 'Jira'}</h3>
      <p className="mb-3 text-[11px] text-muted">{intro ?? 'Lets "New workspace" start from a ticket and suggest a name. Spaces without their own connection use this one.'}</p>
      <div className="mb-3 flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          {jira.connected ? (
            <>
              <div className="flex items-center gap-2 text-[13px] font-medium">
                Connected <Badge tone="ok">OAuth</Badge>
              </div>
              <div className="truncate text-[11px] text-muted">
                {jira.siteName ? `${jira.siteName} · ` : ''}
                {jira.siteUrl}
              </div>
            </>
          ) : (
            <>
              <div className="text-[13px] font-medium">Not connected</div>
              <div className="text-[11px] text-muted">Opens Atlassian in your browser; approve once and Sinfonie keeps a refresh token, encrypted on this Mac.</div>
            </>
          )}
        </div>
        {jira.connected ? (
          <Button size="sm" onClick={disconnect}>
            Disconnect
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={authenticate} disabled={authing}>
            {authing ? 'Waiting…' : 'Authenticate with Jira'}
          </Button>
        )}
      </div>
      <Field label="Default ticket list (JQL)" hint="Shown when the search box is empty.">
        <input className={inputCls} defaultValue={jira.defaultJql} onBlur={(e) => e.target.value !== jira.defaultJql && save({ defaultJql: e.target.value })} />
      </Field>
      <div className="mb-3 flex items-center gap-3">
        <Button size="sm" onClick={test} disabled={!(jira.connected || tokenReady)}>
          Test connection
        </Button>
        {testing && <span className="text-[12px] text-muted">{testing}</span>}
      </div>
      <button className="text-[12px] text-muted hover:text-text" onClick={() => setShowToken(!showToken)}>
        {showToken ? '▾' : '▸'} Use an API token instead
      </button>
      {showToken && (
        <div className="mt-2 rounded-lg border border-border p-3">
          <p className="mb-3 text-[11px] text-muted">
            Fallback for accounts where OAuth is blocked. Create a token at{' '}
            <button className="text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', 'https://id.atlassian.com/manage-profile/security/api-tokens')}>
              id.atlassian.com
            </button>
            . Used only while not connected with OAuth.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Site URL">
              <input className={inputCls} placeholder="https://your-team.atlassian.net" defaultValue={jira.siteUrl} onBlur={(e) => e.target.value !== jira.siteUrl && save({ siteUrl: e.target.value.trim() })} />
            </Field>
            <Field label="Email">
              <input className={inputCls} placeholder="you@company.com" defaultValue={jira.email} onBlur={(e) => e.target.value !== jira.email && save({ email: e.target.value.trim() })} />
            </Field>
          </div>
          <Field label={jira.hasToken ? 'API token (stored; paste a new one to replace)' : 'API token'}>
            <div className="flex gap-2">
              <input type="password" className={inputCls} value={token} onChange={(e) => setToken(e.target.value)} placeholder={jira.hasToken ? '••••••••' : ''} />
              <Button onClick={saveToken} disabled={!token.trim()}>
                Save
              </Button>
            </div>
          </Field>
        </div>
      )}
    </section>
  )
}

