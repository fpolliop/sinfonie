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
  /** GitHub users/orgs whose PRs the review cockpit lists for this space. Empty means "detect from the space's repos". */
  githubOwners?: string[]
  mcpServers?: McpServerSpec[]
  /** Hand Claude the Atlassian MCP using this space's Jira login. Default on when Jira is connected. */
  exposeJiraMcp?: boolean
  /** Ignore MCP servers from Claude Code's own config (claude.ai connectors, plugins, ~/.claude.json). Absent = app default. */
  strictMcp?: boolean
  /** This space's crew. Absent = the app defaults in Settings. */
  agents?: AgentSpec[]
  /** Give the orchestrator its crew at all. Default on. */
  useCrew?: boolean
  /** Which runtime drives chats in this space. Absent = app default. */
  engine?: Engine
  /** Per-space overrides; absent means the app default from Settings. */
  model?: string
  permissionMode?: PermissionMode
  workspacesRoot?: string
}

export const SPACE_COLORS = ['#7c9cff', '#4ade80', '#fbbf24', '#f472b6', '#22d3ee', '#a78bfa', '#fb923c', '#94a3b8']

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

/**
 * A Claude Code login. Each account is a separate CLAUDE_CONFIG_DIR, which is
 * how the CLI keeps independent credentials. `configDir: null` is the default
 * ~/.claude login.
 */
export interface ClaudeAccount {
  id: string
  name: string
  configDir: string | null
  loggedIn?: boolean
  detail?: string
  checkedAt?: string
}

export interface Settings {
  workspacesRoot: string
  basePort: number
  model: string
  permissionMode: PermissionMode
  jira: JiraSettings
  claudeAccounts: ClaudeAccount[]
  defaultClaudeAccountId: string
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
}

export interface ReviewVerdict {
  decision: 'approve' | 'request_changes' | 'comment'
  summary: string
}

export type ReviewRunStatus = 'preparing' | 'running' | 'done' | 'error' | 'submitted' | 'cancelled'

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
export type ChatBlock = ChatTextBlock | ChatThinkingBlock | ChatToolBlock

export interface ChatItem {
  id: string
  role: ChatRole
  blocks: ChatBlock[]
  createdAt: string
  /** For system items: how loud to render it. */
  level?: 'info' | 'warn' | 'error'
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
  | { type: 'user_message'; workspaceId: string; itemId: string; text: string; createdAt: string }
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

export interface UpdateInfo {
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
