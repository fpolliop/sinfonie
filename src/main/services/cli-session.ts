/**
 * CLI mode for a workspace: the real `claude` running interactively in a pty, configured the way the
 * chat would configure the SDK (account, permission mode, model, other worktrees, crew, MCP servers),
 * resuming the workspace's session so a conversation can move between Chat and CLI without loss.
 *
 * Sinfonie stays in the loop from the outside: the CLI writes every message to its session file, and
 * this service tails that file and replays it as the same agent events the SDK path emits, so the
 * chat transcript, the phone, cost tracking and context size all keep working while the CLI runs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { createServer, type IncomingMessage, type Server } from 'http'
import type { AddressInfo } from 'net'
import { homedir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { nanoid } from 'nanoid'
import * as interaction from './interaction'
import * as remote from './remote'
import { getStore } from '../store'
import { effectivePermissionMode } from './permission-mode'
import * as terminal from './terminal'
import * as agent from './agent'
import * as usage from './usage'
import * as limits from './limits'
import { accountForEngine, envForAccount } from './accounts'
import { claudeBinary } from './claude-cli'
import { workspaceEnv } from './scripts'
import { getRepo, getWorkspace, patchWorkspace } from './workspaces'
import { CLAUDE_MODELS, classifyModel } from '@shared/types'
import type { AgentEvent, CliStatus, Workspace } from '@shared/types'

type Emit = (e: AgentEvent) => void
let emit: Emit = () => undefined
export function setEmitter(fn: Emit): void {
  emit = fn
}

interface Live {
  workspaceId: string
  terminalId: string
  cwd: string
  projectDir: string
  startedAt: number
  sessionId: string | null
  file: string | null
  offset: number
  /** Assistant message ids whose usage was already recorded. */
  seen: Set<string>
  /** The assistant item currently open, so a run of blocks becomes one chat item. */
  openItem: string | null
  busy: boolean
  timer: NodeJS.Timeout
  /** Secret in the hook URL, so only this session's hooks reach us. */
  hookToken: string
  /** In-flight permission asks, so a stopped CLI does not leave cards behind. */
  aborts: Set<AbortController>
}
const live = new Map<string, Live>()
agent.addBusySource((id) => live.get(id)?.busy ?? false)

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
/** Claude keys its session folder by the working directory, with every / and . turned into -. */
const projectKey = (cwd: string): string => cwd.replace(/[/.]/g, '-')

export function status(workspaceId: string): CliStatus {
  const l = live.get(workspaceId)
  return { running: Boolean(l), terminalId: l?.terminalId ?? null, sessionId: l?.sessionId ?? getWorkspace(workspaceId).sessionId ?? null }
}

