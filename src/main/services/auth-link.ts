/**
 * Sign-in links are handed to the renderer instead of thrown at the default browser, so the user
 * can open them where they are actually logged in, or copy them. The renderer shows a dialog and
 * closes it when the matching sign-in completes.
 */
import type { AuthLink } from '@shared/types'

let emitLink: ((l: AuthLink) => void) | null = null
let emitDone: ((l: Pick<AuthLink, 'provider' | 'connId'>) => void) | null = null

export function setAuthLinkEmitters(onLink: (l: AuthLink) => void, onDone: (l: Pick<AuthLink, 'provider' | 'connId'>) => void): void {
  emitLink = onLink
  emitDone = onDone
}
export function presentAuthLink(provider: AuthLink['provider'], connId: string, url: string): void {
  emitLink?.({ provider, connId, url })
}
export function authDone(provider: AuthLink['provider'], connId: string): void {
  emitDone?.({ provider, connId })
}
