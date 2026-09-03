import { contextBridge, ipcRenderer } from 'electron'
import type { EventChannel, InvokeChannel, OrchestraEvents, OrchestraInvoke } from '@shared/ipc'

type Invoke = <C extends InvokeChannel>(
  channel: C,
  ...args: Parameters<OrchestraInvoke[C]>
) => Promise<Awaited<ReturnType<OrchestraInvoke[C]>>>

type On = <C extends EventChannel>(channel: C, cb: (payload: OrchestraEvents[C]) => void) => () => void

const api = {
  invoke: ((channel, ...args) => ipcRenderer.invoke(channel, ...args)) as Invoke,
  on: ((channel, cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }) as On,
  platform: process.platform
}

export type OrchestraApi = typeof api

contextBridge.exposeInMainWorld('orchestra', api)
