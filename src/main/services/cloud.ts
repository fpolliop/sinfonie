/**
 * The Sinfonie account: who the user is on sinfonie.dev and which plan they are on. Sign-in is
 * GitHub OAuth through the site, which parks a session token for the app to poll (the same relay
 * the Slack sign-in uses). The token lives in the encrypted secrets; the plan answer is cached in
 * settings.cloud so the app works offline, with a two-week grace before a stale answer counts as free.
 *
 * Plan limits (`assertWithin`) only bite when the server says `enforce`, so nothing changes for
 * existing users until checkout exists. SINFONIE_PLAN=pro|team overrides everything for development.
 */
import { safeStorage, shell } from 'electron'
import { randomBytes } from 'crypto'
import { getStore } from '../store'
import { presentAuthLink, authDone } from './auth-link'
import { PLAN_LIMITS, PLAN_LABELS, PLAN_FEATURES } from '@shared/types'
import type { BillingPeriod, CloudAccount, CloudOrgDetail, CloudState, Plan, PlanFeature, PlanLimits, Vendor } from '@shared/types'

export const CLOUD_URL = process.env.SINFONIE_CLOUD_URL ?? 'https://sinfonie.dev'
const GRACE_MS = 14 * 24 * 3600_000
const REFRESH_EVERY_MS = 6 * 3600_000
const SECRET_KEY = 'cloud:session'

// ---------- secrets (same scheme as jira.ts / slack.ts) ----------
function encrypt(text: string): string {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64')
  return 'plain:' + Buffer.from(text, 'utf8').toString('base64')
}
function decrypt(stored: string): string {
  if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
  return stored
}
function sessionToken(): string | undefined {
  const raw = getStore().get().secrets?.[SECRET_KEY]
  if (!raw) return undefined
  try {
    return decrypt(raw)
  } catch {
    return undefined
  }
}
function writeSessionToken(token: string | undefined): void {
  getStore().update((d) => {
    d.secrets = d.secrets ?? {}
    if (token === undefined) delete d.secrets[SECRET_KEY]
    else d.secrets[SECRET_KEY] = encrypt(token)
  })
}

export function state(): CloudState {
  return getStore().get().settings.cloud ?? {}
}
function patchState(patch: Partial<CloudState> | null): CloudState {
  getStore().update((d) => {
    if (patch === null) delete d.settings.cloud
    else d.settings.cloud = { ...(d.settings.cloud ?? {}), ...patch }
  })
  return state()
}

// ---------- server ----------
class CloudError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
  }
}
async function call<T>(path: string, init: RequestInit = {}, token = sessionToken()): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...((init.headers as Record<string, string>) ?? {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${CLOUD_URL}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new CloudError(String(body.error_description ?? body.error ?? `sinfonie.dev answered ${res.status}`), res.status)
  return body as T
}

/** Re-asks the server who we are. A network failure keeps the cached answer; a 401 signs out. */
export async function refresh(): Promise<CloudState> {
  if (!sessionToken()) return state()
  try {
    const account = await call<CloudAccount>('/api/me')
    return patchState({ account, checkedAt: new Date().toISOString(), error: undefined })
  } catch (err) {
    if (err instanceof CloudError && err.status === 401) {
      writeSessionToken(undefined)
      return patchState(null)
    }
    return patchState({ error: err instanceof Error ? err.message : String(err) })
  }
}

// ---------- sign-in ----------
let pollTimer: NodeJS.Timeout | null = null
let pendingState: string | null = null
function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  pendingState = null
}
export type SignInProvider = 'github' | 'google'
/** Opens the GitHub or Google sign-in on sinfonie.dev and polls for the session the callback parks under our state. */
export async function signIn(provider: SignInProvider = 'github'): Promise<void> {
  stopPolling()
  const st = randomBytes(24).toString('base64url')
  pendingState = st
  const until = Date.now() + 5 * 60_000
  pollTimer = setInterval(() => {
    if (Date.now() > until || pendingState !== st) return stopPolling()
    void fetch(`${CLOUD_URL}/oauth/poll?state=${encodeURIComponent(st)}`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => r.json() as Promise<{ token?: string; error?: string }>)
      .then(async (j) => {
        if (!j.token || pendingState !== st) return
        stopPolling()
        await finishSignIn(j.token)
      })
      .catch(() => undefined)
  }, 2000)
  presentAuthLink('cloud', '', `${CLOUD_URL}/oauth/${provider}/start?state=${encodeURIComponent(st)}`, provider === 'google' ? 'Google' : 'GitHub')
}
async function finishSignIn(token: string): Promise<void> {
  const account = await call<CloudAccount>('/api/me', {}, token)
  writeSessionToken(token)
  patchState({ account, checkedAt: new Date().toISOString(), error: undefined })
  authDone('cloud', '')
}
export async function signOut(): Promise<CloudState> {
  stopPolling()
  const token = sessionToken()
  if (token) await call('/api/me', { method: 'DELETE' }, token).catch(() => undefined)
  writeSessionToken(undefined)
  return patchState(null)
}

