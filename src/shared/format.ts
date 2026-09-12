/**
 * Форматирование чисел токенов в компактном виде: 999 → "999",
 * 1_500 → "1.5K", 42_000 → "42K", 1_048_576 → "1.05M".
 * Единый формат для панели статистики сообщения, счётчика контекста и пр.
 * Точное значение с разделителями — в formatTokensFull (для тултипов).
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`
  }
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Точное значение с разделителями разрядов: 1048576 → "1 048 576". */
export function formatTokensFull(n: number): string {
  return n.toLocaleString('ru-RU')
}

/**
 * Человекочитаемая длительность: 850 → "850 мс", 4.2с → "4.2 с",
 * 95с → "1 мин 35 с", 3_780с → "1 ч 3 мин", 2.5ч → "2 ч 30 мин".
 * Компактно и авто-масштабируется — не показывает "180.0 с" для трёх минут.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} мс`
  const totalSec = ms / 1000
  if (totalSec < 10) return `${totalSec.toFixed(1)} с`
  if (totalSec < 60) return `${Math.round(totalSec)} с`
  const totalMin = Math.floor(totalSec / 60)
  const sec = Math.round(totalSec % 60)
  if (totalMin < 60) {
    // «1 мин 35 с» / «3 мин» (секунды опускаем на круглых)
    return sec > 0 ? `${totalMin} мин ${sec} с` : `${totalMin} мин`
  }
  const hours = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return min > 0 ? `${hours} ч ${min} мин` : `${hours} ч`
}

