// Shared types between main, preload and renderer.

export interface ConductorScripts {
  setup?: string
  run?: string
  archive?: string
}

/** sinfonie.json per repository (conductor.json is read as a fallback). */
export interface ConductorConfig {
  scripts?: ConductorScripts
  runScriptMode?: 'concurrent' | 'sequential'
}

/** An MCP server Claude can use in workspaces of a space (or everywhere, when set at app level). */
export interface McpServerSpec {
  id: string
  name: string
  transport: 'http' | 'sse' | 'stdio'
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled: boolean
}

/** A tag for workspaces. Belongs to a space, or to every space when spaceId is absent. */
export interface Label {
  id: string
  name: string
  color: string
  spaceId?: string
}

/**
 * A member of the crew: a subagent the orchestrator can delegate to, with its
 * own model, effort and tool surface. Maps onto the Agent SDK's AgentDefinition.
 */
export interface AgentSpec {
  id: string
  /** Also the subagent_type the orchestrator uses to call it. */
  name: string
  description: string
  prompt: string
  model: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Allow-list of tools; empty means everything the orchestrator has. */
  tools?: string[]
  disallowedTools?: string[]
  maxTurns?: number
  permissionMode?: PermissionMode
  enabled: boolean
}

export const DEFAULT_CREW: AgentSpec[] = [
  {
    id: 'explorer',
    name: 'explorer',
    description: 'Fast, cheap codebase exploration: find where something lives, how a function is used, which files a change touches. Read-only.',
    prompt: 'You explore code and report back. Answer the question precisely with file paths and line numbers, quoting the relevant snippets. Do not propose changes unless asked, and do not modify anything.',
    model: 'haiku',
    effort: 'low',
    tools: ['Read', 'Grep', 'Glob', 'LS', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git blame:*)'],
    maxTurns: 30,
    enabled: true
  },
  {
    id: 'implementer',
    name: 'implementer',
    description: 'Implements a well-specified change inside one repository: the task must say which worktree, which files or area, and what done looks like.',
    prompt: 'You implement exactly the change described, inside the worktree you are given. Read the surrounding code first, keep the diff minimal and consistent with the codebase, run the relevant tests or type-check if they are cheap, and finish with a short summary of what you changed and anything the caller should double-check.',
    model: 'sonnet',
    effort: 'high',
    maxTurns: 80,
    enabled: true
  },
  {
    id: 'tester',
    name: 'tester',
    description: 'Runs tests, linters and type-checks and reports failures with the exact error output. Does not fix anything.',
    prompt: 'Run the requested checks from the worktree you are given and report the results: which command, pass or fail, and the relevant error output trimmed to what matters. Do not edit files.',
    model: 'haiku',
    effort: 'medium',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    maxTurns: 20,
    enabled: true
  },
  {
    id: 'reviewer',
    name: 'reviewer',
    description: 'Careful review of a diff before it is committed: correctness, edge cases, security, tests. Read-only, thorough.',
    prompt: 'Review the change like a senior engineer who will be paged if it breaks. Read the diff and the surrounding code. Report findings ordered by severity with file and line, what is wrong, why it matters, and the fix. Say clearly whether it is safe to commit. Do not modify anything.',
    model: 'opus',
    effort: 'xhigh',
    tools: ['Read', 'Grep', 'Glob', 'LS', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
    maxTurns: 40,
    enabled: true
  }
]

// ---- Engines and providers ----

/**
 * Which agent runtime drives a chat. `claude-code` is the Claude Agent SDK
 * (uses the Claude Code login, Claude models only). `native` is Sinfonie's own
 * tool loop on the AI SDK: any provider, any model, including local ones.
 */
export type Engine = 'claude-code' | 'native' | 'codex' | 'gemini' | 'grok'

/** Engines that run a vendor CLI agent over the Agent Client Protocol, with the vendor's own login. */
export const ACP_ENGINES: { id: Extract<Engine, 'codex' | 'gemini' | 'grok'>; label: string; vendor: string; loginHint: string }[] = [
  { id: 'codex', label: 'Codex (OpenAI)', vendor: 'OpenAI', loginHint: 'Sign in with your ChatGPT account (Plus, Pro, Team) or an OpenAI API key.' },
  { id: 'gemini', label: 'Gemini CLI (Google)', vendor: 'Google', loginHint: 'Google retired the personal Google-account login for the Gemini CLI (it points to Antigravity instead). Add a Gemini API key under Model providers → Google and the engine signs in with it.' },
  { id: 'grok', label: 'Grok Build (xAI)', vendor: 'xAI', loginHint: 'Sign in with your grok.com account (SuperGrok) in the Grok CLI.' }
]

/** Progress of a vendor sign-in running in the background for one account. */
export interface LoginProgress {
  accountId: string
  terminalId: string
  phase: 'starting' | 'browser' | 'success' | 'failed'
  /** The sign-in URL once the CLI printed it, for a "browser did not open" fallback. */
  url?: string
  message?: string
}

export interface AcpProbe {
  engine: Engine
  installed: boolean
  agent?: string
  authMethods: { id: string; name: string; description?: string; terminal?: boolean }[]
  models: string[]
  currentModel?: string
  modes: string[]
  /** A session could be created, so the agent is usable as configured. */
  signedIn: boolean
  error?: string
}

export type ProviderKind = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'openai-compatible' | 'ollama' | 'lmstudio'

export const PROVIDER_KINDS: { id: ProviderKind; label: string; baseUrl?: string; needsKey: boolean; hint: string }[] = [
  { id: 'anthropic', label: 'Anthropic', needsKey: true, hint: 'API key from console.anthropic.com. Independent of the Claude Code login.' },
  { id: 'openai', label: 'OpenAI', needsKey: true, hint: 'API key from platform.openai.com.' },
  { id: 'google', label: 'Google Gemini', needsKey: true, hint: 'API key from aistudio.google.com.' },
  { id: 'deepseek', label: 'DeepSeek', needsKey: true, hint: 'API key from platform.deepseek.com.' },
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', needsKey: false, hint: 'Models you pulled with `ollama pull`, e.g. Qwen or Llama.' },
  { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', needsKey: false, hint: 'Models loaded in LM Studio with the local server on.' },
  { id: 'openai-compatible', label: 'OpenAI-compatible endpoint', needsKey: true, hint: 'OpenRouter, Groq, Mistral, Together, a vLLM box: any /v1 API.' }
]

export interface ProviderConfig {
  id: string
  kind: ProviderKind
  name: string
  baseUrl?: string
  /** An API key is stored (encrypted) for this provider. */
  hasKey: boolean
  /** Model ids last fetched from the provider, for the pickers. */
  models?: string[]
  modelsFetchedAt?: string
}

/** A model reference for the native engine: "<providerId>/<modelId>". */
export function parseModelRef(ref: string): { providerId: string; modelId: string } | null {
  const i = ref.indexOf('/')
  if (i <= 0) return null
  return { providerId: ref.slice(0, i), modelId: ref.slice(i + 1) }
}

/**
 * Every model a crew member can run on, in one vocabulary:
 * - "sonnet" or "claude-opus-5": a Claude model through Claude Code and your Claude login;
 * - "<providerId>/<modelId>": an API-key provider from Model providers, through the native loop;
 * - "codex/<model>", "gemini/<model>", "grok/<model>": a vendor agent with its own login.
 */
export type ModelKind = 'claude' | 'provider' | 'agent'
export type AgentEngine = Extract<Engine, 'codex' | 'gemini' | 'grok'>
export const AGENT_ENGINES: AgentEngine[] = ['codex', 'gemini', 'grok']
export function classifyModel(ref: string): { kind: ModelKind; modelId: string; providerId?: string; engine?: AgentEngine } {
  const p = parseModelRef(ref)
  if (!p) return { kind: 'claude', modelId: ref }
  if ((AGENT_ENGINES as string[]).includes(p.providerId)) return { kind: 'agent', modelId: p.modelId, engine: p.providerId as AgentEngine }
  return { kind: 'provider', modelId: p.modelId, providerId: p.providerId }
}

/** Claude models Claude Code accepts, with list prices per million tokens (input / output). */
export const CLAUDE_MODELS: { id: string; label: string; alias?: boolean; price?: [number, number] }[] = [
  { id: 'fable', label: 'Claude Fable, most capable', alias: true, price: [10, 50] },
  { id: 'opus', label: 'Claude Opus', alias: true, price: [5, 25] },
  { id: 'sonnet', label: 'Claude Sonnet', alias: true, price: [2, 10] },
  { id: 'haiku', label: 'Claude Haiku, fastest and cheapest', alias: true, price: [1, 5] },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', price: [10, 50] },
  { id: 'claude-opus-5', label: 'Claude Opus 5', price: [5, 25] },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', price: [5, 25] },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', price: [5, 25] },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', price: [5, 25] },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', price: [2, 10] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', price: [3, 15] },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', price: [1, 5] }
]

