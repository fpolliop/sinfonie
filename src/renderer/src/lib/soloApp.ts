/**
 * The solo path for guided users: an app that is not shared by a team. Picks or fetches the app, puts it in a
 * personal space ("My apps", created on first use, never shared) and returns it, so New task works without a team.
 */
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import type { Repo } from '@shared/types'

export const PERSONAL_SPACE_NAME = 'My apps'

/** The personal space for solo apps: an existing unshared "My apps", else a new one. */
export async function ensurePersonalSpace(): Promise<string> {
  const { spaces } = useApp.getState()
  const existing = spaces.find((s) => !s.orgId && s.name === PERSONAL_SPACE_NAME)
  if (existing) return existing.id
  const sp = await api.invoke('spaces:create', PERSONAL_SPACE_NAME)
  return sp.id
}

/** Ask for the app's folder on this Mac. Null when the person cancels. */
export async function pickAppFolder(): Promise<string | null> {
  return api.invoke('dialog:pickFolder', 'Choose the folder your app is in')
}

/** Accepts "owner/name", a github.com page link or a clone link. Null when it does not look like one. */
export function normalizeGithubLink(input: string): string | null {
  const t = input.trim().replace(/\/+$/, '')
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) return `https://github.com/${t}.git`
  const m = t.match(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i) ?? t.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)
  return m ? `https://github.com/${m[1]}/${m[2]}.git` : null
}

/** Add an app to the personal space, from a folder on this Mac or a GitHub link. Returns the app and its space. */
export async function addSoloApp(source: { path: string } | { github: string }): Promise<{ repo: Repo; spaceId: string }> {
  let path: string
  if ('path' in source) path = source.path
  else {
    const url = normalizeGithubLink(source.github)
    if (!url) throw new Error('That does not look like a GitHub link. Copy the address of the app’s GitHub page and paste it here.')
    path = await api.invoke('repos:clone', url)
  }
  const spaceId = await ensurePersonalSpace()
  const [repo] = await api.invoke('repos:addPaths', [path], spaceId)
  return { repo, spaceId }
}
