/**
 * The settings assistant: a Claude conversation that can read and change Sinfonie's own
 * configuration through an in-process tool server. It creates spaces, adds repositories, designs
 * and saves crews after interviewing the user, sets cost modes, starts sign-ins for integrations,
 * configures Google Cloud and on-call, and opens a settings page when something needs the user's
 * hands (terminal logins, API keys). Every write is confirmed in conversation first.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
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
import { DEFAULT_CREW, SPACE_COLORS, type AgentSpec, type AssistantItem, type CostMode, type CostModeScope, type OnCallSettings, type Repo, type Space, type Settings } from '@shared/types'

export const ASSISTANT_WORKSPACE_ID = 'assistant'

// ---------- host callbacks (things that live in ipc.ts) ----------
interface Host {
  addRepoAt: (path: string, spaceId?: string) => Promise<Repo>
  setCostMode: (scope: CostModeScope, mode: CostMode | null) => void
  openSettings: (target: { scope: 'app'; page: string } | { scope: 'space'; spaceId: string; page: string }) => void
}
let host: Host | null = null
export function setHost(h: Host): void {
  host = h
}
const needHost = (): Host => {
  if (!host) throw new Error('assistant host not wired')
  return host
}

// ---------- transcript ----------
interface Persisted {
  items: AssistantItem[]
  sessionId?: string
}
let data: Persisted = { items: [] }
let loaded = false
let busy = false
let abort: AbortController | null = null
let emit: (e: AssistantEvent) => void = () => undefined
export type AssistantEvent = { type: 'item'; item: AssistantItem } | { type: 'delta'; id: string; text: string } | { type: 'status'; busy: boolean } | { type: 'reset' }

function file(): string {
  return join(app.getPath('userData'), 'assistant.json')
}
function load(): void {
  if (loaded) return
  loaded = true
  try {
    if (existsSync(file())) data = JSON.parse(readFileSync(file(), 'utf8')) as Persisted
  } catch {
    data = { items: [] }
  }
}
function save(): void {
  try {
    writeFileSync(file(), JSON.stringify({ ...data, items: data.items.slice(-400) }))
  } catch {
    /* best effort */
  }
}
export function setEmitter(fn: (e: AssistantEvent) => void): void {
  emit = fn
}
export function history(): { items: AssistantItem[]; busy: boolean } {
  load()
  return { items: data.items, busy }
}
export function reset(): void {
  load()
  abort?.abort()
  data = { items: [] }
  save()
  emit({ type: 'reset' })
}
export function stop(): void {
  abort?.abort()
}
function push(item: Omit<AssistantItem, 'id' | 'createdAt'> & { id?: string }): AssistantItem {
  const full: AssistantItem = { id: item.id ?? nanoid(8), createdAt: new Date().toISOString(), ...item }
  data.items.push(full)
  save()
  emit({ type: 'item', item: full })
  return full
}

