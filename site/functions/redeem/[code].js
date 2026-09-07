/** /redeem/:code — the page behind a coupon link: hands the code to the app, or tells the user where to type it. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export async function onRequestGet({ env, params }) {
  const code = String(params.code || '').toUpperCase()
  let c = null
  if (/^[A-Z0-9-]{4,40}$/.test(code)) c = await env.DB.prepare('SELECT plan, max_uses, uses, expires_at FROM coupons WHERE code = ?1').bind(code).first()
  const usable = c && !(c.expires_at && Date.parse(c.expires_at) < Date.now()) && !(c.max_uses !== null && c.uses >= c.max_uses)
  const deep = `sinfonie://redeem?code=${encodeURIComponent(code)}`
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sinfonie · Your code</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ec;font:15px/1.5 -apple-system,system-ui,sans-serif}main{max-width:460px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#8b93a1;margin:0 0 16px}code{display:block;margin-top:8px;background:#171a21;border:1px solid #2a2f3a;border-radius:8px;padding:10px 12px;font-size:14px;letter-spacing:.08em;user-select:all}a.btn{display:inline-block;margin-top:12px;background:#5b7cfa;color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-weight:600}details{color:#8b93a1;font-size:13px}a{color:#7c9cff}</style>
<main>${
    usable
      ? `<h1>Sinfonie ${c.plan === 'team' ? 'with every feature' : 'Pro'}, on us</h1><p>This code unlocks ${c.plan === 'team' ? 'all features' : 'the Pro plan'} for free. Open Sinfonie to redeem it. If you do not have it yet, <a href="/">download it</a> first, then come back to this link.</p><a class="btn" href="${esc(deep)}">Redeem in Sinfonie</a><details><summary>If the button does nothing</summary>In Sinfonie go to Settings → Plan → "Have a code?" and enter<code>${esc(code)}</code></details>`
      : c
        ? `<h1>This code is no longer valid</h1><p>It expired or has been used up. Write to <a href="mailto:hello@sinfonie.dev">hello@sinfonie.dev</a> for a new one.</p>`
        : `<h1>Code not found</h1><p>Check the link, or write to <a href="mailto:hello@sinfonie.dev">hello@sinfonie.dev</a>.</p>`
  }</main></html>`
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}
