import { spawn, type ChildProcess } from 'child_process'
import * as resources from '../resources'
import * as browserHttp from '../browser/http'
import { toBase64 } from '../images'
import type { ChatImageRef } from '@shared/types'
import { Readable, Writable } from 'stream'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve } from 'path'
import { nanoid } from 'nanoid'
import { ClientSideConnection, ndJsonStream, type Client } from '@agentclientprotocol/sdk'
import type * as schema from '@agentclientprotocol/sdk'
import type { AcpProbe, AgentEvent, Engine, McpServerSpec, PermissionMode, SubagentStep, Workspace } from '@shared/types'
import { getStore } from '../../store'
import { accountEnvFor } from '../accounts'
import { getWorkspace, patchWorkspace } from '../workspaces'
import { askPermission } from '../interaction'
import { run } from '../native/tools'
import * as jira from '../jira'
import { logError } from '../telemetry'
import { apiKeyForKind } from '../providers'
import * as notes from '../notes'

type Emit = (e: AgentEvent) => void
type AcpEngine = 'codex' | 'gemini' | 'grok'

/**
 * Vendor agents over the Agent Client Protocol. Each engine launches the
 * vendor's own CLI as a subprocess, so the vendor's own login applies:
 * ChatGPT for Codex, grok.com for Grok, an API key for Gemini.
 */
const PRESETS: Record<AcpEngine, { command: () => string[]; loginCommand: (methodId: string) => string | null; authEnvKey?: string }> = {
  codex: {
    command: () => ['npx', '-y', '@agentclientprotocol/codex-acp'],
    loginCommand: (m) => (m === 'chat-gpt' ? 'npx -y @openai/codex@latest login' : m === 'api-key' ? 'npx -y @openai/codex@latest login --with-api-key' : null)
  },
  gemini: {
    command: () => (localOk('gemini') ? ['gemini', '--acp'] : ['npx', '-y', '@google/gemini-cli@latest', '--acp']),
    loginCommand: () => null,
    authEnvKey: 'GEMINI_API_KEY'
  },
  grok: {
    command: () => ['grok', 'agent', 'stdio'],
    loginCommand: (m) => (m === 'grok.com' ? 'grok agent stdio --reauth' : null)
  }
}

function localOk(bin: string): boolean {
  try {
    const r = require('child_process').spawnSync('/bin/zsh', ['-lc', `command -v ${bin}`])
    return r.status === 0
  } catch {
    return false
  }
}

