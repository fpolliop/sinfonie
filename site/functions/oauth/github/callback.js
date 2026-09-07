/**
 * GitHub sends the user back here. We exchange the code with the client secret (never in the app),
 * upsert the user, mint a desktop session and park it under the app's state for /oauth/poll.
 */
import { completeSignIn, oauthPage, esc, STATE_RE } from '../../_session.js'

async function github(path, token) {
  const r = await fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'sinfonie.dev' } })
  if (!r.ok) throw new Error(`GitHub ${path} answered ${r.status}`)
  return r.json()
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url)
  const code = u.searchParams.get('code') || ''
  const state = u.searchParams.get('state') || ''
  const err = u.searchParams.get('error') || ''
  if (err) return oauthPage('Sign-in cancelled', `${esc(u.searchParams.get('error_description') || err)}. Go back to Sinfonie and try again.`)
  if (!code || !STATE_RE.test(state)) return oauthPage('Sign-in failed', 'The link is incomplete. Start the sign-in again from Sinfonie.')
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return oauthPage('Not configured', 'Sinfonie has no GitHub sign-in configured on the server yet.')
  try {
    const tr = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: 'https://sinfonie.dev/oauth/github/callback' })
    })
    const tj = await tr.json()
    if (!tj.access_token) throw new Error(tj.error_description || tj.error || 'no access token')
    const gh = await github('/user', tj.access_token)
    let email = gh.email || null
    if (!email) {
      const emails = await github('/user/emails', tj.access_token).catch(() => [])
      email = (emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || {}).email || null
    }
    await completeSignIn(env, request, state, { provider: 'github', providerId: gh.id, login: gh.login, name: gh.name, email, avatarUrl: gh.avatar_url })
    return oauthPage('You are signed in', `Signed in as <strong>${esc(gh.login)}</strong>. You can close this tab; Sinfonie picks it up within a few seconds.`)
  } catch (e) {
    console.error('github callback failed', e)
    return oauthPage('Sign-in failed', `${esc(e.message || e)}. Go back to Sinfonie and try again.`)
  }
}
