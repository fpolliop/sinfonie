/**
 * Spaces shared inside an organisation. The definition (repos by remote, crew, integrations without
 * secrets, defaults) lives on sinfonie.dev under the organisation; every member pulls it at launch
 * and after each account refresh, and a member's local edits push back, last write wins with a
 * version number so a stale push is refused rather than clobbering a teammate's change.
 * Accounts, tokens, local paths, workspaces and chats never travel.
 */
import { nanoid } from 'nanoid'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { simpleGit } from 'simple-git'
import { getStore } from '../store'
import * as cloud from './cloud'
import { definitionFor, applySettings, ensureRepo, normalizeRemote, remoteOf } from './shared-space'
import { SPACE_COLORS } from '@shared/types'
import type { OrgSpace, SharedRepo, Space, SpaceDefinition, SpaceImportResolution } from '@shared/types'

const enc = encodeURIComponent

function space(id: string): Space {
  const s = getStore().get().spaces.find((x) => x.id === id)
  if (!s) throw new Error('Unknown space')
  return s
}

/** Share a space in an organisation, or push its current definition when it already is. */
export async function publish(spaceId: string, orgId: string): Promise<Space> {
  const s = space(spaceId)
  const def = await definitionFor(spaceId)
  def.orgId = orgId
  let remote: OrgSpace
  if (s.orgSpace && s.orgId === orgId) {
    try {
      remote = await cloud.api<OrgSpace>(`/api/orgs/${enc(orgId)}/spaces/${enc(s.orgSpace.id)}`, cloud.jsonInit('PUT', { name: s.name, definition: def, version: s.orgSpace.version }))
    } catch (err) {
      // Stale: a teammate changed it. Take theirs, then the user can re-apply and push again.
      if (err instanceof Error && /updated this space since/.test(err.message)) {
        await sync()
        throw new Error('A teammate updated this space since your last sync. Their version was applied; check it and share again.')
      }
      throw err
    }
  } else {
    remote = await cloud.api<OrgSpace>(`/api/orgs/${enc(orgId)}/spaces`, cloud.jsonInit('POST', { id: s.orgSpace?.id, name: s.name, definition: def }))
  }
  getStore().update((d) => {
    const sp = d.spaces.find((x) => x.id === spaceId)
    if (!sp) return
    sp.orgId = orgId
    sp.orgSpace = { id: remote.id, version: remote.version, syncedAt: new Date().toISOString(), updatedBy: remote.updatedBy, repos: def.repos }
    d.settings.ignoredOrgSpaces = (d.settings.ignoredOrgSpaces ?? []).filter((id) => id !== remote.id)
  })
  return space(spaceId)
}

/** The shared space's repositories that are not on this Mac (by remote). */
export async function missing(spaceId: string): Promise<SharedRepo[]> {
  const s = space(spaceId)
  const wanted = s.orgSpace?.repos ?? []
  if (!wanted.length) return []
  const have = new Set<string>()
  for (const r of getStore().get().repos.filter((x) => x.spaceId === spaceId)) {
    const remote = await remoteOf(r.path)
    if (remote) have.add(normalizeRemote(remote))
  }
  return wanted.filter((r) => !have.has(normalizeRemote(r.remote)))
}

/** Locate (existing checkout) or clone the missing repositories, then attach them to the space. */
export async function resolve(spaceId: string, resolutions: SpaceImportResolution[]): Promise<Space> {
  const wanted = await missing(spaceId)
  for (const res of resolutions) {
    const r = wanted.find((w) => normalizeRemote(w.remote) === normalizeRemote(res.remote))
    if (!r) continue
    if (res.path) await ensureRepo(res.path, spaceId, r.name)
    else if (res.cloneInto) {
      const dest = join(res.cloneInto, r.name)
      if (existsSync(dest)) throw new Error(`${dest} already exists. Pick that folder as the checkout instead of cloning.`)
      mkdirSync(dirname(dest), { recursive: true })
      await simpleGit().clone(r.remote, dest)
      await ensureRepo(dest, spaceId, r.name)
    }
  }
  return space(spaceId)
}

/** Stop syncing. The space stays on this Mac and becomes personal; `deleteRemote` also removes the server copy. */
export async function unshare(spaceId: string, deleteRemote = false): Promise<Space> {
  const s = space(spaceId)
  if (deleteRemote && s.orgSpace && s.orgId) await cloud.api(`/api/orgs/${enc(s.orgId)}/spaces/${enc(s.orgSpace.id)}`, { method: 'DELETE' }).catch(() => undefined)
  getStore().update((d) => {
    const sp = d.spaces.find((x) => x.id === spaceId)
    if (!sp) return
    if (sp.orgSpace && !deleteRemote) d.settings.ignoredOrgSpaces = [...new Set([...(d.settings.ignoredOrgSpaces ?? []), sp.orgSpace.id])]
    delete sp.orgSpace
    delete sp.orgId
  })
  return space(spaceId)
}

