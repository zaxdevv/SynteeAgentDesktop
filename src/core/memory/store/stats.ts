/**
 * stats.ts — статистика памяти и реиндексация embeddings.
 *
 * Содержит: getMemoryStats, getMemoryStatsForProject, reindexAllEmbeddings.
 */

import { getDB } from '../../db/handle'
import { embeddingToBuffer } from '../../context/embeddings'
import { embedText, invalidateIdfCache } from './_shared'

// ─── СТАТИСТИКА ──────────────────────────────────────────────────────────────

export function getMemoryStats(): {
  total: number
  byScope: Record<string, number>
  byKind: Record<string, number>
  bySource: Record<string, number>
} {
  const db = getDB()
  const total = (db.prepare(`SELECT COUNT(*) as c FROM memory_items`).get() as { c: number }).c
  const byScopeRows = db.prepare(`SELECT scope, COUNT(*) as c FROM memory_items GROUP BY scope`).all() as Array<{ scope: string; c: number }>
  const byKindRows = db.prepare(`SELECT kind, COUNT(*) as c FROM memory_items GROUP BY kind`).all() as Array<{ kind: string; c: number }>
  const bySourceRows = db.prepare(`SELECT source, COUNT(*) as c FROM memory_items GROUP BY source`).all() as Array<{ source: string; c: number }>
  return {
    total,
    byScope: Object.fromEntries(byScopeRows.map(r => [r.scope, r.c])),
    byKind: Object.fromEntries(byKindRows.map(r => [r.kind, r.c])),
    bySource: Object.fromEntries(bySourceRows.map(r => [r.source, r.c])),
  }
}

/**
 * Статистика по проекту — для системного промпта (агент видит сколько у него
 * памяти по проекту и глобально). Возвращает счётчики по scope/kind/category.
 */
export function getMemoryStatsForProject(projectId?: string): {
  globalCount: number
  projectCount: number
  globalByKind: Record<string, number>
  projectByKind: Record<string, number>
  byCategory: Record<string, number>
} {
  const db = getDB()
  const globalCount = (db.prepare(`SELECT COUNT(*) as c FROM memory_items WHERE scope = 'global'`).get() as { c: number }).c
  const projectCount = projectId
    ? (db.prepare(`SELECT COUNT(*) as c FROM memory_items WHERE scope = 'project' AND project_id = ?`).get(projectId) as { c: number }).c
    : 0
  const globalByKindRows = db.prepare(`SELECT kind, COUNT(*) as c FROM memory_items WHERE scope = 'global' GROUP BY kind`).all() as Array<{ kind: string; c: number }>
  // Bug 1: was `.get(projectId)` — get() returns a single row (object), not
  // an array, so `.map` below threw "(projectByKindRows || []).map is not a
  // function" whenever projectId was set. Must be `.all(projectId)`.
  const projectByKindRows = projectId
    ? (db.prepare(`SELECT kind, COUNT(*) as c FROM memory_items WHERE scope = 'project' AND project_id = ? GROUP BY kind`).all(projectId) as Array<{ kind: string; c: number }>)
    : []
  // Bug 2: the placeholder `?` only appears in SQL when projectId is set,
  // but `.all(projectId)` always passed projectId (even undefined) →
  // better-sqlite3 threw "Too many parameter values were provided" when
  // projectId was undefined. Build the statement conditionally and pass
  // params only when needed.
  const byCategoryStmt = projectId
    ? db.prepare(
        `SELECT COALESCE(category, 'uncategorized') as cat, COUNT(*) as c FROM memory_items
         WHERE scope = 'global' OR (scope = 'project' AND project_id = ?)
         GROUP BY cat ORDER BY c DESC`
      )
    : db.prepare(
        `SELECT COALESCE(category, 'uncategorized') as cat, COUNT(*) as c FROM memory_items
         WHERE scope = 'global'
         GROUP BY cat ORDER BY c DESC`
      )
  const byCategoryRows = (projectId ? byCategoryStmt.all(projectId) : byCategoryStmt.all()) as Array<{ cat: string; c: number }>
  return {
    globalCount,
    projectCount,
    globalByKind: Object.fromEntries(globalByKindRows.map(r => [r.kind, r.c])),
    projectByKind: Object.fromEntries((projectByKindRows || []).map(r => [r.kind, r.c])),
    byCategory: Object.fromEntries(byCategoryRows.map(r => [r.cat, r.c])),
  }
}

/**
 * Реиндекс всех embeddings (после переключения TF-IDF ↔ neural).
 * Дорого — O(N) embedding calls. Вызывать из UI по кнопке.
 */
export async function reindexAllEmbeddings(onProgress?: (done: number, total: number) => void): Promise<number> {
  const db = getDB()
  const rows = db.prepare(`SELECT id, content FROM memory_items`).all() as { id: string; content: string }[]
  let done = 0
  for (const row of rows) {
    try {
      const emb = await embedText(row.content)
      db.prepare(`UPDATE memory_items SET embedding = ? WHERE id = ?`).run(embeddingToBuffer(emb), row.id)
    } catch { /* skip */ }
    done++
    onProgress?.(done, rows.length)
  }
  invalidateIdfCache()
  return rows.length
}
