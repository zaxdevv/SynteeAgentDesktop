import type Database from 'better-sqlite3'
import { basename } from 'path'
import { v4 as uuid } from 'uuid'

/**
 * Переносит существующие chats.workdir в таблицу projects: для каждого
 * уникального workdir создаёт проект (имя = basename папки), чатам
 * проставляет project_id. Идемпотентна — повторный запуск не дублирует.
 */
export function migrateChatsToProjects(db: Database.Database): void {
  const rows = db.prepare(`SELECT DISTINCT workdir FROM chats WHERE workdir IS NOT NULL AND project_id IS NULL`).all() as { workdir: string }[]
  if (rows.length === 0) return
  const now = Date.now()
  for (const { workdir } of rows) {
    // Проверяем, есть ли уже проект с таким workdir (UNIQUE constraint)
    const existing = db.prepare(`SELECT id FROM projects WHERE workdir = ?`).get(workdir) as { id: string } | undefined
    const projectId = existing?.id ?? uuid()
    if (!existing) {
      const name = basename(workdir) || workdir
      const projectContext = db.prepare(`SELECT project_context FROM chats WHERE workdir = ? AND project_context IS NOT NULL LIMIT 1`).get(workdir) as { project_context: string } | undefined
      db.prepare(`INSERT INTO projects (id, name, workdir, project_context, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(projectId, name, workdir, projectContext?.project_context ?? null, now, now)
    }
    db.prepare(`UPDATE chats SET project_id = ? WHERE workdir = ? AND project_id IS NULL`).run(projectId, workdir)
  }
}

/**
 * Переносит старую memory table (key-value: category/key/value) в новую
 * унифицированную memory_items. Идемпотентна — повторный запуск не дублирует
 * (проверяем по metadata->legacy_id, чтобы не мигрировать дважды).
 *
 * Старая memory table оставлена в схеме до Фазы 2 (не дропаем сразу, чтобы
 * можно было откатиться). В Фазе 2, когда MemoryEngine.ts будет удалён и
 * все потребители перейдут на MemoryStore, можно будет DROP TABLE memory.
 *
 * Embedding НЕ считается при миграции (TF-IDF требует IDF-кэш, который ещё
 * не построен). MemoryStore.save() пересчитает embedding при первом update,
 * либо отдельная команда реиндекса в UI. Поиск работает и без embeddings
 * (fallback на LIKE по content), просто менее точно.
 */
export function migrateLegacyMemoryToMemoryItems(db: Database.Database): void {
  // Проверяем, есть ли что мигрировать
  const legacyExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='memory'`
  ).get() as { name: string } | undefined
  if (!legacyExists) return

  const legacyRows = db.prepare(
    `SELECT id, category, key, value, created_at, updated_at FROM memory`
  ).all() as Array<{ id: string; category: string; key: string; value: string; created_at: number; updated_at: number }>

  if (legacyRows.length === 0) return

  // Проверяем, не мигрировали ли уже (по metadata->legacy_id)
  // Простой подход: если в memory_items есть хоть одна запись с source='legacy_migration',
  // считаем что миграция уже была.
  const alreadyMigrated = db.prepare(
    `SELECT 1 FROM memory_items WHERE source = 'legacy_migration' LIMIT 1`
  ).get() as { 1: number } | undefined
  if (alreadyMigrated) return

  const insert = db.prepare(
    `INSERT INTO memory_items (id, title, scope, project_id, chat_id, kind, category, key, content, source, confidence, importance, access_count, last_accessed_at, pinned, embedding, metadata, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, 'user_fact', ?, ?, ?, 'legacy_migration', 1.0, 0.6, 0, NULL, 1, NULL, ?, ?, ?)`
  )

  const migrateAll = db.transaction((rows: typeof legacyRows) => {
    for (const row of rows) {
      // legacy_id в metadata для идемпотентности
      const metadata = JSON.stringify({ legacy_id: row.id })
      // title = row.value (truncate 100), content = row.value
      const title = row.value.slice(0, 100)
      // Новый UUID, scope='global' (старая память не была привязана к проектам)
      insert.run(uuid(), title, 'global', row.category || 'facts', row.key, row.value, metadata, row.created_at, row.updated_at)
    }
  })
  migrateAll(legacyRows)

  console.log(`[migrations] memory_items: migrated ${legacyRows.length} rows from legacy memory table`)
}
