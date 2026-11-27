interface SearchableSkill {
  id: string
  name: string
  description?: string
  state: { enabled: boolean }
}

const PAGE_SIZE = 10

export function formatSkillSearch(skills: SearchableSkill[], query = '', offset = 0): string {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].slice(0, 12)
  const matches = skills.map((skill, index) => {
    const identity = `${skill.name} ${skill.id}`.toLowerCase()
    const description = (skill.description ?? '').toLowerCase()
    const score = terms.reduce((sum, term) => sum + (identity.includes(term) ? 3 : description.includes(term) ? 1 : 0), 0)
    return { skill, score, index }
  }).filter(row => !terms.length || row.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.skill.state.enabled) - Number(a.skill.state.enabled) || a.index - b.index)

  const start = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0
  const page = matches.slice(start, start + PAGE_SIZE)
  if (!page.length) return 'No skills on this page. Use different terms or offset 0.'
  const lines = page.map(({ skill }) => `- ${skill.name.slice(0, 120)} (id: ${skill.id}${skill.state.enabled ? '' : ', inactive'}): ${(skill.description ?? '').replace(/\s+/g, ' ').slice(0, 180)}`)
  lines.unshift(`Skills ${start + 1}–${start + page.length} of ${matches.length}. Use get_skill with the exact id.`)
  if (start + page.length < matches.length) lines.push(`Next offset: ${start + page.length}`)
  return lines.join('\n')
}
