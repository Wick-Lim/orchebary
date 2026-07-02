import type { OrchebaryApi } from './index'

declare global {
  interface Window {
    orchebary: OrchebaryApi
  }
}

export {}