/** One model the user can pick, with where it comes from and whether it is usable right now. */
export interface ModelInventoryItem {
  ref: string
  kind: ModelKind
  /** "Claude (your Claude login)", the provider's name, or "Codex (ChatGPT login)". */
  source: string
  label: string
  /** "$2 / $10 per M tokens" when known; "subscription" for vendor agents. */
  price?: string
  available: boolean
  note?: string
}

export interface CrewSuggestion {
  orchestrator: { model: string; why: string }
  agents: { id: string; name: string; model: string; effort?: AgentSpec['effort']; why: string }[]
  notes?: string
}

/** A group of workspaces and repositories, e.g. "Personal", "Work", "Client". */
export interface Space {
  id: string
  name: string
  color: string
  createdAt: string
  /** Account used by default for workspaces created in this space. */
  claudeAccountId?: string
  /** The space's own Jira connection. Absent means "use the default one from Settings". */
  jira?: JiraSettings
  linear?: LinearSettings
  /** This space's own Slack sign-in; falls back to the application's. */
  slack?: SlackConnection
  /** This space's on-call agent: its channels, context and limits. */
  oncall?: OnCallSettings
  /** GitHub users/orgs whose PRs the review cockpit lists for this space. Empty means "detect from the space's repos". */
  githubOwners?: string[]
  mcpServers?: McpServerSpec[]
  /** Hand Claude the Atlassian MCP using this space's Jira login. Default on when Jira is connected. */
  exposeJiraMcp?: boolean
  /** Expose the Linear MCP server (with this space's login) to sessions. Default on. */
  exposeLinearMcp?: boolean
  /** Ignore MCP servers from Claude Code's own config (claude.ai connectors, plugins, ~/.claude.json). Absent = app default. */
  strictMcp?: boolean
  /** This space's crew. Absent = the app defaults in Settings. */
  agents?: AgentSpec[]
  /** Give the orchestrator its crew at all. Default on. */
  useCrew?: boolean
  /** Budget mode: Sonnet orchestrator, low effort, two subagents, a per-turn spend cap. Absent = app default. */
  budgetMode?: boolean
  /** Overrides the app default; undefined inherits. */
  leanMode?: boolean
  /** Which runtime drives chats in this space. Absent = app default. */
  engine?: Engine
  /** Per-space overrides; absent means the app default from Settings. */
  model?: string
  permissionMode?: PermissionMode
  workspacesRoot?: string
  /** Extra hostnames (optionally with a path prefix) where every browser action asks first. */
  browserSensitiveOrigins?: string[]
}

