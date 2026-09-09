/**
 * Guided mode: the app for people who build with AI without writing code. One setting decides it, every
 * surface asks this module, and the words come from one map so the expert vocabulary never leaks through.
 */
import { WORKSPACE_STAGES, type Workspace, type WorkspaceStage } from '@shared/types'
import { useApp } from '@/stores/app'

/**
 * Where a workspace's app serves, for the Preview tab: the primary repo's preview URL from its sinfonie.json
 * with ${PORT}/$PORT expanded to the workspace's port, falling back to plain localhost:port.
 */
export function previewUrlFor(ws: Workspace | undefined): string {
  if (!ws) return ''
  const repos = useApp.getState().repos
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const tmpl = primary && repos.find((r) => r.id === primary.repoId)?.config?.preview
  const base = `http://localhost:${ws.port}`
  if (!tmpl) return base
  return tmpl.replace(/\$\{PORT\}/g, String(ws.port)).replace(/\$PORT\b/g, String(ws.port))
}

export const useGuided = (): boolean => useApp((s) => s.settings.mode === 'guided')

export const isGuided = (): boolean => useApp.getState().settings.mode === 'guided'

/** Stage labels in guided words: the same four stages, seen from the person's side. */
const GUIDED_STAGES: Record<WorkspaceStage, string> = { todo: 'Not started', 'in-progress': 'Working', 'in-review': 'Waiting for review', done: 'Live' }

export function stageLabel(stage: WorkspaceStage | undefined, guided: boolean): string {
  if (!stage) return ''
  if (guided) return GUIDED_STAGES[stage] ?? stage
  return WORKSPACE_STAGES.find((s) => s.id === stage)?.label ?? stage
}

export const stages = (guided: boolean): { id: WorkspaceStage; label: string }[] => WORKSPACE_STAGES.map((s) => ({ id: s.id, label: stageLabel(s.id, guided) }))

interface Words {
  workspace: string
  workspaces: string
  newWorkspace: string
  space: string
  spaces: string
  repo: string
  repos: string
  archive: string
  browser: string
  chat: string
  agent: string
  sendForReview: string
  composerPlaceholder: string
}

const EXPERT: Words = {
  workspace: 'workspace',
  workspaces: 'workspaces',
  newWorkspace: 'New workspace',
  space: 'space',
  spaces: 'spaces',
  repo: 'repository',
  repos: 'repositories',
  archive: 'Archive',
  browser: 'Browser',
  chat: 'Chat',
  agent: 'the agent',
  sendForReview: 'Open pull request',
  composerPlaceholder: 'Describe the change across your repos… (Enter to send, Shift+Enter for newline, paste or drop images)'
}

const GUIDED: Words = {
  workspace: 'task',
  workspaces: 'tasks',
  newWorkspace: 'New task',
  space: 'team',
  spaces: 'teams',
  repo: 'app',
  repos: 'apps',
  archive: 'Finish',
  browser: 'Preview',
  chat: 'Chat',
  agent: 'the assistant',
  sendForReview: 'Send for review',
  composerPlaceholder: 'What should change? (Enter to send, Shift+Enter for a new line, paste or drop images)'
}

export const words = (guided: boolean): Words => (guided ? GUIDED : EXPERT)

export const useWords = (): Words => words(useGuided())

/** Capitalises the first letter, for a word used at the start of a label. */
export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
