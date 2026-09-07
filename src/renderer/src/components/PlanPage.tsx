import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Check, ExternalLink, LogOut, RefreshCw } from 'lucide-react'

/** Google's "G"; lucide dropped brand icons. */
function GoogleMark({ size = 13 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.7-2.4 3.6v3h3.8c2.3-2.1 3.6-5.2 3.6-8.8z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.8-3c-1.1.7-2.5 1.2-4.2 1.2-3.2 0-5.9-2.2-6.9-5.1H1.1v3.1C3.1 21.3 7.2 24 12 24z" />
      <path fill="#FBBC05" d="M5.1 14.2c-.5-1.5-.5-3 0-4.5V6.6H1.1c-1.5 3-1.5 6.7 0 9.7l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0 7.2 0 3.1 2.7 1.1 6.6l4 3.1c1-2.9 3.7-4.9 6.9-4.9z" />
    </svg>
  )
}
/** GitHub's mark; lucide dropped brand icons. */
function GithubMark({ size = 13 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, inputCls } from './ui'
import { TeamSection } from './TeamSection'
import { PLAN_LABELS, PLAN_LIMITS, type BillingPeriod, type Plan, type PlanLimits } from '@shared/types'

const PRICES: Record<Exclude<Plan, 'free'>, Record<BillingPeriod, number>> = { pro: { month: 15, year: 120 }, team: { month: 30, year: 300 } }
const PLAN_ROWS: { plan: Plan; blurb: string; points: string[] }[] = [
  { plan: 'free', blurb: 'Parallel agents on your Mac, forever.', points: ['Unlimited single-repo workspaces', 'One space with up to two repositories', 'One account per vendor'] },
  { plan: 'pro', blurb: 'For people who work across several repositories.', points: ['Unlimited spaces and repositories per space', 'Several accounts per vendor, and the crew', 'Review cockpit, Jira, Linear, on-call agent'] },
  { plan: 'team', blurb: 'Per seat. Shared spaces for the whole team.', points: ['Everything in Pro', 'Space definitions shared with your team', 'Admin, invites and central billing'] }
]

function limitText(l: PlanLimits): string {
  const n = (v: number | null, one: string, many: string): string => (v === null ? `unlimited ${many}` : `${v} ${v === 1 ? one : many}`)
  return `${n(l.spaces, 'space', 'spaces')} · ${n(l.reposPerSpace, 'repo', 'repos')} per space · ${n(l.accountsPerVendor, 'account', 'accounts')} per vendor`
}

/** "Have a code?": redeems a coupon, including one that arrived through a sinfonie://redeem link. */
function CouponBox({ signedIn }: { signedIn: boolean }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const pendingInvite = useApp((s) => s.pendingInvite)
  const setPendingInvite = useApp((s) => s.setPendingInvite)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const redeem = async (c: string): Promise<void> => {
    if (!c.trim()) return
    setBusy(true)
    try {
      const st = await api.invoke('cloud:redeem', c)
      setCode('')
      setDone(st.account?.grant ? `You are on ${PLAN_LABELS[st.account.plan]}${st.account.grant.until ? ` until ${new Date(st.account.grant.until).toLocaleDateString()}` : ''}. Enjoy.` : 'Code accepted.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (!pendingInvite || pendingInvite.kind !== 'redeem') return
    if (!signedIn) {
      setCode(pendingInvite.token)
      return
    }
    const token = pendingInvite.token
    setPendingInvite(null)
    void redeem(token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInvite, signedIn])
  return (
    <div className="mt-3 flex items-center gap-2">
      <span className="shrink-0 text-[12px] text-muted">Have a code?</span>
      <input className={clsx(inputCls, 'max-w-[280px] font-mono uppercase')} placeholder="BETA-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void redeem(code)} disabled={!signedIn} title={signedIn ? undefined : 'Sign in first'} />
      <Button size="sm" disabled={!signedIn || !code.trim() || busy} onClick={() => void redeem(code)}>
        Redeem
      </Button>
      {done && <span className="text-[12px] text-ok">{done}</span>}
      {!signedIn && pendingInvite?.kind === 'redeem' && <span className="text-[12px] text-muted">Sign in and the code is applied.</span>}
    </div>
  )
}

/** Application → Plan: the Sinfonie account, the current plan, and upgrades. */
export function PlanPage(): React.JSX.Element {
  const cloud = useApp((s) => s.settings.cloud)
  const spaces = useApp((s) => s.spaces)
  const setError = useApp((s) => s.setError)
  const [busy, setBusy] = useState<string | null>(null)
  const [period, setPeriod] = useState<BillingPeriod>('year')
  const [seats, setSeats] = useState(3)
  const account = cloud?.account
  const plan: Plan = account?.plan ?? 'free'
  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  const stale = cloud?.checkedAt ? Date.now() - Date.parse(cloud.checkedAt) > 14 * 24 * 3600_000 : false
  // Opening the page re-asks the server, so a plan bought a minute ago (or billing just switched on) shows up.
  useEffect(() => {
    if (account) void api.invoke('cloud:refresh').catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="max-w-[820px]">
      <section className="mb-5 rounded-lg border border-border p-3">
        {!account ? (
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-[13px] font-medium">Not signed in</div>
              <div className="text-[12px] text-muted">Sign in to keep your plan with you across Macs. Sinfonie itself never sees your agent logins; they stay on this machine.</div>
            </div>
            <Button variant="primary" disabled={busy !== null} onClick={() => void run('signin', () => api.invoke('cloud:signIn', 'github'))}>
              <GithubMark /> GitHub
            </Button>
            <Button variant="primary" disabled={busy !== null} onClick={() => void run('signin', () => api.invoke('cloud:signIn', 'google'))}>
              <GoogleMark /> Google
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            {account.user.avatarUrl ? <img src={account.user.avatarUrl} alt="" className="h-8 w-8 rounded-full" /> : <div className="h-8 w-8 rounded-full bg-panel-2" />}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                {account.user.name || account.user.login}
                <Badge tone={plan === 'free' ? 'muted' : 'accent'}>{PLAN_LABELS[plan]}</Badge>
                {account.subscription?.status && account.subscription.status !== 'active' && <Badge tone="warn">{account.subscription.status.replace('_', ' ')}</Badge>}
                {account.grant && account.grant.plan === plan && <Badge tone="ok">{account.grant.until ? `free until ${new Date(account.grant.until).toLocaleDateString()}` : 'free, on us'}</Badge>}
              </div>
              <div className="truncate text-[12px] text-muted">
                @{account.user.login}
                {account.user.email ? ` · ${account.user.email}` : ''}
                {account.subscription?.endsAt ? ` · ends ${new Date(account.subscription.endsAt).toLocaleDateString()}` : account.subscription?.renewsAt ? ` · renews ${new Date(account.subscription.renewsAt).toLocaleDateString()}` : ''}
              </div>
              {account.orgs.length > 0 && <div className="text-[12px] text-muted">Teams: {account.orgs.map((o) => `${o.name} (${o.role}, ${o.seats} seats)`).join(', ')}</div>}
              {stale && <div className="text-[12px] text-warn">Plan not confirmed for two weeks; the app behaves as Free until it can reach sinfonie.dev.</div>}
              {cloud?.error && <div className="text-[12px] text-warn">Last check failed: {cloud.error}</div>}
            </div>
            <Button size="sm" disabled={busy === 'refresh'} onClick={() => void run('refresh', () => api.invoke('cloud:refresh'))} title="Ask sinfonie.dev again">
              <RefreshCw size={12} className={clsx(busy === 'refresh' && 'animate-spin')} />
            </Button>
            {account.subscription && (
              <Button size="sm" disabled={busy === 'portal'} onClick={() => void run('portal', () => api.invoke('cloud:portal'))}>
                <ExternalLink size={12} /> Manage billing
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy === 'signout'} onClick={() => void run('signout', () => api.invoke('cloud:signOut'))}>
              <LogOut size={12} /> Sign out
            </Button>
          </div>
        )}
      </section>

      <div className="mb-2 flex items-center gap-3">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">Plans</div>
        <div className="ml-auto flex rounded-md border border-border p-0.5 text-[12px]">
          {(['month', 'year'] as BillingPeriod[]).map((p) => (
            <button key={p} className={clsx('rounded px-2 py-0.5', period === p ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')} onClick={() => setPeriod(p)}>
              {p === 'month' ? 'Monthly' : 'Yearly'}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {PLAN_ROWS.map(({ plan: p, blurb, points }) => {
          const current = p === plan
          const price = p === 'free' ? null : PRICES[p][period]
          return (
            <div key={p} className={clsx('flex flex-col rounded-lg border p-3', current ? 'border-accent' : 'border-border')}>
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                {PLAN_LABELS[p]}
                {current && <Badge tone="accent">Current</Badge>}
              </div>
              <div className="mt-1 text-[18px] font-semibold">
                {price === null ? '$0' : `$${price}`}
                <span className="text-[11px] font-normal text-muted">{price === null ? '' : period === 'month' ? ' / month' : ' / year'}{p === 'team' ? ' per seat' : ''}</span>
              </div>
              <div className="mb-2 text-[12px] text-muted">{blurb}</div>
              <ul className="mb-3 flex-1 space-y-1 text-[12px]">
                {points.map((pt) => (
                  <li key={pt} className="flex items-start gap-1.5">
                    <Check size={12} className="mt-0.5 shrink-0 text-ok" /> {pt}
                  </li>
                ))}
              </ul>
              {p !== 'free' && !current && (
                <div className="flex items-center gap-2">
                  {p === 'team' && account && (
                    <input type="number" min={1} max={500} value={seats} onChange={(e) => setSeats(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} className="w-16 rounded-md border border-border bg-bg px-2 py-1 text-[12px] outline-none focus:border-accent" title="Seats" />
                  )}
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy === `buy:${p}` || (account ? !account.billing : false)}
                    title={account && !account.billing ? 'Checkout is not open yet' : undefined}
                    onClick={() => void run(`buy:${p}`, () => (account ? api.invoke('cloud:checkout', p, period, p === 'team' ? seats : 1) : api.invoke('cloud:signIn', 'github')))}
                  >
                    {account ? (plan === 'free' ? `Upgrade to ${PLAN_LABELS[p]}` : `Switch to ${PLAN_LABELS[p]}`) : 'Sign in to upgrade'}
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <CouponBox signedIn={Boolean(account)} />
      <p className="mt-3 text-[11px] text-muted">
        Your plan: {limitText(PLAN_LIMITS[plan])}. You have {spaces.length} space{spaces.length === 1 ? '' : 's'}.
        {account && !account.enforce ? ' Limits are not enforced yet; nothing you have today will be locked.' : ''} Agent subscriptions and API keys are yours and are billed by their vendors, never through Sinfonie.
      </p>
      <TeamSection signedIn={Boolean(account)} />
    </div>
  )
}
