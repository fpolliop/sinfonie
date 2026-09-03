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

export interface Repo {
  id: string
  name: string
  path: string
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

export interface Settings {
  workspacesRoot: string
  basePort: number
  model: string
  permissionMode: PermissionMode
}

export interface StoreData {
  repos: Repo[]
  workspaces: Workspace[]
  settings: Settings
}

export interface CreateWorkspaceInput {
  name: string
  repos: { repoId: string; baseBranch: string }[]
  primaryRepoId?: string
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
