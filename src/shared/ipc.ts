import type { MaestroMemoryCategory, MaestroMemoryEntry, MaestroConversation, MaestroConversationMeta, MaestroContext, MaestroEvent, MaestroSuggestion, NotePatch, NotesFilter, AgentRun, AgentDraft, AgentRunEvent, AgentSpec, AgentMode, AppMode, AuthLink, CompletionRequest, DiscoveredOrg, SharedRepo, TeammateWorkspace, BillingPeriod, CliStatus, CloudOrgDetail, CloudState, Plan, RemoteSettings, RemoteStatus, SpaceDefinition, SpaceImportPreview, SpaceImportResolution, BrowserState, ContextUsage, CrewPriority, FsEntry, LimitAlternative, UsageSnapshot, ChatImageInput, Incident, IncidentStatus, LinearIssue, LinearSettings, OnCallState, ResourceSnapshot, Severity, SlackConnection, LoginProgress, LoginBrowser, ScannedRepo, Note, ModelInventoryItem, CrewSuggestion, OnCallBulkOp,
  AgentEvent,
  ChatItem,
  ChangeCheckpoint,
  GuidedChange,
  GuidedPictures,
  PickedElement,
  VisualCheck,
  JiraIssue,
  JiraSettings,
  Label,
  McpServerSpec,
  RepoPr,
  PermissionMode,
  AcpProbe,
  AgentPrereq,
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
  ChangeScope,
  ChangedFileStat,
  ScriptOutputEvent,
  Settings,
  Space,
  StoreData,
  TerminalDataEvent,
  Workspace, CostMode, CostModeScope, GcpStatus, AssistantItem, DbConnection, DbSecrets, DbSchema, DbQueryResult, DbHistoryEntry, ScopedView, ViewInput, ViewScope, ViewSourceBinding, ViewDataResult, ViewSlot } from './types'

/** Request/response channels (ipcRenderer.invoke). */
export interface SinfonieInvoke {
  'store:get': () => StoreData
  'settings:update': (patch: Partial<Settings>) => Settings

