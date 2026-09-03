import { query, type Options, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { nanoid } from 'nanoid'
import type { AgentEvent, PermissionMode, PermissionRequest, PermissionResponse, Question, QuestionRequest, QuestionResponse, Workspace } from '@shared/types'
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getStore } from '../store'
import { getWorkspace, patchWorkspace } from './workspaces'
import { accountEnv } from './accounts'
import * as jira from './jira'
import type { McpServerSpec } from '@shared/types'

type EmitEvent = (e: AgentEvent) => void
type EmitPermission = (r: PermissionRequest) => void
type EmitQuestion = (r: QuestionRequest) => void
let emitQuestion: EmitQuestion = () => undefined
export function setQuestionEmitter(fn: EmitQuestion): void {
  emitQuestion = fn
}
const pendingQuestions = new Map<string, (r: QuestionResponse) => void>()
export function answerQuestion(response: QuestionResponse): void {
  pendingQuestions.get(response.requestId)?.(response)
}

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
  queue: { id: string; text: string }[]
  /** Set by Stop so the resulting error result is reported as a stop, not a failure. */
  interrupted: boolean
  /** Names of the MCP servers Orchestra passed to this session. */
  mcpNames: string[]
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
const pendingPermissions = new Map<string, (r: PermissionResponse) => void>()

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
  const lines = [
    `You are working inside an Orchestra workspace named "${ws.name}" that spans ${ws.repos.length} git repositories.`,
    `Each repository has its own worktree on the branch "${primary.branch}". The worktrees are:`,
    ...ws.repos.map((r) => `- ${r.repoName}: ${r.worktreePath} (branch ${r.branch}, based on ${r.baseBranch})`),
    `Your working directory is the ${primary.repoName} worktree. The other worktrees are added as additional directories; you can read and edit files in all of them.`,
    `A feature may need changes in several of these repositories. Keep the changes for each repository inside its own worktree, and run git commands from inside the worktree they apply to.`,
    `Never modify the original repositories outside these worktree paths.`
  ]
  return lines.join('\n')
}

function toSdkMcp(spec: McpServerSpec): NonNullable<Options['mcpServers']>[string] | null {
  if (spec.transport === 'stdio') return spec.command ? { type: 'stdio', command: spec.command, args: spec.args ?? [], env: spec.env } : null
  if (!spec.url) return null
  return { type: spec.transport, url: spec.url, headers: spec.headers }
}

/** App-level servers, then the space's, then the space's Jira login as the Atlassian MCP. */
async function mcpServersFor(ws: Workspace): Promise<Record<string, NonNullable<Options['mcpServers']>[string]>> {
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
    const token = await jira.accessToken(connId)
    if (token) out.jira = { type: 'http', url: jira.JIRA_MCP_URL, headers: { Authorization: `Bearer ${token}` } }
  }
  return out
}

/** The crew as SDK agent definitions, plus the paragraph that tells the orchestrator how to use it. */
function crewFor(ws: Workspace): { agents: NonNullable<Options['agents']>; prompt: string } {
  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === ws.spaceId)
  if (space?.useCrew === false) return { agents: {}, prompt: '' }
  const specs = (space?.agents ?? settings.agents).filter((a) => a.enabled && a.name.trim())
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
  if (specs.length === 0) return { agents: {}, prompt: '' }
  const prompt = [
    '',
    'You are the orchestrator of a crew. Delegate with the Agent tool when a subtask is well-specified and a cheaper or more focused agent can do it; keep planning, judgment and integration yourself. Your crew:',
    ...specs.map((a) => `- ${a.name} (${a.model}${a.effort ? `, ${a.effort} effort` : ''}): ${a.description}`),
    'When delegating, state the worktree path, the exact goal, and what a finished answer looks like. Run independent delegations in parallel. Never let two agents edit the same repository at the same time.'
  ].join('\n')
  return { agents, prompt }
}

