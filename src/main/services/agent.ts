import { claudeExecutableOption } from './claude-cli'
import { query, createSdkMcpServer, tool as sdkTool, type Options, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type SpawnedProcess, type HookInput } from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'child_process'
import * as resources from './resources'
import * as browserTools from './browser/tools'
import * as previewShots from './browser/preview'
import { withWorkspaceLock } from './ws-lock'
import type { GuidedChange } from '@shared/types'
import * as workspaceTools from './workspace-tools'
import { toBase64 } from './images'
import * as usage from './usage'
import * as limits from './limits'
import { costModeFor, leanModel, leanBashCommand, leanPrompt, LEAN, LEAN_DISALLOWED } from './cost-mode'
import * as gcp from './gcp'
import * as dbTools from './db/tools'
import type { ChatImageRef } from '@shared/types'
import { z } from 'zod'
import { classifyModel } from '@shared/types'
import { runWorker } from './crew/workers'
import * as notes from './notes'
import * as designs from './designs'
import * as slack from './slack'
import * as slackTools from './slack-tools'
import os from 'os'
import { nanoid } from 'nanoid'
import type { AgentEvent, PermissionMode, PermissionRequest, Question, Space, SubagentStep, Workspace } from '@shared/types'
import { askPermission, askQuestion } from './interaction'
import * as native from './native/engine'
import * as acp from './acp/engine'
import type { Engine } from '@shared/types'
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getStore } from '../store'
import { effectivePermissionMode } from './permission-mode'
import * as library from './agents'
import { getWorkspace, patchWorkspace, assertOnDisk } from './workspaces'
import { checkpoint } from './git'
import { accountEnv } from './accounts'
import { mainSetupServersFor, signInHint } from './claude-config'
import { makeResumable } from './session-files'
import * as jira from './jira'
import * as linear from './linear'
import * as relay from './mcp-relay'
import * as apiTools from './api/tools'
import { logError } from './telemetry'
import type { McpServerSpec } from '@shared/types'
import * as teamRules from './team-rules'

type EmitEvent = (e: AgentEvent) => void
type EmitPermission = (r: PermissionRequest) => void

