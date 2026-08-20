/**
 * symbolsCache — in-memory кэш распарсенных символов (JSON.parse avoidance).
 *
 * Без кэша: каждый вызов get_fast_context делает JSON.parse(symbolsJson) для
 * ВСЕХ 5K+ файлов в индексе. С кэшем: парсим только при первом обращении или
 * при изменении mtime файла. Экономия: 5K JSON.parse → 0 на повторных запросах.
 *
 * Кэш инвалидируется по mtime (точная инвалидация) и имеет LRU-eviction
 * для ограничения памяти (max 10K файлов × ~2KB = ~20MB).
 *
 * Используется из:
 *   - retriever.ts buildRepoMapSlice (каждый get_fast_context запрос)
 *   - indexer.ts computeGraphRank (каждый full scan)
 *   - graphExtractor.ts syncFromFastContext (каждый graph sync)
 */

import type { SymbolDef } from './symbols'

export interface ParsedSymbols {
  d: SymbolDef[]
  i: string[]
  r: string[]
}

interface CacheEntry {
  symbols: ParsedSymbols
  mtime: number
  // Время последнего доступа — для LRU eviction
  lastAccess: number
}

const _cache = new Map<string, CacheEntry>()
const MAX_CACHE_SIZE = 10_000
const EVICT_BATCH = 2_000 // выгоняем пачкой при переполнении

const EMPTY: ParsedSymbols = { d: [], i: [], r: [] }

/**
 * Получить распарсенные символы для файла. Если symbolsJson не изменился
 * с последнего парсинга (по mtime) — возвращает кэшированный результат.
 * Иначе парсит JSON и кэширует.
 */
export function getParsedSymbols(
  filePath: string,
  symbolsJson: string | null,
  mtime: number,
): ParsedSymbols {
  const cached = _cache.get(filePath)
  if (cached && cached.mtime === mtime) {
    cached.lastAccess = Date.now()
    return cached.symbols
  }

  let parsed: ParsedSymbols = EMPTY
  if (symbolsJson) {
    try {
      const raw = JSON.parse(symbolsJson) as { d?: SymbolDef[]; i?: string[]; r?: string[] }
      parsed = { d: raw.d ?? [], i: raw.i ?? [], r: raw.r ?? [] }
    } catch {
      parsed = EMPTY
    }
  }

  // LRU eviction при переполнении
  if (_cache.size >= MAX_CACHE_SIZE) {
    evictLRU()
  }

  _cache.set(filePath, { symbols: parsed, mtime, lastAccess: Date.now() })
  return parsed
}

/** Инвалидировать кэш для одного файла (при удалении/переименовании). */
export function invalidateFile(filePath: string): void {
  _cache.delete(filePath)
}

/** Очистить весь кэш (при полном реиндексе или смене проекта). */
export function clearSymbolsCache(): void {
  _cache.clear()
}

/** Статистика кэша (для диагностики/UI). */
export function getSymbolsCacheStats(): { size: number; maxSize: number } {
  return { size: _cache.size, maxSize: MAX_CACHE_SIZE }
}

/** LRU eviction: выгоняем EVICT_BATCH самых старых по lastAccess. */
function evictLRU(): void {
  const entries = Array.from(_cache.entries())
  // Сортируем по lastAccess (старые первыми)
  entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess)
  const toEvict = Math.min(EVICT_BATCH, entries.length)
  for (let i = 0; i < toEvict; i++) {
    _cache.delete(entries[i][0])
  }
}