export const SPACE_COLORS = ['#7c9cff', '#60a5fa', '#22d3ee', '#2dd4bf', '#4ade80', '#a3e635', '#fbbf24', '#fb923c', '#f87171', '#f472b6', '#e879f9', '#a78bfa', '#c084fc', '#f5d0a9', '#94a3b8', '#e5e7eb']

export interface Repo {
  id: string
  name: string
  path: string
  spaceId?: string
  defaultBranch: string
  config: ConductorConfig | null
  addedAt: string
}

export interface WorkspaceRepo {
  repoId: string
  repoName: string
  worktreePath: string
  branch: string
  baseBranch: string
}

export type WorkspaceStatus = 'creating' | 'ready' | 'error' | 'archiving' | 'archived'

/** Where the work is, as the user sees it. Distinct from `status`, which is the app's own lifecycle. */
export type WorkspaceStage = 'todo' | 'in-progress' | 'in-review' | 'done'

export const WORKSPACE_STAGES: { id: WorkspaceStage; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'in-review', label: 'In review' },
  { id: 'done', label: 'Done' }
]

/** Pre-flight for archive/delete: what would be lost. */
export interface RepoSafety {
  repoId: string
  repoName: string
  uncommitted: number
  unpushed: number
  hasUpstream: boolean
  error?: string
}

export interface Workspace {
  id: string
  name: string
  slug: string
  rootPath: string
  repos: WorkspaceRepo[]
  primaryRepoId: string
  port: number
  status: WorkspaceStatus
  error?: string
  createdAt: string
  archivedAt?: string
  /** Claude Code session id, so the chat can be resumed across app restarts. */
  sessionId?: string
  lastMessageAt?: string
  /** Per-workspace override of the settings default; changed live from the chat. */
  permissionMode?: PermissionMode
  jira?: WorkspaceJira
  linear?: WorkspaceLinear
  linearStatus?: string
  linearStatusAt?: string
  /** Engine override for this workspace (set when the user continued elsewhere after a rate limit). */
  engine?: Engine
  stage: WorkspaceStage
  labelIds?: string[]
  spaceId?: string
  claudeAccountId?: string
  /** Last known status of the linked Jira ticket, refreshed when the workspace is opened. */
  jiraStatus?: string
  jiraStatusAt?: string
}

/** Same modes as the Claude Code CLI (Shift+Tab cycles them there and here). */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'

export const PERMISSION_MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'default', label: 'Ask', hint: 'Prompts before risky tools' },
  { id: 'acceptEdits', label: 'Accept edits', hint: 'Auto-approves file edits, asks for the rest' },
  { id: 'plan', label: 'Plan', hint: 'Read-only: explores and plans, no changes' },
  { id: 'auto', label: 'Auto', hint: 'A classifier approves or denies prompts' },
  { id: 'bypassPermissions', label: 'Bypass', hint: 'Never asks. Use with care' }
]

