// ── Кэш распарсенной истории чатов в main-процессе ──────────────────────
//
// Проблема: getMessages(chatId) на каждый chat:send/context:calculate/compact
// читает ВСЮ историю из SQLite + JSON.parse всех полей (toolSteps, iterations,
// attachments, todo, ...) — на чате с 1000+ сообщений это десятки мс синхронно
// на event loop main.
//
// Решение: кэшируем распарсенный Message[] по chatId. Инвалидация — по версии:
// saveMessage инкрементит версию чата → кэш протухает → следующий getMessagesCached
// перечитает. Для чатов без изменений (частый случай при быстрых send подряд)
// — берём из кэша, пропуская SQL + JSON.parse.

import { getMessages, setMessageSavedCallback } from '../../core/db/messages'
import type { Message } from '../../shared/types'

interface CacheEntry {
  messages: Message[]
  version: number
}

const _historyCache = new Map<string, CacheEntry>()
const _chatVersions = new Map<string, number>()
const HISTORY_CACHE_CAP = 20
// _chatVersions тоже ограничен — иначе каждый чат оставляет запись навсегда.
// При эвикции из _historyCache чистим и версию тоже.
const VERSIONS_CAP = 40

/** Инвалидирует кэш истории чата (вызывается из saveMessage, deleteMessage и т.д.). */
export function invalidateHistoryCache(chatId: string): void {
  const v = (_chatVersions.get(chatId) ?? 0) + 1
  _chatVersions.set(chatId, v)
  _historyCache.delete(chatId)
  // Cap _chatVersions: при превышении удаляем старейшие. Map сохраняет
  // insertion-order, keys().next() — самый старый. Без cap — медленная
  // утечка в долгоживущей сессии с множеством чатов.
  if (_chatVersions.size > VERSIONS_CAP) {
    const oldest = _chatVersions.keys().next().value
    if (oldest) _chatVersions.delete(oldest)
  }
}

/** Возвращает распарсенную историю чата из кэша или из БД (с сохранением в кэш). */
export function getMessagesCached(chatId: string): Message[] {
  const version = _chatVersions.get(chatId) ?? 0
  const cached = _historyCache.get(chatId)
  if (cached && cached.version === version) {
    return cached.messages
  }
  // Cache miss → читаем из БД, кэшируем
  const messages = getMessages(chatId)
  // LRU eviction
  if (_historyCache.size >= HISTORY_CACHE_CAP) {
    const oldest = _historyCache.keys().next().value
    if (oldest) {
      _historyCache.delete(oldest)
    }
  }
  _historyCache.set(chatId, { messages, version })
  return messages
}

/** Полная очистка кэша (при выходе / для тестов). */
export function clearHistoryCache(): void {
  _historyCache.clear()
  _chatVersions.clear()
}

// ── Регистрация callback для инвалидации при saveMessage/deleteMessage ──
// messages.ts вызывает _onMessageSaved(chatId) при записи в БД → кэш чата
// протухает. Регистрируем при загрузке модуля (один раз).
setMessageSavedCallback(invalidateHistoryCache)
