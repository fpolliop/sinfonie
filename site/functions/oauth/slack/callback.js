/**
 * Slack OAuth callback. Slack only accepts HTTPS redirect URLs, so the desktop app points here;
 * this page hands the code straight back to the app through its sinfonie:// link and shows it as
 * a fallback to paste. No secret ever touches this function.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export async function onRequestGet({ request }) {
  const u = new URL(request.url)
  const code = u.searchParams.get('code') || ''
  const state = u.searchParams.get('state') || ''
  const error = u.searchParams.get('error') || ''
  const deep = `sinfonie://oauth/slack?${new URLSearchParams({ code, state, error }).toString()}`
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sinfonie · Slack</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ec;font:15px/1.5 -apple-system,system-ui,sans-serif}main{max-width:460px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#8b93a1;margin:0 0 16px}code{display:block;background:#171a21;border:1px solid #2a2f3a;border-radius:8px;padding:10px 12px;font-size:13px;word-break:break-all;user-select:all}a.btn{display:inline-block;margin-top:12px;background:#5b7cfa;color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-weight:600}</style>
<main>${
    error
      ? `<h1>Slack sign-in failed</h1><p>${esc(error)}. Go back to Sinfonie and try again.</p>`
      : `<h1>Back to Sinfonie</h1><p>Sinfonie should open by itself and finish connecting Slack. If it did not, open it and paste this code under Settings → On call.</p><code>${esc(code)}</code><a class="btn" href="${esc(deep)}">Open Sinfonie</a>`
  }</main>
${error ? '' : `<script>location.href=${JSON.stringify(deep)}</script>`}
</html>`
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}
