import { app, dialog, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Settings, StoreData } from '@shared/types'
import { DEFAULT_CREW } from '@shared/types'

type Listener = (data: StoreData) => void

const DEFAULT_SETTINGS: Settings = {
  workspacesRoot: join(homedir(), 'sinfonie', 'workspaces'),
  basePort: 55000,
  model: 'claude-opus-5',
  permissionMode: 'default',
  agents: DEFAULT_CREW,
  claudeAccounts: [{ id: 'default', name: 'Default (~/.claude)', configDir: null }],
  defaultClaudeAccountId: 'default',
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
    this.file = join(dir, 'sinfonie.json')
    // Earlier builds were called Orchestra; carry the store over once.
    const legacy = join(dir, 'orchestra.json')
    if (!existsSync(this.file) && existsSync(legacy)) renameSync(legacy, this.file)
    this.data = this.load()
  }

  private load(): StoreData {
    if (!existsSync(this.file)) {
      return { spaces: [], labels: [], repos: [], workspaces: [], settings: { ...DEFAULT_SETTINGS } }
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>
      return {
        spaces: raw.spaces ?? [],
        labels: raw.labels ?? [],
        repos: raw.repos ?? [],
        workspaces: (raw.workspaces ?? []).map((w) => ({ ...w, stage: w.stage ?? 'in-progress' })),
        settings: {
          ...DEFAULT_SETTINGS,
          ...(raw.settings ?? {}),
          jira: { ...DEFAULT_SETTINGS.jira, ...(raw.settings?.jira ?? {}) },
          claudeAccounts: withVendorDefaults(raw.settings?.claudeAccounts?.length ? raw.settings.claudeAccounts : DEFAULT_SETTINGS.claudeAccounts),
          defaultClaudeAccountId: raw.settings?.defaultClaudeAccountId ?? 'default',
          agents: raw.settings?.agents?.length ? raw.settings.agents : DEFAULT_CREW
        },
        secrets: migrateSecrets(raw.secrets ?? {})
      }
    } catch (err) {
      console.error('Failed to read store, starting fresh', err)
      this.setAside(err)
      return { spaces: [], labels: [], repos: [], workspaces: [], settings: { ...DEFAULT_SETTINGS } }
    }
  }

  /**
   * The store could not be read: keep the bad file next to it (sinfonie.corrupt-<time>.json) instead of overwriting
   * it on the next save, and say so once, with a way to find the file.
   */
  private setAside(err: unknown): void {
    const aside = join(app.getPath('userData'), `sinfonie.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    try {
      renameSync(this.file, aside)
    } catch {
      try {
        copyFileSync(this.file, aside)
      } catch (copyErr) {
        console.error('Could not keep a copy of the unreadable store', copyErr)
        return
      }
    }
    const reason = err instanceof Error ? err.message : String(err)
    void app.whenReady().then(() =>
      setTimeout(() => {
        void dialog
          .showMessageBox({
            type: 'warning',
            message: 'Sinfonie could not read its saved data',
            detail: `The file was damaged (${reason.slice(0, 200)}), so Sinfonie started fresh. Your workspaces' folders on disk are untouched. The old file was kept as ${aside}; it can be repaired by hand or sent with feedback.`,
            buttons: ['Continue', 'Show the old file'],
            defaultId: 0,
            cancelId: 0
          })
          .then(({ response }) => response === 1 && shell.showItemInFolder(aside))
      }, 1500)
    )
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
    // Atomic: write a temp file next to it, then rename over, so a crash mid-write never leaves half a store.
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
    for (const l of this.listeners) l(this.data)
    return this.data
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** Earlier builds stored the single Jira login under fixed names; they now live under the default connection. */
function migrateSecrets(s: Record<string, string | undefined>): Record<string, string | undefined> {
  const map: Record<string, string> = { jiraOAuthClient: 'jira:default:client', jiraOAuthTokens: 'jira:default:tokens', jiraOAuthVerifier: 'jira:default:verifier', jiraToken: 'jira:default:apitoken' }
  const out = { ...s }
  for (const [oldKey, newKey] of Object.entries(map)) {
    if (out[oldKey] && !out[newKey]) out[newKey] = out[oldKey]
    delete out[oldKey]
  }
  return out
}

/** Every vendor gets a built-in "your normal login" account; older records default to Anthropic. */
function withVendorDefaults(list: Settings['claudeAccounts']): Settings['claudeAccounts'] {
  const out = list.map((a) => ({ ...a, vendor: a.vendor ?? ('anthropic' as const) }))
  const defaults: { id: string; name: string; vendor: 'openai' | 'google' | 'xai' }[] = [
    { id: 'openai-default', name: 'Default (~/.codex)', vendor: 'openai' },
    { id: 'google-default', name: 'Default (~/.gemini)', vendor: 'google' },
    { id: 'xai-default', name: 'Default (~/.grok)', vendor: 'xai' }
  ]
  for (const d of defaults) if (!out.some((a) => a.id === d.id)) out.push({ ...d, configDir: null })
  return out
}

let instance: Store | null = null
export function getStore(): Store {
  if (!instance) instance = new Store()
  return instance
}
