import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import type { AgentEvent, AgentRun, AgentRunEvent, AgentSpec, PermissionMode, Workspace } from '@shared/types'
import { agentOwner, isAgentOwner } from '@shared/types'
import { getStore } from '../../store'
import { effectivePermissionMode } from '../permission-mode'
import { getWorkspace } from '../workspaces'
import { getTranscript } from '../transcripts'
import * as resources from '../resources'
import * as agents from '../agents'
import { runWorker } from './workers'

/**
 * Agents run on their own, outside an orchestrator turn: from the editor's "Try it" pane
 * (progress goes to the agents:run channel), from an @mention in a workspace chat, from the
 * agent's own conversation, or from its schedule. The last three write into a transcript like
 * a delegation followed by the report; every run is also kept in the agent's history.
 */

let emitRun: (e: AgentRunEvent) => void = () => undefined
let emitChat: (e: AgentEvent) => void = () => undefined
let emitRuns: (agentId: string, runs: AgentRun[]) => void = () => undefined
let chatBusy: (workspaceId: string) => boolean = () => false

export function setRunEmitters(run: typeof emitRun, chat: typeof emitChat, runsChanged: typeof emitRuns, busy: typeof chatBusy): void {
  emitRun = run
  emitChat = chat
  emitRuns = runsChanged
  chatBusy = busy
}

const running = new Map<string, { abort: AbortController; workspaceId: string }>()
const invoking = new Set<string>()

/** True while an agent's own conversation or a mention in a workspace is running. */
export function isBusy(workspaceId: string): boolean {
  return invoking.has(workspaceId)
}

function modeFor(ws: Workspace): PermissionMode {
  const { settings, spaces } = getStore().get()
  return effectivePermissionMode(ws, spaces.find((s) => s.id === ws.spaceId), settings)
}

// ---------- the agent's own context: no repos, a folder of its own ----------

function runsDir(agentId: string): string {
  const d = join(app.getPath('userData'), 'agent-runs', agentId)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

/** A workspace-shaped context for an agent that runs without a code workspace. */
export function contextFor(spec: AgentSpec): Workspace {
  const now = new Date().toISOString()
  return {
    id: agentOwner(spec.id),
    name: spec.name,
    slug: spec.name,
    rootPath: runsDir(spec.id),
    repos: [],
    primaryRepoId: '',
    port: 0,
    status: 'ready',
    createdAt: spec.createdAt ?? now,
    stage: 'in-progress',
    ...(spec.scope ? { spaceId: spec.scope } : {}),
    ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {})
  }
}

function contextOf(spec: AgentSpec, workspaceId: string | null | undefined): Workspace {
  return workspaceId && !isAgentOwner(workspaceId) ? getWorkspace(workspaceId) : contextFor(spec)
}

// ---------- history ----------

const historyCache = new Map<string, AgentRun[]>()
const historyFile = (agentId: string): string => join(runsDir(agentId), 'history.json')

export function runs(agentId: string): AgentRun[] {
  const hit = historyCache.get(agentId)
  if (hit) return hit
  let list: AgentRun[] = []
  try {
    if (existsSync(historyFile(agentId))) list = JSON.parse(readFileSync(historyFile(agentId), 'utf8')) as AgentRun[]
  } catch {
    list = []
  }
  historyCache.set(agentId, list)
  return list
}

function record(agentId: string, run: AgentRun): void {
  const list = [run, ...runs(agentId).filter((r) => r.id !== run.id)].slice(0, 200)
  historyCache.set(agentId, list)
  writeFileSync(historyFile(agentId), JSON.stringify(list, null, 2))
  emitRuns(agentId, list)
}

/** The last run that finished, of one trigger kind or any. */
export function lastRun(agentId: string, trigger?: AgentRun['trigger']): AgentRun | undefined {
  return runs(agentId).find((r) => r.endedAt && (!trigger || r.trigger === trigger))
}

// ---------- Try it: progress to the editor ----------