  'spaces:create': (name: string) => Space
  'spaces:update': (id: string, patch: Partial<Pick<Space, 'name' | 'color' | 'claudeAccountId' | 'model' | 'permissionMode' | 'workspacesRoot' | 'browserSensitiveOrigins' | 'githubOwners' | 'exposeLinearMcp' | 'oncall' | 'budgetMode' | 'leanMode' | 'gcp' | 'exposeGcpMcp' | 'mcpServers' | 'exposeJiraMcp' | 'strictMcp' | 'agents' | 'useCrew' | 'crewDisabled' | 'crewModels' | 'engine' | 'agentMode' | 'guided'>>) => Space
  /** MCP servers found in Claude Code's own config (~/.claude.json), for importing. */
  'mcp:importable': () => McpServerSpec[]
  /** Connects to a server the way a session would and lists its tool names. Rejects with plain words when it cannot. */
  'mcp:test': (spec: McpServerSpec) => string[]
  'spaces:delete': (id: string) => void
  /** Team → Guardrails: replace a space's team rules (admins only). */
  'team:setRules': (spaceId: string, rules: import('./types').TeamRules) => Space
  /** Lift today's daily spend limit for a space on this Mac (admins only). */
  'team:overrideSpend': (spaceId: string) => Space
  /** Lifts today's spend limit for one organisation member; shared with the team through the organisation sync. */
  'team:allowSpendFor': (spaceId: string, userId: string, login?: string) => Space
  /** Team → Apps: whether builders may change one app (admins only). Keyed by the app's remote. */
  'team:setAppLookOnly': (spaceId: string, repoId: string, lookOnly: boolean) => Space
  /** The key each app of a space has in `rules.builderReadOnly`: its normalised remote, else its name. */
  'team:appKeys': (spaceId: string) => Record<string, string>
  /** Today's (local day) estimated spend in a space on this Mac, against its limit. */
  'team:spend': (spaceId: string) => { spent: number; limit?: number; lifted: boolean; day: string }
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
  /** Clone a GitHub repository into ~/Sinfonie/<name> (reusing an existing checkout there) and return its local path. */
  /** The same clone, answering with a failure kind instead of throwing; `folderName` when the default folder holds another app. */
  'repos:cloneApp': (url: string, folderName?: string) => import('./types').CloneResult
  'repos:cancelClone': (url: string) => void
  /** What a picked folder is: an app, inside one (its top is used), a plain folder, or git is missing. */
  'repos:inspectFolder': (path: string) => import('./types').FolderKind
  /** "Set this folder up for Sinfonie": git init on main and a first saved version. Returns the folder. */
  'repos:initFolder': (path: string) => string
  // ---- GitHub connection and prerequisites (main/services/prereqs.ts; renderer lib/github.ts) ----
  'github:connection': (refresh?: boolean) => import('./types').GitHubConnection
  /** Connect GitHub in-app (downloads gh if needed, gh auth login --web, gh auth setup-git). Progress: github:connectProgress. */
  'github:connect': () => void
  'github:cancelConnect': () => void
  'github:connectState': () => import('./types').GitHubConnectState
  /** Opens Apple's installer for the developer tools (git). */
  'github:installXcodeTools': () => void
  /** Everything Send for review needs, checked before anything is saved or sent. */
  'github:preflight': (workspaceId: string) => import('./types').SendPreflight
  /** Put an app that is not on GitHub yet on the signed-in account, private. Returns owner/name. */
  'github:publishRepo': (workspaceId: string, repoId: string) => string
  /** Make the person's own copy (fork) of an app they may not change, and send from it. Returns owner/name. */
  'github:forkRepo': (workspaceId: string, repoId: string) => string
  /** Merge a pull request of the person's own app (solo Publish, after they confirmed). */
  'github:mergePr': (workspaceId: string, repoId: string, url: string) => void
  /** Give an app a git author (from GitHub or the Sinfonie account) when it has none. */
  'github:ensureIdentity': (repoPath: string) => void
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
  /** Starts the scripts and returns once they are started (not when they exit), with how many started. */
  'workspaces:runScript': (workspaceId: string, kind: 'setup' | 'run') => { started: number }
  'workspaces:stopScript': (workspaceId: string, kind: 'setup' | 'run' | 'archive') => void
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
  /** Changed files with +/− counts: uncommitted work, or the whole branch against its merge-base with the base branch. */
  'git:changes': (workspaceId: string, repoId: string, scope: ChangeScope) => { base: string | null; files: ChangedFileStat[] }
  /** One file's diff in a scope. */
  'git:fileDiff': (workspaceId: string, repoId: string, path: string, scope: ChangeScope) => string
  /** Revert one modified tracked file to HEAD (index and working tree); returns the replaced bytes for Undo. */
  'git:restoreFile': (workspaceId: string, repoId: string, path: string) => { saved: string; hash: string }
  /** Undo git:restoreFile, only while the file is still what the restore left (its hash). */
  'git:undoRestore': (workspaceId: string, repoId: string, path: string, saved: string, hash: string) => void
  'git:commit': (workspaceId: string, repoId: string, message: string) => string
  'git:push': (workspaceId: string, repoId: string) => string
  'git:createPr': (workspaceId: string, repoId: string, title: string, body: string, reviewers?: string[]) => string
  /** Runs each repo's check script (build/tests/lint) once and reports pass or fail per app. Guided Send for review. */
  'workspaces:check': (workspaceId: string) => { repoId: string; name: string; ran: boolean; ok: boolean; output: string }[]
  /** Worktrees recorded for the workspace that are not on disk any more. */
  'workspaces:health': (workspaceId: string) => { missing: { repoName: string; worktreePath: string; branch: string }[] }
  /** Recreate missing worktrees from their recorded branches. */
  'workspaces:repair': (workspaceId: string) => Workspace
  /** Manual sidebar order: the ids in the order they should appear. */
  'workspaces:setOrder': (ids: string[]) => void
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
  /** "Check again": refresh the account, sync, and try every missing shared app again (failures land in space.cloneErrors). */
  'orgSpaces:retryMissing': () => void
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
  /** Reconnects to the relay now (after an error), instead of waiting for the backoff. */
  'remote:reconnect': () => RemoteStatus
  'remote:updateSettings': (patch: Partial<RemoteSettings>) => RemoteSettings
  'remote:seen': (workspaceId: string) => void
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
  /** Bring the calling window to the front: restore it if minimised, show it if hidden, focus it (a notification click). */
  'window:focus': () => void
  'updates:check': () => UpdateInfo | null
  'updates:download': () => void
  'updates:install': () => void
  /** Arm or disarm the idle restart for a downloaded update. */
  'updates:installWhenIdle': (on: boolean) => void
  /** Stop the download in flight; the update is offered again. */
  'updates:cancel': () => void
  /** The update this app run already knows about, without checking again. */
  'updates:latest': () => UpdateInfo | null
  'feedback:send': (payload: { kind: 'feedback' | 'feature' | 'bug'; message: string; email?: string; includeLogs?: boolean; attachments?: { name: string; mime: string; data: string }[] }) => { ok: boolean; error?: string }
  'logs:open': () => void
  'logs:list': () => ErrorEntry[]
  'logs:clear': () => void
  'app:version': () => string
  /** The renderer's listeners are mounted: replay deep links that arrived before (main/index.ts). */
  'ui:takePendingLinks': () => void

