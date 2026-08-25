/**
 * Auto-discovery project instructions.
 *
 * Сканирует корень workdir на стандартные файлы инструкций, используемые
 * популярными AI-ассистентами. Перечитывается live (с mtime-кэшем), а не
 * замораживается при создании проекта — правки файла видны в следующем turn'е.
 *
 * Порядок проверки (первый найденный имеет приоритет в системном промпте,
 * но возвращаются ВСЕ найденные файлы):
 *   1.  .syntee/instructions.md  (SynteeHelper — собственный)
 *   2.  AGENTS.md                (Codex CLI, OpenCode — универсальный)
 *   3.  CLAUDE.md                (Claude Code)
 *   4.  GEMINI.md                (Gemini CLI)
 *   5.  .cursorrules             (Cursor)
 *   6.  .cursor/rules.md         (Cursor, новый формат)
 *   7.  .windsurfrules           (Windsurf)
 *   8.  .clinerules              (Cline)
 *   9.  .github/copilot-instructions.md  (GitHub Copilot)
 *  10.  copilot-instructions.md  (GitHub Copilot, корень)
 *
 * Только корень workdir (+ .syntee/ и .cursor/ подпапки), без рекурсии
 * вверх по дереву каталогов.
 *
 * Дополнительно: кастомные .md файлы из настроек проекта (contextFiles).
 * readProjectContextFiles объединяет авто-дискавери + кастомные файлы.
 */

import { existsSync } from 'fs'
import { stat as fsStat, readFile as fsReadFile } from 'fs/promises'
import { join } from 'path'

export interface ProjectInstructions {
  content: string
  source: string
}

const CANDIDATE_NAMES: readonly string[] = [
  // SynteeHelper (свой — высший приоритет)
  '.syntee/instructions.md',
  // Универсальные / мульти-агентные
  'AGENTS.md',
  // Инструмент-специфичные
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  '.cursor/rules.md',
  '.windsurfrules',
  '.clinerules',
  '.github/copilot-instructions.md',
  'copilot-instructions.md',
] as const

interface CacheEntry {
  mtimeMs: number
  size: number
  content: string
  source: string
}

// workdir+filename → cached entry. Инвалидируется по mtime/size. Module-level,
// живёт весь процесс приложения (один main-процесс на сессию).
// Ключ — `${workdir}::${relPath}` — поддерживает и стандартные, и кастомные файлы.
const cache = new Map<string, CacheEntry>()

function cacheKey(workdir: string, relPath: string): string {
  return `${workdir}::${relPath}`
}

/**
 * Читает один .md файл из workdir по относительному пути с mtime-кэшем.
 * Возвращает null если файл не найден или не читается.
 */
async function readFileWithCache(workdir: string, relPath: string): Promise<ProjectInstructions | null> {
  const fullPath = join(workdir, relPath)
  if (!existsSync(fullPath)) return null
  try {
    const st = await fsStat(fullPath)
    if (!st.isFile()) return null

    const key = cacheKey(workdir, relPath)
    const cached = cache.get(key)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return { content: cached.content, source: relPath }
    }

    const content = await fsReadFile(fullPath, 'utf-8')
    cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, content, source: relPath })
    return { content, source: relPath }
  } catch {
    return null
  }
}

/**
 * Читает инструкции проекта из workdir (авто-дискавери). Возвращает ВСЕ найденные
 * стандартные файлы инструкций (AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules,
 * .windsurfrules, .clinerules, copilot-instructions.md, .syntee/instructions.md и др.),
 * а не только первый. Использует mtime+size кэш. Пустой массив если ничего не найдено.
 */
export async function readProjectInstructions(workdir?: string): Promise<ProjectInstructions[]> {
  if (!workdir) return []

  const results: ProjectInstructions[] = []
  for (const name of CANDIDATE_NAMES) {
    const result = await readFileWithCache(workdir, name)
    if (result) results.push(result)
  }

  return results
}

/**
 * Читает все инструкции проекта: авто-дискавери (если включён) + кастомные
 * .md файлы из настроек проекта. Возвращает массив (может быть пустым).
 *
 * @param workdir Абсолютный путь к рабочей директории
 * @param contextFiles Массив относительных путей к .md файлам (из настроек проекта)
 * @param autoDiscover Включить авто-дискавери стандартных файлов инструкций
 * @param disabledDiscoveryFiles Стандартные файлы, отключённые пользователем
 */
export async function readProjectContextFiles(
  workdir?: string,
  contextFiles?: string[],
  autoDiscover?: boolean,
  disabledDiscoveryFiles?: string[],
): Promise<ProjectInstructions[]> {
  if (!workdir) return []

  const results: ProjectInstructions[] = []
  const disabled = new Set(disabledDiscoveryFiles ?? [])

  // 1. Авто-дискавери стандартных файлов (если включено)
  if (autoDiscover !== false) {
    const auto = await readProjectInstructions(workdir)
    for (const instr of auto) {
      if (!disabled.has(instr.source)) results.push(instr)
    }
  }

  // 2. Кастомные файлы из настроек проекта
  if (contextFiles && contextFiles.length > 0) {
    for (const relPath of contextFiles) {
      // Не дублируем файлы, уже добавленные авто-дискавери
      if (results.some(r => r.source === relPath)) continue
      const result = await readFileWithCache(workdir, relPath)
      if (result) results.push(result)
    }
  }

  return results
}

/**
 * Синхронно сбросить кэш для конкретного workdir (или весь). Полезно после
 * явного редактирования AGENTS.md через UI или при смене проекта.
 */
export function invalidateProjectInstructionsCache(workdir?: string): void {
  if (workdir) {
    // Удаляем все ключи, начинающиеся с этого workdir
    for (const key of cache.keys()) {
      if (key.startsWith(`${workdir}::`)) cache.delete(key)
    }
  } else {
    cache.clear()
  }
}
