/**
 * Shared types for system-prompt sections.
 * These are imported by the individual section builders and re-exported
 * from buildSystemPrompt.ts for backwards compatibility.
 */

import type { ProjectInstructions } from '../projectInstructions'
import type { Skill } from '../../../shared/types'

/** MCP server info for system-prompt injection. */
export interface McpPromptInfo {
  name: string
  tools: Array<{ shortName: string; description?: string }>
}

/** Memory counters for the system prompt — agent sees how much memory it has. */
export interface MemoryStats {
  globalCount: number
  projectCount: number
  globalByKind: Record<string, number>
  projectByKind: Record<string, number>
}

/** Knowledge graph stats of the project — agent sees project structure. */
export interface GraphStats {
  nodeCount: number
  edgeCount: number
  byNodeType: Record<string, number>
  byEdgeType: Record<string, number>
  hubs: Array<{ id: string; label: string; type: string; degree: number }>
  recentDecisions: Array<{ id: string; label: string; targets: Array<{ label: string; type: string; edgeType: string }> }>
  fileHubs?: Array<{ label: string; degree: number; topImports: string[] }>
}

/** Project notes — titles shown in the system prompt. */
export interface NotesInfo {
  notes: Array<{ id: string; title: string }>
  count: number
}

/** Persona — single-select run mode profile. */
export interface PersonaInfo {
  id: string
  nameEn: string
  toolsProfile: 'full' | 'readonly'
  skillId?: string
}

/** Resolved instructions for a persona that wraps a builtin skill. */
export interface PersonaSkill {
  name: string
  instructions: string
}

/** One-shot skill — instructions temporarily injected for this run. */
export interface OneShotSkill {
  name: string
  instructions: string
}

/** Code-mode block params. */
export interface CodeModeBlockParams {
  workdir?: string
  projectContext?: string
  projectInstructions?: ProjectInstructions | null
}

export type { ProjectInstructions, Skill }
