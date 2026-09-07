/**
 * Begins the Google sign-in the desktop app asked for. Configure a Google OAuth client of type
 * "Web application" with redirect https://sinfonie.dev/oauth/google/callback, and set
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the Pages project.
 */
import { error, STATE_RE } from '../../_session.js'

export async function onRequestGet({ request, env }) {
  const state = new URL(request.url).searchParams.get('state') || ''
  if (!STATE_RE.test(state)) return error('bad_state', 'Start the sign-in from Sinfonie.')
  if (!env.GOOGLE_CLIENT_ID) return error('not_configured', 'Sinfonie has no Google sign-in configured on the server yet.', 503)
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
  u.searchParams.set('redirect_uri', 'https://sinfonie.dev/oauth/google/callback')
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', 'openid email profile')
  u.searchParams.set('state', state)
  u.searchParams.set('prompt', 'select_account')
  return Response.redirect(u.toString(), 302)
}