export function start(agentId: string, workspaceId: string | null, prompt: string, override?: Partial<AgentSpec>): string {
  const base = agents.get(agentId)
  if (!base && !override?.name) throw new Error(`No agent ${agentId}`)
  const spec: AgentSpec = { ...(base ?? { id: agentId || 'draft', name: '', description: '', prompt: '', model: 'sonnet', enabled: true }), ...override }
  if (!spec.name.trim()) throw new Error('Give the agent a name first.')
  const ws = contextOf(spec, workspaceId)
  const runId = nanoid(8)
  const abort = new AbortController()
  running.set(runId, { abort, workspaceId: ws.id })
  const started = new Date()
  const entry: AgentRun = { id: runId, trigger: 'manual', startedAt: started.toISOString(), prompt, ...(workspaceId ? { workspaceId } : {}) }
  if (base) record(base.id, entry)
  void runWorker({
    spec,
    ws,
    prompt,
    mode: modeFor(ws),
    signal: abort.signal,
    onStep: (step, model) => emitRun({ runId, type: 'step', step, model })
  })
    .then((report) => {
      emitRun({ runId, type: 'done', report, durationMs: Date.now() - started.getTime() })
      if (base) record(base.id, { ...entry, endedAt: new Date().toISOString(), report })
    })
    .catch((err) => {
      const message = abort.signal.aborted ? 'Stopped.' : err instanceof Error ? err.message : String(err)
      emitRun({ runId, type: 'error', message })
      if (base) record(base.id, { ...entry, endedAt: new Date().toISOString(), error: message })
    })
    .finally(() => running.delete(runId))
  return runId
}

export function cancel(runId: string): void {
  running.get(runId)?.abort.abort()
}

// ---------- runs that live in a transcript: mentions, the agent's chat, schedules ----------

interface TranscriptRun {
  spec: AgentSpec
  ws: Workspace
  /** Transcript the exchange is written to: the workspace, or the agent's own. */
  owner: string
  prompt: string
  /** What the user item shows. */
  shown: string
  trigger: AgentRun['trigger']
}

async function runInTranscript(t: TranscriptRun): Promise<void> {
  const { spec, ws, owner, prompt, trigger } = t
  if (chatBusy(owner) || invoking.has(owner)) throw new Error(trigger === 'schedule' ? 'The agent is already running.' : 'Wait for the current turn to finish first.')
  const veto = resources.delegationVeto(owner)
  if (veto) throw new Error(veto)
  const now = new Date().toISOString()
  const itemId = nanoid(8)
  const toolUseId = `mention-${nanoid(8)}`
  const taskId = `mention-${toolUseId}`
  const entry: AgentRun = { id: nanoid(8), trigger, startedAt: now, prompt, ...(isAgentOwner(ws.id) ? {} : { workspaceId: ws.id }) }
  invoking.add(owner)
  record(spec.id, entry)
  emitChat({ type: 'user_message', workspaceId: owner, itemId: nanoid(8), text: t.shown, createdAt: now })
  emitChat({ type: 'status', workspaceId: owner, busy: true })
  emitChat({ type: 'assistant_start', workspaceId: owner, itemId })
  emitChat({ type: 'tool_start', workspaceId: owner, itemId, toolUseId, name: 'Agent' })
  emitChat({ type: 'tool_input', workspaceId: owner, itemId, toolUseId, input: { subagent_type: spec.name, description: trigger === 'schedule' ? 'scheduled run' : `@${spec.name}`, prompt } })
  resources.taskStarted(owner, { taskId, toolUseId, description: spec.name, startedAt: now })
  const started = Date.now()
  const abort = new AbortController()
  running.set(taskId, { abort, workspaceId: owner })
  let isError = false
  let errorText: string | undefined
  try {
    const report = await runWorker({
      spec,
      ws,
      prompt,
      mode: modeFor(ws),
      signal: abort.signal,
      onStep: (step, model) => emitChat({ type: 'subagent', workspaceId: owner, parentToolUseId: toolUseId, model, tools: step.kind === 'tool' ? [step.name ?? ''] : [], steps: [step], ...(step.kind === 'text' ? { text: step.detail.slice(0, 400) } : {}) })
    })
    emitChat({ type: 'tool_result', workspaceId: owner, toolUseId, result: report, isError: false })
    emitChat({ type: 'text_delta', workspaceId: owner, itemId, text: report })
    record(spec.id, { ...entry, endedAt: new Date().toISOString(), report })
  } catch (err) {
    isError = true
    errorText = abort.signal.aborted ? 'Stopped.' : err instanceof Error ? err.message : String(err)
    emitChat({ type: 'tool_result', workspaceId: owner, toolUseId, result: errorText, isError: true })
    emitChat({ type: 'text_delta', workspaceId: owner, itemId, text: `@${spec.name} failed: ${errorText}` })
    record(spec.id, { ...entry, endedAt: new Date().toISOString(), error: errorText })
  } finally {
    running.delete(taskId)
    invoking.delete(owner)
    resources.taskEnded(owner, taskId)
    emitChat({ type: 'assistant_end', workspaceId: owner, itemId })
    emitChat({ type: 'result', result: { workspaceId: owner, costUsd: 0, durationMs: Date.now() - started, numTurns: 1, isError, errorText } })
    emitChat({ type: 'status', workspaceId: owner, busy: false })
  }
}

