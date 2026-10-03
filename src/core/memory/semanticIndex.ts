/**
 * semanticIndex — фоновая E5-индексация всех источников recall_memory.
 *
 * Индексирует 5 источников в таблицу semantic_embeddings (384-dim E5):
 *   1. memory_items      → text = "title. content"            (id)
 *   2. messages          → text = content (user/assistant)    (id)
 *   3. chat_summaries    → text = content                     (chat_id)
 *   4. agent_logs        → text = "[tool] ERROR: … | result"  (id)
 *   5. pinned_messages   → text = content сообщения           (message_id)
 *
 * Source texts и роли совпадают с тем, что ищут chatSearch.ts / search.ts —
 * чтобы эмбеддинги и lexical-поиск видели один и тот же корпус.
 *
 * Свойства:
 *   - Идемпотентно: sha256(content) + model в semantic_embeddings; неизменённые
 *     строки пропускаются — на каждом цикле эмбеддятся только новые/изменённые.
 *   - Не блокирует startup/IPC: первый запуск через START_DELAY_MS, далее
 *     периодически; между записями sleep (event loop дышит, IPC отвечают).
 *   - Keyset-пагинация (WHERE id > ? ORDER BY id LIMIT ?) — память bounded,
 *     messages может быть 100k+ строк.
 *   - Защита от параллельных запусков: _running-флаг, повторный вызов no-op.
 *   - stop/start: stopSemanticIndexer() снимает таймеры + флаг _stopRequested
 *     (текущий цикл доезжает до ближайшей проверки и выходит) + disposeE5Embedder.
 *   - Fallback: если E5-модель недоступна (нет сети/ONNX) — цикл пропускается,
 *     текущий TF-IDF/FTS поиск работает как раньше. Ошибки отдельных строк
 *     не прерывают цикл.
 *   - Orphan cleanup: эмбеддинги удалённых строк источников вычищаются
 *     (agent_logs прунятся через 14 дней, messages удаляются при rewind).
 *
 * ВАЖНО: индексер и поиск живут в одном модуле. searchSemanticSources() —
 * E5 query embedding + cosine ranking по semantic_embeddings с теми же
 * scope/project/kind фильтрами, что lexical-канал (chatSearch/search.ts).
 * Hybrid-merge semantic+lexical кандидатов — в searchAllSources (search.ts).
 */

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDB } from '../db/handle'
import {
  getReadyE5Embedder,
  disposeE5Embedder,
  embeddingToBuffer,
  cosineSimilarity,
  bufferToEmbedding,
  type E5Embedder,
  type Embedding,
} from '../context/embeddings'
import { rowToItem, type MemoryKind, type MultiSourceResult } from './store/_shared'

// ─── Типы ────────────────────────────────────────────────────────────────────

/** Источники semantic-индексации — зеркалят SearchSourceName из chatSearch.ts. */
export type SemanticSourceName = 'memory' | 'messages' | 'summaries' | 'agent_logs' | 'pinned'

const SEMANTIC_SOURCES: SemanticSourceName[] = ['memory', 'messages', 'summaries', 'agent_logs', 'pinned']

// ─── Конфиг ──────────────────────────────────────────────────────────────────

/** Задержка первого запуска после start — не блокировать startup. */
const START_DELAY_MS = 30_000
/** Периодический реиндекс (ловит новые сообщения/логи). */
const REINDEX_INTERVAL_MS = 15 * 60 * 1000
/** Строк на страницу (keyset-пагинация) — bounded память. */
const PAGE_SIZE = 200
/** Пауза после каждого эмбеддинга — event loop / IPC не голодают. */
const PAUSE_BETWEEN_ITEMS_MS = 15
/** Пауза между страницами — даже если всё skipped (просто читали хэши). */
const PAUSE_BETWEEN_PAGES_MS = 250
/**
 * E5 лимит ~512 токенов; для RU/EN ~3 символа/токен → 1500 символов с запасом.
 * Хэш считается от усечённого текста — стабильные инвалидиции.
 */
const MAX_TEXT_CHARS = 1500

// ─── Состояние ───────────────────────────────────────────────────────────────

let _startTimer: NodeJS.Timeout | null = null
let _interval: NodeJS.Timeout | null = null
let _running = false
let _stopRequested = false
let _started = false

// ─── Хелперы ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

interface SourceRow {
  /** PK строки источника (memory_items.id / messages.id / chat_id / message_id). */
  id: string
  /** Текст для эмбеддинга (уже собранный, как в chatSearch). */
  text: string
}

