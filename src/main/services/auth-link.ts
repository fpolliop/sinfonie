/**
 * Sign-in links are handed to the renderer instead of thrown at the default browser, so the user
 * can open them where they are actually logged in, or copy them. The renderer shows a dialog and
 * closes it when the matching sign-in completes, or shows the failure (with Start again) when it did not.
 */
import type { AuthLink } from '@shared/types'

let emitLink: ((l: AuthLink) => void) | null = null
let emitDone: ((l: Pick<AuthLink, 'provider' | 'connId'> & { error?: string }) => void) | null = null
/** How to stop each provider's pending sign-in (Jira and Linear close their callback server; cloud stops polling). */
const cancellers = new Map<AuthLink['provider'], (connId: string) => void>()

export function setAuthLinkEmitters(onLink: (l: AuthLink) => void, onDone: (l: Pick<AuthLink, 'provider' | 'connId'> & { error?: string }) => void): void {
  emitLink = onLink
  emitDone = onDone
}
/** `opened`: the caller already opened `url` in the default browser, so the dialog only offers it again or to copy it. */
export function presentAuthLink(provider: AuthLink['provider'], connId: string, url: string, label?: string, addEmail?: boolean, opened?: boolean): void {
  emitLink?.({ provider, connId, url, ...(label ? { label } : {}), ...(addEmail ? { addEmail } : {}), ...(opened ? { opened } : {}) })
}
/** The sign-in finished. Pass `error` (plain words for a person) when it failed, so the dialog says so instead of waiting forever. */
export function authDone(provider: AuthLink['provider'], connId: string, error?: string): void {
  emitDone?.({ provider, connId, ...(error ? { error } : {}) })
}
export function onAuthCancel(provider: AuthLink['provider'], fn: (connId: string) => void): void {
  cancellers.set(provider, fn)
}
export function cancelAuth(provider: AuthLink['provider'], connId: string): void {
  cancellers.get(provider)?.(connId)
}

/** The message a cancelled sign-in rejects with, so callers can tell it from a real failure. */
export const AUTH_CANCELLED = 'Sign-in cancelled.'

/** A failure in words for the sign-in dialog: timeouts and closed ports are said plainly, the rest keeps its message. */
export function authFailureText(name: string, err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/^\[plain\]\s*/, '')
  if (msg === AUTH_CANCELLED) return AUTH_CANCELLED
  if (/timed out/i.test(msg)) return `${name} did not hear back from the browser in time. Start again, and approve access within five minutes.`
  if (/Could not listen on port/i.test(msg)) return `Another ${name} sign-in is still open, or another app is using the sign-in port. Close it and start again.`
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)) return `Sinfonie could not reach ${name}. Check your connection and start again.`
  if (/access_denied|denied/i.test(msg)) return `Access was not approved on ${name}. Start again if that was a mistake.`
  return `The ${name} sign-in did not finish: ${msg}`
}
