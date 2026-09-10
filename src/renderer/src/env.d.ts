/// <reference types="vite/client" />

import type { DoxApi } from '@shared/api'

declare global {
  interface Window {
    api: DoxApi
  }
}

export {}