export interface JiraSettings {
  /** OAuth through Atlassian's MCP server: the preferred path. */
  connected: boolean
  connectedAt?: string
  siteName?: string
  /** Site URL: filled in by OAuth, or typed for the API-token fallback. */
  siteUrl: string
  email: string
  /** Set when an API token is stored (encrypted) in the store. */
  hasToken: boolean
  /** JQL used for the default list in the New workspace dialog. */
  defaultJql: string
}

/** Who issues the login: each vendor has its own coding agent CLI with its own credentials. */
export type Vendor = 'anthropic' | 'openai' | 'google' | 'xai'

export const VENDORS: { id: Vendor; label: string; agent: string; engine: Engine; hint: string; envVar: string }[] = [
  { id: 'anthropic', label: 'Anthropic', agent: 'Claude Code', engine: 'claude-code', hint: 'Claude Pro / Max login, or an API key, through the Claude Code CLI.', envVar: 'CLAUDE_CONFIG_DIR' },
  { id: 'openai', label: 'OpenAI', agent: 'Codex', engine: 'codex', hint: 'ChatGPT Plus / Pro / Team login, or an API key, through the Codex CLI.', envVar: 'CODEX_HOME' },
  { id: 'google', label: 'Google', agent: 'Gemini CLI', engine: 'gemini', hint: 'Google retired the personal Google login for the Gemini CLI; it signs in with the Gemini API key from Model providers.', envVar: 'HOME' },
  { id: 'xai', label: 'xAI', agent: 'Grok Build', engine: 'grok', hint: 'grok.com (SuperGrok) login through the Grok CLI.', envVar: 'HOME' }
]

/**
 * A login for one vendor's agent. Each account is a separate config folder for
 * that CLI, which is how they keep independent credentials. `configDir: null`
 * is the user's normal login (~/.claude, ~/.codex, …).
 */
export interface ClaudeAccount {
  id: string
  name: string
  /** Absent on records from before multi-vendor accounts: treated as anthropic. */
  vendor?: Vendor
  configDir: string | null
  loggedIn?: boolean
  detail?: string
  checkedAt?: string
}

/** How hard Sinfonie leans on the Mac. Missing fields fall back to DEFAULT_RESOURCES in main. */
export interface ResourceSettings {
  /** off: measure only. warn: notices only. enforce: refuse and stop subagents under pressure. */
  governor?: 'off' | 'warn' | 'enforce'
  /** Subagents one session may run at once; further delegations are refused with an explanation. */
  maxSubagentsPerSession?: number
  /** Sessions that may be generating at once app-wide; further messages wait for a slot. */
  maxActiveSessions?: number
  /** Share of RAM Sinfonie's whole process tree may use before pressure counts as warn (80%) and critical (100%). */
  memoryBudgetPct?: number
  /** Under critical pressure, stop the newest subagent each tick until it eases. */
  stopSubagentsOnCritical?: boolean
}
export type PressureLevel = 'normal' | 'warn' | 'critical'
export interface ResourceTask {
  taskId: string
  toolUseId?: string
  description: string
  startedAt: string
}
export interface ResourceSession {
  workspaceId: string
  /** Bytes of resident memory across the agent process and everything it spawned. */
  rss: number
  terminalsRss: number
  procs: number
  tasks: ResourceTask[]
  busy: boolean
}
export interface ResourceSnapshot {
  at: string
  level: PressureLevel
  /** What the macOS kernel reports, independent of Sinfonie's own budget. */
  osPressure: PressureLevel
  totalMem: number
  budget: number
  /** Everything under the Sinfonie process, renderer included. */
  appRss: number
  swapUsed: number
  sessions: ResourceSession[]
  terminalsRss: number
  otherRss: number
  /** Workspaces whose message is waiting for a free session slot. */
  waiting: string[]
}

