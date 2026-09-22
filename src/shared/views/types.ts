/**
 * Generative views: pages and workspace tabs built from a JSON spec that Maestro (or a template)
 * writes, limited to the catalog in ./catalog, rendered by json-render, fed by ./sources.
 */

/** Where a view lives. */
export type ViewSlot = 'home' | 'workspace-tab'

/** json-render's flat spec: a root key and a map of elements. `state.ui` may seed local UI state. */
export interface ViewSpec {
  root: string
  elements: Record<string, ViewElement>
  state?: { ui?: Record<string, unknown> }
}
export interface ViewElement {
  type: string
  props?: Record<string, unknown>
  children?: string[]
  visible?: unknown
  repeat?: { statePath: string | { $item: string }; key?: string }
  on?: Record<string, ViewActionBinding | ViewActionBinding[]>
}
export interface ViewActionBinding {
  action: string
  params?: Record<string, unknown>
}

/** A data source bound into a view's state at /data/<name>. */
export interface ViewSourceBinding {
  source: string
  params?: Record<string, unknown>
  /** How often to refetch while the view is visible; default per source. */
  refreshSeconds?: number
}

export interface ViewHistoryEntry {
  title: string
  spec: ViewSpec
  sources: Record<string, ViewSourceBinding>
  at: string
  by: ViewAuthor
}
export type ViewAuthor = 'user' | 'maestro' | 'template'

export interface ViewDef {
  id: string
  title: string
  slot: ViewSlot
  /** A lucide icon name from VIEW_ICONS. */
  icon?: string
  spec: ViewSpec
  sources: Record<string, ViewSourceBinding>
  /** Catalog version the spec was written against. */
  catalogVersion: number
  /** The template it started from, if any. */
  template?: string
  /** A personal copy of this space view: it replaces the team's for this user. */
  basedOn?: string
  /** Earlier versions, newest last, for undo. */
  history?: ViewHistoryEntry[]
  createdAt: string
  updatedAt: string
  updatedBy: ViewAuthor
}

/** Where a view is stored: the user's settings, or a space (shared with the space's team). */
export type ViewScope = { kind: 'user' } | { kind: 'space'; spaceId: string }

/** A view with where it came from, as lists hand it to the renderer. */
export interface ScopedView extends ViewDef {
  scope: ViewScope
}

/** Input to create or replace a view. */
export interface ViewInput {
  id?: string
  title: string
  slot: ViewSlot
  icon?: string
  spec: ViewSpec
  sources: Record<string, ViewSourceBinding>
  template?: string
  basedOn?: string
}

/** One problem found in a spec; Maestro gets these back and fixes the spec. */
export interface ViewIssue {
  path: string
  message: string
}

/** Main-side data for one source binding. */
export interface ViewDataResult {
  rows: unknown[]
  error?: string
  fetchedAt: string
}
