/**
 * categories.ts — динамические категории памяти.
 *
 * Содержит: BUILTIN_CATEGORIES, listMemoryCategories, createMemoryCategory,
 * deleteMemoryCategory.
 */

import { v4 as uuid } from 'uuid'
import { getDB } from '../../db/handle'
import type { MemoryCategory, MemoryScope, MemoryKind } from './_shared'

/** Builtin категории — всегда доступны, не хранятся в БД. */
export const BUILTIN_CATEGORIES: MemoryCategory[] = [
  { id: 'builtin-personal', name: 'personal', label: 'Личное', icon: 'user', color: null, scope: 'global', projectId: null, kind: 'user_fact', createdAt: 0 },
  { id: 'builtin-work', name: 'work', label: 'Работа', icon: 'briefcase', color: null, scope: 'global', projectId: null, kind: 'user_fact', createdAt: 0 },
  { id: 'builtin-preferences', name: 'preferences', label: 'Предпочтения', icon: 'sparkles', color: null, scope: 'global', projectId: null, kind: 'user_fact', createdAt: 0 },
  { id: 'builtin-projects', name: 'projects', label: 'Проекты', icon: 'folder', color: null, scope: 'global', projectId: null, kind: 'user_fact', createdAt: 0 },
  { id: 'builtin-facts', name: 'facts', label: 'Факты', icon: 'pin', color: null, scope: 'global', projectId: null, kind: 'user_fact', createdAt: 0 },
]

export function listMemoryCategories(projectId?: string): MemoryCategory[] {
  const db = getDB()
  // Builtin + кастомные (global + project-specific если projectId задан)
  const custom = projectId
    ? db.prepare(`SELECT * FROM memory_categories WHERE scope = 'global' OR (scope = 'project' AND project_id = ?) ORDER BY created_at`).all(projectId) as Record<string, unknown>[]
    : db.prepare(`SELECT * FROM memory_categories WHERE scope = 'global' ORDER BY created_at`).all() as Record<string, unknown>[]
  const customMapped = custom.map(r => ({
    id: r.id as string,
    name: r.name as string,
    label: r.label as string,
    icon: (r.icon as string | null) ?? null,
    color: (r.color as string | null) ?? null,
    scope: r.scope as MemoryScope,
    projectId: (r.project_id as string | null) ?? null,
    kind: (r.kind as MemoryKind | null) ?? null,
    createdAt: r.created_at as number,
  }))
  return [...BUILTIN_CATEGORIES, ...customMapped]
}

export function createMemoryCategory(input: {
  name: string
  label: string
  icon?: string
  color?: string
  scope?: MemoryScope
  projectId?: string
  kind?: MemoryKind
}): MemoryCategory {
  const db = getDB()
  const id = uuid()
  const now = Date.now()
  const scope: MemoryScope = input.scope ?? (input.projectId ? 'project' : 'global')
  const name = input.name.toLowerCase().replace(/[^a-zа-я0-9_]/gi, '_')
  db.prepare(
    `INSERT INTO memory_categories (id, name, label, icon, color, scope, project_id, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, input.label, input.icon ?? null, input.color ?? null, scope, input.projectId ?? null, input.kind ?? null, now)
  return { id, name, label: input.label, icon: input.icon ?? null, color: input.color ?? null, scope, projectId: input.projectId ?? null, kind: input.kind ?? null, createdAt: now }
}

export function deleteMemoryCategory(id: string): boolean {
  // Builtin нельзя удалить
  if (id.startsWith('builtin-')) return false
  const result = getDB().prepare(`DELETE FROM memory_categories WHERE id = ?`).run(id)
  return result.changes > 0
}
