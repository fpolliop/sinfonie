import { create } from 'zustand'
import { api } from '@/lib/api'
import type { UpdateInfo } from '@shared/types'

const DISMISSED_KEY = 'orchestra.dismissedUpdate'

interface UpdatesState {
  /** The update this app run knows about, kept in step with main's update:available events. */
  info: UpdateInfo | null
  /** The version the person put off with Later (an offer of that version stays quiet). */
  dismissed: string | null
  dismiss: (version: string) => void
  /** Listen once for the whole app, and read what main already knows (an update found before the renderer loaded). */
  subscribe: () => void
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

let subscribed = false

export const useUpdates = create<UpdatesState>((set) => ({
  info: null,
  dismissed: readDismissed(),
  dismiss: (version) => {
    try {
      localStorage.setItem(DISMISSED_KEY, version)
    } catch {
      /* it just shows again next launch */
    }
    set({ dismissed: version })
  },
  subscribe: () => {
    if (subscribed) return
    subscribed = true
    api.on('update:available', (info) => set({ info }))
    void api
      .invoke('updates:latest')
      .then((u) => u && set((s) => ({ info: s.info ?? u })))
      .catch(() => undefined)
  }
}))

/** Whether the update needs the person: something to download, a restart waiting, or a failure. */
export function updateNeedsYou(info: UpdateInfo | null, dismissed: string | null): boolean {
  if (!info) return false
  if (info.state === 'available') return dismissed !== info.version
  if (info.state === 'downloading') return !info.auto
  if (info.state === 'ready') return dismissed !== `${info.version}@ready`
  return true
}
