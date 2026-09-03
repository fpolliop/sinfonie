import type {
  AgentEvent,
  ChatItem,
  JiraIssue,
  JiraSettings,
  Label,
  McpServerSpec,
  RepoPr,
  PermissionMode,
  RepoSafety,
  ReviewFinding,
  ReviewPr,
  ReviewRun,
  ReviewVerdict,
  SessionSummary,
  WorkspaceStage,
  CreateWorkspaceInput,
  PermissionRequest,
  PermissionResponse,
  QuestionRequest,
  QuestionResponse,
  Repo,
  RepoGitStatus,
  ScriptOutputEvent,
  Settings,
  Space,
  StoreData,
  TerminalDataEvent,
  Workspace
} from './types'

/** Request/response channels (ipcRenderer.invoke). */
export interface OrchestraInvoke {
  'store:get': () => StoreData
  'settings:update': (patch: Partial<Settings>) => Settings

  'spaces:create': (name: string) => Space
  'spaces:update': (id: string, patch: Partial<Pick<Space, 'name' | 'color' | 'claudeAccountId' | 'model' | 'permissionMode' | 'workspacesRoot' | 'githubOwners' | 'mcpServers' | 'exposeJiraMcp'>>) => Space
  /** MCP servers found in Claude Code's own config (~/.claude.json), for importing. */
  'mcp:importable': () => McpServerSpec[]
  'spaces:delete': (id: string) => void
  'workspaces:setSpace': (workspaceId: string, spaceId: string | null) => Workspace
  'labels:create': (name: string, color: string, spaceId: string | null) => Label
  'labels:update': (id: string, patch: Partial<Pick<Label, 'name' | 'color'>>) => Label
  'labels:delete': (id: string) => void
  'workspaces:setLabels': (workspaceId: string, labelIds: string[]) => Workspace
  'repos:setSpace': (repoId: string, spaceId: string | null) => Repo

  'repos:pickAndAdd': (spaceId?: string) => Repo | null
  'repos:remove': (repoId: string) => void
  'repos:branches': (repoId: string) => string[]
  'repos:reloadConfig': (repoId: string) => Repo

  'workspaces:create': (input: CreateWorkspaceInput) => Workspace
  'workspaces:archive': (workspaceId: string, opts: { deleteBranches: boolean; forget?: boolean }) => Workspace | null
  'workspaces:safety': (workspaceId: string) => RepoSafety[]
  'workspaces:setStage': (workspaceId: string, stage: WorkspaceStage) => Workspace
  'workspaces:refreshJira': (workspaceId: string) => Workspace
  'workspaces:delete': (workspaceId: string) => void
  'workspaces:rename': (workspaceId: string, name: string, opts: { renameBranches: boolean }) => Workspace
  'workspaces:openIn': (workspaceId: string, app: 'finder' | 'vscode' | 'cursor' | 'terminal') => void
  'workspaces:runScript': (workspaceId: string, kind: 'setup' | 'run') => void
  'workspaces:stopScript': (workspaceId: string, kind: 'setup' | 'run') => void
  'workspaces:renameBranch': (workspaceId: string, branch: string) => Workspace
  'workspaces:addRepo': (workspaceId: string, repoId: string, baseBranch: string) => Workspace
  'workspaces:removeRepo': (workspaceId: string, repoId: string, opts: { deleteBranch: boolean }) => Workspace

  'git:status': (workspaceId: string) => RepoGitStatus[]
  'git:diff': (workspaceId: string, repoId: string, path?: string) => string
  'git:commit': (workspaceId: string, repoId: string, message: string) => string
  'git:push': (workspaceId: string, repoId: string) => string
  'git:createPr': (workspaceId: string, repoId: string, title: string, body: string) => string

  'github:status': (workspaceId: string) => RepoPr[]

  /** connId is a space id, or '' for the default connection in Settings. */
  'jira:authenticate': (connId: string) => void
  'jira:disconnect': (connId: string) => void
  'jira:saveToken': (connId: string, token: string) => void
  'jira:updateSettings': (connId: string, patch: Partial<JiraSettings>) => void
  'jira:search': (connId: string, query: string) => JiraIssue[]
  'jira:issue': (connId: string, key: string) => JiraIssue

  'shell:openExternal': (url: string) => void

  'accounts:add': (name: string) => Settings
  'accounts:remove': (id: string) => Settings
  'accounts:setDefault': (id: string) => Settings
  'accounts:check': (id: string) => Settings
  'accounts:loginTerminal': (id: string) => string

  'reviews:orgs': () => string[]
  'reviews:list': (owners: string[], mode: 'requested' | 'all') => ReviewPr[]
  /** Owners detected from the origin remotes of a space's repos ('' = repos in no space). */
  'reviews:detectOwners': (spaceId: string) => string[]
  'reviews:runs': () => ReviewRun[]
  'reviews:start': (pr: ReviewPr, accountId: string) => ReviewRun
  'reviews:cancel': (key: string) => void
  'reviews:discard': (key: string) => void
  'reviews:updateFinding': (key: string, findingId: string, patch: Partial<ReviewFinding>) => ReviewRun
  'reviews:setAll': (key: string, approved: boolean) => ReviewRun
  'reviews:setVerdict': (key: string, verdict: ReviewVerdict) => ReviewRun
  'reviews:submit': (key: string) => ReviewRun

  'agent:send': (workspaceId: string, text: string) => void
  'agent:interrupt': (workspaceId: string) => void
  'agent:permission': (response: PermissionResponse) => void
  'agent:answerQuestion': (response: QuestionResponse) => void
  'agent:unqueue': (workspaceId: string, id: string) => void
  /** Claude Code sessions to resume into a workspace: its own worktrees first, or every project. */
  'sessions:list': (workspaceId: string, scope: 'workspace' | 'all', query: string) => SessionSummary[]
  'sessions:resume': (workspaceId: string, sessionId: string) => { messages: number }
  'agent:reset': (workspaceId: string) => void
  'agent:setMode': (workspaceId: string, mode: PermissionMode) => Workspace
  'chat:load': (workspaceId: string) => { items: ChatItem[]; busy: boolean }

  'terminal:create': (workspaceId: string, repoId: string) => string
  'terminal:write': (terminalId: string, data: string) => void
  'terminal:resize': (terminalId: string, cols: number, rows: number) => void
  'terminal:dispose': (terminalId: string) => void
}

/** Push channels (main -> renderer). */
export interface OrchestraEvents {
  'store:changed': StoreData
  'agent:event': AgentEvent
  'agent:permission': PermissionRequest
  'agent:question': QuestionRequest
  'script:output': ScriptOutputEvent
  'terminal:data': TerminalDataEvent
  'terminal:exit': { terminalId: string; exitCode: number }
  'review:changed': ReviewRun
}

export type InvokeChannel = keyof OrchestraInvoke
export type EventChannel = keyof OrchestraEvents