/** Guided mode: told which apps a turn changed, so the renderer can offer a look at the preview. */
let emitGuidedChanged: (e: Omit<GuidedChange, 'changeId'>) => void = () => undefined
export function setGuidedChangedEmitter(fn: typeof emitGuidedChanged): void {
  emitGuidedChanged = fn
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
  queue: { id: string; text: string; images?: ChatImageRef[] }[]
  /** Set by Stop so the resulting error result is reported as a stop, not a failure. */
  interrupted: boolean
  /** Names of the MCP servers Sinfonie passed to this session. */
  mcpNames: string[]
  /** The account's Claude settings folder, when it is not the main one (for sign-in hints). */
  configDir?: string
  /** Last mid-session MCP check, and the servers already reported as down (said once until they recover). */
  mcpCheckedAt?: number
  mcpDown?: Set<string>
  /** Pending tool_use ids per external crew member, so worker activity attaches to the right call. */
  crewCalls: Map<string, string[]>
  /** Set when the workspace gained a repository mid-turn: restart the session at turn end so the new worktree is a working directory. */
  flags: { restartAfterTurn: boolean; leanCalls: number; leanCapNoted: boolean; routeEdits: boolean }
  /** Lean mode: one agent, trimmed context, per-turn tool cap. */
  lean: boolean
  emitPermission: EmitPermission
  /** Cumulative per-model usage already written to the ledger (SDK totals are cumulative per session). */
  usageSeen: Record<string, { costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>
  contextWarned: boolean
  /** Last known context size and window, for the pill and for the awareness note the model gets. */
  context: { tokens: number; window?: number; notedBand: number }
  contextUsageCache?: { at: number; value: import('@shared/types').ContextUsage }
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
  authentication_failed: 'Claude Code is not logged in for this account. Open Settings → Accounts and log in.',
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
/** Failures of servers from the user's own Claude Code setup already reported this app run, as name|status. */
const inheritedWarned = new Set<string>()

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

function systemPromptFor(ws: Workspace, lean = false): string {
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
  // Test runners default to a worker per core per package; three NestJS suites under turbo took 30 GB on 2026-10-13.
  lines.push(`This Mac has ${Math.round(os.totalmem() / 1024 ** 3)} GB of memory shared with the user's other apps and agents. When you run test suites or builds, keep parallelism low: one package at a time (turbo --concurrency=1, nx --parallel=1) and few workers (jest or vitest --maxWorkers=2, pytest -n 2), and run only the tests you need.`)
  lines.push(workspaceTools.promptFor(ws.id))
  const designHint = designs.promptFor(ws.id)
  if (designHint) lines.push(designHint)
  lines.push('Context hygiene: the user pays for every token you re-read. Prefer targeted reads over whole files, avoid echoing large outputs, and when a note tells you the window is filling, suggest compacting or a new session before a fresh task.')
  if (!lean) lines.push(`Sinfonie runs on the user's Mac next to other sessions and limits you to ${resources.resourceSettings().maxSubagentsPerSession} subagents at once; under memory pressure it refuses new ones. When a delegation is refused, the tool result says why: do that work yourself or wait for running subagents instead of retrying.`)
  const guided = guidedPromptFor(ws)
  if (guided) lines.push(guided)
  const team = teamRules.promptFor(ws)
  if (team) lines.push(team)
  return lines.join('\n')
}

/**
 * Extra guidance when the person is a guided-mode user: talk in product terms, keep the app running, fix
 * before offering to ask a colleague, and follow the space's own instructions and guardrails.
 */
function guidedPromptFor(ws: Workspace): string | null {
  if (getStore().get().settings.mode !== 'guided') return null
  const space = getStore().get().spaces.find((s) => s.id === ws.spaceId)
  const g = space?.guided
  const lines = [
    '',
    'GUIDED MODE. The person you are talking to builds with AI and does not read code. Speak in plain, product terms: what changed and what it does, never file names, diffs, branches, commits or commands. Do not show code blocks unless they ask. Explain choices briefly.',
    'They cannot answer questions about implementation. Make reasonable technical decisions yourself and only ask about product intent, in their words.',
    'After a change, keep their app runnable: if you break it, fix it before replying. When something is outside what you may do here, say so in one sentence and offer to ask a teammate, rather than describing the command you would have run.',
    'When you have made a visible change, tell them to look at the Preview.'
  ]
  if (g?.instructions?.trim()) lines.push(`Team instructions for this space: ${g.instructions.trim()}`)
  if (g?.guardrails?.deny?.length) lines.push(`Never run these, even if asked: ${g.guardrails.deny.join(', ')}.`)
  const protectedBranches = [...new Set([...ws.repos.map((r) => r.baseBranch), ...(g?.guardrails?.protectedBranches ?? [])])]
  lines.push(`Never push to these protected branches: ${protectedBranches.join(', ')}. Work only on the task's own branch. Do not run git push yourself: changes go out when the person clicks Send for review.`)
  return lines.join('\n')
}

/** A hard deny-list for guided tasks, enforced before the classifier so a person never has to judge a command. */
function guidedGuardrails(ws: Workspace, space: Space | undefined): (command: string) => string | null {
  const deny = (space?.guided?.guardrails?.deny ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean)
  return (raw: string): string | null => {
    const cmd = raw.toLowerCase()
    if (/\bgit\s+push\b/.test(cmd)) return 'In guided mode, changes go out through Send for review, not by pushing. Make the change; the person will send it for review.'
    if (/\bgit\s+(reset\s+--hard|rebase|filter-branch|reflog\s+expire)\b/.test(cmd) || /\bpush\b.*--force|\+refs\//.test(cmd)) return 'That rewrites history, which is not allowed here.'
    if (/\b(drop|truncate)\s+(table|database)\b/.test(cmd) || /\bdropdb\b/.test(cmd)) return 'Changing or dropping a database is not allowed from a task.'
    if (/\brm\s+-rf?\s+[~/]/.test(cmd)) return 'Deleting files outside this task is not allowed.'
    for (const d of deny) if (cmd.includes(d)) return `Your team does not allow that here (${d}).`
    return null
  }
}

function toSdkMcp(spec: McpServerSpec): NonNullable<Options['mcpServers']>[string] | null {
  if (spec.transport === 'stdio') return spec.command ? { type: 'stdio', command: spec.command, args: spec.args ?? [], env: spec.env } : null
  if (!spec.url) return null
  return { type: spec.transport, url: spec.url, headers: spec.headers }
}

/**
 * Whether a Jira/Linear login can serve this session: connected, and not revoked. A network error does
 * not count against it (the relay retries per call); an expired login is said once, here, and never
 * opens a browser.
 */
async function loginUsable(label: string, token: () => Promise<string | null>, Revoked: new (...a: never[]) => Error, onWarning?: (text: string) => void): Promise<boolean> {
  try {
    return (await token()) !== null
  } catch (err) {
    if (err instanceof Revoked) {
      onWarning?.(`${label} tools are off for this session: ${err.message}`)
      return false
    }
    console.warn(`[mcp] ${label} token check failed; the relay will retry per call`, err)
    return true
  }
}

/** App-level servers, then the space's, then the space's Jira login as the Atlassian MCP. */
export async function mcpServersFor(ws: Workspace, onWarning?: (text: string) => void): Promise<Record<string, NonNullable<Options['mcpServers']>[string]>> {
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
    // Through the local relay, which refreshes the token per request; a static bearer would die within the hour.
    if (await loginUsable('Jira', () => jira.accessToken(connId), jira.JiraReauthRequired, onWarning)) out.jira = { type: 'http', url: await relay.relayUrl('jira', connId) }
  }
  const exposeLinear = space ? space.exposeLinearMcp !== false : true
  if (exposeLinear && !out.linear) {
    const linearConn = linear.connectionForSpace(ws.spaceId)
    if (await loginUsable('Linear', () => linear.accessToken(linearConn), linear.LinearReauthRequired, onWarning)) out.linear = { type: 'http', url: await relay.relayUrl('linear', linearConn) }
  }
  // Google Cloud: read-only tools over the user's local gcloud login, when the space (or app) names a project.
  if (gcp.gcpFor(ws.spaceId) && (space ? space.exposeGcpMcp !== false : true) && !out.gcp) out.gcp = gcp.sdkServer(ws.spaceId)
  // Databases: the space's connections, read-only unless a connection allows writes (then the permission card confirms each).
  if (ws.spaceId && (space?.databases?.length ?? 0) > 0 && !out.db) out.db = dbTools.sdkServer(ws.spaceId, ws.id)
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
  const all = library.crewFor(ws.spaceId)
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
    const mode = effectivePermissionMode(ws, space, settings)
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
  assertOnDisk(ws)
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const wsCwd = primary?.worktreePath ?? ws.rootPath
  // The session may have been recorded under another folder (before the first repository was added, or under another primary).
  const resumeId = ws.sessionId && makeResumable(ws, ws.sessionId) ? ws.sessionId : undefined
  if (ws.sessionId && !resumeId) {
    // Forget it, so a session that fails before starting doesn't search and warn again on every retry.
    patchWorkspace(workspaceId, { sessionId: undefined })
    emit({ type: 'notice', workspaceId, itemId: nanoid(8), level: 'warn', text: "Claude couldn't find the earlier conversation, so this message starts a new one. The chat above stays.", createdAt: new Date().toISOString() })
  }
  const others = ws.repos.filter((r) => r !== primary).map((r) => r.worktreePath)
  // A second Claude account has its own settings folder, which hides the main setup's MCP servers: pass them in.
  const configDir = accountEnv(ws.claudeAccountId).CLAUDE_CONFIG_DIR
  const fromMainSetup = (space?.strictMcp ?? settings.strictMcp) ? {} : mainSetupServersFor(configDir)
  for (const [name, cfg] of Object.entries(fromMainSetup)) if (!mcpServers[name]) mcpServers = { ...mcpServers, [name]: cfg }
  const flags = { restartAfterTurn: false, leanCalls: 0, leanCapNoted: false, routeEdits: false }
  const costMode = costModeFor(ws.spaceId, ws.id)
  const budget = costMode === 'budget'
  const lean = costMode === 'lean'
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
    // Lean mode trims shell output here for the modes that ask; bypass mode gets the same trim from the hook below.
    const finalInput = lean && toolName === 'Bash' && typeof (toolInput as { command?: unknown }).command === 'string' ? { ...toolInput, command: leanBashCommand((toolInput as { command: string }).command) } : toolInput
    const r: PermissionResult = {
      behavior: 'allow',
      updatedInput: finalInput,
      ...(decision.decision === 'always' && opts.suggestions ? { updatedPermissions: opts.suggestions } : {})
    }
    return r
  }

  const stoppedContext = (hookEventName: 'PostToolUse' | 'PostToolUseFailure') => {
    const note = resources.takeStoppedNote(workspaceId)
    return note ? { hookSpecificOutput: { hookEventName, additionalContext: note } } : {}
  }
  const mode = effectivePermissionMode(ws, space, settings)
  const guardrails = settings.mode === 'guided' ? guidedGuardrails(ws, space) : null
  const crewCalls = new Map<string, string[]>()
  const crew = lean ? { agents: {}, prompt: '' } : crewFor(ws, emit, crewCalls)
  if (crew.server) mcpServers = { ...mcpServers, crew: crew.server }
  // Lean keeps only the workspace tools (two small ones) and whatever MCP servers the user configured themselves.
  // Sinfonie's own Slack tools (the user's sign-in, refreshed per call), unless the user configured a "slack" server of their own.
  const slackConn = slack.connectionForSpace(ws.spaceId)
  const ownSlack = !lean && !mcpServers.slack && slack.connection(slackConn).connected
  // The API explorer's endpoints and request runner, for workspaces with code.
  const ownApi = !lean && !mcpServers.api && ws.repos.length > 0
  mcpServers = lean ? { ...mcpServers, workspace: workspaceTools.sdkServer(ws.id, () => (flags.restartAfterTurn = true)) } : { ...mcpServers, notes: notes.sdkServer(ws.id), browser: browserTools.sdkServer(ws.id), workspace: workspaceTools.sdkServer(ws.id, () => (flags.restartAfterTurn = true)), ...(ownSlack ? { slack: slackTools.sdkServer(slackConn) } : {}), ...(ownApi ? { api: apiTools.sdkServer(ws.id) } : {}) }
  const options: Options = {
    ...claudeExecutableOption(),
    cwd: wsCwd,
    additionalDirectories: others,
    permissionMode: mode,
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    model: budget || lean ? leanModel(space?.model || settings.model) : space?.model || settings.model,
    // No maxBudgetUsd: the SDK applies it to the whole session and then ends it with an error; the per-turn brake is the tool cap in the hook below.
    ...(budget ? { effort: 'low' as const } : {}),
    ...(lean ? { effort: LEAN.effort, disallowedTools: LEAN_DISALLOWED } : {}),
    // Opus 5 / Fable hide reasoning by default; ask for the readable summary so the Thinking block has content.
    thinking: { type: 'adaptive', display: 'summarized' },
    includePartialMessages: true,
    abortController: abort,
    canUseTool,
    systemPrompt: lean
      ? { type: 'preset', preset: 'claude_code', append: systemPromptFor(ws, true) + (Object.keys(mcpServers).length ? `\nMCP servers available in this workspace: ${Object.keys(mcpServers).join(', ')}.` : '') + (mcpServers.gcp ? gcp.promptFor(ws.spaceId) : '') + (mcpServers.db && ws.spaceId ? dbTools.promptFor(ws.spaceId) : '') + notes.standingPrompt(ws.id) + leanPrompt() }
      : { type: 'preset', preset: 'claude_code', append: systemPromptFor(ws) + (Object.keys(mcpServers).length ? `\nMCP servers available in this workspace: ${Object.keys(mcpServers).join(', ')}.` : '') + crew.prompt + notes.promptFor(ws.id, true) + (ownSlack ? '\n' + slackTools.promptFor(slackConn) : '') + (ownApi ? '\n' + apiTools.promptFor() : '') + (mcpServers.gcp ? gcp.promptFor(ws.spaceId) : '') + (mcpServers.db && ws.spaceId ? dbTools.promptFor(ws.spaceId) : '') + '\n' + browserTools.promptFor(ws.port) },
    ...(Object.keys(crew.agents).length ? { agents: crew.agents } : {}),
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
    ...(space?.strictMcp ?? settings.strictMcp ? { strictMcpConfig: true } : {}),
    settingSources: ['user', 'project', 'local'],
    // db_query is allowed too: read-only runs need no prompt, and writes ask through the tool's own permission card.
    allowedTools: lean ? [...workspaceTools.SDK_ALLOWED, ...gcp.SDK_ALLOWED, ...dbTools.SDK_ALLOWED] : [...browserTools.sdkAllowedTools(), ...workspaceTools.SDK_ALLOWED, ...gcp.SDK_ALLOWED, ...dbTools.SDK_ALLOWED, ...(ownSlack ? slackTools.SDK_READ_ALLOWED : []), ...(ownApi ? apiTools.SDK_ALLOWED : [])],
    hooks: {
      PreToolUse: [
        // Before the first route edit, keep the endpoint list as it was, to diff against after the turn.
        { matcher: 'Edit|Write|MultiEdit', hooks: [async (raw: HookInput) => (ownApi && apiTools.isRouteFile(ws.id, editedFile(raw)) && (await Promise.race([apiTools.ensureBaseline(ws.id).catch(() => undefined), new Promise((r) => setTimeout(r, 15_000))])), {})] },
        ...(lean || budget
          ? [
              {
                hooks: [
                  async (raw: HookInput) => {
                    const cap = lean ? LEAN.toolCap : LEAN.budgetToolCap
                    const input = raw as { tool_name?: string; tool_input?: unknown }
                    const toolInput = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>
                    flags.leanCalls += 1
                    if (flags.leanCalls > cap) {
                      if (!flags.leanCapNoted) {
                        flags.leanCapNoted = true
                        emit({ type: 'notice', workspaceId, itemId: nanoid(8), level: 'info', text: `${lean ? 'Lean' : 'Budget'} mode: ${cap} tool calls this turn. The agent stops here and reports; say "continue" to go on.`, createdAt: new Date().toISOString() })
                      }
                      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: `${lean ? 'Lean' : 'Budget'} mode: ${cap} tool calls used this turn. Stop now, report what is done and what remains in a few lines, and wait for the user.` } }
                    }
                    // Bypass mode never reaches canUseTool, so trim shell output here.
                    if (lean && mode === 'bypassPermissions' && input.tool_name === 'Bash' && typeof toolInput.command === 'string') {
                      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, updatedInput: { ...toolInput, command: leanBashCommand(toolInput.command) } } }
                    }
                    return {}
                  }
                ]
              }
            ]
          : []),
        ...(guardrails
          ? [
              {
                matcher: 'Bash',
                hooks: [
                  async (raw: HookInput) => {
                    const command = (raw as { tool_input?: { command?: unknown } }).tool_input?.command
                    if (typeof command !== 'string') return {}
                    const reason = guardrails(command)
                    if (reason) return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } }
                    return {}
                  }
                ]
              }
            ]
          : []),
        // Team guardrails (team-rules.ts): hooks run in every permission mode, bypass included, and for subagents.
        {
          matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
          hooks: [
            async (raw: HookInput) => {
              const input = raw as { tool_name?: string; tool_input?: unknown; cwd?: string }
              const reason = teamRules.toolVeto(getWorkspace(workspaceId), input.tool_name ?? '', input.tool_input, input.cwd)
              if (!reason) return {}
              if (getStore().get().settings.mode !== 'guided') emit({ type: 'notice', workspaceId, itemId: nanoid(8), level: 'warn', text: `Guardrail: ${reason}`, createdAt: new Date().toISOString() })
              return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } }
            }
          ]
        },
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
      ],
      // A command the resource governor stopped fails with a bare signal; say why, so the agent does not rerun it as it was.
      PostToolUse: [
        { matcher: 'Bash', hooks: [async () => stoppedContext('PostToolUse')] },
        // An edit to a route file: rescan the endpoints after the turn and tell the agent what changed.
        { matcher: 'Edit|Write|MultiEdit', hooks: [async (raw: HookInput) => (ownApi && apiTools.isRouteFile(ws.id, editedFile(raw)) && (flags.routeEdits = true), {})] }
      ],
      UserPromptSubmit: [
        {
          hooks: [
            async () => {
              const note = ownApi ? apiTools.takeNote(ws.id) : undefined
              return note ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' as const, additionalContext: note } } : {}
            }
          ]
        }
      ],
      PostToolUseFailure: [{ matcher: 'Bash', hooks: [async () => stoppedContext('PostToolUseFailure')] }]
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
    ...(resumeId ? { resume: resumeId } : {})
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
  const session: Session = { workspaceId, q, push: input.push, end: input.end, abort, busy: false, stderr: stderrLines, queue: [], interrupted: false, mcpNames: Object.keys(mcpServers).filter((n) => n !== 'crew' && n !== 'notes' && n !== 'browser' && n !== 'workspace' && n !== 'api' && !(n in fromMainSetup)), configDir, crewCalls, flags, lean, emitPermission, usageSeen: {}, contextWarned: false, context: { tokens: 0, notedBand: 0 } }
  sessions.set(workspaceId, session)
  void pump(session, emit)
  return session
}