export interface Settings {
  workspacesRoot: string
  basePort: number
  model: string
  permissionMode: PermissionMode
  jira: JiraSettings
  linear?: LinearSettings
  /** Accounts for every vendor (the name predates multi-vendor support). */
  claudeAccounts: ClaudeAccount[]
  /** Default Anthropic account. */
  defaultClaudeAccountId: string
  /** Default account per other vendor. */
  defaultAccounts?: Partial<Record<Vendor, string>>
  /** MCP servers available in every space. */
  mcpServers?: McpServerSpec[]
  /** Default for spaces: only use MCP servers configured in Sinfonie. */
  strictMcp?: boolean
  /** Default crew for spaces without their own. */
  agents: AgentSpec[]
  /** Default engine for spaces without their own. */
  engine?: Engine
  /** Model providers for the native engine. */
  providers?: ProviderConfig[]
  /** Default native-engine model, as "<providerId>/<modelId>". */
  nativeModel?: string
  /** Default model per vendor agent engine, from that agent's own list. */
  codexModel?: string
  geminiModel?: string
  grokModel?: string
  /** Send anonymised crash reports (error message, stack, version, OS) to sinfonie.dev. Default on. */
  crashReports?: boolean
  /** Send an anonymous daily usage ping (random install id, version, OS, engines, counts). Default on. */
  usageStats?: boolean
  /** Random id for the usage ping; never tied to an account. */
  installId?: string
  installFirstSeen?: string
  /** First-run setup, tour and getting-started checklist state. */
  onboarding?: { setupDoneAt?: string; tourDoneAt?: string; checklistDismissedAt?: string }
  resources?: ResourceSettings
  /** Expose browser_evaluate (arbitrary JavaScript in pages) to agents. Off by default. */
  browserEvaluate?: boolean
  slack?: SlackConnection
  oncall?: OnCallSettings
  usage?: UsageSettings
  /** Budget mode default for spaces that do not set their own. */
  budgetMode?: boolean
  /** Lean mode: one Sonnet agent, no crew, trimmed tools and context, a tool-call cap per turn. Beats budget mode. */
  leanMode?: boolean
  /** Per-turn spend cap in budget mode, USD at list price. */
  turnBudgetUsd?: number
}

/** What the crew optimizer favours when assigning models. */
export type CrewPriority = 'cost' | 'balanced' | 'quality'

/** A session note or todo on a workspace. The orchestrator can read and edit them too. */
export interface Note {
  id: string
  text: string
  kind: 'note' | 'todo'
  done: boolean
  /** Who wrote it. */
  source: 'user' | 'agent'
  createdAt: string
  updatedAt: string
}

/** A git repository found by scanning a folder, for the setup assistant. */
export interface ScannedRepo {
  path: string
  name: string
  /** Already in the app. */
  added: boolean
}

// ---- Review cockpit ----

export interface ReviewPr {
  nameWithOwner: string
  number: number
  title: string
  author: string
  url: string
  updatedAt: string
  isDraft: boolean
}

export type ReviewSeverity = 'critical' | 'major' | 'minor' | 'nit'

export interface ReviewFinding {
  id: string
  path: string
  /** Line on the new side of the diff, when the finding points at changed code. */
  line: number | null
  severity: ReviewSeverity
  title: string
  body: string
  suggestion?: string
  approved: boolean
  /** The lines the finding points at, from the PR head at review time. */
  snippet?: { start: number; lines: string[] }
  /** Set once a fix round changed code for it. */
  addressedRound?: number
}
/** One pass of the fixer over a set of findings, ending in a commit pushed to the PR branch. */
export interface FixRound {
  n: number
  status: 'fixing' | 'pushing' | 'done' | 'error'
  findingIds: string[]
  startedAt: string
  finishedAt?: string
  summary?: string
  commit?: string
  error?: string
  costUsd: number
}
export interface ReviewIteration {
  status: 'running' | 'done' | 'stopped' | 'error'
  maxRounds: number
  round: number
  phase?: string
  startedAt: string
  finishedAt?: string
  summary?: string
  error?: string
}

export interface ReviewVerdict {
  decision: 'approve' | 'request_changes' | 'comment'
  summary: string
}

export type ReviewRunStatus = 'preparing' | 'running' | 'fixing' | 'done' | 'error' | 'submitted' | 'cancelled'

export interface ReviewRun {
  key: string
  pr: ReviewPr
  accountId: string
  status: ReviewRunStatus
  phase?: string
  error?: string
  findings: ReviewFinding[]
  verdict?: ReviewVerdict
  baseRefName?: string
  headRefName?: string
  startedAt: string
  finishedAt?: string
  costUsd?: number
  submittedUrl?: string
  checkoutPath?: string
  /** owner/name of the head repository; pushes are only possible when it is the PR's own repository. */
  headRepo?: string
  isFork?: boolean
  fixes?: FixRound[]
  iteration?: ReviewIteration
  /** How many review passes ran for this PR (each fix round triggers one more). */
  passes?: number
}

export interface StoreData {
  spaces: Space[]
  labels: Label[]
  repos: Repo[]
  workspaces: Workspace[]
  settings: Settings
  /** Encrypted with Electron safeStorage, base64, keyed per connection. Never sent to the renderer. */
  secrets?: Record<string, string | undefined>
}

export interface JiraIssue {
  key: string
  summary: string
  status: string
  type: string
  priority?: string
  assignee?: string
  updated?: string
  url: string
  /** Plain-text rendering of the description; only present on jira:issue. */
  description?: string
}

/** Which Jira connection a space resolves to: its own when set up, else '' (the default in Settings). */
export function jiraConnectionFor(space: Space | undefined): string {
  const j = space?.jira
  if (!space || !j) return ''
  return j.connected || Boolean(j.siteUrl && j.email && j.hasToken) ? space.id : ''
}

