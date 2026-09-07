/**
 * Shared spaces: a space written to sinfonie.space.json in one of its repositories, so a team commits
 * it next to the code and every member imports the same repos, crew, integrations and defaults.
 * Repositories are named by remote, never by local path; accounts, tokens and folders stay personal.
 * Git is the sync layer: "check for updates" re-reads the file and applies what changed.
 */
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { basename, dirname, join } from 'path'
import { nanoid } from 'nanoid'
import { simpleGit } from 'simple-git'
import { getStore } from '../store'
import * as gitSvc from './git'
import * as cloud from './cloud'
import { SPACE_FILE, SPACE_COLORS } from '@shared/types'
import type { Repo, SharedRepo, SharedSpaceSettings, Space, SpaceDefinition, SpaceImportPreview, SpaceImportResolution } from '@shared/types'

const SHARED_KEYS = ['engine', 'model', 'permissionMode', 'useCrew', 'agents', 'budgetMode', 'leanMode', 'strictMcp', 'githubOwners', 'browserSensitiveOrigins', 'exposeGcpMcp', 'exposeJiraMcp', 'exposeLinearMcp'] as const

/** github.com/org/repo, however the remote was written (https, ssh, with or without .git). */
export function normalizeRemote(remote: string): string {
  let r = remote.trim()
  r = r.replace(/^git@([^:]+):/, '$1/').replace(/^ssh:\/\/(?:[^@]+@)?/, '').replace(/^https?:\/\/(?:[^@]+@)?/, '').replace(/^git:\/\//, '')
  r = r.replace(/\.git$/, '').replace(/\/+$/, '')
  return r.toLowerCase()
}
async function remoteOf(path: string): Promise<string | null> {
  try {
    const remotes = await gitSvc.git(path).getRemotes(true)
    const origin = remotes.find((x) => x.name === 'origin') ?? remotes[0]
    return origin?.refs.fetch || origin?.refs.push || null
  } catch {
    return null
  }
}
const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

function space(id: string): Space {
  const s = getStore().get().spaces.find((x) => x.id === id)
  if (!s) throw new Error('Unknown space')
  return s
}

/** What the file would contain for a space right now. */
export async function definitionFor(spaceId: string): Promise<SpaceDefinition> {
  const s = space(spaceId)
  const repos: SharedRepo[] = []
  for (const r of getStore().get().repos.filter((x) => x.spaceId === spaceId)) {
    const remote = await remoteOf(r.path)
    if (!remote) throw new Error(`${r.name} has no git remote, so a teammate could not fetch it. Push it somewhere first.`)
    repos.push({ remote, name: r.name, defaultBranch: r.defaultBranch })
  }
  const settings: SharedSpaceSettings = {}
  for (const k of SHARED_KEYS) if (s[k] !== undefined) (settings as Record<string, unknown>)[k] = s[k]
  // MCP servers travel without their headers and env: those are where API keys live.
  if (s.mcpServers?.length) settings.mcpServers = s.mcpServers.map(({ headers: _h, env: _e, ...rest }) => rest)
  if (s.jira?.siteUrl || s.jira?.defaultJql) settings.jira = { siteUrl: s.jira.siteUrl, defaultJql: s.jira.defaultJql }
  if (s.linear?.defaultQuery) settings.linear = { defaultQuery: s.linear.defaultQuery }
  if (s.gcp?.projectId) settings.gcp = { projectId: s.gcp.projectId, ...(s.gcp.region ? { region: s.gcp.region } : {}) }
  if (s.oncall) {
    const { enabled, channels, pollSeconds, model, maxTriagesPerHour, context } = s.oncall
    settings.oncall = { enabled, channels, pollSeconds, maxTriagesPerHour, context, ...(model ? { model } : {}) }
  }
  const orgId = cloud.state().account?.orgs.find((o) => o.plan === 'team')?.id
  return { sinfonie: 1, name: s.name, color: s.color, ...(orgId ? { orgId } : {}), updatedAt: new Date().toISOString(), repos, settings }
}

/** Writes the definition into a repository of the space and remembers the link. Committing it is the user's normal flow. */
export async function exportSpace(spaceId: string, repoId: string): Promise<{ file: string }> {
  cloud.assertFeature('sharedSpaces')
  const repo = getStore().get().repos.find((r) => r.id === repoId && r.spaceId === spaceId)
  if (!repo) throw new Error('Pick a repository that belongs to this space.')
  const def = await definitionFor(spaceId)
  const text = JSON.stringify(def, null, 2) + '\n'
  const file = join(repo.path, SPACE_FILE)
  writeFileSync(file, text)
  getStore().update((d) => {
    const s = d.spaces.find((x) => x.id === spaceId)
    if (s) s.shared = { file, hash: hashOf(text), repoId, appliedAt: new Date().toISOString() }
  })
  return { file }
}

function parse(file: string): { def: SpaceDefinition; text: string } {
  if (!existsSync(file)) throw new Error(`${file} does not exist.`)
  const text = readFileSync(file, 'utf8')
  let def: SpaceDefinition
  try {
    def = JSON.parse(text) as SpaceDefinition
  } catch {
    throw new Error(`${basename(file)} is not valid JSON.`)
  }
  if (def.sinfonie !== 1 || typeof def.name !== 'string' || !Array.isArray(def.repos)) throw new Error(`${basename(file)} is not a Sinfonie space definition.`)
  for (const r of def.repos) if (typeof r.remote !== 'string' || typeof r.name !== 'string') throw new Error(`${basename(file)} lists a repository without a remote.`)
  def.settings = def.settings ?? {}
  return { def, text }
}

/** Which of the definition's repositories are already on this Mac, by remote. */
export async function previewImport(file: string): Promise<SpaceImportPreview> {
  const { def } = parse(file)
  const known = getStore().get().repos
  const byRemote = new Map<string, Repo>()
  for (const r of known) {
    const remote = await remoteOf(r.path)
    if (remote) byRemote.set(normalizeRemote(remote), r)
  }
  const existing = getStore().get().spaces.find((s) => s.shared?.file === file)
  return {
    file,
    definition: def,
    existingSpaceId: existing?.id,
    repos: def.repos.map((r) => {
      const m = byRemote.get(normalizeRemote(r.remote))
      return { remote: r.remote, name: r.name, defaultBranch: r.defaultBranch || 'main', ...(m ? { match: { repoId: m.id, path: m.path, spaceId: m.spaceId } } : {}) }
    })
  }
}

async function ensureRepo(path: string, spaceId: string, name: string): Promise<Repo> {
  const existing = getStore().get().repos.find((r) => r.path === path)
  if (existing) {
    getStore().update((d) => {
      const r = d.repos.find((x) => x.id === existing.id)
      if (r) r.spaceId = spaceId
    })
    return existing
  }
  if (!(await gitSvc.isGitRepo(path))) throw new Error(`${path} is not the root of a git repository.`)
  const repo: Repo = { id: nanoid(8), name: name || basename(path), path, defaultBranch: await gitSvc.detectDefaultBranch(path), config: gitSvc.readConductorConfig(path), addedAt: new Date().toISOString(), spaceId }
  getStore().update((d) => d.repos.push(repo))
  return repo
}

function applySettings(s: Space, settings: SharedSpaceSettings): void {
  const target = s as unknown as Record<string, unknown>
  for (const k of SHARED_KEYS) {
    if (settings[k] === undefined) delete target[k]
    else target[k] = settings[k]
  }
  // Keep whatever headers/env the user already had for a server with the same id; the file never carries them.
  if (settings.mcpServers) {
    const mine = new Map((s.mcpServers ?? []).map((m) => [m.id, m]))
    s.mcpServers = settings.mcpServers.map((m) => ({ ...m, headers: mine.get(m.id)?.headers, env: mine.get(m.id)?.env }))
  } else delete s.mcpServers
  if (settings.jira) s.jira = { connected: false, email: '', hasToken: false, ...(s.jira ?? {}), siteUrl: settings.jira.siteUrl, defaultJql: settings.jira.defaultJql }
  if (settings.linear) s.linear = { connected: false, ...(s.linear ?? {}), defaultQuery: settings.linear.defaultQuery }
  if (settings.gcp) s.gcp = { ...(s.gcp ?? {}), projectId: settings.gcp.projectId, region: settings.gcp.region }
  if (settings.oncall) s.oncall = { ...(s.oncall ?? {}), ...settings.oncall }
}

/** Creates (or refreshes) the space from a definition file, locating or cloning each repository as resolved. */
export async function importSpace(file: string, resolutions: SpaceImportResolution[], opts: { skipMissing?: boolean; onProgress?: (msg: string) => void } = {}): Promise<Space> {
  const onProgress = opts.onProgress
  cloud.assertFeature('sharedSpaces')
  const preview = await previewImport(file)
  const { def, text } = parse(file)
  const byRemote = new Map(resolutions.map((r) => [normalizeRemote(r.remote), r]))
  let spaceId = preview.existingSpaceId
  if (!spaceId) {
    spaceId = nanoid(6)
    const color = def.color && SPACE_COLORS.includes(def.color) ? def.color : SPACE_COLORS[getStore().get().spaces.length % SPACE_COLORS.length]
    getStore().update((d) => d.spaces.push({ id: spaceId as string, name: def.name, color, createdAt: new Date().toISOString() }))
  }
  for (const r of preview.repos) {
    if (r.match) {
      await ensureRepo(r.match.path, spaceId, r.name)
      continue
    }
    const res = byRemote.get(normalizeRemote(r.remote))
    if (res?.path) {
      await ensureRepo(res.path, spaceId, r.name)
    } else if (res?.cloneInto) {
      const dest = join(res.cloneInto, r.name)
      if (existsSync(dest)) throw new Error(`${dest} already exists. Pick that folder as the checkout instead of cloning.`)
      onProgress?.(`Cloning ${r.name}…`)
      mkdirSync(dirname(dest), { recursive: true })
      await simpleGit().clone(r.remote, dest)
      await ensureRepo(dest, spaceId, r.name)
    } else if (!opts.skipMissing) {
      throw new Error(`Say where ${r.name} is, or where to clone it.`)
    }
  }
  const hash = hashOf(text)
  getStore().update((d) => {
    const s = d.spaces.find((x) => x.id === spaceId)
    if (!s) return
    s.name = def.name
    if (def.color && SPACE_COLORS.includes(def.color)) s.color = def.color
    applySettings(s, def.settings)
    s.shared = { file, hash, repoId: s.shared?.repoId, appliedAt: new Date().toISOString() }
  })
  return space(spaceId)
}

/** Spaces whose definition file changed since it was last applied (or vanished). */
export function pendingUpdates(): { spaceId: string; file: string; missing: boolean; changed: boolean }[] {
  const out: { spaceId: string; file: string; missing: boolean; changed: boolean }[] = []
  for (const s of getStore().get().spaces) {
    if (!s.shared) continue
    if (!existsSync(s.shared.file)) {
      out.push({ spaceId: s.id, file: s.shared.file, missing: true, changed: false })
      continue
    }
    const changed = hashOf(readFileSync(s.shared.file, 'utf8')) !== s.shared.hash
    if (changed) out.push({ spaceId: s.id, file: s.shared.file, missing: false, changed })
  }
  return out
}

/** Re-applies the file a space follows: settings and any repositories already on this Mac. New repos need the import flow. */
export async function applyUpdate(spaceId: string): Promise<Space> {
  const s = space(spaceId)
  if (!s.shared) throw new Error('This space does not follow a shared definition.')
  return importSpace(s.shared.file, [], { skipMissing: true })
}

/** Stop following the file; the space keeps everything it has. */
export function unlink(spaceId: string): Space {
  getStore().update((d) => {
    const s = d.spaces.find((x) => x.id === spaceId)
    if (s) delete s.shared
  })
  return space(spaceId)
}
