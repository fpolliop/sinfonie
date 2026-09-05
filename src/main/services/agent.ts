import { claudeExecutableOption } from './claude-cli'
import { query, createSdkMcpServer, tool as sdkTool, type Options, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'child_process'
import * as resources from './resources'
import * as browserTools from './browser/tools'
import * as workspaceTools from './workspace-tools'
import { toBase64 } from './images'
import type { ChatImageRef } from '@shared/types'
import { z } from 'zod'
import { classifyModel } from '@shared/types'
import { runWorker } from './crew/workers'
import * as notes from './notes'
import { nanoid } from 'nanoid'
import type { AgentEvent, PermissionMode, PermissionRequest, Question, SubagentStep, Workspace } from '@shared/types'
import { askPermission, askQuestion } from './interaction'
import * as native from './native/engine'
import * as acp from './acp/engine'
import type { Engine } from '@shared/types'
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getStore } from '../store'
import { getWorkspace, patchWorkspace } from './workspaces'
import { accountEnv } from './accounts'
import * as jira from './jira'
import * as linear from './linear'
import { logError } from './telemetry'
import type { McpServerSpec } from '@shared/types'

type EmitEvent = (e: AgentEvent) => void
type EmitPermission = (r: PermissionRequest) => void

interface Session {
  workspaceId: string
  q: Query
  push: (m: SDKUserMessage) => void
  end: () => void
  abort: AbortController
  busy: boolean
  /** Last lines the CLI wrote to stderr, shown when a turn fails without a better explanation. */
  stderr: string[]
  /** Messages typed while a turn was running; delivered one per turn, in order. */
  queue: { id: string; text: string; images?: ChatImageRef[] }[]
  /** Set by Stop so the resulting error result is reported as a stop, not a failure. */
  interrupted: boolean
  /** Names of the MCP servers Sinfonie passed to this session. */
  mcpNames: string[]
  /** Pending tool_use ids per external crew member, so worker activity attaches to the right call. */
  crewCalls: Map<string, string[]>
  /** Set when the workspace gained a repository mid-turn: restart the session at turn end so the new worktree is a working directory. */
  flags: { restartAfterTurn: boolean }
  emitPermission: EmitPermission
}

/** Everything the SDK sends (minus streaming deltas) goes to a per-workspace log for diagnosis. */
export function agentLogPath(workspaceId: string): string {
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, `agent-${workspaceId}.jsonl`)
}
function logMsg(workspaceId: string, msg: SDKMessage): void {
  if (msg.type === 'stream_event' && msg.event.type !== 'message_start' && msg.event.type !== 'message_delta' && msg.event.type !== 'message_stop') return
  try {
    const { type } = msg
    const subtype = 'subtype' in msg ? msg.subtype : undefined
    const brief: Record<string, unknown> = { ts: new Date().toISOString(), type, subtype }
    if (msg.type === 'assistant') brief.error = msg.error, (brief.stop_reason = msg.message.stop_reason), (brief.blocks = msg.message.content.map((b) => b.type))
    if (msg.type === 'result') brief.is_error = msg.is_error, (brief.stop_reason = msg.stop_reason), (brief.errors = 'errors' in msg ? msg.errors : undefined), (brief.num_turns = msg.num_turns)
    if (msg.type === 'stream_event' && msg.event.type === 'message_delta') brief.stop_reason = msg.event.delta.stop_reason
    if (msg.type === 'system' && msg.subtype !== 'init') brief.detail = JSON.stringify(msg).slice(0, 600)
    if (msg.type === 'auth_status' || msg.type === 'rate_limit_event') brief.detail = JSON.stringify(msg).slice(0, 600)
    appendFileSync(agentLogPath(workspaceId), JSON.stringify(brief) + '\n')
  } catch {
    /* logging must never break the session */
  }
}

const ERROR_TEXT: Record<string, string> = {
  authentication_failed: 'Claude Code is not logged in for this account. Open Settings → Claude accounts and log in.',
  oauth_org_not_allowed: 'This login is not allowed to use the API for this organization.',
  account_on_hold: 'The Claude account is on hold.',
  billing_error: 'Billing problem on the Claude account.',
  rate_limit: 'Rate limit reached. Wait a bit and try again.',
  overloaded: 'The API is overloaded right now.',
  invalid_request: 'The API rejected the request as invalid.',
  model_not_found: 'The configured model was not found. Check the model name in Settings.',
  server_error: 'The API returned a server error.',
  max_output_tokens: 'The reply hit the maximum output length and was cut off.',
  unknown: 'Unknown API error.'
}
function describeError(code: string | undefined): string {
  return (code && ERROR_TEXT[code]) || `API error${code ? ` (${code})` : ''}`
}

