/**
 * A manual "keep the Mac awake" toggle, like the `caffeinate` command: while it is on, the system does not
 * sleep, so a long agent run keeps going with the lid closed or the user away. The display may still turn
 * off. This is separate from the phone's automatic blocker in remote.ts; either keeps the machine awake.
 */
import { powerSaveBlocker } from 'electron'

let blockerId: number | null = null
let onChange: (on: boolean) => void = () => undefined

export function setOnChange(fn: (on: boolean) => void): void {
  onChange = fn
}

export function active(): boolean {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId)
}

export function set(on: boolean): boolean {
  if (on && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (!on && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
  const state = active()
  onChange(state)
  return state
}

export function toggle(): boolean {
  return set(!active())
}
