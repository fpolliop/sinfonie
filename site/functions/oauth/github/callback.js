/**
 * GitHub sends the user back here. We exchange the code with the client secret (never in the app),
 * upsert the user, mint a desktop session and park it under the app's state for /oauth/github/poll.
 * The page itself only says "you can close this".
 */
import { sha256, randomToken, newId } from '../../_session.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const page = (title, body) =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sinfonie · ${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ec;font:15px/1.5 -apple-system,system-ui,sans-serif}main{max-width:460px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#8b93a1;margin:0 0 16px}</style>
<main><h1>${esc(title)}</h1><p>${body}</p></main></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  )

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
  if (err) return page('Sign-in cancelled', `${esc(u.searchParams.get('error_description') || err)}. Go back to Sinfonie and try again.`)
  if (!code || !/^[A-Za-z0-9_-]{16,64}$/.test(state)) return page('Sign-in failed', 'The link is incomplete. Start the sign-in again from Sinfonie.')
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return page('Not configured', 'Sinfonie has no GitHub sign-in configured on the server yet.')
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
    const existing = await env.DB.prepare('SELECT id FROM users WHERE github_id = ?1').bind(gh.id).first()
    const userId = existing?.id || newId()
    if (existing) {
      await env.DB.prepare("UPDATE users SET login = ?2, name = ?3, email = COALESCE(?4, email), avatar_url = ?5, last_seen_at = datetime('now') WHERE id = ?1").bind(userId, gh.login, gh.name || null, email, gh.avatar_url || null).run()
    } else {
      await env.DB.prepare("INSERT INTO users (id, github_id, login, name, email, avatar_url, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))").bind(userId, gh.id, gh.login, gh.name || null, email, gh.avatar_url || null).run()
    }
    const token = randomToken(32)
    await env.DB.batch([
      env.DB.prepare('INSERT INTO sessions (token_hash, user_id, user_agent) VALUES (?1, ?2, ?3)').bind(await sha256(token), userId, (request.headers.get('User-Agent') || '').slice(0, 200)),
      env.DB.prepare('INSERT OR REPLACE INTO oauth_codes (state, code) VALUES (?1, ?2)').bind(`gh:${state}`, token)
    ])
    return page('You are signed in', `Signed in as <strong>${esc(gh.login)}</strong>. You can close this tab; Sinfonie picks it up within a few seconds.`)
  } catch (e) {
    console.error('github callback failed', e)
    return page('Sign-in failed', `${esc(e.message || e)}. Go back to Sinfonie and try again.`)
  }
}
