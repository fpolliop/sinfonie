import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import { ToolLoopAgent, stepCountIs, tool, type ModelMessage, type ToolApprovalResponse, type ToolSet } from 'ai'
import { z } from 'zod'
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'
import type { AgentEvent, AgentSpec, McpServerSpec, PermissionMode, SubagentStep, Workspace } from '@shared/types'
import { parseModelRef } from '@shared/types'
import { getStore } from '../../store'
import { getWorkspace, patchWorkspace } from '../workspaces'
import { buildTools, type ToolContext } from './tools'
import { runWorker } from '../crew/workers'
import * as notes from '../notes'
import { askPermission } from '../interaction'
import { estimateCost, resolveModel } from '../providers'
import { isReadOnlyCommand } from '../readonly'
import * as jira from '../jira'
import { logError } from '../telemetry'

type Emit = (e: AgentEvent) => void

interface NativeSession {
  workspaceId: string
  messages: ModelMessage[]
  busy: boolean
  abort: AbortController | null
  queue: { id: string; text: string }[]
  interrupted: boolean
  costByModel: Map<string, { costUsd: number; outputTokens: number }>
  mcpClients: MCPClient[]
}

const sessions = new Map<string, NativeSession>()

// ---------- persistence: our own history, one JSON per workspace ----------

function historyFile(workspaceId: string): string {
  const dir = join(app.getPath('userData'), 'native-sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, `${workspaceId}.json`)
}
function loadHistory(workspaceId: string): ModelMessage[] {
  const f = historyFile(workspaceId)
  if (!existsSync(f)) return []
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as ModelMessage[]
  } catch {
    return []
  }
}
function saveHistory(workspaceId: string, messages: ModelMessage[]): void {
  writeFileSync(historyFile(workspaceId), JSON.stringify(messages))
}
export function clearHistory(workspaceId: string): void {
  saveHistory(workspaceId, [])
}
/** Fork: copy the source history to the new workspace. */
export function copyHistory(from: string, to: string): void {
  saveHistory(to, loadHistory(from))
}

function getSession(workspaceId: string): NativeSession {
  let s = sessions.get(workspaceId)
  if (!s) {
    s = { workspaceId, messages: loadHistory(workspaceId), busy: false, abort: null, queue: [], interrupted: false, costByModel: new Map(), mcpClients: [] }
    sessions.set(workspaceId, s)
  }
  return s
}

// ---------- configuration ----------

function spaceOf(ws: Workspace) {
  const { settings, spaces } = getStore().get()
  return { settings, space: spaces.find((x) => x.id === ws.spaceId) }
}

function modelRefFor(ws: Workspace): string {
  const { settings, space } = spaceOf(ws)
  const ref = space?.model || settings.nativeModel || ''
  if (!parseModelRef(ref)) throw new Error('No native model configured. In the space settings (or app Settings) pick a provider and model for the native engine.')
  return ref
}

function systemPrompt(ws: Workspace, crew: AgentSpec[], mcpNames: string[]): string {
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const lines = [
    `You are Sinfonie's coding agent working inside the workspace "${ws.name}", which spans ${ws.repos.length} git repositories, each checked out as a worktree on branch "${primary.branch}":`,
    ...ws.repos.map((r) => `- ${r.repoName}: ${r.worktreePath} (based on ${r.baseBranch})`),
    `Your working directory is the ${primary.repoName} worktree. Use absolute paths when working in another repository's worktree. Keep each repository's changes inside its own worktree and run git commands from inside the worktree they apply to. Never modify the original repositories outside these worktree paths.`,
    `Tools: Read, Write, Edit, LS, Glob, Grep for files; Bash for shell commands; AskUserQuestion when a decision is the user's. Read before you edit. Prefer Edit for small changes. Run the relevant tests or type-check when they are cheap. When a tool call is denied, do not retry it; ask or adapt.`,
    `Answer in concise markdown. State what you changed and anything the user should verify.`
  ]
  if (mcpNames.length) lines.push(`MCP tools are available from: ${mcpNames.join(', ')}.`)
  if (crew.length) {
    lines.push(
      `You are also the orchestrator of a crew. Delegate with the Agent tool (subagent_type = the crew member name) when a subtask is well-specified and a cheaper or more focused agent can do it; keep planning, judgment and integration yourself. Reading many files to answer a question is a job for the explorer; running tests is a job for the tester; a well-specified change in one repository goes to the implementer; before committing, have the reviewer look at the diff. Your crew:`,
      ...crew.map((a) => `- ${a.name} (${a.model}${a.effort ? `, ${a.effort} effort` : ''}): ${a.description}`),
      `When delegating, state the worktree path, the exact goal, and what a finished answer looks like. Never let two agents edit the same repository at the same time.`
    )
  }
  return lines.join('\n')
}

