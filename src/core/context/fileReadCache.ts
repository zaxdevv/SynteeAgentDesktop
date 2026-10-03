/**
 * fileReadCache.ts — персистентный кэш результатов read_file на весь чат.
 *
 * Живёт в main-процессе (module-level Map). На каждое chat:send отдаёт снимок
 * кэша в workerData (plain object). Worker после завершения возвращает
 * обновлённые/новые записи через postMessage, main мержит с LRU-эвикшеном.
 *
 * Инвалидация — по mtime+size файла на диске: если файл изменился извне
 * (пользователь редактировал в другом редакторе) или агент сам его изменил
 * (edit_file/write_file), кэш-хит не срабатывает и файл читается заново.
 */

import type { FileCacheEntry } from './fileCacheTypes'

/** Максимум записей на один чат */
const MAX_ENTRIES_PER_CHAT = 80
/** Максимум суммарного размера output на один чат (байт, ~3МБ) */
const MAX_TOTAL_BYTES_PER_CHAT = 3 * 1024 * 1024

// chatId → Map<path, FileCacheEntry>
const cache = new Map<string, Map<string, FileCacheEntry>>()
const MAX_CACHED_CHATS = 20
const MAX_GLOBAL_BYTES = 32 * 1024 * 1024

function touchChat(chatId: string, entries: Map<string, FileCacheEntry>): void {
  cache.delete(chatId)
  cache.set(chatId, entries)
}

function chatBytes(entries: Map<string, FileCacheEntry>): number {
  let bytes = 0
  for (const entry of entries.values()) bytes += Buffer.byteLength(entry.output, 'utf8')
  return bytes
}

function evictGlobal(): void {
  let bytes = 0
  for (const entries of cache.values()) bytes += chatBytes(entries)
  for (const [id, entries] of cache) {
    if (cache.size <= MAX_CACHED_CHATS && bytes <= MAX_GLOBAL_BYTES) break
    bytes -= chatBytes(entries)
    cache.delete(id)
  }
}

function getOrCreateChatMap(chatId: string): Map<string, FileCacheEntry> {
  let m = cache.get(chatId)
  if (!m) {
    m = new Map()
    cache.set(chatId, m)
  }
  return m
}

/**
 * Снапшот кэша чата для передачи в worker (plain object, не Map).
 */
export function getFileCacheSnapshot(chatId: string): Record<string, FileCacheEntry> {
  const m = cache.get(chatId)
  if (!m || m.size === 0) return {}
  touchChat(chatId, m)
  const result: Record<string, FileCacheEntry> = {}
  for (const [path, entry] of m) {
    result[path] = entry
  }
  return result
}

/**
 * Мерж обновлений от worker обратно в кэш чата.
 * Срабатывает LRU-эвикшение если превышены лимиты.
 */
export function mergeFileCache(chatId: string, updates: Record<string, FileCacheEntry>): void {
  if (!updates || Object.keys(updates).length === 0) return
  const m = getOrCreateChatMap(chatId)
  for (const [path, entry] of Object.entries(updates)) {
    m.set(path, entry)
  }
  evictIfNeeded(m)
  touchChat(chatId, m)
  evictGlobal()
}

/**
 * Полная очистка кэша чата — вызывается при удалении чата.
 */
export function clearFileCache(chatId: string): void {
  cache.delete(chatId)
}

/**
 * LRU-эвикшен: если записей слишком много или суммарный размер слишком большой —
 * удаляем самые старые по cachedAt.
 */
function evictIfNeeded(m: Map<string, FileCacheEntry>): void {
  if (m.size <= MAX_ENTRIES_PER_CHAT) {
    let totalBytes = 0
    for (const entry of m.values()) totalBytes += entry.output.length
    if (totalBytes <= MAX_TOTAL_BYTES_PER_CHAT) return
  }

  // Сортируем по cachedAt (возрастание), удаляем самые старые пока не уложимся
  const entries = Array.from(m.entries()).sort((a, b) => a[1].cachedAt - b[1].cachedAt)
  let totalBytes = 0
  for (const entry of m.values()) totalBytes += entry.output.length

  for (const [path, entry] of entries) {
    if (m.size <= MAX_ENTRIES_PER_CHAT && totalBytes <= MAX_TOTAL_BYTES_PER_CHAT) break
    totalBytes -= entry.output.length
    m.delete(path)
  }
}
