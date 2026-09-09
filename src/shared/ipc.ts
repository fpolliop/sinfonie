import type { AgentMode, AppMode, AuthLink, CompletionRequest, DiscoveredOrg, SharedRepo, TeammateWorkspace, BillingPeriod, CliStatus, CloudOrgDetail, CloudState, Plan, RemoteSettings, RemoteStatus, SpaceDefinition, SpaceImportPreview, SpaceImportResolution, BrowserState, ContextUsage, CrewPriority, FsEntry, LimitAlternative, UsageSnapshot, ChatImageInput, Incident, IncidentStatus, LinearIssue, LinearSettings, OnCallState, ResourceSnapshot, Severity, SlackConnection, LoginProgress, ScannedRepo, Note, ModelInventoryItem, CrewSuggestion, OnCallBulkOp,
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
  Workspace, CostMode, CostModeScope, GcpStatus, AssistantItem, DbConnection, DbSecrets, DbSchema, DbQueryResult, DbHistoryEntry } from './types'

/** Request/response channels (ipcRenderer.invoke). */
export interface SinfonieInvoke {
  'store:get': () => StoreData
  'settings:update': (patch: Partial<Settings>) => Settings

  'spaces:create': (name: string) => Space
  'spaces:update': (id: string, patch: Partial<Pick<Space, 'name' | 'color' | 'claudeAccountId' | 'model' | 'permissionMode' | 'workspacesRoot' | 'browserSensitiveOrigins' | 'githubOwners' | 'exposeLinearMcp' | 'oncall' | 'budgetMode' | 'leanMode' | 'gcp' | 'exposeGcpMcp' | 'mcpServers' | 'exposeJiraMcp' | 'strictMcp' | 'agents' | 'useCrew' | 'engine' | 'agentMode' | 'guided'>>) => Space
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
  /** The friendly name and one-line description a guided user sees for this app. */
  'repos:setMeta': (repoId: string, meta: { displayName?: string; description?: string }) => Repo
  /** Edit the repo's sinfonie.json: run/setup/check scripts and the preview URL. Empty string clears a field. */
  'repos:writeConfig': (repoId: string, patch: { scripts?: { setup?: string; run?: string; check?: string }; preview?: string }) => Repo

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
  // ---- files (confined to the workspace) ----
  'fs:list': (workspaceId: string, dir: string, showHidden?: boolean) => FsEntry[]
  'fs:read': (workspaceId: string, path: string) => { text: string; truncated: boolean; binary: boolean; size: number; hash: string }
  /** Saves an edit; refused when the file changed on disk since `expectedHash` was read. */
  'fs:write': (workspaceId: string, path: string, text: string, expectedHash?: string) => { hash: string }
  /** The committed version of a file (HEAD), or null when it is untracked. */
  'git:show': (workspaceId: string, repoId: string, path: string) => string | null
  'completions:suggest': (req: CompletionRequest) => string
  'completions:cancel': (workspaceId: string) => void
  'fs:reveal': (workspaceId: string, path: string) => void
  'fs:open': (workspaceId: string, path: string) => void
  'git:diff': (workspaceId: string, repoId: string, path?: string) => string
  'git:commit': (workspaceId: string, repoId: string, message: string) => string
  'git:push': (workspaceId: string, repoId: string) => string
  'git:createPr': (workspaceId: string, repoId: string, title: string, body: string, reviewers?: string[]) => string
  /** Runs each repo's check script (build/tests/lint) once and reports pass or fail per app. Guided Send for review. */
  'workspaces:check': (workspaceId: string) => { repoId: string; name: string; ran: boolean; ok: boolean; output: string }[]
  /** Guided New task: from a description and the space's apps, pick the apps to touch and a friendly task name. */
  'guided:plan': (spaceId: string, description: string) => { repoIds: string[]; name: string }
  /** Guided mode: post the person's question to the team's Slack channel. Returns a link, or throws with why. */
  'guided:askTeammate': (workspaceId: string, message: string) => { ok: true; url?: string }

  'github:status': (workspaceId: string) => RepoPr[]

