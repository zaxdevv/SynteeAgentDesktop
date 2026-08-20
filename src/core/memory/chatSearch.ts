/**
 * chatSearch — поиск по истории чатов для recall_memory.
 *
 * 4 источника (параллельно с MemoryStore.searchMemory):
 *   - messages (FTS5 trigram + bm25)
 *   - chat_summaries (LIKE, scope filter)
 *   - agent_logs (LIKE, recent 14 дней)
 *   - pinned_messages (FTS5 + pinned boost)
 *
 * Scope-логика: все источники фильтруются по chats.project_id.
 *   - Если projectId задан → только чаты этого проекта
 *   - Если projectId = undefined → только чаты без project_id (IS NULL)
 *
 * Каждая функция возвращает top-K результатов с normalized score 0..1,
 * content truncate до MAX_CONTENT_CHARS. Унифицированный формат SearchSourceResult.
 */

import { getDB } from '../db/handle'

// ─── Типы ────────────────────────────────────────────────────────────────────

export type SearchSourceName = 'memory' | 'messages' | 'summaries' | 'agent_logs' | 'pinned'

export interface SearchSourceResult {
  source: SearchSourceName
  content: string
  score: number // 0..1 (normalized для сравнения между источниками)
  // Метаданные (только для messages/pinned):
  chatId?: string
  chatTitle?: string
  messageId?: string
  role?: string
  date?: number
}

const MAX_CONTENT_CHARS = 600
const DEFAULT_LIMIT = 5

// ─── Хелперы ─────────────────────────────────────────────────────────────────

function truncate(text: string, max = MAX_CONTENT_CHARS): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

/**
 * Экранирует спецсимволы FTS5 в запросе.
 * Trigram токенайзер чувствителен к кавычкам и спецсимволам — оборачиваем в кавычки.
 * Если запрос короче 3 символов — возвращаем NULL (trigram не сработает, нужен LIKE fallback).
 *
 * Для длинных запросов (>60 символов) разбиваем на ключевые слова через OR —
 * это улучшает поиск: вместо точного совпадения длинной фразы, ищем совпадения
 * по отдельным словам, что даёт больше релевантных результатов.
 *
 * Экспортируется для search.ts (FTS-канал по memory_fts).
 */