/**
 * After a turn: Sinfonie's MCP servers can drop mid-session (a network change, a server restart) and the
 * SDK does not bring them back. Reconnect any that failed, and say so only when that does not help.
 */
async function checkMcp(session: Session, notice: (level: 'info' | 'warn' | 'error', text: string) => void): Promise<void> {
  if (session.mcpCheckedAt && Date.now() - session.mcpCheckedAt < 60_000) return
  session.mcpCheckedAt = Date.now()
  const down = (session.mcpDown ??= new Set())
  try {
    const ours = new Set(session.mcpNames)
    for (const m of await session.q.mcpServerStatus()) {
      if (!ours.has(m.name)) {
        // The user's own servers: bring a dropped one back quietly; the init notice already said if it never worked.
        if (m.status === 'failed') await session.q.reconnectMcpServer(m.name).catch(() => undefined)
        continue
      }
      if (m.status === 'connected' || m.status === 'pending' || m.status === 'disabled') {
        down.delete(m.name)
        continue
      }
      if (m.status === 'failed') {
        await session.q.reconnectMcpServer(m.name).catch(() => undefined)
        const now = (await session.q.mcpServerStatus()).find((x) => x.name === m.name)
        if (now?.status === 'connected') {
          console.info(`[mcp ${session.workspaceId}] reconnected ${m.name}`)
          down.delete(m.name)
          continue
        }
      }
      if (down.has(m.name)) continue
      down.add(m.name)
      const why = m.status === 'needs-auth' ? 'needs signing in again' : `disconnected${m.error ? ` (${m.error})` : ''} and could not reconnect`
      notice('warn', `MCP server "${m.name}" ${why}. Its tools are unavailable until it is back; Sinfonie tries again after each turn.`)
    }
  } catch (err) {
    console.warn(`[mcp ${session.workspaceId}] status check failed`, err)
  }
}

