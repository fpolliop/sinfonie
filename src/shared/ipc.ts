import type {
  AgentEvent,
  PermissionMode,
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
  'workspaces:archive': (workspaceId: string, opts: { deleteBranches: boolean }) => Workspace
  'workspaces:delete': (workspaceId: string) => void
  'workspaces:rename': (workspaceId: string, name: string) => Workspace
  'workspaces:openIn': (workspaceId: string, app: 'finder' | 'vscode' | 'cursor' | 'terminal') => void
  'workspaces:runScript': (workspaceId: string, kind: 'setup' | 'run') => void
  'workspaces:stopScript': (workspaceId: string, kind: 'setup' | 'run') => void
  'workspaces:renameBranch': (workspaceId: string, branch: string) => Workspace

  'git:status': (workspaceId: string) => RepoGitStatus[]
  'git:diff': (workspaceId: string, repoId: string, path?: string) => string
  'git:commit': (workspaceId: string, repoId: string, message: string) => string
  'git:push': (workspaceId: string, repoId: string) => string
  'git:createPr': (workspaceId: string, repoId: string, title: string, body: string) => string

  'agent:send': (workspaceId: string, text: string) => void
  'agent:interrupt': (workspaceId: string) => void
  'agent:permission': (response: PermissionResponse) => void
  'agent:reset': (workspaceId: string) => void
  'agent:setMode': (workspaceId: string, mode: PermissionMode) => Workspace

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
}

export type InvokeChannel = keyof OrchestraInvoke
export type EventChannel = keyof OrchestraEvents