  'accounts:add': (name: string, vendor?: Vendor) => Settings
  'accounts:remove': (id: string) => Settings
  'accounts:setDefault': (id: string) => Settings
  'accounts:check': (id: string) => Settings
  'accounts:login': (id: string) => string
  /** Installs a missing agent prerequisite in a pty (its output streams as terminal:data); null when there is no safe one-step installer. */
  'accounts:install': (what: AgentPrereq) => string | null
  /** Stops a pending Jira, Linear or Sinfonie sign-in; its dialog gets ui:authDone with an error. */
  'auth:cancel': (provider: AuthLink['provider'], connId: string) => void

  'reviews:orgs': () => string[]
  /** PRs from the given repositories (owner/name) plus, when owners are given, every repository of those owners. */
  'reviews:list': (owners: string[], mode: 'requested' | 'all', repos?: string[]) => ReviewPr[]
  /** Owners detected from the origin remotes of a space's repos ('' = repos in no space). */
  'reviews:detectOwners': (spaceId: string) => string[]
  /** GitHub repositories (owner/name) behind a space's registered repos. */
  'reviews:detectRepos': (spaceId: string) => string[]
  /** Hosts of the space's repositories that are not github.com (GitHub Enterprise and others are not supported yet). */
  'reviews:otherHosts': (spaceId: string) => string[]
  /** Which GitHub logins do not exist. `unchecked` says why nothing could be checked (GitHub not reachable). */
  'reviews:checkLogins': (logins: string[]) => { invalid: string[]; unchecked?: string }
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
  // ---- review inbox (pre-reads, marks, GitHub fallbacks) ----
  /** Pre-read and rule-based risk for a PR; cached per PR update. */
  'inbox:preread': (pr: ReviewPr, force?: boolean) => import('./inbox').PreRead
  /** Pre-read for a local workspace's branch (a hand-off with no pull request yet). */
  'inbox:prereadWorkspace': (workspaceId: string, force?: boolean) => import('./inbox').PreRead
  'inbox:marks': () => Record<string, import('./inbox').InboxMark>
  'inbox:mark': (key: string, mark: import('./inbox').InboxMark | null) => Record<string, import('./inbox').InboxMark>
  /** A note on an external PR as a GitHub review asking for changes (a comment on your own PR). */
  'inbox:noteBackPr': (pr: ReviewPr, text: string) => import('./inbox').InboxMark
  /** Approve the head commit the reviewer read; refused when the PR moved on since. */
  'inbox:approvePr': (pr: ReviewPr, expectedHead: string) => void
  /** Local repository id to its origin's owner/name (lowercase). */
  'inbox:repoRemotes': () => Record<string, string>
  /** The workspace on the PR's branch, created from origin when there is none. */
  'inbox:takeOverPr': (pr: ReviewPr) => Workspace

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
  // ---- agent library ----
  'agents:list': () => AgentSpec[]
  /** Create (empty id) or update; returns the stored spec. */
  'agents:save': (spec: AgentSpec) => AgentSpec
  'agents:remove': (id: string) => void
  'agents:duplicate': (id: string) => AgentSpec
  'agents:fromTemplate': (name: string, spaceId?: string) => AgentSpec
  'agents:resetBuiltins': () => AgentSpec[]
  /** Draft a whole agent from a one-line description, model picked from the inventory. */
  'agents:draft': (description: string, spaceId?: string) => AgentDraft
  /** Run an agent once from the editor, in a workspace or (null) in its own context; progress arrives on agents:run. Returns the run id. */
  'agents:run': (agentId: string, workspaceId: string | null, prompt: string, override?: Partial<AgentSpec>, runId?: string) => string
  /** Run history of an agent, newest first. */
  'agents:runs': (agentId: string) => AgentRun[]
  /** Start the agent's standing task now, as a scheduled run would. */
  'agents:runNow': (agentId: string) => void
  'agents:cancelRun': (runId: string) => void
  /** Import Claude Code agent files (.claude/agents/*.md) from a folder. */
  'agents:importDir': (dir: string, spaceId?: string) => AgentSpec[]
  /** Write one agent as a Claude Code agent file into a folder; returns the path. */
  'agents:export': (id: string, dir: string) => string
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
  // ---- Maestro ----
  'maestro:conversations': () => MaestroConversationMeta[]
  'maestro:get': (id: string) => MaestroConversation
  'maestro:new': (context?: MaestroContext) => MaestroConversation
  /** retry: send the text again without adding it as a new message. accountId: continue this conversation on that account. */
  'maestro:send': (id: string, text: string, opts?: { retry?: boolean; accountId?: string }) => void
  'maestro:stop': (id: string) => void
  'maestro:rename': (id: string, title: string) => void
  'maestro:pin': (id: string, pinned: boolean) => void
  'maestro:archive': (id: string, archived: boolean) => void
  'maestro:delete': (id: string) => void
  'maestro:suggestions': () => MaestroSuggestion[]
  'maestro:memory': () => MaestroMemoryEntry[]
  'maestro:memoryAdd': (category: MaestroMemoryCategory, text: string) => MaestroMemoryEntry[]
  'maestro:memoryUpdate': (id: string, text: string) => MaestroMemoryEntry[]
  'maestro:memoryRemove': (id: string) => MaestroMemoryEntry[]
  /** Has the user talked to Maestro at all (for the checklist). */
  'assistant:history': () => { items: AssistantItem[]; busy: boolean }
  'agent:setMode': (workspaceId: string, mode: PermissionMode) => Workspace
  'chat:load': (workspaceId: string) => { items: ChatItem[]; busy: boolean }
  // ---- session notes ----
  'notes:list': (workspaceId: string) => Note[]
  'notes:add': (workspaceId: string, text: string, kind: Note['kind']) => Note[]
  'notes:update': (workspaceId: string, id: string, patch: NotePatch) => Note[]
  /** Move a note to another owner (workspace id, "space:<id>" or "app"). Returns the destination list. */
  'notes:move': (fromOwner: string, id: string, toOwner: string) => Note[]
  'notes:remove': (workspaceId: string, id: string) => Note[]
  /** Every owner with notes: workspace ids, "space:<id>" and "app", with a display label. */
  'notes:all': () => { owner: string; label: string; notes: Note[] }[]
  /** A Claude summary of the filtered notes, or an answer to a question about them. */
  /** A failure comes back as a coded error (not thrown), so the dialog can offer the fix: sign in, another account, retry. */
  'notes:summarize': (filter: NotesFilter, question?: string) => { text: string } | { error: { code: import('./types').MaestroTurnError['code']; message: string; detail?: string } }