  /** connId is a space id, or '' for the default connection in Settings. */
  'jira:authenticate': (connId: string) => void
  'jira:disconnect': (connId: string) => void
  'jira:saveToken': (connId: string, token: string) => void
  'jira:updateSettings': (connId: string, patch: Partial<JiraSettings>) => void
  'jira:search': (connId: string, query: string) => JiraIssue[]
  'jira:issue': (connId: string, key: string) => JiraIssue
  // ---- linear ----
  'linear:authenticate': (connId: string) => void
  'linear:disconnect': (connId: string) => void
  'linear:updateSettings': (connId: string, patch: Partial<LinearSettings>) => void
  'linear:search': (connId: string, query: string) => LinearIssue[]
  'linear:issue': (connId: string, identifier: string) => LinearIssue
  'workspaces:refreshLinear': (workspaceId: string) => Workspace
  // ---- Sinfonie account and plan ----
  'cloud:signIn': (provider?: 'github' | 'google') => void
  'cloud:signOut': () => CloudState
  'cloud:refresh': () => CloudState
  'cloud:checkout': (plan: Exclude<Plan, 'free'>, period: BillingPeriod, seats?: number) => void
  'cloud:portal': () => void
  'cloud:orgs': () => CloudOrgDetail[]
  'cloud:invite': (orgId: string, role: 'admin' | 'member', email?: string) => CloudOrgDetail
  'cloud:revokeInvite': (orgId: string, token: string) => CloudOrgDetail
  'cloud:setMemberRole': (orgId: string, userId: string, role: 'admin' | 'member') => CloudOrgDetail
  'cloud:removeMember': (orgId: string, userId: string) => CloudOrgDetail
  'cloud:renameOrg': (orgId: string, name: string) => CloudOrgDetail
  'cloud:leaveOrg': (orgId: string) => void
  'cloud:deleteOrg': (orgId: string) => void
  'cloud:acceptInvite': (codeOrUrl: string) => CloudOrgDetail
  'cloud:redeem': (code: string) => CloudState
  // ---- organisations ----
  /** Sign in with another provider to add its email to this account. */
  'cloud:addEmail': (provider: 'github' | 'google') => void
  'cloud:removeEmail': (email: string) => CloudState
  'cloud:createOrg': (name: string) => CloudOrgDetail
  'cloud:setDomainJoin': (orgId: string, policy: 'open' | 'approval' | 'off') => CloudOrgDetail
  'cloud:setOrgDefaultMode': (orgId: string, mode: AppMode) => CloudOrgDetail
  'cloud:addDomain': (orgId: string, domain: string) => { verified: boolean; domain: string; token?: string; record?: string; found?: string[]; org: CloudOrgDetail }
  'cloud:verifyDomain': (orgId: string, domain: string) => { verified: boolean; domain: string; token?: string; record?: string; found?: string[]; org: CloudOrgDetail }
  'cloud:removeDomain': (orgId: string, domain: string) => CloudOrgDetail
  'cloud:discover': () => DiscoveredOrg[]
  'cloud:joinOrg': (orgId: string) => { joined: boolean; requested?: boolean }
  'cloud:decideRequest': (orgId: string, userId: string, action: 'approve' | 'deny') => CloudOrgDetail
  /** Share a space in an organisation (or push its latest definition when already shared). */
  'orgSpaces:publish': (spaceId: string, orgId: string) => Space
  /** Stop sharing: the space stays, becomes personal. Admins may also delete the server copy. */
  'orgSpaces:unshare': (spaceId: string, deleteRemote?: boolean) => Space
  /** Pull every organisation's shared spaces; returns the spaces created or updated. */
  'orgSpaces:sync': () => { created: string[]; updated: string[]; missingRepos: { spaceId: string; remotes: string[] }[] }
  /** Repositories of a shared space that are not on this Mac yet. */
  'orgSpaces:missing': (spaceId: string) => SharedRepo[]
  /** Locate or clone missing repositories of a shared space. */
  'orgSpaces:resolve': (spaceId: string, resolutions: SpaceImportResolution[]) => Space
  /** What teammates are working on in this shared space. */
  'orgSpaces:teammates': (spaceId: string) => TeammateWorkspace[]
  /** Open a teammate's workspace here: same name and branches, checked out from origin when pushed. */
  'orgSpaces:openTeammate': (spaceId: string, remote: TeammateWorkspace) => Workspace
  // ---- phone companion ----
  'remote:status': () => RemoteStatus
  'remote:pair': () => { url: string; qrSvg: string }
  'remote:unpair': () => RemoteStatus
  'remote:updateSettings': (patch: Partial<RemoteSettings>) => RemoteSettings
  // ---- shared spaces (sinfonie.space.json) ----
  'shared:definition': (spaceId: string) => SpaceDefinition
  'shared:export': (spaceId: string, repoId: string) => { file: string }
  'shared:pickFile': () => string | null
  'shared:preview': (file: string) => SpaceImportPreview
  'shared:import': (file: string, resolutions: SpaceImportResolution[]) => Space
  'shared:pending': () => { spaceId: string; file: string; missing: boolean; changed: boolean }[]
  'shared:apply': (spaceId: string) => Space
  'shared:unlink': (spaceId: string) => Space