export interface LinearSettings {
  /** OAuth through Linear's MCP server (dynamic client registration; nothing to create). */
  connected: boolean
  connectedAt?: string
  userName?: string
  orgName?: string
  /** Text search used when the picker's box is empty; empty means "my open issues". */
  defaultQuery: string
}
export interface LinearIssue {
  id: string
  identifier: string
  title: string
  state: string
  priority?: string
  assignee?: string
  updated?: string
  url: string
  description?: string
}
export interface WorkspaceLinear {
  id: string
  identifier: string
  title: string
  url: string
}
export function linearConnectionFor(space: Space | undefined): string {
  return space?.linear?.connected ? space.id : ''
}

export interface WorkspaceJira {
  key: string
  summary: string
  url: string
}

export interface CreateWorkspaceInput {
  name: string
  repos: { repoId: string; baseBranch: string }[]
  primaryRepoId?: string
  jira?: WorkspaceJira
  claudeAccountId?: string
  spaceId?: string
  linear?: WorkspaceLinear
}

// ---- GitHub ----

export interface PrCheck {
  name: string
  status: 'success' | 'failure' | 'pending' | 'skipped' | 'neutral'
  url?: string
}

export interface PrInfo {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  author: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | ''
  mergeable: string
  baseRefName: string
  headRefName: string
  additions: number
  deletions: number
  checks: PrCheck[]
}

export interface ReviewComment {
  id: string
  author: string
  body: string
  url: string
  createdAt: string
}

export interface ReviewThread {
  id: string
  path: string
  line: number | null
  isResolved: boolean
  isOutdated: boolean
  comments: ReviewComment[]
}

export interface RepoPr {
  repoId: string
  branch: string
  nameWithOwner?: string
  pr: PrInfo | null
  threads: ReviewThread[]
  error?: string
  fetchedAt: string
}

export interface FsEntry {
  name: string
  path: string
  dir: boolean
  size: number
}

export interface GitFileStatus {
  path: string
  /** M, A, D, R, ?, etc. */
  status: string
  staged: boolean
}

export interface RepoGitStatus {
  repoId: string
  branch: string
  ahead: number
  behind: number
  files: GitFileStatus[]
  hasUpstream: boolean
}

export interface ScriptOutputEvent {
  workspaceId: string
  repoId: string
  kind: 'setup' | 'run' | 'archive'
  data: string
  done?: boolean
  exitCode?: number | null
}

export interface TerminalDataEvent {
  terminalId: string
  data: string
}

// ---- Chat ----

export type ChatRole = 'user' | 'assistant' | 'system'

/** An image attached by the user, as sent from the renderer (base64). */
export interface ChatImageInput {
  name?: string
  mimeType: string
  data: string
}
/** A stored image: a file in the app data folder, shown through the sinfonie-image scheme. */
export interface ChatImageRef {
  id: string
  name: string
  mimeType: string
  path: string
  url: string
}
export interface ChatImageBlock {
  type: 'image'
  image: ChatImageRef
}
export interface ChatTextBlock {
  type: 'text'
  text: string
}
export interface ChatThinkingBlock {
  type: 'thinking'
  text: string
}
/** One thing a subagent did: a tool call with its headline, or a piece of text it wrote. */
export interface SubagentStep {
  kind: 'tool' | 'text'
  name?: string
  detail: string
}

export interface ChatToolBlock {
  type: 'tool'
  toolUseId: string
  name: string
  input: unknown
  result?: string
  isError?: boolean
  done: boolean
  /** For Agent delegations: what the subagent has done so far. */
  sub?: { model?: string; toolCalls: number; lastTool?: string; text?: string; steps?: SubagentStep[] }
}
export type ChatBlock = ChatTextBlock | ChatThinkingBlock | ChatToolBlock | ChatImageBlock

export interface ChatItem {
  id: string
  role: ChatRole
  blocks: ChatBlock[]
  createdAt: string
  /** For system items: how loud to render it. */
  level?: 'info' | 'warn' | 'error'
}

/** What fills the model's context window right now, from Claude Code's own accounting. */
export interface ContextUsage {
  model: string
  totalTokens: number
  maxTokens: number
  /** 0..100 */
  percentage: number
  overLimit?: { tokensOver: number; kind: 'hard_limit' | 'compaction_window' }
  categories: { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }[]
  mcpTools: { name: string; serverName: string; tokens: number }[]
  memoryFiles: { path: string; type: string; tokens: number }[]
  agents: { agentType: string; source: string; tokens: number }[]
  skills: { name: string; source: string; tokens: number }[]
  at: string
}

