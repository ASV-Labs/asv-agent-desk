/// <reference types="vite/client" />

import type { AgentDeskApi } from '../../preload'

declare global {
  interface Window {
    agentDesk: AgentDeskApi
  }
}

export {}
