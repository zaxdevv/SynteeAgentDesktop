/**
 * _shared.ts — общие типы и внутренние хелперы MemoryStore.
 *
 * Содержит:
 *   - все типы (MemoryItem, SaveMemoryInput, SearchMemoryParams, ...)
 *   - константы (MEMORY_IDF_NAMESPACE, SEMANTIC_MERGE_THRESHOLD)
 *   - внутренние хелперы (embedText, rowToItem, invalidateIdfCache, ensureMemoryIdf)
 */

import { getDB } from '../../db/handle'
import {
  getEmbedder,
  bufferToEmbedding,
  setActiveProjectId,
  updateTfidfIdf,
  type Embedding,
} from '../../context/embeddings'
import type { SearchSourceName } from '../chatSearch'

// ─── Типы ────────────────────────────────────────────────────────────────────

export type MemoryScope = 'global' | 'project' | 'chat'
export type MemoryKind = 'user_fact' | 'project_decision' | 'convention' | 'conversation' | 'agent_outcome'
export type MemorySource =
  | 'user_explicit'    // юзер сказал «запомни»
  | 'agent_tool'       // агент вызвал save_memory
  | 'auto_extract'     // LLM-извлечение из диалога
  | 'compaction'       // синк из chat_summaries
  | 'agent_log'        // извлечение уроков из agent_logs
  | 'legacy_migration' // перенос из старой memory table
  | 'user_manual'      // ручной ввод через UI