export interface ChatTurnResult {
  workspaceId: string
  costUsd: number
  durationMs: number
  numTurns: number
  isError: boolean
  errorText?: string
  /** Running cost of the session split by model, from the SDK's modelUsage. */
  byModel?: { model: string; costUsd: number; outputTokens: number }[]
}

/** Events the agent service emits to the renderer. Kept deliberately small. */
export type AgentEvent =
  | { type: 'init'; workspaceId: string; sessionId: string; model: string; cwd: string }
  | { type: 'user_message'; workspaceId: string; itemId: string; text: string; createdAt: string; images?: ChatImageRef[] }
  | { type: 'notice'; workspaceId: string; itemId: string; level: 'info' | 'warn' | 'error'; text: string; createdAt: string }
  | { type: 'queue'; workspaceId: string; items: { id: string; text: string }[] }
  | { type: 'subagent'; workspaceId: string; parentToolUseId: string; model?: string; tools: string[]; text?: string; steps: SubagentStep[] }
  | { type: 'assistant_start'; workspaceId: string; itemId: string }
  | { type: 'text_delta'; workspaceId: string; itemId: string; text: string }
  | { type: 'thinking_delta'; workspaceId: string; itemId: string; text: string }
  | { type: 'tool_start'; workspaceId: string; itemId: string; toolUseId: string; name: string }
  | { type: 'tool_input'; workspaceId: string; itemId: string; toolUseId: string; input: unknown }
  | { type: 'tool_result'; workspaceId: string; toolUseId: string; result: string; isError: boolean }
  | { type: 'assistant_end'; workspaceId: string; itemId: string }
  | { type: 'result'; result: ChatTurnResult }
  | { type: 'status'; workspaceId: string; busy: boolean }
  /** Current context size of the session, from the last model call. cacheRead: how much of it came from the prompt cache. */
  | { type: 'context'; workspaceId: string; tokens: number; window?: number; cacheRead?: number; compacted?: { pre: number; post?: number; trigger: 'manual' | 'auto' } }
  /** A usage limit is near (preflight, message parked) or was hit mid-task; the chat shows a card with the alternatives. */
  | { type: 'limit'; workspaceId: string; itemId: string; mode: 'preflight' | 'hit'; accountId: string; accountName: string; limitType?: LimitType; utilization?: number; resetsAt?: string; text: string; alternatives: LimitAlternative[]; createdAt: string }
  | { type: 'limit_resolved'; workspaceId: string; itemId: string }
  | { type: 'error'; workspaceId: string; message: string }

export interface PermissionRequest {
  requestId: string
  workspaceId: string
  toolName: string
  input: Record<string, unknown>
  blockedPath?: string
  canAlwaysAllow: boolean
}

/** Claude's AskUserQuestion, surfaced as a card in the chat. */
export interface QuestionOption {
  label: string
  description: string
  preview?: string
}
export interface Question {
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}
export interface QuestionRequest {
  requestId: string
  workspaceId: string
  questions: Question[]
}
export interface QuestionResponse {
  requestId: string
  /** question text -> chosen label(s) joined with ", " or free text */
  answers: Record<string, string>
  /** A general reply instead of answering, when the user dismisses the card with text. */
  response?: string
  cancelled?: boolean
}

/** A Claude Code session on disk, as shown in the Resume picker. */
export interface SessionSummary {
  sessionId: string
  title: string
  firstPrompt?: string
  cwd?: string
  gitBranch?: string
  lastModified: number
  fileSize?: number
  /** True when the session was recorded inside one of the workspace's worktrees. */
  inWorkspace: boolean
}

/** One line of errors.log, parsed for the in-app Errors view. */
export interface ErrorEntry {
  id: string
  ts: string
  where: string
  message: string
  stack?: string
  extra?: string
}

/** A sign-in URL the renderer shows with Open / Copy, instead of the app opening a browser on its own. */
export interface AuthLink {
  provider: 'jira' | 'linear' | 'slack'
  /** '' for the application connection, else the space id. */
  connId: string
  url: string
}

// ---- On call ----