function getOrCreateSession(workspaceId: string, emit: EmitEvent, emitPermission: EmitPermission, mcpServers: Record<string, NonNullable<Options['mcpServers']>[string]>): Session {
  const existing = sessions.get(workspaceId)
  if (existing) return existing

  const ws = getWorkspace(workspaceId)
  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === ws.spaceId)
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const others = ws.repos.filter((r) => r !== primary).map((r) => r.worktreePath)
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
      const reply = await new Promise<QuestionResponse>((resolve) => {
        pendingQuestions.set(requestId, resolve)
        emitQuestion({ requestId, workspaceId, questions })
        opts.signal.addEventListener('abort', () => {
          pendingQuestions.delete(requestId)
          resolve({ requestId, answers: {}, cancelled: true })
        })
      })
      pendingQuestions.delete(requestId)
      if (reply.cancelled) return { behavior: 'deny', message: 'The user dismissed the questions without answering. Continue with your best judgement or ask in plain text.' }
      const updatedInput: Record<string, unknown> = { questions: (toolInput as { questions?: unknown }).questions, answers: reply.answers }
      if (reply.response) updatedInput.response = reply.response
      return { behavior: 'allow', updatedInput }
    }
    const decision = await new Promise<PermissionResponse>((resolve) => {
      pendingPermissions.set(requestId, resolve)
      emitPermission({
        requestId,
        workspaceId,
        toolName,
        input: toolInput,
        blockedPath: opts.blockedPath,
        canAlwaysAllow: Boolean(opts.suggestions && opts.suggestions.length > 0)
      })
      opts.signal.addEventListener('abort', () => {
        pendingPermissions.delete(requestId)
        resolve({ requestId, decision: 'deny', message: 'Cancelled' })
      })
    })
    pendingPermissions.delete(requestId)
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
  const crew = crewFor(ws)
  const options: Options = {
    cwd: primary.worktreePath,
    additionalDirectories: others,
    permissionMode: mode,
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    model: space?.model || settings.model,
    // Opus 5 / Fable hide reasoning by default; ask for the readable summary so the Thinking block has content.
    thinking: { type: 'adaptive', display: 'summarized' },
    includePartialMessages: true,
    abortController: abort,
    canUseTool,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptFor(ws) + (Object.keys(mcpServers).length ? `\nMCP servers available in this workspace: ${Object.keys(mcpServers).join(', ')}.` : '') + crew.prompt },
    ...(Object.keys(crew.agents).length ? { agents: crew.agents } : {}),
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
    ...(space?.strictMcp ?? settings.strictMcp ? { strictMcpConfig: true } : {}),
    settingSources: ['user', 'project', 'local'],
    env: {
      ...process.env,
      ...accountEnv(ws.claudeAccountId),
      ORCHESTRA_WORKSPACE_NAME: ws.slug,
      ORCHESTRA_WORKSPACE_ROOT: ws.rootPath,
      ORCHESTRA_PORT: String(ws.port)
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
  const session: Session = { workspaceId, q, push: input.push, end: input.end, abort, busy: false, stderr: stderrLines, queue: [], interrupted: false, mcpNames: Object.keys(mcpServers) }
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
            emit({ type: 'subagent', workspaceId, parentToolUseId: msg.parent_tool_use_id, model: msg.message.model, tools, ...(text ? { text } : {}) })
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
            // Servers Orchestra configured get a warning each; everything inherited from Claude Code's own
            // config (claude.ai connectors, plugins) is folded into one quiet line, once per app run.
            const ours = new Set(session.mcpNames)
            const bad = msg.mcp_servers.filter((m) => m.status !== 'connected' && m.status !== 'pending')
            for (const m of bad) if (ours.has(m.name)) notice('warn', `MCP server "${m.name}" is ${m.status}.`)
            const inherited = bad.filter((m) => !ours.has(m.name))
            if (inherited.length && !mcpNoticeShown.has(workspaceId)) {
              mcpNoticeShown.add(workspaceId)
              const names = inherited.map((m) => `${m.name} (${m.status})`).join(', ')
              notice('info', `${inherited.length} MCP server${inherited.length === 1 ? '' : 's'} from your Claude Code config ${inherited.length === 1 ? 'is' : 'are'} not available: ${names}. Turn on "Only Orchestra's MCP servers" in the space settings to stop loading them.`)
            }
          } else if (msg.subtype === 'api_retry') {
            notice('warn', `${describeError(msg.error)} Retrying (${msg.attempt}/${msg.max_retries}) in ${Math.round(msg.retry_delay_ms / 1000)}s…`)
          } else if (msg.subtype === 'model_refusal_no_fallback') {
            notice('error', `The model declined this request${msg.api_refusal_category ? ` (${msg.api_refusal_category})` : ''}. ${msg.api_refusal_explanation ?? msg.content ?? ''}`.trim())
          } else if (msg.subtype === 'model_refusal_fallback') {
            notice('info', `Switched from ${msg.original_model} to ${msg.fallback_model} after a refusal.`)
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
          if (next) {
            emit({ type: 'queue', workspaceId, items: [...session.queue] })
            deliver(session, next.text, emit)
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
      const tail = session.stderr.slice(-5).join(' | ')
      notice('error', `The session ended unexpectedly: ${message}${tail ? ` · stderr: ${tail}` : ''}`)
      emit({ type: 'error', workspaceId, message })
    }
  } finally {
    sessions.delete(workspaceId)
    emit({ type: 'status', workspaceId, busy: false })
  }
}

function deliver(session: Session, text: string, emit: EmitEvent): void {
  const { workspaceId } = session
  session.busy = true
  emit({ type: 'user_message', workspaceId, itemId: nanoid(8), text, createdAt: new Date().toISOString() })
  emit({ type: 'status', workspaceId, busy: true })
  session.push({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null
  })
}

export async function sendMessage(workspaceId: string, text: string, emit: EmitEvent, emitPermission: EmitPermission): Promise<void> {
  const mcp = sessions.has(workspaceId) ? {} : await mcpServersFor(getWorkspace(workspaceId))
  const session = getOrCreateSession(workspaceId, emit, emitPermission, mcp)
  if (session.busy) {
    // Like the CLI: typed mid-turn, delivered when the current turn ends.
    session.queue.push({ id: nanoid(6), text })
    emit({ type: 'queue', workspaceId, items: [...session.queue] })
    return
  }
  deliver(session, text, emit)
}

export function unqueue(workspaceId: string, id: string, emit: EmitEvent): void {
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
  return sessions.get(workspaceId)?.busy ?? false
}

export async function interrupt(workspaceId: string): Promise<void> {
  const s = sessions.get(workspaceId)
  if (!s) return
  s.interrupted = true
  try {
    await s.q.interrupt()
  } catch (err) {
    console.warn('interrupt failed', err)
  }
}

export function answerPermission(response: PermissionResponse): void {
  pendingPermissions.get(response.requestId)?.(response)
}

/** Drop the live session and forget the stored session id, so the next message starts fresh. */
export function resetSession(workspaceId: string): void {
  closeSession(workspaceId)
  getStore().update((d) => {
    const w = d.workspaces.find((x) => x.id === workspaceId)
    if (w) delete w.sessionId
  })
}

export function closeSession(workspaceId: string): void {
  const s = sessions.get(workspaceId)
  if (!s) return
  s.end()
  s.abort.abort()
  sessions.delete(workspaceId)
}

export function closeAllSessions(): void {
  for (const id of Array.from(sessions.keys())) closeSession(id)
}