/** Starts (or returns) the CLI for a workspace. `prompt` becomes the first message; the stored session is resumed. */
export async function start(workspaceId: string, opts: { prompt?: string; fresh?: boolean; cols?: number; rows?: number } = {}): Promise<CliStatus> {
  const existing = live.get(workspaceId)
  if (existing) return status(workspaceId)
  const ws = getWorkspace(workspaceId)
  if (ws.status !== 'ready') throw new Error('The workspace is not ready yet.')
  // The SDK must let go of the session file before the CLI resumes it.
  agent.closeSession(workspaceId)

  const { settings, spaces } = getStore().get()
  const space = spaces.find((s) => s.id === ws.spaceId)
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const cwd = primary?.worktreePath ?? ws.rootPath
  const repo = getRepo(primary?.repoId ?? ws.primaryRepoId)
  const acc = accountForEngine('claude-code', ws.claudeAccountId)
  const env: NodeJS.ProcessEnv = { ...workspaceEnv(ws, repo, cwd), ...envForAccount(acc), CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' }
  // A Sinfonie started from inside a Claude session inherits markers that make claude treat itself as a child and skip the transcript we tail.
  delete env.CLAUDE_CODE_CHILD_SESSION
  delete env.CLAUDECODE
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const projectDir = join(configDir, 'projects', projectKey(cwd))

  const args: string[] = []
  for (const r of ws.repos) if (r.worktreePath !== cwd) args.push('--add-dir', q(r.worktreePath))
  const mode = effectivePermissionMode(ws, space, settings)
  if (mode === 'acceptEdits' || mode === 'plan' || mode === 'bypassPermissions') args.push('--permission-mode', mode)
  const model = space?.model ?? settings.model
  if (model) args.push('--model', q(model))
  // The crew: members on Claude models become the CLI's subagents, the same definitions the SDK gets.
  if (space?.useCrew !== false) {
    const crew = (space?.agents ?? settings.agents).filter((a) => a.enabled && a.name.trim() && classifyModel(a.model).kind === 'claude')
    if (crew.length) {
      const defs = Object.fromEntries(crew.map((a) => [a.name, { description: a.description, prompt: a.prompt, model: a.model, ...(a.tools?.length ? { tools: a.tools } : {}), ...(a.disallowedTools?.length ? { disallowedTools: a.disallowedTools } : {}) }]))
      args.push('--agents', q(JSON.stringify(defs)))
    }
  }
  // MCP servers the CLI can reach: everything with a URL or a command. In-process ones (crew, gcp, db) need the Sinfonie MCP endpoint, later.
  const servers = await agent.mcpServersFor(ws).catch(() => ({}))
  const external = Object.fromEntries(Object.entries(servers).filter(([, s]) => (s as { type?: string }).type !== 'sdk'))
  if (Object.keys(external).length) {
    const dir = join(app.getPath('userData'), 'cli')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${workspaceId}.mcp.json`)
    writeFileSync(file, JSON.stringify({ mcpServers: external }))
    args.push('--mcp-config', q(file))
  }
  // Hooks: Claude calls back into Sinfonie before tools run (permission cards, phone), on stop, on notifications.
  const hookToken = nanoid(24)
  const port = await hookPort()
  const hook = (event: string, timeout: number): object => ({ hooks: [{ type: 'command', command: `curl -sS -m ${timeout} -X POST --data-binary @- 'http://127.0.0.1:${port}/hook/${workspaceId}/${hookToken}/${event}'`, timeout }] })
  const settingsFile = join(app.getPath('userData'), 'cli', `${workspaceId}.settings.json`)
  mkdirSync(join(app.getPath('userData'), 'cli'), { recursive: true })
  writeFileSync(settingsFile, JSON.stringify({ hooks: { PreToolUse: [hook('PreToolUse', 3600)], UserPromptSubmit: [hook('UserPromptSubmit', 10)], Stop: [hook('Stop', 10)], Notification: [hook('Notification', 10)] } }))
  args.push('--settings', q(settingsFile))
  const resumeId = !opts.fresh && ws.sessionId ? ws.sessionId : null
  if (resumeId) args.push('--resume', q(resumeId))
  // The prompt goes first: --add-dir takes a list, and a trailing positional would be read as a directory.
  const command = [q(claudeBinary()), ...(opts.prompt?.trim() ? [q(opts.prompt.trim())] : []), ...args].join(' ')

  const startedAt = Date.now()
  const terminalId = terminal.createTerminal(
    cwd,
    env,
    (tid, data) => terminalData?.(tid, data),
    (tid, code) => {
      terminalExit?.(tid, code)
      const l = live.get(workspaceId)
      if (l && l.terminalId === tid) stop(workspaceId)
    },
    command,
    opts.cols && opts.rows ? { cols: opts.cols, rows: opts.rows } : undefined
  )
  const l: Live = { workspaceId, terminalId, cwd, projectDir, startedAt, sessionId: resumeId, file: resumeId ? join(projectDir, `${resumeId}.jsonl`) : null, offset: 0, seen: new Set(), openItem: null, busy: Boolean(opts.prompt), timer: setInterval(() => poll(l), 700), hookToken, aborts: new Set() }
  // Resuming: skip what the chat already has; only lines the CLI appends from now on are replayed.
  if (l.file && existsSync(l.file)) l.offset = statSync(l.file).size
  live.set(workspaceId, l)
  if (opts.prompt?.trim()) emit({ type: 'status', workspaceId, busy: true })
  return status(workspaceId)
}

/** Data and exit go through the same terminal events the Terminal tab uses; ipc wires these. */
let terminalData: ((terminalId: string, data: string) => void) | null = null
let terminalExit: ((terminalId: string, code: number) => void) | null = null
export function setTerminalEmitters(onData: (terminalId: string, data: string) => void, onExit: (terminalId: string, code: number) => void): void {
  terminalData = onData
  terminalExit = onExit
}

export function stop(workspaceId: string): CliStatus {
  const l = live.get(workspaceId)
  if (!l) return status(workspaceId)
  clearInterval(l.timer)
  poll(l)
  for (const a of l.aborts) a.abort()
  terminal.disposeTerminal(l.terminalId)
  live.delete(workspaceId)
  if (l.openItem) emit({ type: 'assistant_end', workspaceId, itemId: l.openItem })
  emit({ type: 'status', workspaceId, busy: false })
  return status(workspaceId)
}
export function stopAll(): void {
  for (const id of Array.from(live.keys())) stop(id)
}

// ---------- transcript tail ----------

function poll(l: Live): void {
  try {
    if (!l.file) {
      if (!existsSync(l.projectDir)) return
      // A new session: the newest transcript created after we launched belongs to this CLI.
      const candidates = readdirSync(l.projectDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, m: statSync(join(l.projectDir, f)).mtimeMs }))
        .filter((x) => x.m >= l.startedAt - 2000)
        .sort((a, b) => b.m - a.m)
      if (!candidates.length) return
      l.file = join(l.projectDir, candidates[0].f)
      l.sessionId = candidates[0].f.replace(/\.jsonl$/, '')
      patchWorkspace(l.workspaceId, { sessionId: l.sessionId })
      emit({ type: 'init', workspaceId: l.workspaceId, sessionId: l.sessionId, model: '', cwd: l.cwd })
    }
    if (!existsSync(l.file)) return
    const size = statSync(l.file).size
    if (size <= l.offset) return
    // Byte-accurate: the offset is in bytes and the file has non-ASCII text.
    const buf = readFileSync(l.file).subarray(l.offset)
    // Only whole lines; a partially written line waits for the next poll.
    const cut = buf.lastIndexOf(0x0a)
    if (cut < 0) return
    l.offset += cut + 1
    for (const line of buf.subarray(0, cut).toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        replay(l, JSON.parse(line) as TranscriptLine)
      } catch {
        /* not ours to judge */
      }
    }
  } catch {
    /* transient: file being rotated or written */
  }
}

interface TranscriptLine {
  type?: string
  uuid?: string
  timestamp?: string
  isSidechain?: boolean
  message?: { id?: string; role?: string; model?: string; content?: string | ContentBlock[]; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
}
interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | { type: string; text?: string }[]
  is_error?: boolean
}
const textOf = (c: ContentBlock['content']): string => (typeof c === 'string' ? c : (c ?? []).map((x) => x.text ?? '').join('\n'))

function replay(l: Live, e: TranscriptLine): void {
  const wsId = l.workspaceId
  if (e.isSidechain) return // subagent traffic: the SDK path folds it into a subagent card; the CLI shows it on screen
  const m = e.message
  if (!m) return
  const at = e.timestamp ?? new Date().toISOString()
  if (e.type === 'user') {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content } as ContentBlock] : (m.content ?? [])
    const results = blocks.filter((b) => b.type === 'tool_result')
    for (const r of results) emit({ type: 'tool_result', workspaceId: wsId, toolUseId: r.tool_use_id ?? '', result: textOf(r.content).slice(0, 20_000), isError: Boolean(r.is_error) })
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim()
    if (text && !results.length) {
      if (l.openItem) {
        emit({ type: 'assistant_end', workspaceId: wsId, itemId: l.openItem })
        l.openItem = null
      }
      emit({ type: 'user_message', workspaceId: wsId, itemId: e.uuid ?? `${Date.now()}`, text, createdAt: at })
      if (!l.busy) emit({ type: 'status', workspaceId: wsId, busy: true })
      l.busy = true
    }
    return
  }
  if (e.type !== 'assistant') return
  const itemId = m.id ?? e.uuid ?? `${Date.now()}`
  if (l.openItem !== itemId) {
    if (l.openItem) emit({ type: 'assistant_end', workspaceId: wsId, itemId: l.openItem })
    emit({ type: 'assistant_start', workspaceId: wsId, itemId })
    l.openItem = itemId
  }
  const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content } as ContentBlock] : (m.content ?? [])
  let usedTool = false
  for (const b of blocks) {
    if (b.type === 'text' && b.text) emit({ type: 'text_delta', workspaceId: wsId, itemId, text: b.text })
    else if (b.type === 'thinking' && b.thinking) emit({ type: 'thinking_delta', workspaceId: wsId, itemId, text: b.thinking })
    else if (b.type === 'tool_use') {
      usedTool = true
      emit({ type: 'tool_start', workspaceId: wsId, itemId, toolUseId: b.id ?? '', name: b.name ?? 'tool' })
      emit({ type: 'tool_input', workspaceId: wsId, itemId, toolUseId: b.id ?? '', input: b.input })
    }
  }
  // Usage arrives on every block of the same API call; count it once per message id.
  if (m.usage && m.id && !l.seen.has(m.id)) {
    l.seen.add(m.id)
    recordUsage(l, m.model ?? '', m.usage)
  }
  // No tool call in this message: the model answered and is waiting for the user (until the Stop hook says so precisely).
  if (!usedTool && blocks.some((b) => b.type === 'text')) {
    emit({ type: 'assistant_end', workspaceId: wsId, itemId })
    l.openItem = null
    l.busy = false
    emit({ type: 'status', workspaceId: wsId, busy: false })
  }
}

function recordUsage(l: Live, model: string, u: NonNullable<TranscriptLine['message']>['usage']): void {
  if (!u) return
  const ws = getWorkspace(l.workspaceId)
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  const cacheRead = u.cache_read_input_tokens ?? 0
  const output = u.output_tokens ?? 0
  const price = priceOf(model)
  // Cache reads are billed at a tenth of input; cache writes at 1.25x. List prices, like the rest of the ledger.
  const costUsd = price ? ((u.input_tokens ?? 0) * price[0] + (u.cache_creation_input_tokens ?? 0) * price[0] * 1.25 + cacheRead * price[0] * 0.1 + output * price[1]) / 1_000_000 : 0
  usage.recordTurn({ at: new Date().toISOString(), workspaceId: ws.id, spaceId: ws.spaceId ?? '', accountId: limits.accountIdOf(ws), engine: 'claude-code', kind: 'chat', costUsd, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, durationMs: 0, byModel: [{ model, costUsd, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead }] })
  emit({ type: 'context', workspaceId: ws.id, tokens: input + cacheRead, cacheRead })
}
function priceOf(model: string): [number, number] | null {
  const exact = CLAUDE_MODELS.find((m) => m.id === model)?.price
  if (exact) return exact
  const family = /haiku/.test(model) ? 'haiku' : /sonnet/.test(model) ? 'sonnet' : /fable/.test(model) ? 'fable' : /opus/.test(model) ? 'opus' : null
  return family ? (CLAUDE_MODELS.find((m) => m.id === family)?.price ?? null) : null
}

/** Types a line into the running CLI, for the phone and for hand-offs. */
export function type(workspaceId: string, text: string): void {
  const l = live.get(workspaceId)
  if (!l) throw new Error('The CLI is not running in this workspace.')
  terminal.writeTerminal(l.terminalId, text.replace(/\r?\n/g, '\r') + '\r')
}

/** Esc interrupts the CLI's current turn, as at the keyboard. */
export function interrupt(workspaceId: string): void {
  const l = live.get(workspaceId)
  if (l) terminal.writeTerminal(l.terminalId, '\x1b')
}
export function isRunning(workspaceId: string): boolean {
  return live.has(workspaceId)
}

// ---------- hooks: Claude Code calls back before tools run, on stop, on notifications ----------

let hookServer: Server | null = null
let hookPortNumber = 0
async function hookPort(): Promise<number> {
  if (hookServer) return hookPortNumber
  hookServer = createServer((req, res) => {
    void handleHook(req)
      .then((body) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(body ? JSON.stringify(body) : '{}')
      })
      .catch((err) => {
        res.writeHead(403)
        res.end(String(err))
      })
  })
  await new Promise<void>((resolve) => hookServer!.listen(0, '127.0.0.1', resolve))
  hookPortNumber = (hookServer.address() as AddressInfo).port
  return hookPortNumber
}
export function stopHookServer(): void {
  hookServer?.close()
  hookServer = null
}

/** Tools the CLI runs without asking in every mode; no card for these. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'Task', 'NotebookRead', 'BashOutput', 'KillShell', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'Skill', 'ToolSearch', 'Agent'])
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

interface HookInput {
  session_id?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  permission_mode?: string
  notification_type?: string
  message?: string
  title?: string
  stop_hook_active?: boolean
}

async function handleHook(req: IncomingMessage): Promise<object | null> {
  const m = /^\/hook\/([^/]+)\/([^/]+)\/([^/?]+)/.exec(req.url ?? '')
  if (!m) throw new Error('no such hook')
  const [, workspaceId, token, event] = m
  const l = live.get(workspaceId)
  if (!l || l.hookToken !== token) throw new Error('unknown session')
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  let input: HookInput = {}
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as HookInput
  } catch {
    input = {}
  }
  switch (event) {
    case 'UserPromptSubmit':
      l.busy = true
      emit({ type: 'status', workspaceId, busy: true })
      return null
    case 'Stop':
      if (l.openItem) {
        emit({ type: 'assistant_end', workspaceId, itemId: l.openItem })
        l.openItem = null
      }
      l.busy = false
      emit({ type: 'status', workspaceId, busy: false })
      return null
    case 'Notification':
      // The CLI asks in its own UI (a tool the hook let through, or a question): the phone should know.
      if (input.notification_type === 'permission_prompt') remote.notifyFromCli(workspaceId, 'permission', 'Claude Code is asking', input.message ?? 'Permission needed in the terminal')
      else if (input.notification_type === 'idle_prompt') {
        l.busy = false
        emit({ type: 'status', workspaceId, busy: false })
      }
      return null
    case 'PreToolUse':
      return preToolUse(l, input)
    default:
      return null
  }
}

/**
 * Before a tool runs. Sinfonie asks only where the CLI itself would: never for read-only tools,
 * not for edits under acceptEdits, never under plan or bypass. The card shows in the app and on the
 * phone; the answer goes back as the hook's decision. Anything else is left to the CLI's own rules.
 */
async function preToolUse(l: Live, input: HookInput): Promise<object | null> {
  const tool = input.tool_name ?? ''
  const ws = getWorkspace(l.workspaceId)
  const { settings, spaces } = getStore().get()
  const mode = effectivePermissionMode(ws, spaces.find((s) => s.id === ws.spaceId), settings)
  if (!tool || READ_ONLY.has(tool) || tool.startsWith('mcp__')) return null
  if (mode === 'plan' || mode === 'bypassPermissions' || mode === 'auto') return null
  if (mode === 'acceptEdits' && EDITS.has(tool)) return null
  const abort = new AbortController()
  l.aborts.add(abort)
  try {
    const r = await interaction.askPermission({ workspaceId: l.workspaceId, toolName: tool, input: input.tool_input ?? {}, canAlwaysAllow: false }, abort.signal)
    const allow = r.decision === 'allow' || r.decision === 'always'
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: allow ? 'Approved in Sinfonie' : (r.message ?? 'Denied in Sinfonie') } }
  } finally {
    l.aborts.delete(abort)
  }
}
