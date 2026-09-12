import { nanoid } from 'nanoid'
import type { AgentEvent, AgentRunEvent, AgentSpec, PermissionMode, Workspace } from '@shared/types'
import { getStore } from '../../store'
import { getWorkspace } from '../workspaces'
import * as resources from '../resources'
import * as agents from '../agents'
import { runWorker } from './workers'

/**
 * Agents run on their own, outside an orchestrator turn: from the editor's "Try it" pane
 * (progress goes to the agents:run channel) and from an @mention in the chat (progress goes
 * into the transcript like a delegation, followed by the report as the reply).
 */

let emitRun: (e: AgentRunEvent) => void = () => undefined
let emitChat: (e: AgentEvent) => void = () => undefined
let chatBusy: (workspaceId: string) => boolean = () => false

export function setRunEmitters(run: typeof emitRun, chat: typeof emitChat, busy: typeof chatBusy): void {
  emitRun = run
  emitChat = chat
  chatBusy = busy
}

const running = new Map<string, { abort: AbortController; workspaceId: string }>()
const invoking = new Set<string>()

function modeFor(ws: Workspace): PermissionMode {
  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === ws.spaceId)
  return ws.permissionMode ?? space?.permissionMode ?? settings.permissionMode
}

/** A run from the editor. Returns the run id at once; events follow on agents:run. */
export function start(agentId: string, workspaceId: string, prompt: string, override?: Partial<AgentSpec>): string {
  const base = agents.get(agentId)
  if (!base && !override?.name) throw new Error(`No agent ${agentId}`)
  const spec: AgentSpec = { ...(base ?? { id: agentId, name: '', description: '', prompt: '', model: 'sonnet', enabled: true }), ...override }
  if (!spec.name.trim()) throw new Error('Give the agent a name first.')
  const ws = getWorkspace(workspaceId)
  const runId = nanoid(8)
  const abort = new AbortController()
  running.set(runId, { abort, workspaceId })
  const started = Date.now()
  void runWorker({
    spec,
    ws,
    prompt,
    mode: modeFor(ws),
    signal: abort.signal,
    onStep: (step, model) => emitRun({ runId, type: 'step', step, model })
  })
    .then((report) => emitRun({ runId, type: 'done', report, durationMs: Date.now() - started }))
    .catch((err) => emitRun({ runId, type: 'error', message: abort.signal.aborted ? 'Stopped.' : err instanceof Error ? err.message : String(err) }))
    .finally(() => running.delete(runId))
  return runId
}

export function cancel(runId: string): void {
  running.get(runId)?.abort.abort()
}

/** "@name do this": run the agent in the workspace and write the exchange into the chat. */
export async function invoke(workspaceId: string, agentId: string, prompt: string, originalText: string): Promise<void> {
  const ws = getWorkspace(workspaceId)
  const spec = agents.get(agentId)
  if (!spec) throw new Error(`No agent ${agentId}`)
  if (chatBusy(workspaceId) || invoking.has(workspaceId)) throw new Error('Wait for the current turn to finish before mentioning an agent.')
  const veto = resources.delegationVeto(workspaceId)
  if (veto) throw new Error(veto)
  const crewModel = agents.crewFor(ws.spaceId).find((a) => a.id === spec.id)?.model
  const run: AgentSpec = crewModel ? { ...spec, model: crewModel } : spec
  const now = new Date().toISOString()
  const itemId = nanoid(8)
  const toolUseId = `mention-${nanoid(8)}`
  const taskId = `mention-${toolUseId}`
  invoking.add(workspaceId)
  emitChat({ type: 'user_message', workspaceId, itemId: nanoid(8), text: originalText, createdAt: now })
  emitChat({ type: 'status', workspaceId, busy: true })
  emitChat({ type: 'assistant_start', workspaceId, itemId })
  emitChat({ type: 'tool_start', workspaceId, itemId, toolUseId, name: 'Agent' })
  emitChat({ type: 'tool_input', workspaceId, itemId, toolUseId, input: { subagent_type: run.name, description: `@${run.name}`, prompt } })
  resources.taskStarted(workspaceId, { taskId, toolUseId, description: run.name, startedAt: now })
  const started = Date.now()
  const abort = new AbortController()
  running.set(taskId, { abort, workspaceId })
  let isError = false
  let errorText: string | undefined
  try {
    const report = await runWorker({
      spec: run,
      ws,
      prompt,
      mode: modeFor(ws),
      signal: abort.signal,
      onStep: (step, model) => emitChat({ type: 'subagent', workspaceId, parentToolUseId: toolUseId, model, tools: step.kind === 'tool' ? [step.name ?? ''] : [], steps: [step], ...(step.kind === 'text' ? { text: step.detail.slice(0, 400) } : {}) })
    })
    emitChat({ type: 'tool_result', workspaceId, toolUseId, result: report, isError: false })
    emitChat({ type: 'text_delta', workspaceId, itemId, text: report })
  } catch (err) {
    isError = true
    errorText = abort.signal.aborted ? 'Stopped.' : err instanceof Error ? err.message : String(err)
    emitChat({ type: 'tool_result', workspaceId, toolUseId, result: errorText, isError: true })
    emitChat({ type: 'text_delta', workspaceId, itemId, text: `@${run.name} failed: ${errorText}` })
  } finally {
    running.delete(taskId)
    invoking.delete(workspaceId)
    resources.taskEnded(workspaceId, taskId)
    emitChat({ type: 'assistant_end', workspaceId, itemId })
    emitChat({ type: 'result', result: { workspaceId, costUsd: 0, durationMs: Date.now() - started, numTurns: 1, isError, errorText } })
    emitChat({ type: 'status', workspaceId, busy: false })
  }
}

/** Stop an @mention run in a workspace, if one is going. */
export function interrupt(workspaceId: string): boolean {
  let hit = false
  for (const [id, r] of running) {
    if (id.startsWith('mention-') && r.workspaceId === workspaceId) {
      r.abort.abort()
      hit = true
    }
  }
  return hit
}

/** "@name rest of message" at the start of a message; null when the message is not a mention. */
export function parseMention(text: string, spaceId?: string): { agent: AgentSpec; prompt: string } | null {
  const m = /^@([A-Za-z0-9][A-Za-z0-9_-]*)\s*([\s\S]*)$/.exec(text.trim())
  if (!m) return null
  const agent = agents.byName(m[1], spaceId)
  if (!agent) return null
  return { agent, prompt: m[2].trim() || 'Do what your description says for this workspace and report back.' }
}
