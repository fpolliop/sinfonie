import { note } from './crash'

const raw = window.sinfonie

/**
 * Every call to the main process and every event from it passes through here, so a crash report can
 * name the last steps the page took before it broke (lib/crash.ts).
 */
export const api: typeof raw = {
  ...raw,
  invoke: ((channel, ...args) => {
    note(`call ${channel}`)
    return raw.invoke(channel, ...args)
  }) as typeof raw.invoke,
  on: ((channel, cb) =>
    raw.on(channel, ((payload: never) => {
      note(`event ${channel}`)
      return (cb as (p: never) => void)(payload)
    }) as never)) as typeof raw.on
}
