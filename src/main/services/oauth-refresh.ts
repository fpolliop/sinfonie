/**
 * Access tokens for the OAuth-protected MCP servers Sinfonie signs in to (Atlassian, Linear).
 *
 * The MCP SDK's own refresh is not safe for us: two refreshes at once spend a rotating refresh
 * token twice and the loser wipes the stored tokens, and a network error mid-refresh falls through
 * to "sign in again". Here there is one refresh in flight per connection, the stored refresh token
 * is kept when the server does not send a new one, and only an answer that says the login is dead
 * (invalid_grant, invalid_client) counts as signed out. Everything else is a retryable error.
 */
import { discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata, refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { InvalidClientError, InvalidGrantError, UnauthorizedClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

export interface TokenStore {
  tokens(): OAuthTokens | undefined
  saveTokens(tokens: OAuthTokens): void
  tokensObtainedAt(): number | undefined
  clientInformation(): OAuthClientInformationMixed | undefined
}

/** The login is gone (revoked, or the refresh token was refused): only signing in again helps. */
export class LoginRevoked extends Error {}

/** Refresh this long before the access token expires, so a call never starts with one about to lapse. */
const EARLY_MS = 2 * 60_000

/** When the stored access token expires (ms epoch); 0 when the server did not say. */
export function expiresAt(store: TokenStore): number {
  const at = store.tokensObtainedAt()
  const tok = store.tokens()
  if (!at || !tok || typeof tok.expires_in !== 'number' || tok.expires_in <= 0) return 0
  return at + tok.expires_in * 1000
}

const inflight = new Map<string, Promise<string>>()
const discovery = new Map<string, { asUrl: URL; metadata?: AuthorizationServerMetadata; resource?: URL }>()

async function discover(serverUrl: string): Promise<{ asUrl: URL; metadata?: AuthorizationServerMetadata; resource?: URL }> {
  const hit = discovery.get(serverUrl)
  if (hit) return hit
  const prm = await discoverOAuthProtectedResourceMetadata(serverUrl).catch(() => undefined)
  const asUrl = new URL(prm?.authorization_servers?.[0] ?? new URL('/', serverUrl).toString())
  const metadata = await discoverAuthorizationServerMetadata(asUrl)
  const found = { asUrl, metadata, resource: prm?.resource ? new URL(prm.resource) : undefined }
  discovery.set(serverUrl, found)
  return found
}

async function refresh(serverUrl: string, store: TokenStore): Promise<string> {
  const t = store.tokens()
  if (!t) throw new LoginRevoked('No stored login')
  const client = store.clientInformation()
  if (!t.refresh_token || !client) {
    const exp = expiresAt(store)
    if (!exp || exp > Date.now()) return t.access_token
    throw new LoginRevoked('The login expired and cannot be refreshed')
  }
  const { asUrl, metadata, resource } = await discover(serverUrl)
  try {
    const next = await refreshAuthorization(asUrl, { metadata, clientInformation: client, refreshToken: t.refresh_token, resource })
    store.saveTokens({ ...next, refresh_token: next.refresh_token ?? t.refresh_token })
    return next.access_token
  } catch (err) {
    if (err instanceof InvalidGrantError || err instanceof InvalidClientError || err instanceof UnauthorizedClientError) throw new LoginRevoked(err.message)
    throw err
  }
}

/**
 * A usable access token. The stored one while it has time left; otherwise one refresh, shared by every
 * caller asking at the same moment. force: the server just refused `stale`, so refresh unless someone
 * already replaced it.
 */
export async function bearer(key: string, serverUrl: string, store: TokenStore, opts: { force?: boolean; stale?: string } = {}): Promise<string> {
  const t = store.tokens()
  if (!t) throw new LoginRevoked('No stored login')
  if (opts.force && opts.stale && t.access_token !== opts.stale) return t.access_token
  const exp = expiresAt(store)
  if (!opts.force && (!exp || exp - Date.now() > EARLY_MS)) return t.access_token
  let p = inflight.get(key)
  if (!p) {
    p = refresh(serverUrl, store).finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  return p
}

/** fetch for an MCP client transport: adds the bearer, and on a 401 refreshes once and retries. */
export function authedFetch(token: (force: boolean, stale?: string) => Promise<string>): FetchLike {
  const withAuth = (init: RequestInit | undefined, tok: string): RequestInit => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${tok}`)
    return { ...init, headers }
  }
  return async (url, init) => {
    const tok = await token(false)
    const res = await fetch(url, withAuth(init, tok))
    if (res.status !== 401) return res
    const fresh = await token(true, tok)
    return fetch(url, withAuth(init, fresh))
  }
}
