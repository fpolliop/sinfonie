import type { BrowserState, ChatImageInput, Incident, IncidentStatus, OnCallState, ResourceSnapshot, Severity, SlackConnection, LoginProgress, ScannedRepo, Note, ModelInventoryItem, CrewSuggestion,
  AgentEvent,
  ChatItem,
  JiraIssue,
  JiraSettings,
  Label,
  McpServerSpec,
  RepoPr,
  PermissionMode,
  AcpProbe,
  Engine,
  Vendor,
  ProviderConfig,
  ProviderKind,
  RepoSafety,
  ReviewFinding,
  ReviewPr,
  ReviewRun,
  ReviewVerdict,
  ErrorEntry,
  SessionSummary,
  UpdateInfo,
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
export interface SinfonieInvoke {
  'store:get': () => StoreData
  'settings:update': (patch: Partial<Settings>) => Settings

  'spaces:create': (name: string) => Space
  'spaces:update': (id: string, patch: Partial<Pick<Space, 'name' | 'color' | 'claudeAccountId' | 'model' | 'permissionMode' | 'workspacesRoot' | 'browserSensitiveOrigins' | 'githubOwners' | 'mcpServers' | 'exposeJiraMcp' | 'strictMcp' | 'agents' | 'useCrew' | 'engine'>>) => Space
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
  /** Git repositories directly under a folder (and one level below), for the setup assistant. */
  'repos:scan': (root: string) => ScannedRepo[]
  'repos:addPaths': (paths: string[], spaceId?: string) => Repo[]
  'dialog:pickFolder': (title: string, defaultPath?: string) => string | null
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
  'updates:check': () => UpdateInfo | null
  'updates:download': () => void
  'updates:install': () => void
  'feedback:send': (payload: { kind: 'feedback' | 'feature' | 'bug'; message: string; email?: string; includeLogs?: boolean }) => { ok: boolean; error?: string }
  'logs:open': () => void
  'logs:list': () => ErrorEntry[]
  'logs:clear': () => void
  'app:version': () => string

  'accounts:add': (name: string, vendor?: Vendor) => Settings
  'accounts:remove': (id: string) => Settings
  'accounts:setDefault': (id: string) => Settings
  'accounts:check': (id: string) => Settings
  'accounts:login': (id: string) => string

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

  'agent:send': (workspaceId: string, text: string, images?: ChatImageInput[]) => void
  'agent:interrupt': (workspaceId: string) => void
  'agent:permission': (response: PermissionResponse) => void
  'agent:answerQuestion': (response: QuestionResponse) => void
  'agent:unqueue': (workspaceId: string, id: string) => void
  /** Claude Code sessions to resume into a workspace: its own worktrees first, or every project. */
  'sessions:list': (workspaceId: string, scope: 'workspace' | 'all', query: string) => SessionSummary[]
  'sessions:resume': (workspaceId: string, sessionId: string) => { messages: number }
  /** New workspace on branches cut from this one, with a forked copy of its conversation. */
  'workspaces:fork': (workspaceId: string, name: string) => Workspace

  /** Launch the agent, read its auth methods, models and modes; tells whether it is usable now. */
  'acp:probe': (engine: Engine, accountId?: string) => AcpProbe
  /** Probe results already collected this app run, without launching anything. */
  'acp:probes': () => Partial<Record<Engine, AcpProbe>>
  /** Every model the crew can use, from every source. */
  'crew:inventory': () => ModelInventoryItem[]
  /** Ask Claude to assign a model to the orchestrator and each crew member, given the inventory. */
  'crew:suggest': (spaceId?: string) => CrewSuggestion
  /** Run the agent's own authentication method (browser or terminal flow). Returns the terminal command when one must be run instead. */
  'acp:authenticate': (engine: Engine, methodId: string) => { ok: boolean; terminalCommand?: string; error?: string }
  /** A shell already running `command`, for interactive logins. */

  'providers:add': (cfg: { kind: ProviderKind; name: string; baseUrl?: string; apiKey?: string }) => ProviderConfig
  'providers:update': (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string }) => ProviderConfig
  'providers:remove': (id: string) => void
  /** Fetches the provider's model list and caches it on the config. */
  'providers:models': (id: string) => string[]
  'agent:reset': (workspaceId: string) => void
  'agent:setMode': (workspaceId: string, mode: PermissionMode) => Workspace
  'chat:load': (workspaceId: string) => { items: ChatItem[]; busy: boolean }
  // ---- session notes ----
  'notes:list': (workspaceId: string) => Note[]
  'notes:add': (workspaceId: string, text: string, kind: Note['kind']) => Note[]
  'notes:update': (workspaceId: string, id: string, patch: Partial<Pick<Note, 'text' | 'done' | 'kind'>>) => Note[]
  'notes:remove': (workspaceId: string, id: string) => Note[]

  'terminal:create': (workspaceId: string, repoId: string) => string
  'terminal:write': (terminalId: string, data: string) => void
  'terminal:resize': (terminalId: string, cols: number, rows: number) => void
  'terminal:dispose': (terminalId: string) => void
  // ---- on call ----
  'oncall:state': () => OnCallState
  'oncall:slackSetClient': (clientId: string, clientSecret: string) => SlackConnection
  /** Opens the browser for Slack approval; the code returns via sinfonie://oauth/slack or oncall:slackFinish. */
  'oncall:slackConnect': () => void
  'oncall:slackFinish': (code: string) => SlackConnection
  'oncall:slackDisconnect': () => SlackConnection
  'oncall:slackChannels': (query?: string) => { id: string; name: string; is_private: boolean; is_member: boolean }[]
  'oncall:pollNow': () => void
  'oncall:triage': (incidentId: string) => void
  'oncall:setStatus': (incidentId: string, status: IncidentStatus) => Incident
  'oncall:setSeverity': (incidentId: string, severity: Severity) => Incident
  'oncall:approve': (incidentId: string, proposalId: string, text?: string) => Incident
  'oncall:dismissProposal': (incidentId: string, proposalId: string) => Incident
  'oncall:addProposal': (incidentId: string, text: string) => Incident
  'oncall:ask': (incidentId: string, question: string) => Incident
  'oncall:remove': (incidentId: string) => void
  // ---- workspace browser ----
  'browser:state': (workspaceId: string) => BrowserState
  /** Where the Browser pane sits in the window (CSS px), or null while hidden. */
  'browser:setBounds': (workspaceId: string, bounds: { x: number; y: number; width: number; height: number } | null) => void
  'browser:open': (workspaceId: string, url: string) => BrowserState
  'browser:navigate': (workspaceId: string, url: string) => void
  'browser:tabAction': (workspaceId: string, action: 'new' | 'select' | 'close' | 'back' | 'forward' | 'reload', tabId?: string) => BrowserState
  'browser:setPaused': (workspaceId: string, paused: boolean) => void
  /** A modal is open (true) or closed (false): pages are hidden while any modal is up. */
  'browser:suspend': (on: boolean) => void
  // ---- resources ----
  'resources:get': () => ResourceSnapshot
  'resources:stopTask': (workspaceId: string, taskId: string) => void
  'resources:cancelWaiting': (workspaceId: string) => void
}