// ---------- helpers ----------
const MODEL_RE = /^(haiku|sonnet|opus|fable|claude-[a-z0-9.-]+|[a-z0-9-]+\/[A-Za-z0-9._:-]+)$/
const spaceOrThrow = (id: string): Space => {
  const s = getStore().get().spaces.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase())
  if (!s) throw new Error(`No space "${id}". Call get_overview for the list.`)
  return s
}
const connId = (spaceId?: string): string => (spaceId ? spaceOrThrow(spaceId).id : '')
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
      defaultCrew: crewSummary(settings.agents),
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
      crew: s.agents ? crewSummary(s.agents) : 'app default crew',
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
    description: 'Full crew specs (name, description, prompt, model, effort, tools, maxTurns, enabled) for the app default or one space.',
    shape: { scope: z.string().describe('"app" or a space id / name') },
    run: async (i) => {
      const scope = String(i.scope)
      const { settings } = getStore().get()
      const agents = scope === 'app' ? settings.agents : (spaceOrThrow(scope).agents ?? null)
      return agents ? pretty(agents) : 'This space uses the app default crew. Pass scope "app" to see it, or set_crew for the space to give it its own.'
    }
  },
  {
    name: 'set_crew',
    description: 'Save a crew: the subagents the orchestrator can delegate to. Replaces the whole list for the scope. Confirm the design with the user first. Models: haiku (cheap, fast), sonnet (default coder), opus (deep reasoning), fable (strongest, expensive), or provider/model for API providers. Give read-only roles tools ["Read","Grep","Glob"].',
    shape: { scope: z.string().describe('"app" or a space id / name'), agents: z.array(agentShape).min(1).max(8), useCrew: z.boolean().optional().describe('Space only: false turns delegation off') },
    run: async (i) => {
      const scope = String(i.scope)
      const parsed = z.array(agentShape).parse(i.agents)
      const names = new Set<string>()
      for (const a of parsed) {
        if (names.has(a.name)) throw new Error(`Duplicate crew name ${a.name}`)
        names.add(a.name)
      }
      const specs: AgentSpec[] = parsed.map((a) => ({ id: a.name, name: a.name, description: a.description, prompt: a.prompt, model: a.model, ...(a.effort ? { effort: a.effort } : {}), ...(a.tools?.length ? { tools: a.tools } : {}), ...(a.maxTurns ? { maxTurns: a.maxTurns } : {}), enabled: a.enabled !== false }))
      getStore().update((d) => {
        if (scope === 'app') d.settings.agents = specs
        else {
          const s = d.spaces.find((x) => x.id === spaceOrThrow(scope).id)!
          s.agents = specs
          if (typeof i.useCrew === 'boolean') {
            if (i.useCrew) delete s.useCrew
            else s.useCrew = false
          }
        }
      })
      return `Saved ${specs.length} crew member(s) for ${scope === 'app' ? 'the app default' : `space ${spaceOrThrow(scope).name}`}: ${specs.map((s) => `${s.name} (${s.model})`).join(', ')}. New sessions in that scope use them.`
    }
  },
  {
    name: 'reset_crew_to_default',
    description: 'Restore the built-in default crew (explorer, implementer, tester, reviewer) for the app, or make a space inherit the app default again.',
    shape: { scope: z.string() },
    run: async (i) => {
      const scope = String(i.scope)
      getStore().update((d) => {
        if (scope === 'app') d.settings.agents = DEFAULT_CREW.map((a) => ({ ...a }))
        else {
          const s = d.spaces.find((x) => x.id === spaceOrThrow(scope).id)!
          delete s.agents
        }
      })
      return scope === 'app' ? 'App default crew restored.' : 'The space now inherits the app default crew.'
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

function server(): NonNullable<Options['mcpServers']>[string] {
  return createSdkMcpServer({
    name: 'sinfonie',
    tools: TOOLS.map((t) =>
      sdkTool(t.name, t.description, t.shape, async (args) => {
        const started = Date.now()
        try {
          const text = await t.run(args as Record<string, unknown>)
          push({ role: 'tool', text: text.slice(0, 4000), tool: { name: t.name, input: args as Record<string, unknown>, ok: true, ms: Date.now() - started } })
          return { content: [{ type: 'text', text }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          push({ role: 'tool', text: msg, tool: { name: t.name, input: args as Record<string, unknown>, ok: false, ms: Date.now() - started } })
          return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
        }
      })
    )
  })
}

const SYSTEM = `You are Sinfonie's setup assistant, living inside the app. You configure Sinfonie for the user by talking with them and calling the sinfonie tools; you never edit files or run shell commands.

Sinfonie in one minute:
- A SPACE groups repositories (one product, one client, one team). Each space can have its own engine, model, permission mode, cost mode, crew, and integrations (Jira, Linear, Slack, Google Cloud, on-call); anything unset falls back to the app default.
- A WORKSPACE is one task inside a space: a git worktree per repository the task touches, plus a conversation with an agent. The user creates workspaces from the sidebar; you do not create them.
- The ENGINE runs the conversation: claude-code (default, uses the user's Claude login), native (API providers with keys), codex, gemini, grok (their CLIs).
- The CREW is the set of subagents the orchestrator can delegate to. Each has a name, a description (when to delegate), a system prompt, a model (haiku cheap and fast; sonnet the default coder; opus deep reasoning; fable the strongest and most expensive), an effort, optional tool allow-list and turn cap. Spaces can override the app default crew or turn delegation off.
- COST MODES: standard, budget (Sonnet orchestrator, low effort, 60 tool calls per message), lean (one Sonnet agent, no crew, trimmed tools, 25 calls per message). Lean is for tight subscriptions.
- INTEGRATIONS: Slack and Linear/Jira sign in through the browser (OAuth); Google Cloud uses the local gcloud login and a project per space; GitHub uses the gh CLI. The on-call agent watches Slack channels, triages incidents, and can open draft PRs with fixes.
- Accounts: several Claude/OpenAI/Google/xAI logins can coexist; spaces and workspaces pick one.

How you work:
1. Start every conversation by calling get_overview, then answer or act. Keep replies short and concrete; use lists sparingly.
2. Before any write, say what you are about to change in one or two lines and get a clear yes (or use AskUserQuestion with the options). After a write, confirm what changed. Never delete anything without the user naming it.
3. Prefer AskUserQuestion for choices (at most 4 questions per card, 2 to 4 options each, with an "Other" the user can type into). Use plain text for open-ended questions.
4. Crew setup is an interview, not a form. Learn: what they build (languages, frameworks, services, monorepo or many repos), how they test (unit, integration, e2e; how long the suite takes), how code gets reviewed and merged (PRs, CI, who approves), how they deploy (where, how often, migrations), team size and roles, what they want the agents to be good at, and their budget priority (cost, balanced, quality). Ask in two or three rounds, not twenty questions at once, and read the repositories (package.json, CI config, README) when they are registered instead of asking what you can see. Then propose 3 to 5 crew members with concrete prompts written for that team (name the test command, the review rules, the deploy caveats), models matched to the role and the budget priority, read-only tools for explorer and reviewer roles, and sensible turn caps. Show the proposal, adjust, then set_crew for the space they chose (or the app default).
5. Repositories: scan likely folders (ask which if unsure), show what you found, add the ones they pick into the right space.
6. Sign-ins open the browser; you cannot complete them. Say so, wait for the user to say they finished, then verify with integration_status. Things that need a terminal or a secret (account sign-ins, provider API keys, MCP servers, Slack advanced client) are done by the user on the settings page you open with open_settings.
7. If something is outside what the tools can do, say so and open the right settings page.
Reply in the user's language.`

// ---------- conversation ----------
export async function send(text: string): Promise<void> {
  load()
  if (busy) throw new Error('The assistant is still answering; wait or stop it.')
  const { settings, repos } = getStore().get()
  push({ role: 'user', text })
  busy = true
  abort = new AbortController()
  emit({ type: 'status', busy: true })
  const accountId = settings.defaultClaudeAccountId ?? defaultAccountId('anthropic') ?? 'default'
  const model = costModeFor(undefined) !== 'standard' ? leanModel(settings.model) : settings.model
  const root = settings.workspacesRoot.startsWith('~') ? join(homedir(), settings.workspacesRoot.slice(1)) : settings.workspacesRoot
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  const canUseTool: NonNullable<Options['canUseTool']> = async (toolName, toolInput, opts) => {
    if (toolName === 'AskUserQuestion') {
      const questions = ((toolInput as { questions?: { question: string; header: string; multiSelect?: boolean; options?: { label: string; description: string }[] }[] }).questions ?? []).map((q) => ({ question: q.question, header: q.header, multiSelect: Boolean(q.multiSelect), options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })) }))
      const reply = await askQuestion(ASSISTANT_WORKSPACE_ID, questions, opts.signal)
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
    mcpServers: { sinfonie: server() },
    strictMcpConfig: true,
    settingSources: [],
    // AskUserQuestion stays out of allowedTools so it reaches canUseTool and shows the card.
    allowedTools: ['Read', 'Grep', 'Glob', ...TOOLS.map((t) => `mcp__sinfonie__${t.name}`)],
    disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'EnterPlanMode', 'ExitPlanMode'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM },
    maxTurns: 40,
    env: { ...process.env, ...accountEnv(accountId) },
    ...(data.sessionId ? { resume: data.sessionId } : {}),
    stderr: (d) => console.error('[assistant]', d.trimEnd()),
    spawnClaudeCodeProcess: (o) => {
      const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal })
      resources.registerProcess(child.pid, { kind: 'agent', label: 'Assistant' })
      child.once('exit', () => resources.unregisterProcess(child.pid))
      return child as unknown as SpawnedProcess
    }
  }
  let current: AssistantItem | null = null
  let streamed = ''
  try {
    for await (const msg of query({ prompt: text, options }) as AsyncIterable<SDKMessage>) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        data.sessionId = msg.session_id
        save()
        if (process.env.SINFONIE_ASSISTANT_DEBUG) {
          const init = msg as unknown as { mcp_servers?: { name: string; status: string; error?: string }[]; tools?: string[] }
          console.error('[assistant] init mcp:', JSON.stringify(init.mcp_servers), 'sinfonie tools:', (init.tools ?? []).filter((t) => t.includes('sinfonie')).length, 'of', (init.tools ?? []).length)
        }
      } else if (msg.type === 'stream_event') {
        const ev = msg.event as { type: string; delta?: { type: string; text?: string } }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          if (!current) {
            current = push({ role: 'assistant', text: '' })
            streamed = ''
          }
          streamed += ev.delta.text
          emit({ type: 'delta', id: current.id, text: streamed })
        }
      } else if (msg.type === 'assistant') {
        // The full message is authoritative; stream events may arrive around it in either order.
        const blocks = msg.message.content as { type: string; text?: string; name?: string }[]
        const full = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
        if (process.env.SINFONIE_ASSISTANT_DEBUG) console.error('[assistant] message blocks:', blocks.map((b) => b.type + (b.name ? ':' + b.name : '')).join(','), 'text', full.length)
        if (current) {
          current.text = full || streamed
          save()
          emit({ type: 'item', item: current })
          current = null
        } else if (full.trim()) push({ role: 'assistant', text: full })
        streamed = ''
      } else if (msg.type === 'result') {
        if (current) {
          current.text = streamed
          save()
          emit({ type: 'item', item: current })
          current = null
        }
        if (process.env.SINFONIE_ASSISTANT_DEBUG) console.error('[assistant] result', msg.subtype, 'turns', msg.num_turns)
        try {
          usage.recordTurn(usage.fromResult(msg, { workspaceId: '', spaceId: '', accountId, kind: 'chat' }))
        } catch {
          /* ledger must not break the assistant */
        }
        if (msg.subtype !== 'success' && !abort.signal.aborted) push({ role: 'system', text: `The assistant stopped: ${msg.subtype.replace(/_/g, ' ')}${'errors' in msg && Array.isArray(msg.errors) ? ` (${(msg.errors as string[]).join('; ')})` : ''}` })
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) push({ role: 'system', text: `Assistant error: ${err instanceof Error ? err.message : String(err)}` })
  } finally {
    busy = false
    abort = null
    emit({ type: 'status', busy: false })
  }
}
