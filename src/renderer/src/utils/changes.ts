/**
 * computeLiveChanges — парсит diff-строки из tool_result-шагов live-состояния
 * и агрегирует per-file added/deleted, как getLastTurnChanges в chat.ipc.ts,
 * но работает в рендерере на массиве ToolStep[] во время выполнения запроса.
 *
 * Возвращает null если нет правок — бейдж не показывается.
 * userMessageId/assistantMessageId пустые (неизвестны до CHAT_STREAM_DONE).
 */
import type { ToolStep, LastTurnChanges, LastTurnFileChange } from '../../../shared/types'

export function computeLiveChanges(steps: ToolStep[] | undefined | null): LastTurnChanges | null {
  if (!steps || steps.length === 0) return null

  const fileMap = new Map<string, { added: number; deleted: number }>()

  for (const step of steps) {
    if (step.type !== 'tool_result' || !step.diff || !step.success) continue
    if (!['write_file', 'edit_file'].includes(step.toolName || '')) continue

    // Извлекаем path из +++ строки, fallback — toolArgs.path.
    // createPatch на Windows оборачивает пути с '\' в кавычки И экранирует
    // слеши: +++ "C:\\Projects\\..." — срезаем кавычки и расэкранируем.
    const pathMatch = step.diff.match(/^\+\+\+\s+(.+)$/m)
    let filePath = pathMatch?.[1]?.trim() ?? (step.toolArgs?.path as string | undefined)
    if (!filePath) continue
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"')
    }

    let added = 0
    let deleted = 0
    for (const line of step.diff.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) deleted++
    }

    const existing = fileMap.get(filePath)
    if (existing) {
      existing.added += added
      existing.deleted += deleted
    } else {
      fileMap.set(filePath, { added, deleted })
    }
  }

  if (fileMap.size === 0) return null

  const files: LastTurnFileChange[] = Array.from(fileMap.entries()).map(([path, v]) => ({
    path,
    added: v.added,
    deleted: v.deleted,
  }))

  return {
    files,
    totalAdded: files.reduce((s, f) => s + f.added, 0),
    totalDeleted: files.reduce((s, f) => s + f.deleted, 0),
    userMessageId: '',
    assistantMessageId: '',
  }
}
