// csv — конвертация xlsx↔csv (exceljs + fs). UTF-8 с BOM, RFC 4180.
const fs = require('fs')
const ExcelJS = require('exceljs')
const { cellToPlainValue, cellToFormula } = require('../excel/cells')

/** Экранирование поля по RFC 4180 */
function csvField(v) {
  if (v === null || v === undefined) return ''
  let s = String(v)
  if (/[",;\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'
  return s
}

/** xlsxToCsv(src, out, { sheet, delimiter, encoding }) → { size, summary } */
async function xlsxToCsv(src, out, opts) {
  const { sheet, delimiter = ';', encoding = 'utf-8' } = opts || {}
  const enc = String(encoding || 'utf-8').toLowerCase()
  if (enc !== 'utf-8' && enc !== 'utf8') {
    throw new Error(
      'Кодировка вывода не поддерживается: ' + encoding +
      '. Доступно: utf-8 (с BOM). Для других кодировок используйте office_save_as (.xlsx→.csv) или конвертацию через MS Excel.',
    )
  }
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(src)
  const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets[0]
  if (!ws) throw new Error('Лист не найден: ' + sheet)

  let maxR = 0
  let maxC = 0
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn > maxR) maxR = rn
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.col > maxC) maxC = cell.col
    })
  })

  const lines = []
  for (let r = 1; r <= maxR; r++) {
    const fields = []
    for (let c = 1; c <= maxC; c++) {
      const cell = ws.getRow(r).getCell(c)
      const f = cellToFormula(cell)
      const v = f || cellToPlainValue(cell)
      fields.push(csvField(v))
    }
    lines.push(fields.join(delimiter))
  }

  const content = '\uFEFF' + lines.join('\r\n') + (lines.length ? '\r\n' : '')
  fs.writeFileSync(out, content, 'utf-8')
  const size = fs.statSync(out).size
  return { size, summary: maxR + ' строк, ' + maxC + ' колонок' }
}

/** Парсер CSV (учитывает кавычки, \r\n внутри полей) */
function parseCsv(text, delimiter) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field); field = ''
    } else if (ch === '\n') {
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else if (ch === '\r') {
      // пропустить (перед \n)
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  return rows
}

const DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/
const NUM_RE = /^-?\d+([.,]\d+)?%?$/

/** Авто-тип: число / дата dd.mm.yyyy / строка. → { value, numFmt? } */
function guessType(s) {
  if (s === '' || s == null) return { value: null }
  const dm = DATE_RE.exec(s)
  if (dm) {
    const d = new Date(Date.UTC(+dm[3], +dm[2] - 1, +dm[1], 12, 0, 0))
    if (!isNaN(d.getTime()) && +dm[2] >= 1 && +dm[2] <= 12 && +dm[1] >= 1 && +dm[1] <= 31) {
      return { value: d, numFmt: 'dd.mm.yyyy' }
    }
  }
  if (NUM_RE.test(s)) {
    const isPct = s.endsWith('%')
    const n = parseFloat(s.replace('%', '').replace(',', '.'))
    if (!isNaN(n)) {
      return isPct ? { value: n / 100, numFmt: '0.00%' } : { value: n }
    }
  }
  return { value: s }
}

/** Декодировать CSV/текстовый файл с учётом кодировки (utf-8, windows-1251, cp866, koi8-r, iso-8859-1...) */
function readTextWithEncoding(src, encoding) {
  const enc = String(encoding || 'utf-8').toLowerCase()
  if (enc === 'utf-8' || enc === 'utf8') {
    return fs.readFileSync(src, 'utf-8')
  }
  const buf = fs.readFileSync(src)
  try {
    return new TextDecoder(enc).decode(buf)
  } catch (e) {
    throw new Error(
      'Неподдерживаемая кодировка: ' + encoding +
      '. Поддерживаются: utf-8, windows-1251, cp866, koi8-r, iso-8859-1',
    )
  }
}

/** csvToXlsx(src, out, { delimiter, sheetName, encoding }) → { size, summary } */
async function csvToXlsx(src, out, opts) {
  const { delimiter = ';', sheetName = 'Данные', encoding = 'utf-8' } = opts || {}
  const text = readTextWithEncoding(src, encoding)
  const rows = parseCsv(text, delimiter)
  if (!rows.length) throw new Error('CSV пуст: ' + src)

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(sheetName)

  const maxCols = Math.max(...rows.map((r) => r.length))
  const colMaxLen = new Array(maxCols).fill(0)

  rows.forEach((row, r) => {
    for (let c = 0; c < maxCols; c++) {
      const raw = row[c] != null ? row[c] : ''
      if (r === 0 || String(raw).length > colMaxLen[c]) colMaxLen[c] = String(raw).length
      const cell = ws.getRow(r + 1).getCell(c + 1)
      const { value, numFmt } = guessType(raw)
      cell.value = value
      if (numFmt) cell.numFmt = numFmt
    }
  })

  // Ширины колонок по макс. длине (+2 запас)
  for (let c = 0; c < maxCols; c++) {
    ws.getColumn(c + 1).width = Math.max(8, Math.min(60, colMaxLen[c] + 2))
  }

  const buffer = await wb.xlsx.writeBuffer()
  fs.writeFileSync(out, Buffer.from(buffer))
  const size = fs.statSync(out).size
  return { size, summary: rows.length + ' строк, ' + maxCols + ' колонок' }
}

module.exports = { xlsxToCsv, csvToXlsx, parseCsv, guessType, csvField, readTextWithEncoding }
