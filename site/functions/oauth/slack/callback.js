/**
 * Slack OAuth callback. Slack only accepts HTTPS redirect URLs, so the desktop app points here.
 * The code is parked under its state for the app to poll (/oauth/slack/poll), and also offered
 * through the sinfonie:// link and as text to paste. No secret ever touches this function.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export async function onRequestGet({ request, env }) {
  const u = new URL(request.url)
  const code = u.searchParams.get('code') || ''
  const state = u.searchParams.get('state') || ''
  const error = u.searchParams.get('error') || ''
  if (code && state && /^[A-Za-z0-9_-]{16,64}$/.test(state)) {
    try {
      await env.DB.prepare('INSERT OR REPLACE INTO oauth_codes (state, code) VALUES (?1, ?2)').bind(state, code).run()
    } catch (e) {
      console.error('oauth_codes insert failed', e)
    }
  }
  const deep = `sinfonie://oauth/slack?${new URLSearchParams({ code, state, error }).toString()}`
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sinfonie · Slack</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ec;font:15px/1.5 -apple-system,system-ui,sans-serif}main{max-width:460px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#8b93a1;margin:0 0 16px}details{color:#8b93a1;font-size:13px}code{display:block;margin-top:8px;background:#171a21;border:1px solid #2a2f3a;border-radius:8px;padding:10px 12px;font-size:12px;word-break:break-all;user-select:all}a.btn{display:inline-block;margin-top:12px;background:#5b7cfa;color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-weight:600}</style>
<main>${
    error
      ? `<h1>Slack sign-in failed</h1><p>${esc(error)}. Go back to Sinfonie and try again.</p>`
      : `<h1>Slack is connected</h1><p>You can close this tab. Sinfonie picks the connection up by itself within a few seconds.</p><a class="btn" href="${esc(deep)}">Back to Sinfonie</a><details><summary>If Sinfonie does not connect</summary>Open it and paste this code under Settings → Integrations → Slack.<code>${esc(code)}</code></details>`
  }</main>
</html>`
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}
