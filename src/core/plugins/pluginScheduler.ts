/**
 * Мини-парсер cron-выражений для планировщика плагинов.
 *
 * Поддерживаются стандартные 5 полей:
 *   minute (0-59) | hour (0-23) | day-of-month (1-31) | month (1-12) | day-of-week (0-7, 0 и 7 = вс)
 *
 * Синтаксис поля: любое (*) | любое с шагом (звездочка/n) | точное значение |
 * диапазон a-b | список a,b,c. Реализовано намеренно просто — без имён
 * месяцев/дней и спец-символов L/W/# (для задач плагинов этого достаточно).
 */

/** Проверяет, матчит ли expr текущую минуту. Бросает Error при невалидном expr. */
export function matchesCronExpression(expr: string, now: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`Некорректный cron: "${expr}" — ожидается 5 полей`)
  }
  const [minField, hourField, domField, monthField, dowField] = fields
  return (
    fieldMatches(minField, now.getMinutes(), 0, 59) &&
    fieldMatches(hourField, now.getHours(), 0, 23) &&
    fieldMatches(domField, now.getDate(), 1, 31) &&
    fieldMatches(monthField, now.getMonth() + 1, 1, 12) &&
    fieldMatches(dowField, now.getDay() === 0 ? 7 : now.getDay(), 0, 7)
  )
}

/** Матчит одно поле (список через запятую). */
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(',').some(part => partMatches(part.trim(), value, min, max))
}

/** Матчит один элемент поля: любое значение, шаг (звездочка/n), точное a,
 *  диапазон a-b, диапазон с шагом a-b/n. */
function partMatches(part: string, value: number, min: number, max: number): boolean {
  if (!part) return false
  // Диапазон (опционально с шагом): a-b/n
  const rangeMatch = part.match(/^(\*|\d+)-(\*|\d+)(?:\/(\d+))?$/)
  if (rangeMatch) {
    const lo = rangeMatch[1] === '*' ? min : Number(rangeMatch[1])
    const hi = rangeMatch[2] === '*' ? max : Number(rangeMatch[2])
    const step = rangeMatch[3] ? Number(rangeMatch[3]) : 1
    if (lo < min || hi > max || lo > hi || step < 1) return false
    return value >= lo && value <= hi && (value - lo) % step === 0
  }
  // Шаг от начала: */n
  const stepMatch = part.match(/^\*\/(\d+)$/)
  if (stepMatch) {
    const step = Number(stepMatch[1])
    if (step < 1) return false
    return (value - min) % step === 0
  }
  // Точное значение
  const exact = Number(part)
  if (!Number.isInteger(exact)) return false
  return exact === value
}
