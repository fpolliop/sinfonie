/**
 * The settings assistant: a Claude conversation that can read and change Sinfonie's own
 * configuration through an in-process tool server. It creates spaces, adds repositories, designs
 * and saves crews after interviewing the user, sets cost modes, starts sign-ins for integrations,
 * configures Google Cloud and on-call, and opens a settings page when something needs the user's
 * hands (terminal logins, API keys). Every write is confirmed in conversation first.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { query, createSdkMcpServer, tool as sdkTool, type Options, type SDKMessage, type SpawnedProcess, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { getStore } from '../store'
import { claudeExecutableOption } from './claude-cli'
import { accountEnv, defaultAccountId, addAccount } from './accounts'
import { askQuestion } from './interaction'
import { costModeFor, leanModel } from './cost-mode'
import * as resources from './resources'
import * as usage from './usage'
import * as slack from './slack'
import * as linear from './linear'
import * as jira from './jira'
import * as gcp from './gcp'
import * as oncall from './oncall/service'
import * as library from './agents'
import * as notes from './notes'
import * as runs from './crew/runs'
import * as scheduler from './crew/scheduler'
import * as slackTools from './slack-tools'
import * as reviews from './reviews'
import { mcpServersFor } from './agent'
import { getTranscript } from './transcripts'
import { agentOwner, type MaestroConversation, type MaestroConversationMeta, type MaestroContext, type MaestroEvent, type MaestroSuggestion } from '@shared/types'
import { SPACE_COLORS, type AgentSpec, type AssistantItem, type CostMode, type CostModeScope, type OnCallSettings, type Repo, type Space, type Settings } from '@shared/types'

export const ASSISTANT_WORKSPACE_ID = 'assistant'

// ---------- host callbacks (things that live in ipc.ts) ----------
interface Host {
  addRepoAt: (path: string, spaceId?: string) => Promise<Repo>
  setCostMode: (scope: CostModeScope, mode: CostMode | null) => void
  openSettings: (target: { scope: 'app'; page: string } | { scope: 'space'; spaceId: string; page: string }) => void
  /** Send a message into a workspace's conversation, as if typed there. */
  sendToWorkspace: (workspaceId: string, text: string) => Promise<void> | void
  openWorkspace: (workspaceId: string) => void
}
let host: Host | null = null
export function setHost(h: Host): void {
  host = h
}
const needHost = (): Host => {
  if (!host) throw new Error('assistant host not wired')
  return host
}

// ---------- conversations ----------
/**
 * Maestro keeps many conversations, one JSON each under userData/maestro. Each has its own
 * Claude session (resumed across app runs), a title, optional pin and archive marks, and the
 * workspace or space it was opened from.
 */
interface Conversation extends MaestroConversationMeta {
  items: AssistantItem[]
  sessionId?: string
}
const convos = new Map<string, Conversation>()
let loaded = false
const running = new Map<string, AbortController>()
let emit: (e: MaestroEvent) => void = () => undefined

function dir(): string {
  const d = join(app.getPath('userData'), 'maestro')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}
const fileOf = (id: string): string => join(dir(), `${id}.json`)

function load(): void {
  if (loaded) return
  loaded = true
  for (const f of readdirSync(dir())) {
    if (!f.endsWith('.json')) continue
    try {
      const c = JSON.parse(readFileSync(join(dir(), f), 'utf8')) as Conversation
      if (c && typeof c.id === 'string') convos.set(c.id, { ...c, items: c.items ?? [] })
    } catch (err) {
      console.error(`Corrupt Maestro conversation ${f}`, err)
    }
  }
  // The single conversation of earlier builds becomes the first one here.
  const legacy = join(app.getPath('userData'), 'assistant.json')
  if (convos.size === 0 && existsSync(legacy)) {
    try {
      const old = JSON.parse(readFileSync(legacy, 'utf8')) as { items?: AssistantItem[]; sessionId?: string }
      if (old.items?.length) {
        const c: Conversation = { id: 'legacy', title: 'Earlier conversation', createdAt: old.items[0].createdAt, updatedAt: old.items[old.items.length - 1].createdAt, items: old.items, sessionId: old.sessionId }
        convos.set(c.id, c)
        save(c)
      }
      renameSync(legacy, `${legacy}.migrated`)
    } catch {
      /* ignore */
    }
  }
}
function save(c: Conversation): void {
  try {
    writeFileSync(fileOf(c.id), JSON.stringify({ ...c, items: c.items.slice(-600) }))
  } catch {
    /* best effort */
  }
}
function meta(c: Conversation): MaestroConversationMeta {
  const { items: _i, sessionId: _s, ...m } = c
  void _i
  void _s
  return { ...m, busy: running.has(c.id), preview: [...c.items].reverse().find((it) => it.role === 'user' || it.role === 'assistant')?.text.slice(0, 120) }
}
const need = (id: string): Conversation => {
  load()
  const c = convos.get(id)
  if (!c) throw new Error(`No conversation ${id}`)
  return c
}

export function setEmitter(fn: (e: MaestroEvent) => void): void {
  emit = fn
}
export function conversations(): MaestroConversationMeta[] {
  load()
  return [...convos.values()].map(meta).sort((a, b) => Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt)) || b.updatedAt.localeCompare(a.updatedAt))
}
export function get(id: string): MaestroConversation {
  const c = need(id)
  return { ...meta(c), items: c.items }
}
export function create(context?: MaestroContext): MaestroConversation {
  load()
  const now = new Date().toISOString()
  const c: Conversation = { id: nanoid(8), title: 'New conversation', createdAt: now, updatedAt: now, items: [], ...(context && (context.workspaceId || context.spaceId) ? { context } : {}) }
  convos.set(c.id, c)
  save(c)
  emit({ conversationId: c.id, type: 'meta', meta: meta(c) })
  return { ...meta(c), items: [] }
}
export function rename(id: string, title: string): void {
  const c = need(id)
  c.title = title.trim() || c.title
  c.titleLocked = true
  save(c)
  emit({ conversationId: id, type: 'meta', meta: meta(c) })
}
export function pin(id: string, pinned: boolean): void {
  const c = need(id)
  if (pinned) c.pinnedAt = new Date().toISOString()
  else delete c.pinnedAt
  save(c)
  emit({ conversationId: id, type: 'meta', meta: meta(c) })
}
export function archive(id: string, archived: boolean): void {
  const c = need(id)
  if (archived) c.archivedAt = new Date().toISOString()
  else delete c.archivedAt
  save(c)
  emit({ conversationId: id, type: 'meta', meta: meta(c) })
}
export function remove(id: string): void {
  const c = need(id)
  running.get(id)?.abort()
  convos.delete(id)
  try {
    rmSync(fileOf(c.id), { force: true })
  } catch {
    /* ignore */
  }
  emit({ conversationId: id, type: 'removed' })
}
export function stop(id: string): void {
  running.get(id)?.abort()
}
/** Kept for the checklist: has the user talked to Maestro at all. */
export function history(): { items: AssistantItem[]; busy: boolean } {
  load()
  const all = [...convos.values()].flatMap((c) => c.items)
  return { items: all, busy: running.size > 0 }
}
export function reset(): void {
  /* conversations are removed one by one now */
}
function push(c: Conversation, item: Omit<AssistantItem, 'id' | 'createdAt'> & { id?: string }): AssistantItem {
  const full: AssistantItem = { id: item.id ?? nanoid(8), createdAt: new Date().toISOString(), ...item }
  c.items.push(full)
  c.updatedAt = full.createdAt
  save(c)
  emit({ conversationId: c.id, type: 'item', item: full })
  return full
}