export interface SlackConnection {
  connected: boolean
  connectedAt?: string
  teamName?: string
  userName?: string
  userId?: string
  /** The user stored their own Slack OAuth client id/secret (Advanced). */
  hasClient: boolean
  clientId?: string
  /** This build carries Sinfonie's registered Slack client, so plain Sign in works. */
  vendorClient: boolean
}
export interface OnCallChannel {
  id: string
  name: string
  /** support: human requests, each top-level message is a ticket. alerts: monitoring posts; "resolved" messages close incidents. */
  kind: 'support' | 'alerts'
}
export interface OnCallSettings {
  enabled: boolean
  /** Legacy (app-level config only): space whose repositories the triage agent may read. */
  spaceId?: string
  channels: OnCallChannel[]
  pollSeconds: number
  model?: string
  claudeAccountId?: string
  maxTriagesPerHour: number
  /** Free text: services, owners, runbook pointers, what normal looks like. */
  context: string
}
export type IncidentStatus = 'new' | 'triaging' | 'open' | 'waiting' | 'resolved' | 'dismissed'
export type Severity = 'low' | 'medium' | 'high' | 'critical'
export interface IncidentMessage {
  ts: string
  user: string
  userName?: string
  text: string
}
export interface TriageReport {
  summary: string
  severity: Severity
  category: 'customer' | 'bug' | 'infra' | 'question' | 'noise'
  likelyCause: string
  evidence: string[]
  nextSteps: string[]
  customerReply?: string
  needsHuman: boolean
  confidence: 'low' | 'medium' | 'high'
}
export interface Proposal {
  id: string
  kind: 'slack_reply'
  channelId: string
  threadTs: string
  text: string
  status: 'proposed' | 'sent' | 'dismissed'
  createdAt: string
  sentAt?: string
}
export interface Incident {
  id: string
  /** Space whose on-call config produced it; '' for the application-level config. */
  spaceId: string
  source: 'slack'
  channelId: string
  channelName: string
  kind: 'support' | 'alerts'
  threadTs: string
  permalink?: string
  title: string
  messages: IncidentMessage[]
  status: IncidentStatus
  severity?: Severity
  report?: TriageReport
  proposals: Proposal[]
  notes: { at: string; role: 'user' | 'agent' | 'system'; text: string }[]
  costUsd: number
  createdAt: string
  updatedAt: string
  triagedAt?: string
  error?: string
}
export interface OnCallState {
  running: boolean
  /** Space ids with an active watcher ('' for the application-level config). */
  activeSpaces: string[]
  lastPollAt?: string
  nextPollAt?: string
  lastError?: string
  incidents: Incident[]
  triagesThisHour: number
  triaging: string | null
}

export interface BrowserDownload {
  name: string
  path: string
  size: number
  at: string
  state: 'progressing' | 'completed' | 'failed'
}
export interface BrowserTabInfo {
  id: string
  url: string
  title: string
  loading: boolean
}
/** The workspace browser as the renderer sees it. */
export interface BrowserState {
  workspaceId: string
  tabs: BrowserTabInfo[]
  activeId: string | null
  /** An agent tool is acting on the browser right now (or did in the last moment). */
  agentBusy: boolean
  /** The user paused agent control; tool calls wait until resumed. */
  paused: boolean
  downloads: BrowserDownload[]
}

// ---- Usage ----

export type LimitType = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage'
export interface UsageLimit {
  type: LimitType
  /** 0..1 */
  utilization: number
  status: 'allowed' | 'allowed_warning' | 'rejected'
  resetsAt?: string
  /** When this reading was taken. */
  at: string
  /** Linear projection of when the window fills at the recent pace, if it will before the reset. */
  projectedExhaustAt?: string
}
export interface UsageAccount {
  accountId: string
  name: string
  limits: UsageLimit[]
}
export interface UsageTurn {
  at: string
  workspaceId: string
  spaceId: string
  accountId: string
  engine: string
  kind: 'chat' | 'review' | 'oncall' | 'crew' | 'suggest'
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  durationMs: number
  byModel: { model: string; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }[]
}
export interface UsageDay {
  day: string
  costUsd: number
  inputTokens: number
  outputTokens: number
  turns: number
  byModel: Record<string, number>
  bySpace: Record<string, number>
  byWorkspace: Record<string, number>
  byKind: Record<string, number>
}
export interface UsageSnapshot {
  accounts: UsageAccount[]
  days: UsageDay[]
  today: UsageDay
  topWorkspaces: { workspaceId: string; costUsd: number; turns: number }[]
  /** Current context size per workspace session, in tokens. */
  contextTokens: Record<string, number>
  warnAtPct: number
  contextWarnTokens: number
}
export interface UsageSettings {
  /** Warn before a task when the fullest window is at or above this percentage. */
  warnAtPct?: number
  /** Nudge to start a new session when the context passes this many tokens. */
  contextWarnTokens?: number
}
/** What the user can do when a limit is near or hit. */
export interface LimitAlternative {
  kind: 'proceed' | 'account' | 'engine' | 'native' | 'lean' | 'cancel'
  id?: string
  label: string
  hint?: string
}

export interface UpdateInfo {
  /** available: offer the download. downloading: show progress. ready: offer the restart. error: the download failed. */
  state: 'available' | 'downloading' | 'ready' | 'error'
  percent?: number
  error?: string
  version: string
  current: string
  /** Direct DMG download when available, else the release page. */
  url: string
  releaseUrl: string
  notes: string
}

export interface PermissionResponse {
  requestId: string
  decision: 'allow' | 'always' | 'deny'
  message?: string
}
