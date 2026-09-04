import { contextBridge, ipcRenderer } from 'electron'
import type { EventChannel, InvokeChannel, SinfonieEvents, SinfonieInvoke } from '@shared/ipc'

type Invoke = <C extends InvokeChannel>(
  channel: C,
  ...args: Parameters<SinfonieInvoke[C]>
) => Promise<Awaited<ReturnType<SinfonieInvoke[C]>>>

type On = <C extends EventChannel>(channel: C, cb: (payload: SinfonieEvents[C]) => void) => () => void

const api = {
  invoke: ((channel, ...args) => ipcRenderer.invoke(channel, ...args)) as Invoke,
  on: ((channel, cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }) as On,
  platform: process.platform
}

export type SinfonieApi = typeof api

contextBridge.exposeInMainWorld('sinfonie', api)
