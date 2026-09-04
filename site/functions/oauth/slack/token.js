/**
 * Token exchange for Sinfonie's registered Slack OAuth client. The desktop app does PKCE and sends
 * the code (or a refresh token) here; this function adds the client secret, which never ships in
 * the app, and returns Slack's answer unchanged. Configure SLACK_CLIENT_ID and SLACK_CLIENT_SECRET
 * as Pages secrets.
 */
const REDIRECT = 'https://sinfonie.dev/oauth/slack/callback'
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
export async function onRequestPost({ request, env }) {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) return json({ error: 'not_configured', error_description: 'Sinfonie has no Slack client configured on the server yet.' }, 503)
  let b
  try {
    b = await request.json()
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }
  const grant = b.grant_type
  const params = new URLSearchParams({ client_id: env.SLACK_CLIENT_ID, client_secret: env.SLACK_CLIENT_SECRET, grant_type: grant })
  if (grant === 'authorization_code') {
    if (!b.code || !b.code_verifier || b.redirect_uri !== REDIRECT) return json({ error: 'invalid_request' }, 400)
    params.set('code', String(b.code))
    params.set('code_verifier', String(b.code_verifier))
    params.set('redirect_uri', REDIRECT)
  } else if (grant === 'refresh_token') {
    if (!b.refresh_token) return json({ error: 'invalid_request' }, 400)
    params.set('refresh_token', String(b.refresh_token))
  } else return json({ error: 'unsupported_grant_type' }, 400)
  const res = await fetch('https://slack.com/api/oauth.v2.user.access', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params })
  const body = await res.text()
  return new Response(body, { status: res.ok ? 200 : res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}
