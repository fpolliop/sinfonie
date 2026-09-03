import { create } from 'zustand'
import type { ScriptOutputEvent } from '@shared/types'
import { api } from '@/lib/api'
import { stripAnsi } from '@/lib/format'

interface ScriptRun {
  output: string
  running: boolean
  exitCode?: number | null
}

interface ScriptsState {
  runs: Record<string, ScriptRun>
  key: (workspaceId: string, repoId: string, kind: string) => string
  subscribe: () => void
  clear: (workspaceId: string, repoId: string, kind: string) => void
}

export const useScripts = create<ScriptsState>((set, get) => ({
  runs: {},
  key: (w, r, k) => `${w}:${r}:${k}`,
  subscribe: () => {
    api.on('script:output', (e: ScriptOutputEvent) => {
      const k = get().key(e.workspaceId, e.repoId, e.kind)
      set((s) => {
        const prev = s.runs[k] ?? { output: '', running: true }
        const output = (prev.output + stripAnsi(e.data).replace(/\r\n/g, '\n')).slice(-200_000)
        return { runs: { ...s.runs, [k]: { output, running: !e.done, exitCode: e.done ? e.exitCode : prev.exitCode } } }
      })
    })
  },
  clear: (w, r, k) => set((s) => ({ runs: { ...s.runs, [get().key(w, r, k)]: { output: '', running: false } } }))
}))
