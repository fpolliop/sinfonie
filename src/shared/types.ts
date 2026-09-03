// Shared types between main, preload and renderer.

export interface ConductorScripts {
  setup?: string
  run?: string
  archive?: string
}

/** Mirrors conductor.json so existing repos work unchanged. */
export interface ConductorConfig {
  scripts?: ConductorScripts
  runScriptMode?: 'concurrent' | 'sequential'
}

/** A group of workspaces and repositories, e.g. "Personal", "Lumepic", "Howdy". */
export interface Space {
  id: string
  name: string
  color: string
  createdAt: string
  /** Account used by default for workspaces created in this space. */
  claudeAccountId?: string
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
  repos: Repo[]
  workspaces: Workspace[]
  settings: Settings
  /** Encrypted with Electron safeStorage, base64. Never sent to the renderer. */
  secrets?: { jiraToken?: string; jiraOAuthClient?: string; jiraOAuthTokens?: string; jiraOAuthVerifier?: string }
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

export type ChatRole = 'user' | 'assistant'

export interface ChatTextBlock {
  type: 'text'
  text: string
}
export interface ChatThinkingBlock {
  type: 'thinking'
  text: string
}
export interface ChatToolBlock {
  type: 'tool'
  toolUseId: string
  name: string
  input: unknown
  result?: string
  isError?: boolean
  done: boolean
}
export type ChatBlock = ChatTextBlock | ChatThinkingBlock | ChatToolBlock

export interface ChatItem {
  id: string
  role: ChatRole
  blocks: ChatBlock[]
  createdAt: string
}

export interface ChatTurnResult {
  workspaceId: string
  costUsd: number
  durationMs: number
  numTurns: number
  isError: boolean
  errorText?: string
}

/** Events the agent service emits to the renderer. Kept deliberately small. */
export type AgentEvent =
  | { type: 'init'; workspaceId: string; sessionId: string; model: string; cwd: string }
  | { type: 'user_message'; workspaceId: string; itemId: string; text: string; createdAt: string }
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

export interface PermissionResponse {
  requestId: string
  decision: 'allow' | 'always' | 'deny'
  message?: string
}
