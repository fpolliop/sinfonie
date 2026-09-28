/**
 * Undo instead of confirm, for low-stakes removals: the item disappears at once, a toast offers Undo, and the
 * real call only runs when the toast has closed without it (a little after the toast's six seconds).
 */
import { useApp } from '@/stores/app'
import { friendlyError } from '@/lib/errors'

const UNDO_WINDOW_MS = 6500

/** Removals waiting out their undo window; committed at once if the window closes first. */
const pending = new Map<string, () => void>()
window.addEventListener('beforeunload', () => {
  for (const run of pending.values()) run()
  pending.clear()
})

/**
 * Hide `id` from lists now (and leave it if it is the open workspace), run `commit` after the undo window unless
 * Undo was pressed; Undo brings it back and reopens it when it was open.
 */
export function removeWithUndo(id: string, text: string, commit: () => Promise<unknown>): void {
  const st = useApp.getState()
  const wasOpen = st.selectedId === id
  if (wasOpen) st.select(null)
  st.setPendingRemoval(id, true)
  let undone = false
  const run = (): void => {
    pending.delete(id)
    if (undone) return
    undone = true
    commit()
      .catch((err) => useApp.getState().setError(friendlyError(err)))
      .finally(() => useApp.getState().setPendingRemoval(id, false))
  }
  pending.set(id, run)
  const timer = window.setTimeout(run, UNDO_WINDOW_MS)
  st.notify({
    kind: 'info',
    text,
    undo: () => {
      if (undone) return
      undone = true
      pending.delete(id)
      window.clearTimeout(timer)
      useApp.getState().setPendingRemoval(id, false)
      if (wasOpen) useApp.getState().select(id)
    }
  })
}
