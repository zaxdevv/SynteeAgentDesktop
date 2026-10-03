// ── Skills ───────────────────────────────────────────────────────────────

import type { ExtensionScope } from './mcp'

/** Источник скилла. */
export type SkillSource = 'builtin' | 'user' | 'project'

/**
 * Скилл = markdown-инструкция, инжектищаяся в system prompt когда включён.
 * Загружается из .md-файла с YAML frontmatter.
 */
export interface Skill {
  /** Стабильный id: source + ':' + относительный путь/имя. */
  id: string
  name: string
  description: string
  /** Тело файла (инструкции) — попадает в system prompt. */
  instructions: string
  source: SkillSource
  /** Абсолютный путь к файлу. */
  filePath: string
  /** Путь от корня skills, с '/' независимо от платформы. */
  relativePath?: string
  /** Корень skills и папка файла — для дерева и разрешения относительных ссылок. */
  rootDir?: string
  baseDir?: string
  /** Старый id одиночного файла — только для миграции сохранённого состояния. */
  legacyId?: string
  /** Для проектных — id проекта. */
  projectId?: string
  /** mtime файла для инвалидации кэша. */
  mtimeMs: number
}

/** Per-skill состояние (включён + область применения). */
export interface SkillState {
  enabled: boolean
  scope: ExtensionScope
}

/** Групповая операция. Папка задаётся относительно skills, '' — весь источник. */
export interface SkillFolderUpdate {
  source: SkillSource
  folderPath: string
  projectId?: string
  chatId?: string
  patch: Partial<SkillState>
}
