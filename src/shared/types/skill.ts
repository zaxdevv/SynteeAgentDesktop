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
