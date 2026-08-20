// ── System / Display / AgentAction ──────────────────────────────────────

export interface DisplayInfo {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  isPrimary: boolean
}

export interface SystemInfo {
  platform: string
  version: string
  appVersion: string
}

export interface AgentAction {
  type: 'tool_call' | 'tool_result' | 'thinking' | 'done' | 'error'
  tool?: string
  args?: unknown
  result?: string
  error?: string
  timestamp: number
}
