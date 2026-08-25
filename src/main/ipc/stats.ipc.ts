/**
 * Stats IPC — локальная статистика использования (Настройки → Статистика).
 *
 * Все агрегаты считаются на стороне SQLite (GROUP BY / json_each), в JS
 * попадают только готовые числа — тащить тысячи строк в renderer незачем.
 *
 *   totals      — сообщения / токены / средняя длительность / тул-коллы
 *   activity    — бакеты: часы (24ч/7д), дни (30д), месяцы (всё время)
 *   byModel     — запросы / in / out / latency по моделям (role='assistant')
 *   topChats    — самые активные чаты (инкогнито исключены)
 *   attachments — вложения по типам (image/file/skill/command) и источникам
 *   links       — URL из текста сообщений: всего / уникальных / топ-домены
 *
 * created_at в messages — миллисекунды (Date.now()), поэтому в strftime
 * делим на 1000 + 'unixepoch' (иначе даты уезжают в 1970-й).
 * Prepared statements кэшируются: better-sqlite3 — prepare дорог, run дешёв.
 */
import { ipcMain } from 'electron'
import type { Statement } from 'better-sqlite3'
import { getDB } from '../../core/db/handle'

// ─── Публичные типы (контракт IPC) ───────────────────────────────────────────

export interface StatsTotals {
  messages: number
  userMessages: number
  assistantMessages: number
  promptTokens: number
  completionTokens: number
  avgDurationMs: number | null
  toolCalls: number
  thinkingMs: number
  chatsCount: number
  projectsCount: number
}

export interface StatsActivityPoint {
  /** 'YYYY-MM-DD HH' | 'YYYY-MM-DD' | 'YYYY-MM' (локальное время) */
  bucket: string
  messages: number
  tokens: number
}

export interface StatsModelRow {
  model: string
  requests: number
  promptTokens: number
  completionTokens: number
  avgDurationMs: number | null
}

export interface StatsChatRow {
  chatId: string
  title: string
  messages: number
  tokens: number
  lastActive: number
}

export interface StatsAttachments {
  total: number
  byKind: { kind: string; count: number }[]
  bySource: { source: string; count: number }[]
  /** Последние вложения для галереи/списка */
  items: StatsAttachmentItem[]
}

export interface StatsAttachmentItem {
  id: string
  kind: string
  name: string
  source: string
  chatId: string
  chatTitle: string
  createdAt: number
  path: string | null
  dataUrl: string | null
  mime: string | null
  size: number | null
}

export interface StatsLinks {
  total: number
  unique: number
  topDomains: { domain: string; count: number }[]
  /** Последние ссылки для списка */
  items: StatsLinkItem[]
}

export interface StatsLinkItem {
  url: string
  chatId: string
  chatTitle: string
  createdAt: number
}

export interface StatsOverview {
  totals: StatsTotals
  activity: StatsActivityPoint[]
  byModel: StatsModelRow[]
  topChats: StatsChatRow[]
  attachments: StatsAttachments
  links: StatsLinks
}

// ─── Кэш prepared statements ─────────────────────────────────────────────────

// getDB() — синглтон main-процесса (initDB вызывается один раз до регистрации
// IPC), поэтому кэш по SQL-строке безопасен. Максимум 3 варианта activity-SQL.
const stmtCache = new Map<string, Statement>()
function stmt(sql: string): Statement {
  let s = stmtCache.get(sql)
  if (!s) {
    s = getDB().prepare(sql)
    stmtCache.set(sql, s)
  }
  return s
}

// ─── Извлечение ссылок из контента ───────────────────────────────────────────

// URL в markdown-контенте: обрезаем по пробелу и markdown-разделителям <>[]()"
const URL_RE = /(https?:\/\/[^\s<>"'`[\])]+)/g
// Верхняя граница сканирования — защита от деградации на гигантских историях:
// берём самые свежие строки с 'http' (LIKE-префильтр уже отсеял остальные).
const LINK_SCAN_LIMIT = 10_000
const TOP_DOMAINS = 8

function extractLinks(
  rows: { content: string; chatId: string; chatTitle: string; createdAt: number }[],
): StatsLinks {
  let total = 0
  const unique = new Set<string>()
  const domains = new Map<string, number>()
  const items: StatsLinkItem[] = []
  for (const row of rows) {
    URL_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = URL_RE.exec(row.content)) !== null) {
      const url = m[1]
      total++
      unique.add(url)
      let host: string
      try {
        host = new URL(url).hostname.replace(/^www\./, '')
      } catch {
        continue
      }
      domains.set(host, (domains.get(host) ?? 0) + 1)
      items.push({ url, chatId: row.chatId, chatTitle: row.chatTitle, createdAt: row.createdAt })
    }
  }
  const topDomains = [...domains.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_DOMAINS)
  return { total, unique: unique.size, topDomains, items }
}

// ─── Регистрация IPC ─────────────────────────────────────────────────────────