export interface MemoryItem {
  id: string
  title: string
  scope: MemoryScope
  projectId: string | null
  chatId: string | null
  kind: MemoryKind
  category: string | null
  key: string | null
  content: string
  source: MemorySource
  confidence: number
  importance: number
  accessCount: number
  lastAccessedAt: number | null
  pinned: boolean
  metadata: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

export interface SaveMemoryInput {
  title: string
  content: string
  kind: MemoryKind
  scope?: MemoryScope // default: 'project' если есть projectId, иначе 'global'
  projectId?: string
  chatId?: string
  category?: string
  key?: string
  source?: MemorySource // default: 'agent_tool'
  confidence?: number // default: 1.0
  importance?: number // default: 0.5
  pinned?: boolean // default: true если source='user_explicit', иначе false
  metadata?: Record<string, unknown>
}

export interface SearchMemoryParams {
  query: string
  kind?: MemoryKind
  /** 'global' | 'project' | 'all' (default: 'all' = global + текущий проект) */
  scope?: MemoryScope | 'all'
  projectId?: string // для scope='project' или 'all'
  limit?: number // default: 8 (для memory_items)
  minScore?: number // default: 0.01
  /**
   * Какие источники искать (multi-source search). Default: все 5.
   * - 'memory'       → memory_items (TF-IDF + importance + recency)
   * - 'messages'     → messages (FTS5 trigram + bm25)
   * - 'summaries'    → chat_summaries (LIKE + recency)
   * - 'agent_logs'   → agent_logs (LIKE, recent 14d)
   * - 'pinned'       → pinned_messages (FTS5 + boost)
   */
  sources?: SearchSourceName[] | 'all'
  /** If true, search across ALL projects (not just current). Default: false. */
  crossProject?: boolean
}

export interface SearchResult {
  item: MemoryItem
  score: number
}

/**
 * Унифицированный результат multi-source поиска. Возвращается searchAllSources.
 * Поле source указывает откуда пришёл результат.
 * Для messages/pinned дополнительно: chatId, chatTitle, messageId, role, date.
 * Для memory: kind, scope, key (внутри item).
 * Для graph: связанные сущности knowledge graph (1-hop соседи найденных
 * memory items) — ассоциативные подсказки, score фиксированный.
 */
export interface MultiSourceResult {
  source: 'memory' | SearchSourceName | 'graph'
  content: string
  score: number // 0..1, normalized для сравнения между источниками
  // Memory-specific (когда source='memory'):
  item?: MemoryItem
  // Messages/pinned-specific:
  chatId?: string
  chatTitle?: string
  messageId?: string
  role?: string
  date?: number
  /**
   * Stable PK строки источника (memory_items.id / messages.id /
   * chat_summaries.chat_id / agent_logs.id / pinned message_id).
   * Ключ hybrid-merge в searchAllSources: semantic + lexical каналы,
   * нашедшие одну и ту же строку, сливаются в один объект.
   */
  sourceId?: string
  /** Cosine (E5) 0..1 — кандидат найден semantic-каналом. */
  semanticScore?: number
  /** Score 0..1 lexical-канала (FTS5/LIKE/TF-IDF) до hybrid-merge. */
  lexicalScore?: number
}

export interface ListMemoryFilter {
  scope?: MemoryScope
  kind?: MemoryKind
  projectId?: string
  category?: string
  search?: string // LIKE по content
  limit?: number
  offset?: number
}

export interface MemoryCategory {
  id: string
  name: string         // машинное имя (lowercase)
  label: string        // человекочитаемое
  icon: string | null  // имя иконки из AppIcon
  color: string | null // hex
  scope: MemoryScope
  projectId: string | null
  kind: MemoryKind | null // фильтр (null = любой)
  createdAt: number
}

// ─── Константы ───────────────────────────────────────────────────────────────

export const MEMORY_IDF_NAMESPACE = '__syntee_memory__'
export const SEMANTIC_MERGE_THRESHOLD = 0.92

// ─── Внутренние хелперы ──────────────────────────────────────────────────────

/** IDF cache для памяти. Строится лениво из всех memory_items.content. */
let _idfBuilt = false

export function invalidateIdfCache(): void {
  _idfBuilt = false
}

function ensureMemoryIdf(): void {
  if (_idfBuilt) return
  try {
    const db = getDB()
    const rows = db.prepare(`SELECT content FROM memory_items`).all() as { content: string }[]
    updateTfidfIdf(
      MEMORY_IDF_NAMESPACE,
      rows.map(r => r.content),
    )
    _idfBuilt = true
  } catch {
    // БД пуста или недоступна — IDF не построен, embed вернёт zero-vector.
    // Не критично: search упадёт на LIKE-fallback, save всё равно запишет.
  }
}

/**
 * Embedding текста в namespace памяти. Синхронно для TF-IDF, async для neural.
 * Важно: setActiveProjectId переключает global IDF cache — FastContext после
 * этого выставит свой projectId, так что конфликтов нет (JS single-threaded).
 */
export async function embedText(text: string): Promise<Embedding> {
  ensureMemoryIdf()
  setActiveProjectId(MEMORY_IDF_NAMESPACE)
  const embedder = await getEmbedder()
  return embedder.embed(text)
}

export function rowToItem(row: Record<string, unknown>): MemoryItem {
  let metadata: Record<string, unknown> | null = null
  if (row.metadata && typeof row.metadata === 'string') {
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown> } catch { /* skip */ }
  }
  return {
    id: row.id as string,
    title: (row.title as string) ?? '',
    scope: row.scope as MemoryScope,
    projectId: (row.project_id as string | null) ?? null,
    chatId: (row.chat_id as string | null) ?? null,
    kind: row.kind as MemoryKind,
    category: (row.category as string | null) ?? null,
    key: (row.key as string | null) ?? null,
    content: row.content as string,
    source: row.source as MemorySource,
    confidence: (row.confidence as number) ?? 1.0,
    importance: (row.importance as number) ?? 0.5,
    accessCount: (row.access_count as number) ?? 0,
    lastAccessedAt: (row.last_accessed_at as number | null) ?? null,
    pinned: Boolean(row.pinned),
    metadata,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }
}

// Re-export Embedding type for consumers that need it
export type { Embedding }
export { bufferToEmbedding }
