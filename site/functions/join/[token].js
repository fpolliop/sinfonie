/** /join/:token — the page behind an invite link: names the team and hands the code to the app. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export async function onRequestGet({ env, params }) {
  const token = params.token || ''
  let inv = null
  if (/^[A-Za-z0-9_-]{16,64}$/.test(token)) inv = await env.DB.prepare('SELECT i.accepted_at, o.name FROM org_invites i JOIN orgs o ON o.id = i.org_id WHERE i.token = ?1').bind(token).first()
  const ok = inv && !inv.accepted_at
  const deep = `sinfonie://join?token=${encodeURIComponent(token)}`
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sinfonie · Join ${esc(inv?.name || 'a team')}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ec;font:15px/1.5 -apple-system,system-ui,sans-serif}main{max-width:460px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#8b93a1;margin:0 0 16px}code{display:block;margin-top:8px;background:#171a21;border:1px solid #2a2f3a;border-radius:8px;padding:10px 12px;font-size:12px;word-break:break-all;user-select:all}a.btn{display:inline-block;margin-top:12px;background:#5b7cfa;color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-weight:600}details{color:#8b93a1;font-size:13px}a{color:#7c9cff}</style>
<main>${
    ok
      ? `<h1>You are invited to ${esc(inv.name)}</h1><p>Open Sinfonie to join. If you do not have it yet, <a href="/">download it</a> first, then come back to this link.</p><a class="btn" href="${esc(deep)}">Open in Sinfonie</a><details><summary>If the button does nothing</summary>In Sinfonie go to Settings → Plan → Join a team and paste this code.<code>${esc(token)}</code></details>`
      : inv
        ? `<h1>This invite was already used</h1><p>Ask a team admin for a new link.</p>`
        : `<h1>Invite not found</h1><p>The link is incomplete or was revoked. Ask a team admin for a new one.</p>`
  }</main></html>`
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}
