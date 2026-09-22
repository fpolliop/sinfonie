# Generative views: Maestro adapts the Sinfonie UI

Status: phase 1 built (branch `generative-views`, 2026-09-21), not merged.

Verified in a dev run against a sanitized copy of the real store: gallery, Morning cockpit with 30 real
PRs (CI, review, Merge only when mergeable, Workspace/Fix links by branch), Branch panel tab on a real
workspace (per-repo ahead/behind, dirty, PR, CI), repeat + $item lanes (a stage board over `workspaces`),
the rebase confirmation (cancelled), the source error banner (Jira offline in the copy), and Maestro
adding a "Waiting for my review" card in one pass (ui_catalog → ui_get_view → ui_patch_view) with Undo.
Not verified: Ticket board with a live Jira/Linear, any outward action actually run (merge, push, open PRs),
createWorkspaceFromTicket, sharing a space view with a teammate, guided-mode Home.

## Goal

Every user can have Sinfonie reshaped for how they work. They describe what they want to Maestro,
or pick a template, and get views built from Sinfonie's own components, bound to live data
(workspaces, PRs, branches, tickets, usage), with buttons that act (open, start, fix, merge, push).

Decisions from the discussion:

- **For all users.** Templates are the entry point (guided users included); talking to Maestro is how
  you change them.
- **Views act.** Every action has a fixed risk tier (below). A spec can never lower it.
- **Two scopes.** Personal views (the user's settings) and space views (the space, shared with the team
  through the space definition). A user can fork a space view into a personal copy that replaces it
  for them, with "reset to team version".
- **Only in slots.** Sidebar, chat, code, review cockpit and terminal stay hand-built. Generated UI lives
  in: the **Home** page, and **custom workspace tabs**. (Sidebar widgets later.)
- **No generated code.** Specs are JSON limited to a catalog, rendered by
  [json-render](https://github.com/vercel-labs/json-render) (`@json-render/core` + `@json-render/react`, 0.21).

## Architecture

```
src/shared/views/
  catalog.ts     defineCatalog: components (zod props + descriptions) and actions (params, tier)
  sources.ts     data source ids, params, row shapes, which slot they need (workspace context)
  templates.ts   starter views: Morning cockpit, Branch panel, Ticket board
  validate.ts    catalog.validate + validateSpec + our own checks (sources exist, actions exist)
src/main/services/views/
  store.ts       CRUD on Settings.views / Space.views, history (undo), fork/reset
  data.ts        main-side sources: myPrs, reviewQueue, branchStatus, tickets
  actions.ts     main-side actions: mergePr, pushAll, rebaseAll, openPrsAll, createFromTicket
  tools.ts       Maestro tools (ui_*), appended to Maestro's tool list
src/renderer/src/components/views/
  registry.tsx   defineRegistry: our Tailwind implementations of the catalog
  ViewHost.tsx   resolves sources into state, wires action handlers + confirmations, renders
  HomeView.tsx   the Home page: tabs of views, template gallery, "Ask Maestro to change this"
```

### View record

```ts
interface ViewDef {
  id: string
  title: string
  slot: 'home' | 'workspace-tab'
  icon?: string
  spec: Spec                        // json-render flat spec: { root, elements, state? }
  sources: Record<string, { source: SourceId; params?: Record<string, unknown>; refreshSeconds?: number }>
  basedOn?: string                  // personal fork of a space view
  history?: { spec; sources; at; by }[]   // last 10, for undo
  createdAt, updatedAt, updatedBy: 'user' | 'maestro' | 'template'
}
Settings.views?: ViewDef[]          // personal, all spaces
Space.views?: ViewDef[]             // shared (added to SHARED_KEYS, travels with the space definition)
```

### Data binding

The host puts each declared source at `/data/<name>` in json-render state, plus
`/meta/<name>` = `{ count, loading, error, fetchedAt }`, and `/context` = `{ spaceId, workspaceId?, now }`.
Specs read with `$state`, list with `repeat: { statePath: "/data/<name>" }` and `$item`, filter columns
with `visible: { "$item": "status", "eq": "..." }`, show empty states with `/meta/<name>/count`.

Sources, v1:

| id | where | rows |
|---|---|---|
| `attention` | renderer | pending permissions/questions, agents that finished, workspaces in error |
| `workspaces` | renderer | id, name, space, stage, busy, branch, repos, ticket |
| `usage` | renderer | per account: name, percent, resetsIn; today's cost |
| `myPrs` | main (gh GraphQL) | repo, number, title, url, ci, review, mergeable, draft, workspaceId |
| `reviewQueue` | main (gh GraphQL) | PRs requesting my review |
| `branchStatus` | main | per repo of the context workspace: branch, ahead/behind, dirty, pr, ci |
| `tickets` | main (Jira/Linear) | key, title, status, statusCategory, url, workspaceId, workspaceState |

### Actions and tiers

| tier | behaviour | actions |
|---|---|---|
| navigate | runs at once | `openWorkspace`, `openUrl`, `openReview`, `refresh`, `askMaestro` |
| confirm | one confirmation dialog | `createWorkspaceFromTicket`, `fixWithAgent`, `sendToAgent`, `runScript`, `rebaseAll` |
| outward | a stronger confirmation that names what leaves the machine | `mergePr`, `pushAll`, `openPrsAll` |

Tiers live in the catalog (code), not in the spec. Handlers are in the renderer; main-side ones go
through `views:action` IPC, which re-checks the tier was confirmed.

### Maestro tools

`ui_catalog` (components, sources, actions, slots, rules; generated from the catalog), `ui_list_views`,
`ui_get_view`, `ui_save_view` (create/replace; validates and returns issues so Maestro repairs them),
`ui_patch_view` (merge elements / remove keys / change sources), `ui_undo_view`, `ui_delete_view`
(asks first), `ui_templates`, `ui_install_template`, `ui_open_view`. System prompt gets a short rule:
UI requests → `ui_catalog` first, prefer patching, open the view when done.

Every Maestro change records history; the view header shows "Changed by Maestro · Undo".

## Phases

1. **Foundation** (this PR)
   - deps, shared catalog/sources/validate, types, store + IPC (`views:*`)
   - renderer registry (~16 components), ViewHost with data + actions + confirmations
   - Home page (sidebar entry, per space: personal + space views, tabs, gallery) and workspace view tabs
   - main data sources + actions
   - three templates: Morning cockpit (home, personal), Branch panel (workspace tab, personal),
     Ticket board (home, space)
   - Maestro ui_* tools + prompt rule
   - typecheck, test templates validate, drive the app to see them render
2. **Polish**: fork/reset UX for shared views, edit mode (reorder/remove cards without Maestro),
   Maestro proactive offer ("you open PRs in 3 repos every morning…"), streaming preview while Maestro writes.
3. **More templates**: Team review queue, On-call board, Data watch (saved queries), Cost & crew,
   Simple home for guided users (Maestro is off in guided mode, so guided users get templates only).
4. **Sidebar widgets** slot; phone (mobile app) rendering the same specs with `@json-render/react-native`.

## Risks

- json-render is a Vercel Labs project at 0.x: pin the version; our catalog/data/actions are ours and a
  custom renderer could replace it.
- Catalog changes break saved specs: `catalogVersion` on each view; unknown components render a
  "this part needs an update, ask Maestro" fallback instead of crashing.
- Rate of GitHub/Jira calls: sources cache in main (30–120 s) and refresh on focus/explicit refresh.
