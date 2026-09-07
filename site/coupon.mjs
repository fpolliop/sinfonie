#!/usr/bin/env node
/**
 * Mint or list coupon codes straight in D1 with your Cloudflare login (no ADMIN_TOKEN needed).
 *
 *   pnpm coupon                                   list codes and how often they were used
 *   pnpm coupon new                               one code, all features, for good, single use
 *   pnpm coupon new --uses 20 --note "beta wave 1"
 *   pnpm coupon new --code FRIENDS-2026 --plan pro --days 90 --uses 50
 *
 * Share the printed link; it opens the app and applies the code after sign-in.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const sql = (q) => {
  const out = execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'sinfonie-feedback', '--remote', '--json', '--config', 'site/wrangler.toml', '--command', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  return JSON.parse(out.slice(out.indexOf('[')))[0]
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`

if (args[0] !== 'new') {
  const { results } = sql('SELECT code, plan, uses, max_uses, duration_days, expires_at, note, created_at FROM coupons ORDER BY created_at DESC')
  if (!results.length) console.log('No coupons yet. Create one with: pnpm coupon new')
  for (const c of results) console.log(`${c.code.padEnd(18)} ${c.plan.padEnd(5)} ${String(c.uses).padStart(3)}/${c.max_uses ?? '∞'}  ${c.duration_days ? c.duration_days + ' days' : 'for good'}${c.expires_at ? '  expires ' + c.expires_at.slice(0, 10) : ''}${c.note ? '  ' + c.note : ''}`)
  process.exit(0)
}

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const rnd = (n) => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join('')
const code = String(opt('code', `${opt('prefix', 'BETA')}-${rnd(4)}-${rnd(4)}`)).toUpperCase()
const plan = opt('plan', 'team')
const uses = opt('uses', '1')
const days = opt('days', null)
const note = opt('note', null)
if (!['pro', 'team'].includes(plan)) throw new Error('--plan must be pro or team')
sql(`INSERT INTO coupons (code, plan, max_uses, duration_days, note) VALUES (${q(code)}, ${q(plan)}, ${uses === 'unlimited' ? 'NULL' : Number(uses)}, ${days ? Number(days) : 'NULL'}, ${note ? q(note) : 'NULL'})`)
console.log(`${code}  ${plan === 'team' ? 'all features' : 'Pro'}, ${days ? days + ' days' : 'for good'}, ${uses === 'unlimited' ? 'unlimited uses' : uses + ' use' + (uses === '1' ? '' : 's')}`)
console.log(`https://sinfonie.dev/redeem/${code}`)
