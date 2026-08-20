/**
 * utils.ts — утилиты политики забывания и feedback loop.
 *
 * Содержит: decayPrune (забывание), bumpMemoryHit (usage-based importance).
 */

import { getDB } from '../../db/handle'
import { invalidateIdfCache } from './_shared'

// ─── FORGET POLICY ───────────────────────────────────────────────────────────

/**
 * Decay prune — удаляет низко-important неиспользуемые записи.
 * Защищены: pinned=1, source='user_explicit'.
 *
 * Критерии удаления:
 *   - pinned = 0
 *   - source != 'user_explicit'
 *   - importance < minImportance
 *   - access_count = 0 (никогда не искалась)
 *   - last_accessed_at < cutoff ИЛИ NULL
 *   - created_at < cutoff (не свежая)
 *
 * Возвращает кол-во удалённых записей. Вызывать раз в сутки при старте app.
 */
export function decayPrune(maxAgeDays = 30, minImportance = 0.2): number {
  const db = getDB()
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const result = db.prepare(
    `DELETE FROM memory_items
     WHERE pinned = 0
       AND source != 'user_explicit'
       AND importance < ?
       AND access_count = 0
       AND (last_accessed_at IS NULL OR last_accessed_at < ?)
       AND created_at < ?`
  ).run(minImportance, cutoff, cutoff)
  if (result.changes > 0) invalidateIdfCache()
  return result.changes
}

// ─── FEEDBACK LOOP: usage-based importance ───────────────────────────────────

/**
 * Feedback loop: bump access_count + importance для memory_items, которые
 * попали в результаты recall_memory. Часто вспоминаемые факты становятся
 * "неприкосновенными" (decayPrune защищает access_count > 0).
 *
 * - access_count += 1
 * - last_accessed_at = now
 * - importance = min(1.0, importance + 0.05) — плавный boost
 *
 * Вызывается из recall_memory handler после searchAllSources.
 * Non-fatal: ошибки не блокируют recall.
 */
export function bumpMemoryHit(ids: string[]): number {
  if (!ids.length) return 0
  const db = getDB()
  const now = Date.now()
  const stmt = db.prepare(
    `UPDATE memory_items
     SET access_count = access_count + 1,
         last_accessed_at = ?,
         importance = MIN(1.0, importance + 0.05)
     WHERE id = ?`
  )
  let bumped = 0
  const tx = db.transaction(() => {
    for (const id of ids) {
      const r = stmt.run(now, id)
      if (r.changes > 0) bumped++
    }
  })
  tx()
  return bumped
}
