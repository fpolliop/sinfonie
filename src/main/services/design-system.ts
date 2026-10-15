/**
 * Claude Design, phase 2: a space's design system.
 *
 * `DesignSync` (the Claude Code tool behind /design-sync) works from Agent SDK sessions once the person
 * has run `/design-login` in an interactive Claude Code session. Sinfonie checks that with a small,
 * read-only probe (a short Haiku turn that only calls `list_projects`), and syncs by asking a workspace's
 * agent to run the design-sync flow: it proposes a plan of files and writes nothing until the person
 * approves it (DesignSync's finalize_plan enforces that).
 */
import os from 'os'
import { query, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { DesignSystemProbe, SpaceDesignSystem } from '@shared/types'
import { getStore } from '../store'
import { claudeExecutableOption } from './claude-cli'
import { accountEnv } from './accounts'

const PROBE_TTL = 5 * 60_000
let last: DesignSystemProbe | null = null
let running: Promise<DesignSystemProbe> | null = null

/** DesignSync's answer when /design-login has not been run on this Mac (2026-10-10 spike). */
const UNAUTHORIZED = /design-system authorization|\/design-login/i

function parse(text: string): DesignSystemProbe {
  const at = new Date().toISOString()
  if (UNAUTHORIZED.test(text)) return { authorized: false, projects: [], checkedAt: at, error: 'Claude Design is not authorized on this Mac yet.' }
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  try {
    const d = JSON.parse(json ?? '') as { projects?: { id?: string; projectId?: string; name?: string; title?: string }[] }
    const projects = (d.projects ?? []).map((p) => ({ id: String(p.id ?? p.projectId ?? ''), name: String(p.name ?? p.title ?? p.id ?? 'Untitled') })).filter((p) => p.id)
    return { authorized: true, projects, checkedAt: at }
  } catch {
    return { authorized: false, projects: [], checkedAt: at, error: text.trim().slice(0, 300) || 'Claude Design did not answer.' }
  }
}

async function run(): Promise<DesignSystemProbe> {
  const deny = async (): Promise<PermissionResult> => ({ behavior: 'deny', message: 'Only DesignSync list_projects is allowed in this check.' })
  const q = query({
    prompt:
      'Load the DesignSync tool (ToolSearch "select:DesignSync") and call it once with {"method":"list_projects"}. Do nothing else. Reply with only the raw JSON it returned. If it returns an error, reply with "ERROR: " and its exact text.',
    options: {
      ...claudeExecutableOption(),
      cwd: os.tmpdir(),
      model: 'haiku',
      maxTurns: 4,
      settingSources: [],
      allowedTools: ['ToolSearch', 'DesignSync'],
      canUseTool: deny,
      env: { ...process.env, ...accountEnv(undefined) }
    }
  })
  let text = ''
  for await (const m of q) {
    if (m.type === 'user') {
      // The tool result itself is the most faithful answer (the model may paraphrase it).
      for (const b of (m.message.content as { type: string; content?: unknown }[]) ?? []) {
        if (b.type === 'tool_result') {
          const c = b.content
          const t = typeof c === 'string' ? c : Array.isArray(c) ? (c as { text?: string }[]).map((x) => x.text ?? '').join('') : ''
          if (/list_projects|design-system authorization|design-login/i.test(t)) text = t
        }
      }
    }
    if (m.type === 'result' && !text) text = m.subtype === 'success' ? m.result : (m as { errors?: string[] }).errors?.join('; ') ?? ''
  }
  return parse(text)
}

/** The last check this app run, if any (the settings page shows it without asking again). */
export function lastProbe(): DesignSystemProbe | null {
  return last
}

/** Whether Claude Design is authorized here, and the design-system projects it can write to (cached 5 minutes). */
export async function probe(force = false): Promise<DesignSystemProbe> {
  if (!force && last && Date.now() - Date.parse(last.checkedAt) < PROBE_TTL) return last
  running ??= run()
    .catch((err) => ({ authorized: false, projects: [], checkedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) }))
    .then((r) => (last = r))
    .finally(() => (running = null))
  return running
}

export function save(spaceId: string, ds: SpaceDesignSystem): void {
  getStore().update((d) => {
    const s = d.spaces.find((x) => x.id === spaceId)
    if (!s) throw new Error('Unknown space')
    s.designSystem = { ...s.designSystem, ...ds }
  })
}

/** The message that asks a workspace's agent to sync the space's component library with Claude Design. */
export function syncPrompt(spaceId: string): string {
  const { spaces, repos } = getStore().get()
  const space = spaces.find((s) => s.id === spaceId)
  const ds = space?.designSystem
  if (!space || !ds?.repoId) throw new Error('Pick the repository with the component library first.')
  const repo = repos.find((r) => r.id === ds.repoId)
  const target = ds.projectId ? `the existing design-system project "${ds.projectName ?? ds.projectId}" (id ${ds.projectId})` : `a new design-system project named "${space.name}"`
  return [
    `Sync this space's design system with Claude Design, using the DesignSync tool (load it with ToolSearch "select:DesignSync").`,
    `Component library: the ${repo?.name ?? 'selected'} repository${ds.folder ? `, folder ${ds.folder}` : ''}. Target: ${target}.`,
    'Follow the design-sync flow: read the components, propose the plan of files to write, show it to me, and call finalize_plan only after I approve it here. Never write anything to Claude Design without my approval. If DesignSync says it needs authorization, stop and tell me to run /design-login in Claude Code.',
    ds.lastSyncAt ? `The last sync was ${ds.lastSyncAt}; only update components that changed since then, never replace the whole project.` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export function markSynced(spaceId: string): void {
  save(spaceId, { lastSyncAt: new Date().toISOString() })
}