/** What matters right now, for an empty conversation: computed from real state, each one a prompt. */
export function suggestions(): MaestroSuggestion[] {
  load()
  const { workspaces, spaces } = getStore().get()
  const out: MaestroSuggestion[] = []
  const today = new Date().toISOString().slice(0, 10)
  const all = notes.listAll().flatMap((g) => g.notes.map((n) => ({ ...n, owner: g.owner })))
  const overdue = all.filter((n) => n.kind === 'todo' && !n.done && n.due && n.due < today)
  const dueToday = all.filter((n) => n.kind === 'todo' && !n.done && n.due === today)
  if (overdue.length) out.push({ kind: 'todos', label: `${overdue.length} overdue todo${overdue.length === 1 ? '' : 's'}`, text: 'Show me my overdue todos and help me decide what to do first.' })
  if (dueToday.length) out.push({ kind: 'todos', label: `${dueToday.length} due today`, text: 'What is due today, and what would you tackle first?' })
  const last = [...convos.values()].map((c) => c.updatedAt).sort().pop() ?? ''
  const finished = workspaces.filter((w) => w.status !== 'archived' && w.lastMessageAt && w.lastMessageAt > last).slice(0, 3)
  for (const w of finished) out.push({ kind: 'workspace', label: `${w.name} was active`, text: `What happened in the "${w.name}" workspace since we last talked? Summarise it.`, id: w.id })
  const agentsRan = library
    .list()
    .map((a) => ({ a, r: runs.lastRun(a.id, 'schedule') }))
    .filter((x) => x.r && x.r.startedAt > last)
    .slice(0, 2)
  for (const { a, r } of agentsRan) out.push({ kind: 'agent', label: `${a.icon ? `${a.icon} ` : ''}${a.name} ran ${r!.startedAt.slice(11, 16)}`, text: `What did ${a.name} report in its last scheduled run, and did it file anything?`, id: a.id })
  const incidents = oncall.state().incidents.filter((i) => i.status !== 'resolved' && i.status !== 'dismissed')
  if (incidents.length) out.push({ kind: 'oncall', label: `${incidents.length} open incident${incidents.length === 1 ? '' : 's'}`, text: 'Walk me through the open on-call incidents.' })
  const open = all.filter((n) => n.kind === 'todo' && !n.done).length
  if (open && out.length < 4) out.push({ kind: 'todos', label: `${open} open todos`, text: 'Give me a short brief of everything left across my notes and todos.' })
  if (spaces.length && out.length < 5) out.push({ kind: 'setup', label: 'What changed lately?', text: 'What changed in Sinfonie since we last talked: workspaces, agents, notes, incidents?' })
  if (out.length === 0) out.push({ kind: 'setup', label: 'Show me around', text: 'Show me what is configured right now and what looks incomplete.' }, { kind: 'setup', label: 'Set up my crew', text: 'Help me set up my crew. Interview me about how we build, test, review and ship, then propose the agents.' })
  return out.slice(0, 6)
}

// ---------- helpers ----------
const MODEL_RE = /^(haiku|sonnet|opus|fable|claude-[a-z0-9.-]+|[a-z0-9-]+\/[A-Za-z0-9._:-]+)$/
const spaceOrThrow = (id: string): Space => {
  const s = getStore().get().spaces.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase())
  if (!s) throw new Error(`No space "${id}". Call get_overview for the list.`)
  return s
}
const connId = (spaceId?: string): string => (spaceId ? spaceOrThrow(spaceId).id : '')
const agentOrThrow = (ref: string): AgentSpec => {
  const a = library.list().find((x) => x.id === ref || x.name.toLowerCase() === ref.toLowerCase())
  if (!a) throw new Error(`No agent "${ref}". Call list_agents for the list.`)
  return a
}
const pretty = (v: unknown): string => JSON.stringify(v, null, 1)

function overview(): unknown {
  const { settings, spaces, repos, workspaces } = getStore().get()
  const crewSummary = (agents: AgentSpec[]): string[] => agents.filter((a) => a.enabled).map((a) => `${a.name} (${a.model}${a.effort ? `, ${a.effort}` : ''}): ${a.description.slice(0, 80)}`)
  return {
    app: {
      engine: settings.engine ?? 'claude-code',
      model: settings.model,
      permissionMode: settings.permissionMode,
      costMode: costModeFor(undefined),
      workspacesRoot: settings.workspacesRoot,
      autoDownloadUpdates: settings.autoDownloadUpdates !== false,
      crashReports: settings.crashReports !== false,
      usageStats: settings.usageStats !== false,
      defaultCrew: crewSummary(library.crewFor(undefined)),
      integrations: {
        jira: settings.jira?.connected ? `connected (${settings.jira.siteName ?? settings.jira.siteUrl})` : 'not connected',
        linear: settings.linear?.connected ? `connected (${settings.linear.orgName ?? ''})` : 'not connected',
        slack: slack.connection('').connected ? `connected (${slack.connection('').teamName ?? ''})` : 'not connected',
        gcp: settings.gcp?.projectId ? `project ${settings.gcp.projectId}${settings.gcp.account ? ` as ${settings.gcp.account}` : ''}` : 'no project',
        oncall: settings.oncall?.enabled ? `on, ${settings.oncall.channels.length} channel(s)` : 'off',
        mcpServers: (settings.mcpServers ?? []).map((m) => `${m.name}${m.enabled ? '' : ' (disabled)'}`),
        modelProviders: (settings.providers ?? []).map((p) => p.name)
      }
    },
    accounts: settings.claudeAccounts.map((a) => ({ id: a.id, name: a.name, vendor: a.vendor ?? 'anthropic', loggedIn: a.loggedIn, default: a.id === settings.defaultClaudeAccountId })),
    spaces: spaces.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      engine: s.engine ?? 'app default',
      model: s.model ?? 'app default',
      permissionMode: s.permissionMode ?? 'app default',
      costMode: costModeFor(s.id),
      useCrew: s.useCrew !== false,
      crew: crewSummary(library.crewFor(s.id)),
      repos: repos.filter((r) => r.spaceId === s.id).map((r) => r.name),
      workspaces: workspaces.filter((w) => w.spaceId === s.id && w.status !== 'archived').length,
      integrations: {
        jira: s.jira?.connected ? 'own connection' : 'app default',
        linear: s.linear?.connected ? 'own connection' : 'app default',
        slack: slack.connection(s.id).connected ? 'own connection' : 'app default',
        gcp: s.gcp?.projectId ? `project ${s.gcp.projectId}${s.gcp.account ? ` as ${s.gcp.account}` : ''}` : 'app default',
        oncall: s.oncall?.enabled ? `on, ${s.oncall.channels.length} channel(s)` : 'off'
      }
    })),
    workspaces: workspaces
      .filter((w) => w.status !== 'archived')
      .map((w) => ({ id: w.id, name: w.name, space: spaces.find((s) => s.id === w.spaceId)?.name ?? null, stage: w.stage, status: w.status, repos: w.repos.map((r) => `${r.repoName}@${r.branch}`), lastMessageAt: w.lastMessageAt ?? null, openTodos: notes.list(w.id).filter((n) => n.kind === 'todo' && !n.done).length })),
    agents: library.list().map((a) => ({ id: a.id, name: a.name, icon: a.icon, role: a.crew ? 'crew' : 'standalone', enabled: a.enabled, model: a.model, scope: a.scope ? (spaces.find((s) => s.id === a.scope)?.name ?? a.scope) : 'every space', tools: a.tools?.length ? a.tools : 'all', schedule: a.schedule?.enabled ? `${a.schedule.kind === 'daily' ? `daily at ${a.schedule.at}` : `every ${a.schedule.everyMinutes} min`}${scheduler.nextRunAt(a) ? `, next ${scheduler.nextRunAt(a)!.toISOString()}` : ''}` : 'off', lastRun: runs.lastRun(a.id)?.startedAt ?? null, description: a.description.slice(0, 120) })),
    notes: notes.listAll().map((g) => ({ owner: g.owner, where: notes.ownerLabel(g.owner), openTodos: g.notes.filter((n) => n.kind === 'todo' && !n.done).length, notes: g.notes.filter((n) => n.kind === 'note').length, done: g.notes.filter((n) => n.kind === 'todo' && n.done).length })),
    reviews: reviews.listRuns().slice(0, 20).map((r) => ({ key: r.key, status: r.status, title: (r as unknown as { title?: string }).title ?? r.key })),
    oncall: { running: oncall.state().running, openIncidents: oncall.state().incidents.filter((i) => i.status !== 'resolved' && i.status !== 'dismissed').length },
    unassignedRepos: repos.filter((r) => !r.spaceId).map((r) => ({ id: r.id, name: r.name, path: r.path })),
    reposById: repos.map((r) => ({ id: r.id, name: r.name, path: r.path, spaceId: r.spaceId, defaultBranch: r.defaultBranch })),
    settingsPages: {
      app: ['general', 'spaces', 'repos', 'providers', 'accounts', 'crew', 'resources', 'usage', 'oncall', 'jira', 'linear', 'slack', 'gcp', 'mcp', 'feedback', 'about'],
      space: ['general', 'repos', 'crew', 'oncall', 'jira', 'linear', 'slack', 'gcp', 'github', 'mcp']
    }
  }
}

