// ── Barrel re-export: all shared types ──────────────────────────────────
// Domain files are split by concern. This barrel preserves backward
// compatibility — all existing `import { X } from '../types'` keep working.

export * from './chat'
export * from './attachment'
export * from './question'
export * from './provider'
export * from './mcp'
export * from './skill'
export * from './plugin'
export * from './marketplace'
export * from './system'
export * from './theme'
export * from './update'
export * from './notification'
export * from './ipc'
export * from './protectedVars'
export * from './dot'
export * from './taskSummary'
