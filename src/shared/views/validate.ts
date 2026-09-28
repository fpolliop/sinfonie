/**
 * Checks a view before it is saved: the catalog (component types, literal props, actions and their
 * params), the data bindings ($state paths must point at a declared source, /meta, /context or /ui),
 * and json-render's own structural checks. Issues go back to Maestro, which repairs the spec.
 */
import type { z } from 'zod'
import { validateSpec, type Spec } from '@json-render/core'
import { ACTIONS, BUILTIN_ACTIONS, COMPONENTS } from './catalog'
import { SOURCES, isSourceId } from './sources'
import type { ViewInput, ViewIssue } from './types'

const isExpr = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).some((k) => k.startsWith('$'))

/** Every state path an expression reads or binds, including ${/path} inside $template. */
function paths(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => paths(x, out))
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === '$state' || k === '$bindState') && typeof x === 'string') out.push(x)
      else if (k === '$template' && typeof x === 'string') for (const m of x.matchAll(/\$\{(\/[^}]*)\}/g)) out.push(m[1])
      else paths(x, out)
    }
  }
  return out
}

function checkLiteral(issues: ViewIssue[], at: string, shape: Record<string, z.ZodType>, values: Record<string, unknown> | undefined, what: string): void {
  const vals = values ?? {}
  for (const [k, v] of Object.entries(vals)) {
    const field = shape[k]
    if (!field) {
      issues.push({ path: `${at}.${k}`, message: `unknown ${what} "${k}"; allowed: ${Object.keys(shape).join(', ') || 'none'}` })
      continue
    }
    if (isExpr(v)) continue
    const r = field.safeParse(v)
    if (!r.success) issues.push({ path: `${at}.${k}`, message: r.error.issues.map((i) => i.message).join('; ') })
  }
  for (const [k, field] of Object.entries(shape)) {
    if (!(k in vals) && !field.safeParse(undefined).success) issues.push({ path: `${at}.${k}`, message: `required ${what} "${k}" is missing` })
  }
}

export function validateView(v: ViewInput): ViewIssue[] {
  const issues: ViewIssue[] = []
  if (!v.title?.trim()) issues.push({ path: 'title', message: 'a title is required' })
  if (v.slot !== 'home' && v.slot !== 'workspace-tab') issues.push({ path: 'slot', message: 'slot must be "home" or "workspace-tab"' })
  const sources = v.sources ?? {}
  for (const [name, b] of Object.entries(sources)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) issues.push({ path: `sources.${name}`, message: 'source names are identifiers (letters, digits, _)' })
    if (!isSourceId(b.source)) {
      issues.push({ path: `sources.${name}.source`, message: `unknown source "${b.source}"; available: ${Object.keys(SOURCES).join(', ')}` })
      continue
    }
    const def = SOURCES[b.source]
    const r = def.params.safeParse(b.params ?? {})
    if (!r.success) issues.push({ path: `sources.${name}.params`, message: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
    if ('needsWorkspace' in def && def.needsWorkspace && v.slot !== 'workspace-tab') issues.push({ path: `sources.${name}`, message: `${b.source} needs a workspace: use it in a "workspace-tab" view` })
  }
  const spec = v.spec
  if (!spec || typeof spec !== 'object' || !spec.elements || typeof spec.elements !== 'object') {
    issues.push({ path: 'spec', message: 'spec must be { root, elements }' })
    return issues
  }
  if (!spec.elements[spec.root]) issues.push({ path: 'spec.root', message: `root "${spec.root}" is not an element` })

  const okPath = (p: string): string | null => {
    const seg = p.split('/').filter(Boolean)
    if (!seg.length) return 'empty path'
    if (seg[0] === 'context' || seg[0] === 'ui') return null
    if (seg[0] === 'data' || seg[0] === 'meta') return seg[1] && seg[1] in sources ? null : `"${p}" reads source "${seg[1] ?? ''}", which the view does not declare in sources`
    return `"${p}" is outside the state a view can read (/data/<source>, /meta/<source>, /context, /ui)`
  }

  for (const [key, el] of Object.entries(spec.elements)) {
    const at = `spec.elements.${key}`
    const comp = COMPONENTS[el.type as keyof typeof COMPONENTS]
    if (!comp) {
      issues.push({ path: `${at}.type`, message: `unknown component "${el.type}"; available: ${Object.keys(COMPONENTS).join(', ')}` })
      continue
    }
    checkLiteral(issues, `${at}.props`, comp.props.shape as Record<string, z.ZodType>, el.props, 'prop')
    for (const p of paths([el.props, el.visible])) {
      const bad = okPath(p)
      if (bad) issues.push({ path: at, message: bad })
    }
    if (el.repeat) {
      const sp = el.repeat.statePath
      if (typeof sp === 'string') {
        const bad = okPath(sp)
        if (bad) issues.push({ path: `${at}.repeat`, message: bad })
        else if (!sp.startsWith('/data/') && !sp.startsWith('/ui/')) issues.push({ path: `${at}.repeat`, message: 'repeat over /data/<source> (or a /ui array)' })
      }
    }
    for (const [event, bindings] of Object.entries(el.on ?? {})) {
      for (const b of Array.isArray(bindings) ? bindings : [bindings]) {
        const bat = `${at}.on.${event}`
        if ((BUILTIN_ACTIONS as readonly string[]).includes(b.action)) continue
        const action = ACTIONS[b.action as keyof typeof ACTIONS]
        if (!action) {
          issues.push({ path: bat, message: `unknown action "${b.action}"; available: ${[...Object.keys(ACTIONS), ...BUILTIN_ACTIONS].join(', ')}` })
          continue
        }
        checkLiteral(issues, `${bat}.params`, action.params.shape as Record<string, z.ZodType>, b.params, 'param')
        for (const p of paths(b.params)) {
          const bad = okPath(p)
          if (bad) issues.push({ path: bat, message: bad })
        }
      }
    }
  }

  // json-render's structure checks, with the state a real render would have.
  const data = Object.fromEntries(Object.keys(sources).map((n) => [n, []]))
  const meta = Object.fromEntries(Object.keys(sources).map((n) => [n, { count: 0, loading: false }]))
  const structural = validateSpec({ ...spec, state: { data, meta, context: {}, ui: spec.state?.ui ?? {} } } as unknown as Spec)
  for (const i of structural.issues) if (i.severity === 'error') issues.push({ path: i.elementKey ? `spec.elements.${i.elementKey}` : 'spec', message: i.message })
  return issues
}
