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
import { presentAuthLink, authDone, onAuthCancel } from './auth-link'
import { PLAN_LIMITS, PLAN_LABELS, PLAN_FEATURES, PLAIN_ERROR_MARK } from '@shared/types'
import type { AppMode, BillingPeriod, CloudAccount, CloudOrgDetail, CloudState, DiscoveredOrg, Plan, PlanFeature, PlanLimits, Vendor } from '@shared/types'

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
    public status: number,
    /** The server's error code (`not_found`, `used`, `no_seats`, …), when it sent one. */
    public code?: string
  ) {
    super(message)
  }
}
async function call<T>(path: string, init: RequestInit = {}, token = sessionToken()): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...((init.headers as Record<string, string>) ?? {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${CLOUD_URL}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new CloudError(String(body.error_description ?? body.error ?? `sinfonie.dev answered ${res.status}`), res.status, typeof body.error === 'string' ? body.error : undefined)
  return body as T
}

/** Something to run after every successful refresh (the organisation-space sync registers here). */
let afterRefresh: (() => void) | null = null
export function onRefreshed(fn: () => void): void {
  afterRefresh = fn
}

/**
 * A person who never chose a mode takes the default of an organisation they belong to. Their own choice, once
 * made (onboarding or Settings), is never overridden.
 */
function applyOrgDefaultMode(account: CloudAccount): void {
  if (getStore().get().settings.mode) return
  if (!account.orgs.some((o) => o.defaultMode === 'guided')) return
  getStore().update((d) => {
    d.settings.mode = 'guided'
  })
}

/** Re-asks the server who we are. A network failure keeps the cached answer; a 401 signs out. */
export async function refresh(): Promise<CloudState> {
  if (!sessionToken()) return state()
  try {
    const account = await call<CloudAccount>('/api/me')
    const out = patchState({ account, checkedAt: new Date().toISOString(), error: undefined })
    applyOrgDefaultMode(account)
    afterRefresh?.()
    return out
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
onAuthCancel('cloud', () => stopPolling())

/**
 * Polls for the session the sign-in callback parks under `st`. Every way it ends reaches the dialog through
 * authDone: success, the five-minute timeout, the server saying no, repeated network failures, or a failed
 * finish. Closing the dialog calls auth:cancel, which stops the polling.
 */
function pollForSession(st: string, label: string): void {
  const until = Date.now() + 5 * 60_000
  let misses = 0
  let inFlight = false
  const fail = (text: string): void => {
    if (pendingState !== st) return
    stopPolling()
    authDone('cloud', '', text)
  }
  pollTimer = setInterval(() => {
    if (pendingState !== st) return stopPolling()
    if (Date.now() > until) return fail(`The ${label} sign-in was not finished within five minutes. Start again when you are ready.`)
    if (inFlight) return
    inFlight = true
    void fetch(`${CLOUD_URL}/oauth/poll?state=${encodeURIComponent(st)}`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => r.json() as Promise<{ token?: string; error?: string; error_description?: string }>)
      .then(async (j) => {
        misses = 0
        if (pendingState !== st) return
        // Waiting answers vary; only a clear refusal ends the wait early.
        if (j.error && /denied|expired|invalid/i.test(j.error)) return fail(`The ${label} sign-in did not go through (${j.error_description ?? j.error}). Start again.`)
        if (!j.token) return
        stopPolling()
        try {
          await finishSignIn(j.token)
        } catch (err) {
          authDone('cloud', '', `You approved access, but Sinfonie could not finish signing in (${err instanceof Error ? err.message : String(err)}). Start again.`)
        }
      })
      .catch(() => {
        // One slow answer is fine; half a minute of them means the connection is down.
        if (++misses >= 15) fail('Sinfonie could not reach sinfonie.dev to finish signing in. Check your connection and start again.')
      })
      .finally(() => (inFlight = false))
  }, 2000)
}

/** Opens the GitHub or Google sign-in on sinfonie.dev and polls for the session the callback parks under our state. */
export async function signIn(provider: SignInProvider = 'github'): Promise<void> {
  stopPolling()
  const st = randomBytes(24).toString('base64url')
  pendingState = st
  const label = provider === 'google' ? 'Google' : 'GitHub'
  pollForSession(st, label)
  // Open the browser right away; the dialog (or the setup wizard's inline wait) is the "didn't open? copy it" fallback.
  const url = `${CLOUD_URL}/oauth/${provider}/start?state=${encodeURIComponent(st)}`
  const opened = await shell.openExternal(url).then(
    () => true,
    () => false
  )
  presentAuthLink('cloud', '', url, label, false, opened)
}
async function finishSignIn(token: string): Promise<void> {
  const account = await call<CloudAccount>('/api/me', {}, token)
  writeSessionToken(token)
  patchState({ account, checkedAt: new Date().toISOString(), error: undefined })
  applyOrgDefaultMode(account)
  authDone('cloud', '')
  // Pull the team's shared apps now, not at the next six-hourly refresh.
  afterRefresh?.()
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
  if (!sessionToken()) throw new Error(`${PLAIN_ERROR_MARK}Sign in to Sinfonie first, then choose a plan.`)
  const q = new URLSearchParams({ plan, period, seats: String(seats) })
  const { url } = await call<{ url: string }>(`/api/billing/checkout?${q}`, { method: 'POST' })
  await shell.openExternal(url)
}
/** Paddle's customer portal: invoices, payment method, cancel. */
export async function portal(): Promise<void> {
  needSession()
  const { url } = await call<{ url: string }>('/api/billing/portal', { method: 'POST' })
  await shell.openExternal(url)
}

// ---------- teams ----------
/** The settings page that holds the Sinfonie account and plan, named as the person's lens shows it. */
function planPageName(): string {
  return getStore().get().settings.mode === 'guided' ? 'Settings → Account & team' : 'Settings → Plan'
}
function needSession(): void {
  if (!sessionToken()) throw new Error(`${PLAIN_ERROR_MARK}Sign in to Sinfonie first, under ${planPageName()}.`)
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
export async function deleteOrg(orgId: string): Promise<void> {
  needSession()
  await call(`/api/orgs/${encodeURIComponent(orgId)}?delete=1`, { method: 'DELETE' })
  await refresh()
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
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new Error(`${PLAIN_ERROR_MARK}That does not look like an invite link. Copy the whole link your admin sent and paste it again.`)
  let org: CloudOrgDetail
  try {
    org = await call<CloudOrgDetail>(`/api/invites/${encodeURIComponent(token)}`, { method: 'POST' })
  } catch (err) {
    // The server answers with a code; say it in words (the invite page on sinfonie.dev uses the same codes).
    const code = err instanceof CloudError ? err.code : undefined
    if (code === 'not_found') throw new Error(`${PLAIN_ERROR_MARK}This invite link no longer works: it was cancelled or mistyped. Ask your admin for a new one.`)
    if (code === 'used' || code === 'expired') throw new Error(`${PLAIN_ERROR_MARK}This invite link was already used or has expired. Ask your admin for a new one.`)
    if (code === 'no_seats') throw new Error(`${PLAIN_ERROR_MARK}Your team has no free seats left. Ask your admin to add a seat, then try the link again.`)
    throw err
  }
  await refresh()
  return org
}

/** Redeems a coupon code (or its sinfonie.dev/redeem link) for a free plan. */
export async function redeem(codeOrUrl: string): Promise<CloudState> {
  needSession()
  let code = codeOrUrl.trim()
  try {
    const u = new URL(code)
    code = u.searchParams.get('code') || u.pathname.split('/').filter(Boolean).pop() || code
  } catch {
    // a bare code
  }
  const account = await call<CloudAccount>('/api/coupons/redeem', jsonInit('POST', { code }))
  return patchState({ account, checkedAt: new Date().toISOString(), error: undefined })
}

// ---------- emails and organisations ----------
/** Adds an email by signing in with another provider; the server attaches that identity to this account. */
export async function addEmail(provider: SignInProvider): Promise<void> {
  needSession()
  stopPolling()
  const st = randomBytes(24).toString('base64url')
  await call('/api/me/link', jsonInit('POST', { state: st }))
  pendingState = st
  const label = provider === 'google' ? 'Google' : 'GitHub'
  // Same account, fresh session once approved: finishSignIn keeps it and refreshes, so the new email shows up.
  pollForSession(st, label)
  presentAuthLink('cloud', '', `${CLOUD_URL}/oauth/${provider}/start?state=${encodeURIComponent(st)}`, label, true)
}
export async function removeEmail(email: string): Promise<CloudState> {
  needSession()
  await call(`/api/me/link?email=${encodeURIComponent(email)}`, { method: 'DELETE' })
  return refresh()
}
export async function createOrg(name: string): Promise<CloudOrgDetail> {
  needSession()
  const org = await call<CloudOrgDetail>('/api/orgs', jsonInit('POST', { name }))
  await refresh()
  return org
}
export async function setDomainJoin(orgId: string, policy: 'open' | 'approval' | 'off'): Promise<CloudOrgDetail> {
  needSession()
  return call<CloudOrgDetail>(`/api/orgs/${encodeURIComponent(orgId)}`, jsonInit('PATCH', { domainJoin: policy }))
}
export async function setOrgDefaultMode(orgId: string, mode: AppMode): Promise<CloudOrgDetail> {
  needSession()
  const org = await call<CloudOrgDetail>(`/api/orgs/${encodeURIComponent(orgId)}`, jsonInit('PATCH', { defaultMode: mode }))
  await refresh()
  return org
}
type DomainResult = { verified: boolean; domain: string; token?: string; record?: string; found?: string[]; org: CloudOrgDetail }
export async function addDomain(orgId: string, domain: string): Promise<DomainResult> {
  needSession()
  return call<DomainResult>(`/api/orgs/${encodeURIComponent(orgId)}/domains`, jsonInit('POST', { domain }))
}
export async function verifyDomain(orgId: string, domain: string): Promise<DomainResult> {
  needSession()
  return call<DomainResult>(`/api/orgs/${encodeURIComponent(orgId)}/domains`, jsonInit('POST', { domain, verify: 1 }))
}
export async function removeDomain(orgId: string, domain: string): Promise<CloudOrgDetail> {
  needSession()
  return call<CloudOrgDetail>(`/api/orgs/${encodeURIComponent(orgId)}/domains?domain=${encodeURIComponent(domain)}`, { method: 'DELETE' })
}
export async function discover(): Promise<DiscoveredOrg[]> {
  needSession()
  const found = (await call<{ orgs: DiscoveredOrg[] }>('/api/orgs/discover')).orgs
  // A request made earlier (another session) keeps being watched until an admin answers.
  for (const d of found) if (d.requested && !d.denied) watchJoinRequest(d.id)
  return found
}
export async function joinOrg(orgId: string): Promise<{ joined: boolean; requested?: boolean }> {
  needSession()
  const out = await call<{ joined: boolean; requested?: boolean }>(`/api/orgs/${encodeURIComponent(orgId)}/join`, { method: 'POST' })
  if (out.joined) await refresh()
  else if (out.requested) watchJoinRequest(orgId)
  return out
}

/**
 * "Ask to join" waits on an admin. Re-ask the server every minute (for up to a day) until the membership shows up,
 * so the team and its apps arrive without the person doing anything; refresh() then syncs the shared apps.
 */
const joinWatch = new Map<string, NodeJS.Timeout>()
export function watchJoinRequest(orgId: string): void {
  if (joinWatch.has(orgId)) return
  const until = Date.now() + 24 * 3600_000
  const t = setInterval(() => {
    if (Date.now() > until || !sessionToken()) {
      clearInterval(t)
      joinWatch.delete(orgId)
      return
    }
    void refresh().then((st) => {
      if (st.account?.orgs.some((o) => o.id === orgId)) {
        clearInterval(t)
        joinWatch.delete(orgId)
      }
    })
  }, 60_000)
  joinWatch.set(orgId, t)
}
export async function decideRequest(orgId: string, userId: string, action: 'approve' | 'deny'): Promise<CloudOrgDetail> {
  needSession()
  return call<CloudOrgDetail>(`/api/orgs/${encodeURIComponent(orgId)}/requests`, jsonInit('POST', { userId, action }))
}
/** Raw access for the organisation-space sync service. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  needSession()
  return call<T>(path, init)
}
export const hasSession = (): boolean => Boolean(sessionToken())
export { jsonInit }

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
  const guided = getStore().get().settings.mode === 'guided'
  const noun = what === 'spaces' ? `${max} ${guided ? 'team' : 'space'}${max === 1 ? '' : 's'}` : what === 'reposPerSpace' ? (guided ? `${max} app${max === 1 ? '' : 's'} per team` : `${max} repositories per space`) : `${max} ${vendor ?? ''} account${max === 1 ? '' : 's'} per vendor`.replace('  ', ' ')
  throw new Error(`${PLAIN_ERROR_MARK}Plan limit: the ${p} plan allows ${noun}. Upgrade under ${planPageName()} to add more.`)
}

/** Throws when the current plan lacks a feature; a no-op until limits are enforced. */
export function assertFeature(feature: PlanFeature): void {
  if (!enforced()) return
  if (PLAN_FEATURES[plan()].includes(feature)) return
  const need = feature === 'sharedSpaces' ? 'Team' : 'Pro'
  const what = feature === 'sharedSpaces' ? 'Shared spaces' : feature === 'reviewCockpit' ? 'The review cockpit' : feature === 'oncall' ? 'The on-call agent' : feature === 'crew' ? 'The crew' : `${feature[0].toUpperCase()}${feature.slice(1)}`
  throw new Error(`${PLAIN_ERROR_MARK}Plan limit: ${what} needs the ${need} plan. Upgrade under ${planPageName()}.`)
}

let refreshTimer: NodeJS.Timeout | null = null
/** Refresh at startup (a few seconds in, off the launch path) and every six hours. */
export function start(): void {
  if (refreshTimer) return
  setTimeout(() => void refresh(), 5_000)
  refreshTimer = setInterval(() => void refresh(), REFRESH_EVERY_MS)
}