let pushTimers = new Map<string, NodeJS.Timeout>()
/** Called after a space or its repos changed: push the definition a little later, folding bursts of edits. */
export function pushSoon(spaceId: string): void {
  const s = getStore().get().spaces.find((x) => x.id === spaceId)
  if (!s?.orgSpace || !s.orgId || !cloud.hasSession()) return
  const t = pushTimers.get(spaceId)
  if (t) clearTimeout(t)
  pushTimers.set(
    spaceId,
    setTimeout(() => {
      pushTimers.delete(spaceId)
      void publish(spaceId, s.orgId as string).catch((err) => console.error('[org-spaces] push failed', err instanceof Error ? err.message : err))
    }, 2000)
  )
}

/** Apply a server definition to a local space: name, colour, settings, and the repos already on this Mac. Returns remotes still missing. */
async function applyDefinition(spaceId: string, def: SpaceDefinition): Promise<string[]> {
  const byRemote = new Map<string, { id: string; path: string }>()
  for (const r of getStore().get().repos) {
    const remote = await remoteOf(r.path)
    if (remote) byRemote.set(normalizeRemote(remote), { id: r.id, path: r.path })
  }
  const missing: string[] = []
  for (const r of def.repos) {
    const m = byRemote.get(normalizeRemote(r.remote))
    if (m) await ensureRepo(m.path, spaceId, r.name)
    else missing.push(r.remote)
  }
  getStore().update((d) => {
    const s = d.spaces.find((x) => x.id === spaceId)
    if (!s) return
    s.name = def.name
    if (def.color && SPACE_COLORS.includes(def.color)) s.color = def.color
    applySettings(s, def.settings ?? {})
  })
  return missing
}

/** Pull every organisation's shared spaces into local spaces. */
export async function sync(): Promise<{ created: string[]; updated: string[]; missingRepos: { spaceId: string; remotes: string[] }[] }> {
  const out = { created: [] as string[], updated: [] as string[], missingRepos: [] as { spaceId: string; remotes: string[] }[] }
  const account = cloud.state().account
  if (!account || !cloud.hasSession()) return out
  const seen = new Set<string>()
  for (const org of account.orgs) {
    let remotes: OrgSpace[]
    try {
      remotes = (await cloud.api<{ spaces: OrgSpace[] }>(`/api/orgs/${enc(org.id)}/spaces`)).spaces
    } catch {
      continue
    }
    const ignored = new Set(getStore().get().settings.ignoredOrgSpaces ?? [])
    for (const r of remotes) {
      seen.add(r.id)
      if (ignored.has(r.id)) continue
      const local = getStore().get().spaces.find((s) => s.orgSpace?.id === r.id)
      if (local && local.orgSpace && local.orgSpace.version >= r.version) continue
      let spaceId = local?.id
      if (!spaceId) {
        spaceId = nanoid(6)
        const color = r.definition.color && SPACE_COLORS.includes(r.definition.color) ? r.definition.color : SPACE_COLORS[getStore().get().spaces.length % SPACE_COLORS.length]
        getStore().update((d) => d.spaces.push({ id: spaceId as string, name: r.name, color, createdAt: new Date().toISOString(), orgId: org.id }))
        out.created.push(spaceId)
      } else out.updated.push(spaceId)
      const missing = await applyDefinition(spaceId, r.definition)
      if (missing.length) out.missingRepos.push({ spaceId, remotes: missing })
      getStore().update((d) => {
        const s = d.spaces.find((x) => x.id === spaceId)
        if (s) {
          s.orgId = org.id
          s.orgSpace = { id: r.id, version: r.version, syncedAt: new Date().toISOString(), updatedBy: r.updatedBy, repos: r.definition.repos }
        }
      })
    }
  }
  // Shared spaces that vanished on the server (or from organisations we left) become personal again.
  const orgIds = new Set(account.orgs.map((o) => o.id))
  getStore().update((d) => {
    for (const s of d.spaces) {
      if (!s.orgSpace) continue
      if (!seen.has(s.orgSpace.id) && (!s.orgId || orgIds.has(s.orgId))) {
        delete s.orgSpace
        delete s.orgId
      }
    }
  })
  return out
}

let timer: NodeJS.Timeout | null = null
export function start(): void {
  if (timer) return
  cloud.onRefreshed(() => void sync().catch(() => undefined))
  timer = setInterval(() => void sync().catch(() => undefined), 6 * 3600_000)
}