// ---------- MCP ----------

async function connectMcp(ws: Workspace, session: NativeSession): Promise<{ tools: ToolSet; names: string[] }> {
  const { settings, space } = spaceOf(ws)
  const specs: McpServerSpec[] = [...(settings.mcpServers ?? []), ...(space?.mcpServers ?? [])].filter((s) => s.enabled)
  const tools: ToolSet = {}
  const names: string[] = []
  const connect = async (name: string, make: () => Promise<MCPClient>): Promise<void> => {
    try {
      const client = await make()
      session.mcpClients.push(client)
      const t = await client.tools()
      for (const [k, v] of Object.entries(t)) tools[`mcp__${name}__${k}`] = v
      names.push(name)
    } catch (err) {
      logError('native:mcp', err, { name })
    }
  }
  for (const s of specs) {
    if (s.transport === 'stdio' && s.command) {
      await connect(s.name, () => createMCPClient({ transport: new StdioMCPTransport({ command: s.command!, args: s.args ?? [], env: s.env }) }))
    } else if (s.url) {
      await connect(s.name, () => createMCPClient({ transport: { type: s.transport === 'sse' ? 'sse' : 'http', url: s.url!, headers: s.headers } }))
    }
  }
  const expose = space ? space.exposeJiraMcp !== false : true
  if (expose && !names.includes('jira')) {
    const token = await jira.accessToken(jira.connectionForSpace(ws.spaceId))
    if (token) await connect('jira', () => createMCPClient({ transport: { type: 'http', url: jira.JIRA_MCP_URL, headers: { Authorization: `Bearer ${token}` } } }))
  }
  return { tools, names }
}

// ---------- crew as a single Agent tool ----------

