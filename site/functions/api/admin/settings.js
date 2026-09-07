/**
 * Admin: settings. GET returns them; PUT {trialEnabled, trialDays, trialPlan} saves them.
 * The trial applies to accounts created after the change; existing trials keep their dates.
 */
import { authorize, json } from '../../_auth.js'
import { getSettings } from '../../_session.js'

export async function onRequestGet({ request, env }) {
  if (!(await authorize(request, env))) return json({ error: 'unauthorized' }, 401)
  return json(await getSettings(env))
}

export async function onRequestPut({ request, env }) {
  if (!(await authorize(request, env))) return json({ error: 'unauthorized' }, 401)
  const b = await request.json().catch(() => ({}))
  const writes = []
  const put = (k, v) => writes.push(env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(k, String(v)))
  if (typeof b.trialEnabled === 'boolean') put('trial_enabled', b.trialEnabled)
  if (b.trialDays !== undefined) {
    const d = Math.max(0, Math.min(365, Math.round(Number(b.trialDays) || 0)))
    put('trial_days', d)
  }
  if (b.trialPlan === 'pro' || b.trialPlan === 'team') put('trial_plan', b.trialPlan)
  if (writes.length) await env.DB.batch(writes)
  return json(await getSettings(env))
}