/**
 * Одна страница строк источника (keyset-пагинация по id, ASC).
 * Тексты собираем из тех же полей, что ищут chatSearch.ts / search.ts.
 */
function fetchSourcePage(
  source: SemanticSourceName,
  db: Database.Database,
  afterId: string | null,
  limit: number,
): SourceRow[] {
  const after = afterId ?? ''
  switch (source) {
    case 'memory': {
      // title + content — search.ts матчит и content, и title (LIKE boost).
      const rows = db.prepare(
        `SELECT id, title, content FROM memory_items WHERE id > ? ORDER BY id ASC LIMIT ?`
      ).all(after, limit) as Array<{ id: string; title: string | null; content: string }>
      return rows.map(r => ({ id: r.id, text: `${r.title ?? ''}. ${r.content}`.trim() }))
    }
    case 'messages': {
      // user/assistant — как FTS-триггеры messages_fts_ai индексируют роли;
      // system-сообщения (разделители компакции) семантически бесполезны.
      const rows = db.prepare(
        `SELECT id, content FROM messages WHERE id > ? AND role IN ('user','assistant') ORDER BY id ASC LIMIT ?`
      ).all(after, limit) as Array<{ id: string; content: string }>
      return rows.map(r => ({ id: r.id, text: r.content }))
    }
    case 'summaries': {
      const rows = db.prepare(
        `SELECT chat_id AS id, content FROM chat_summaries WHERE chat_id > ? ORDER BY chat_id ASC LIMIT ?`
      ).all(after, limit) as Array<{ id: string; content: string }>
      return rows.map(r => ({ id: r.id, text: r.content }))
    }
    case 'agent_logs': {
      // Include a bounded args fragment: lexical search also checks args, and
      // technical identifiers often live there (file paths, tool parameters).
      const rows = db.prepare(
        `SELECT id, tool, args, result, error FROM agent_logs WHERE id > ? ORDER BY id ASC LIMIT ?`
      ).all(after, limit) as Array<{
        id: string
        tool: string | null
        args: string | null
        result: string | null
        error: string | null
      }>
      return rows.map(r => {
        const parts: string[] = []
        if (r.tool) parts.push(`[${r.tool}]`)
        if (r.args) parts.push(`ARGS: ${r.args.slice(0, 700)}`)
        if (r.error) parts.push(`ERROR: ${r.error}`)
        else if (r.result) parts.push(r.result)
        return { id: r.id, text: parts.join(' ') }
      })
    }
    case 'pinned': {
      const rows = db.prepare(
        `SELECT pm.message_id AS id, m.content
         FROM pinned_messages pm
         JOIN messages m ON m.id = pm.message_id
         WHERE pm.message_id > ? ORDER BY pm.message_id ASC LIMIT ?`
      ).all(after, limit) as Array<{ id: string; content: string }>
      return rows.map(r => ({ id: r.id, text: r.content }))
    }
  }
}

/** Удаляет эмбеддинги строк, которых больше нет в источнике (prune/rewind). */
function cleanupOrphans(source: SemanticSourceName, db: Database.Database): number {
  const sourceTable: Record<SemanticSourceName, string> = {
    memory: `(SELECT id FROM memory_items)`,
    messages: `(SELECT id FROM messages)`,
    summaries: `(SELECT chat_id FROM chat_summaries)`,
    agent_logs: `(SELECT id FROM agent_logs)`,
    pinned: `(SELECT message_id FROM pinned_messages)`,
  }
  try {
    const info = db.prepare(
      `DELETE FROM semantic_embeddings WHERE source = ? AND source_id NOT IN ${sourceTable[source]}`
    ).run(source)
    return info.changes
  } catch {
    return 0
  }
}

// ─── Индексация одного источника ─────────────────────────────────────────────

interface SourceStats {
  indexed: number
  skipped: number
  failed: number
}

