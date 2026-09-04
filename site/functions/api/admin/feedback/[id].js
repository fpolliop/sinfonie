import { authorize, json } from '../../../_auth.js'

const STATUSES = new Set(['new', 'planned', 'in-progress', 'done', 'wontfix'])

/** PATCH { status?, note? } and DELETE for one item. */
export async function onRequestPatch({ request, env, params }) {
  const who = await authorize(request, env)
  if (!who) return json({ error: 'unauthorized' }, 401)
  const body = await request.json().catch(() => ({}))
  const sets = [], binds = []
  if (body.status !== undefined) { if (!STATUSES.has(body.status)) return json({ error: 'bad status' }, 400); sets.push('status = ?'); binds.push(body.status) }
  if (body.note !== undefined) { sets.push('note = ?'); binds.push(String(body.note).slice(0, 4000)) }
  if (!sets.length) return json({ error: 'nothing to update' }, 400)
  sets.push('updated_at = CURRENT_TIMESTAMP')
  await env.DB.prepare(`UPDATE feedback SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, Number(params.id)).run()
  return json({ ok: true })
}

export async function onRequestDelete({ request, env, params }) {
  const who = await authorize(request, env)
  if (!who) return json({ error: 'unauthorized' }, 401)
  await env.DB.prepare('DELETE FROM feedback WHERE id = ?').bind(Number(params.id)).run()
  return json({ ok: true })
}
