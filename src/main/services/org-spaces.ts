/**
 * Spaces shared inside an organisation. The definition (repos by remote, crew, integrations without
 * secrets, defaults) lives on sinfonie.dev under the organisation; every member pulls it at launch
 * and after each account refresh, and a member's local edits push back, last write wins with a
 * version number so a stale push is refused rather than clobbering a teammate's change.
 * Accounts, tokens, local paths, workspaces and chats never travel.
 */
import { nanoid } from 'nanoid'
import { dirname, join } from 'path'
import { getStore } from '../store'
import * as cloud from './cloud'
import { logError } from './telemetry'
import { definitionFor, applySettings, ensureRepo, normalizeRemote, remoteOf } from './shared-space'
import { PLAIN_ERROR_MARK, SPACE_COLORS } from '@shared/types'
import type { RepoCloneError, OrgSpace, SharedRepo, Space, SpaceDefinition, SpaceImportResolution, TeammateWorkspace, Workspace } from '@shared/types'
import * as workspaces from './workspaces'
import { cloneRepo, ensureIdentity, githubNameWithOwner } from './prereqs'

const enc = encodeURIComponent

function space(id: string): Space {
  const s = getStore().get().spaces.find((x) => x.id === id)
  if (!s) throw new Error('Unknown space')
  return s
}

/**
 * A sinfonie.dev failure in words for the person (PLAIN_ERROR_MARK, so guided mode shows it as is). `what` completes
 * "could not …", e.g. "share this space". Messages already written for people pass through.
 */
export function plainCloudError(err: unknown, what: string): Error {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.startsWith(PLAIN_ERROR_MARK)) return err instanceof Error ? err : new Error(msg)
  const status = (err as { status?: number } | null)?.status
  const why =
    status === 401
      ? 'Your Sinfonie sign-in has expired. Sign in again, then try again.'
      : status === 403
        ? 'Only an admin of the organisation can do this.'
        : status === 404
          ? 'The organisation or the shared copy no longer exists on sinfonie.dev.'
          : status === 402 || /plan|limit|seat/i.test(msg)
            ? `${msg.replace(/\.$/, '')}.`
            : status && status >= 500
              ? 'sinfonie.dev had a problem on its side. Try again in a minute.'
              : /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|aborted|network/i.test(msg)
                ? 'Sinfonie could not reach sinfonie.dev. Check your connection and try again.'
                : /updated this space since/i.test(msg)
                  ? msg
                  : `sinfonie.dev said: ${msg}`
  return new Error(`${PLAIN_ERROR_MARK}Could not ${what}. ${why}`)
}

/** Share a space in an organisation, or push its current definition when it already is. */
export async function publish(spaceId: string, orgId: string): Promise<Space> {
  try {
    return await publishRaw(spaceId, orgId)
  } catch (err) {
    // The stale-version case already explains itself in plain words.
    if (err instanceof Error && /A teammate updated this space since your last sync/.test(err.message)) throw new Error(PLAIN_ERROR_MARK + err.message)
    throw Object.assign(plainCloudError(err, 'share this space with the team'), { status: (err as { status?: number }).status, cause: err })
  }
}
async function publishRaw(spaceId: string, orgId: string): Promise<Space> {
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
  // Each app on its own: one that cannot be downloaded (private, no access, offline) never stops the others. The
  // failure is kept per app on the space (cloneErrors), so the team card can say why and offer the one fix.
  const failures: string[] = []
  for (const res of resolutions) {
    const r = wanted.find((w) => normalizeRemote(w.remote) === normalizeRemote(res.remote))
    if (!r) continue
    try {
      if (res.path) await ensureRepo(res.path, spaceId, r.name, { displayName: r.displayName, description: r.description })
      else if (res.cloneInto) {
        let out = await cloneRepo(r.remote, join(res.cloneInto, r.name))
        // Another app already sits in that folder: use a second name instead of asking.
        if (!out.ok && out.kind === 'folder-exists') {
          const owner = githubNameWithOwner(r.remote)?.split('/')[0] ?? 'team'
          out = await cloneRepo(r.remote, join(res.cloneInto, `${r.name}-${owner}`))
        }
        if (!out.ok) {
          recordCloneError(spaceId, { remote: r.remote, name: r.displayName || r.name, kind: out.kind, message: out.message, at: new Date().toISOString() })
          failures.push(`${r.name}: ${out.message}`)
          continue
        }
        await ensureIdentity(out.path).catch(() => undefined)
        await ensureRepo(out.path, spaceId, r.name, { displayName: r.displayName, description: r.description })
      } else continue
      recordCloneError(spaceId, null, r.remote)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // The team card shows this to builders: plain words; the raw text goes to the log.
      logError('org-spaces.resolve', err, { spaceId, remote: r.remote })
      recordCloneError(spaceId, { remote: r.remote, name: r.displayName || r.name, kind: 'other', message: 'Sinfonie could not add this app. Try again, or ask a teammate.', at: new Date().toISOString() })
      failures.push(`${r.name}: ${message}`)
    }
  }
  if (failures.length) throw new Error(failures.join('\n'))
  return space(spaceId)
}