async function indexSource(
  source: SemanticSourceName,
  embedder: E5Embedder,
): Promise<SourceStats> {
  const db = getDB()
  const selectExisting = db.prepare(
    `SELECT content_hash, model FROM semantic_embeddings WHERE source = ? AND source_id = ?`
  )
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO semantic_embeddings
       (source, source_id, content_hash, embedding, model, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )

  const stats: SourceStats = { indexed: 0, skipped: 0, failed: 0 }
  let afterId: string | null = null

  for (;;) {
    if (_stopRequested) return stats

    const rows = fetchSourcePage(source, db, afterId, PAGE_SIZE)
    if (rows.length === 0) break
    afterId = rows[rows.length - 1].id

    for (const row of rows) {
      if (_stopRequested) return stats

      const text = row.text.slice(0, MAX_TEXT_CHARS).trim()
      if (!text) {
        stats.skipped++
        continue
      }

      // Не переэмбеддим неизменённое: hash совпал + та же модель.
      const hash = sha256(text)
      const existing = selectExisting.get(source, row.id) as
        | { content_hash: string; model: string }
        | undefined
      if (existing && existing.content_hash === hash && existing.model === embedder.model) {
        stats.skipped++
        continue
      }

      try {
        const emb = await embedder.embedPassage(text)
        upsert.run(source, row.id, hash, embeddingToBuffer(emb), embedder.model, Date.now())
        stats.indexed++
      } catch {
        // Ошибка одной строки (слишком длинный/битый текст) не валит цикл.
        stats.failed++
      }

      // Пауза только после реального эмбеддинга — skipped-скан не спит
      // (полный проход по 100k сообщений занимает секунды, не часы).
      await sleep(PAUSE_BETWEEN_ITEMS_MS)
    }

    if (rows.length < PAGE_SIZE) break
    await sleep(PAUSE_BETWEEN_PAGES_MS)
  }

  const orphans = cleanupOrphans(source, db)
  if (orphans > 0) {
    console.log(`[semanticIndex] ${source}: cleaned ${orphans} orphaned embeddings`)
  }
  return stats
}

// ─── Публичный API ───────────────────────────────────────────────────────────

/**
 * Один цикл индексации всех 5 источников. Идемпотентен, защищён от
 * параллельных запусков (_running). Ошибки глотаются с warn — фоновый
 * процесс не должен падать и не должен ломать основной поиск.
 */
