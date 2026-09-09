import React, { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { Check, Copy, Globe, Link2, LogOut, Mail, Plus, RefreshCw, ShieldCheck, Trash2, UserMinus, UserPlus, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, inputCls } from './ui'
import { InlineRename } from './InlineRename'
import type { CloudEmail, CloudOrgDetail, DiscoveredOrg } from '@shared/types'

/**
 * Settings → Plan → Emails and Organisations. One account, several verified emails; organisations
 * with members, roles, invite links, verified domains that let colleagues join, join requests, and
 * the count of spaces shared inside. Joining with an invite code stays at the bottom.
 */
export function TeamSection({ signedIn }: { signedIn: boolean }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const account = useApp((s) => s.settings.cloud?.account)
  const pendingInvite = useApp((s) => s.pendingInvite)
  const setPendingInvite = useApp((s) => s.setPendingInvite)
  const [orgs, setOrgs] = useState<CloudOrgDetail[] | null>(null)
  const [discovered, setDiscovered] = useState<DiscoveredOrg[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [newOrg, setNewOrg] = useState('')
  const [domainDraft, setDomainDraft] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const fail = useCallback((err: unknown) => setError(err instanceof Error ? err.message : String(err)), [setError])

  const load = useCallback(async (): Promise<void> => {
    if (!signedIn) {
      setOrgs(null)
      setDiscovered([])
      return
    }
    try {
      const [o, d] = await Promise.all([api.invoke('cloud:orgs'), api.invoke('cloud:discover').catch(() => [])])
      setOrgs(o)
      setDiscovered(d)
    } catch (err) {
      fail(err)
    }
  }, [signedIn, fail])
  useEffect(() => void load(), [load])

  const run = async (key: string, fn: () => Promise<CloudOrgDetail | void | unknown>): Promise<void> => {
    setBusy(key)
    try {
      const out = await fn()
      const org = out && typeof out === 'object' && 'members' in (out as object) ? (out as CloudOrgDetail) : null
      if (org) setOrgs((cur) => ((cur ?? []).some((o) => o.id === org.id) ? (cur ?? []).map((o) => (o.id === org.id ? org : o)) : [...(cur ?? []), org]))
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
  useEffect(() => {
    if (!pendingInvite || pendingInvite.kind !== 'join') return
    if (!signedIn) {
      setCode(pendingInvite.token)
      return
    }
    const token = pendingInvite.token
    setPendingInvite(null)
    void join(token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInvite, signedIn])

  const copy = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text)
    setCopied(text)
    setTimeout(() => setCopied(null), 2000)
  }
  const emails: CloudEmail[] = account?.emails ?? (account?.user.email ? [{ email: account.user.email, primary: true }] : [])

  return (
    <div className="mt-6">
      {/* ---- emails ---- */}
      <section className="mb-6">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Emails</div>
        {!signedIn && <p className="text-[12px] text-muted">Sign in to manage the emails on your account.</p>}
        {signedIn && (
          <div className="rounded-lg border border-border p-3">
            <ul className="mb-2 space-y-1">
              {emails.map((e) => (
                <li key={e.email} className="flex items-center gap-2 text-[12px]">
                  <Mail size={12} className="text-muted" />
                  <span>{e.email}</span>
                  {e.primary && <Badge tone="accent">primary</Badge>}
                  {e.provider && <span className="text-[11px] text-muted">via {e.provider}</span>}
                  {!e.primary && (
                    <Button size="sm" variant="ghost" className="ml-auto" disabled={busy === `rm-email:${e.email}`} onClick={() => void run(`rm-email:${e.email}`, () => api.invoke('cloud:removeEmail', e.email))} title="Remove this email">
                      <X size={12} />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2 text-[12px] text-muted">
              <span>Add an email by signing in with it:</span>
              <Button size="sm" disabled={busy !== null} onClick={() => void run('add-email', () => api.invoke('cloud:addEmail', 'github'))}>
                GitHub
              </Button>
              <Button size="sm" disabled={busy !== null} onClick={() => void run('add-email', () => api.invoke('cloud:addEmail', 'google'))}>
                Google
              </Button>
              <span className="ml-1">A work email lets its organisation find you.</span>
            </div>
          </div>
        )}
      </section>

      {/* ---- organisations ---- */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">Organisations</div>
          {signedIn && (
            <Button size="sm" variant="ghost" className="ml-auto" disabled={busy === 'reload'} onClick={() => void run('reload', () => load())} title="Reload">
              <RefreshCw size={12} />
            </Button>
          )}
        </div>
        {!signedIn && <p className="text-[12px] text-muted">Sign in to see your organisations{pendingInvite?.kind === 'join' ? ', then the invite you opened will be accepted' : ''}.</p>}
        {signedIn && discovered.length > 0 && (
          <div className="mb-3 rounded-lg border border-accent/40 bg-accent/5 p-3">
            <div className="mb-1 text-[12px] font-medium">Organisations for your emails</div>
            {discovered.map((d) => (
              <div key={d.id} className="flex items-center gap-2 text-[12px]">
                <Globe size={12} className="text-muted" />
                <span>{d.name}</span>
                <span className="text-muted">@{d.domain}</span>
                <span className="ml-auto">
                  {d.requested ? (
                    <Badge tone="warn">request pending</Badge>
                  ) : d.domainJoin === 'off' ? (
                    <span className="text-[11px] text-muted">invite only</span>
                  ) : (
                    <Button size="sm" variant="primary" disabled={busy === `join:${d.id}`} onClick={() => void run(`join:${d.id}`, () => api.invoke('cloud:joinOrg', d.id))}>
                      <UserPlus size={12} /> {d.domainJoin === 'open' ? 'Join' : 'Request to join'}
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {signedIn && orgs && orgs.length === 0 && <p className="mb-3 text-[12px] text-muted">You are not in an organisation yet. Create one for your team, or paste an invite from an admin below.</p>}
        {(orgs ?? []).map((org) => {
          const admin = org.role === 'admin'
          return (
            <div key={org.id} className="mb-3 rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center gap-2">
                {renaming === org.id ? (
                  <InlineRename value={org.name} className="text-[13px] font-medium" onSave={(v) => (setRenaming(null), v.trim() && v.trim() !== org.name && void run(`rename:${org.id}`, () => api.invoke('cloud:renameOrg', org.id, v.trim())))} onCancel={() => setRenaming(null)} />
                ) : (
                  <span className={clsx('text-[13px] font-medium', admin && 'cursor-text')} title={admin ? 'Double-click to rename' : undefined} onDoubleClick={() => admin && setRenaming(org.id)}>
                    {org.name}
                  </span>
                )}
                <Badge tone={org.plan === 'team' ? 'accent' : 'muted'}>{org.plan === 'team' ? 'Team' : 'Free'}</Badge>
                <span className="text-[12px] text-muted">
                  {org.members.length} member{org.members.length === 1 ? '' : 's'}
                  {org.plan === 'team' && org.seats ? ` of ${org.seats} seats` : ''} · {org.sharedSpaces} shared space{org.sharedSpaces === 1 ? '' : 's'}
                  {org.sharedSpaceLimit !== null ? ` of ${org.sharedSpaceLimit}` : ''}
                  {org.subscription?.endsAt ? ` · ends ${new Date(org.subscription.endsAt).toLocaleDateString()}` : ''}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  {admin && (
                    <Button size="sm" disabled={busy === `invite:${org.id}`} onClick={() => void run(`invite:${org.id}`, () => api.invoke('cloud:invite', org.id, 'member'))}>
                      <Plus size={12} /> Invite link
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={busy === `leave:${org.id}`} onClick={() => void run(`leave:${org.id}`, () => api.invoke('cloud:leaveOrg', org.id))} title="Leave this organisation">
                    <LogOut size={12} />
                  </Button>
                  {admin && org.members.length === 1 && (
                    <Button size="sm" variant="ghost" disabled={busy === `delete:${org.id}`} onClick={() => window.confirm(`Delete ${org.name}? Its shared spaces are removed from the server; local copies stay.`) && void run(`delete:${org.id}`, () => api.invoke('cloud:deleteOrg', org.id))} title="Delete this organisation">
                      <Trash2 size={12} />
                    </Button>
                  )}
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
                      <Button size="sm" variant="ghost" className="ml-auto" disabled={busy === `rm:${m.id}`} onClick={() => void run(`rm:${m.id}`, () => api.invoke('cloud:removeMember', org.id, m.id))} title="Remove from the organisation">
                        <UserMinus size={12} />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {admin && org.requests.length > 0 && (
                <div className="mt-2 border-t border-border pt-2">
                  <div className="mb-1 text-[11px] text-muted">Asking to join through a verified domain</div>
                  {org.requests.map((r) => (
                    <div key={r.userId} className="flex items-center gap-2 text-[12px]">
                      {r.avatarUrl ? <img src={r.avatarUrl} alt="" className="h-5 w-5 rounded-full" /> : <span className="h-5 w-5 rounded-full bg-panel-2" />}
                      <span>{r.name || r.login}</span>
                      <span className="text-muted">{r.email}</span>
                      <span className="ml-auto flex gap-1">
                        <Button size="sm" variant="primary" disabled={busy === `req:${r.userId}`} onClick={() => void run(`req:${r.userId}`, () => api.invoke('cloud:decideRequest', org.id, r.userId, 'approve'))}>
                          Approve
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy === `req:${r.userId}`} onClick={() => void run(`req:${r.userId}`, () => api.invoke('cloud:decideRequest', org.id, r.userId, 'deny'))}>
                          Deny
                        </Button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {(admin || org.domains.length > 0) && (
                <div className="mt-2 border-t border-border pt-2">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
                    <span>Domains. Colleagues with a verified email on one of these can join</span>
                    {admin ? (
                      <select className="rounded border border-border bg-bg px-1 py-0.5 text-[11px]" value={org.domainJoin} disabled={busy === `policy:${org.id}`} onChange={(e) => void run(`policy:${org.id}`, () => api.invoke('cloud:setDomainJoin', org.id, e.target.value as 'open' | 'approval' | 'off'))}>
                        <option value="open">at once</option>
                        <option value="approval">after an admin approves</option>
                        <option value="off">never (invite links only)</option>
                      </select>
                    ) : (
                      <span>{org.domainJoin === 'open' ? 'at once' : org.domainJoin === 'approval' ? 'after an admin approves' : 'never'}</span>
                    )}
                  </div>
                  {org.domains.map((d) => (
                    <div key={d.domain} className="mb-1 text-[12px]">
                      <div className="flex items-center gap-2">
                        <ShieldCheck size={12} className={d.verified ? 'text-ok' : 'text-muted'} />
                        <span>{d.domain}</span>
                        {d.verified ? <Badge tone="ok">verified</Badge> : <Badge tone="warn">not verified</Badge>}
                        {admin && !d.verified && (
                          <Button size="sm" disabled={busy === `verify:${d.domain}`} onClick={() => void run(`verify:${d.domain}`, async () => {
                            const r = await api.invoke('cloud:verifyDomain', org.id, d.domain)
                            if (!r.verified) setError(`No matching TXT record at ${r.record} yet${r.found?.length ? ` (found: ${r.found.join(', ')})` : ''}. DNS changes can take a few minutes.`)
                            return r.org
                          })}>
                            Verify
                          </Button>
                        )}
                        {admin && (
                          <Button size="sm" variant="ghost" className="ml-auto" disabled={busy === `rm-domain:${d.domain}`} onClick={() => void run(`rm-domain:${d.domain}`, () => api.invoke('cloud:removeDomain', org.id, d.domain))} title="Remove this domain">
                            <Trash2 size={12} />
                          </Button>
                        )}
                      </div>
                      {admin && !d.verified && d.token && (
                        <div className="ml-5 mt-1 rounded-md border border-border bg-bg px-2 py-1 font-mono text-[11px] text-muted">
                          Add a TXT record at <span className="text-text">_sinfonie.{d.domain}</span> with the value <span className="text-text">{d.token}</span>
                          <button className="ml-2 text-accent hover:underline" onClick={() => void copy(d.token as string)}>
                            {copied === d.token ? 'copied' : 'copy'}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {admin && (
                    <div className="mt-1 flex items-center gap-2">
                      <input className={clsx(inputCls, 'max-w-[260px]')} placeholder="company.com" value={domainDraft[org.id] ?? ''} onChange={(e) => setDomainDraft({ ...domainDraft, [org.id]: e.target.value })} />
                      <Button size="sm" disabled={!(domainDraft[org.id] ?? '').trim() || busy === `add-domain:${org.id}`} onClick={() => void run(`add-domain:${org.id}`, async () => {
                        const r = await api.invoke('cloud:addDomain', org.id, domainDraft[org.id])
                        setDomainDraft({ ...domainDraft, [org.id]: '' })
                        return r.org
                      })}>
                        Add domain
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {admin && org.invites.length > 0 && (
                <div className="mt-2 border-t border-border pt-2">
                  <div className="mb-1 text-[11px] text-muted">Open invite links. Anyone with a link can join while a seat is free.</div>
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
        {signedIn && (
          <div className="mb-2 flex items-center gap-2">
            <input className={inputCls} placeholder="New organisation, e.g. Lumepic" value={newOrg} onChange={(e) => setNewOrg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && newOrg.trim() && void run('create', () => api.invoke('cloud:createOrg', newOrg).then((o) => (setNewOrg(''), o)))} />
            <Button disabled={!newOrg.trim() || busy === 'create'} onClick={() => void run('create', () => api.invoke('cloud:createOrg', newOrg).then((o) => (setNewOrg(''), o)))}>
              <Plus size={12} /> Create
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <input className={inputCls} placeholder="Paste an invite link or code to join an organisation" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void join(code)} disabled={!signedIn} />
          <Button disabled={!signedIn || !code.trim() || busy === 'join'} onClick={() => void join(code)}>
            Join
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted">A free organisation shares one space; the Team plan, per seat, shares any number and adds central billing. Personal spaces stay yours either way.</p>
      </section>
    </div>
  )
}
