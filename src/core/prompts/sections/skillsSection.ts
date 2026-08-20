/**
 * Skills blocks — active skills list and one-shot skill injection.
 */

import type { Skill } from '../../../shared/types'
import type { OneShotSkill } from './_shared'

/**
 * One-shot skill block — instructions are temporarily injected for this run
 * (without persisting to skillsState). Used by commands like /review.
 * Unlike active skills, instructions go directly into the prompt,
 * not via get_skill. If no skill — empty string.
 */
export function buildOneShotSkillBlock(skill?: OneShotSkill): string {
  if (!skill?.instructions) return ''
  return `## Active mode: ${skill.name}

Follow these instructions in the current task:

${skill.instructions}`
}

/**
 * Active skills block in the system prompt. Only a list of names — NOT instructions.
 * The agent must use get_skill(name) to get a specific skill's instructions
 * when they are needed. If no skills — empty string.
 */
export function buildSkillsBlock(skills?: Skill[]): string {
  if (!skills?.length) return ''
  const names = skills.map(s => `- **${s.name}**${s.description ? `: ${s.description}` : ''}`).join('\n')
  return `## Active skills (${skills.length})

You have skills enabled — these are instructions to follow in relevant situations. Do NOT try to guess their content. If the task is relevant to a skill — call get_skill(name) to read its instructions. Call list_extensions to see the full list.

${names}`
}
