/**
 * The catalog of what a generated view may contain: components (with zod props) and actions (with
 * params and a fixed risk tier). Shared by main (Maestro's docs, validation) and the renderer
 * (json-render registry). Bump CATALOG_VERSION when a change would break saved specs.
 */
import { z } from 'zod'
import { defineCatalog } from '@json-render/core'
import { schema } from '@json-render/react/schema'

export const CATALOG_VERSION = 1

const tone = z.enum(['default', 'muted', 'accent', 'ok', 'warn', 'danger'])
const gap = z.enum(['none', 'xs', 'sm', 'md', 'lg'])

/** Icons a view may name (lucide). Kept small so specs stay portable. */
export const VIEW_ICONS = [
  'layout-dashboard', 'sun', 'git-branch', 'git-pull-request', 'git-merge', 'kanban', 'ticket', 'bell', 'alert-triangle', 'check', 'x',
  'play', 'upload', 'refresh-cw', 'external-link', 'wand', 'wrench', 'message-square', 'folder', 'eye', 'gauge', 'clock', 'plus', 'arrow-right', 'database', 'activity'
] as const
const icon = z.enum(VIEW_ICONS)

export const COMPONENTS = {
  Stack: {
    props: z.object({
      direction: z.enum(['column', 'row']).optional(),
      gap: gap.optional(),
      align: z.enum(['start', 'center', 'end', 'stretch']).optional(),
      justify: z.enum(['start', 'center', 'end', 'between']).optional(),
      wrap: z.boolean().optional()
    }),
    description: 'Lays out its children in a column (default) or a row. The basic building block.'
  },
  Grid: {
    props: z.object({ columns: z.number().int().min(1).max(4), gap: gap.optional() }),
    description: 'Responsive grid of its children (cards, metrics). Collapses to fewer columns when narrow.'
  },
  Card: {
    props: z.object({ title: z.string().optional(), subtitle: z.string().optional(), icon: icon.optional(), tone: tone.optional(), span: z.number().int().min(1).max(4).optional() }),
    description: 'A panel with an optional title row. span = how many Grid columns it takes. Children go in the body.'
  },
  Heading: {
    props: z.object({ text: z.string(), level: z.number().int().min(1).max(3).optional() }),
    description: 'A heading. level 1 is the page title.'
  },
  Text: {
    props: z.object({ text: z.string(), tone: tone.optional(), size: z.enum(['xs', 'sm', 'md', 'lg']).optional(), mono: z.boolean().optional(), truncate: z.boolean().optional() }),
    description: 'A line or paragraph of text.'
  },
  Badge: {
    props: z.object({ label: z.string(), tone: tone.optional() }),
    description: 'A small pill label (status, count, repo name).'
  },
  Status: {
    props: z.object({ status: z.string(), label: z.string().optional() }),
    description:
      'A colored dot with an optional label. status: success | failure | pending | running | waiting | error | none (any other value shows grey). Use for CI and agent state.'
  },
  Metric: {
    props: z.object({ label: z.string(), value: z.union([z.string(), z.number()]), hint: z.string().optional(), tone: tone.optional() }),
    description: 'A big number with a label, for KPIs and counts.'
  },
  Meter: {
    props: z.object({ label: z.string(), value: z.number(), hint: z.string().optional() }),
    description: 'A horizontal bar from 0 to 100 (turns amber at 80, red at 95). For usage windows.'
  },
  List: {
    props: z.object({ emptyText: z.string().optional(), count: z.number().optional(), divided: z.boolean().optional() }),
    description:
      'A vertical list. Put `repeat` on it with a ListItem child to render one row per item. Bind count to /meta/<source>/count so emptyText shows when there are none.'
  },
  ListItem: {
    props: z.object({ title: z.string(), subtitle: z.string().optional(), meta: z.string().optional(), status: z.string().optional(), icon: icon.optional() }),
    description:
      'A row: optional status dot or icon, title, subtitle, meta on the right, then its children (badges, buttons) at the end. Emits "press" when the row is clicked.'
  },
  Column: {
    props: z.object({ title: z.string(), count: z.number().optional(), tone: tone.optional() }),
    description: 'A board column (kanban lane) with a header and count. Put several in a Stack row; filter each with repeat + visible $item.'
  },
  Tile: {
    props: z.object({ title: z.string(), subtitle: z.string().optional(), meta: z.string().optional(), status: z.string().optional() }),
    description: 'A compact card for boards (a ticket, a workspace). Children (buttons, badges) sit at the bottom. Emits "press".'
  },
  Button: {
    props: z.object({ label: z.string(), variant: z.enum(['primary', 'subtle', 'ghost', 'danger']).optional(), icon: icon.optional(), size: z.enum(['sm', 'md']).optional() }),
    description: 'A button. Emits "press"; bind it with on.press to an action.'
  },
  Divider: { props: z.object({}), description: 'A thin horizontal rule.' },
  Empty: {
    props: z.object({ text: z.string(), hint: z.string().optional(), icon: icon.optional() }),
    description: 'A friendly empty state.'
  }
} as const

