import type {
  AgentEvent,
  ChatItem,
  JiraIssue,
  RepoPr,
  PermissionMode,
  RepoSafety,
  ReviewFinding,
  ReviewPr,
  ReviewRun,
  ReviewVerdict,
  WorkspaceStage,
  CreateWorkspaceInput,
  PermissionRequest,
  PermissionResponse,
  Repo,
  RepoGitStatus,
  ScriptOutputEvent,
  Settings,
  StoreData,
  TerminalDataEvent,
  Workspace
} from './types'

/** Request/response channels (ipcRenderer.invoke). */
export interface OrchestraInvoke {
  'store:get': () => StoreData
  'settings:update': (patch: Partial<Settings>) => Settings

  'repos:pickAndAdd': () => Repo | null
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

  'git:status': (workspaceId: string) => RepoGitStatus[]
  'git:diff': (workspaceId: string, repoId: string, path?: string) => string
  'git:commit': (workspaceId: string, repoId: string, message: string) => string
  'git:push': (workspaceId: string, repoId: string) => string
  'git:createPr': (workspaceId: string, repoId: string, title: string, body: string) => string

  'github:status': (workspaceId: string) => RepoPr[]

  'jira:authenticate': () => Settings
  'jira:disconnect': () => Settings
  'jira:saveToken': (token: string) => Settings
  'jira:search': (query: string) => JiraIssue[]
  'jira:issue': (key: string) => JiraIssue

  'shell:openExternal': (url: string) => void

  'accounts:add': (name: string) => Settings
  'accounts:remove': (id: string) => Settings
  'accounts:setDefault': (id: string) => Settings
  'accounts:check': (id: string) => Settings
  'accounts:loginTerminal': (id: string) => string

  'reviews:orgs': () => string[]
  'reviews:list': (owner: string, mode: 'requested' | 'all') => ReviewPr[]
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
  'script:output': ScriptOutputEvent
  'terminal:data': TerminalDataEvent
  'terminal:exit': { terminalId: string; exitCode: number }
  'review:changed': ReviewRun
}

export type InvokeChannel = keyof OrchestraInvoke
export type EventChannel = keyof OrchestraEvents
