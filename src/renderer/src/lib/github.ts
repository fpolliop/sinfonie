/**
 * The GitHub connection, shared by every screen that needs it (setup, Send for review, Pull requests, team apps):
 * what this Mac has (git, the GitHub tool, a sign-in) and where an in-app "Connect GitHub" stands. Main owns the
 * truth (services/prereqs.ts); this keeps one copy for the renderer and follows `github:connectProgress`.
 *
 * Reuse: `const gh = useGitHubConnection()` then `gh.connection?.signedIn`, `gh.connect()`, `gh.refresh()`, or
 * drop in <ConnectGitHubCard /> from components/ConnectGitHub.tsx.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '@/lib/api'
import type { GitHubConnectState, GitHubConnection } from '@shared/types'

interface GitHubStore {
  connection: GitHubConnection | null
  state: GitHubConnectState
  loading: boolean
  /** Re-check git, the GitHub tool and the sign-in. */
  refresh: () => Promise<GitHubConnection | null>
  /** Start Connect GitHub (installs the tool when needed, then the browser sign-in with a one-time code). */
  connect: () => Promise<void>
  cancel: () => Promise<void>
}

let subscribed = false

const useStore = create<GitHubStore>((set, get) => ({
  connection: null,
  state: { phase: 'idle' },
  loading: false,
  refresh: async () => {
    set({ loading: true })
    try {
      const connection = await api.invoke('github:connection', true)
      set({ connection })
      return connection
    } catch {
      return get().connection
    } finally {
      set({ loading: false })
    }
  },
  connect: async () => {
    set({ state: { phase: 'checking' } })
    await api.invoke('github:connect')
  },
  cancel: async () => {
    await api.invoke('github:cancelConnect')
  }
}))

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  api.on('github:connectProgress', (state) => {
    useStore.setState({ state })
    // Connected (or it failed for a missing piece): the connection itself changed, so ask again.
    if (state.phase === 'done' || state.phase === 'failed') void useStore.getState().refresh()
  })
  void api
    .invoke('github:connectState')
    .then((state) => useStore.setState({ state }))
    .catch(() => undefined)
}

/** The GitHub connection and Connect GitHub, checked once when first used. */
export function useGitHubConnection(): GitHubStore {
  const store = useStore()
  useEffect(() => {
    subscribe()
    if (!useStore.getState().connection && !useStore.getState().loading) void useStore.getState().refresh()
  }, [])
  return store
}

/** Outside React (a submit handler): the latest connection, checked now. */
export const checkGitHub = (): Promise<GitHubConnection | null> => useStore.getState().refresh()

/** A gh / git error that means "connect GitHub" rather than a real failure (lib/errors.ts routes these here). */
export const GITHUB_AUTH_RE = /gh auth login|not logged in to github|github\.com.*(authentication|403|401)|could not read Username|Authentication failed for 'https:\/\/github|terminal prompts disabled|Repository not found|gh: command not found|spawn gh ENOENT|ENOENT.*\bgh\b|Permission to [\w.-]+\/[\w.-]+ denied|Permission denied \(publickey\)|Could not read from remote repository|git-credential|HTTP 40[13]/i
