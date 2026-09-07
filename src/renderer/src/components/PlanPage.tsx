import React, { useState } from 'react'
import clsx from 'clsx'
import { Check, ExternalLink, LogOut, RefreshCw } from 'lucide-react'

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
import { Badge, Button } from './ui'
import { PLAN_LABELS, PLAN_LIMITS, type BillingPeriod, type Plan, type PlanLimits } from '@shared/types'

const PRICES: Record<Exclude<Plan, 'free'>, Record<BillingPeriod, number>> = { pro: { month: 15, year: 120 }, team: { month: 30, year: 300 } }
const PLAN_ROWS: { plan: Plan; blurb: string; points: string[] }[] = [
  { plan: 'free', blurb: 'Parallel agents on your Mac, forever.', points: ['Unlimited single-repo workspaces', 'One space with up to two repositories', 'One account per vendor'] },
  { plan: 'pro', blurb: 'For people who work across several repositories.', points: ['Unlimited spaces and repositories per space', 'Several accounts per vendor, and the crew', 'Review cockpit, Jira, Linear, on-call agent'] },
  { plan: 'team', blurb: 'Per seat. Shared spaces for the whole team.', points: ['Everything in Pro', 'Space definitions shared with your team', 'Admin, invites and central billing'] }
]

function limitText(l: PlanLimits): string {
  const n = (v: number | null): string => (v === null ? 'unlimited' : String(v))
  return `${n(l.spaces)} spaces · ${n(l.reposPerSpace)} repos per space · ${n(l.accountsPerVendor)} accounts per vendor`
}

/** Application → Plan: the Sinfonie account, the current plan, and upgrades. */
export function PlanPage(): React.JSX.Element {
  const cloud = useApp((s) => s.settings.cloud)
  const spaces = useApp((s) => s.spaces)
  const setError = useApp((s) => s.setError)
  const [busy, setBusy] = useState<string | null>(null)
  const [period, setPeriod] = useState<BillingPeriod>('year')
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

  return (
    <div className="max-w-[820px]">
      <section className="mb-5 rounded-lg border border-border p-3">
        {!account ? (
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-[13px] font-medium">Not signed in</div>
              <div className="text-[12px] text-muted">Sign in with GitHub to keep your plan with you across Macs. Sinfonie itself never sees your agent logins; they stay on this machine.</div>
            </div>
            <Button variant="primary" disabled={busy === 'signin'} onClick={() => void run('signin', () => api.invoke('cloud:signIn'))}>
              <GithubMark /> Sign in with GitHub
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
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy === `buy:${p}` || (account ? !account.billing : false)}
                  title={account && !account.billing ? 'Checkout is not open yet' : undefined}
                  onClick={() => void run(`buy:${p}`, () => (account ? api.invoke('cloud:checkout', p, period) : api.invoke('cloud:signIn')))}
                >
                  {account ? (plan === 'free' ? `Upgrade to ${PLAN_LABELS[p]}` : `Switch to ${PLAN_LABELS[p]}`) : 'Sign in to upgrade'}
                </Button>
              )}
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-[11px] text-muted">
        Your plan: {limitText(PLAN_LIMITS[plan])}. You have {spaces.length} space{spaces.length === 1 ? '' : 's'}.
        {account && !account.enforce ? ' Limits are not enforced yet; nothing you have today will be locked.' : ''} Agent subscriptions and API keys are yours and are billed by their vendors, never through Sinfonie.
      </p>
    </div>
  )
}