export type ActionTier = 'navigate' | 'confirm' | 'outward'

export const ACTIONS = {
  openWorkspace: { tier: 'navigate', params: z.object({ workspaceId: z.string() }), description: 'Open a workspace (its chat).' },
  openWorkspaceTab: { tier: 'navigate', params: z.object({ workspaceId: z.string(), tab: z.enum(['chat', 'code', 'prs', 'terminal', 'run', 'browser', 'data']) }), description: 'Open a workspace on a given tab.' },
  openUrl: { tier: 'navigate', params: z.object({ url: z.string() }), description: 'Open a link in the default browser (PR, ticket, CI run).' },
  refresh: { tier: 'navigate', params: z.object({ source: z.string().optional() }), description: 'Refetch one data source (by its name in the view) or all of them.' },
  askMaestro: { tier: 'navigate', params: z.object({ prompt: z.string() }), description: 'Open Maestro with this message ready to send.' },
  openIncident: { tier: 'navigate', params: z.object({ incidentId: z.string() }), description: 'Open an incident in the On call view.' },
  triageIncident: { tier: 'confirm', params: z.object({ incidentId: z.string() }), description: 'Run the on-call agent\'s read-only triage on an incident (costs a few cents).' },
  newWorkspace: { tier: 'navigate', params: z.object({ spaceId: z.string().optional() }), description: 'Open the New workspace dialog.' },
  createWorkspaceFromTicket: {
    tier: 'confirm',
    params: z.object({ key: z.string(), title: z.string(), url: z.string().optional(), provider: z.enum(['jira', 'linear']), id: z.string().optional(), spaceId: z.string().optional() }),
    description: "Start a workspace for a ticket (no worktrees yet; the agent adds the repos it needs). Pass the ticket row's key, title, url, provider and id."
  },
  sendToAgent: { tier: 'confirm', params: z.object({ workspaceId: z.string(), text: z.string() }), description: "Send a message to a workspace's agent, as if typed in its chat." },
  fixWithAgent: {
    tier: 'confirm',
    params: z.object({ workspaceId: z.string(), number: z.number().optional(), repo: z.string().optional(), what: z.string().optional() }),
    description: "Ask the workspace's agent to fix its PR: failing CI by default, or `what`."
  },
  runScript: { tier: 'confirm', params: z.object({ workspaceId: z.string(), kind: z.enum(['setup', 'run']) }), description: "Run the workspace's setup or run script." },
  rebaseAll: { tier: 'confirm', params: z.object({ workspaceId: z.string() }), description: "Fetch and rebase every repo of the workspace onto its base branch (stops on conflicts; nothing is pushed)." },
  pushAll: { tier: 'outward', params: z.object({ workspaceId: z.string() }), description: 'Push every repo of the workspace that has commits to push.' },
  openPrsAll: { tier: 'outward', params: z.object({ workspaceId: z.string(), draft: z.boolean().optional() }), description: 'Open a pull request in every repo of the workspace that has pushed commits and no PR yet.' },
  mergePr: { tier: 'outward', params: z.object({ repo: z.string(), number: z.number(), method: z.enum(['squash', 'merge', 'rebase']).optional() }), description: 'Merge a pull request on GitHub (repo = owner/name). Squash by default.' }
} as const satisfies Record<string, { tier: ActionTier; params: z.ZodObject; description: string }>

export type ActionName = keyof typeof ACTIONS
export type ComponentName = keyof typeof COMPONENTS

export const catalog = defineCatalog(schema, {
  components: COMPONENTS,
  actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, { params: a.params, description: a.description }])) as { [K in ActionName]: { params: (typeof ACTIONS)[K]['params']; description: string } }
})

/** Actions json-render handles itself (local UI state). */
export const BUILTIN_ACTIONS = ['setState', 'pushState', 'removeState'] as const
