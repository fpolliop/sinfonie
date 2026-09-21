/**
 * What Maestro reads before writing a view (ui_catalog): components with their props, actions with
 * tiers, data sources with their row fields, and the expression rules. Generated from the catalog so
 * it never drifts.
 */
import { z } from 'zod'
import { ACTIONS, COMPONENTS, CATALOG_VERSION } from './catalog'
import { SOURCES } from './sources'
import { TEMPLATES } from './templates'

function typeOf(s: Record<string, unknown>): string {
  if (Array.isArray(s.enum)) return (s.enum as unknown[]).map((v) => JSON.stringify(v)).join('|')
  if (Array.isArray(s.anyOf)) return (s.anyOf as Record<string, unknown>[]).map(typeOf).join('|')
  if (s.type === 'array') return `${typeOf((s.items as Record<string, unknown>) ?? {})}[]`
  if (s.type === 'integer' || s.type === 'number') {
    const r = [s.minimum, s.maximum].every((v) => typeof v === 'number') ? ` ${s.minimum}-${s.maximum}` : ''
    return `number${r}`
  }
  return String(s.type ?? 'any')
}

function propsLine(schema: z.ZodObject): string {
  const js = z.toJSONSchema(schema, { unrepresentable: 'any' }) as { properties?: Record<string, Record<string, unknown>>; required?: string[] }
  const req = new Set(js.required ?? [])
  const parts = Object.entries(js.properties ?? {}).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${typeOf(v)}${v.description ? ` (${String(v.description)})` : ''}`)
  return parts.length ? parts.join(', ') : 'none'
}

export function catalogDocs(): string {
  const comps = Object.entries(COMPONENTS)
    .map(([name, c]) => `- ${name} { ${propsLine(c.props)} }: ${c.description}`)
    .join('\n')
  const actions = Object.entries(ACTIONS)
    .map(([name, a]) => `- ${name} [${a.tier}] { ${propsLine(a.params)} }: ${a.description}`)
    .join('\n')
  const sources = Object.entries(SOURCES)
    .map(([id, s]) => {
      const fields = Object.entries(s.fields).map(([f, m]) => `${f} (${m})`).join(', ')
      return `- ${id}${'needsWorkspace' in s && s.needsWorkspace ? ' [workspace-tab only]' : ''}, params { ${propsLine(s.params)} }: ${s.description}\n  rows: ${fields}`
    })
    .join('\n')
  return `# Sinfonie view catalog (version ${CATALOG_VERSION})

A view is { title, slot, icon?, sources, spec }.
- slot "home": a page on the Home screen. slot "workspace-tab": a tab inside every workspace (the view then knows its workspace).
- sources: { <name>: { source, params?, refreshSeconds? } }. Each lands at /data/<name> (array of rows) and /meta/<name> = { count, loading, error }.
- spec: json-render flat spec { root: "<key>", elements: { <key>: { type, props, children?: [keys], visible?, repeat?, on? } } }. Every child key must exist. Optional spec.state.ui seeds local UI state at /ui.

## State you can read
- /data/<source>, /meta/<source>/count|loading|error
- /context: spaceId, spaceName, workspaceId, workspaceName, branch (workspace-tab only), userName, today
- /ui/...: local state, written with the setState action

## Expressions (in any prop or action param)
- { "$state": "/path" } reads state. { "$item": "field" } reads the current repeat row. { "$index": true } the row index.
- { "$template": "\${repoName} #\${number} in \${/context/spaceName}" }: bare names read the repeat row, /paths read state.
- { "$cond": <condition>, "$then": x, "$else": y }.
- Lists: put "repeat": { "statePath": "/data/<source>", "key": "id" } on a List (or Column/Stack/Grid) and give it one child element; that child renders once per row and can use $item.
- Filtered lists (board lanes): repeat + "visible": { "$item": "lane", "eq": "todo" } on the same container.
- visible: { "$state": "/p" } truthy, { "$state": "/p", "eq"|"neq"|"gt"|"gte"|"lt"|"lte": v }, { "$item": "f", "eq": v }, "not": true, an array means AND, { "$or": [..] }.
- Events: "on": { "press": { "action": "<name>", "params": { ... } } } on Button, ListItem, Tile.

## Components
${comps}

## Actions (tier is fixed by Sinfonie: navigate runs at once, confirm asks once, outward asks and names what leaves the machine)
${actions}
- setState { statePath: "/ui/...", value }: local UI state (tabs, toggles).

## Data sources
${sources}

## Templates (ui_install_template, or read one with ui_get_template as an example)
${TEMPLATES.map((t) => `- ${t.id}: ${t.title}. ${t.description}`).join('\n')}

## Rules
- Only these components, actions and sources. No HTML, no styles, no code.
- Prefer small readable specs: a page Stack, a Grid of Cards, Lists with repeat.
- Every list gets emptyText with count bound to /meta/<source>/count.
- Hide buttons that do not apply to a row with visible (e.g. Merge only when mergeable).
- Element keys are short camelCase names (needsList, prRow).`
}
