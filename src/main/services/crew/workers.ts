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
  return ws.repos.map((r) => `- ${r.repoName}: ${r.worktreePath}`).join('\n')
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
  const mode = spec.permissionMode ?? run.mode
  const abort = new AbortController()
  run.signal?.addEventListener('abort', () => abort.abort())
  const options: Options = {
    cwd: primary.worktreePath,
    additionalDirectories: ws.repos.filter((r) => r !== primary).map((r) => r.worktreePath),
    model: spec.model,
    permissionMode: mode,
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    ...(spec.tools?.length ? { allowedTools: spec.tools } : {}),
    ...(spec.disallowedTools?.length ? { disallowedTools: spec.disallowedTools } : {}),
    maxTurns: spec.maxTurns ?? 40,
    ...(spec.effort ? { effort: spec.effort } : {}),
    abortController: abort,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: `\n${spec.prompt}\n\nYou are the "${spec.name}" agent inside workspace "${ws.name}". Worktrees:\n${worktreeLines(ws)}\nFinish with a clear report for the orchestrator.` },
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
    if (msg.type === 'assistant') {
      for (const b of msg.message.content) {
        if (b.type === 'tool_use') {
          const i = (b.input ?? {}) as Record<string, unknown>
          const detail = [i.command, i.file_path, i.pattern, i.description, i.query].find((v) => typeof v === 'string') as string | undefined
          run.onStep({ kind: 'tool', name: b.name, detail: (detail ?? JSON.stringify(i)).slice(0, 200) }, msg.message.model)
        } else if (b.type === 'text' && b.text.trim()) run.onStep({ kind: 'text', detail: b.text.slice(0, 600) }, msg.message.model)
      }
    } else if (msg.type === 'result') {
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
  const ctx: ToolContext = { workspace: ws, roots: ws.repos.map((r) => r.worktreePath), cwd: primary.worktreePath, signal: run.signal ?? new AbortController().signal }
  const all = buildTools(ctx)
  const allowed = spec.tools?.length ? new Set(spec.tools.map((t) => t.split('(')[0])) : null
  const tools: ToolSet = {}
  for (const [k, v] of Object.entries(all)) if (k !== 'AskUserQuestion' && (!allowed || allowed.has(k))) tools[k] = v
  const readOnly = readOnlyOf(spec)
  const modelId = classifyModel(spec.model).modelId
  const sub = new ToolLoopAgent({
    model: resolveModel(spec.model),
    instructions: `${spec.prompt}\n\nYou are the "${spec.name}" agent inside workspace "${ws.name}". Worktrees:\n${worktreeLines(ws)}\n${readOnly ? 'You are read-only: do not modify files.' : ''}\nFinish with a clear report for the orchestrator.`,
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
    prompt: `${spec.prompt}\n\nYou are the "${spec.name}" agent inside workspace "${ws.name}". Worktrees:\n${worktreeLines(ws)}\n${readOnly ? 'You are read-only: do not modify files.' : ''}\nFinish with a clear report for the orchestrator.\n\nTask:\n${run.prompt}`,
    signal: run.signal,
    onStep: (s) => run.onStep(s, `${engine}/${model}`)
  })
  return text || '(no report)'
}

export { estimateCost }
