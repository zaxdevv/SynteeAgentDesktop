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

import { getMessages, getMessagesAfterLatestCompact, saveMessage, setMessageSavedCallback } from '../../core/db/messages'
import { getStreamingBuffersForChat, deleteStreamingBuffer } from '../../core/db/streamingBuffers'
import { getDB } from '../../core/db/handle'
import type { Message } from '../../shared/types'

interface CacheEntry {
  messages: Message[]
  version: number
}

const _historyCache = new Map<string, CacheEntry>()
const _liveHistoryCache = new Map<string, CacheEntry>()
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
  _liveHistoryCache.delete(chatId)
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
  // Краш-рекавери: чекпоинт стриминга из streaming_buffers → messages.
  // Выполняем ДО чтения version — saveMessage внутри recovery инвалидирует
  // кэш, и мы кэшируем уже с актуальной версией. Одноразово: буфер после
  // обработки удаляется, повторные вызовы — пустой SELECT по индексу.
  recoverStreamingBuffersForChat(chatId)
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

/** Read scoped AI history; recovery runs before querying, as for full history. */
export function getMessagesAfterLatestCompactCached(chatId: string, excludeMessageId?: string): Message[] {
  recoverStreamingBuffersForChat(chatId)
  const version = _chatVersions.get(chatId) ?? 0
  let cached = _liveHistoryCache.get(chatId)
  if (!cached || cached.version !== version) {
    cached = { messages: getMessagesAfterLatestCompact(chatId), version }
  }
  _liveHistoryCache.delete(chatId)
  if (_liveHistoryCache.size >= HISTORY_CACHE_CAP) {
    const oldest = _liveHistoryCache.keys().next().value
    if (oldest !== undefined) _liveHistoryCache.delete(oldest)
  }
  _liveHistoryCache.set(chatId, cached)
  return excludeMessageId ? cached.messages.filter(m => m.id !== excludeMessageId) : cached.messages
}

/**
 * Краш-рекавери частичных assistant-сообщений (streaming_buffers → messages).
 *
 * Чекпоинт-таймер стриминга пишет промежуточные версии ответа в
 * streaming_buffers (БЕЗ FTS-триггеров), а не в messages. Если процесс упал
 * до финального sendDone — буфер остаётся единственной копией накопленного
 * ответа. Здесь переносим его в messages, сохраняя прежнее поведение «после
 * краша частичный ответ виден в чате».
 *
 * Буфер удаляется в любом случае: либо финальный sendDone уже успел записать
 * полную версию в messages (тогда это no-op — INSERT не делаем), либо
 * частичная версия восстановлена из буфера ниже.
 */
export function recoverStreamingBuffersForChat(chatId: string): void {
  const buffers = getStreamingBuffersForChat(chatId)
  if (buffers.length === 0) return
  for (const b of buffers) {
    try {
      // Финальная версия уже в messages (sendDone успел до краша) —
      // ничего восстанавливать не нужно.
      const exists = getDB().prepare('SELECT 1 FROM messages WHERE id = ?').get(b.messageId)
      if (!exists) {
        saveMessage(JSON.parse(b.payload) as Message)
      }
    } catch (e) {
      console.warn('[historyCache] streaming buffer recover failed chatId=%s msgId=%s: %s',
        chatId, b.messageId, (e as Error).message)
    } finally {
      deleteStreamingBuffer(b.messageId)
    }
  }
}

/** Полная очистка кэша (при выходе / для тестов). */
export function clearHistoryCache(): void {
  _historyCache.clear()
  _liveHistoryCache.clear()
  _chatVersions.clear()
}

// ── Регистрация callback для инвалидации при saveMessage/deleteMessage ──
// messages.ts вызывает _onMessageSaved(chatId) при записи в БД → кэш чата
// протухает. Регистрируем при загрузке модуля (один раз).
setMessageSavedCallback(invalidateHistoryCache)