const sessions = new Map<string, Session>()
/** Workspaces that already got the inherited-MCP notice this app run. */
const mcpNoticeShown = new Set<string>()

/** An async iterable we can push into from outside; the SDK consumes it as the prompt stream. */
function makeInputStream(): { iterable: AsyncIterable<SDKUserMessage>; push: (m: SDKUserMessage) => void; end: () => void } {
  const queue: SDKUserMessage[] = []
  let waiting: ((v: IteratorResult<SDKUserMessage>) => void) | null = null
  let ended = false
  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => (waiting = resolve))
        }
      }
    }
  }
  return {
    iterable,
    push: (m) => {
      if (waiting) {
        const w = waiting
        waiting = null
        w({ value: m, done: false })
      } else queue.push(m)
    },
    end: () => {
      ended = true
      if (waiting) {
        const w = waiting
        waiting = null
        w({ value: undefined, done: true })
      }
    }
  }
}

function systemPromptFor(ws: Workspace): string {
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const lines = primary
    ? [
        `You are working inside an Sinfonie workspace named "${ws.name}" that spans ${ws.repos.length} git repositor${ws.repos.length === 1 ? 'y' : 'ies'}.`,
        `Each repository has its own worktree on the branch "${primary.branch}". The worktrees are:`,
        ...ws.repos.map((r) => `- ${r.repoName}: ${r.worktreePath} (branch ${r.branch}, based on ${r.baseBranch})`),
        `Your working directory is the ${primary.repoName} worktree. The other worktrees are added as additional directories; you can read and edit files in all of them.`,
        `A feature may need changes in several of these repositories. Keep the changes for each repository inside its own worktree, and run git commands from inside the worktree they apply to.`,
        `Never modify the original repositories outside these worktree paths.`
      ]
    : [`You are working inside an Sinfonie workspace named "${ws.name}". Your working directory is its folder, ${ws.rootPath}.`]
  lines.push(workspaceTools.promptFor(ws.id))
  lines.push(`Sinfonie runs on the user's Mac next to other sessions and limits you to ${resources.resourceSettings().maxSubagentsPerSession} subagents at once; under memory pressure it refuses new ones. When a delegation is refused, the tool result says why: do that work yourself or wait for running subagents instead of retrying.`)
  return lines.join('\n')
}

function toSdkMcp(spec: McpServerSpec): NonNullable<Options['mcpServers']>[string] | null {
  if (spec.transport === 'stdio') return spec.command ? { type: 'stdio', command: spec.command, args: spec.args ?? [], env: spec.env } : null
  if (!spec.url) return null
  return { type: spec.transport, url: spec.url, headers: spec.headers }
}

