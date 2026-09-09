/**
 * Domains an organisation claims (admin).
 *   POST {domain}           claim it; returns the TXT token to publish at _sinfonie.<domain>
 *   POST {domain, verify:1} look the record up over DNS-over-HTTPS and mark the domain verified
 *   DELETE ?domain=         drop the claim
 * A verified domain lets people with a verified email on it join, per the organisation's domain-join policy.
 */
import { currentUser, randomToken, json, error } from '../../../_session.js'
import { orgView } from '../index.js'
import { membership } from './index.js'

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/
const PUBLIC = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com', 'mail.com', 'gmx.com', 'yandex.com', 'zoho.com', 'fastmail.com', 'hey.com'])

async function admin(request, env, params) {
  const user = await currentUser(request, env)
  if (!user) return { res: error('unauthorized', 'Sign in again.', 401) }
  const org = await membership(env, params.id, user.id)
  if (!org) return { res: error('not_found', 'No such organisation.', 404) }
  if (org.role !== 'admin') return { res: error('forbidden', 'Only admins manage domains.', 403) }
  return { user, org }
}

/** TXT records at _sinfonie.<domain>, through Cloudflare's resolver. */
export async function txtRecords(domain) {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=_sinfonie.${encodeURIComponent(domain)}&type=TXT`, { headers: { Accept: 'application/dns-json' } })
  if (!r.ok) return []
  const j = await r.json()
  return (j.Answer || []).map((a) => String(a.data || '').replace(/^"|"$/g, '').replace(/"\s*"/g, ''))
}

export async function onRequestPost({ request, env, params }) {
  const { res, org } = await admin(request, env, params)
  if (res) return res
  const b = await request.json().catch(() => ({}))
  const domain = String(b.domain || '').trim().toLowerCase().replace(/^@/, '')
  if (!DOMAIN_RE.test(domain)) return error('invalid_domain', 'That does not look like a domain.')
  if (PUBLIC.has(domain)) return error('public_domain', 'Public email providers cannot be claimed.')
  const existing = await env.DB.prepare('SELECT org_id, token, verified_at FROM org_domains WHERE domain = ?1').bind(domain).first()
  if (existing && existing.org_id !== org.id) {
    if (existing.verified_at) return error('taken', 'Another organisation already verified this domain.', 409)
    await env.DB.prepare('DELETE FROM org_domains WHERE domain = ?1').bind(domain).run()
  }
  let token = existing && existing.org_id === org.id ? existing.token : null
  if (!token) {
    token = `sinfonie-verify=${randomToken(18)}`
    await env.DB.prepare('INSERT INTO org_domains (domain, org_id, token) VALUES (?1, ?2, ?3)').bind(domain, org.id, token).run()
  }
  if (b.verify) {
    const records = await txtRecords(domain)
    if (!records.includes(token)) return json({ verified: false, domain, token, record: `_sinfonie.${domain}`, found: records.slice(0, 5), org: await orgView(env, org, org.role) })
    await env.DB.prepare("UPDATE org_domains SET verified_at = datetime('now') WHERE domain = ?1").bind(domain).run()
    return json({ verified: true, domain, org: await orgView(env, org, org.role) })
  }
  return json({ verified: false, domain, token, record: `_sinfonie.${domain}`, org: await orgView(env, org, org.role) })
}

export async function onRequestDelete({ request, env, params }) {
  const { res, org } = await admin(request, env, params)
  if (res) return res
  const domain = (new URL(request.url).searchParams.get('domain') || '').toLowerCase()
  await env.DB.prepare('DELETE FROM org_domains WHERE domain = ?1 AND org_id = ?2').bind(domain, org.id).run()
  return json(await orgView(env, org, org.role))
}
