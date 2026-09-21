/**
 * Maestro's tools for generated views: read the catalog, list and read views, create, patch, undo,
 * delete, install templates, open a view. Every save validates; problems come back as the tool
 * error so Maestro fixes the spec and tries again. Saving opens the view so the user sees it.
 */
import { z } from 'zod'
import { getStore } from '../../store'
import { catalogDocs } from '@shared/views/catalog-docs'
import { TEMPLATES } from '@shared/views/templates'
import type { ViewElement, ViewScope, ViewSourceBinding, ViewSpec } from '@shared/views/types'
import * as views from './store'

export type ViewToolDef = { name: string; description: string; shape: z.ZodRawShape; run: (args: Record<string, unknown>) => Promise<string> }

interface Host {
  openView: (viewId: string, workspaceId?: string) => void
}

/** Objects may arrive as JSON text; accept both. (z.record in a tool shape breaks the SDK MCP server, so these are z.any.) */
function obj<T>(v: unknown, what: string): T {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T
    } catch {
      throw new Error(`${what} is not valid JSON`)
    }
  }
  if (!v || typeof v !== 'object') throw new Error(`${what} must be an object`)
  return v as T
}

function scopeOf(ref: unknown): ViewScope {
  const r = String(ref ?? 'user').trim()
  if (!r || ['user', 'me', 'personal', 'mine'].includes(r.toLowerCase())) return { kind: 'user' }
  const s = getStore().get().spaces.find((x) => x.id === r || x.name.toLowerCase() === r.toLowerCase())
  if (!s) throw new Error(`No space "${r}". Use "user" for a personal view or a space id / name.`)
  return { kind: 'space', spaceId: s.id }
}

function scopeName(s: ViewScope): string {
  return s.kind === 'user' ? 'personal' : `space ${getStore().get().spaces.find((x) => x.id === s.spaceId)?.name ?? s.spaceId}`
}

