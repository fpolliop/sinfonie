/**
 * Guided New task: given what the person wants and the apps in their team's space, a fast Claude call picks
 * which apps the task needs and a short, friendly name. Runs on the Claude login (guided users have no API
 * keys). Falls back to every app and a slug when the model is unsure or unavailable.
 */
import { claudeExecutableOption } from './claude-cli'
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { getStore } from '../store'
import { accountEnv, defaultAccountId } from './accounts'
import * as usage from './usage'
import { logError } from './telemetry'

export interface TaskPlan {
  /** repo ids the task should include. */
  repoIds: string[]
  /** A short, friendly task name, e.g. "Bigger add-to-cart button". */
  name: string
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'A short, friendly task name in plain words, 2-6 words, no punctuation at the end.' },
    apps: { type: 'array', items: { type: 'string' }, description: 'The ids of the apps this task needs to change.' }
  },
  required: ['name', 'apps']
}

function slugName(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(' ')
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 60) || 'New task'
}

export async function planTask(spaceId: string, description: string): Promise<TaskPlan> {
  const { settings, repos, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === spaceId)
  const apps = repos.filter((r) => r.spaceId === spaceId)
  const fallback: TaskPlan = { repoIds: apps.map((r) => r.id), name: slugName(description) }
  if (apps.length <= 1 || !description.trim()) return { repoIds: apps.map((r) => r.id), name: slugName(description) }

  const list = apps.map((r) => `- id "${r.id}": ${r.displayName || r.name}${r.description ? ` — ${r.description}` : ''}`).join('\n')
  const prompt = [
    `A teammate who builds with AI wants to make this change:`,
    `"""${description.trim().slice(0, 2000)}"""`,
    ``,
    `These are the apps in their workspace:`,
    list,
    ``,
    `Pick the ids of the apps that this change needs to touch (usually one or two; include an app only if the change clearly involves it). If you truly cannot tell, return them all. Also write a short, friendly task name.`
  ].join('\n')

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 30_000)
  const options: Options = {
    ...claudeExecutableOption(),
    cwd: process.env.HOME ?? '/',
    model: 'haiku',
    maxTurns: 1,
    allowedTools: [],
    canUseTool: async (tool) => ({ behavior: 'deny', message: `${tool} is not needed; answer from the list.` }),
    abortController: abort,
    settingSources: [],
    outputFormat: { type: 'json_schema', schema: SCHEMA as unknown as Record<string, unknown> },
    env: { ...process.env, ...accountEnv(space?.claudeAccountId) }
  }
  try {
    let structured: unknown
    for await (const msg of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result') {
        try {
          usage.recordTurn(usage.fromResult(msg, { workspaceId: '', spaceId, accountId: space?.claudeAccountId ?? defaultAccountId('anthropic') ?? 'default', kind: 'suggest' }))
        } catch {
          /* ledger must never break planning */
        }
        if (msg.subtype === 'success') structured = msg.structured_output
      }
    }
    const s = (structured ?? {}) as { name?: string; apps?: string[] }
    const known = new Set(apps.map((r) => r.id))
    const picked = (s.apps ?? []).filter((id) => known.has(id))
    return {
      repoIds: picked.length ? picked : fallback.repoIds,
      name: (s.name || '').trim() ? slugName(s.name as string) : fallback.name
    }
  } catch (err) {
    logError('plan.planTask', err, { spaceId })
    return fallback
  } finally {
    clearTimeout(timer)
  }
}