export async function runSemanticIndexingOnce(): Promise<void> {
  if (_running) {
    console.log('[semanticIndex] cycle already running — skip')
    return
  }
  _running = true
  _stopRequested = false
  try {
    // Background indexing is the only path allowed to initialize/download E5.
    // recall_memory uses getReadyE5Embedder() and never blocks on model startup.
    const { getE5Embedder } = await import('../context/embeddings')
    const embedder = await getE5Embedder()
    if (!embedder) {
      // Модель недоступна (нет сети / ONNX упал). Не ошибка: lexical/TF-IDF
      // поиск работает как раньше. До перезапуска приложения не ретраим.
      console.log('[semanticIndex] E5 embedder unavailable — skipping cycle (lexical search unaffected)')
      return
    }

    const startedAt = Date.now()
    for (const source of SEMANTIC_SOURCES) {
      if (_stopRequested) break
      try {
        const stats = await indexSource(source, embedder)
        if (stats.indexed > 0 || stats.failed > 0) {
          console.log(
            `[semanticIndex] ${source}: +${stats.indexed} indexed, ${stats.skipped} unchanged, ${stats.failed} failed (${Date.now() - startedAt}ms elapsed)`
          )
        }
      } catch (e) {
        console.warn(`[semanticIndex] source '${source}' failed:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    console.warn('[semanticIndex] cycle failed:', e instanceof Error ? e.message : e)
  } finally {
    _running = false
  }
}

/**
 * Запускает фоновую индексацию: первый цикл через START_DELAY_MS (не блокирует
 * startup), далее каждые REINDEX_INTERVAL_MS. Повторный вызов — no-op.
 * Вызывается из registerMemoryIPC; сами циклы не блокируют IPC-хендлеры
 * (async + sleep-паузы между эмбеддингами).
 */
export function startSemanticIndexer(): void {
  if (_started) return
  _started = true
  _stopRequested = false

  _startTimer = setTimeout(() => {
    _startTimer = null
    void runSemanticIndexingOnce()
    _interval = setInterval(() => {
      void runSemanticIndexingOnce()
    }, REINDEX_INTERVAL_MS)
    _interval.unref?.()
  }, START_DELAY_MS)
  _startTimer.unref?.()
}

/**
 * Останавливает индексатор: снимает таймеры, выставляет _stopRequested
 * (текущий цикл доедет до ближайшей проверки и выйдет), освобождает E5 ONNX
 * pipeline. Вызывается из main/index.ts before-quit.
 */
export function stopSemanticIndexer(): void {
  _stopRequested = true
  _started = false
  if (_startTimer) {
    clearTimeout(_startTimer)
    _startTimer = null
  }
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
  disposeE5Embedder()
}

/** Текущее состояние (для диагностики/UI-статуса). */
export function getSemanticIndexerStatus(): {
  started: boolean
  running: boolean
  stopRequested: boolean
} {
  return { started: _started, running: _running, stopRequested: _stopRequested }
}

// ─── SEMANTIC SEARCH (E5 query → cosine ranking) ─────────────────────────────

export interface SemanticSearchOptions {
  /** Какие источники искать. Default: все 5. */
  sources?: SemanticSourceName[]
  /**
   * Scope-фильтр memory_items — зеркалит SearchMemoryParams.scope
   * ('global' | 'project' | 'chat' | 'all'). Default: 'all'.
   */
  scope?: 'global' | 'project' | 'chat' | 'all'
  /** Проект для scope-фильтров (memory + chat-источники). */
  projectId?: string
  /** kind-фильтр memory_items (как SearchMemoryParams.kind). */
  kind?: MemoryKind
  /** Chat-источники: искать во всех проектах (как chatSearch crossProject). */
  crossProject?: boolean
  /** Top-K кандидатов на источник. Default: 5. */
  limit?: number
}

/**
 * Верхняя граница сканируемых строк на источник: cosine считается в JS по
 * BLOB-векторам, скан обязан быть bounded (память ≤ cap × 1.5KB, время
 * ≤ cap × ~2µs). Для типичных БД это полный скан источника; для гигантских —
 * обрезка: memory по importance (как top-500 в searchMemory), chat-источники
 * по recency (как ORDER BY created_at в chatSearch LIKE-fallback).
 */
const SEMANTIC_SCAN_CAPS: Record<SemanticSourceName, number> = {
  memory: 4000,
  messages: 10000,
  summaries: 2000,
  agent_logs: 3000,
  pinned: 2000,
}

/** Content truncate — тот же лимит, что MAX_CONTENT_CHARS в chatSearch.ts. */
const SEMANTIC_MAX_CONTENT_CHARS = 600

function truncateContent(text: string): string {
  return text.length <= SEMANTIC_MAX_CONTENT_CHARS
    ? text
    : text.slice(0, SEMANTIC_MAX_CONTENT_CHARS) + '…'
}

/**
 * Scope WHERE для memory_items — точная копия логики searchMemory (search.ts):
 * semantic-канал обязан видеть ровно тот же набор строк, что lexical.
 */
function memoryScopeWhere(
  scope: 'global' | 'project' | 'chat' | 'all' | undefined,
  projectId: string | undefined,
  crossProject = false,
): { where: string; args: unknown[] } {
  if (crossProject) return { where: `1=1`, args: [] }
  if (scope === 'global') return { where: `mi.scope = 'global'`, args: [] }
  if ((scope === 'project' || scope === 'chat') && projectId) {
    return { where: `mi.scope = 'project' AND mi.project_id = ?`, args: [projectId] }
  }
  // 'all' (default) / 'project'|'chat' без projectId — как в searchMemory
  return {
    where: `(mi.scope = 'global' OR (mi.scope = 'project' AND mi.project_id = ?))`,
    args: [projectId ?? '__none__'],
  }
}

/** Scope WHERE для chat-источников (JOIN chats c) — копия chatSearch.scopeFilter. */
function chatScopeWhere(
  crossProject: boolean | undefined,
  projectId: string | undefined,
): { where: string; args: unknown[] } {
  if (crossProject) return { where: `1=1`, args: [] }
  if (projectId) return { where: `c.project_id = ?`, args: [projectId] }
  return { where: `c.project_id IS NULL`, args: [] }
}

/** Строка-кандидат semantic-канала: PK + вектор + content + метаданные. */
interface SemanticRow {
  sourceId: string
  embedding: Buffer
  content: string
  chatId?: string | null
  chatTitle?: string | null
  role?: string | null
  date?: number
  /** Полная строка memory_items (mi.*) — для item в MultiSourceResult. */
  memoryRow?: Record<string, unknown>
}

interface SemanticFetchOptions {
  scope: 'global' | 'project' | 'chat' | 'all' | undefined
  projectId: string | undefined
  crossProject: boolean | undefined
  kind: MemoryKind | undefined
}

/**
 * Кандидаты одного источника: semantic_embeddings JOIN таблица источника
 * (scope/kind фильтры + se.model = ? — не смешиваем векторы разных моделей).
 * Вся параметризация — placeholders; ORDER BY + LIMIT держат скан bounded.
 */
function fetchSemanticRows(
  source: SemanticSourceName,
  db: Database.Database,
  model: string,
  opts: SemanticFetchOptions,
): SemanticRow[] {
  const cap = SEMANTIC_SCAN_CAPS[source]
  switch (source) {
    case 'memory': {
      const scope = memoryScopeWhere(opts.scope, opts.projectId, opts.crossProject)
      const kindWhere = opts.kind ? `AND mi.kind = ?` : ''
      const kindArgs = opts.kind ? [opts.kind] : []
      const rows = db.prepare(
        `SELECT se.source_id, se.embedding, mi.*
         FROM semantic_embeddings se
         JOIN memory_items mi ON mi.id = se.source_id
         WHERE se.source = 'memory' AND se.model = ? AND ${scope.where} ${kindWhere}
         ORDER BY mi.importance DESC
         LIMIT ?`
      ).all(model, ...scope.args, ...kindArgs, cap) as Array<Record<string, unknown>>
      return rows.map(r => ({
        sourceId: r.source_id as string,
        embedding: r.embedding as Buffer,
        // memory content не усекаем — searchMemory тоже возвращает полный content
        content: r.content as string,
        memoryRow: r,
      }))
    }
    case 'messages': {
      const scope = chatScopeWhere(opts.crossProject, opts.projectId)
      const rows = db.prepare(
        `SELECT se.source_id, se.embedding, m.content, m.role, m.chat_id, c.title, m.created_at
         FROM semantic_embeddings se
         JOIN messages m ON m.id = se.source_id
         JOIN chats c ON c.id = m.chat_id
         WHERE se.source = 'messages' AND se.model = ? AND ${scope.where}
         ORDER BY m.created_at DESC
         LIMIT ?`
      ).all(model, ...scope.args, cap) as Array<{
        source_id: string; embedding: Buffer; content: string; role: string
        chat_id: string; title: string | null; created_at: number
      }>
      return rows.map(r => ({
        sourceId: r.source_id,
        embedding: r.embedding,
        content: truncateContent(r.content),
        chatId: r.chat_id,
        chatTitle: r.title,
        role: r.role,
        date: r.created_at,
      }))
    }
    case 'summaries': {
      const scope = chatScopeWhere(opts.crossProject, opts.projectId)
      const rows = db.prepare(
        `SELECT se.source_id, se.embedding, cs.content, c.title, cs.updated_at
         FROM semantic_embeddings se
         JOIN chat_summaries cs ON cs.chat_id = se.source_id
         JOIN chats c ON c.id = cs.chat_id
         WHERE se.source = 'summaries' AND se.model = ? AND ${scope.where}
         ORDER BY cs.updated_at DESC
         LIMIT ?`
      ).all(model, ...scope.args, cap) as Array<{
        source_id: string; embedding: Buffer; content: string
        title: string | null; updated_at: number
      }>
      return rows.map(r => ({
        sourceId: r.source_id,
        embedding: r.embedding,
        content: truncateContent(r.content),
        chatId: r.source_id,
        chatTitle: r.title,
        date: r.updated_at,
      }))
    }
    case 'agent_logs': {
      const scope = chatScopeWhere(opts.crossProject, opts.projectId)
      // 14-дневный cutoff — как в searchAgentLogs (старые логи прунятся)
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
      const rows = db.prepare(
        `SELECT se.source_id, se.embedding, al.tool, al.result, al.error, al.created_at, al.chat_id, c.title
         FROM semantic_embeddings se
         JOIN agent_logs al ON al.id = se.source_id
         LEFT JOIN chats c ON c.id = al.chat_id
         WHERE se.source = 'agent_logs' AND se.model = ? AND ${scope.where} AND al.created_at > ?
         ORDER BY al.created_at DESC
         LIMIT ?`
      ).all(model, ...scope.args, cutoff, cap) as Array<{
        source_id: string; embedding: Buffer; tool: string | null; result: string | null
        error: string | null; created_at: number; chat_id: string | null; title: string | null
      }>
      // Content — тот же формат, что searchAgentLogs: "[tool] ERROR: …" / "[tool] result"
      return rows.map(r => {
        const parts: string[] = []
        if (r.tool) parts.push(`[${r.tool}]`)
        if (r.error) parts.push(`ERROR: ${r.error}`)
        else if (r.result) parts.push(r.result)
        return {
          sourceId: r.source_id,
          embedding: r.embedding,
          content: truncateContent(parts.join(' ')),
          chatId: r.chat_id,
          chatTitle: r.title,
          date: r.created_at,
        }
      })
    }
    case 'pinned': {
      const scope = chatScopeWhere(opts.crossProject, opts.projectId)
      const rows = db.prepare(
        `SELECT se.source_id, se.embedding, m.content, m.role, m.chat_id, c.title, m.created_at
         FROM semantic_embeddings se
         JOIN pinned_messages pm ON pm.message_id = se.source_id
         JOIN messages m ON m.id = pm.message_id
         JOIN chats c ON c.id = m.chat_id
         WHERE se.source = 'pinned' AND se.model = ? AND ${scope.where}
         ORDER BY m.created_at DESC
         LIMIT ?`
      ).all(model, ...scope.args, cap) as Array<{
        source_id: string; embedding: Buffer; content: string; role: string
        chat_id: string; title: string | null; created_at: number
      }>
      return rows.map(r => ({
        sourceId: r.source_id,
        embedding: r.embedding,
        content: truncateContent(r.content),
        chatId: r.chat_id,
        chatTitle: r.title,
        role: r.role,
        date: r.created_at,
      }))
    }
  }
}

/**
 * Semantic-поиск по всем источникам recall_memory (E5, cosine).
 *
 * Делает E5 query embedding и ищет кандидатов в semantic_embeddings с теми же
 * scope/project/kind фильтрами, что lexical-канал (chatSearch/search.ts) —
 * оба канала видят один и тот же корпус. Возвращает top-K на источник в
 * формате MultiSourceResult с sourceId и semanticScore (cosine 0..1).
 * Graph НЕ возвращается — граф-экспансия остаётся в searchAllSources.
 *
 * Отказоустойчивость: E5 недоступен / таблицы нет / ошибка SQL / битый BLOB →
 * [] (или пропуск источника) — lexical-канал работает как раньше.
 */
export async function searchSemanticSources(
  query: string,
  options: SemanticSearchOptions = {},
): Promise<MultiSourceResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  // Query path uses only an already initialized pipeline; model download/load
  // belongs exclusively to the background indexer, never a chat tool call.
  const embedder = getReadyE5Embedder()
  if (!embedder) return []

  let queryEmb: Embedding
  try {
    queryEmb = await embedder.embedQuery(trimmed)
  } catch {
    return []
  }

  let db: Database.Database
  try {
    db = getDB()
  } catch {
    return []
  }

  const sources = options.sources ?? SEMANTIC_SOURCES
  const limit = Math.max(1, options.limit ?? 5)
  const results: MultiSourceResult[] = []

  for (const source of sources) {
    if (!SEMANTIC_SOURCES.includes(source)) continue
    let rows: SemanticRow[]
    try {
      rows = fetchSemanticRows(source, db, embedder.model, {
        scope: options.scope,
        projectId: options.projectId,
        crossProject: options.crossProject,
        kind: options.kind,
      })
    } catch {
      continue // нет таблицы/индекса у источника — пропускаем, не валим поиск
    }
    if (rows.length === 0) continue

    // Cosine ranking: E5-векторы L2-normalized → dot product.
    const scored: Array<{ row: SemanticRow; cos: number }> = []
    for (const row of rows) {
      try {
        const cos = cosineSimilarity(queryEmb, bufferToEmbedding(row.embedding))
        if (Number.isFinite(cos)) scored.push({ row, cos })
      } catch { /* битый BLOB — пропускаем строку */ }
    }
    scored.sort((a, b) => b.cos - a.cos)

    for (const { row, cos } of scored.slice(0, limit)) {
      const semanticScore = Math.max(0, Math.min(1, cos))
      const res: MultiSourceResult = {
        source,
        sourceId: row.sourceId,
        content: row.content,
        score: semanticScore,
        semanticScore,
      }
      if (source === 'memory' && row.memoryRow) res.item = rowToItem(row.memoryRow)
      if (row.chatId != null) res.chatId = row.chatId
      if (row.chatTitle != null) res.chatTitle = row.chatTitle
      if (row.role != null) res.role = row.role
      if (row.date != null) res.date = row.date
      if (source === 'messages' || source === 'pinned') res.messageId = row.sourceId
      results.push(res)
    }
  }

  return results
}
