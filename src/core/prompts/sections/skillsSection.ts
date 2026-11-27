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
  const names = skills.slice(0, 12).map(s => `- ${s.name.slice(0, 100)}${s.description ? `: ${s.description.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`).join('\n')
  const search = skills.length > 12 ? ' For other skills or duplicate names, search list_extensions with scope="skills".' : ''
  return `## Active skills (${skills.length})

Read applicable skills with get_skill before using them. Resolve links from the returned base directory.${search}

${names}`
}