/** The file an Edit/Write/MultiEdit hook input touches. */
function editedFile(raw: HookInput): string {
  const input = (raw as { tool_input?: { file_path?: unknown } }).tool_input
  return typeof input?.file_path === 'string' ? input.file_path : ''
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
  // Guided change cards: the files this turn edited (paths only) and its last assistant message, taken at turn end.
  const toolNames = new Map<string, string>()
  let turnEdits: { name: string; input: Record<string, unknown> }[] = []
  const notice = (level: 'info' | 'warn' | 'error', text: string): void =>
    emit({ type: 'notice', workspaceId, itemId: nanoid(8), level, text, createdAt: new Date().toISOString() })
  try {
    for await (const msg of session.q as AsyncIterable<SDKMessage>) {
      logMsg(workspaceId, msg)
      switch (msg.type) {
        case 'assistant':
          if (msg.error && !msg.parent_tool_use_id) notice('error', describeError(msg.error))
          if (!msg.parent_tool_use_id && msg.message.usage) {
            const u = msg.message.usage as { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
            const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
            if (tokens > 0) {
              usage.recordContext(workspaceId, tokens)
              session.context.tokens = tokens
              session.contextUsageCache = undefined
              emit({ type: 'context', workspaceId, tokens, window: session.context.window, cacheRead: u.cache_read_input_tokens ?? 0 })
              if (!session.contextWarned && tokens >= usage.settings().contextWarnTokens) {
                session.contextWarned = true
                notice('warn', `This session now carries about ${Math.round(tokens / 1000)}k tokens of context, and every message re-reads them. For the next task, start a new session (the button next to Send); it is the single biggest saving on a subscription.`)
              }
            }
          }
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
          const ws = getWorkspace(workspaceId)
          usage.recordLimit(limits.accountIdOf(ws), r)
          if (r.status === 'rejected') {
            notice('error', `Rate limit hit (${r.rateLimitType ?? 'usage'})${r.resetsAt ? `, resets ${new Date(r.resetsAt * 1000).toLocaleTimeString()}` : ''}.`)
            emit(limits.hitEvent(ws, r))
          } else if (r.status === 'allowed_warning' && r.utilization != null) notice('warn', `Approaching the ${r.rateLimitType ?? 'usage'} limit: ${Math.round(r.utilization * 100)}% used.`)
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
            for (const m of bad) {
              if (!ours.has(m.name)) continue
              ;(session.mcpDown ??= new Set()).add(m.name)
              notice('warn', `MCP server "${m.name}" is ${m.status}. Sinfonie tries to reconnect it after each turn.`)
            }
            // Servers from the user's own Claude Code setup (and claude.ai connectors): each failure is said once per
            // app run with what fixes it, instead of one quiet line that hid a dead Jira or Slack.
            const fresh = bad.filter((m) => !ours.has(m.name) && !inheritedWarned.has(`${m.name}|${m.status}`))
            for (const m of fresh) inheritedWarned.add(`${m.name}|${m.status}`)
            if (fresh.length) {
              const how = (m: { name: string; status: string }) =>
                m.status === 'needs-auth' ? (m.name.startsWith('claude.ai ') ? `${m.name}: needs connecting again at claude.ai, Settings, Connectors.` : `${m.name}: needs signing in again; ${signInHint(session.configDir)}.`) : m.status === 'disabled' ? `${m.name}: turned off in your Claude Code settings.` : `${m.name}: failed to start. Check it with \`claude mcp list\`${session.configDir ? ` (with CLAUDE_CONFIG_DIR=${session.configDir})` : ''}.`
              const names = fresh.map((m) => m.name).join(', ')
              // First paragraph is the summary; the lines after the blank line fold behind "Details".
              notice('warn', `${fresh.length === 1 ? 'An MCP server' : `${fresh.length} MCP servers`} from your Claude Code setup ${fresh.length === 1 ? 'is' : 'are'} not working in this session: ${names}. Their tools are unavailable until fixed; Sinfonie's own integrations are not affected.\n\n${fresh.map(how).join('\n')}\nTo load only Sinfonie's servers, turn on "Only Sinfonie's MCP servers" in the space settings.`)
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
          } else if (msg.subtype === 'compact_boundary') {
            const m = msg.compact_metadata
            const post = m.post_tokens
            session.context.tokens = post ?? 0
            session.context.notedBand = 0
            session.contextWarned = false
            session.contextUsageCache = undefined
            notice('info', `${m.trigger === 'manual' ? 'Compacted' : 'Auto-compacted'} the conversation: ${Math.round(m.pre_tokens / 1000)}k tokens summarised${post ? ` into ${Math.round(post / 1000)}k` : ''}. Earlier detail is now a summary; the work continues from here.`)
            emit({ type: 'context', workspaceId, tokens: post ?? 0, window: session.context.window, compacted: { pre: m.pre_tokens, post, trigger: m.trigger } })
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
              toolNames.set(block.id, block.name)
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
              const name = toolNames.get(toolUseId) ?? ''
              if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name) && input && typeof input === 'object') {
                const i = input as Record<string, unknown>
                turnEdits.push({ name, input: { file_path: i.file_path, notebook_path: i.notebook_path, path: i.path } })
              }
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
          previewShots.turnEnded(workspaceId)
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
          void checkMcp(session, notice)
          if (session.flags.routeEdits) {
            session.flags.routeEdits = false
            void apiTools
              .afterRouteEdits(workspaceId)
              .then((t) => t && notice('info', t))
              .catch((err) => console.warn('[api] rescan after route edits failed', err))
          }
          try {
            const wsNow = getWorkspace(workspaceId)
            usage.recordTurn(usage.fromResult(msg, { workspaceId, spaceId: wsNow.spaceId ?? '', accountId: limits.accountIdOf(wsNow), kind: 'chat' }, session.usageSeen))
            const windows = Object.values(msg.modelUsage ?? {}).map((u) => u.contextWindow).filter((n) => n > 0)
            if (windows.length) session.context.window = Math.max(...windows)
          } catch {
            /* ledger must never break the turn */
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
          // Guided mode: checkpoint whatever the assistant changed this turn, so "changes not sent for review"
          // is honest and nothing is lost between turns (partial or interrupted work included). Never pushed;
          // Send for review does that.
          // The card belongs to this turn: its last message and edits, taken now (a queued turn may already be starting).
          const edits = turnEdits.slice(-200)
          const afterItemId = itemId || null
          turnEdits = []
          toolNames.clear()
          if (getStore().get().settings.mode === 'guided') {
            const wsNow = getWorkspace(workspaceId)
            // One lock with "Undo this change" (builder.ts), so the two never touch the same worktree at once.
            void withWorkspaceLock(workspaceId, () =>
              Promise.all(
                wsNow.repos.map(async (r) => {
                  const sha = await checkpoint(r.worktreePath, `Checkpoint: ${wsNow.name}`).catch((err) => (logError('guided.checkpoint', err, { workspaceId }), null))
                  const repo = getStore().get().repos.find((x) => x.id === r.repoId)
                  return sha ? { app: repo?.displayName || r.repoName, repoId: r.repoId, sha } : null
                })
              )
            ).then((changed) => {
              const hits = changed.filter((a): a is { app: string; repoId: string; sha: string } => Boolean(a))
              if (hits.length) emitGuidedChanged({ workspaceId, apps: hits.map((h) => h.app), checkpoints: hits.map(({ repoId, sha }) => ({ repoId, sha })), afterItemId, edits })
            })
          }
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

/** A short note the model sees (the user does not) when the window is filling, so it can suggest compacting. */
function contextNote(session: Session): string {
  const { tokens, window } = session.context
  if (!tokens) return ''
  const pct = window ? tokens / window : tokens / 200_000
  // Lean mode nudges earlier: every extra 100k in context is re-read on each call.
  const [hi, lo] = session.lean ? [0.6, 0.4] : [0.8, 0.6]
  const band = pct >= hi ? 2 : pct >= lo ? 1 : 0
  if (band === 0 || band <= session.context.notedBand) return ''
  session.context.notedBand = band
  return `[Sinfonie: this conversation now uses about ${Math.round(pct * 100)}% of the context window (${Math.round(tokens / 1000)}k tokens). Every message re-reads it. If the remaining work is separable from what came before, tell the user in one sentence that compacting the conversation (the Compact button next to the model) or starting a new session would save tokens, then continue.]\n\n`
}

function deliver(session: Session, text: string, emit: EmitEvent, announce = true, images?: ChatImageRef[]): void {
  const { workspaceId } = session
  // Guided mode: a picture of the preview before this turn, for the change card if the turn changes the app.
  previewShots.beforeTurn(workspaceId)
  session.busy = true
  session.flags.leanCalls = 0
  session.flags.leanCapNoted = false
  const note = text.startsWith('/') ? '' : contextNote(session)
  if (announce) emit({ type: 'user_message', workspaceId, itemId: nanoid(8), text, createdAt: new Date().toISOString(), ...(images?.length ? { images } : {}) })
  emit({ type: 'status', workspaceId, busy: true })
  session.push({
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...(images ?? []).map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mimeType as 'image/png', data: toBase64(img) } })),
        { type: 'text' as const, text: note + (text || (images?.length ? 'See the attached image.' : '')) }
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
  return ws.engine ?? spaces.find((s) => s.id === ws.spaceId)?.engine ?? settings.engine ?? 'claude-code'
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

/** Restart the session when the running turn ends (settings changed mid-turn); the conversation resumes. */
export function restartAfterTurn(workspaceId: string): boolean {
  const s = sessions.get(workspaceId)
  if (!s) return false
  s.flags.restartAfterTurn = true
  return true
}

/** Other runtimes that can be busy for a workspace (the CLI mode registers itself). */
const extraBusy: ((workspaceId: string) => boolean)[] = []
export function addBusySource(fn: (workspaceId: string) => boolean): void {
  extraBusy.push(fn)
}
export function isBusy(workspaceId: string): boolean {
  return (sessions.get(workspaceId)?.busy ?? false) || native.isBusy(workspaceId) || acp.isBusy(workspaceId) || extraBusy.some((f) => f(workspaceId))
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

/** Ask the live session to summarise itself. Delivered as the /compact command; the boundary message reports the result. */
export function compact(workspaceId: string, emit: EmitEvent): void {
  const s = sessions.get(workspaceId)
  if (!s) throw new Error('No live session to compact. The next message resumes the conversation; compact after that.')
  if (s.busy) throw new Error('Wait for the current turn to finish, then compact.')
  emit({ type: 'notice', workspaceId, itemId: nanoid(8), level: 'info', text: 'Compacting the conversation…', createdAt: new Date().toISOString() })
  deliver(s, '/compact', emit, false)
}

/** Claude Code's own breakdown of what fills the window right now; cached briefly since it calls the token counter. */
export async function contextUsage(workspaceId: string): Promise<import('@shared/types').ContextUsage | null> {
  const s = sessions.get(workspaceId)
  if (!s) return null
  if (s.contextUsageCache && Date.now() - s.contextUsageCache.at < 15_000) return s.contextUsageCache.value
  const r = (await s.q.getContextUsage({ detail: s.busy ? 'summary' : 'full' })) as unknown as {
    model: string
    total_tokens: number
    raw_max_tokens: number
    percentage: number
    over_limit?: { tokens_over: number; kind: 'hard_limit' | 'compaction_window' }
    categories: { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }[]
    mcp_tools: { name: string; server_name: string; tokens: number }[]
    memory_files: { path: string; type: string; tokens: number }[]
    agents: { agent_type: string; source: string; tokens: number }[]
    skills?: { name: string; source: string; tokens: number }[]
  }
  const value = {
    model: r.model,
    totalTokens: r.total_tokens,
    maxTokens: r.raw_max_tokens,
    percentage: r.percentage,
    overLimit: r.over_limit ? { tokensOver: r.over_limit.tokens_over, kind: r.over_limit.kind } : undefined,
    categories: r.categories ?? [],
    mcpTools: (r.mcp_tools ?? []).map((t) => ({ name: t.name, serverName: t.server_name, tokens: t.tokens })),
    memoryFiles: r.memory_files ?? [],
    agents: (r.agents ?? []).map((a) => ({ agentType: a.agent_type, source: a.source, tokens: a.tokens })),
    skills: r.skills ?? [],
    at: new Date().toISOString()
  }
  s.context.window = value.maxTokens || s.context.window
  s.contextUsageCache = { at: Date.now(), value }
  return value
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
