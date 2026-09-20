// cells — работа с адресами ячеек и значениями (спека ↔ exceljs)

const DATE_FMT_RE = /d{1,4}|m{1,4}|y{2,4}/i

/** 'B3' → { col: 2, row: 3 } (1-based) */
function parseRef(ref) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(ref || '').trim())
  if (!m) throw new Error('Некорректный адрес ячейки: ' + ref)
  return { col: lettersToNum(m[1]), row: parseInt(m[2], 10) }
}

/** 'A' → 1, 'Z' → 26, 'AA' → 27 */
function lettersToNum(letters) {
  let n = 0
  const s = letters.toUpperCase()
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64)
  return n
}

/** 1 → 'A', 27 → 'AA' */
function numToLetters(n) {
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** 'A1:C5' → { c1, r1, c2, r2 } (1-based inclusive) */
function parseRange(range) {
  const m = /^\s*\$?([A-Za-z]+)\$?(\d+)\s*:\s*\$?([A-Za-z]+)\$?(\d+)\s*$/.exec(String(range || ''))
  if (!m) throw new Error('Некорректный диапазон: ' + range)
  const c1 = lettersToNum(m[1]); const r1 = parseInt(m[2], 10)
  const c2 = lettersToNum(m[3]); const r2 = parseInt(m[4], 10)
  return { c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) }
}

function rangeToString(r) {
  return numToLetters(r.c1) + r.r1 + ':' + numToLetters(r.c2) + r.r2
}

const DATE_STR_RE = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/ // dd.mm.yyyy

/** Парсинг даты-строки: dd.mm.yyyy (или ISO) → Date (UTC-полдень) | null */
function parseDateStr(s) {
  const m = DATE_STR_RE.exec(s)
  if (m) {
    const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 12, 0, 0))
    return isNaN(d.getTime()) ? null : d
  }
  const iso = new Date(s)
  if (!isNaN(iso.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    return new Date(Date.UTC(iso.getUTCFullYear(), iso.getUTCMonth(), iso.getUTCDate(), 12, 0, 0))
  }
  return null
}

/** Значение ячейки спеки → exceljs cell.value.
 *  Формула: "=SUM(A1:A2)" → { formula: 'SUM(A1:A2)' }.
 *  Дата: строка dd.mm.yyyy/ISO при дата-подобном numFmt → Date. */
function specValueToCell(cellSpec) {
  if (cellSpec.formula != null && cellSpec.formula !== '') {
    let f = String(cellSpec.formula).trim()
    if (f.startsWith('=')) f = f.slice(1)
    return { formula: f, result: cellSpec.value != null ? cellSpec.value : undefined }
  }
  const v = cellSpec.value
  if (typeof v === 'string' && v && cellSpec.numFmt && DATE_FMT_RE.test(String(cellSpec.numFmt).replace(/[[\]]/g, ''))) {
    const d = parseDateStr(v)
    if (d) return d
  }
  return v === undefined ? null : v
}

/** exceljs cell.value → простое значение (для values-режима) */
function cellToPlainValue(cell) {
  if (!cell || cell.value === null || cell.value === undefined) return null
  const v = cell.value
  if (v instanceof Date) {
    const dd = String(v.getUTCDate()).padStart(2, '0')
    const mm = String(v.getUTCMonth() + 1).padStart(2, '0')
    return dd + '.' + mm + '.' + v.getUTCFullYear()
  }
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('')
    if (v.formula) return v.result !== undefined && v.result !== null ? v.result : null
    if (v.sharedFormula) return v.result !== undefined && v.result !== null ? v.result : null
    if (v.error) return '#' + v.error
    if (v.hyperlink) return v.text || v.hyperlink
  }
  return v
}

/** exceljs cell.value → формула-строка "=..." или null */
function cellToFormula(cell) {
  if (!cell || !cell.value || typeof cell.value !== 'object') return null
  const v = cell.value
  if (v.formula) return '=' + v.formula
  if (v.sharedFormula) return '=' + v.sharedFormula
  return null
}

/** exceljs cell.value → значение для full-спеки (value или formula) */
function cellToSpecValue(cell) {
  const f = cellToFormula(cell)
  if (f) return { formula: f }
  const v = cell.value
  if (v instanceof Date) {
    return { value: v.toISOString().slice(0, 10) }
  }
  if (v && typeof v === 'object') {
    if (v.richText) return { value: v.richText.map((r) => r.text).join('') }
    if (v.hyperlink) return { value: v.text || v.hyperlink, hyperlink: v.hyperlink }
    if (v.error) return { value: '#' + v.error }
  }
  return { value: v === undefined ? null : v }
}

module.exports = { parseRef, lettersToNum, numToLetters, parseRange, rangeToString, specValueToCell, cellToPlainValue, cellToFormula, cellToSpecValue }
