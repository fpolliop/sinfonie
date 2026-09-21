/**
 * Generated views, stored in the user's settings (personal) or a space (shared with its team). Every
 * change keeps the previous version for undo. Validation happens here so no surface can save a
 * spec the renderer would refuse.
 */
import { nanoid } from 'nanoid'
import { getStore } from '../../store'
import { CATALOG_VERSION } from '@shared/views/catalog'
import { TEMPLATES } from '@shared/views/templates'
import { validateView } from '@shared/views/validate'
import type { ScopedView, ViewAuthor, ViewDef, ViewElement, ViewInput, ViewIssue, ViewScope, ViewSourceBinding } from '@shared/views/types'
import type { StoreData } from '@shared/types'

const HISTORY = 10

export class ViewInvalid extends Error {
  constructor(public issues: ViewIssue[]) {
    super(`The view has ${issues.length} problem(s):\n${issues.map((i) => `- ${i.path}: ${i.message}`).join('\n')}`)
  }
}

function listIn(d: StoreData, scope: ViewScope): ViewDef[] {
  if (scope.kind === 'user') return (d.settings.views ??= [])
  const s = d.spaces.find((x) => x.id === scope.spaceId)
  if (!s) throw new Error(`No space ${scope.spaceId}`)
  return (s.views ??= [])
}

export function list(): ScopedView[] {
  const d = getStore().get()
  return [
    ...(d.settings.views ?? []).map((v) => ({ ...v, scope: { kind: 'user' } as ViewScope })),
    ...d.spaces.flatMap((s) => (s.views ?? []).map((v) => ({ ...v, scope: { kind: 'space', spaceId: s.id } as ViewScope })))
  ]
}

export function get(id: string): ScopedView {
  const v = list().find((x) => x.id === id)
  if (!v) throw new Error(`No view ${id}. Call ui_list_views for the list.`)
  return v
}

/** Create, or replace when input.id names an existing view (keeping its scope). */
export function save(input: ViewInput, scope: ViewScope, by: ViewAuthor): ScopedView {
  const issues = validateView(input)
  if (issues.length) throw new ViewInvalid(issues)
  const now = new Date().toISOString()
  const existing = input.id ? list().find((v) => v.id === input.id) : undefined
  const target = existing?.scope ?? scope
  let saved: ViewDef | undefined
  getStore().update((d) => {
    const arr = listIn(d, target)
    const i = existing ? arr.findIndex((v) => v.id === existing.id) : -1
    const prev = i >= 0 ? arr[i] : undefined
    const history = prev ? [...(prev.history ?? []), { title: prev.title, spec: prev.spec, sources: prev.sources, at: prev.updatedAt, by: prev.updatedBy }].slice(-HISTORY) : []
    const next: ViewDef = {
      id: prev?.id ?? nanoid(8),
      title: input.title.trim(),
      slot: input.slot,
      ...(input.icon ? { icon: input.icon } : {}),
      spec: input.spec,
      sources: input.sources ?? {},
      catalogVersion: CATALOG_VERSION,
      ...((input.template ?? prev?.template) ? { template: input.template ?? prev?.template } : {}),
      ...((input.basedOn ?? prev?.basedOn) ? { basedOn: input.basedOn ?? prev?.basedOn } : {}),
      ...(history.length ? { history } : {}),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      updatedBy: by
    }
    if (i >= 0) arr[i] = next
    else arr.push(next)
    saved = next
  })
  return { ...saved!, scope: target }
}

export interface ViewPatch {
  title?: string
  icon?: string
  root?: string
  /** Elements to add or replace; null removes one (and its key from every children list). */
  elements?: Record<string, ViewElement | null>
  /** Sources to add or replace; null removes one. */
  sources?: Record<string, ViewSourceBinding | null>
  uiState?: Record<string, unknown>
}

export function patch(id: string, p: ViewPatch, by: ViewAuthor): ScopedView {
  const v = get(id)
  const elements = { ...v.spec.elements }
  for (const [k, el] of Object.entries(p.elements ?? {})) {
    if (el === null) {
      delete elements[k]
      for (const [ok, other] of Object.entries(elements)) if (other.children?.includes(k)) elements[ok] = { ...other, children: other.children.filter((c) => c !== k) }
    } else elements[k] = el
  }
  const sources = { ...v.sources }
  for (const [k, b] of Object.entries(p.sources ?? {})) {
    if (b === null) delete sources[k]
    else sources[k] = b
  }
  const spec = { root: p.root ?? v.spec.root, elements, ...(p.uiState || v.spec.state ? { state: { ui: { ...(v.spec.state?.ui ?? {}), ...(p.uiState ?? {}) } } } : {}) }
  return save({ id, title: p.title ?? v.title, slot: v.slot, icon: p.icon ?? v.icon, spec, sources, template: v.template, basedOn: v.basedOn }, v.scope, by)
}

/** Back to the previous version. */
export function undo(id: string): ScopedView {
  const v = get(id)
  const prev = v.history?.at(-1)
  if (!prev) throw new Error('Nothing to undo for this view.')
  getStore().update((d) => {
    const arr = listIn(d, v.scope)
    const i = arr.findIndex((x) => x.id === id)
    arr[i] = { ...arr[i], title: prev.title, spec: prev.spec, sources: prev.sources, history: (arr[i].history ?? []).slice(0, -1), updatedAt: new Date().toISOString(), updatedBy: 'user' }
  })
  return get(id)
}

export function remove(id: string): void {
  const v = get(id)
  getStore().update((d) => {
    const arr = listIn(d, v.scope)
    arr.splice(arr.findIndex((x) => x.id === id), 1)
    const o = d.settings.viewOverrides
    if (o) for (const [k, val] of Object.entries(o)) if (k === id || val === id) delete o[k]
  })
}

/** A personal copy of a space view that replaces it for this user. */
export function fork(id: string): ScopedView {
  const v = get(id)
  if (v.scope.kind !== 'space') throw new Error('Only space views can be copied for yourself.')
  const mine = save({ title: v.title, slot: v.slot, icon: v.icon, spec: v.spec, sources: v.sources, template: v.template, basedOn: v.id }, { kind: 'user' }, 'user')
  getStore().update((d) => {
    d.settings.viewOverrides = { ...(d.settings.viewOverrides ?? {}), [v.id]: mine.id }
  })
  return mine
}

/** Drop a personal copy and go back to the team's version. */
export function resetToTeam(personalId: string): void {
  const v = get(personalId)
  if (!v.basedOn) throw new Error('This view is not a copy of a space view.')
  remove(personalId)
}

export function setHidden(spaceViewId: string, hidden: boolean): void {
  getStore().update((d) => {
    const o = { ...(d.settings.viewOverrides ?? {}) }
    if (hidden) o[spaceViewId] = 'hidden'
    else if (o[spaceViewId] === 'hidden') delete o[spaceViewId]
    d.settings.viewOverrides = o
  })
}

export function move(id: string, dir: -1 | 1): void {
  const v = get(id)
  getStore().update((d) => {
    const arr = listIn(d, v.scope)
    const i = arr.findIndex((x) => x.id === id)
    const j = i + dir
    if (j < 0 || j >= arr.length) return
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  })
}

export function installTemplate(templateId: string, scope?: ViewScope): ScopedView {
  const t = TEMPLATES.find((x) => x.id === templateId)
  if (!t) throw new Error(`No template ${templateId}. Available: ${TEMPLATES.map((x) => x.id).join(', ')}`)
  const target: ViewScope = scope ?? { kind: 'user' }
  return save({ ...structuredClone(t.view), id: undefined }, target, 'template')
}