function crewTool(ws: Workspace, crew: AgentSpec[], baseCtx: ToolContext, emit: Emit, mode: PermissionMode) {
  const byName = new Map(crew.map((a) => [a.name, a]))
  return tool({
    description: `Delegate a task to a crew member. subagent_type is one of: ${crew.map((a) => a.name).join(', ')}. The agent works in the workspace and returns a report.`,
    inputSchema: z.object({
      subagent_type: z.string(),
      description: z.string().describe('3-6 word summary shown to the user'),
      prompt: z.string().describe('The full task: worktree path, exact goal, what done looks like')
    }),
    execute: async ({ subagent_type, description, prompt }, { toolCallId, abortSignal }) => {
      void description
      const spec = byName.get(subagent_type)
      if (!spec) return `Unknown crew member "${subagent_type}". Available: ${crew.map((a) => a.name).join(', ')}.`
      try {
        return await runWorker({
          spec,
          ws,
          prompt,
          mode,
          signal: abortSignal ?? baseCtx.signal,
          onStep: (step, model) => emit({ type: 'subagent', workspaceId: ws.id, parentToolUseId: toolCallId, model, tools: step.kind === 'tool' ? [step.name ?? ''] : [], steps: [step], ...(step.kind === 'text' ? { text: step.detail.slice(0, 400) } : {}) }),
          onUsage: (modelId, i, o) => addCost(getSession(ws.id), modelId, i, o)
        })
      } catch (err) {
        return `${spec.name} failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  })
}

function addCost(s: NativeSession, modelId: string, input: number, output: number): void {
  const cur = s.costByModel.get(modelId) ?? { costUsd: 0, outputTokens: 0 }
  cur.costUsd += estimateCost(modelId, input, output)
  cur.outputTokens += output
  s.costByModel.set(modelId, cur)
}

// ---------- approvals by permission mode ----------

function approvalPolicy(mode: PermissionMode, ws: Workspace) {
  return ({ toolCall }: { toolCall: { toolName: string; input: unknown } }) => {
    const name = toolCall.toolName
    const input = (toolCall.input ?? {}) as Record<string, unknown>
    const readTools = new Set(['Read', 'LS', 'Glob', 'Grep', 'AskUserQuestion', 'Agent'])
    if (readTools.has(name)) return undefined
    if (mode === 'bypassPermissions') return undefined
    if (mode === 'plan') {
      if (name === 'Write' || name === 'Edit') return { type: 'denied' as const, reason: 'Plan mode: no file changes. Describe the change instead.' }
      if (name === 'Bash' && typeof input.command === 'string' && !isReadOnlyCommand(input.command)) return { type: 'denied' as const, reason: 'Plan mode: read-only commands only.' }
      return undefined
    }
    if (name === 'Bash' && typeof input.command === 'string' && isReadOnlyCommand(input.command)) return undefined
    if (mode === 'acceptEdits' || mode === 'auto') {
      if (name === 'Write' || name === 'Edit') return undefined
      if (mode === 'auto' && name === 'Bash' && typeof input.command === 'string' && /^(pnpm|npm|yarn|bun|npx|git (add|commit|status|diff|log|fetch|checkout|switch|stash|restore)|make|cargo|go |python|pytest|tsc|eslint|prettier|vitest|jest)\b/.test(input.command.trim())) return undefined
    }
    void ws
    return 'user-approval' as const
  }
}

// ---------- the turn loop ----------

async function runTurn(ws: Workspace, session: NativeSession, emit: Emit): Promise<void> {
  const { settings, space } = spaceOf(ws)
  const mode: PermissionMode = ws.permissionMode ?? space?.permissionMode ?? settings.permissionMode
  const modelRef = modelRefFor(ws)
  const modelId = parseModelRef(modelRef)!.modelId
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const abort = new AbortController()
  session.abort = abort
  const ctx: ToolContext = { workspace: ws, roots: ws.repos.map((r) => r.worktreePath), cwd: primary.worktreePath, signal: abort.signal }
  const builtin = buildTools(ctx)
  const crew = space?.useCrew === false ? [] : (space?.agents ?? settings.agents).filter((a) => a.enabled && a.name.trim())
  const mcp = await connectMcp(ws, session)
  const tools: ToolSet = { ...builtin, ...mcp.tools, ...notes.aiTools(ws.id), ...(crew.length ? { Agent: crewTool(ws, crew, ctx, emit, mode) } : {}) }
  const agent = new ToolLoopAgent({
    model: resolveModel(modelRef),
    instructions: systemPrompt(ws, crew, mcp.names) + notes.promptFor(ws.id, true),
    tools,
    stopWhen: stepCountIs(120),
    toolApproval: approvalPolicy(mode, ws)
  })

  let itemId = ''
  const notice = (level: 'info' | 'warn' | 'error', text: string): void => emit({ type: 'notice', workspaceId: ws.id, itemId: nanoid(8), level, text, createdAt: new Date().toISOString() })

  try {
    // Loop: run, collect approval requests, ask the user, respond, run again until the model finishes.
    for (let round = 0; round < 50; round++) {
      const result = await agent.stream({ messages: session.messages, abortSignal: abort.signal })
      const approvals: { approvalId: string; toolName: string; input: Record<string, unknown> }[] = []
      const toolItems = new Map<string, string>()
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'start-step':
            itemId = nanoid(8)
            emit({ type: 'assistant_start', workspaceId: ws.id, itemId })
            break
          case 'text-delta':
            emit({ type: 'text_delta', workspaceId: ws.id, itemId, text: part.text })
            break
          case 'reasoning-delta':
            emit({ type: 'thinking_delta', workspaceId: ws.id, itemId, text: part.text })
            break
          case 'tool-call':
            toolItems.set(part.toolCallId, itemId)
            emit({ type: 'tool_start', workspaceId: ws.id, itemId, toolUseId: part.toolCallId, name: part.toolName })
            emit({ type: 'tool_input', workspaceId: ws.id, itemId, toolUseId: part.toolCallId, input: part.input })
            break
          case 'tool-result':
            emit({ type: 'tool_result', workspaceId: ws.id, toolUseId: part.toolCallId, result: typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2), isError: false })
            break
          case 'tool-error':
            emit({ type: 'tool_result', workspaceId: ws.id, toolUseId: part.toolCallId, result: String(part.error), isError: true })
            break
          case 'tool-output-denied':
            emit({ type: 'tool_result', workspaceId: ws.id, toolUseId: part.toolCallId, result: 'Denied', isError: true })
            break
          case 'finish-step':
            addCost(session, modelId, part.usage.inputTokens ?? 0, part.usage.outputTokens ?? 0)
            emit({ type: 'assistant_end', workspaceId: ws.id, itemId })
            break
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(String(part.error))
          default:
            break
        }
      }
      const responseMessages = await result.response.then((r) => r.messages)
      session.messages.push(...responseMessages)
      const content = await result.content
      for (const part of content) {
        if (part.type === 'tool-approval-request' && !part.isAutomatic) approvals.push({ approvalId: part.approvalId, toolName: part.toolCall.toolName, input: (part.toolCall.input ?? {}) as Record<string, unknown> })
      }
      saveHistory(ws.id, session.messages)
      if (approvals.length === 0) break
      // Ask the user for each pending approval, then continue the turn.
      const responses: ToolApprovalResponse[] = []
      for (const a of approvals) {
        const cb = approvals.length > 1 ? undefined : undefined
        void cb
        const r = await askPermission({ workspaceId: ws.id, toolName: a.toolName, input: a.input, canAlwaysAllow: false }, abort.signal)
        // "Allow all" from the UI switches the workspace to auto; honour it for the remaining approvals in this batch too.
        responses.push({ type: 'tool-approval-response', approvalId: a.approvalId, approved: r.decision !== 'deny', reason: r.decision === 'deny' ? r.message ?? 'The user denied this action' : undefined })
      }
      session.messages.push({ role: 'tool', content: responses })
      saveHistory(ws.id, session.messages)
      if (abort.signal.aborted) break
    }
    const byModel = Array.from(session.costByModel.entries())
      .map(([model, c]) => ({ model, costUsd: c.costUsd, outputTokens: c.outputTokens }))
      .sort((a, b) => b.costUsd - a.costUsd)
    const total = byModel.reduce((n, m) => n + m.costUsd, 0)
    if (session.interrupted) {
      session.interrupted = false
      notice('info', 'You stopped the response.')
    }
    emit({ type: 'result', result: { workspaceId: ws.id, costUsd: total, durationMs: 0, numTurns: 1, isError: false, byModel } })
    patchWorkspace(ws.id, { lastMessageAt: new Date().toISOString() })
  } catch (err) {
    if (abort.signal.aborted) {
      session.interrupted = false
      notice('info', 'You stopped the response.')
      emit({ type: 'result', result: { workspaceId: ws.id, costUsd: 0, durationMs: 0, numTurns: 1, isError: false } })
    } else {
      const message = err instanceof Error ? err.message : String(err)
      logError('native:turn', err, { workspaceId: ws.id, model: modelRef })
      notice('error', `The turn failed: ${message}`)
      emit({ type: 'result', result: { workspaceId: ws.id, costUsd: 0, durationMs: 0, numTurns: 1, isError: true, errorText: message } })
    }
  } finally {
    for (const c of session.mcpClients) void c.close().catch(() => undefined)
    session.mcpClients = []
    session.abort = null
    session.busy = false
    emit({ type: 'status', workspaceId: ws.id, busy: false })
    const next = session.queue.shift()
    if (next) {
      emit({ type: 'queue', workspaceId: ws.id, items: [...session.queue] })
      deliver(ws.id, next.text, emit)
    }
  }
}

function deliver(workspaceId: string, text: string, emit: Emit): void {
  const session = getSession(workspaceId)
  const ws = getWorkspace(workspaceId)
  session.busy = true
  session.messages.push({ role: 'user', content: text })
  emit({ type: 'user_message', workspaceId, itemId: nanoid(8), text, createdAt: new Date().toISOString() })
  emit({ type: 'status', workspaceId, busy: true })
  void runTurn(ws, session, emit)
}

// ---------- public surface, mirrors the Claude Code engine ----------

export function sendMessage(workspaceId: string, text: string, emit: Emit): void {
  const session = getSession(workspaceId)
  if (session.busy) {
    session.queue.push({ id: nanoid(6), text })
    emit({ type: 'queue', workspaceId, items: [...session.queue] })
    return
  }
  deliver(workspaceId, text, emit)
}

export function unqueue(workspaceId: string, id: string, emit: Emit): void {
  const s = sessions.get(workspaceId)
  if (!s) return
  s.queue = s.queue.filter((m) => m.id !== id)
  emit({ type: 'queue', workspaceId, items: [...s.queue] })
}

export function interrupt(workspaceId: string): void {
  const s = sessions.get(workspaceId)
  if (!s?.abort) return
  s.interrupted = true
  s.abort.abort()
}

export function isBusy(workspaceId: string): boolean {
  return sessions.get(workspaceId)?.busy ?? false
}

export function resetSession(workspaceId: string): void {
  interrupt(workspaceId)
  sessions.delete(workspaceId)
  clearHistory(workspaceId)
}

export function closeSession(workspaceId: string): void {
  interrupt(workspaceId)
  sessions.delete(workspaceId)
}

export function closeAll(): void {
  for (const id of Array.from(sessions.keys())) closeSession(id)
}
