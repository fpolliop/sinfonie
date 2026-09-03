import { create } from 'zustand'
import type { RepoPr } from '@shared/types'
import { api } from '@/lib/api'

interface GithubState {
  byWorkspace: Record<string, { repos: RepoPr[]; loading: boolean; error?: string; fetchedAt?: string }>
  refresh: (workspaceId: string) => Promise<void>
}

export const useGithub = create<GithubState>((set, get) => ({
  byWorkspace: {},
  refresh: async (id) => {
    if (get().byWorkspace[id]?.loading) return
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [id]: { repos: s.byWorkspace[id]?.repos ?? [], loading: true } } }))
    try {
      const repos = await api.invoke('github:status', id)
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [id]: { repos, loading: false, fetchedAt: new Date().toISOString() } } }))
    } catch (err) {
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [id]: { repos: s.byWorkspace[id]?.repos ?? [], loading: false, error: err instanceof Error ? err.message : String(err) } } }))
    }
  }
}))