/** App-level servers, then the space's, then the space's Jira login as the Atlassian MCP. */
async function mcpServersFor(ws: Workspace, onWarning?: (text: string) => void): Promise<Record<string, NonNullable<Options['mcpServers']>[string]>> {
  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === ws.spaceId)
  const out: Record<string, NonNullable<Options['mcpServers']>[string]> = {}
  for (const spec of [...(settings.mcpServers ?? []), ...(space?.mcpServers ?? [])]) {
    if (!spec.enabled) continue
    const cfg = toSdkMcp(spec)
    if (cfg) out[spec.name] = cfg
  }
  const connId = jira.connectionForSpace(ws.spaceId)
  const expose = space ? space.exposeJiraMcp !== false : true
  if (expose && !out.jira) {
    try {
      const token = await jira.accessToken(connId)
      if (token) out.jira = { type: 'http', url: jira.JIRA_MCP_URL, headers: { Authorization: `Bearer ${token}` } }
    } catch (err) {
      // An expired Jira login must not take the other MCP servers down with it, and must never open a browser here.
      onWarning?.(`Jira tools are off for this session: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const exposeLinear = space ? space.exposeLinearMcp !== false : true
  if (exposeLinear && !out.linear) {
    try {
      const token = await linear.accessToken(linear.connectionForSpace(ws.spaceId))
      if (token) out.linear = { type: 'http', url: linear.LINEAR_MCP_URL, headers: { Authorization: `Bearer ${token}` } }
    } catch (err) {
      onWarning?.(`Linear tools are off for this session: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}

/**
 * The crew for Claude Code: members on Claude models become SDK subagents; members on other
 * vendors (API providers, Codex, Gemini, Grok) become tools of an in-process MCP server named
 * "crew", each running through the shared workers. Plus the paragraph that tells the
 * orchestrator how to use them.
 */
function crewFor(ws: Workspace, emit: EmitEvent, crewCalls: Map<string, string[]>): { agents: NonNullable<Options['agents']>; prompt: string; server?: NonNullable<Options['mcpServers']>[string] } {
  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === ws.spaceId)
  if (space?.useCrew === false) return { agents: {}, prompt: '' }
  const all = (space?.agents ?? settings.agents).filter((a) => a.enabled && a.name.trim())
  const specs = all.filter((a) => classifyModel(a.model).kind === 'claude')
  const external = all.filter((a) => classifyModel(a.model).kind !== 'claude')
  const agents: NonNullable<Options['agents']> = {}
  for (const a of specs) {
    agents[a.name] = {
      description: a.description,
      prompt: a.prompt,
      model: a.model,
      ...(a.effort ? { effort: a.effort } : {}),
      ...(a.tools?.length ? { tools: a.tools } : {}),
      ...(a.disallowedTools?.length ? { disallowedTools: a.disallowedTools } : {}),
      ...(a.maxTurns ? { maxTurns: a.maxTurns } : {}),
      ...(a.permissionMode ? { permissionMode: a.permissionMode } : {})
    }
  }
  if (all.length === 0) return { agents: {}, prompt: '' }
  let server: NonNullable<Options['mcpServers']>[string] | undefined
  if (external.length) {
    const mode = ws.permissionMode ?? space?.permissionMode ?? settings.permissionMode
    server = createSdkMcpServer({
      name: 'crew',
      tools: external.map((spec) =>
        sdkTool(
          spec.name,
          `Delegate to the ${spec.name} crew member (${spec.model}): ${spec.description}`,
          { description: z.string().describe('3-6 word summary shown to the user'), prompt: z.string().describe('The full task: worktree path, exact goal, what done looks like') },
          async ({ prompt }) => {
            const parentToolUseId = crewCalls.get(spec.name)?.shift() ?? nanoid(8)
            const veto = resources.delegationVeto(ws.id)
            if (veto) return { content: [{ type: 'text', text: `Delegation refused by Sinfonie's resource governor: ${veto}` }], isError: true }
            const taskId = `crew-${nanoid(6)}`
            resources.taskStarted(ws.id, { taskId, toolUseId: parentToolUseId, description: spec.name, startedAt: new Date().toISOString() })
            try {
              const report = await runWorker({
                spec,
                ws: getWorkspace(ws.id),
                prompt,
                mode,
                onStep: (step, model) => emit({ type: 'subagent', workspaceId: ws.id, parentToolUseId, model, tools: step.kind === 'tool' ? [step.name ?? ''] : [], steps: [step], ...(step.kind === 'text' ? { text: step.detail.slice(0, 400) } : {}) })
              })
              return { content: [{ type: 'text', text: report }] }
            } catch (err) {
              return { content: [{ type: 'text', text: `${spec.name} failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
            } finally {
              resources.taskEnded(ws.id, taskId)
            }
          }
        )
      )
    })
  }
  const prompt = [
    '',
    'You are the orchestrator of a crew. Keep planning, judgment and integration yourself, and delegate the rest. Reading more than a couple of files to answer a question is a job for the explorer, not you: it is far cheaper. Running tests or type-checks is a job for the tester. A well-specified change inside one repository goes to the implementer. Before committing, have the reviewer look at the diff. Your crew:',
    ...specs.map((a) => `- ${a.name} (${a.model}${a.effort ? `, ${a.effort} effort` : ''}): ${a.description}. Call it with the Agent tool, subagent_type "${a.name}".`),
    ...external.map((a) => `- ${a.name} (${a.model}): ${a.description}. Call it with its own tool mcp__crew__${a.name} (description + prompt); it runs on another vendor's model and returns a report.`),
    `When delegating, state the worktree path, the exact goal, and what a finished answer looks like. Run independent delegations in parallel, at most ${resources.resourceSettings().maxSubagentsPerSession} at a time: Sinfonie refuses more, and the tool result explains why. Prefer a few well-scoped delegations over many small ones. Never let two agents edit the same repository at the same time.`
  ].join('\n')
  return { agents, prompt, server }
}

function getOrCreateSession(workspaceId: string, emit: EmitEvent, emitPermission: EmitPermission, mcpServersIn: Record<string, NonNullable<Options['mcpServers']>[string]>): Session {
  let mcpServers = mcpServersIn
  const existing = sessions.get(workspaceId)
  if (existing) return existing

  const ws = getWorkspace(workspaceId)
  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === ws.spaceId)
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const wsCwd = primary?.worktreePath ?? ws.rootPath
  const others = ws.repos.filter((r) => r !== primary).map((r) => r.worktreePath)
  const flags = { restartAfterTurn: false }
  const abort = new AbortController()
  const input = makeInputStream()

  const canUseTool: NonNullable<Options['canUseTool']> = async (toolName, toolInput, opts) => {
    const requestId = nanoid(8)
    if (toolName === 'AskUserQuestion') {
      // Claude's clarifying questions: show the card, hand the chosen labels back as `answers`.
      const questions = ((toolInput as { questions?: Question[] }).questions ?? []).map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: Boolean(q.multiSelect),
        options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description, preview: o.preview }))
      }))
      const reply = await askQuestion(workspaceId, questions, opts.signal)
      if (reply.cancelled) return { behavior: 'deny', message: 'The user dismissed the questions without answering. Continue with your best judgement or ask in plain text.' }
      const updatedInput: Record<string, unknown> = { questions: (toolInput as { questions?: unknown }).questions, answers: reply.answers }
      if (reply.response) updatedInput.response = reply.response
      return { behavior: 'allow', updatedInput }
    }
    void requestId
    const decision = await askPermission(
      { workspaceId, toolName, input: toolInput, blockedPath: opts.blockedPath, canAlwaysAllow: Boolean(opts.suggestions && opts.suggestions.length > 0) },
      opts.signal
    )
    if (decision.decision === 'deny') {
      const r: PermissionResult = { behavior: 'deny', message: decision.message || 'User denied this tool call' }
      return r
    }
    const r: PermissionResult = {
      behavior: 'allow',
      updatedInput: toolInput,
      ...(decision.decision === 'always' && opts.suggestions ? { updatedPermissions: opts.suggestions } : {})
    }
    return r
  }

  const mode = ws.permissionMode ?? space?.permissionMode ?? settings.permissionMode
  const crewCalls = new Map<string, string[]>()
  const crew = crewFor(ws, emit, crewCalls)
  if (crew.server) mcpServers = { ...mcpServers, crew: crew.server }
  mcpServers = { ...mcpServers, notes: notes.sdkServer(ws.id), browser: browserTools.sdkServer(ws.id), workspace: workspaceTools.sdkServer(ws.id, () => (flags.restartAfterTurn = true)) }
  const options: Options = {
    ...claudeExecutableOption(),
    cwd: wsCwd,
    additionalDirectories: others,
    permissionMode: mode,
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    model: space?.model || settings.model,
    // Opus 5 / Fable hide reasoning by default; ask for the readable summary so the Thinking block has content.
    thinking: { type: 'adaptive', display: 'summarized' },
    includePartialMessages: true,
    abortController: abort,
    canUseTool,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptFor(ws) + (Object.keys(mcpServers).length ? `\nMCP servers available in this workspace: ${Object.keys(mcpServers).join(', ')}.` : '') + crew.prompt + notes.promptFor(ws.id, true) + '\n' + browserTools.promptFor(ws.port) },
    ...(Object.keys(crew.agents).length ? { agents: crew.agents } : {}),
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
    ...(space?.strictMcp ?? settings.strictMcp ? { strictMcpConfig: true } : {}),
    settingSources: ['user', 'project', 'local'],
    allowedTools: [...browserTools.sdkAllowedTools(), ...workspaceTools.SDK_ALLOWED],
    hooks: {
      PreToolUse: [
        {
          matcher: 'Agent|Task',
          hooks: [
            async () => {
              const veto = resources.delegationVeto(workspaceId)
              if (!veto) return {}
              emit({ type: 'notice', workspaceId, itemId: nanoid(8), level: 'warn', text: `Delegation refused: ${veto}`, createdAt: new Date().toISOString() })
              return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Sinfonie resource governor: ${veto}` } }
            }
          ]
        }
      ]
    },
    // Spawn the CLI ourselves so the governor knows its pid and can charge its whole subtree to this workspace.
    spawnClaudeCodeProcess: (o) => {
      const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal })
      resources.registerProcess(child.pid, { kind: 'agent', workspaceId, label: 'Claude Code' })
      child.stderr?.on('data', (d: Buffer) => options.stderr?.(d.toString()))
      child.once('exit', () => resources.unregisterProcess(child.pid))
      return child as unknown as SpawnedProcess
    },
    env: {
      ...process.env,
      ...accountEnv(ws.claudeAccountId),
      SINFONIE_WORKSPACE_NAME: ws.slug,
      SINFONIE_WORKSPACE_ROOT: ws.rootPath,
      SINFONIE_PORT: String(ws.port)
    },
    ...(ws.sessionId ? { resume: ws.sessionId } : {})
  }

  const stderrLines: string[] = []
  options.stderr = (d) => {
    console.error(`[agent ${ws.slug}]`, d.trimEnd())
    for (const line of d.split('\n')) {
      if (line.trim()) stderrLines.push(line.trim())
    }
    if (stderrLines.length > 40) stderrLines.splice(0, stderrLines.length - 40)
  }
  const q = query({ prompt: input.iterable, options })
  const session: Session = { workspaceId, q, push: input.push, end: input.end, abort, busy: false, stderr: stderrLines, queue: [], interrupted: false, mcpNames: Object.keys(mcpServers).filter((n) => n !== 'crew' && n !== 'notes' && n !== 'browser' && n !== 'workspace'), crewCalls, flags, emitPermission }
  sessions.set(workspaceId, session)
  void pump(session, emit)
  return session
}

/** Translate the SDK's message stream into the small event set the UI renders. */
async function pump(session: Session, emit: EmitEvent): Promise<void> {
  const { workspaceId } = session
  let itemId = ''
  // Map content-block index -> tool_use id for the in-flight assistant message.
  const toolIds = new Map<number, string>()
  const toolJson = new Map<number, string>()
  // What this turn produced so far, so an empty turn can be called out.
  let turnText = 0
  let turnTools = 0
  let turnStop: string | null = null
  const notice = (level: 'info' | 'warn' | 'error', text: string): void =>
    emit({ type: 'notice', workspaceId, itemId: nanoid(8), level, text, createdAt: new Date().toISOString() })
  try {
    for await (const msg of session.q as AsyncIterable<SDKMessage>) {
      logMsg(workspaceId, msg)
      switch (msg.type) {
        case 'assistant':
          if (msg.error && !msg.parent_tool_use_id) notice('error', describeError(msg.error))
          if (msg.parent_tool_use_id) {
            const tools = msg.message.content.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name)
            const text = msg.message.content
              .filter((b) => b.type === 'text')
              .map((b) => (b as { text: string }).text)
              .join('')
              .slice(0, 400)
            const steps: SubagentStep[] = []
            for (const b of msg.message.content) {
              if (b.type === 'tool_use') {
                const i = (b.input ?? {}) as Record<string, unknown>
                const detail = [i.command, i.file_path, i.pattern, i.description, i.query, i.url].find((v) => typeof v === 'string') as string | undefined
                steps.push({ kind: 'tool', name: b.name, detail: (detail ?? JSON.stringify(i)).slice(0, 200) })
              } else if (b.type === 'text' && b.text.trim()) {
                steps.push({ kind: 'text', detail: b.text.slice(0, 600) })
              }
            }
            emit({ type: 'subagent', workspaceId, parentToolUseId: msg.parent_tool_use_id, model: msg.message.model, tools, steps, ...(text ? { text } : {}) })
          }
          break
        case 'auth_status':
          if (msg.error) notice('error', `Authentication: ${msg.error}`)
          break
        case 'rate_limit_event': {
          const r = msg.rate_limit_info
          if (r.status === 'rejected') notice('error', `Rate limit hit (${r.rateLimitType ?? 'usage'})${r.resetsAt ? `, resets ${new Date(r.resetsAt * 1000).toLocaleTimeString()}` : ''}.`)
          else if (r.status === 'allowed_warning' && r.utilization != null) notice('warn', `Approaching the ${r.rateLimitType ?? 'usage'} limit: ${Math.round(r.utilization * 100)}% used.`)
          break
        }
        case 'system':
          if (msg.subtype === 'init') {
            getStore().update((d) => {
              const w = d.workspaces.find((x) => x.id === workspaceId)
              if (w) w.sessionId = msg.session_id
            })
            emit({ type: 'init', workspaceId, sessionId: msg.session_id, model: msg.model, cwd: msg.cwd })
            // Servers Sinfonie configured get a warning each; everything inherited from Claude Code's own
            // config (claude.ai connectors, plugins) is folded into one quiet line, once per app run.
            const ours = new Set(session.mcpNames)
            const bad = msg.mcp_servers.filter((m) => m.status !== 'connected' && m.status !== 'pending')
            for (const m of bad) if (ours.has(m.name)) notice('warn', `MCP server "${m.name}" is ${m.status}.`)
            const inherited = bad.filter((m) => !ours.has(m.name))
            if (inherited.length && !mcpNoticeShown.has(workspaceId)) {
              mcpNoticeShown.add(workspaceId)
              const names = inherited.map((m) => `${m.name} (${m.status})`).join(', ')
              notice('info', `${inherited.length} MCP server${inherited.length === 1 ? '' : 's'} from your Claude Code config ${inherited.length === 1 ? 'is' : 'are'} not available: ${names}. Turn on "Only Sinfonie's MCP servers" in the space settings to stop loading them.`)
            }
          } else if (msg.subtype === 'api_retry') {
            notice('warn', `${describeError(msg.error)} Retrying (${msg.attempt}/${msg.max_retries}) in ${Math.round(msg.retry_delay_ms / 1000)}s…`)
          } else if (msg.subtype === 'model_refusal_no_fallback') {
            notice('error', `The model declined this request${msg.api_refusal_category ? ` (${msg.api_refusal_category})` : ''}. ${msg.api_refusal_explanation ?? msg.content ?? ''}`.trim())
          } else if (msg.subtype === 'model_refusal_fallback') {
            notice('info', `Switched from ${msg.original_model} to ${msg.fallback_model} after a refusal.`)
          } else if (msg.subtype === 'task_started') {
            if (!msg.ambient && (msg.subagent_type || msg.task_type === 'local_agent')) resources.taskStarted(workspaceId, { taskId: msg.task_id, toolUseId: msg.tool_use_id, description: msg.subagent_type ?? msg.description, startedAt: new Date().toISOString() })
          } else if (msg.subtype === 'task_notification') {
            resources.taskEnded(workspaceId, msg.task_id)
          } else if (msg.subtype === 'task_updated') {
            if (msg.patch.status && ['completed', 'failed', 'killed'].includes(msg.patch.status)) resources.taskEnded(workspaceId, msg.task_id)
          } else if (msg.subtype === 'notification') {
            if (msg.priority === 'high' || msg.priority === 'immediate') notice('warn', msg.text)
          } else if (msg.subtype === 'status') {
            if (msg.compact_result === 'failed') notice('warn', `Context compaction failed${msg.compact_error ? `: ${msg.compact_error}` : ''}.`)
          } else if (msg.subtype === 'permission_denied') {
            notice('warn', `${msg.tool_name} was denied: ${msg.message}`)
          }
          break
        case 'stream_event': {
          if (msg.parent_tool_use_id) break // subagent chatter stays hidden
          const ev = msg.event
          if (ev.type === 'message_start') {
            itemId = nanoid(8)
            toolIds.clear()
            toolJson.clear()
            session.busy = true
            emit({ type: 'assistant_start', workspaceId, itemId })
          } else if (ev.type === 'message_delta') {
            turnStop = ev.delta.stop_reason ?? turnStop
          } else if (ev.type === 'content_block_start') {
            const block = ev.content_block
            if (block.type === 'tool_use') {
              turnTools++
              toolIds.set(ev.index, block.id)
              if (block.name.startsWith('mcp__crew__')) {
                const n = block.name.slice('mcp__crew__'.length)
                session.crewCalls.set(n, [...(session.crewCalls.get(n) ?? []), block.id])
              }
              toolJson.set(ev.index, '')
              emit({ type: 'tool_start', workspaceId, itemId, toolUseId: block.id, name: block.name })
            }
          } else if (ev.type === 'content_block_delta') {
            const delta = ev.delta
            if (delta.type === 'text_delta') turnText += delta.text.length, emit({ type: 'text_delta', workspaceId, itemId, text: delta.text })
            else if (delta.type === 'thinking_delta') emit({ type: 'thinking_delta', workspaceId, itemId, text: delta.thinking })
            else if (delta.type === 'input_json_delta') toolJson.set(ev.index, (toolJson.get(ev.index) ?? '') + delta.partial_json)
          } else if (ev.type === 'content_block_stop') {
            const toolUseId = toolIds.get(ev.index)
            if (toolUseId) {
              let input: unknown = {}
              try {
                input = JSON.parse(toolJson.get(ev.index) || '{}')
              } catch {
                input = { raw: toolJson.get(ev.index) }
              }
              emit({ type: 'tool_input', workspaceId, itemId, toolUseId, input })
            }
          } else if (ev.type === 'message_stop') {
            emit({ type: 'assistant_end', workspaceId, itemId })
          }
          break
        }
        case 'user': {
          if (msg.parent_tool_use_id) break
          const content = msg.message.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const text =
                  typeof block.content === 'string'
                    ? block.content
                    : (block.content ?? [])
                        .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
                        .join('\n')
                emit({ type: 'tool_result', workspaceId, toolUseId: block.tool_use_id, result: text, isError: Boolean(block.is_error) })
              }
            }
          }
          break
        }
        case 'result': {
          session.busy = false
          const isError = msg.subtype !== 'success' || msg.is_error
          const errs = 'errors' in msg && Array.isArray(msg.errors) ? (msg.errors as string[]).join('\n') : ''
          const denials = 'permission_denials' in msg && Array.isArray(msg.permission_denials) ? msg.permission_denials.length : 0
          let errorText: string | undefined
          if (session.interrupted) {
            session.interrupted = false
            notice('info', 'You stopped the response.')
          } else if (isError) {
            const parts = [errs || (msg.subtype === 'success' ? (msg.result || '').slice(0, 500) : msg.subtype.replace(/_/g, ' '))]
            if (msg.stop_reason) parts.push(`stop reason: ${msg.stop_reason}`)
            if (denials) parts.push(`${denials} tool call${denials === 1 ? '' : 's'} denied`)
            if (!errs && session.stderr.length) parts.push(`stderr: ${session.stderr.slice(-5).join(' | ')}`)
            errorText = parts.join(' · ')
            notice('error', `The turn failed: ${errorText}`)
          } else if (turnText === 0 && turnTools === 0) {
            const why = turnStop ?? msg.stop_reason
            notice('warn', `Claude ended the turn without replying${why ? ` (stop reason: ${why})` : ''}. Try sending the message again; if it keeps happening, start a new session.`)
          } else if (turnStop === 'max_tokens' || msg.stop_reason === 'max_tokens') {
            notice('warn', 'The reply was cut off at the maximum output length.')
          }
          turnText = 0
          turnTools = 0
          turnStop = null
          // Deliver the next queued message, if any, as its own turn.
          const next = session.queue.shift()
          if (session.flags.restartAfterTurn) {
            // A repository was added mid-turn: the CLI's directory list is fixed at start, so resume in a fresh process.
            session.flags.restartAfterTurn = false
            const pending = next ? [next, ...session.queue] : [...session.queue]
            session.queue = []
            emit({ type: 'queue', workspaceId, items: [] })
            notice('info', 'Reloading the session so the new repository is a working directory.')
            setTimeout(() => {
              closeSession(workspaceId)
              for (const m of pending) void sendMessage(workspaceId, m.text, emit, session.emitPermission, m.images)
            }, 0)
          } else if (next) {
            emit({ type: 'queue', workspaceId, items: [...session.queue] })
            deliver(session, next.text, emit, true, next.images)
          }
          emit({
            type: 'result',
            result: {
              workspaceId,
              costUsd: msg.total_cost_usd,
              durationMs: msg.duration_ms,
              numTurns: msg.num_turns,
              isError,
              errorText,
              byModel: Object.entries(msg.modelUsage ?? {})
                .map(([model, u]) => ({ model, costUsd: u.costUSD, outputTokens: u.outputTokens }))
                .sort((a, b) => b.costUsd - a.costUsd)
            }
          })
          emit({ type: 'status', workspaceId, busy: false })
          getStore().update((d) => {
            const w = d.workspaces.find((x) => x.id === workspaceId)
            if (w) w.lastMessageAt = new Date().toISOString()
          })
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!session.abort.signal.aborted) {
      logError('agent:session', err, { workspaceId, stderr: session.stderr.slice(-5) })
      const tail = session.stderr.slice(-5).join(' | ')
      notice('error', `The session ended unexpectedly: ${message}${tail ? ` · stderr: ${tail}` : ''}`)
      emit({ type: 'error', workspaceId, message })
    }
  } finally {
    sessions.delete(workspaceId)
    emit({ type: 'status', workspaceId, busy: false })
  }
}

function deliver(session: Session, text: string, emit: EmitEvent, announce = true, images?: ChatImageRef[]): void {
  const { workspaceId } = session
  session.busy = true
  if (announce) emit({ type: 'user_message', workspaceId, itemId: nanoid(8), text, createdAt: new Date().toISOString(), ...(images?.length ? { images } : {}) })
  emit({ type: 'status', workspaceId, busy: true })
  session.push({
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...(images ?? []).map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mimeType as 'image/png', data: toBase64(img) } })),
        { type: 'text' as const, text: text || (images?.length ? 'See the attached image.' : '') }
      ]
    },
    parent_tool_use_id: null
  })
}

const starting = new Set<string>()

/** Which runtime a workspace uses: its space's engine, else the app default, else Claude Code. */
export function engineFor(workspaceId: string): Engine {
  const ws = getWorkspace(workspaceId)
  const { settings, spaces } = getStore().get()
  return spaces.find((s) => s.id === ws.spaceId)?.engine ?? settings.engine ?? 'claude-code'
}

export async function sendMessage(workspaceId: string, text: string, emit: EmitEvent, emitPermission: EmitPermission, images?: ChatImageRef[]): Promise<void> {
  const engine = engineFor(workspaceId)
  if (engine === 'native') return native.sendMessage(workspaceId, text, emit, images)
  if (engine === 'codex' || engine === 'gemini' || engine === 'grok') return acp.sendMessage(workspaceId, engine, text, emit, images)
  const live = sessions.get(workspaceId)
  if (live) {
    if (live.busy) {
      // Like the CLI: typed mid-turn, delivered when the current turn ends.
      live.queue.push({ id: nanoid(6), text, images })
      emit({ type: 'queue', workspaceId, items: [...live.queue] })
      return
    }
    deliver(live, text, emit, true, images)
    return
  }
  if (starting.has(workspaceId)) {
    emit({ type: 'notice', workspaceId, itemId: nanoid(8), level: 'warn', text: 'The session is still starting; send again in a moment.', createdAt: new Date().toISOString() })
    return
  }
  // Show the message and the busy state right away; MCP setup (which can wait on the network) happens after.
  starting.add(workspaceId)
  emit({ type: 'user_message', workspaceId, itemId: nanoid(8), text, createdAt: new Date().toISOString(), ...(images?.length ? { images } : {}) })
  emit({ type: 'status', workspaceId, busy: true })
  let mcp: Record<string, NonNullable<Options['mcpServers']>[string]> = {}
  try {
    mcp = await Promise.race([
      mcpServersFor(getWorkspace(workspaceId), (text) => emit({ type: 'notice', workspaceId, itemId: nanoid(8), level: 'warn', text, createdAt: new Date().toISOString() })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('MCP setup timed out')), 15_000))
    ])
  } catch (err) {
    emit({ type: 'notice', workspaceId, itemId: nanoid(8), level: 'warn', text: `Could not set up MCP servers (${err instanceof Error ? err.message : String(err)}). Continuing without them.`, createdAt: new Date().toISOString() })
  } finally {
    starting.delete(workspaceId)
  }
  const session = getOrCreateSession(workspaceId, emit, emitPermission, mcp)
  deliver(session, text, emit, false, images)
}

export function unqueue(workspaceId: string, id: string, emit: EmitEvent): void {
  const eng = engineFor(workspaceId)
  if (eng === 'native') return native.unqueue(workspaceId, id, emit)
  if (eng === 'codex' || eng === 'gemini' || eng === 'grok') return acp.unqueue(workspaceId, id, emit)
  const s = sessions.get(workspaceId)
  if (!s) return
  s.queue = s.queue.filter((m) => m.id !== id)
  emit({ type: 'queue', workspaceId, items: [...s.queue] })
}

/** Switch the mode for future sessions and, when one is live, for the running session too. */
export async function setMode(workspaceId: string, mode: PermissionMode): Promise<Workspace> {
  const ws = patchWorkspace(workspaceId, { permissionMode: mode })
  const s = sessions.get(workspaceId)
  if (s) {
    if (mode === 'bypassPermissions') {
      // The SDK only honours bypass when the session was started with the dangerous flag,
      // so restart the session; the stored session id makes the next message resume it.
      closeSession(workspaceId)
    } else {
      await s.q.setPermissionMode(mode)
    }
  }
  return ws
}

export function isBusy(workspaceId: string): boolean {
  return (sessions.get(workspaceId)?.busy ?? false) || native.isBusy(workspaceId) || acp.isBusy(workspaceId)
}

export async function interrupt(workspaceId: string): Promise<void> {
  native.interrupt(workspaceId)
  acp.interrupt(workspaceId)
  const s = sessions.get(workspaceId)
  if (!s) return
  s.interrupted = true
  try {
    await s.q.interrupt()
  } catch (err) {
    console.warn('interrupt failed', err)
  }
}


/** Drop the live session and forget the stored session id, so the next message starts fresh. */
export function resetSession(workspaceId: string): void {
  native.resetSession(workspaceId)
  acp.resetSession(workspaceId)
  closeSession(workspaceId)
  getStore().update((d) => {
    const w = d.workspaces.find((x) => x.id === workspaceId)
    if (w) delete w.sessionId
  })
}

/** Stop one running subagent (Claude Code tasks; crew workers on other engines end with their session). */
export async function stopTask(workspaceId: string, taskId: string): Promise<void> {
  const s = sessions.get(workspaceId)
  if (s && !taskId.startsWith('crew-')) await s.q.stopTask(taskId)
  resources.taskEnded(workspaceId, taskId)
}

export function closeSession(workspaceId: string): void {
  native.closeSession(workspaceId)
  acp.closeSession(workspaceId)
  resources.clearWorkspace(workspaceId)
  const s = sessions.get(workspaceId)
  if (!s) return
  s.end()
  s.abort.abort()
  sessions.delete(workspaceId)
}

export function closeAllSessions(): void {
  native.closeAll()
  acp.closeAll()
  for (const id of Array.from(sessions.keys())) closeSession(id)
}