function scanRepos(rootIn: string): { path: string; name: string; added: boolean }[] {
  const root = rootIn.startsWith('~') ? join(homedir(), rootIn.slice(1)) : rootIn
  const known = new Set(getStore().get().repos.map((r) => r.path))
  const out: { path: string; name: string; added: boolean }[] = []
  const seen = new Set<string>()
  const consider = (p: string): void => {
    if (seen.has(p) || !existsSync(join(p, '.git'))) return
    seen.add(p)
    out.push({ path: p, name: basename(p), added: known.has(p) })
  }
  const SKIP = new Set(['node_modules', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', 'Public', 'Desktop', 'Downloads', 'Documents', 'go', 'vendor', 'dist', 'build', 'target', 'venv', '.venv'])
  const children = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
        .map((e) => join(dir, e.name))
    } catch {
      return []
    }
  }
  if (!existsSync(root)) return out
  consider(root)
  for (const c of children(root)) {
    consider(c)
    if (out.length > 200) break
    if (!seen.has(c)) for (const g of children(c)) consider(g)
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

const SPACE_KEYS = ['name', 'color', 'engine', 'model', 'permissionMode', 'budgetMode', 'leanMode', 'useCrew', 'workspacesRoot', 'exposeLinearMcp', 'exposeJiraMcp', 'exposeGcpMcp', 'claudeAccountId'] as const
const SETTINGS_KEYS = ['engine', 'model', 'permissionMode', 'budgetMode', 'leanMode', 'workspacesRoot', 'basePort', 'autoDownloadUpdates', 'crashReports', 'usageStats', 'strictMcp', 'browserEvaluate', 'defaultClaudeAccountId', 'nativeModel', 'codexModel', 'geminiModel', 'grokModel'] as const

const agentShape = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'lowercase, digits and dashes'),
  description: z.string().min(10).describe('When the orchestrator should delegate to it; one or two sentences'),
  prompt: z.string().min(20).describe('Its system prompt: role, how it works, what it returns'),
  model: z.string().regex(MODEL_RE, 'haiku | sonnet | opus | fable | provider/model'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  tools: z.array(z.string()).optional().describe('Allow-list, e.g. ["Read","Grep","Glob"] for read-only roles; omit for everything'),
  maxTurns: z.number().int().min(5).max(200).optional(),
  enabled: z.boolean().optional()
})

// ---------- tools ----------
type ToolDef = { name: string; description: string; shape: z.ZodRawShape; run: (args: Record<string, unknown>) => Promise<string> }