/** Keep (or clear, with null) the download failure of one shared app on its space. */
function recordCloneError(spaceId: string, entry: RepoCloneError | null, remote = entry?.remote ?? ''): void {
  getStore().update((d) => {
    const sp = d.spaces.find((x) => x.id === spaceId)
    if (!sp) return
    const rest = (sp.cloneErrors ?? []).filter((e) => normalizeRemote(e.remote) !== normalizeRemote(remote))
    const next = entry ? [...rest, entry] : rest
    if (next.length) sp.cloneErrors = next
    else delete sp.cloneErrors
  })
}

/**
 * "Check again" on the team card: re-ask the server (so a new membership or newly shared apps arrive), then try
 * every shared app that is still missing on this Mac again, each on its own.
 */
export async function retryMissing(): Promise<void> {
  await cloud.refresh()
  await sync()
  const into = join(dirname(getStore().get().settings.workspacesRoot), 'repos')
  for (const sp of getStore().get().spaces.filter((x) => x.orgSpace && x.orgId)) {
    const gone = await missing(sp.id).catch(() => [])
    // Apps found on this Mac since the last try: their old failure no longer applies.
    for (const e of sp.cloneErrors ?? []) if (!gone.some((g) => normalizeRemote(g.remote) === normalizeRemote(e.remote))) recordCloneError(sp.id, null, e.remote)
    if (!gone.length) continue
    await resolve(sp.id, gone.map((g) => ({ remote: g.remote, cloneInto: into }))).catch((err) => logError('org-spaces.retry', err, { spaceId: sp.id }))
  }
}

/** Stop syncing. The space stays on this Mac and becomes personal; `deleteRemote` also removes the server copy. */
export async function unshare(spaceId: string, deleteRemote = false): Promise<Space> {
  const s = space(spaceId)
  // Removing for everyone must really remove it: a failed DELETE stops here, before the space is unlinked, so the
  // person can try again instead of believing teammates lost it while the server copy lives on. Already gone is fine.
  if (deleteRemote && s.orgSpace && s.orgId)
    await cloud.api(`/api/orgs/${enc(s.orgId)}/spaces/${enc(s.orgSpace.id)}`, { method: 'DELETE' }).catch((err) => {
      if ((err as { status?: number }).status === 404) return
      throw plainCloudError(err, 'remove the space for everyone, so it is still shared')
    })
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
      void publish(spaceId, s.orgId as string).catch((err) => {
        console.error('[org-spaces] push failed', err instanceof Error ? err.message : err)
        // Remembered on the space so the app can say "Not shared yet" with a Retry; the next successful publish clears it.
        const text = (err instanceof Error ? err.message : String(err)).replace(PLAIN_ERROR_MARK, '')
        getStore().update((d) => {
          const sp = d.spaces.find((x) => x.id === spaceId)
          if (sp?.orgSpace) sp.orgSpace.pushError = text
        })
      })
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
    if (m) await ensureRepo(m.path, spaceId, r.name, { displayName: r.displayName, description: r.description })
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
  // A guided user never sees "Locate or clone": the team's apps are cloned next to the workspaces folder.
  if (getStore().get().settings.mode === 'guided' && out.missingRepos.length) {
    const into = join(dirname(getStore().get().settings.workspacesRoot), 'repos')
    for (const m of out.missingRepos) {
      await resolve(m.spaceId, m.remotes.map((remote) => ({ remote, cloneInto: into }))).catch((err) => logError('org-spaces.clone', err, { spaceId: m.spaceId }))
    }
    out.missingRepos = []
  }
  return out
}

