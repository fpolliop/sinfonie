/**
 * Begins the GitHub sign-in the desktop app asked for. The app's `state` travels through GitHub and
 * back to /oauth/github/callback, which parks the resulting session under it for the app to poll.
 */
import { error } from '../../_session.js'

export async function onRequestGet({ request, env }) {
  const state = new URL(request.url).searchParams.get('state') || ''
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(state)) return error('bad_state', 'Start the sign-in from Sinfonie.')
  if (!env.GITHUB_CLIENT_ID) return error('not_configured', 'Sinfonie has no GitHub sign-in configured on the server yet.', 503)
  const u = new URL('https://github.com/login/oauth/authorize')
  u.searchParams.set('client_id', env.GITHUB_CLIENT_ID)
  u.searchParams.set('redirect_uri', 'https://sinfonie.dev/oauth/github/callback')
  u.searchParams.set('scope', 'read:user user:email')
  u.searchParams.set('state', state)
  return Response.redirect(u.toString(), 302)
}
