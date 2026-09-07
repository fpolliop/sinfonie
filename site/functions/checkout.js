/**
 * /checkout?_ptxn=txn_…  The fallback checkout page when the Paddle account has no default payment
 * link: loads Paddle.js with the public client token and opens the transaction the API created.
 */
export async function onRequestGet({ request, env }) {
  const txn = new URL(request.url).searchParams.get('_ptxn') || ''
  const ok = /^txn_[A-Za-z0-9]+$/.test(txn) && env.PADDLE_CLIENT_TOKEN
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sinfonie · Checkout</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ec;font:15px/1.5 -apple-system,system-ui,sans-serif}main{max-width:460px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#8b93a1}</style>
<main><h1>${ok ? 'Opening checkout…' : 'Checkout is not available'}</h1><p>${ok ? 'Payment is handled by Paddle, our merchant of record. Close this tab when you are done; Sinfonie updates your plan by itself.' : 'Start again from Settings → Plan in Sinfonie.'}</p></main>
${
  ok
    ? `<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script><script>
${env.PADDLE_ENV === 'live' ? '' : "Paddle.Environment.set('sandbox');"}
Paddle.Initialize({ token: ${JSON.stringify(env.PADDLE_CLIENT_TOKEN)} });
Paddle.Checkout.open({ transactionId: ${JSON.stringify(txn)}, settings: { displayMode: 'overlay', theme: 'dark', successUrl: 'https://sinfonie.dev/checkout/done' } });
</script>`
    : ''
}</html>`
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}