// ---------- presence: what I work on, what teammates work on ----------

/** The rows this Mac publishes for one shared space: live workspaces, names, branches, stage, times. */
function presenceOf(space: Space): Record<string, unknown>[] {
  return getStore()
    .get()
    .workspaces.filter((w) => w.spaceId === space.id && w.status !== 'archived')
    .map((w) => ({
      workspaceId: w.id,
      name: w.name,
      slug: w.slug,
      stage: w.stage,
      status: w.status,
      repos: w.repos.map((r) => ({ name: r.repoName, branch: r.branch })),
      ticket: w.jira?.key ?? w.linear?.identifier,
      lastActivityAt: w.lastMessageAt ?? w.createdAt
    }))
}
let lastPublished = ''
/** Push presence for every shared space, only when it changed since the last push. */
export async function publishPresence(force = false): Promise<void> {
  if (!cloud.hasSession()) return
  const shared = getStore().get().spaces.filter((s) => s.orgSpace && s.orgId)
  const payload = JSON.stringify(shared.map((s) => [s.orgSpace?.id, presenceOf(s)]))
  if (!force && payload === lastPublished) return
  for (const s of shared) {
    await cloud.api(`/api/orgs/${enc(s.orgId as string)}/spaces/${enc(s.orgSpace?.id as string)}/workspaces`, cloud.jsonInit('PUT', { workspaces: presenceOf(s) })).catch(() => undefined)
  }
  lastPublished = payload
}
let presenceTimer: NodeJS.Timeout | null = null
export function presenceSoon(): void {
  if (presenceTimer) clearTimeout(presenceTimer)
  presenceTimer = setTimeout(() => void publishPresence(), 5_000)
}

export async function teammates(spaceId: string): Promise<TeammateWorkspace[]> {
  const s = space(spaceId)
  if (!s.orgSpace || !s.orgId) return []
  return (await cloud.api<{ workspaces: TeammateWorkspace[] }>(`/api/orgs/${enc(s.orgId)}/spaces/${enc(s.orgSpace.id)}/workspaces`)).workspaces
}

/** Recreate a teammate's workspace here: same branch in the same repositories, checked out from origin when they pushed. */
export async function openTeammate(spaceId: string, remote: TeammateWorkspace, emit: Parameters<typeof workspaces.createWorkspace>[1]): Promise<Workspace> {
  const s = space(spaceId)
  const mine = getStore().get().repos.filter((r) => r.spaceId === s.id)
  const repos = remote.repos
    .map((rr) => {
      const local = mine.find((r) => r.name === rr.name)
      return local ? { repoId: local.id, baseBranch: local.defaultBranch } : null
    })
    .filter((x): x is { repoId: string; baseBranch: string } => Boolean(x))
  if (!repos.length) throw new Error(`None of ${remote.user.login}'s repositories for this workspace is on this Mac yet. Locate or clone them from the space's Repositories page first.`)
  const branch = remote.repos[0]?.branch || remote.slug
  return workspaces.createWorkspace({ name: remote.name, branch, repos, primaryRepoId: repos[0].repoId, spaceId: s.id, claudeAccountId: s.claudeAccountId ?? getStore().get().settings.defaultClaudeAccountId }, emit)
}

let timer: NodeJS.Timeout | null = null
export function start(): void {
  if (timer) return
  cloud.onRefreshed(() => void sync().then(() => publishPresence(true)).catch(() => undefined))
  timer = setInterval(() => void sync().then(() => publishPresence()).catch(() => undefined), 6 * 3600_000)
  setInterval(() => void publishPresence(), 5 * 60_000)
  getStore().subscribe(() => presenceSoon())
}