export function registerStatsIPC(): void {
  ipcMain.handle('stats:overview', (_e, params: { hours?: number } = {}): StatsOverview => {
    const hours = params?.hours
    // since=0 для «всё время» — параметр всегда привязан, SQL остаётся
    // постоянным → prepared statement переиспользуется из кэша.
    const since = hours ? Date.now() - hours * 3_600_000 : 0

    // Бакет активности: 24ч/7д → часы, 30д → дни, всё время → месяцы.
    const bucketExpr =
      hours != null && hours <= 24 * 7
        ? `strftime('%Y-%m-%d %H', created_at / 1000, 'unixepoch', 'localtime')`
        : hours != null && hours <= 24 * 31
          ? `strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime')`
          : `strftime('%Y-%m', created_at / 1000, 'unixepoch', 'localtime')`

    const totals = stmt(`
      SELECT
        COUNT(*) AS messages,
        COALESCE(SUM(role = 'user'), 0) AS userMessages,
        COALESCE(SUM(role = 'assistant'), 0) AS assistantMessages,
        COALESCE(SUM(COALESCE(prompt_tokens, 0)), 0) AS promptTokens,
        COALESCE(SUM(COALESCE(completion_tokens, 0)), 0) AS completionTokens,
        AVG(duration_ms) AS avgDurationMs,
        COALESCE(SUM(COALESCE(tool_calls_count, 0)), 0) AS toolCalls,
        COALESCE(SUM(COALESCE(thinking_ms, 0)), 0) AS thinkingMs
      FROM messages WHERE created_at >= ?
    `).get(since) as StatsTotals

    totals.chatsCount = (
      stmt('SELECT COUNT(*) AS c FROM chats WHERE is_incognito = 0').get() as { c: number }
    ).c
    totals.projectsCount = (stmt('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c

    const activity = stmt(`
      SELECT ${bucketExpr} AS bucket,
             COUNT(*) AS messages,
             COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS tokens
      FROM messages WHERE created_at >= ?
      GROUP BY bucket ORDER BY bucket
    `).all(since) as StatsActivityPoint[]

    const byModel = stmt(`
      SELECT model,
             COUNT(*) AS requests,
             COALESCE(SUM(COALESCE(prompt_tokens, 0)), 0) AS promptTokens,
             COALESCE(SUM(COALESCE(completion_tokens, 0)), 0) AS completionTokens,
             AVG(duration_ms) AS avgDurationMs
      FROM messages
      WHERE role = 'assistant' AND model IS NOT NULL AND created_at >= ?
      GROUP BY model ORDER BY requests DESC LIMIT 50
    `).all(since) as StatsModelRow[]

    // Топ-чаты: инкогнито исключаем — тайтлы приватных чатов не должны
    // всплывать в статистике. При этом сообщения инкогнито входят в totals:
    // потреблённые токены остаются учтёнными, но анонимно.
    const topChats = stmt(`
      SELECT m.chat_id AS chatId, c.title, COUNT(*) AS messages,
             COALESCE(SUM(COALESCE(m.prompt_tokens, 0) + COALESCE(m.completion_tokens, 0)), 0) AS tokens,
             MAX(m.created_at) AS lastActive
      FROM messages m JOIN chats c ON c.id = m.chat_id
      WHERE c.is_incognito = 0 AND m.created_at >= ?
      GROUP BY m.chat_id ORDER BY messages DESC LIMIT 50
    `).all(since) as StatsChatRow[]

    // Вложения: messages.attachments — JSON-массив Attachment. Разворачиваем
    // через json_each и группируем по kind / source. json_valid защищает от
    // невалидного JSON в старых строках (json_each кинул бы SQL-ошибку).
    const byKind = stmt(`
      SELECT json_extract(j.value, '$.kind') AS kind, COUNT(*) AS count
      FROM messages m, json_each(m.attachments) j
      WHERE m.attachments IS NOT NULL AND json_valid(m.attachments) AND m.created_at >= ?
      GROUP BY kind ORDER BY count DESC
    `).all(since) as { kind: string; count: number }[]

    const bySource = stmt(`
      SELECT json_extract(j.value, '$.source') AS source, COUNT(*) AS count
      FROM messages m, json_each(m.attachments) j
      WHERE m.attachments IS NOT NULL AND json_valid(m.attachments) AND m.created_at >= ?
      GROUP BY source ORDER BY count DESC
    `).all(since) as { source: string; count: number }[]

    // Последние вложения для галереи/списка — БЕЗ ЛИМИТА: показываем все.
    // Это безопасно, потому что dataUrl НЕ выбираем (98 картинок ≈ 16 МБ base64
    // через IPC — недопустимо). Метаданные вложения ~200 байт: даже тысячи
    // штук весят копейки. Порционный рендер (догрузка при скролле) —
    // на клиенте, см. useInfiniteChunk в StatisticsSection.
    const attachmentItems = stmt(`
      SELECT
        json_extract(j.value, '$.id') AS id,
        json_extract(j.value, '$.kind') AS kind,
        json_extract(j.value, '$.name') AS name,
        json_extract(j.value, '$.source') AS source,
        m.chat_id AS chatId,
        c.title AS chatTitle,
        m.created_at AS createdAt,
        json_extract(j.value, '$.path') AS path,
        NULL AS dataUrl,
        json_extract(j.value, '$.mime') AS mime,
        json_extract(j.value, '$.size') AS size
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      CROSS JOIN json_each(m.attachments) j
      WHERE m.attachments IS NOT NULL AND json_valid(m.attachments)
        AND c.is_incognito = 0 AND m.created_at >= ?
      ORDER BY m.created_at DESC
    `).all(since) as StatsAttachmentItem[]

    const attachments: StatsAttachments = {
      total: byKind.reduce((s, k) => s + k.count, 0),
      byKind,
      bySource,
      items: attachmentItems,
    }

    // Ссылки: LIKE-префильтр в SQL (читаем только строки, где реально есть
    // 'http'), regex-парсинг — уже в JS. Инкогнито исключены.
    const linkRows = stmt(`
      SELECT m.content, m.chat_id AS chatId, c.title AS chatTitle, m.created_at AS createdAt
      FROM messages m JOIN chats c ON c.id = m.chat_id
      WHERE c.is_incognito = 0 AND m.content LIKE '%http%' AND m.created_at >= ?
      ORDER BY m.created_at DESC LIMIT ${LINK_SCAN_LIMIT}
    `).all(since) as { content: string; chatId: string; chatTitle: string; createdAt: number }[]
    const links = extractLinks(linkRows)

    return { totals, activity, byModel, topChats, attachments, links }
  })
}
