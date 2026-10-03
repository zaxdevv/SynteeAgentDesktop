import type { ProjectIcon } from './types/chat'

export const PROJECT_COLORS = ['#7c8cff', '#43b581', '#f0a44b', '#e36b73', '#c678dd', '#32a6a6', '#d2bd45', '#8b98a8'] as const

export const PROJECT_ICONS: { id: ProjectIcon; label: string }[] = [
  { id: 'folder', label: 'Папка' },
  { id: 'code', label: 'Код' },
  { id: 'bot', label: 'AI' },
  { id: 'briefcase', label: 'Работа' },
  { id: 'layers', label: 'Слои' },
  { id: 'database', label: 'База данных' },
  { id: 'terminal', label: 'Терминал' },
  { id: 'globe', label: 'Веб' },
  { id: 'star', label: 'Избранное' },
  { id: 'zap', label: 'Инструмент' },
  { id: 'image', label: 'Изображения' },
  { id: 'git', label: 'Git' },
  { id: 'puzzle', label: 'Расширение' },
]

export function defaultProjectColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return `hsl(${Math.abs(hash) % 360}, 55%, 58%)`
}
