import type { OrchestraApi } from './index'

declare global {
  interface Window {
    orchestra: OrchestraApi
  }
}
export {}
