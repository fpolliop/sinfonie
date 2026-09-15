import { claudeExecutableOption } from '../claude-cli'
import * as usage from '../usage'
import { defaultAccountId } from '../accounts'
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ToolLoopAgent, stepCountIs, type ToolSet } from 'ai'
import type { AgentSpec, PermissionMode, SubagentStep, Workspace } from '@shared/types'
import { classifyModel } from '@shared/types'
import { buildTools, type ToolContext } from '../native/tools'
import { resolveModel, estimateCost } from '../providers'
import { isReadOnlyCommand } from '../readonly'
import { accountEnv } from '../accounts'
import { askPermission } from '../interaction'
import * as acp from '../acp/engine'
import * as notes from '../notes'
import * as slack from '../slack'
import * as slackTools from '../slack-tools'
import { mcpServersFor } from '../agent'

const INTEGRATION_HINT: Record<string, string> = {
  jira: "Jira, with Sinfonie's Jira sign-in (mcp__jira tools: search and read issues, comment, transition).",
  linear: "Linear, with Sinfonie's Linear sign-in (mcp__linear tools).",
  gcp: "Google Cloud, read-only over the local gcloud login (mcp__gcp tools: logs, Cloud Run, error groups).",
  db: "The space's databases, read-only unless a connection allows writes (mcp__db tools)."
}

/**
 * Sinfonie's own servers every agent run gets: session notes always, Slack when connected, and the
 * same integrations a workspace session has (Jira, Linear, Google Cloud, databases, the user's MCP
 * servers). Agents see only these; Claude Code's own MCP config stays out, so a stale entry there
 * cannot shadow an integration that Sinfonie has connected.
 */
