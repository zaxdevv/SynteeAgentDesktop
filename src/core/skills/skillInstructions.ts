import { dirname } from 'path'
import type { Skill } from '../../shared/types'

/** Shared, unambiguous lookup for get_skill(name); IDs also work in the same parameter. */
export function getSkillInstructions(skills: Skill[], nameOrId: string): string {
  const byId = skills.find(s => s.id === nameOrId)
  const matches = byId ? [byId] : skills.filter(s => s.name === nameOrId)
  if (!matches.length) return `Скилл "${nameOrId}" не найден. Доступные: ${skills.map(s => `${s.name} (id: ${s.id})`).join(', ') || 'нет'}`
  if (matches.length > 1) {
    return `Найдено несколько скиллов "${nameOrId}". Вызови get_skill с точным id в параметре name:\n${matches.map(s => `- ${s.id} — ${s.filePath}`).join('\n')}`
  }
  const skill = matches[0]
  return [
    `# ${skill.name}`,
    `ID: ${skill.id}`,
    `Файл скилла: ${skill.filePath}`,
    `Базовая папка: ${skill.baseDir ?? dirname(skill.filePath)}`,
    'Относительные ссылки в инструкциях разрешай от базовой папки скилла, НЕ от рабочей папки проекта. Читай связанные файлы через read_file по абсолютному пути, только когда они нужны. Вложенные материалы не загружаются автоматически.',
    skill.description ? `Описание: ${skill.description}` : '',
    '',
    skill.instructions,
  ].join('\n')
}
