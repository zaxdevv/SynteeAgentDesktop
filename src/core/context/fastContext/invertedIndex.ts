/**
 * invertedIndex — инвертированный индекс token → Set<filePath>.
 *
 * Построение: при buildOrUpdateIndex (indexer.ts) для каждого файла
 * извлекаются все symbol name parts (через splitNameParts + stem),
 * добавляются в Map<token, Set<filePath>>. Также индексируются
 * filename parts и path segments.
 *
 * Использование: в retriever.ts buildRepoMapSlice pre-filter проверяет
 * query tokens против инвертированного индекса — вместо linear scan
 * 5K+ entries по filename. Получаем O(queryTokens) вместо O(N×tokens).
 *
 * Проблема без индекса: pre-filter в retriever делал baseName.includes(t)
 * для каждого entry × каждого query token = 5K × 5 = 25K string.includes.
 * С индексом: 5 lookups в Map → 5 Sets filePaths → готово.
 *
 * Инвалидация: по projectId (clearInvertedIndex) при полном reindex.
 * Incremental: rebuildInvertedIndex пересчитывает индекс из БД (быстро).
 */

import { splitNameParts, stem, localGetEntries, type LocalFastContextEntry } from './state'
import { getParsedSymbols } from './symbolsCache'
import { sep } from 'path'

// ─── In-memory inverted index ──────────────────────────────────────────────
// Map<projectId, Map<token, Set<filePath>>>
const _indexes = new Map<string, Map<string, Set<string>>>()

/**
 * Построить инвертированный индекс для проекта из текущих entries в БД.
 * Вызывается после buildOrUpdateIndex (indexer.ts) или лениво при первом
 * get_fast_context запросе (retriever.ts).
 *
 * Для каждого файла индексируются:
 *   - symbol name parts (splitNameParts + stem): "getUserById" → ["get", "user", "by", "id"] → stemmed
 *   - filename parts: "UserService.ts" → ["user", "service"]
 *   - path segments: "src/auth/login.ts" → ["src", "auth", "login"]
 *
 * Токены нормализуются через stem() для matching: "users" → "user",
 * "authentication" → "auth".
 */
export function buildInvertedIndex(projectId: string): Map<string, Set<string>> {
  const existing = _indexes.get(projectId)
  if (existing) return existing

  const index = new Map<string, Set<string>>()
  const entries = localGetEntries(projectId)

  for (const entry of entries) {
    indexEntry(index, entry)
  }

  _indexes.set(projectId, index)
  return index
}

/** Индексировать одну запись (для incremental updates). */
export function indexEntry(index: Map<string, Set<string>>, entry: LocalFastContextEntry): void {
  const filePath = entry.filePath
  const parsed = getParsedSymbols(filePath, entry.symbolsJson, entry.mtime)

  // Symbol name parts → stemmed tokens
  for (const def of parsed.d) {
    const parts = splitNameParts(def.name)
    for (const part of parts) {
      const stemmed = stem(part.toLowerCase())
      if (stemmed.length < 2) continue
      addToIndex(index, stemmed, filePath)
    }
    // Также индексируем полное имя (lowercase) — для exact match
    const fullName = def.name.toLowerCase()
    if (fullName.length >= 3) {
      addToIndex(index, fullName, filePath)
    }
  }

  // Filename parts: "UserService.ts" → ["user", "service"]
  const basename = filePath.split(sep).pop() ?? ''
  const baseNoExt = basename.replace(/\.[^.]+$/, '')
  for (const part of splitNameParts(baseNoExt)) {
    const stemmed = stem(part.toLowerCase())
    if (stemmed.length >= 2) addToIndex(index, stemmed, filePath)
  }

  // Path segments: "src/auth/login.ts" → ["src", "auth", "login"]
  const normalized = filePath.replace(/\\/g, '/')
  const segments = normalized.split('/')
  for (const seg of segments) {
    const lower = seg.toLowerCase()
    if (lower.length >= 2) {
      addToIndex(index, lower, filePath)
      // Также stemmed версию
      const stemmed = stem(lower)
      if (stemmed !== lower && stemmed.length >= 2) {
        addToIndex(index, stemmed, filePath)
      }
    }
  }
}

function addToIndex(index: Map<string, Set<string>>, token: string, filePath: string): void {
  let set = index.get(token)
  if (!set) {
    set = new Set()
    index.set(token, set)
  }
  set.add(filePath)
}

/**
 * Найти файлы по query tokens используя инвертированный индекс.
 * Возвращает Set<filePath> — файлы, содержащие хотя бы один query token.
 *
 * @param index — инвертированный индекс проекта
 * @param queryTokens — токены запроса (lowercase, без стоп-слов)
 * @param queryStems — stemmed версии query tokens
 * @returns Set filePaths matching any token, или null если индекс пуст
 */
export function lookupFiles(
  index: Map<string, Set<string>>,
  queryTokens: string[],
  queryStems: string[],
): Set<string> | null {
  if (index.size === 0) return null

  const result = new Set<string>()
  for (let i = 0; i < queryTokens.length; i++) {
    const t = queryTokens[i]
    const ts = queryStems[i]

    // Сначала stemmed lookup (более точный — "users" → "user" match)
    const stemmed = ts !== t ? ts : stem(t)
    const files = index.get(stemmed)
    if (files) {
      for (const f of files) result.add(f)
    }
    // Также пробуем raw token (без stemming)
    if (stemmed !== t) {
      const rawFiles = index.get(t)
      if (rawFiles) {
        for (const f of rawFiles) result.add(f)
      }
    }
  }

  return result.size > 0 ? result : null
}

/** Очистить индекс проекта (при полном reindex или удалении проекта). */
export function clearInvertedIndex(projectId: string): void {
  _indexes.delete(projectId)
}

/** Очистить все индексы (при выходе из приложения). */
export function clearAllInvertedIndexes(): void {
  _indexes.clear()
}

/** Статистика индекса (для диагностики). */
export function getInvertedIndexStats(projectId: string): { tokens: number; files: number } {
  const index = _indexes.get(projectId)
  if (!index) return { tokens: 0, files: 0 }
  const allFiles = new Set<string>()
  for (const set of index.values()) {
    for (const f of set) allFiles.add(f)
  }
  return { tokens: index.size, files: allFiles.size }
}
