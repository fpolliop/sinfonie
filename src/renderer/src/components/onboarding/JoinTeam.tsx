import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Copy, Loader2, LogIn, RefreshCw, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, inputCls } from '../ui'
import { friendlyError } from '@/lib/errors'
import { useInlineCloudSignIn } from '../AuthLinkDialog'
import { ConnectGitHubCard } from '../ConnectGitHub'
import type { DiscoveredOrg, RepoCloneError } from '@shared/types'

/**
 * Sinfonie sign-in with the Google or GitHub account the team uses, then the organisation that claimed that email's
 * domain (or an invite link): join it, and its shared spaces (the team's apps) arrive on this Mac by themselves. An
 * invite link can be pasted before signing in: it is kept, and used as soon as the sign-in lands. Every wait says
 * what it waits on and can be cancelled or checked again; every failure says why, with one action.
 */
export function JoinTeam({ onSpace }: { onSpace: (id: string) => void }): React.JSX.Element {
  const account = useApp((s) => s.settings.cloud?.account)
  const [invite, setInvite] = useState('')
  return account ? <SignedIn onSpace={onSpace} initialInvite={invite} onInviteUsed={() => setInvite('')} /> : <SignInInline invite={invite} setInvite={setInvite} />
}

/** Sign in to Sinfonie with the sign-in shown right here: the browser opens, this card waits, Cancel stops it. */
function SignInInline({ invite, setInvite }: { invite: string; setInvite: (v: string) => void }): React.JSX.Element {
  useInlineCloudSignIn()
  const [waiting, setWaiting] = useState<'github' | 'google' | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => api.on('ui:authLink', (l) => l.provider === 'cloud' && setUrl(l.url)), [])
  useEffect(
    () =>
      api.on('ui:authDone', (d) => {
        if (d.provider !== 'cloud') return
        setWaiting(null)
        // A cancel the person asked for is not a failure worth showing.
        if (d.error && !/cancelled/i.test(d.error)) setFailure(d.error)
      }),
    []
  )
  const start = async (provider: 'github' | 'google'): Promise<void> => {
    setFailure(null)
    setUrl(null)
    setWaiting(provider)
    try {
      await api.invoke('cloud:signIn', provider)
    } catch (err) {
      setWaiting(null)
      setFailure(friendlyError(err, 'Sinfonie could not reach the internet. Check your connection and try again.'))
    }
  }
  const cancel = (): void => {
    setWaiting(null)
    void api.invoke('auth:cancel', 'cloud', '').catch(() => undefined)
  }
  const copy = async (): Promise<void> => {
    if (!url) return
    await navigator.clipboard.writeText(url).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div>
      <p className="text-[13px] text-muted">Sign in with the Google or GitHub account your team uses. Your team's apps are set up for you once you are in.</p>
      <div className="mt-3 rounded-xl border border-border bg-panel/40 px-4 py-3">
        <div className="text-[13px] font-semibold">Sign in to Sinfonie</div>
        {waiting ? (
          <div className="mt-2">
            <div role="status" className="flex items-center gap-2 text-[13px]">
              <Loader2 size={13} className="animate-spin text-accent" aria-hidden /> Waiting for you in the browser…
            </div>
            <p className="mt-1 text-[12px] text-muted">Approve the sign-in with {waiting === 'google' ? 'Google' : 'GitHub'} in the browser window that opened, then come back here.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {url && (
                <>
                  <Button size="sm" onClick={() => void api.invoke('shell:openExternal', url)}>
                    Open it again
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void copy()} title="Paste it into the browser where you use your work email">
                    <Copy size={12} /> {copied ? 'Copied' : 'Didn’t open? Copy link'}
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" className="ml-auto" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-1 text-[11px] text-muted">Use the Google or GitHub account your team uses. A browser window opens and comes back here.</div>
            <label className="mt-3 block text-[12px] font-medium" htmlFor="join-invite-link">
              I have an invite link
            </label>
            <input
              id="join-invite-link"
              className={`${inputCls} mt-1`}
              placeholder="Paste the link your team sent you"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
            />
            {/* The link doesn't say which account the team uses, so the person picks the sign-in; it joins by itself after. */}
            {invite.trim() && <div className="mt-1 text-[11px] text-muted">Now sign in with the account your team uses; Sinfonie joins with this link right after.</div>}
            {failure && (
              <p role="alert" className="mt-2 text-[12px] text-danger">
                {failure}
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <Button variant="primary" onClick={() => void start('github')}>
                <LogIn size={12} /> {failure ? 'Try again with GitHub' : invite.trim() ? 'Sign in with GitHub and join' : 'Sign in with GitHub'}
              </Button>
              <Button variant="primary" onClick={() => void start('google')}>
                <LogIn size={12} /> {failure ? 'Try again with Google' : invite.trim() ? 'Sign in with Google and join' : 'Sign in with Google'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SignedIn({ onSpace, initialInvite, onInviteUsed }: { onSpace: (id: string) => void; initialInvite: string; onInviteUsed: () => void }): React.JSX.Element {
  const account = useApp((s) => s.settings.cloud?.account)
  const spaces = useApp((s) => s.spaces)
  const [busy, setBusy] = useState<string | null>(null)
  const [discovered, setDiscovered] = useState<DiscoveredOrg[] | null>(null)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [asked, setAsked] = useState<Set<string>>(new Set())
  const [shared, setShared] = useState<Record<string, number>>({})
  const [invite, setInvite] = useState(initialInvite)
  const orgs = useMemo(() => account?.orgs ?? [], [account])
  const teamSpaces = useMemo(() => spaces.filter((sp) => sp.orgId && orgs.some((o) => o.id === sp.orgId)), [spaces, orgs])

  const load = useCallback(async (): Promise<void> => {
    setDiscoverError(null)
    try {
      setDiscovered(await api.invoke('cloud:discover'))
    } catch (err) {
      // Not "no teams": say that the question itself failed, with Try again.
      setDiscoverError(friendlyError(err, 'Sinfonie could not look up your team. Check your connection and try again.'))
    }
    api
      .invoke('cloud:orgs')
      .then((list) => setShared(Object.fromEntries(list.map((o) => [o.id, o.sharedSpaces]))))
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    void load()
  }, [load, orgs.length])
  useEffect(() => {
    if (teamSpaces[0]) onSpace(teamSpaces[0].id)
  }, [teamSpaces, onSpace])

  const pending = (discovered ?? []).filter((d) => !orgs.some((o) => o.id === d.id) && (d.requested || asked.has(d.id)))
  // While an admin has not answered, look again every minute (main also watches; this refreshes the screen).
  useEffect(() => {
    if (!pending.length) return
    const t = setInterval(() => {
      void api
        .invoke('cloud:refresh')
        .catch(() => undefined)
        .then(load)
    }, 60_000)
    return () => clearInterval(t)
  }, [pending.length, load])

  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setActionError(null)
    try {
      await fn()
    } catch (err) {
      setActionError(friendlyError(err))
    } finally {
      setBusy(null)
    }
  }
  const checkAgain = (): Promise<void> =>
    run('check', async () => {
      await api.invoke('orgSpaces:retryMissing')
      await load()
    })
  const join = (d: DiscoveredOrg): Promise<void> =>
    run(`join:${d.id}`, async () => {
      const r = await api.invoke('cloud:joinOrg', d.id)
      if (r.requested && !r.joined) setAsked((s) => new Set(s).add(d.id))
      await load()
    })
  const acceptInvite = (link = invite): Promise<void> =>
    run('invite', async () => {
      await api.invoke('cloud:acceptInvite', link.trim())
      setInvite('')
      await load()
    })
  // A link pasted before signing in: join with it once, right away (the ref keeps StrictMode from joining twice).
  const usedInvite = useRef(false)
  useEffect(() => {
    if (usedInvite.current || !initialInvite.trim()) return
    usedInvite.current = true
    onInviteUsed()
    void acceptInvite(initialInvite)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const countOf = (orgId: string): number => teamSpaces.filter((sp) => sp.orgId === orgId).length
  const errorsOf = (orgId: string): RepoCloneError[] => teamSpaces.filter((sp) => sp.orgId === orgId).flatMap((sp) => sp.cloneErrors ?? [])

  return (
    <div>
      <p className="text-[13px] text-muted">Your team's apps are set up for you once you are in the team.</p>
      <div className="mt-3 flex flex-col gap-2">
        <div className="rounded-xl border border-ok/40 bg-ok/5 px-4 py-3 text-[13px]">
          <CheckCircle2 size={14} className="mr-1 inline text-ok" /> Signed in as {account?.user.name || account?.user.login}
          {account?.emails?.length ? <span className="text-muted"> · {account.emails.map((e) => e.email).join(', ')}</span> : null}
        </div>
        {orgs.map((o) => {
          const errs = errorsOf(o.id)
          const needsGitHub = errs.some((e) => e.kind === 'needs-github')
          return (
            <div key={o.id} className="rounded-xl border border-ok/40 bg-ok/5 px-4 py-3">
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <Users size={14} className="text-ok" /> {o.name}
                <Badge tone="ok">joined</Badge>
                <Button size="sm" variant="ghost" className="ml-auto" disabled={busy !== null} onClick={() => void checkAgain()}>
                  <RefreshCw size={12} className={busy === 'check' ? 'animate-spin' : ''} /> Check again
                </Button>
              </div>
              <div className="mt-1 text-[11px] text-muted">
                {countOf(o.id)
                  ? `${countOf(o.id)} team${countOf(o.id) === 1 ? '' : 's'} ready: ${teamSpaces
                      .filter((sp) => sp.orgId === o.id)
                      .map((sp) => sp.name)
                      .join(', ')}`
                  : shared[o.id] === 0
                    ? 'This team has not shared its apps yet. Ask whoever set up Sinfonie for your team to share them with you, then check again.'
                    : 'Setting up the team’s apps… this can take a minute the first time.'}
              </div>
              {errs.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {errs.map((e) => (
                    <li key={e.remote} className="flex items-start gap-2 text-[12px]">
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{e.name}</span> <span className="text-muted">could not be downloaded. {e.message}</span>
                      </span>
                      {e.kind === 'no-access' || e.kind === 'not-found' ? (
                        <span className="shrink-0 text-muted">Ask your admin for access, then check again.</span>
                      ) : e.kind !== 'needs-github' ? (
                        <Button size="sm" disabled={busy !== null} onClick={() => void checkAgain()}>
                          Try again
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {needsGitHub && <ConnectGitHubCard className="mt-2" reason="Some of your team’s apps are private. Connect your GitHub account so Sinfonie can download them." onConnected={() => void checkAgain()} />}
            </div>
          )
        })}
        {(discovered ?? [])
          .filter((d) => !orgs.some((o) => o.id === d.id))
          .map((d) => {
            const waiting = d.requested || asked.has(d.id)
            return (
              <div key={d.id} className="flex items-center gap-3 rounded-xl border border-border bg-panel/40 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold">{d.name}</div>
                  <div className="text-[11px] text-muted">
                    {d.denied ? 'An admin did not approve your request. Ask them for an invite link.' : waiting ? 'Asked. An admin of this team needs to approve you; Sinfonie checks every minute.' : `Your ${d.domain} email matches this team.`}
                  </div>
                </div>
                {waiting && !d.denied ? (
                  <>
                    <Badge tone="warn">waiting for an admin</Badge>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void checkAgain()}>
                      <RefreshCw size={12} className={busy === 'check' ? 'animate-spin' : ''} /> Check again
                    </Button>
                  </>
                ) : d.domainJoin === 'off' || d.denied ? (
                  <span className="text-[11px] text-muted">Ask an admin for an invite link</span>
                ) : (
                  <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void join(d)}>
                    {busy === `join:${d.id}` ? <Loader2 size={12} className="animate-spin" /> : null} {d.domainJoin === 'open' ? 'Join' : 'Ask to join'}
                  </Button>
                )}
              </div>
            )
          })}
        {discoverError && (
          <div role="alert" className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-[12px]">
            <span className="min-w-0 flex-1 text-danger">{discoverError}</span>
            <Button size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}
        {!discoverError && discovered && discovered.length === 0 && orgs.length === 0 && <p className="text-[12px] text-muted">No team has claimed your email's domain yet. Ask whoever set up Sinfonie for your team for an invite link and paste it below.</p>}
        {actionError && (
          <p role="alert" className="text-[12px] text-danger">
            {actionError}
          </p>
        )}
        <form
          className="mt-1 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (invite.trim()) void acceptInvite()
          }}
        >
          <input className={inputCls} aria-label="Invite link" placeholder="Have an invite link? Paste it here" value={invite} onChange={(e) => setInvite(e.target.value)} />
          <Button type="submit" variant={orgs.length ? 'subtle' : 'primary'} disabled={busy !== null || !invite.trim()}>
            {busy === 'invite' ? <Loader2 size={12} className="animate-spin" /> : null} Join with this link
          </Button>
        </form>
      </div>
    </div>
  )
}
