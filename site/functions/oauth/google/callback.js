/** Google sends the user back here: exchange the code, read the profile, mint the desktop session. */
import { completeSignIn, oauthPage, esc, STATE_RE } from '../../_session.js'

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url)
  const code = u.searchParams.get('code') || ''
  const state = u.searchParams.get('state') || ''
  const err = u.searchParams.get('error') || ''
  if (err) return oauthPage('Sign-in cancelled', `${esc(err)}. Go back to Sinfonie and try again.`)
  if (!code || !STATE_RE.test(state)) return oauthPage('Sign-in failed', 'The link is incomplete. Start the sign-in again from Sinfonie.')
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return oauthPage('Not configured', 'Sinfonie has no Google sign-in configured on the server yet.')
  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: 'https://sinfonie.dev/oauth/google/callback', grant_type: 'authorization_code' })
    })
    const tj = await tr.json()
    if (!tj.access_token) throw new Error(tj.error_description || tj.error || 'no access token')
    const pr = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tj.access_token}` } })
    if (!pr.ok) throw new Error(`Google userinfo answered ${pr.status}`)
    const p = await pr.json()
    if (!p.sub) throw new Error('Google returned no account id')
    const email = p.email_verified && p.email ? p.email : null
    const login = (email ? email.split('@')[0] : `google-${p.sub.slice(-6)}`).toLowerCase()
    await completeSignIn(env, request, state, { provider: 'google', providerId: p.sub, login, name: p.name, email, avatarUrl: p.picture })
    return oauthPage('You are signed in', `Signed in as <strong>${esc(p.name || email || login)}</strong>. You can close this tab; Sinfonie picks it up within a few seconds.`)
  } catch (e) {
    console.error('google callback failed', e)
    return oauthPage('Sign-in failed', `${esc(e.message || e)}. Go back to Sinfonie and try again.`)
  }
}