// ---------- billing ----------
/** Opens Paddle checkout for a plan in the browser. The server builds the transaction so the price ids never ship. */
export async function checkout(plan: Exclude<Plan, 'free'>, period: BillingPeriod, seats = 1): Promise<void> {
  if (!sessionToken()) throw new Error('Sign in to Sinfonie first, then choose a plan.')
  const q = new URLSearchParams({ plan, period, seats: String(seats) })
  const { url } = await call<{ url: string }>(`/api/billing/checkout?${q}`, { method: 'POST' })
  await shell.openExternal(url)
}
/** Paddle's customer portal: invoices, payment method, cancel. */
export async function portal(): Promise<void> {
  if (!sessionToken()) throw new Error('Sign in to Sinfonie first.')
  const { url } = await call<{ url: string }>('/api/billing/portal', { method: 'POST' })
  await shell.openExternal(url)
}

// ---------- teams ----------
function needSession(): void {
  if (!sessionToken()) throw new Error('Sign in to Sinfonie first.')
}
export async function orgs(): Promise<CloudOrgDetail[]> {
  needSession()
  return (await call<{ orgs: CloudOrgDetail[] }>('/api/orgs')).orgs
}
const jsonInit = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
export async function createInvite(orgId: string, role: 'admin' | 'member' = 'member', email?: string): Promise<CloudOrgDetail> {
  needSession()
  return call<CloudOrgDetail>(`/api/orgs/${encodeURIComponent(orgId)}/invites`, jsonInit('POST', { role, email }))
}
export async function revokeInvite(orgId: string, token: string): Promise<CloudOrgDetail> {
  needSession()
  return call<CloudOrgDetail>(`/api/orgs/${encodeURIComponent(orgId)}/invites?token=${encodeURIComponent(token)}`, { method: 'DELETE' })
}
export async function setMemberRole(orgId: string, userId: string, role: 'admin' | 'member'): Promise<CloudOrgDetail> {
  needSession()
  return call<CloudOrgDetail>(`/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, jsonInit('PATCH', { role }))
}
export async function removeMember(orgId: string, userId: string): Promise<CloudOrgDetail> {
  needSession()
  return call<CloudOrgDetail>(`/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })
}
export async function renameOrg(orgId: string, name: string): Promise<CloudOrgDetail> {
  needSession()
  return call<CloudOrgDetail>(`/api/orgs/${encodeURIComponent(orgId)}`, jsonInit('PATCH', { name }))
}
export async function leaveOrg(orgId: string): Promise<void> {
  needSession()
  await call(`/api/orgs/${encodeURIComponent(orgId)}`, { method: 'DELETE' })
  await refresh()
}
/** Accepts an invite given as the token, the join link, or the sinfonie://join deep link. */
export async function acceptInvite(codeOrUrl: string): Promise<CloudOrgDetail> {
  needSession()
  let token = codeOrUrl.trim()
  try {
    const u = new URL(token)
    token = u.searchParams.get('token') || u.pathname.split('/').filter(Boolean).pop() || token
  } catch {
    // a bare token
  }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new Error('That does not look like an invite code.')
  const org = await call<CloudOrgDetail>(`/api/invites/${encodeURIComponent(token)}`, { method: 'POST' })
  await refresh()
  return org
}

// ---------- entitlements ----------
const DEV_PLAN = (['free', 'pro', 'team'] as const).find((p) => p === process.env.SINFONIE_PLAN)

/** The plan the app should behave as. Stale answers (no refresh for two weeks) fall back to free. */
export function plan(): Plan {
  if (DEV_PLAN) return DEV_PLAN
  const s = state()
  if (!s.account) return 'free'
  if (s.checkedAt && Date.now() - Date.parse(s.checkedAt) > GRACE_MS) return 'free'
  return s.account.plan
}
function enforced(): boolean {
  if (DEV_PLAN) return true
  return Boolean(state().account?.enforce)
}
export function limits(): PlanLimits {
  return PLAN_LIMITS[plan()]
}
/** Throws a plan-limit message when adding one more of `what` would exceed the current plan. */
export function assertWithin(what: keyof PlanLimits, current: number, vendor?: Vendor): void {
  if (!enforced()) return
  const max = limits()[what]
  if (max === null || current < max) return
  const p = PLAN_LABELS[plan()]
  const noun = what === 'spaces' ? `${max} space${max === 1 ? '' : 's'}` : what === 'reposPerSpace' ? `${max} repositories per space` : `${max} ${vendor ?? ''} account${max === 1 ? '' : 's'} per vendor`.replace('  ', ' ')
  throw new Error(`Plan limit: the ${p} plan allows ${noun}. Upgrade under Settings → Plan to add more.`)
}

/** Throws when the current plan lacks a feature; a no-op until limits are enforced. */
export function assertFeature(feature: PlanFeature): void {
  if (!enforced()) return
  if (PLAN_FEATURES[plan()].includes(feature)) return
  const need = feature === 'sharedSpaces' ? 'Team' : 'Pro'
  const what = feature === 'sharedSpaces' ? 'Shared spaces' : feature === 'reviewCockpit' ? 'The review cockpit' : feature === 'oncall' ? 'The on-call agent' : feature === 'crew' ? 'The crew' : `${feature[0].toUpperCase()}${feature.slice(1)}`
  throw new Error(`Plan limit: ${what} needs the ${need} plan. Upgrade under Settings → Plan.`)
}

let refreshTimer: NodeJS.Timeout | null = null
/** Refresh at startup (a few seconds in, off the launch path) and every six hours. */
export function start(): void {
  if (refreshTimer) return
  setTimeout(() => void refresh(), 5_000)
  refreshTimer = setInterval(() => void refresh(), REFRESH_EVERY_MS)
}