  'shell:openExternal': (url: string) => void
  'updates:check': () => UpdateInfo | null
  'updates:download': () => void
  'updates:install': () => void
  /** Arm or disarm the idle restart for a downloaded update. */
  'updates:installWhenIdle': (on: boolean) => void
  'feedback:send': (payload: { kind: 'feedback' | 'feature' | 'bug'; message: string; email?: string; includeLogs?: boolean; attachments?: { name: string; mime: string; data: string }[] }) => { ok: boolean; error?: string }
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
  /** PRs from the given repositories (owner/name) plus, when owners are given, every repository of those owners. */
  'reviews:list': (owners: string[], mode: 'requested' | 'all', repos?: string[]) => ReviewPr[]
  /** Owners detected from the origin remotes of a space's repos ('' = repos in no space). */
  'reviews:detectOwners': (spaceId: string) => string[]
  /** GitHub repositories (owner/name) behind a space's registered repos. */
  'reviews:detectRepos': (spaceId: string) => string[]
  'reviews:runs': () => ReviewRun[]
  'reviews:start': (pr: ReviewPr, accountId: string) => ReviewRun
  'reviews:cancel': (key: string) => void
  'reviews:discard': (key: string) => void
  'reviews:updateFinding': (key: string, findingId: string, patch: Partial<ReviewFinding>) => ReviewRun
  'reviews:setAll': (key: string, approved: boolean) => ReviewRun
  'reviews:setVerdict': (key: string, verdict: ReviewVerdict) => ReviewRun
  'reviews:submit': (key: string) => ReviewRun
  /** Fix the given findings (or every unaddressed non-nit one) in the PR checkout, commit and push. */
  'reviews:fix': (key: string, findingIds: string[] | 'all') => ReviewRun
  /** Fix, push, re-review, repeat until approved or maxRounds. */
  'reviews:iterate': (key: string, maxRounds?: number) => ReviewRun
  'reviews:stopIteration': (key: string) => void

  'agent:send': (workspaceId: string, text: string, images?: ChatImageInput[]) => void
  'agent:interrupt': (workspaceId: string) => void
  /** Claude Code's breakdown of the live session's context window; null when no session is live. */
  'agent:contextUsage': (workspaceId: string) => ContextUsage | null
  /** Ask Claude Code to compact the conversation (summarise it) in place. */
  'agent:compact': (workspaceId: string) => void
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
  'crew:suggest': (spaceId?: string, priority?: CrewPriority) => CrewSuggestion
  /** Instant, rule-based suggestion for Claude Code crews; null for other engines. */
  'crew:preset': (spaceId?: string, priority?: CrewPriority) => CrewSuggestion | null
  /** Run the agent's own authentication method (browser or terminal flow). Returns the terminal command when one must be run instead. */
  'acp:authenticate': (engine: Engine, methodId: string) => { ok: boolean; terminalCommand?: string; error?: string }
  /** A shell already running `command`, for interactive logins. */