function loginEnv(engine?: AcpEngine, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${process.env.HOME}/.grok/bin:${process.env.HOME}/.nvm/versions/node/v22.18.0/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`, ...extra }
  // Google no longer allows personal Google-account logins in the Gemini CLI; a Gemini API key from Model providers is the way in.
  if (engine === 'gemini' && !env.GEMINI_API_KEY) {
    const key = apiKeyForKind('google')
    if (key) env.GEMINI_API_KEY = key
  }
  return env
}

/** When a session cannot be created for lack of auth, try the key-based method the agent offers and retry once. */
async function newSessionWithAuth(conn: ClientSideConnection, engine: AcpEngine, params: schema.NewSessionRequest, authMethods: schema.AuthMethod[]): Promise<schema.NewSessionResponse> {
  try {
    return await conn.newSession(params)
  } catch (err) {
    const keyMethod = authMethods.find((m) => /api.?key/i.test(m.id))
    const hasKey = engine === 'gemini' ? Boolean(apiKeyForKind('google') || process.env.GEMINI_API_KEY) : false
    if (!keyMethod || !hasKey) throw err
    await conn.authenticate({ methodId: keyMethod.id })
    return conn.newSession(params)
  }
}

interface Session {
  workspaceId: string
  engine: AcpEngine
  child: ChildProcess
  conn: ClientSideConnection
  sessionId: string
  busy: boolean
  queue: { id: string; text: string; images?: ChatImageRef[] }[]
  interrupted: boolean
  /** ACP tool-call id -> transcript item id, so results attach to the right block. */
  toolItems: Map<string, string>
  itemId: string
  terminals: Map<string, { child: ChildProcess; output: string; exit: { code: number | null; signal: string | null } | null; waiters: (() => void)[] }>
  modes: schema.SessionModeState | null
  tokens: { input: number; output: number }
  emit: Emit
}

const sessions = new Map<string, Session>()

function within(roots: string[], p: string): boolean {
  const abs = resolve(p)
  return roots.some((r) => !relative(r, abs).startsWith('..') && !isAbsolute(relative(r, abs)))
}

/** Spawn the agent and open an ACP connection. The client half handles updates, permissions, files and terminals. */
function connect(engine: AcpEngine, cwd: string, client: (agent: ClientSideConnection) => Client, extraEnv: NodeJS.ProcessEnv = {}): { child: ChildProcess; conn: ClientSideConnection } {
  const [cmd, ...args] = PRESETS[engine].command()
  const child = spawn(cmd, args, { cwd, env: loginEnv(engine, extraEnv), stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr?.on('data', (d: Buffer) => console.error(`[acp ${engine}]`, d.toString().trimEnd()))
  const stream = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>)
  let connRef: ClientSideConnection | null = null
  const conn = new ClientSideConnection(() => client(connRef!), stream)
  connRef = conn
  return { child, conn }
}

// ---------- probe / auth (settings UI) ----------

/** Env for a specific stored account. accounts.ts imports probe() from here; the ESM cycle is fine because both sides only call each other at run time, and a lazy require breaks in the bundled build. */
function accountEnvById(engine: AcpEngine, accountId: string | undefined): NodeJS.ProcessEnv {
  return accountEnvFor(engine, accountId)
}

/** Last probe per engine this app run, for pickers and the crew inventory. */
export const probeCache: Partial<Record<Engine, AcpProbe>> = {}

export async function probe(engine: Engine, accountId?: string): Promise<AcpProbe> {
  const r = await probeUncached(engine, accountId)
  if (r.installed) probeCache[engine] = r
  return r
}

async function probeUncached(engine: Engine, accountId?: string): Promise<AcpProbe> {
  const e = engine as AcpEngine
  if (!PRESETS[e]) return { engine, installed: false, authMethods: [], models: [], modes: [], signedIn: false, error: 'Not an ACP engine' }
  const cwd = getStore().get().settings.workspacesRoot || process.env.HOME || '/'
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })
  let child: ChildProcess | null = null
  const timer = setTimeout(() => child?.kill('SIGKILL'), 90_000)
  try {
    const c = connect(e, cwd, () => ({ requestPermission: async (p) => ({ outcome: { outcome: 'selected', optionId: p.options[0].optionId } }), sessionUpdate: async () => undefined }), accountEnvById(e, accountId))
    child = c.child
    const init = await c.conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } })
    const out: AcpProbe = {
      engine,
      installed: true,
      agent: init.agentInfo ? `${init.agentInfo.title ?? init.agentInfo.name} ${init.agentInfo.version ?? ''}`.trim() : undefined,
      authMethods: (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name, description: m.description ?? undefined, terminal: (m as { type?: string }).type === 'terminal' })),
      models: [],
      modes: [],
      signedIn: false
    }
    try {
      const s = (await newSessionWithAuth(c.conn, e, { cwd, mcpServers: [] }, init.authMethods ?? [])) as schema.NewSessionResponse & { models?: { availableModels?: { modelId: string }[]; currentModelId?: string } }
      out.signedIn = true
      out.modes = (s.modes?.availableModes ?? []).map((m) => m.id)
      out.models = (s.models?.availableModels ?? []).map((m) => m.modelId)
      out.currentModel = s.models?.currentModelId
      for (const opt of s.configOptions ?? []) {
        if (opt.type === 'select' && /model/i.test(`${opt.id} ${opt.name} ${opt.category ?? ''}`)) {
          const o = opt as unknown as { options?: { value: string }[]; currentValue?: string }
          if (o.options?.length) out.models = o.options.map((x) => x.value)
          out.currentModel = o.currentValue ?? out.currentModel
        }
      }
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err)
    }
    return out
  } catch (err) {
    return { engine, installed: false, authMethods: [], models: [], modes: [], signedIn: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
    child?.kill('SIGKILL')
  }
}

export async function authenticate(engine: Engine, methodId: string): Promise<{ ok: boolean; terminalCommand?: string; error?: string }> {
  const e = engine as AcpEngine
  const preset = PRESETS[e]
  if (!preset) return { ok: false, error: 'Not an ACP engine' }
  const terminalCommand = preset.loginCommand(methodId)
  // Prefer the vendor's own interactive login in a terminal: browsers, device codes and keychains all just work there.
  if (terminalCommand) return { ok: true, terminalCommand }
  const cwd = process.env.HOME ?? '/'
  let child: ChildProcess | null = null
  try {
    const c = connect(e, cwd, () => ({ requestPermission: async (p) => ({ outcome: { outcome: 'selected', optionId: p.options[0].optionId } }), sessionUpdate: async () => undefined }))
    child = c.child
    await c.conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } })
    await c.conn.authenticate({ methodId })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    child?.kill('SIGKILL')
  }
}

// ---------- sessions ----------

function spaceOf(ws: Workspace) {
  const { settings, spaces } = getStore().get()
  return { settings, space: spaces.find((x) => x.id === ws.spaceId) }
}

async function acpMcpServers(ws: Workspace): Promise<schema.McpServer[]> {
  const { settings, space } = spaceOf(ws)
  const specs: McpServerSpec[] = [...(settings.mcpServers ?? []), ...(space?.mcpServers ?? [])].filter((s) => s.enabled)
  const out: schema.McpServer[] = []
  // The workspace browser, served over localhost MCP so vendor agents get the same browser_* tools.
  try {
    out.push({ type: 'http', name: 'browser', url: await browserHttp.urlFor(ws.id), headers: [] })
  } catch (err) {
    console.warn('[acp] browser MCP unavailable', err)
  }
  for (const s of specs) {
    if (s.transport === 'stdio' && s.command) out.push({ name: s.name, command: s.command, args: s.args ?? [], env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })) })
    else if (s.url && s.transport === 'http') out.push({ type: 'http', name: s.name, url: s.url, headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value })) })
    else if (s.url && s.transport === 'sse') out.push({ type: 'sse', name: s.name, url: s.url, headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value })) })
  }
  const expose = space ? space.exposeJiraMcp !== false : true
  if (!expose || out.some((m) => m.name === 'jira')) return out
  const token = await jira.accessToken(jira.connectionForSpace(ws.spaceId))
  if (token) out.push({ type: 'http', name: 'jira', url: jira.JIRA_MCP_URL, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] })
  return out
}

function sessionKey(ws: Workspace, engine: AcpEngine): string {
  return `acp:${engine}:sessionId`
}

async function openSession(workspaceId: string, engine: AcpEngine, emit: Emit): Promise<Session> {
  const ws = getWorkspace(workspaceId)
  const { settings, space } = spaceOf(ws)
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const wsCwd = primary?.worktreePath ?? ws.rootPath
  const roots = [...ws.repos.map((r) => r.worktreePath), ws.rootPath]
  const mode: PermissionMode = ws.permissionMode ?? space?.permissionMode ?? settings.permissionMode
  let session!: Session

  const client = (): Client => ({
    async sessionUpdate({ update }) {
      const s = session
      const e = s.emit
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          if (!s.itemId) {
            s.itemId = nanoid(8)
            e({ type: 'assistant_start', workspaceId, itemId: s.itemId })
          }
          if (update.content.type === 'text') e({ type: 'text_delta', workspaceId, itemId: s.itemId, text: update.content.text })
          break
        case 'agent_thought_chunk':
          if (!s.itemId) {
            s.itemId = nanoid(8)
            e({ type: 'assistant_start', workspaceId, itemId: s.itemId })
          }
          if (update.content.type === 'text') e({ type: 'thinking_delta', workspaceId, itemId: s.itemId, text: update.content.text })
          break
        case 'tool_call': {
          if (!s.itemId) {
            s.itemId = nanoid(8)
            e({ type: 'assistant_start', workspaceId, itemId: s.itemId })
          }
          const name = toolName(update.kind, update.title, update.name ?? undefined)
          s.toolItems.set(update.toolCallId, s.itemId)
          e({ type: 'tool_start', workspaceId, itemId: s.itemId, toolUseId: update.toolCallId, name })
          e({ type: 'tool_input', workspaceId, itemId: s.itemId, toolUseId: update.toolCallId, input: inputOf(update) })
          if (update.status === 'completed' || update.status === 'failed') e({ type: 'tool_result', workspaceId, toolUseId: update.toolCallId, result: contentText(update.content), isError: update.status === 'failed' })
          break
        }
        case 'tool_call_update':
          if (update.status === 'completed' || update.status === 'failed') e({ type: 'tool_result', workspaceId, toolUseId: update.toolCallId, result: contentText(update.content ?? undefined) || (update.status === 'completed' ? 'done' : 'failed'), isError: update.status === 'failed' })
          break
        case 'usage_update': {
          const u = update as unknown as { usage?: { inputTokens?: number; outputTokens?: number } }
          if (u.usage) {
            s.tokens.input = u.usage.inputTokens ?? s.tokens.input
            s.tokens.output = u.usage.outputTokens ?? s.tokens.output
          }
          break
        }
        case 'current_mode_update':
          break
        default:
          break
      }
    },
    async requestPermission(p) {
      const s = session
      const pick = (kinds: schema.PermissionOptionKind[]): string | undefined => kinds.map((k) => p.options.find((o) => o.kind === k)?.optionId).find(Boolean)
      if (mode === 'bypassPermissions' || mode === 'auto') {
        const id = pick(['allow_once', 'allow_always']) ?? p.options[0]?.optionId
        return { outcome: { outcome: 'selected', optionId: id } }
      }
      const tc = p.toolCall
      const r = await askPermission({ workspaceId, toolName: toolName(tc.kind ?? undefined, tc.title ?? undefined, tc.name ?? undefined), input: inputOf(tc), canAlwaysAllow: p.options.some((o) => o.kind === 'allow_always') })
      void s
      const id = r.decision === 'deny' ? pick(['reject_once', 'reject_always']) : r.decision === 'always' ? pick(['allow_always', 'allow_once']) : pick(['allow_once', 'allow_always'])
      return { outcome: id ? { outcome: 'selected', optionId: id } : { outcome: 'cancelled' } }
    },
    async readTextFile({ path, line, limit }) {
      if (!within(roots, path)) throw new Error(`Path outside the workspace: ${path}`)
      const lines = readFileSync(path, 'utf8').split('\n')
      const start = (line ?? 1) - 1
      return { content: lines.slice(start, limit ? start + limit : undefined).join('\n') }
    },
    async writeTextFile({ path, content }) {
      if (!within(roots, path)) throw new Error(`Path outside the workspace: ${path}`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      return {}
    },
    async createTerminal({ command, args, env, cwd, outputByteLimit }) {
      const id = nanoid(8)
      // ACP says `command` is an executable and `args` its arguments, but some agents send one full
      // command line (e.g. "/opt/homebrew/bin/bash -lc 'git status'") with no args. Spawning that
      // verbatim fails with ENOENT, so hand such strings to a shell instead.
      const viaShell = (!args || args.length === 0) && /\s/.test(command.trim())
      const [file, argv] = viaShell ? ['/bin/zsh', ['-lc', command]] : [command, args ?? []]
      const child = spawn(file, argv, { cwd: cwd ?? wsCwd, env: { ...loginEnv(), ...Object.fromEntries((env ?? []).map((e) => [e.name, e.value])) } })
      resources.registerProcess(child.pid, { kind: 'tool', workspaceId, label: command })
      child.once('exit', () => resources.unregisterProcess(child.pid))
      const t = { child, output: '', exit: null as { code: number | null; signal: string | null } | null, waiters: [] as (() => void)[] }
      const cap = outputByteLimit ?? 200_000
      const push = (d: Buffer): void => {
        t.output = (t.output + d.toString()).slice(-cap)
      }
      const finish = (code: number | null, signal: string | null): void => {
        if (t.exit) return
        t.exit = { code, signal }
        t.waiters.forEach((w) => w())
        t.waiters = []
      }
      child.stdout?.on('data', push)
      child.stderr?.on('data', push)
      child.on('close', (code, signal) => finish(code, signal ?? null))
      // A missing executable or a spawn failure must reach the agent as a failed command, not crash the app.
      child.on('error', (err) => {
        push(Buffer.from(`${err.message}\n`))
        finish(127, null)
      })
      session.terminals.set(id, t)
      return { terminalId: id }
    },
    async terminalOutput({ terminalId }) {
      const t = session.terminals.get(terminalId)
      if (!t) throw new Error('Unknown terminal')
      return { output: t.output, truncated: false, exitStatus: t.exit ? { exitCode: t.exit.code, signal: t.exit.signal } : null }
    },
    async waitForTerminalExit({ terminalId }) {
      const t = session.terminals.get(terminalId)
      if (!t) throw new Error('Unknown terminal')
      if (!t.exit) await new Promise<void>((r) => t.waiters.push(r))
      return { exitCode: t.exit?.code ?? null, signal: t.exit?.signal ?? null }
    },
    async killTerminal({ terminalId }) {
      session.terminals.get(terminalId)?.child.kill('SIGKILL')
      return {}
    },
    async releaseTerminal({ terminalId }) {
      const t = session.terminals.get(terminalId)
      if (t && !t.exit) t.child.kill('SIGKILL')
      session.terminals.delete(terminalId)
      return {}
    }
  })

  const { child, conn } = connect(engine, wsCwd, client, accountEnvById(engine, ws.claudeAccountId))
  resources.registerProcess(child.pid, { kind: 'agent', workspaceId, label: engine })
  child.once('exit', () => resources.unregisterProcess(child.pid))
  session = { workspaceId, engine, child, conn, sessionId: '', busy: false, queue: [], interrupted: false, toolItems: new Map(), itemId: '', terminals: new Map(), modes: null, tokens: { input: 0, output: 0 }, emit }
  child.on('exit', (code) => {
    if (sessions.get(workspaceId) === session) {
      sessions.delete(workspaceId)
      if (session.busy) {
        emit({ type: 'notice', workspaceId, itemId: nanoid(8), level: 'error', text: `The ${engine} agent process exited (code ${code}).`, createdAt: new Date().toISOString() })
        emit({ type: 'status', workspaceId, busy: false })
      }
    }
  })
  const init = await conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } })
  const mcpServers = await acpMcpServers(ws)
  const stored = (ws as unknown as Record<string, string | undefined>)[sessionKey(ws, engine)]
  let s: schema.NewSessionResponse | null = null
  if (stored) {
    try {
      const l = await conn.loadSession({ sessionId: stored, cwd: wsCwd, mcpServers })
      s = { sessionId: stored, modes: l.modes ?? null, configOptions: l.configOptions ?? null }
    } catch {
      s = null
    }
  }
  if (!s) {
    s = await newSessionWithAuth(conn, engine, { cwd: wsCwd, mcpServers }, init.authMethods ?? [])
    patchWorkspace(workspaceId, { [sessionKey(ws, engine)]: s.sessionId } as Partial<Workspace>)
  }
  session.sessionId = s.sessionId
  session.modes = s.modes ?? null
  await applyMode(conn, s.sessionId, s.modes ?? null, mode)
  await applyModel(conn, s.sessionId, s, space?.model || settings[`${engine}Model` as keyof typeof settings] as string | undefined)
  sessions.set(workspaceId, session)
  return session
}

/** Map Sinfonie's permission mode onto whatever modes the agent offers. */
async function applyMode(conn: ClientSideConnection, sessionId: string, state: schema.SessionModeState | null, mode: PermissionMode): Promise<void> {
  const modes = state?.availableModes ?? []
  if (modes.length === 0) return
  const find = (re: RegExp): string | undefined => modes.find((m) => re.test(`${m.id} ${m.name}`))?.id
  let target: string | undefined
  if (mode === 'plan') target = find(/read.?only|plan/i)
  else if (mode === 'bypassPermissions' || mode === 'auto') target = find(/full.?access|yolo|bypass|auto.?accept|dangerous/i) ?? find(/agent|auto/i)
  else if (mode === 'acceptEdits') target = find(/auto.?edit|accept.?edit/i) ?? find(/^agent$|default/i)
  else target = find(/^agent$|default|ask/i)
  if (target && target !== state?.currentModeId) {
    try {
      await conn.setSessionMode({ sessionId, modeId: target })
    } catch (err) {
      logError('acp:setMode', err)
    }
  }
}

async function applyModel(conn: ClientSideConnection, sessionId: string, resp: schema.NewSessionResponse, model: string | undefined): Promise<void> {
  if (!model) return
  const opt = (resp.configOptions ?? []).find((o) => o.type === 'select' && /model/i.test(`${o.id} ${o.name} ${o.category ?? ''}`))
  if (!opt) return
  try {
    await conn.setSessionConfigOption({ sessionId, configId: opt.id, value: model } as schema.SetSessionConfigOptionRequest)
  } catch (err) {
    logError('acp:setModel', err, { model })
  }
}

function toolName(kind: string | null | undefined, title: string | undefined, name: string | undefined): string {
  const t = (name || title || '').trim()
  if (/^(bash|shell|run|execute)\b/i.test(t) || kind === 'execute') return 'Bash'
  if (kind === 'read') return 'Read'
  if (kind === 'edit') return 'Edit'
  if (kind === 'search') return 'Grep'
  if (kind === 'fetch') return 'WebFetch'
  return t || kind || 'tool'
}
function inputOf(tc: { rawInput?: unknown; title?: string | null; locations?: { path: string }[] | null }): Record<string, unknown> {
  const raw = (tc.rawInput ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = { ...raw }
  if (typeof raw.command !== 'string' && typeof raw.cmd === 'string') out.command = raw.cmd
  if (typeof raw.file_path !== 'string' && tc.locations?.[0]?.path) out.file_path = tc.locations[0].path
  if (tc.title && !out.description) out.description = tc.title
  return out
}
function contentText(content: schema.ToolCallContent[] | null | undefined): string {
  if (!content) return ''
  return content
    .map((c) => {
      if (c.type === 'content' && c.content.type === 'text') return c.content.text
      if (c.type === 'diff') return `diff ${c.path}\n${c.newText}`
      if (c.type === 'terminal') return `[terminal ${c.terminalId}]`
      return ''
    })
    .join('\n')
    .slice(0, 20_000)
}

// ---------- public surface ----------

function deliver(session: Session, text: string, images?: ChatImageRef[]): void {
  const { workspaceId, emit } = session
  session.busy = true
  session.itemId = ''
  emit({ type: 'user_message', workspaceId, itemId: nanoid(8), text, createdAt: new Date().toISOString(), ...(images?.length ? { images } : {}) })
  emit({ type: 'status', workspaceId, busy: true })
  session.conn
    .prompt({ sessionId: session.sessionId, prompt: [...(images ?? []).map((img) => ({ type: 'image' as const, data: toBase64(img), mimeType: img.mimeType })), { type: 'text', text: notes.prefixFor(workspaceId) + (text || (images?.length ? 'See the attached image.' : '')) }] })
    .then((r) => {
      if (session.itemId) emit({ type: 'assistant_end', workspaceId, itemId: session.itemId })
      if (session.interrupted || r.stopReason === 'cancelled') {
        session.interrupted = false
        emit({ type: 'notice', workspaceId, itemId: nanoid(8), level: 'info', text: 'You stopped the response.', createdAt: new Date().toISOString() })
      } else if (r.stopReason === 'refusal') {
        emit({ type: 'notice', workspaceId, itemId: nanoid(8), level: 'warn', text: 'The agent declined this request.', createdAt: new Date().toISOString() })
      }
      const u = r.usage
      if (u) {
        session.tokens.input += u.inputTokens
        session.tokens.output += u.outputTokens
      }
      emit({ type: 'result', result: { workspaceId, costUsd: 0, durationMs: 0, numTurns: 1, isError: false, byModel: [{ model: `${session.engine}`, costUsd: 0, outputTokens: session.tokens.output }] } })
      patchWorkspace(workspaceId, { lastMessageAt: new Date().toISOString() })
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      logError('acp:prompt', err, { workspaceId, engine: session.engine })
      emit({ type: 'notice', workspaceId, itemId: nanoid(8), level: 'error', text: `The turn failed: ${message}${/auth/i.test(message) ? ' Sign in under Settings → Agent logins.' : ''}`, createdAt: new Date().toISOString() })
      emit({ type: 'result', result: { workspaceId, costUsd: 0, durationMs: 0, numTurns: 1, isError: true, errorText: message } })
    })
    .finally(() => {
      session.busy = false
      emit({ type: 'status', workspaceId, busy: false })
      const next = session.queue.shift()
      if (next) {
        emit({ type: 'queue', workspaceId, items: [...session.queue] })
        deliver(session, next.text, next.images)
      }
    })
}

export async function sendMessage(workspaceId: string, engine: Engine, text: string, emit: Emit, images?: ChatImageRef[]): Promise<void> {
  let session = sessions.get(workspaceId)
  if (session && session.busy) {
    session.queue.push({ id: nanoid(6), text, images })
    emit({ type: 'queue', workspaceId, items: [...session.queue] })
    return
  }
  if (!session) {
    emit({ type: 'status', workspaceId, busy: true })
    try {
      session = await openSession(workspaceId, engine as AcpEngine, emit)
      emit({ type: 'init', workspaceId, sessionId: session.sessionId, model: engine, cwd: getWorkspace(workspaceId).repos[0]?.worktreePath ?? '' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logError('acp:open', err, { workspaceId, engine })
      emit({ type: 'notice', workspaceId, itemId: nanoid(8), level: 'error', text: `Could not start the ${engine} agent: ${message}. Check Settings → Agent logins.`, createdAt: new Date().toISOString() })
      emit({ type: 'status', workspaceId, busy: false })
      return
    }
  }
  deliver(session, text, images)
}

export function unqueue(workspaceId: string, id: string, emit: Emit): void {
  const s = sessions.get(workspaceId)
  if (!s) return
  s.queue = s.queue.filter((m) => m.id !== id)
  emit({ type: 'queue', workspaceId, items: [...s.queue] })
}
export function interrupt(workspaceId: string): void {
  const s = sessions.get(workspaceId)
  if (!s || !s.busy) return
  s.interrupted = true
  void s.conn.cancel({ sessionId: s.sessionId })
}
export function isBusy(workspaceId: string): boolean {
  return sessions.get(workspaceId)?.busy ?? false
}
export function closeSession(workspaceId: string): void {
  const s = sessions.get(workspaceId)
  if (!s) return
  sessions.delete(workspaceId)
  for (const t of s.terminals.values()) t.child.kill('SIGKILL')
  s.child.kill('SIGTERM')
}
export function resetSession(workspaceId: string): void {
  closeSession(workspaceId)
  const ws = getWorkspace(workspaceId)
  const patch: Record<string, undefined> = {}
  for (const e of ['codex', 'gemini', 'grok'] as AcpEngine[]) patch[sessionKey(ws, e)] = undefined
  patchWorkspace(workspaceId, patch as Partial<Workspace>)
}
export function closeAll(): void {
  for (const id of Array.from(sessions.keys())) closeSession(id)
}
void run

// ---------- one-shot worker for the crew ----------

export interface AcpWorkerRun {
  engine: AcpEngine
  ws: Workspace
  model: string
  mode: PermissionMode
  prompt: string
  signal?: AbortSignal
  onStep: (step: SubagentStep) => void
}

/** Run one task on a vendor agent in a fresh session and return its final text. Tool calls are reported as steps. */
export async function runWorker(run: AcpWorkerRun): Promise<string> {
  const { ws, engine } = run
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const wsCwd = primary?.worktreePath ?? ws.rootPath
  const roots = [...ws.repos.map((r) => r.worktreePath), ws.rootPath]
  let text = ''
  const seen = new Set<string>()
  const client = (): Client => ({
    async sessionUpdate({ update }) {
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content.type === 'text') text += update.content.text
          break
        case 'tool_call': {
          if (seen.has(update.toolCallId)) break
          seen.add(update.toolCallId)
          const i = inputOf(update)
          const detail = [i.command, i.file_path, i.path, i.pattern, update.title].find((v) => typeof v === 'string') as string | undefined
          run.onStep({ kind: 'tool', name: toolName(update.kind, update.title, update.name ?? undefined), detail: (detail ?? '').slice(0, 200) })
          break
        }
        default:
          break
      }
    },
    async requestPermission(p) {
      const pick = (kinds: schema.PermissionOptionKind[]): string | undefined => kinds.map((k) => p.options.find((o) => o.kind === k)?.optionId).find(Boolean)
      if (run.mode === 'bypassPermissions' || run.mode === 'auto') return { outcome: { outcome: 'selected', optionId: pick(['allow_once', 'allow_always']) ?? p.options[0]?.optionId } }
      const tc = p.toolCall
      const r = await askPermission({ workspaceId: ws.id, toolName: `${engine}: ${toolName(tc.kind ?? undefined, tc.title ?? undefined, tc.name ?? undefined)}`, input: inputOf(tc), canAlwaysAllow: false })
      const id = r.decision === 'deny' ? pick(['reject_once', 'reject_always']) : pick(['allow_once', 'allow_always'])
      return { outcome: id ? { outcome: 'selected', optionId: id } : { outcome: 'cancelled' } }
    },
    async readTextFile({ path, line, limit }) {
      if (!within(roots, path)) throw new Error(`Path outside the workspace: ${path}`)
      const lines = readFileSync(path, 'utf8').split('\n')
      const start = (line ?? 1) - 1
      return { content: lines.slice(start, limit ? start + limit : undefined).join('\n') }
    },
    async writeTextFile({ path, content }) {
      if (!within(roots, path)) throw new Error(`Path outside the workspace: ${path}`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      return {}
    }
  })
  const { child, conn } = connect(engine, wsCwd, client, accountEnvById(engine, ws.claudeAccountId))
  resources.registerProcess(child.pid, { kind: 'agent', workspaceId: ws.id, label: engine })
  child.once('exit', () => resources.unregisterProcess(child.pid))
  const kill = (): void => {
    child.kill('SIGKILL')
  }
  run.signal?.addEventListener('abort', kill)
  try {
    const init = await conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } })
    const s = await newSessionWithAuth(conn, engine, { cwd: wsCwd, mcpServers: [] }, init.authMethods ?? [])
    await applyMode(conn, s.sessionId, s.modes ?? null, run.mode)
    await applyModel(conn, s.sessionId, s, run.model)
    await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: 'text', text: run.prompt }] })
    return text
  } finally {
    run.signal?.removeEventListener('abort', kill)
    kill()
  }
}