  /** A shell in the repo's worktree, or at the workspace root when repoId is null. */
  'terminal:create': (workspaceId: string, repoId: string | null, cols?: number, rows?: number, agent?: Engine) => string
  /** Engines whose interactive CLI can be opened in a workspace terminal (a signed-in account exists). */
  'terminal:clis': () => Engine[]
  // ---- CLI mode: the real claude in the conversation, session shared with the chat ----
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
  // ---- keep awake (caffeinate) ----
  /** Whether the manual keep-awake blocker is on. */
  'power:get': () => boolean
  /** Turn the keep-awake blocker on or off (or toggle when no argument); returns the new state. */
  'power:set': (on?: boolean) => boolean
  'usage:resolveLimit': (workspaceId: string, itemId: string, choice: LimitAlternative) => void
  // ---- on call ----
  'oncall:state': () => OnCallState
  /** Live view of a Slack connection: derived flags (vendor client, own client) are never trusted from the persisted copy. */
  'slack:connection': (connId: string) => SlackConnection
  /** Diagnostic: what mcp.slack.com answers to an initialize with the stored token, and the token's scopes. */
  'slack:testMcp': (connId: string) => { ok: boolean; status: number; detail: string; scopes: string[] }
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
  'oncall:restore': (incident: Incident) => void
  /** Applies one change to many incidents; returns how many were touched. */
  'oncall:bulk': (incidentIds: string[], op: OnCallBulkOp) => number
  /** Draft a PR with the triage's proposed fix: branch from the default branch, agent edits, push, `gh pr create --draft`. */
  'oncall:openFixPr': (incidentId: string) => Incident
  /** Stops a queued or running triage, question or draft PR run for the incident. */
  'oncall:cancel': (incidentId: string) => Incident
  'gcp:status': (force?: boolean) => GcpStatus
  'gcp:projects': (account?: string, force?: boolean) => { projectId: string; name: string }[]
  /** `gcloud auth login [account]`: opens the browser; pass the account to re-authenticate an expired one. */
  'gcp:login': (account?: string) => GcpStatus
  /** Stops a running gcloud sign-in; the pending gcp:login rejects with a plain message. */
  'gcp:cancelLogin': () => void
  /** Runs one small read in the space's (or app's) project and describes the result. */
  'gcp:test': (spaceId: string) => string
  // ---- builder: the guided task screen's preview ----
  /** A small picture of the preview as it is now (JPEG data URL, the task's thumbnail, also saved on disk), or null when it is not open or not on screen. */
  'preview:capture': (workspaceId: string) => string | null
  /** The last saved preview picture per task, for the builder home. */
  'preview:thumbnails': (workspaceIds: string[]) => Record<string, string>
  /** "Point at something": waits for the person to click an element in the preview; null when cancelled (Esc). */
  'preview:pick': (workspaceId: string, token: string) => PickedElement | null
  /** Cancels that pick only (a newer pick is left alone). */
  'preview:cancelPick': (workspaceId: string, token: string) => void
  /** Quick checks on the preview before sending for review. */
  'preview:checks': (workspaceId: string) => VisualCheck[]
  /** The Send for review sheet closed: stop the checks it started. */
  'preview:cancelChecks': (workspaceId: string) => void
  /** Reverts the saves one guided turn made, newest first; refuses when later work depends on them. */
  'builder:undoChange': (workspaceId: string, checkpoints: ChangeCheckpoint[]) => void
  // ---- workspace browser ----
  'browser:state': (workspaceId: string) => BrowserState
  /** Chromium browsers whose logins can be imported into a space's in-app browser (macOS). */
  'logins:detect': () => LoginBrowser[]
  /** Import cookies from a browser into a space's in-app browser session. */
  'logins:import': (spaceId: string | undefined, browserId: string) => { imported: number; skipped: number; browser: string }
  /** Where the Browser pane sits in the window (CSS px), or null while hidden. */
  'browser:setBounds': (workspaceId: string, bounds: { x: number; y: number; width: number; height: number } | null) => void
  'browser:open': (workspaceId: string, url: string) => BrowserState
  'browser:navigate': (workspaceId: string, url: string) => void
  'browser:tabAction': (workspaceId: string, action: 'new' | 'select' | 'close' | 'back' | 'forward' | 'reload', tabId?: string) => BrowserState
  'browser:setPaused': (workspaceId: string, paused: boolean) => void
  /** A modal is open (true) or closed (false): pages are hidden while any modal is up. */
  'browser:suspend': (on: boolean) => void
  // ---- generated views (Home pages, workspace tabs) ----
  /** Create or replace a view (validated; throws with the issues). */
  'views:save': (input: ViewInput, scope: ViewScope) => ScopedView
  'views:undo': (id: string) => ScopedView
  'views:delete': (id: string) => void
  /** A personal copy of a space view that replaces it for this user. */
  'views:fork': (id: string) => ScopedView
  /** Drop a personal copy and go back to the team's view. */
  'views:resetToTeam': (id: string) => void
  'views:setHidden': (spaceViewId: string, hidden: boolean) => void
  'views:move': (id: string, dir: -1 | 1) => void
  'views:installTemplate': (templateId: string, scope?: ViewScope) => ScopedView
  'views:templates': () => { id: string; title: string; description: string; scope: 'user' | 'space'; guided: boolean; slot: ViewSlot; icon?: string }[]
  /** Rows for a main-side source (GitHub, git, Jira/Linear), cached briefly unless forced. */
  'views:data': (binding: ViewSourceBinding, ctx: { spaceId?: string; workspaceId?: string }, force?: boolean) => ViewDataResult
  /** A git/GitHub action from a view; confirm/outward tiers need confirmed = true. Returns a summary. */
  'views:action': (name: string, params: Record<string, unknown>, confirmed: boolean) => string
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
  'guided:changed': GuidedChange
  'guided:pictures': GuidedPictures
  'agents:changed': AgentSpec[]
  'agents:run': AgentRunEvent
  'agents:runsChanged': { agentId: string; runs: AgentRun[] }
  /** A scheduled run's notification was clicked: open that agent. */
  'ui:openAgent': { agentId: string }
  'ui:openWorkspace': { workspaceId: string }
  /** Menu items: toggle Maestro, open the New workspace dialog. */
  'ui:openMaestro': Record<string, never>
  'ui:newWorkspace': Record<string, never>
  /** A new error was logged; the sidebar badge updates. */
  'errors:new': ErrorEntry
  /** Memory and process sample, every few seconds. */
  'resources:snapshot': ResourceSnapshot
  'browser:state': BrowserState
  'oncall:changed': OnCallState
  'usage:changed': UsageSnapshot
  /** The keep-awake blocker changed, so every button stays in sync. */
  'power:changed': boolean
  /** A sign-in link to show the user (Open in browser / Copy link). */
  'ui:authLink': AuthLink
  /** That sign-in finished; close the dialog. */
  /** A sign-in finished; `error` (plain words) when it failed, timed out or was cancelled. */
  'ui:authDone': { provider: AuthLink['provider']; connId: string; error?: string }
  /** A sinfonie://join or sinfonie://redeem link arrived: the Plan page should act on it. */
  'cloud:invite': { token: string; kind: 'join' | 'redeem' }
  /** Any other sinfonie:// link opened from outside (a browser, another app): the renderer's openSinfonieLink handles it. */
  'ui:openLink': { href: string }
  /** The Slack sign-in coming back through sinfonie://oauth/slack failed; `message` is plain words for the Slack card. */
  'slack:authFailed': { connId?: string; message: string }
  'remote:status': RemoteStatus
  /** Open the review cockpit on this PR (notification click). */
  'ui:openReview': { key: string }
  /** The assistant (or main) asks the renderer to show a settings page. */
  'ui:openSettings': { scope: 'app'; page: string } | { scope: 'space'; spaceId: string; page: string }
  'db:history': { connectionId: string }
  'maestro:event': MaestroEvent
  /** Open the On call view on this incident (notification click, deep link). */
  'ui:openOnCall': { incidentId?: string }
  /** Show a generated view (Maestro saved or opened one): Home on it, or the workspace on its tab. */
  'ui:openView': { viewId: string; workspaceId?: string }
  /** An agent started using the browser of this workspace; the renderer brings the pane forward. */
  'browser:agentActive': { workspaceId: string }
  /** Connect GitHub progress (code to enter, done, failed). */
  'github:connectProgress': import('./types').GitHubConnectState
  /** An app download's progress. */
  'repos:cloneProgress': import('./types').CloneProgress
}

export type InvokeChannel = keyof SinfonieInvoke
export type EventChannel = keyof SinfonieEvents