  'providers:add': (cfg: { kind: ProviderKind; name: string; baseUrl?: string; apiKey?: string }) => ProviderConfig
  'providers:update': (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string }) => ProviderConfig
  'providers:remove': (id: string) => void
  /** Fetches the provider's model list and caches it on the config. */
  'providers:models': (id: string) => string[]
  'agent:reset': (workspaceId: string) => void
  /** Set the cost profile at one scope; sessions that are affected restart and resume their conversation. */
  'costMode:set': (scope: CostModeScope, mode: CostMode | null) => void
  // ---- databases ----
  'db:list': (spaceId: string) => DbConnection[]
  'db:save': (spaceId: string, conn: DbConnection, secrets?: DbSecrets) => DbConnection
  'db:remove': (spaceId: string, id: string) => void
  'db:test': (spaceId: string, conn: DbConnection, secrets?: DbSecrets) => { ok: boolean; message: string; ms: number }
  'db:schema': (spaceId: string, id: string, refresh?: boolean) => DbSchema
  'db:query': (spaceId: string, id: string, sql: string, opts?: { maxRows?: number; timeoutMs?: number; allowWrite?: boolean }) => DbQueryResult
  'db:cancel': (spaceId: string, id: string) => string
  'db:history': (connectionId: string) => DbHistoryEntry[]
  'db:cloudSqlInstances': (spaceId: string) => { connectionName: string; name: string; engine: string; region: string }[]
  /** Read-only classification, so the Data tab can warn before running a write. */
  'db:classify': (spaceId: string, id: string, text: string) => { statements: number; readOnly: boolean; first: string }
  'db:explain': (spaceId: string, id: string, text: string) => string
  /** UPDATE one row by primary key on a connection that allows writes; the UI confirmed the preview. */
  'db:update': (spaceId: string, id: string, req: { table: { schema: string; name: string }; pk: Record<string, unknown>; set: Record<string, unknown> }) => { affected: number; preview: string }
  'db:updatePreview': (spaceId: string, id: string, req: { table: { schema: string; name: string }; pk: Record<string, unknown>; set: Record<string, unknown> }) => string
  'db:csvPreview': (path?: string) => { path: string; delimiter: string; headers: string[]; sample: string[][]; rowCount: number } | null
  'db:import': (spaceId: string, id: string, req: { path: string; delimiter: string; table: { schema: string; name: string }; mapping: Record<string, string>; coerceTypes?: boolean }) => { inserted: number; ms: number }
  'db:export': (spaceId: string, id: string, text: string, format: 'csv' | 'json') => { path: string; rows: number } | null
  'db:pickSqlite': () => string | null
  // ---- setup assistant ----
  'assistant:send': (text: string) => void
  'assistant:history': () => { items: AssistantItem[]; busy: boolean }
  'assistant:reset': () => void
  'assistant:stop': () => void
  'agent:setMode': (workspaceId: string, mode: PermissionMode) => Workspace
  'chat:load': (workspaceId: string) => { items: ChatItem[]; busy: boolean }
  // ---- session notes ----
  'notes:list': (workspaceId: string) => Note[]
  'notes:add': (workspaceId: string, text: string, kind: Note['kind']) => Note[]
  'notes:update': (workspaceId: string, id: string, patch: Partial<Pick<Note, 'text' | 'done' | 'kind'>>) => Note[]
  'notes:remove': (workspaceId: string, id: string) => Note[]

  /** A shell in the repo's worktree, or at the workspace root when repoId is null. */
  'terminal:create': (workspaceId: string, repoId: string | null, cols?: number, rows?: number, agent?: Engine) => string
  /** Engines whose interactive CLI can be opened in a workspace terminal (a signed-in account exists). */
  'terminal:clis': () => Engine[]
  // ---- CLI mode: the real claude in the Chat tab, session shared with the chat ----
  'cli:status': (workspaceId: string) => CliStatus
  'cli:start': (workspaceId: string, opts?: { prompt?: string; fresh?: boolean; cols?: number; rows?: number }) => CliStatus
  'cli:stop': (workspaceId: string) => CliStatus
  'cli:type': (workspaceId: string, text: string) => void
  'workspaces:setAgentMode': (workspaceId: string, mode: AgentMode) => Workspace
  'terminal:write': (terminalId: string, data: string) => void
  /** Whether the system clipboard currently holds an image (so ⌘V in a terminal can hand the paste to the CLI). */
  'clipboard:hasImage': () => boolean
  'terminal:resize': (terminalId: string, cols: number, rows: number) => void
  'terminal:dispose': (terminalId: string) => void
  // ---- usage ----
  'usage:get': () => UsageSnapshot
  'usage:resolveLimit': (workspaceId: string, itemId: string, choice: LimitAlternative) => void
  // ---- on call ----
  'oncall:state': () => OnCallState
  /** Live view of a Slack connection: derived flags (vendor client, own client) are never trusted from the persisted copy. */
  'slack:connection': (connId: string) => SlackConnection
  /** connId: '' for the application's Slack, or a space id for that space's own. */
  'oncall:slackSetClient': (connId: string, clientId: string, clientSecret: string) => SlackConnection
  /** Opens the browser for Slack approval; the code returns via sinfonie://oauth/slack or oncall:slackFinish. */
  'oncall:slackConnect': (connId: string) => void
  'oncall:slackFinish': (code: string, connId?: string) => SlackConnection
  'oncall:slackDisconnect': (connId: string) => SlackConnection
  'oncall:slackClearClient': (connId: string) => SlackConnection
  'oncall:slackChannels': (connId: string, query?: string) => { id: string; name: string; is_private: boolean; is_member: boolean }[]
  'oncall:pollNow': () => void
  'oncall:triage': (incidentId: string) => void
  'oncall:setStatus': (incidentId: string, status: IncidentStatus) => Incident
  'oncall:setSeverity': (incidentId: string, severity: Severity) => Incident
  'oncall:approve': (incidentId: string, proposalId: string, text?: string) => Incident
  'oncall:dismissProposal': (incidentId: string, proposalId: string) => Incident
  'oncall:addProposal': (incidentId: string, text: string) => Incident
  'oncall:ask': (incidentId: string, question: string) => Incident
  'oncall:remove': (incidentId: string) => void
  /** Applies one change to many incidents; returns how many were touched. */
  'oncall:bulk': (incidentIds: string[], op: OnCallBulkOp) => number
  /** Draft a PR with the triage's proposed fix: branch from the default branch, agent edits, push, `gh pr create --draft`. */
  'oncall:openFixPr': (incidentId: string) => Incident
  'gcp:status': (force?: boolean) => GcpStatus
  'gcp:projects': (account?: string, force?: boolean) => { projectId: string; name: string }[]
  /** `gcloud auth login [account]`: opens the browser; pass the account to re-authenticate an expired one. */
  'gcp:login': (account?: string) => GcpStatus
  /** Runs one small read in the space's (or app's) project and describes the result. */
  'gcp:test': (spaceId: string) => string
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
  /** A prompt was answered from another surface (the phone). */
  'agent:promptResolved': { requestId: string }
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
  /** Guided mode: a turn changed files in these apps, so the person can look at the preview. */
  'guided:changed': { workspaceId: string; apps: string[] }
  /** A new error was logged; the sidebar badge updates. */
  'errors:new': ErrorEntry
  /** Memory and process sample, every few seconds. */
  'resources:snapshot': ResourceSnapshot
  'browser:state': BrowserState
  'oncall:changed': OnCallState
  'usage:changed': UsageSnapshot
  /** A sign-in link to show the user (Open in browser / Copy link). */
  'ui:authLink': AuthLink
  /** That sign-in finished; close the dialog. */
  'ui:authDone': { provider: AuthLink['provider']; connId: string }
  /** A sinfonie://join or sinfonie://redeem link arrived: the Plan page should act on it. */
  'cloud:invite': { token: string; kind: 'join' | 'redeem' }
  'remote:status': RemoteStatus
  /** Open the review cockpit on this PR (notification click). */
  'ui:openReview': { key: string }
  /** The assistant (or main) asks the renderer to show a settings page. */
  'ui:openSettings': { scope: 'app'; page: string } | { scope: 'space'; spaceId: string; page: string }
  'db:history': { connectionId: string }
  'assistant:event': { type: 'item'; item: AssistantItem } | { type: 'delta'; id: string; text: string } | { type: 'status'; busy: boolean } | { type: 'reset' }
  /** Open the On call view on this incident (notification click, deep link). */
  'ui:openOnCall': { incidentId?: string }
  /** An agent started using the browser of this workspace; the renderer brings the pane forward. */
  'browser:agentActive': { workspaceId: string }
}

export type InvokeChannel = keyof SinfonieInvoke
export type EventChannel = keyof SinfonieEvents
