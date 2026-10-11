export const CONTEXT_SOURCE_KEYS = ['instructions', 'projectFiles', 'memory', 'history', 'tools'] as const
export type ContextSourceKey = typeof CONTEXT_SOURCE_KEYS[number]
export interface ContextPreferences {
  sources: Record<ContextSourceKey, boolean>
  excludedFiles: string[]
}
export const DEFAULT_CONTEXT_PREFERENCES: ContextPreferences = {
  sources: { instructions: true, projectFiles: true, memory: true, history: true, tools: true },
  excludedFiles: [],
}
export interface ContextSourceInfo {
  key: ContextSourceKey
  label: string
  enabled: boolean
  detail: string
  characters: number
}
export interface ContextInspection {
  preferences: ContextPreferences
  sources: ContextSourceInfo[]
  files: Array<{ source: string; characters: number; included: boolean }>
  messages: Array<{ id: string; role: string; preview: string; isPinned: boolean; isHidden: boolean; included: boolean }>
}
