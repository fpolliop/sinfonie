import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Settings, StoreData } from '@shared/types'

type Listener = (data: StoreData) => void

const DEFAULT_SETTINGS: Settings = {
  workspacesRoot: join(homedir(), 'orchestra', 'workspaces'),
  basePort: 55000,
  model: 'claude-opus-5',
  permissionMode: 'default',
  jira: { connected: false, siteUrl: '', email: '', hasToken: false, defaultJql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' }
}

/**
 * Tiny JSON-file store. Everything the app knows lives in one file under
 * userData, so it is trivially inspectable and backed up.
 */
class Store {
  private data: StoreData
  private file: string
  private listeners = new Set<Listener>()

  constructor() {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'orchestra.json')
    this.data = this.load()
  }

  private load(): StoreData {
    if (!existsSync(this.file)) {
      return { repos: [], workspaces: [], settings: { ...DEFAULT_SETTINGS } }
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>
      return {
        repos: raw.repos ?? [],
        workspaces: raw.workspaces ?? [],
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}), jira: { ...DEFAULT_SETTINGS.jira, ...(raw.settings?.jira ?? {}) } },
        secrets: raw.secrets ?? {}
      }
    } catch (err) {
      console.error('Failed to read store, starting fresh', err)
      return { repos: [], workspaces: [], settings: { ...DEFAULT_SETTINGS } }
    }
  }

  get(): StoreData {
    return this.data
  }

  /** What the renderer is allowed to see: everything except secrets. */
  public(): StoreData {
    const { secrets: _secrets, ...rest } = this.data
    return rest
  }

  update(mutator: (draft: StoreData) => void): StoreData {
    mutator(this.data)
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    for (const l of this.listeners) l(this.data)
    return this.data
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

let instance: Store | null = null
export function getStore(): Store {
  if (!instance) instance = new Store()
  return instance
}
