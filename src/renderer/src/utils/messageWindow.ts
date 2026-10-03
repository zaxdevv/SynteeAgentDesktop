// ── Pure helpers для оконной (пагинированной) истории сообщений ──────────
//
// Используются DotChat (и при необходимости другими лентами): вместо загрузки
// ВСЕЙ истории чата на каждый ран грузим последнюю страницу (getMessagesPage)
// и мержим её в уже загруженное окно. Функции чистые (без React/стора) — легко
// покрыть юнит-тестами и рассуждать о них изолированно.

/**
 * Мержит свежую «хвостовую» страницу в существующее ASC-окно, НЕ теряя уже
 * подгруженные старые сообщения.
 *
 * - Сообщения, которые есть и в existing, и во fresh — заменяются свежей
 *   версией (правки контента/реакции приходят из main).
 * - Сообщения, которых нет в existing (новые) — добавляются в конец
 *   (fresh приходит в ASC-порядке, т.е. новейшие последними).
 * - Если ничего не изменилось — возвращается исходная ссылка (важно для
 *   Object.is-сравнений в сторе/React: лишних ре-рендеров не будет).
 */
export function mergeTail<T extends { id: string }>(existing: T[], fresh: T[]): T[] {
  if (fresh.length === 0) return existing
  const freshById = new Map<string, T>()
  for (const m of fresh) freshById.set(m.id, m)
  const existingIds = new Set(existing.map(m => m.id))

  let changed = false
  const merged = existing.map(m => {
    const f = freshById.get(m.id)
    if (f && f !== m) {
      changed = true
      return f
    }
    return m
  })
  let appended = false
  for (const m of fresh) {
    if (!existingIds.has(m.id)) {
      merged.push(m)
      appended = true
    }
  }
  return changed || appended ? merged : existing
}

/**
 * Добавляет страницу более старых сообщений В НАЧАЛО ASC-окна, дедуплицируя по
 * id (защита от гонок/двойной догрузки). Возвращает исходную ссылку, если
 * добавлять нечего.
 */
export function prependOlder<T extends { id: string }>(existing: T[], older: T[]): T[] {
  if (older.length === 0) return existing
  const seen = new Set(existing.map(m => m.id))
  const add: T[] = []
  for (const m of older) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      add.push(m)
    }
  }
  if (add.length === 0) return existing
  return [...add, ...existing]
}

/**
 * Индекс id → элемент. Заменяет повторные `list.find(...)` (O(n²) на списке
 * ответов/реплаев) на один O(n)-проход + O(1) лукапы.
 */
export function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const it of items) map.set(it.id, it)
  return map
}