export function viewTools(host: Host): ViewToolDef[] {
  const opened = (id: string, text: string, workspaceId?: string): string => {
    const v = views.get(id)
    if (v.slot === 'workspace-tab' && !workspaceId) return `${text} It shows as the "${v.title}" tab in every workspace${v.scope.kind === 'space' ? ' of that space' : ''}; open a workspace to see it.`
    host.openView(id, workspaceId)
    return `${text} Opened it for the user.`
  }
  return [
    {
      name: 'ui_catalog',
      description:
        "How to build Sinfonie views: the components, actions (with risk tiers), data sources and their row fields, expression rules and templates. Call it before creating or changing a view (a Home page or a workspace tab the user wants, e.g. 'show my PRs and CI', 'a board of my tickets', 'a tab with each repo's branch status').",
      shape: {},
      run: async () => catalogDocs()
    },
    {
      name: 'ui_list_views',
      description: 'The views that exist: personal ones and each space\'s (shared with its team), with slot, template, whether the user hid or copied a space view, and who changed it last.',
      shape: {},
      run: async () => {
        const overrides = getStore().get().settings.viewOverrides ?? {}
        const list = views.list()
        if (!list.length) return 'No views yet. Templates: ' + TEMPLATES.map((t) => `${t.id} (${t.title})`).join(', ')
        return list
          .map((v) => {
            const o = overrides[v.id]
            const flag = o === 'hidden' ? ' [hidden by the user]' : o ? ` [replaced for the user by personal copy ${o}]` : v.basedOn ? ` [personal copy of ${v.basedOn}]` : ''
            return `- ${v.id}: "${v.title}" (${v.slot}, ${scopeName(v.scope)}${v.template ? `, from ${v.template}` : ''}, ${Object.keys(v.spec.elements).length} elements, sources ${Object.entries(v.sources).map(([n, b]) => `${n}=${b.source}`).join(', ') || 'none'}, last changed by ${v.updatedBy}${v.history?.length ? `, ${v.history.length} undo step(s)` : ''})${flag}`
          })
          .join('\n')
      }
    },
    {
      name: 'ui_get_view',
      description: 'The full definition of one view (title, slot, sources, spec) to read before patching it.',
      shape: { id: z.string() },
      run: async (i) => {
        const { history: _h, ...v } = views.get(String(i.id))
        return JSON.stringify(v, null, 1)
      }
    },
    {
      name: 'ui_get_template',
      description: 'The full definition of a template, as an example to start from.',
      shape: { id: z.string() },
      run: async (i) => {
        const t = TEMPLATES.find((x) => x.id === String(i.id))
        if (!t) throw new Error(`No template ${String(i.id)}. Available: ${TEMPLATES.map((x) => x.id).join(', ')}`)
        return JSON.stringify(t, null, 1)
      }
    },
    {
      name: 'ui_save_view',
      description:
        'Create a view, or replace one completely (pass its id). scope: "user" for a personal view (every space) or a space id/name to put it in that space for the whole team. spec and sources as described by ui_catalog. Validated: on problems you get the list back; fix and retry. The view opens for the user.',
      shape: {
        id: z.string().optional().describe('Existing view id to replace'),
        title: z.string(),
        slot: z.enum(['home', 'workspace-tab']),
        icon: z.string().optional(),
        scope: z.string().optional().describe('"user" (default) or a space id / name'),
        sources: z.any().describe('{ "<name>": { "source": "<source id>", "params": {...} } }'),
        spec: z.any().describe('{ "root": "<key>", "elements": { ... } }'),
        workspaceId: z.string().optional().describe('For a workspace-tab view: a workspace to open it in')
      },
      run: async (i) => {
        const v = views.save(
          {
            id: i.id ? String(i.id) : undefined,
            title: String(i.title),
            slot: i.slot as 'home' | 'workspace-tab',
            icon: i.icon ? String(i.icon) : undefined,
            sources: i.sources === undefined ? {} : obj<Record<string, ViewSourceBinding>>(i.sources, 'sources'),
            spec: obj<ViewSpec>(i.spec, 'spec')
          },
          scopeOf(i.scope),
          'maestro'
        )
        return opened(v.id, `Saved "${v.title}" (${v.id}, ${scopeName(v.scope)}).`, i.workspaceId ? String(i.workspaceId) : undefined)
      }
    },
    {
      name: 'ui_patch_view',
      description:
        'Change part of a view: elements to add or replace ({ key: element }, or { key: null } to remove it and its references), sources ({ name: binding } or null), title, icon, root. Prefer this over ui_save_view for small changes. Validated like a save; the user can undo.',
      shape: {
        id: z.string(),
        title: z.string().optional(),
        icon: z.string().optional(),
        root: z.string().optional(),
        elements: z.any().optional(),
        sources: z.any().optional(),
        workspaceId: z.string().optional()
      },
      run: async (i) => {
        const v = views.patch(
          String(i.id),
          {
            ...(i.title ? { title: String(i.title) } : {}),
            ...(i.icon ? { icon: String(i.icon) } : {}),
            ...(i.root ? { root: String(i.root) } : {}),
            ...(i.elements !== undefined ? { elements: obj<Record<string, ViewElement | null>>(i.elements, 'elements') } : {}),
            ...(i.sources !== undefined ? { sources: obj<Record<string, ViewSourceBinding | null>>(i.sources, 'sources') } : {})
          },
          'maestro'
        )
        return opened(v.id, `Updated "${v.title}".`, i.workspaceId ? String(i.workspaceId) : undefined)
      }
    },
    {
      name: 'ui_undo_view',
      description: 'Put a view back to its previous version.',
      shape: { id: z.string() },
      run: async (i) => {
        const v = views.undo(String(i.id))
        return opened(v.id, `"${v.title}" is back to its previous version.`)
      }
    },
    {
      name: 'ui_delete_view',
      description: 'Delete a view. Ask the user first, naming it. Deleting a space view removes it for the whole team.',
      shape: { id: z.string() },
      run: async (i) => {
        const v = views.get(String(i.id))
        views.remove(v.id)
        return `Deleted "${v.title}" (${scopeName(v.scope)}).`
      }
    },
    {
      name: 'ui_install_template',
      description: `Install a template as a new view. Templates: ${TEMPLATES.map((t) => `${t.id} (${t.title}, default ${t.scope === 'user' ? 'personal' : 'space'})`).join(', ')}. scope: "user" or a space id / name (space templates need one).`,
      shape: { template: z.string(), scope: z.string().optional() },
      run: async (i) => {
        const t = TEMPLATES.find((x) => x.id === String(i.template))
        if (!t) throw new Error(`No template ${String(i.template)}`)
        const scope = i.scope ? scopeOf(i.scope) : { kind: 'user' as const }
        const v = views.installTemplate(t.id, scope)
        return opened(v.id, `Installed "${v.title}" (${v.id}, ${scopeName(v.scope)}).`)
      }
    },
    {
      name: 'ui_open_view',
      description: 'Show a view to the user (Home page, or a workspace tab when given a workspace).',
      shape: { id: z.string(), workspaceId: z.string().optional() },
      run: async (i) => opened(String(i.id), 'Done.', i.workspaceId ? String(i.workspaceId) : undefined)
    }
  ]
}