/** Push channels (main -> renderer). */
export interface SinfonieEvents {
  'store:changed': StoreData
  'agent:event': AgentEvent
  'agent:permission': PermissionRequest
  'agent:question': QuestionRequest
  'script:output': ScriptOutputEvent
  'terminal:data': TerminalDataEvent
  'terminal:exit': { terminalId: string; exitCode: number }
  'accounts:loginProgress': LoginProgress
  'review:changed': ReviewRun
  'update:available': UpdateInfo
  /** Main asks the renderer to open the Feedback dialog (Help menu, shortcut). */
  'ui:openFeedback': { tab: 'feedback' | 'errors' }
  'ui:openOnboarding': { kind: 'setup' | 'tour' }
  'notes:changed': { workspaceId: string; notes: Note[] }
  /** A new error was logged; the sidebar badge updates. */
  'errors:new': ErrorEntry
  /** Memory and process sample, every few seconds. */
  'resources:snapshot': ResourceSnapshot
  'browser:state': BrowserState
  'oncall:changed': OnCallState
  /** Open the On call view on this incident (notification click, deep link). */
  'ui:openOnCall': { incidentId?: string }
  /** An agent started using the browser of this workspace; the renderer brings the pane forward. */
  'browser:agentActive': { workspaceId: string }
}

export type InvokeChannel = keyof SinfonieInvoke
export type EventChannel = keyof SinfonieEvents