const TOOLS: ToolDef[] = [
  {
    name: 'get_overview',
    description: 'Everything configured in Sinfonie right now: app defaults, accounts, spaces (engine, model, cost mode, crew, repos, integrations, workspaces), repositories, and the list of settings pages. Call it first, and again after changes.',
    shape: {},
    run: async () => pretty(overview())
  },
  {
    name: 'get_crew',
    description: 'The crew the orchestrator gets in a scope: every library agent marked crew, enabled and visible there (name, description, prompt, model, effort, tools, maxTurns), plus the visible agents that are standalone or switched off for the space.',
    shape: { scope: z.string().describe('"app" or a space id / name') },
    run: async (i) => {
      const scope = String(i.scope)
      const spaceId = scope === 'app' ? undefined : spaceOrThrow(scope).id
      const crew = library.crewFor(spaceId)
      const off = library.visibleTo(spaceId).filter((a) => !crew.some((c) => c.id === a.id))
      return pretty({ crew, notOnTheCrew: off.map((a) => `${a.name} (${!a.enabled ? 'disabled' : !a.crew ? 'standalone, not offered to orchestrators' : 'switched off for this space'})`) })
    }
  },
  {
    name: 'set_crew',
    description: 'Save agents into the library as crew members for a scope: agents with these names are created or updated and marked crew (scope "app" makes them available everywhere, a space makes them that space\'s own); crew agents not in the list are switched off for that scope. Standalone agents (the user runs them directly) are untouched. Confirm the design with the user first. Models: haiku (cheap, fast), sonnet (default coder), opus (deep reasoning), fable (strongest, expensive), or provider/model for API providers. Give read-only roles tools ["Read","Grep","Glob"].',
    shape: { scope: z.string().describe('"app" or a space id / name'), agents: z.array(agentShape).min(1).max(8), useCrew: z.boolean().optional().describe('Space only: false turns delegation off') },
    run: async (i) => {
      const scope = String(i.scope)
      const parsed = z.array(agentShape).parse(i.agents)
      const names = new Set<string>()
      for (const a of parsed) {
        if (names.has(a.name)) throw new Error(`Duplicate crew name ${a.name}`)
        names.add(a.name)
      }
      const spaceId = scope === 'app' ? undefined : spaceOrThrow(scope).id
      const saved: AgentSpec[] = parsed.map((a) => {
        const existing = library.byName(a.name, spaceId)
        return library.save({
          id: existing?.id ?? '',
          name: a.name,
          description: a.description,
          prompt: a.prompt,
          model: a.model,
          ...(a.effort ? { effort: a.effort } : {}),
          ...(a.tools?.length ? { tools: a.tools } : {}),
          ...(a.maxTurns ? { maxTurns: a.maxTurns } : {}),
          enabled: a.enabled !== false,
          crew: true,
          ...(existing?.scope || (!existing && spaceId) ? { scope: existing?.scope ?? spaceId } : {})
        })
      })
      const keep = new Set(saved.map((a) => a.id))
      if (spaceId) {
        getStore().update((d) => {
          const s = d.spaces.find((x) => x.id === spaceId)!
          s.crewDisabled = library.visibleTo(spaceId).filter((a) => !keep.has(a.id)).map((a) => a.id)
          if (typeof i.useCrew === 'boolean') {
            if (i.useCrew) delete s.useCrew
            else s.useCrew = false
          }
        })
      } else {
        for (const a of library.list()) if (!a.scope && !keep.has(a.id) && a.crew) library.save({ ...a, crew: false })
      }
      return `Saved ${saved.length} agent(s) for ${scope === 'app' ? 'every space' : `space ${spaceOrThrow(scope).name}`}: ${saved.map((s) => `${s.name} (${s.model})`).join(', ')}. New sessions in that scope use them; the user can edit them under Agents.`
    }
  },
  {
    name: 'reset_crew_to_default',
    description: 'Restore the built-in agents (explorer, implementer, tester, reviewer) to their defaults, or make a space use the whole library again (clears its switched-off list and model overrides).',
    shape: { scope: z.string() },
    run: async (i) => {
      const scope = String(i.scope)
      if (scope === 'app') {
        library.resetBuiltins()
        return 'Built-in agents restored to their defaults.'
      }
      getStore().update((d) => {
        const s = d.spaces.find((x) => x.id === spaceOrThrow(scope).id)!
        delete s.crewDisabled
        delete s.crewModels
      })
      return 'The space now uses every crew agent in the library again.'
    }
  },
  {
    name: 'scan_repos',
    description: 'Find git repositories under a folder (two levels deep), marking the ones already added. Use it before add_repos. Typical roots: ~/repos, ~/code, ~/Projects, ~/dev.',
    shape: { root: z.string().describe('Folder, ~ allowed') },
    run: async (i) => {
      const list = scanRepos(String(i.root))
      return list.length ? list.map((r) => `${r.added ? '[added] ' : ''}${r.path}`).join('\n') : `No git repositories under ${String(i.root)}.`
    }
  },
  {
    name: 'add_repos',
    description: 'Register git repositories (absolute paths to repository roots) and optionally put them in a space. Existing ones move to the space.',
    shape: { paths: z.array(z.string()).min(1).max(50), spaceId: z.string().optional().describe('Space id or name') },
    run: async (i) => {
      const sid = i.spaceId ? spaceOrThrow(String(i.spaceId)).id : undefined
      const out: string[] = []
      for (const p0 of i.paths as string[]) {
        const p = p0.startsWith('~') ? join(homedir(), p0.slice(1)) : p0
        try {
          const r = await needHost().addRepoAt(p, sid)
          out.push(`added ${r.name} (${r.defaultBranch})${sid ? ` to ${spaceOrThrow(sid).name}` : ''}`)
        } catch (err) {
          out.push(`skipped ${p}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return out.join('\n')
    }
  },
  {
    name: 'move_repo',
    description: 'Move a registered repository to a space (or out of every space with spaceId "").',
    shape: { repoId: z.string().describe('Repo id or name'), spaceId: z.string() },
    run: async (i) => {
      const sid = i.spaceId ? spaceOrThrow(String(i.spaceId)).id : ''
      let name = ''
      getStore().update((d) => {
        const r = d.repos.find((x) => x.id === i.repoId || x.name === i.repoId)
        if (!r) throw new Error(`No repository ${String(i.repoId)}`)
        name = r.name
        if (sid) r.spaceId = sid
        else delete r.spaceId
      })
      return `${name} is now ${sid ? `in ${spaceOrThrow(sid).name}` : 'unassigned'}.`
    }
  },
  {
    name: 'create_space',
    description: 'Create a space: a group of repositories with its own crew, model, cost mode and integrations. Returns its id.',
    shape: { name: z.string().min(1).max(40), color: z.string().optional().describe('Hex colour; default picks the next palette colour') },
    run: async (i) => {
      const { spaces } = getStore().get()
      const space: Space = { id: nanoid(6), name: String(i.name).trim(), color: typeof i.color === 'string' && /^#[0-9a-f]{6}$/i.test(i.color) ? i.color : SPACE_COLORS[spaces.length % SPACE_COLORS.length], createdAt: new Date().toISOString() }
      getStore().update((d) => d.spaces.push(space))
      return `Created space ${space.name} (id ${space.id}).`
    }
  },
  {
    name: 'update_space',
    description: `Change a space. Keys: ${SPACE_KEYS.join(', ')}. Empty string or null resets a key to the app default. engine: claude-code | native | codex | gemini | grok. permissionMode: default | acceptEdits | plan | bypassPermissions.`,
    shape: { spaceId: z.string(), patch: z.object({}).passthrough().describe('Key/value object') },
    run: async (i) => {
      const s = spaceOrThrow(String(i.spaceId))
      const patch = i.patch as Record<string, unknown>
      const bad = Object.keys(patch).filter((k) => !(SPACE_KEYS as readonly string[]).includes(k))
      if (bad.length) throw new Error(`Not settable here: ${bad.join(', ')}. Use open_settings for those.`)
      getStore().update((d) => {
        const t = d.spaces.find((x) => x.id === s.id) as unknown as Record<string, unknown>
        for (const [k, v] of Object.entries(patch)) {
          if (v === '' || v === null || v === undefined) delete t[k]
          else if (k === 'useCrew' && v === true) delete t[k]
          else t[k] = v
        }
      })
      return `Updated ${s.name}: ${Object.keys(patch).join(', ')}.`
    }
  },
  {
    name: 'delete_space',
    description: 'Delete an empty space (no workspaces). Its repositories become unassigned. Only after the user explicitly confirmed the deletion by name.',
    shape: { spaceId: z.string(), confirmed: z.literal(true) },
    run: async (i) => {
      const s = spaceOrThrow(String(i.spaceId))
      const { workspaces } = getStore().get()
      const n = workspaces.filter((w) => w.spaceId === s.id && w.status !== 'archived').length
      if (n) throw new Error(`${s.name} still has ${n} workspace(s); archive them first (the user does that from the sidebar).`)
      getStore().update((d) => {
        d.spaces = d.spaces.filter((x) => x.id !== s.id)
        for (const r of d.repos) if (r.spaceId === s.id) delete r.spaceId
      })
      return `Deleted space ${s.name}.`
    }
  },
  {
    name: 'update_settings',
    description: `Change app-wide defaults. Keys: ${SETTINGS_KEYS.join(', ')}. model: haiku | sonnet | opus | fable (Claude Code engine).`,
    shape: { patch: z.object({}).passthrough().describe('Key/value object') },
    run: async (i) => {
      const patch = i.patch as Record<string, unknown>
      const bad = Object.keys(patch).filter((k) => !(SETTINGS_KEYS as readonly string[]).includes(k))
      if (bad.length) throw new Error(`Not settable here: ${bad.join(', ')}. Use open_settings for those.`)
      getStore().update((d) => Object.assign(d.settings, patch as Partial<Settings>))
      return `Updated: ${Object.keys(patch).join(', ')}.`
    }
  },
  {
    name: 'set_cost_mode',
    description: 'Set the cost profile at a scope. standard: configured model and crew. budget: Sonnet orchestrator, low effort, 60 tool calls per message. lean: one Sonnet agent, no crew, trimmed tools, 25 calls per message (fewest tokens). Affected sessions restart and keep their conversation.',
    shape: { scope: z.string().describe('"app" or a space id / name'), mode: z.enum(['standard', 'budget', 'lean']) },
    run: async (i) => {
      const scope = String(i.scope)
      const target: CostModeScope = scope === 'app' ? { kind: 'app' } : { kind: 'space', id: spaceOrThrow(scope).id }
      needHost().setCostMode(target, i.mode as CostMode)
      return `Cost mode ${String(i.mode)} set for ${scope === 'app' ? 'the app' : spaceOrThrow(scope).name}.`
    }
  },
  {
    name: 'integration_status',
    description: 'Current status of one integration for the app or a space: slack, linear, jira, gcp (gcloud accounts and projects), github (gh CLI), oncall.',
    shape: { provider: z.enum(['slack', 'linear', 'jira', 'gcp', 'github', 'oncall']), spaceId: z.string().optional() },
    run: async (i) => {
      const p = String(i.provider)
      const cid = connId(i.spaceId as string | undefined)
      const { settings } = getStore().get()
      const space = cid ? spaceOrThrow(cid) : undefined
      if (p === 'slack') return pretty(slack.connection(cid))
      if (p === 'linear') return pretty((cid ? space?.linear : settings.linear) ?? { connected: false })
      if (p === 'jira') return pretty((cid ? space?.jira : settings.jira) ?? { connected: false })
      if (p === 'oncall') return pretty((cid ? space?.oncall : settings.oncall) ?? { enabled: false, channels: [] })
      if (p === 'gcp') return pretty({ configured: gcp.gcpFor(cid || undefined) ?? null, gcloud: await gcp.status() })
      return await new Promise<string>((resolve) => {
        const child = spawn('gh', ['auth', 'status'], { env: process.env })
        let out = ''
        child.stdout.on('data', (d: Buffer) => (out += d.toString()))
        child.stderr.on('data', (d: Buffer) => (out += d.toString()))
        child.on('error', (e) => resolve(`gh is not installed or not on PATH (${e.message}). The review cockpit and PR features need it: brew install gh && gh auth login.`))
        child.on('exit', () => resolve(out.trim() || 'gh auth status returned nothing'))
      })
    }
  },
  {
    name: 'connect_integration',
    description: 'Start a sign-in. slack / linear / jira open the browser (OAuth) and the app finishes on its own; gcp runs gcloud auth login in the browser. Tell the user to complete it in the browser, then call integration_status to confirm. spaceId gives that space its own connection; omit for the app default.',
    shape: { provider: z.enum(['slack', 'linear', 'jira', 'gcp']), spaceId: z.string().optional(), account: z.string().optional().describe('gcp only: re-authenticate this Google account') },
    run: async (i) => {
      const p = String(i.provider)
      const cid = connId(i.spaceId as string | undefined)
      if (p === 'slack') {
        await slack.startAuth(cid)
        return 'Slack sign-in opened in the browser. When the user approves, Sinfonie receives the callback and the connection shows as connected.'
      }
      if (p === 'linear') {
        void linear.authenticate(cid).catch((err) => console.warn('[assistant] linear auth', err))
        return 'Linear sign-in opened in the browser; it completes on its own. Check integration_status in a moment.'
      }
      if (p === 'jira') {
        void jira.authenticate(cid).catch((err) => console.warn('[assistant] jira auth', err))
        return 'Jira sign-in opened in the browser; it completes on its own. Check integration_status in a moment.'
      }
      void gcp.login(i.account ? String(i.account) : undefined).catch((err) => console.warn('[assistant] gcloud login', err))
      return 'gcloud auth login opened in the browser. After the user approves, call integration_status gcp; then configure_gcp with the project.'
    }
  },
  {
    name: 'gcp_projects',
    description: 'Google Cloud projects visible to a signed-in gcloud account (default: the active one).',
    shape: { account: z.string().optional() },
    run: async (i) => pretty(await gcp.projects(i.account ? String(i.account) : undefined))
  },
  {
    name: 'configure_gcp',
    description: 'Set the Google Cloud project (and optionally account and default region) for the app or a space. Sessions there get read-only logs, Cloud Run and Error Reporting tools; the on-call agent uses them too.',
    shape: { scope: z.string().describe('"app" or space id / name'), projectId: z.string(), account: z.string().optional(), region: z.string().optional() },
    run: async (i) => {
      const cfg = { projectId: String(i.projectId), ...(i.account ? { account: String(i.account) } : {}), ...(i.region ? { region: String(i.region) } : {}) }
      const scope = String(i.scope)
      getStore().update((d) => {
        if (scope === 'app') d.settings.gcp = cfg
        else d.spaces.find((x) => x.id === spaceOrThrow(scope).id)!.gcp = cfg
      })
      return `Google Cloud project ${cfg.projectId} set for ${scope === 'app' ? 'the app' : spaceOrThrow(scope).name}.`
    }
  },
  {
    name: 'slack_channels',
    description: 'Slack channels visible to a connection (for on-call setup). Returns id, name, private, member.',
    shape: { spaceId: z.string().optional(), query: z.string().optional() },
    run: async (i) => pretty((await slack.listChannels(slack.connectionForSpace(connId(i.spaceId as string | undefined) || undefined), String(i.query ?? ''))).slice(0, 60))
  },
  {
    name: 'configure_oncall',
    description: 'Turn the on-call agent on or off for a space (or the app) and set its channels (id, name, kind support|alerts), poll interval, hourly triage cap and team context. Needs a Slack connection.',
    shape: { scope: z.string(), patch: z.object({ enabled: z.boolean().optional(), channels: z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(['support', 'alerts']) })).optional(), pollSeconds: z.number().int().min(30).max(3600).optional(), maxTriagesPerHour: z.number().int().min(1).max(60).optional(), context: z.string().optional(), model: z.string().optional() }) },
    run: async (i) => {
      const scope = String(i.scope)
      const patch = i.patch as Partial<OnCallSettings>
      getStore().update((d) => {
        const holder = scope === 'app' ? d.settings : d.spaces.find((x) => x.id === spaceOrThrow(scope).id)!
        holder.oncall = { ...oncall.DEFAULT_ONCALL, ...(holder.oncall ?? {}), ...patch }
      })
      oncall.reconcile()
      return `On-call ${patch.enabled === false ? 'off' : 'configured'} for ${scope === 'app' ? 'the app' : spaceOrThrow(scope).name}.`
    }
  },
  {
    name: 'add_claude_account',
    description: 'Register another agent login (vendor anthropic | openai | google | xai). The actual sign-in runs in a terminal inside Settings → Accounts; call open_settings accounts afterwards and tell the user to press Sign in.',
    shape: { name: z.string().min(1).max(40), vendor: z.enum(['anthropic', 'openai', 'google', 'xai']).optional() },
    run: async (i) => {
      const before = new Set(getStore().get().settings.claudeAccounts.map((a) => a.id))
      const s = addAccount(String(i.name), (i.vendor as 'anthropic' | undefined) ?? 'anthropic')
      const added = s.claudeAccounts.find((a) => !before.has(a.id))
      return `Account ${String(i.name)} added${added ? ` (id ${added.id})` : ''}. It still needs a sign-in from Settings → Accounts.`
    }
  },
  {
    name: 'list_workspaces',
    description: 'Workspaces (tasks) with their space, stage, status, repos and branches, last activity and open todos. Optionally one space.',
    shape: { space: z.string().optional().describe('space id or name') },
    run: async (i) => {
      const { spaces, workspaces } = getStore().get()
      const sid = i.space ? spaceOrThrow(String(i.space)).id : undefined
      return pretty(
        workspaces
          .filter((w) => w.status !== 'archived' && (!sid || w.spaceId === sid))
          .map((w) => ({ id: w.id, name: w.name, space: spaces.find((s) => s.id === w.spaceId)?.name ?? null, stage: w.stage, status: w.status, repos: w.repos.map((r) => `${r.repoName}@${r.branch} (${r.worktreePath})`), lastMessageAt: w.lastMessageAt ?? null, engine: w.engine ?? 'space/app default', costMode: costModeFor(w.spaceId, w.id) }))
      )
    }
  },
  {
    name: 'workspace_transcript',
    description: "The recent conversation of a workspace (or of an agent's own chat: pass agent:<id>): who said what and which tools ran. Use it to answer 'what happened in X' or 'what is the agent doing'.",
    shape: { workspaceId: z.string(), last: z.number().int().min(1).max(60).optional().describe('How many items from the end, default 20') },
    run: async (i) => {
      const id = String(i.workspaceId)
      const items = getTranscript(id.startsWith('agent:') ? agentOwner(id.slice(6)) : id).slice(-(Number(i.last) || 20))
      if (items.length === 0) return 'No conversation yet.'
      return items
        .map((it) => {
          const text = it.blocks.map((b) => (b.type === 'text' ? b.text : b.type === 'tool' ? `[tool ${b.name}${b.done ? '' : ' (running)'}${b.isError ? ' failed' : ''}]` : '')).join(' ').trim()
          return `${it.createdAt.slice(0, 16).replace('T', ' ')} ${it.role}: ${text.slice(0, 1200)}`
        })
        .join('\n')
    }
  },
  {
    name: 'send_to_workspace',
    description: "Send a message into a workspace's conversation, as if the user typed it there; the orchestrator of that workspace acts on it. Confirm with the user first. Returns at once; read workspace_transcript later for the outcome.",
    shape: { workspaceId: z.string(), text: z.string().min(1) },
    run: async (i) => {
      const ws = getStore().get().workspaces.find((w) => w.id === String(i.workspaceId))
      if (!ws) throw new Error('No such workspace. Call list_workspaces.')
      await needHost().sendToWorkspace(ws.id, String(i.text))
      return `Sent to "${ws.name}". It runs there; check workspace_transcript for the reply.`
    }
  },
  {
    name: 'open_workspace',
    description: 'Show a workspace in the main window.',
    shape: { workspaceId: z.string() },
    run: async (i) => {
      needHost().openWorkspace(String(i.workspaceId))
      return 'Opened.'
    }
  },
  {
    name: 'notes_list',
    description: 'Notes and todos, everywhere or filtered: owner (a workspace id, "space:<id>" or "app"), source (user|agent), kind (note|todo), openOnly, since (ISO date), query (text).',
    shape: { owner: z.string().optional(), source: z.enum(['user', 'agent']).optional(), kind: z.enum(['note', 'todo']).optional(), openOnly: z.boolean().optional(), since: z.string().optional(), query: z.string().optional() },
    run: async (i) => {
      const groups = notes.filtered({ ...(i.owner ? { owners: [String(i.owner)] } : {}), ...(i.source ? { source: i.source as 'user' | 'agent' } : {}), ...(i.kind ? { kind: i.kind as 'note' | 'todo' } : {}), ...(i.openOnly ? { openOnly: true } : {}), ...(i.since ? { since: String(i.since) } : {}), ...(i.query ? { query: String(i.query) } : {}) })
      if (groups.length === 0) return 'Nothing matches.'
      return groups.map((g) => `## ${g.label} (owner ${g.owner})\n${g.notes.map((n) => `- [${n.id}] ${n.kind === 'todo' ? (n.done ? '[x] ' : '[ ] ') : ''}${n.text} (${n.source}, ${n.createdAt.slice(0, 10)})`).join('\n')}`).join('\n\n')
    }
  },
  {
    name: 'notes_add',
    description: 'Add a note or todo. owner: "app" (default, tied to no project), "space:<id>", or a workspace id. Optional priority and due date (YYYY-MM-DD).',
    shape: { text: z.string().min(1), kind: z.enum(['note', 'todo']).default('todo'), owner: z.string().optional(), priority: z.enum(['low', 'medium', 'high']).optional(), due: z.string().optional() },
    run: async (i) => {
      const owner = String(i.owner || notes.APP_OWNER)
      const list = notes.add(owner, String(i.text), (i.kind as 'note' | 'todo') ?? 'todo', 'agent')
      const last = list[list.length - 1]
      if (last && (i.priority || i.due)) notes.update(owner, last.id, { ...(i.priority ? { priority: i.priority as 'low' | 'medium' | 'high' } : {}), ...(i.due ? { due: String(i.due) } : {}) })
      return `Added to ${notes.ownerLabel(owner)}.`
    }
  },
  {
    name: 'notes_update',
    description: 'Edit a note: text, status (todo|doing|done), priority (low|medium|high), due date (YYYY-MM-DD), tags, kind. Pass the owner from notes_list.',
    shape: { owner: z.string(), id: z.string(), text: z.string().optional(), status: z.enum(['todo', 'doing', 'done']).optional(), done: z.boolean().optional(), priority: z.enum(['low', 'medium', 'high']).optional(), due: z.string().optional(), tags: z.array(z.string()).optional(), kind: z.enum(['note', 'todo']).optional() },
    run: async (i) => {
      notes.update(String(i.owner), String(i.id), { ...(i.text !== undefined ? { text: String(i.text) } : {}), ...(i.status ? { status: i.status as 'todo' | 'doing' | 'done' } : {}), ...(i.done !== undefined ? { done: Boolean(i.done) } : {}), ...(i.priority ? { priority: i.priority as 'low' | 'medium' | 'high' } : {}), ...(i.due !== undefined ? { due: String(i.due) } : {}), ...(i.tags !== undefined ? { tags: i.tags as string[] } : {}), ...(i.kind ? { kind: i.kind as 'note' | 'todo' } : {}) })
      return 'Updated.'
    }
  },
  {
    name: 'notes_remove',
    description: 'Delete a note. Only when the user asked for it.',
    shape: { owner: z.string(), id: z.string() },
    run: async (i) => {
      notes.remove(String(i.owner), String(i.id))
      return 'Removed.'
    }
  },
  {
    name: 'list_agents',
    description: 'The agent library: crew members and standalone agents, with model, tools, scope, schedule and last run.',
    shape: {},
    run: async () => pretty((overview() as { agents: unknown }).agents)
  },
  {
    name: 'get_agent',
    description: 'Full definition of one agent: prompt, description, model, tools, schedule, and its recent runs.',
    shape: { agent: z.string().describe('agent id or name') },
    run: async (i) => {
      const a = agentOrThrow(String(i.agent))
      return pretty({ ...a, runs: runs.runs(a.id).slice(0, 10).map((r) => ({ trigger: r.trigger, startedAt: r.startedAt, endedAt: r.endedAt, error: r.error, report: r.report?.slice(0, 400) })) })
    }
  },
  {
    name: 'save_agent',
    description: 'Create an agent (no id) or update one (id). Fields left out are kept. crew=false is standalone (the user runs it by @name, chat or schedule); crew=true offers it to orchestrators. schedule: {enabled, kind: interval|daily, everyMinutes, at "HH:MM", prompt}. Confirm with the user before creating or changing.',
    shape: {
      id: z.string().optional(),
      name: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i).optional(),
      description: z.string().optional(),
      prompt: z.string().optional(),
      model: z.string().optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      tools: z.array(z.string()).optional().describe('Allow-list; e.g. ["mcp__slack","mcp__notes"] for a Slack agent, ["Read","Grep","Glob"] for read-only code roles; omit for everything'),
      maxTurns: z.number().int().min(5).max(200).optional(),
      icon: z.string().optional(),
      crew: z.boolean().optional(),
      enabled: z.boolean().optional(),
      scope: z.string().optional().describe('space id or name to restrict it to one space; "" for every space'),
      schedule: z.object({ enabled: z.boolean(), kind: z.enum(['interval', 'daily']), everyMinutes: z.number().int().min(5).optional(), at: z.string().optional(), prompt: z.string().optional() }).optional()
    },
    run: async (i) => {
      const existing = i.id ? library.get(String(i.id)) : undefined
      if (i.id && !existing) throw new Error(`No agent ${String(i.id)}`)
      if (!existing && (!i.name || !i.prompt)) throw new Error('A new agent needs at least a name and a prompt.')
      const scope = i.scope === undefined ? existing?.scope : i.scope ? spaceOrThrow(String(i.scope)).id : undefined
      const spec: AgentSpec = {
        id: existing?.id ?? '',
        name: String(i.name ?? existing?.name ?? ''),
        description: String(i.description ?? existing?.description ?? ''),
        prompt: String(i.prompt ?? existing?.prompt ?? ''),
        model: String(i.model ?? existing?.model ?? 'sonnet'),
        enabled: i.enabled === undefined ? (existing?.enabled ?? true) : Boolean(i.enabled),
        crew: i.crew === undefined ? Boolean(existing?.crew) : Boolean(i.crew),
        ...(i.effort !== undefined ? { effort: i.effort as AgentSpec['effort'] } : existing?.effort ? { effort: existing.effort } : {}),
        ...(i.tools !== undefined ? { tools: i.tools as string[] } : existing?.tools ? { tools: existing.tools } : {}),
        ...(i.maxTurns !== undefined ? { maxTurns: Number(i.maxTurns) } : existing?.maxTurns ? { maxTurns: existing.maxTurns } : {}),
        ...(i.icon !== undefined ? { icon: String(i.icon) } : existing?.icon ? { icon: existing.icon } : {}),
        ...(scope ? { scope } : {}),
        ...(i.schedule !== undefined ? { schedule: i.schedule as AgentSpec['schedule'] } : existing?.schedule ? { schedule: existing.schedule } : {})
      }
      const saved = library.save(spec)
      return `${existing ? 'Updated' : 'Created'} agent ${saved.name} (id ${saved.id}, ${saved.crew ? 'crew' : 'standalone'}${saved.schedule?.enabled ? ', scheduled' : ''}).`
    }
  },
  {
    name: 'delete_agent',
    description: 'Delete an agent from the library. Only when the user named it.',
    shape: { agent: z.string() },
    run: async (i) => {
      const a = agentOrThrow(String(i.agent))
      library.remove(a.id)
      return `Deleted ${a.name}.`
    }
  },
  {
    name: 'run_agent',
    description: "Run an agent now with a task and wait for its report (up to a few minutes). The exchange also appears in the agent's own chat. Use it to delegate anything an agent is built for, e.g. a Slack sweep.",
    shape: { agent: z.string(), task: z.string().min(1) },
    run: async (i) => runs.ask(agentOrThrow(String(i.agent)).id, String(i.task))
  },
  {
    name: 'run_agent_task',
    description: "Start an agent's standing (scheduled) task now, as its schedule would. Returns when it finishes.",
    shape: { agent: z.string() },
    run: async (i) => {
      const a = agentOrThrow(String(i.agent))
      await scheduler.runNow(a.id)
      return runs.lastRun(a.id)?.report ?? runs.lastRun(a.id)?.error ?? 'Done.'
    }
  },
  {
    name: 'oncall_incidents',
    description: 'On-call incidents Sinfonie has seen: title, channel, status, severity.',
    shape: { all: z.boolean().optional().describe('Include resolved and dismissed') },
    run: async (i) => {
      const inc = oncall.state().incidents.filter((x) => i.all || (x.status !== 'resolved' && x.status !== 'dismissed'))
      return inc.length ? pretty(inc.map((x) => ({ id: x.id, title: x.title, channel: x.channelName, status: x.status, severity: (x as unknown as { severity?: string }).severity }))) : 'No incidents.'
    }
  },
  {
    name: 'open_settings',
    description: 'Open a settings page in the app for the user, for anything this assistant cannot do itself: account sign-ins (terminal), API keys under providers, MCP servers with secrets, resources. App pages: general, spaces, repos, providers, accounts, crew, resources, usage, oncall, jira, linear, slack, gcp, mcp, about. Space pages: general, repos, crew, oncall, jira, linear, slack, gcp, github, mcp.',
    shape: { page: z.string(), spaceId: z.string().optional() },
    run: async (i) => {
      const page = String(i.page)
      if (i.spaceId) needHost().openSettings({ scope: 'space', spaceId: spaceOrThrow(String(i.spaceId)).id, page })
      else needHost().openSettings({ scope: 'app', page })
      return `Opened ${i.spaceId ? `${spaceOrThrow(String(i.spaceId)).name} → ` : ''}${page}.`
    }
  }
]

function server(c: Conversation): NonNullable<Options['mcpServers']>[string] {
  return createSdkMcpServer({
    name: 'sinfonie',
    tools: TOOLS.map((t) =>
      sdkTool(t.name, t.description, t.shape, async (args) => {
        const started = Date.now()
        try {
          const text = await t.run(args as Record<string, unknown>)
          push(c, { role: 'tool', text: text.slice(0, 4000), tool: { name: t.name, input: args as Record<string, unknown>, ok: true, ms: Date.now() - started } })
          return { content: [{ type: 'text', text }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          push(c, { role: 'tool', text: msg, tool: { name: t.name, input: args as Record<string, unknown>, ok: false, ms: Date.now() - started } })
          return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
        }
      })
    )
  })
}

const SYSTEM = `You are Maestro, Sinfonie's assistant, living inside the app: the one place the user can ask about anything Sinfonie knows and have it done. You configure the app, you know every space, workspace, agent, integration and note, and you use the same integrations the user's agents use (Slack, Jira, Linear, Google Cloud, MCP servers) through their tools. You never edit files or run shell commands yourself; for code work you send tasks to workspaces or run agents.

Sinfonie in one minute:
- A SPACE groups repositories (one product, one client, one team). Each space can have its own engine, model, permission mode, cost mode, crew, and integrations (Jira, Linear, Slack, Google Cloud, on-call, databases); anything unset falls back to the app default.
- A WORKSPACE is one task inside a space: a git worktree per repository the task touches, plus a conversation with an orchestrator agent. You can read its transcript (workspace_transcript) and send it a message (send_to_workspace); the user creates workspaces from the sidebar.
- AGENTS live in a library. A crew agent is a subagent orchestrators delegate to. A standalone agent is one the user runs directly: by @name in a workspace chat, in the agent's own chat, on a schedule (every N minutes or daily), or by you with run_agent. Agents have a name, description, prompt, model (haiku cheap and fast; sonnet the default coder; opus deep reasoning; fable the strongest), optional tool allow-list (mcp__slack for Slack, mcp__notes for notes, Read/Grep/Glob for read-only code) and turn cap.
- NOTES and todos live at three levels: a workspace, a space ("space:<id>"), or the app ("app", tied to no project). Agents file into them; the user sees everything in the Notes view.
- The ENGINE runs conversations: claude-code (default, the user's Claude login), native (API providers), codex, gemini, grok.
- COST MODES: standard, budget (Sonnet orchestrator, low effort, capped calls), lean (one Sonnet agent, no crew, trimmed tools).
- INTEGRATIONS: Slack, Jira and Linear sign in through the browser; Google Cloud uses the local gcloud login; GitHub uses gh. The on-call agent watches Slack channels and triages incidents. The review cockpit runs AI reviews on pull requests.
- Accounts: several Claude/OpenAI/Google/xAI logins can coexist; spaces and workspaces pick one.

How you work:
1. Start every conversation by calling get_overview; it has the spaces, workspaces, agents, notes, integrations and accounts. Answer from it when you can; call the specific tools for detail (list_workspaces, workspace_transcript, notes_list, get_agent, oncall_incidents, integration_status).
2. Use the integrations directly when the question needs them: Slack tools (mcp__slack) to search messages, Jira and Linear tools for issues, Google Cloud tools for logs, MCP servers the user configured. Say which you used.
3. Before any write (settings, spaces, crews, agents, notes, sending a message to a workspace), say what you are about to change in one or two lines and get a clear yes, or use AskUserQuestion with the options. After a write, confirm what changed. Never delete anything without the user naming it.
4. Prefer AskUserQuestion for choices (at most 4 questions per card, 2 to 4 options each). Use plain text for open-ended questions. Keep replies short and concrete.
5. Delegate real work: a Slack sweep goes to a Slack agent with run_agent; a code change goes to the right workspace with send_to_workspace (then read its transcript when asked). Create an agent with save_agent when a recurring job has none; propose a schedule when the user wants it to happen by itself.
6. Crew setup is an interview, not a form: what they build, how they test, review, deploy, team size, budget priority. Read the repositories (package.json, CI config, README) instead of asking what you can see. Then propose 3 to 5 crew members with concrete prompts, models matched to role and budget, read-only tools for explorer and reviewer roles, sensible turn caps; show, adjust, then set_crew.
7. Repositories: scan likely folders, show what you found, add the ones they pick into the right space.
8. Sign-ins open the browser; you cannot complete them. Say so, wait for the user, then verify with integration_status. Things that need a terminal or a secret (account sign-ins, provider API keys, MCP servers, Slack advanced client) are done by the user on the settings page you open with open_settings.
9. If something is outside what the tools can do, say so and open the right settings page.
10. Link what you mention so the user can jump there: [name](sinfonie://workspace/<id>), [name](sinfonie://agent/<id>), [name](sinfonie://space/<id>), [Notes](sinfonie://notes), [Agents](sinfonie://agents), [Settings › page](sinfonie://settings/app/<page>) or sinfonie://settings/space/<spaceId>/<page>. Use the ids from get_overview.
Reply in the user's language.`

// ---------- a turn ----------

/** The assistant's servers: its own tools, plus the integrations an app-level session gets (Slack, Jira, Linear, Google Cloud, the user's MCP servers). */
async function assistantServers(c: Conversation): Promise<NonNullable<Options['mcpServers']>> {
  const out: NonNullable<Options['mcpServers']> = { sinfonie: server(c) }
  if (slack.connection('').connected) out.slack = slackTools.sdkServer('')
  try {
    const ctx = { id: `maestro:${c.id}`, name: 'Maestro', slug: 'maestro', rootPath: homedir(), repos: [], primaryRepoId: '', port: 0, status: 'ready' as const, createdAt: new Date().toISOString(), stage: 'in-progress' as const, ...(c.context?.spaceId ? { spaceId: c.context.spaceId } : {}) }
    Object.assign(out, await mcpServersFor(ctx, (w) => push(c, { role: 'system', text: w })))
  } catch (err) {
    console.warn('[maestro] integrations unavailable', err)
  }
  return out
}

function contextLine(c: Conversation): string {
  const { workspaces, spaces } = getStore().get()
  const ws = c.context?.workspaceId ? workspaces.find((w) => w.id === c.context!.workspaceId) : undefined
  const sp = spaces.find((s) => s.id === (ws?.spaceId ?? c.context?.spaceId))
  if (!ws && !sp) return ''
  return `Context: the user opened this conversation from ${ws ? `the workspace "${ws.name}" (id ${ws.id}${sp ? `, space ${sp.name}` : ''})` : `the space "${sp!.name}" (id ${sp!.id})`}. Assume questions are about it unless they say otherwise.\n\n`
}

/** A short title from the first exchange, best effort, with a cheap model. */
async function titleFor(c: Conversation): Promise<void> {
  if (c.titleLocked || c.items.filter((i) => i.role === 'assistant').length !== 1) return
  const user = c.items.find((i) => i.role === 'user')?.text ?? ''
  const reply = c.items.find((i) => i.role === 'assistant')?.text ?? ''
  const { settings } = getStore().get()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 20_000)
  try {
    let title = ''
    for await (const msg of query({ prompt: `Title this conversation in 3 to 6 words, no quotes, no trailing period, same language as the user.\n\nUser: ${user.slice(0, 600)}\n\nAssistant: ${reply.slice(0, 600)}`, options: { ...claudeExecutableOption(), cwd: homedir(), model: 'haiku', maxTurns: 1, allowedTools: [], settingSources: [], abortController: abort, env: { ...process.env, ...accountEnv(settings.defaultClaudeAccountId) } } }) as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result' && msg.subtype === 'success') title = msg.result.trim().replace(/^["']|["'.]$/g, '')
    }
    if (title && !c.titleLocked) {
      c.title = title.slice(0, 80)
      save(c)
      emit({ conversationId: c.id, type: 'meta', meta: meta(c) })
    }
  } catch {
    /* the first message stays as the title */
  } finally {
    clearTimeout(timer)
  }
}

export async function send(id: string, text: string): Promise<void> {
  const c = need(id)
  if (running.has(id)) throw new Error('Maestro is still answering here; wait or stop it.')
  const { settings, repos } = getStore().get()
  const first = c.items.length === 0
  push(c, { role: 'user', text })
  if (first && !c.titleLocked) {
    c.title = text.trim().slice(0, 60)
    save(c)
    emit({ conversationId: id, type: 'meta', meta: meta(c) })
  }
  const abort = new AbortController()
  running.set(id, abort)
  emit({ conversationId: id, type: 'status', busy: true })
  const accountId = settings.defaultClaudeAccountId ?? defaultAccountId('anthropic') ?? 'default'
  const model = costModeFor(undefined) !== 'standard' ? leanModel(settings.model) : settings.model
  const root = settings.workspacesRoot.startsWith('~') ? join(homedir(), settings.workspacesRoot.slice(1)) : settings.workspacesRoot
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  const canUseTool: NonNullable<Options['canUseTool']> = async (toolName, toolInput, opts) => {
    if (toolName === 'AskUserQuestion') {
      const questions = ((toolInput as { questions?: { question: string; header: string; multiSelect?: boolean; options?: { label: string; description: string }[] }[] }).questions ?? []).map((q) => ({ question: q.question, header: q.header, multiSelect: Boolean(q.multiSelect), options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })) }))
      const reply = await askQuestion(`maestro:${id}`, questions, opts.signal)
      if (reply.cancelled) return { behavior: 'deny', message: 'The user dismissed the questions. Continue in plain text.' }
      const updatedInput: Record<string, unknown> = { questions: (toolInput as { questions?: unknown }).questions, answers: reply.answers }
      if (reply.response) updatedInput.response = reply.response
      return { behavior: 'allow', updatedInput }
    }
    const r: PermissionResult = { behavior: 'allow', updatedInput: toolInput }
    return r
  }
  const options: Options = {
    ...claudeExecutableOption(),
    cwd: root,
    additionalDirectories: repos.map((r) => r.path).filter((p) => existsSync(p)).slice(0, 30),
    permissionMode: 'default',
    model,
    thinking: { type: 'adaptive', display: 'summarized' },
    includePartialMessages: true,
    abortController: abort,
    canUseTool,
    mcpServers: await assistantServers(c),
    strictMcpConfig: true,
    settingSources: [],
    // AskUserQuestion stays out of allowedTools so it reaches canUseTool and shows the card.
    allowedTools: ['Read', 'Grep', 'Glob', ...TOOLS.map((t) => `mcp__sinfonie__${t.name}`)],
    disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'EnterPlanMode', 'ExitPlanMode'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM },
    maxTurns: 40,
    env: { ...process.env, ...accountEnv(accountId) },
    ...(c.sessionId ? { resume: c.sessionId } : {}),
    stderr: (d) => console.error('[maestro]', d.trimEnd()),
    spawnClaudeCodeProcess: (o) => {
      const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal })
      resources.registerProcess(child.pid, { kind: 'agent', label: 'Maestro' })
      child.once('exit', () => resources.unregisterProcess(child.pid))
      return child as unknown as SpawnedProcess
    }
  }
  let current: AssistantItem | null = null
  let streamed = ''
  const prompt = first ? `${contextLine(c)}${text}` : text
  try {
    for await (const msg of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        c.sessionId = msg.session_id
        save(c)
      } else if (msg.type === 'stream_event') {
        const ev = msg.event as { type: string; delta?: { type: string; text?: string } }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          if (!current) {
            current = push(c, { role: 'assistant', text: '' })
            streamed = ''
          }
          streamed += ev.delta.text
          emit({ conversationId: id, type: 'delta', id: current.id, text: streamed })
        }
      } else if (msg.type === 'assistant') {
        const blocks = msg.message.content as { type: string; text?: string; name?: string }[]
        const full = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
        if (current) {
          current.text = full || streamed
          save(c)
          emit({ conversationId: id, type: 'item', item: current })
          current = null
        } else if (full.trim()) push(c, { role: 'assistant', text: full })
        streamed = ''
      } else if (msg.type === 'result') {
        if (current) {
          current.text = streamed
          save(c)
          emit({ conversationId: id, type: 'item', item: current })
          current = null
        }
        try {
          usage.recordTurn(usage.fromResult(msg, { workspaceId: '', spaceId: '', accountId, kind: 'chat' }))
        } catch {
          /* ledger must not break the assistant */
        }
        if (msg.subtype !== 'success' && !abort.signal.aborted) push(c, { role: 'system', text: `Maestro stopped: ${msg.subtype.replace(/_/g, ' ')}${'errors' in msg && Array.isArray(msg.errors) ? ` (${(msg.errors as string[]).join('; ')})` : ''}` })
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) push(c, { role: 'system', text: `Maestro error: ${err instanceof Error ? err.message : String(err)}` })
  } finally {
    running.delete(id)
    emit({ conversationId: id, type: 'status', busy: false })
    emit({ conversationId: id, type: 'meta', meta: meta(c) })
    void titleFor(c)
  }
}
