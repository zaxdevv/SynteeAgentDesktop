/**
 * IPC для кастомных slash-команд.
 *
 *   commands:list  — список custom-команд для UI (builtin из SLASH_COMMANDS
 *                    renderer добавляет сам через filterCommands).
 *                    Параметр: { projectWorkdir?: string }.
 *   commands:reload — сброс кэша (после правки .md-файлов).
 */
import { ipcMain } from 'electron'
import { getCommandManager } from '../../core/commands/commandManager'
import { getPluginManager } from '../../core/plugins/pluginManager'
import { getAllProjects, getChatWorkdirContext } from '../../core/db'
import type { SlashCommand } from '../../shared/slashCommands'

/**
 * Стрипает функции из команды перед отправкой через IPC (structured clone
 * не переносит функции). systemPrompt восстанавливается в renderer через
 * hydrateCommands() из promptTemplate + hasArgsPlaceholder.
 */
function stripForIPC(cmd: SlashCommand): Omit<SlashCommand, 'systemPrompt'> {
  const { systemPrompt, ...rest } = cmd
  void systemPrompt
  return rest
}

export function registerCommandsIPC(): void {
  ipcMain.handle('commands:list', (_, params?: { projectWorkdir?: string; chatId?: string }) => {
    try {
      const custom = getCommandManager().getAllForUI({ projectWorkdir: params?.projectWorkdir })
      // Команды плагинов (registerCommand) — из запущенных плагинов.
      // chatId надёжнее projectWorkdir: резолвит проект из БД.
      let pluginCommands: SlashCommand[] = []
      try {
        let projectWorkdir = params?.projectWorkdir
        let projectId: string | undefined
        if (!projectWorkdir && params?.chatId) {
          try {
            const ctx = getChatWorkdirContext(params.chatId)
            if (ctx.workdir) {
              projectWorkdir = ctx.workdir
              projectId = getAllProjects().find(p => p.workdir === ctx.workdir)?.id
            }
          } catch { /* чат без проекта */ }
        } else if (projectWorkdir) {
          projectId = getAllProjects().find(p => p.workdir === projectWorkdir)?.id
        }
        pluginCommands = getPluginManager().getCommandsForUI({ projectWorkdir, projectId })
      } catch {
        // Плагины недоступны — работаем без них.
      }
      return [...custom, ...pluginCommands].map(stripForIPC)
    } catch (e) {
      console.error('[commands:list] error:', (e as Error).message)
      return []
    }
  })

  ipcMain.handle('commands:reload', () => {
    try {
      getCommandManager().invalidate()
      return true
    } catch (e) {
      console.error('[commands:reload] error:', (e as Error).message)
      return false
    }
  })
}
