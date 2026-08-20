/**
 * System-prompt sections barrel — combines all section builders.
 */

export { buildCodeModeBlock } from './codeModeSection'
export { buildPlanningInjection, buildAskInjection } from './planningSection'
export { buildPersonaInjection } from './personaSection'
export { buildOneShotSkillBlock, buildSkillsBlock } from './skillsSection'
export { buildMcpBlock, buildInstallPathsBlock } from './mcpSection'
export { buildMemoryStatsBlock, buildGraphStatsBlock, buildNotesBlock } from './memorySection'

export type {
  McpPromptInfo,
  MemoryStats,
  GraphStats,
  NotesInfo,
  PersonaInfo,
  PersonaSkill,
  OneShotSkill,
  CodeModeBlockParams,
} from './_shared'