/** "@name do this" in a workspace chat. */
export async function invoke(workspaceId: string, agentId: string, prompt: string, originalText: string): Promise<void> {
  const ws = getWorkspace(workspaceId)
  const spec = agents.get(agentId)
  if (!spec) throw new Error(`No agent ${agentId}`)
  const crewModel = agents.crewFor(ws.spaceId).find((a) => a.id === spec.id)?.model
  await runInTranscript({ spec: crewModel ? { ...spec, model: crewModel } : spec, ws, owner: workspaceId, prompt, shown: originalText, trigger: 'mention' })
}

/** The last few turns of the agent's own conversation, so a one-shot run keeps the thread. */
function recentHistory(owner: string, limit = 8): string {
  const items = getTranscript(owner).filter((it) => it.role === 'user' || it.role === 'assistant')
  const turns = items.slice(-limit * 2).map((it) => {
    const text = it.blocks
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim()
    return text ? `${it.role === 'user' ? 'User' : 'You'}: ${text.slice(0, 1500)}` : ''
  })
  const lines = turns.filter(Boolean)
  return lines.length ? `Earlier in this conversation:\n${lines.join('\n\n')}\n\n` : ''
}

/** A turn in the agent's own conversation (no workspace). */
export async function chat(agentId: string, text: string): Promise<void> {
  const spec = agents.get(agentId)
  if (!spec) throw new Error(`No agent ${agentId}`)
  const owner = agentOwner(agentId)
  await runInTranscript({ spec, ws: contextFor(spec), owner, prompt: `${recentHistory(owner)}Now the user says:\n${text}`, shown: text, trigger: 'chat' })
}

/** The standing task, as the schedule (or "Run now") starts it; the exchange lands in the agent's conversation. */
export async function scheduled(agentId: string, trigger: 'schedule' | 'manual' = 'schedule'): Promise<void> {
  const spec = agents.get(agentId)
  if (!spec) throw new Error(`No agent ${agentId}`)
  const owner = agentOwner(agentId)
  const task = spec.schedule?.prompt?.trim() || 'Do what your description says.'
  const prev = lastRun(agentId)
  const prompt = `${prev ? `Your previous run started at ${prev.startedAt}${prev.report ? ` and reported:\n${prev.report.slice(0, 1500)}` : ''}.\n\n` : 'This is your first run.\n\n'}Task:\n${task}`
  await runInTranscript({ spec, ws: contextFor(spec), owner, prompt, shown: `${trigger === 'schedule' ? '⏰ Scheduled run' : '▶ Run now'}: ${task}`, trigger })
}

/** Stop the run going on in a transcript, if any. */
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
