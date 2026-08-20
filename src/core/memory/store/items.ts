/**
 * items.ts — CRUD для memory_items.
 *
 * Содержит: saveMemoryItem (с dedup), getMemoryItem, listMemoryItems,
 * deleteMemoryItem, pinMemoryItem, updateMemoryItemImportance.
 */

import { v4 as uuid } from 'uuid'
import { getDB } from '../../db/handle'
import {
  embeddingToBuffer,
  bufferToEmbedding,
  cosineSimilarity,
} from '../../context/embeddings'
import {
  embedText,
  rowToItem,
  invalidateIdfCache,
  SEMANTIC_MERGE_THRESHOLD,
  type MemoryItem,
  type SaveMemoryInput,
  type ListMemoryFilter,
  type MemoryScope,
  type MemorySource,
} from './_shared'

// ─── SAVE (с dedup) ──────────────────────────────────────────────────────────

/**
 * Сохраняет запись в память с дедупликацией:
 *   1. Если есть key и найдена запись с тем же (scope, key) → update
 *   2. Иначе если cosine(новое, существующее same-scope+kind) > 0.92 → merge
 *   3. Иначе insert новой записи
 *
 * Embedding считается всегда (TF-IDF мгновенно). При update/merge embedding
 * пересчитывается от нового content.
 */
export async function saveMemoryItem(input: SaveMemoryInput): Promise<MemoryItem> {
  const db = getDB()
  const now = Date.now()
  const scope: MemoryScope = input.scope ?? (input.projectId ? 'project' : 'global')
  const source: MemorySource = input.source ?? 'agent_tool'
  const pinnedInt = (input.pinned ?? source === 'user_explicit') ? 1 : 0
  const importance = input.importance ?? 0.5
  const confidence = input.confidence ?? 1.0
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null

  // ── 1. Dedup по key ──
  if (input.key) {
    const existing = db.prepare(
      `SELECT * FROM memory_items WHERE scope = ? AND key = ?`
    ).get(scope, input.key) as Record<string, unknown> | undefined

    if (existing) {
      const emb = await embedText(input.content)
      const newImportance = Math.min(1, (existing.importance as number) + 0.1)
      db.prepare(
        `UPDATE memory_items
         SET title = ?, content = ?, category = ?, importance = ?, confidence = ?, embedding = ?, metadata = ?, pinned = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        input.title,
        input.content,
        input.category ?? (existing.category as string | null),
        newImportance,
        confidence,
        embeddingToBuffer(emb),
        metadataJson,
        pinnedInt,
        now,
        existing.id as string,
      )
      invalidateIdfCache()
      const updated = db.prepare(`SELECT * FROM memory_items WHERE id = ?`).get(existing.id) as Record<string, unknown>
      return rowToItem(updated)
    }
  }

  // ── 2. Semantic dedup (cosine > 0.92) ──
  const emb = await embedText(input.content)
  const candidates = db.prepare(
    `SELECT * FROM memory_items WHERE scope = ? AND kind = ? AND embedding IS NOT NULL`
  ).all(scope, input.kind) as Record<string, unknown>[]

  let bestMatch: { id: string; cosine: number; row: Record<string, unknown> } | null = null
  for (const c of candidates) {
    try {
      const cEmb = bufferToEmbedding(c.embedding as Buffer)
      const cos = cosineSimilarity(emb, cEmb)
      if (cos > SEMANTIC_MERGE_THRESHOLD && (!bestMatch || cos > bestMatch.cosine)) {
        bestMatch = { id: c.id as string, cosine: cos, row: c }
      }
    } catch { /* skip corrupted embedding */ }
  }

  if (bestMatch) {
    const existing = bestMatch.row
    // Merge: оставляем более длинный content, boost importance
    const existingContent = existing.content as string
    const mergedContent = input.content.length > existingContent.length ? input.content : existingContent
    const newImportance = Math.min(1, (existing.importance as number) + 0.1)
    db.prepare(
      `UPDATE memory_items
       SET title = ?, content = ?, importance = ?, embedding = ?, updated_at = ?
       WHERE id = ?`
    ).run(input.title, mergedContent, newImportance, embeddingToBuffer(emb), now, bestMatch.id)
    invalidateIdfCache()
    const updated = db.prepare(`SELECT * FROM memory_items WHERE id = ?`).get(bestMatch.id) as Record<string, unknown>
    return rowToItem(updated)
  }

  // ── 3. Insert новой записи ──
  const id = uuid()
  db.prepare(
    `INSERT INTO memory_items
     (id, title, scope, project_id, chat_id, kind, category, key, content, source, confidence, importance, access_count, last_accessed_at, pinned, embedding, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.title,
    scope,
    input.projectId ?? null,
    input.chatId ?? null,
    input.kind,
    input.category ?? null,
    input.key ?? null,
    input.content,
    source,
    confidence,
    importance,
    pinnedInt,
    embeddingToBuffer(emb),
    metadataJson,
    now,
    now,
  )
  invalidateIdfCache()
  const row = db.prepare(`SELECT * FROM memory_items WHERE id = ?`).get(id) as Record<string, unknown>
  return rowToItem(row)
}

// ─── LIST / GET / DELETE / PIN ───────────────────────────────────────────────

export function getMemoryItem(id: string): MemoryItem | null {
  const row = getDB().prepare(`SELECT * FROM memory_items WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  return row ? rowToItem(row) : null
}

export function listMemoryItems(filter: ListMemoryFilter = {}): MemoryItem[] {
  const db = getDB()
  const where: string[] = []
  const args: unknown[] = []

  if (filter.scope) { where.push(`scope = ?`); args.push(filter.scope) }
  if (filter.kind) { where.push(`kind = ?`); args.push(filter.kind) }
  if (filter.projectId) { where.push(`project_id = ?`); args.push(filter.projectId) }
  if (filter.category) { where.push(`category = ?`); args.push(filter.category) }
  if (filter.search) {
    where.push(`(content LIKE ? OR key LIKE ?)`)
    const q = `%${filter.search}%`
    args.push(q, q)
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const limit = filter.limit ?? 200
  const offset = filter.offset ?? 0

  const rows = db.prepare(
    `SELECT * FROM memory_items ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
  ).all(...args, limit, offset) as Record<string, unknown>[]

  return rows.map(rowToItem)
}

export function deleteMemoryItem(id: string): boolean {
  const result = getDB().prepare(`DELETE FROM memory_items WHERE id = ?`).run(id)
  if (result.changes > 0) invalidateIdfCache()
  return result.changes > 0
}

export function pinMemoryItem(id: string, pinned: boolean): boolean {
  const result = getDB().prepare(`UPDATE memory_items SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, id)
  return result.changes > 0
}

export function updateMemoryItemImportance(id: string, importance: number): boolean {
  const clamped = Math.max(0, Math.min(1, importance))
  const result = getDB().prepare(`UPDATE memory_items SET importance = ? WHERE id = ?`).run(clamped, id)
  return result.changes > 0
}