export function sanitizeFtsQuery(query: string): string | null {
  const trimmed = query.trim()
  if (trimmed.length < 3) return null
  // Удаляем двойные кавычки (FTS5 строковый разделитель)
  const cleaned = trimmed.replace(/"/g, ' ').trim()
  if (cleaned.length < 3) return null

  // Для длинных запросов — разбиваем на слова и ищем через OR
  // Это даёт больше результатов (не требует точного совпадения всей фразы)
  if (cleaned.length > 60) {
    const words = cleaned.split(/\s+/)
      .filter(w => w.length >= 3) // trigram требует минимум 3 символа
      .slice(0, 8) // не больше 8 слов (FTS5 лимит)
    if (words.length === 0) return null
    if (words.length === 1) return `"${words[0]}"`
    // OR-запрос: каждое слово как phrase
    return words.map(w => `"${w}"`).join(' OR ')
  }

  // Для коротких запросов — phrase query (точная подстрока)
  return `"${cleaned}"`
}

/** Scope filter для JOIN с chats. Возвращает [whereClause, args[]]. */
function scopeFilter(projectId?: string, crossProject?: boolean): { where: string; args: unknown[] } {
  if (crossProject) {
    return { where: `1=1`, args: [] }
  }
  if (projectId) {
    return { where: `c.project_id = ?`, args: [projectId] }
  }
  return { where: `c.project_id IS NULL`, args: [] }
}

// ─── 1. MESSAGES (FTS5) ──────────────────────────────────────────────────────

/**
 * Полнотекстовый поиск по сообщениям через FTS5 trigram.
 * Использует bm25() для ранжирования. Score нормализуется через сигмоиду.
 *
 * Fallback на LIKE если запрос < 3 символов (trigram требует ≥3).
 */
export function searchMessagesFTS(query: string, projectId?: string, limit = DEFAULT_LIMIT, crossProject = false): SearchSourceResult[] {
  const db = getDB()
  const ftsQuery = sanitizeFtsQuery(query)
  const scope = scopeFilter(projectId, crossProject)

  let rows: Array<{
    message_id: string
    chat_id: string
    role: string
    created_at: number
    content: string
    title: string
    bm25_score: number
  }>

  try {
    if (ftsQuery) {
      // FTS5 + bm25 ранжирование. bm25 возвращает отрицательные значения (меньше = релевантнее),
      // инвертируем через -bm25 и нормализуем.
      rows = db.prepare(
        `SELECT mfts.message_id, mfts.chat_id, mfts.role, mfts.created_at,
                mfts.content, c.title,
                bm25(messages_fts) as bm25_score
         FROM messages_fts mfts
         JOIN chats c ON c.id = mfts.chat_id
         WHERE messages_fts MATCH ? AND ${scope.where}
         ORDER BY bm25_score
         LIMIT ?`
      ).all(ftsQuery, ...scope.args, limit) as typeof rows
    } else {
      // Fallback: LIKE для коротких запросов (< 3 символов)
      const likePattern = `%${query.trim().toLowerCase()}%`
      rows = db.prepare(
        `SELECT m.id as message_id, m.chat_id, m.role, m.created_at,
                m.content, c.title,
                0.0 as bm25_score
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
         WHERE LOWER(m.content) LIKE ? AND ${scope.where}
         ORDER BY m.created_at DESC
         LIMIT ?`
      ).all(likePattern, ...scope.args, limit) as typeof rows
    }
  } catch {
    // FTS5 может упасть на сложном запросе — fallback на LIKE
    const likePattern = `%${query.trim().toLowerCase()}%`
    rows = db.prepare(
      `SELECT m.id as message_id, m.chat_id, m.role, m.created_at,
              m.content, c.title,
              0.0 as bm25_score
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE LOWER(m.content) LIKE ? AND ${scope.where}
       ORDER BY m.created_at DESC
       LIMIT ?`
    ).all(likePattern, ...scope.args, limit) as typeof rows
  }

  if (rows.length === 0) return []

  // Нормализуем score: bm25 отрицательный, чем ближе к 0 тем релевантнее.
  // Конвертируем в 0..1 через сигмоиду. Для LIKE-fallback — фиксированный score.
  let maxBm25 = -Infinity
  let minBm25 = Infinity
  for (const r of rows) {
    if (r.bm25_score > maxBm25) maxBm25 = r.bm25_score
    if (r.bm25_score < minBm25) minBm25 = r.bm25_score
  }
  const range = maxBm25 - minBm25

  return rows.map(r => {
    let normalized: number
    if (ftsQuery && range > 0) {
      // -bm25 (больше = релевантнее), нормализуем в [0..1]
      const inverted = -r.bm25_score
      const invertedMax = -minBm25
      const invertedMin = -maxBm25
      normalized = (inverted - invertedMin) / (invertedMax - invertedMin)
    } else if (ftsQuery) {
      normalized = 0.7 // все одинаковые — даём базовый score
    } else {
      normalized = 0.3 // LIKE fallback — низкий score
    }
    return {
      source: 'messages' as const,
      content: truncate(r.content),
      score: Math.max(0, Math.min(1, normalized)),
      chatId: r.chat_id,
      chatTitle: r.title,
      messageId: r.message_id,
      role: r.role,
      date: r.created_at,
    }
  })
}

// ─── 2. CHAT_SUMMARIES (FTS5 + LIKE fallback) ───────────────────────────────

/**
 * Поиск по компактным резюме чатов (chat_summaries) через FTS5 trigram.
 * Резюме — сжатые итоги длинных диалогов, часто содержат ключевые решения
 * и архитектурные контексты. bm25() для ранжирования.
 *
 * FTS5 даёт морфологию ('авториз' → 'авторизация') и поиск по подстрокам,
 * что критично для русского. LIKE fallback для запросов < 3 символов.
 * Recency boost: свежие резюме чуть выше (0.15).
 */
export function searchChatSummaries(query: string, projectId?: string, limit = DEFAULT_LIMIT, crossProject = false): SearchSourceResult[] {
  const db = getDB()
  const ftsQuery = sanitizeFtsQuery(query)
  const scope = scopeFilter(projectId, crossProject)

  let rows: Array<{
    content: string
    updated_at: number
    chat_id: string
    title: string
    bm25_score: number
  }>

  try {
    if (ftsQuery) {
      rows = db.prepare(
        `SELECT csfts.content, csfts.chat_id, cs.updated_at, c.title,
                bm25(chat_summaries_fts) as bm25_score
         FROM chat_summaries_fts csfts
         JOIN chats c ON c.id = csfts.chat_id
         JOIN chat_summaries cs ON cs.chat_id = csfts.chat_id
         WHERE chat_summaries_fts MATCH ? AND ${scope.where}
         ORDER BY bm25_score
         LIMIT ?`
      ).all(ftsQuery, ...scope.args, limit) as typeof rows
    } else {
      const likePattern = `%${query.trim().toLowerCase()}%`
      rows = db.prepare(
        `SELECT cs.content, cs.updated_at, cs.chat_id, c.title,
                0.0 as bm25_score
         FROM chat_summaries cs
         JOIN chats c ON c.id = cs.chat_id
         WHERE LOWER(cs.content) LIKE ? AND ${scope.where}
         ORDER BY cs.updated_at DESC
         LIMIT ?`
      ).all(likePattern, ...scope.args, limit) as typeof rows
    }
  } catch {
    // FTS5 может упасть на сложном запросе — fallback на LIKE
    const likePattern = `%${query.trim().toLowerCase()}%`
    rows = db.prepare(
      `SELECT cs.content, cs.updated_at, cs.chat_id, c.title,
              0.0 as bm25_score
       FROM chat_summaries cs
       JOIN chats c ON c.id = cs.chat_id
       WHERE LOWER(cs.content) LIKE ? AND ${scope.where}
       ORDER BY cs.updated_at DESC
       LIMIT ?`
    ).all(likePattern, ...scope.args, limit) as typeof rows
  }

  if (rows.length === 0) return []

  // Нормализуем score: bm25 отрицательный, инвертируем и масштабируем в 0..1.
  let maxBm25 = -Infinity
  let minBm25 = Infinity
  for (const r of rows) {
    if (r.bm25_score > maxBm25) maxBm25 = r.bm25_score
    if (r.bm25_score < minBm25) minBm25 = r.bm25_score
  }
  const range = maxBm25 - minBm25

  const now = Date.now()
  const RECENT_WINDOW = 30 * 24 * 60 * 60 * 1000 // 30 дней

  return rows.map(r => {
    let normalized: number
    if (ftsQuery && range > 0) {
      const inverted = -r.bm25_score
      const invertedMax = -minBm25
      const invertedMin = -maxBm25
      normalized = (inverted - invertedMin) / (invertedMax - invertedMin)
    } else if (ftsQuery) {
      normalized = 0.65 // все одинаковые — базовый score для FTS5
    } else {
      normalized = 0.3 // LIKE fallback — низкий score
    }
    // Recency boost: свежие резюме чуть выше (до +0.15)
    const age = now - r.updated_at
    const recencyBoost = Math.max(0, 1 - age / RECENT_WINDOW) * 0.15
    return {
      source: 'summaries' as const,
      content: truncate(r.content),
      score: Math.max(0, Math.min(1, normalized + recencyBoost)),
      chatId: r.chat_id,
      chatTitle: r.title,
      date: r.updated_at,
    }
  })
}

// ─── 3. AGENT_LOGS (LIKE) ────────────────────────────────────────────────────

/**
 * Поиск по логам действий агента (agent_logs).
 * Ищет по tool name, args (JSON), result, error. Помогает найти «что агент делал».
 *
 * Ограничение: последние 14 дней (pruneOldAgentLogs удаляет старые).
 */
export function searchAgentLogs(query: string, projectId?: string, limit = DEFAULT_LIMIT, crossProject = false): SearchSourceResult[] {
  const db = getDB()
  const likePattern = `%${query.trim().toLowerCase()}%`
  const scope = scopeFilter(projectId, crossProject)
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000

  const rows = db.prepare(
    `SELECT al.tool, al.args, al.result, al.error, al.created_at,
            al.chat_id, c.title
     FROM agent_logs al
     LEFT JOIN chats c ON c.id = al.chat_id
     WHERE (LOWER(COALESCE(al.tool, '')) LIKE ?
            OR LOWER(COALESCE(al.args, '')) LIKE ?
            OR LOWER(COALESCE(al.result, '')) LIKE ?
            OR LOWER(COALESCE(al.error, '')) LIKE ?)
       AND ${scope.where}
       AND al.created_at > ?
     ORDER BY al.created_at DESC
     LIMIT ?`
  ).all(likePattern, likePattern, likePattern, likePattern, ...scope.args, cutoff, limit) as Array<{
    tool: string | null
    args: string | null
    result: string | null
    error: string | null
    created_at: number
    chat_id: string | null
    title: string | null
  }>

  if (rows.length === 0) return []

  // Score: error matches приоритетнее (0.8), result matches (0.6), args/tool (0.4)
  const q = query.trim().toLowerCase()
  return rows.map(r => {
    let score = 0.4 // базовый
    if (r.error && r.error.toLowerCase().includes(q)) score = 0.8
    else if (r.result && r.result.toLowerCase().includes(q)) score = 0.6

    // Формируем content: tool + result/error (args могут быть огромными — truncate жёстче)
    const parts: string[] = []
    if (r.tool) parts.push(`[${r.tool}]`)
    if (r.error) parts.push(`ERROR: ${r.error}`)
    else if (r.result) parts.push(r.result)
    const content = parts.join(' ')

    return {
      source: 'agent_logs' as const,
      content: truncate(content),
      score,
      chatId: r.chat_id ?? undefined,
      chatTitle: r.title ?? undefined,
      date: r.created_at,
    }
  })
}

// ─── 4. PINNED_MESSAGES (FTS5 + boost) ───────────────────────────────────────

/**
 * Поиск по закреплённым сообщениям (pinned_messages + messages + FTS5).
 * Закреплённые = пользователь отметил как важные. Score boost +0.2.
 */
export function searchPinnedMessages(query: string, projectId?: string, limit = DEFAULT_LIMIT, crossProject = false): SearchSourceResult[] {
  const db = getDB()
  const ftsQuery = sanitizeFtsQuery(query)
  const scope = scopeFilter(projectId, crossProject)

  let rows: Array<{
    message_id: string
    chat_id: string
    role: string
    created_at: number
    content: string
    title: string
    bm25_score: number
  }>

  try {
    if (ftsQuery) {
      rows = db.prepare(
        `SELECT mfts.message_id, mfts.chat_id, mfts.role, mfts.created_at,
                mfts.content, c.title,
                bm25(messages_fts) as bm25_score
         FROM messages_fts mfts
         JOIN pinned_messages pm ON pm.message_id = mfts.message_id
         JOIN chats c ON c.id = mfts.chat_id
         WHERE messages_fts MATCH ? AND ${scope.where}
         ORDER BY bm25_score
         LIMIT ?`
      ).all(ftsQuery, ...scope.args, limit) as typeof rows
    } else {
      const likePattern = `%${query.trim().toLowerCase()}%`
      rows = db.prepare(
        `SELECT m.id as message_id, m.chat_id, m.role, m.created_at,
                m.content, c.title,
                0.0 as bm25_score
         FROM messages m
         JOIN pinned_messages pm ON pm.message_id = m.id
         JOIN chats c ON c.id = m.chat_id
         WHERE LOWER(m.content) LIKE ? AND ${scope.where}
         ORDER BY m.created_at DESC
         LIMIT ?`
      ).all(likePattern, ...scope.args, limit) as typeof rows
    }
  } catch {
    // FTS5 fallback на LIKE
    const likePattern = `%${query.trim().toLowerCase()}%`
    rows = db.prepare(
      `SELECT m.id as message_id, m.chat_id, m.role, m.created_at,
              m.content, c.title,
              0.0 as bm25_score
       FROM messages m
       JOIN pinned_messages pm ON pm.message_id = m.id
       JOIN chats c ON c.id = m.chat_id
       WHERE LOWER(m.content) LIKE ? AND ${scope.where}
       ORDER BY m.created_at DESC
       LIMIT ?`
    ).all(likePattern, ...scope.args, limit) as typeof rows
  }

  if (rows.length === 0) return []

  let maxBm25 = -Infinity
  let minBm25 = Infinity
  for (const r of rows) {
    if (r.bm25_score > maxBm25) maxBm25 = r.bm25_score
    if (r.bm25_score < minBm25) minBm25 = r.bm25_score
  }
  const range = maxBm25 - minBm25

  return rows.map(r => {
    let normalized: number
    if (ftsQuery && range > 0) {
      const inverted = -r.bm25_score
      const invertedMax = -minBm25
      const invertedMin = -maxBm25
      normalized = (inverted - invertedMin) / (invertedMax - invertedMin)
    } else if (ftsQuery) {
      normalized = 0.7
    } else {
      normalized = 0.3
    }
    // Pinned boost: +0.2 (но не больше 1)
    normalized = Math.min(1, normalized + 0.2)
    return {
      source: 'pinned' as const,
      content: truncate(r.content),
      score: Math.max(0, Math.min(1, normalized)),
      chatId: r.chat_id,
      chatTitle: r.title,
      messageId: r.message_id,
      role: r.role,
      date: r.created_at,
    }
  })
}