async function sinfonieServers(ws: Workspace, warn?: (text: string) => void): Promise<{ servers: NonNullable<Options['mcpServers']>; prompt: string; slackConn?: string }> {
  const servers: NonNullable<Options['mcpServers']> = { notes: notes.sdkServer(ws.id) }
  const lines = [notes.promptFor(ws.id, true)]
  let slackConn: string | undefined
  const connId = slack.connectionForSpace(ws.spaceId)
  if (slack.connection(connId).connected) {
    servers.slack = slackTools.sdkServer(connId)
    lines.push(slackTools.promptFor(connId))
    slackConn = connId
  }
  try {
    const extra = await mcpServersFor(ws, warn)
    const names = Object.keys(extra)
    Object.assign(servers, extra)
    if (names.length) lines.push('', `Integrations available to you, through Sinfonie's own sign-ins: ${names.map((n) => INTEGRATION_HINT[n] ?? `${n} (mcp__${n} tools).`).join(' ')} Use them directly; there is nothing to authorise here.`)
  } catch (err) {
    warn?.(`Integrations unavailable: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { servers, prompt: lines.join('\n'), slackConn }
}

export interface WorkerRun {
  spec: AgentSpec
  ws: Workspace
  prompt: string
  /** The workspace's permission mode; the spec's own mode wins when set. */
  mode: PermissionMode
  signal?: AbortSignal
  /** Called for every tool call or text the worker produces, for the activity tree. */
  onStep: (step: SubagentStep, model?: string) => void
  /** Token accounting for the native path. */
  onUsage?: (modelId: string, input: number, output: number) => void
}

function worktreeLines(ws: Workspace): string {
  if (ws.repos.length === 0) return '(none: this run has no code workspace; work with the tools you have, such as notes, Slack and the web)'
  return ws.repos.map((r) => `- ${r.repoName}: ${r.worktreePath}`).join('\n')
}
function whereLine(spec: AgentSpec, ws: Workspace): string {
  return ws.repos.length ? `You are the "${spec.name}" agent inside workspace "${ws.name}". Worktrees:\n${worktreeLines(ws)}` : `You are the "${spec.name}" agent, running on your own (no code workspace). Worktrees:\n${worktreeLines(ws)}`
}

function readOnlyOf(spec: AgentSpec): boolean {
  const names = (spec.tools ?? []).map((t) => t.split('(')[0])
  return names.length > 0 && !names.includes('Write') && !names.includes('Edit')
}

/**
 * Run one crew member on whatever its model reference names: a Claude model through Claude
 * Code, an API-key provider through the native loop, or a vendor agent (Codex, Gemini, Grok)
 * over ACP. Returns the worker's report for the orchestrator.
 */
export async function runWorker(run: WorkerRun): Promise<string> {
  const m = classifyModel(run.spec.model)
  if (m.kind === 'claude') return runClaude(run)
  if (m.kind === 'agent') return runAgent(run, m.engine!, m.modelId)
  return runNative(run)
}

// ---------- Claude Code (your Claude login) ----------

async function runClaude(run: WorkerRun): Promise<string> {
  const { spec, ws } = run
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const wsCwd = primary?.worktreePath ?? ws.rootPath
  const mode = spec.permissionMode ?? run.mode
  const abort = new AbortController()
  run.signal?.addEventListener('abort', () => abort.abort())
  const own = await sinfonieServers(ws, (text) => run.onStep({ kind: 'text', detail: text }))
  // An allow-list still lets the agent use Sinfonie's notes without a prompt; Slack asks unless listed.
  const allowed = spec.tools?.length ? [...spec.tools, ...(spec.tools.some((t) => t.startsWith('mcp__notes')) ? [] : ['mcp__notes'])] : undefined
  const options: Options = {
    ...claudeExecutableOption(),
    cwd: wsCwd,
    additionalDirectories: ws.repos.filter((r) => r !== primary).map((r) => r.worktreePath),
    model: spec.model,
    permissionMode: mode,
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    ...(allowed ? { allowedTools: allowed } : {}),
    ...(spec.disallowedTools?.length ? { disallowedTools: spec.disallowedTools } : {}),
    maxTurns: spec.maxTurns ?? 40,
    ...(spec.effort ? { effort: spec.effort } : {}),
    abortController: abort,
    mcpServers: own.servers,
    // Sinfonie's servers only: the CLI's own MCP entries (and their auth state) would confuse the agent.
    strictMcpConfig: true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: `\n${spec.prompt}\n\n${whereLine(spec, ws)}\nFinish with a clear report.\n${own.prompt}` },
    settingSources: ['user', 'project', 'local'],
    env: { ...process.env, ...accountEnv(ws.claudeAccountId) },
    canUseTool: async (toolName, toolInput, opts) => {
      if (toolName === 'AskUserQuestion') return { behavior: 'deny', message: 'Workers cannot ask the user; decide yourself or report the open question.' }
      const d = await askPermission({ workspaceId: ws.id, toolName: `${spec.name}: ${toolName}`, input: toolInput, blockedPath: opts.blockedPath, canAlwaysAllow: false }, opts.signal)
      return d.decision === 'deny' ? { behavior: 'deny', message: d.message || 'User denied this tool call' } : { behavior: 'allow', updatedInput: toolInput }
    },
    stderr: (d) => console.error(`[worker ${spec.name}]`, d.trimEnd())
  }
  let report = ''
  for await (const msg of query({ prompt: run.prompt, options }) as AsyncIterable<SDKMessage>) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      // Surface MCP servers that did not come up, so a silent "0 tool calls" has an explanation in the activity.
      const bad = (msg.mcp_servers ?? []).filter((s) => s.status !== 'connected' && s.status !== 'pending')
      if (bad.length) run.onStep({ kind: 'text', detail: `MCP servers not available: ${bad.map((s) => `${s.name} (${s.status})`).join(', ')}` }, msg.model)
    } else if (msg.type === 'assistant') {
      for (const b of msg.message.content) {
        if (b.type === 'tool_use') {
          const i = (b.input ?? {}) as Record<string, unknown>
          const detail = [i.command, i.file_path, i.pattern, i.description, i.query].find((v) => typeof v === 'string') as string | undefined
          run.onStep({ kind: 'tool', name: b.name, detail: (detail ?? JSON.stringify(i)).slice(0, 200) }, msg.message.model)
        } else if (b.type === 'text' && b.text.trim()) run.onStep({ kind: 'text', detail: b.text.slice(0, 600) }, msg.message.model)
      }
    } else if (msg.type === 'result') {
      try {
        usage.recordTurn(usage.fromResult(msg, { workspaceId: ws.id, spaceId: ws.spaceId ?? '', accountId: ws.claudeAccountId ?? defaultAccountId('anthropic') ?? 'default', kind: 'crew' }))
      } catch {
        /* ledger must never break the run */
      }
      if (msg.subtype === 'success') report = msg.result
      else throw new Error(`${spec.name} ended with ${msg.subtype}${'errors' in msg && Array.isArray(msg.errors) ? `: ${(msg.errors as string[]).join('; ')}` : ''}`)
    }
  }
  return report || '(no report)'
}

// ---------- native loop (API-key providers, local models) ----------

async function runNative(run: WorkerRun): Promise<string> {
  const { spec, ws } = run
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const wsCwd = primary?.worktreePath ?? ws.rootPath
  const ctx: ToolContext = { workspace: ws, roots: [...ws.repos.map((r) => r.worktreePath), ws.rootPath], cwd: wsCwd, signal: run.signal ?? new AbortController().signal }
  const all = buildTools(ctx)
  const allowed = spec.tools?.length ? new Set(spec.tools.map((t) => t.split('(')[0])) : null
  const tools: ToolSet = {}
  for (const [k, v] of Object.entries(all)) if (k !== 'AskUserQuestion' && (!allowed || allowed.has(k))) tools[k] = v
  Object.assign(tools, notes.aiTools(ws.id))
  const own = await sinfonieServers(ws)
  if (own.slackConn !== undefined) Object.assign(tools, slackTools.aiTools(own.slackConn))
  const readOnly = readOnlyOf(spec)
  const modelId = classifyModel(spec.model).modelId
  const sub = new ToolLoopAgent({
    model: resolveModel(spec.model),
    instructions: `${spec.prompt}\n\n${whereLine(spec, ws)}\n${readOnly ? 'You are read-only: do not modify files.' : ''}\nFinish with a clear report.\n${own.prompt}`,
    tools,
    stopWhen: stepCountIs(spec.maxTurns ?? 40),
    toolApproval: ({ toolCall }) => {
      if (readOnly && toolCall.toolName === 'Bash' && typeof (toolCall.input as { command?: unknown }).command === 'string' && !isReadOnlyCommand((toolCall.input as { command: string }).command)) return { type: 'denied', reason: 'This agent is read-only' }
      return undefined
    }
  })
  const result = await sub.stream({ prompt: run.prompt, abortSignal: run.signal })
  let text = ''
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') text += part.text
    else if (part.type === 'tool-call') {
      const i = part.input as Record<string, unknown>
      const detail = [i.command, i.file_path, i.pattern, i.path].find((v) => typeof v === 'string') as string | undefined
      run.onStep({ kind: 'tool', name: part.toolName, detail: (detail ?? JSON.stringify(i)).slice(0, 200) }, modelId)
    } else if (part.type === 'finish-step') {
      const u = part.usage
      run.onUsage?.(modelId, u.inputTokens ?? 0, u.outputTokens ?? 0)
    }
  }
  if (text.trim()) run.onStep({ kind: 'text', detail: text.slice(0, 600) }, modelId)
  return text || '(no report)'
}

// ---------- vendor agents over ACP (Codex, Gemini CLI, Grok Build) ----------

async function runAgent(run: WorkerRun, engine: 'codex' | 'gemini' | 'grok', model: string): Promise<string> {
  const { spec, ws } = run
  const readOnly = readOnlyOf(spec)
  const mode: PermissionMode = readOnly ? 'plan' : (spec.permissionMode ?? run.mode)
  const text = await acp.runWorker({
    engine,
    ws,
    model,
    mode,
    prompt: `${spec.prompt}\n\n${whereLine(spec, ws)}\n${readOnly ? 'You are read-only: do not modify files.' : ''}\nFinish with a clear report.\n\nTask:\n${run.prompt}`,
    signal: run.signal,
    onStep: (s) => run.onStep(s, `${engine}/${model}`)
  })
  return text || '(no report)'
}

export { estimateCost }
