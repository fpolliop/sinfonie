import type { SinfonieApi } from './index'

declare global {
  interface Window {
    sinfonie: SinfonieApi
  }
}
export {}
