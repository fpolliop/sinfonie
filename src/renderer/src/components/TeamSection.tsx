import React, { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Link2, LogOut, Plus, RefreshCw, Trash2, UserMinus } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, inputCls } from './ui'
import type { CloudOrgDetail } from '@shared/types'

/** Settings → Plan → Teams: the teams the account belongs to, their members and invite links; joining with a code. */
export function TeamSection({ signedIn }: { signedIn: boolean }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const pendingInvite = useApp((s) => s.pendingInvite)
  const setPendingInvite = useApp((s) => s.setPendingInvite)
  const [orgs, setOrgs] = useState<CloudOrgDetail[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const fail = useCallback((err: unknown) => setError(err instanceof Error ? err.message : String(err)), [setError])

  const load = useCallback(async (): Promise<void> => {
    if (!signedIn) return setOrgs(null)
    try {
      setOrgs(await api.invoke('cloud:orgs'))
    } catch (err) {
      fail(err)
    }
  }, [signedIn, fail])
  useEffect(() => void load(), [load])

  const run = async (key: string, fn: () => Promise<CloudOrgDetail | void>): Promise<void> => {
    setBusy(key)
    try {
      const org = await fn()
      if (org) setOrgs((cur) => (cur ?? []).some((o) => o.id === org.id) ? (cur ?? []).map((o) => (o.id === org.id ? org : o)) : [...(cur ?? []), org])
      else await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }
  const join = async (c: string): Promise<void> => {
    if (!c.trim()) return
    await run('join', () => api.invoke('cloud:acceptInvite', c))
    setCode('')
  }
  // A sinfonie://join link arrived while (or before) this page was open.
  useEffect(() => {
    if (!pendingInvite) return
    if (!signedIn) {
      setCode(pendingInvite)
      return
    }
    const token = pendingInvite
    setPendingInvite(null)
    void join(token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInvite, signedIn])

  const copy = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text)
    setCopied(text)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">Teams</div>
        {signedIn && (
          <Button size="sm" variant="ghost" className="ml-auto" disabled={busy === 'reload'} onClick={() => void run('reload', () => load())} title="Reload">
            <RefreshCw size={12} />
          </Button>
        )}
      </div>
      {!signedIn && <p className="text-[12px] text-muted">Sign in to see your teams{pendingInvite ? ', then the invite you opened will be accepted' : ''}.</p>}
      {signedIn && orgs && orgs.length === 0 && <p className="mb-3 text-[12px] text-muted">You are not in a team yet. Buy the Team plan above to start one, or paste an invite from a team admin below.</p>}
      {(orgs ?? []).map((org) => {
        const admin = org.role === 'admin'
        const used = org.members.length
        return (
          <div key={org.id} className="mb-3 rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[13px] font-medium">{org.name}</span>
              <Badge tone={org.plan === 'team' ? 'accent' : 'muted'}>{org.plan === 'team' ? 'Team' : 'No subscription'}</Badge>
              <span className="text-[12px] text-muted">
                {used} of {org.seats || '∞'} seats{org.subscription?.endsAt ? ` · ends ${new Date(org.subscription.endsAt).toLocaleDateString()}` : ''}
              </span>
              <span className="ml-auto flex items-center gap-1">
                {admin && (
                  <Button size="sm" disabled={busy === `invite:${org.id}`} onClick={() => void run(`invite:${org.id}`, () => api.invoke('cloud:invite', org.id, 'member'))}>
                    <Plus size={12} /> Invite link
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy === `leave:${org.id}`} onClick={() => void run(`leave:${org.id}`, () => api.invoke('cloud:leaveOrg', org.id))} title="Leave this team">
                  <LogOut size={12} />
                </Button>
              </span>
            </div>
            <ul className="space-y-1">
              {org.members.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-[12px]">
                  {m.avatarUrl ? <img src={m.avatarUrl} alt="" className="h-5 w-5 rounded-full" /> : <span className="h-5 w-5 rounded-full bg-panel-2" />}
                  <span>{m.name || m.login}</span>
                  <span className="text-muted">@{m.login}</span>
                  {admin ? (
                    <select className="ml-1 rounded border border-border bg-bg px-1 py-0.5 text-[11px]" value={m.role} disabled={busy === `role:${m.id}`} onChange={(e) => void run(`role:${m.id}`, () => api.invoke('cloud:setMemberRole', org.id, m.id, e.target.value as 'admin' | 'member'))}>
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  ) : (
                    <Badge>{m.role}</Badge>
                  )}
                  {admin && (
                    <Button size="sm" variant="ghost" className="ml-auto" disabled={busy === `rm:${m.id}`} onClick={() => void run(`rm:${m.id}`, () => api.invoke('cloud:removeMember', org.id, m.id))} title="Remove from the team">
                      <UserMinus size={12} />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {admin && org.invites.length > 0 && (
              <div className="mt-2 border-t border-border pt-2">
                <div className="mb-1 text-[11px] text-muted">Open invites. Anyone with a link can join while a seat is free.</div>
                {org.invites.map((inv) => (
                  <div key={inv.token} className="flex items-center gap-2 text-[12px]">
                    <Link2 size={12} className="text-muted" />
                    <span className="truncate font-mono text-[11px] text-muted">{inv.url}</span>
                    <Badge>{inv.role}</Badge>
                    <Button size="sm" variant="ghost" onClick={() => void copy(inv.url)}>
                      {copied === inv.url ? <Check size={12} /> : <Copy size={12} />}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy === `revoke:${inv.token}`} onClick={() => void run(`revoke:${inv.token}`, () => api.invoke('cloud:revokeInvite', org.id, inv.token))} title="Revoke">
                      <Trash2 size={12} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      <div className="flex items-center gap-2">
        <input className={inputCls} placeholder="Paste an invite link or code to join a team" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void join(code)} disabled={!signedIn} />
        <Button disabled={!signedIn || !code.trim() || busy === 'join'} onClick={() => void join(code)}>
          Join
        </Button>
      </div>
    </section>
  )
}
