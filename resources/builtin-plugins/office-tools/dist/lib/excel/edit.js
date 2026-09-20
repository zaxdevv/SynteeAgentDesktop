// edit — гранулярные правки .xlsx: read full → применить ops → пересобрать → перезаписать
const fs = require('fs')
const { readWorkbook } = require('./read')
const { buildWorkbook } = require('./spec')
const { parseRef, parseRange, rangeToString, lettersToNum, numToLetters } = require('./cells')
const { backupFile } = require('../backup')

/** Найти индекс листа в спеке по имени */
function sheetIdx(spec, name) {
  const i = spec.sheets.findIndex((s) => s.name === name)
  if (i < 0) {
    const names = spec.sheets.map((s) => '"' + s.name + '"').join(', ')
    throw new Error('Лист не найден: ' + name + '. Листы в файле: ' + names)
  }
  return i
}

/** Гарантировать наличие rows/columns у листа спеки */
function ensureRows(sheetSpec, rowCount, colCount) {
  if (!Array.isArray(sheetSpec.rows)) sheetSpec.rows = []
  while (sheetSpec.rows.length < rowCount) sheetSpec.rows.push([])
  if (colCount != null) {
    for (const row of sheetSpec.rows) {
      while (row.length < colCount) row.push(null)
    }
  }
}

/** Сдвиг номера строки/колонки при вставке/удалении. Возвращает новый номер или null (удалён). */
function shiftIdx(n, at, count, insert) {
  if (n < at) return n
  if (insert) return n + count
  const shifted = n - count
  return shifted < at ? null : shifted
}

/** Сдвиг ссылок в формуле ("=SUM(B2:B4)" → "=SUM(B3:B5)") вне строковых литералов */
function shiftFormulaRefs(f, axis, at, count, insert) {
  const parts = String(f).split('"')
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g, (m, d1, letters, d2, digits) => {
      if (axis === 'row') {
        const n = shiftIdx(parseInt(digits, 10), at, count, insert)
        return n == null ? m : d1 + letters + d2 + n
      }
      const c = shiftIdx(lettersToNum(letters), at, count, insert)
      return c == null ? m : d1 + numToLetters(c) + d2 + digits
    })
  }
  return parts.join('"')
}

/** Сдвинуть все ссылки листа (формулы, merged, freeze, autoFilter, validation, CF) при insert/delete строк/колонок */
function shiftSheetRefs(sh, axis, at, count, insert) {
  const shiftRangeStr = (rangeStr) => {
    try {
      const r = parseRange(rangeStr)
      const a = axis === 'row' ? ['r1', 'r2'] : ['c1', 'c2']
      const n1 = shiftIdx(r[a[0]], at, count, insert)
      const n2 = shiftIdx(r[a[1]], at, count, insert)
      if (n1 == null || n2 == null) return null
      r[a[0]] = n1; r[a[1]] = n2
      return rangeToString(r)
    } catch (e) { return rangeStr }
  }
  for (const row of sh.rows || []) {
    const cells = Array.isArray(row) ? row : row && row.cells
    if (!cells) continue
    for (const cell of cells) {
      if (cell && typeof cell === 'object' && typeof cell.formula === 'string') {
        cell.formula = shiftFormulaRefs(cell.formula, axis, at, count, insert)
      }
    }
  }
  if (Array.isArray(sh.merged)) sh.merged = sh.merged.map(shiftRangeStr).filter(Boolean)
  if (sh.autoFilter) {
    const shifted = shiftRangeStr(sh.autoFilter)
    if (shifted) sh.autoFilter = shifted; else delete sh.autoFilter
  }
  if (sh.freeze) {
    try {
      const { col, row } = parseRef(sh.freeze)
      if (axis === 'row') {
        const n = shiftIdx(row, at, count, insert)
        if (n != null) sh.freeze = numToLetters(col) + n; else delete sh.freeze
      } else {
        const n = shiftIdx(col, at, count, insert)
        if (n != null) sh.freeze = numToLetters(n) + row; else delete sh.freeze
      }
    } catch (e) { /* leave */ }
  }
  if (Array.isArray(sh.dataValidation)) {
    sh.dataValidation = sh.dataValidation.map((dv) => (dv && dv.range ? Object.assign({}, dv, { range: shiftRangeStr(dv.range) }) : dv)).filter(Boolean)
  }
  if (Array.isArray(sh.conditionalFormatting)) {
    sh.conditionalFormatting = sh.conditionalFormatting.map((cf) => (cf && cf.range ? Object.assign({}, cf, { range: shiftRangeStr(cf.range) }) : cf)).filter(Boolean)
  }
  if (axis === 'row') {
    if (sh.rowHeights && typeof sh.rowHeights === 'object') {
      const nh = {}
      for (const [k, v] of Object.entries(sh.rowHeights)) {
        const n = shiftIdx(parseInt(k, 10), at, count, insert)
        if (n != null) nh[n] = v
      }
      sh.rowHeights = nh
    }
    if (Array.isArray(sh.hiddenRows)) {
      sh.hiddenRows = sh.hiddenRows.map((n) => shiftIdx(n, at, count, insert)).filter((n) => n != null)
    }
  } else if (Array.isArray(sh.hiddenColumns)) {
    sh.hiddenColumns = sh.hiddenColumns.map((n) => shiftIdx(n, at, count, insert)).filter((n) => n != null)
  }
}

/** set_cells */
function opSetCells(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!Array.isArray(op.cells)) throw new Error('set_cells: cells (массив) обязателен')
  for (const c of op.cells) {
    if (!c || !c.ref) throw new Error('set_cells: у каждой ячейки нужен ref')
    const { col, row } = parseRef(c.ref)
    ensureRows(sh, row, col)
    const cell = {}
    if (c.value !== undefined) cell.value = c.value
    if (c.formula !== undefined && c.formula !== null && c.formula !== '') cell.formula = c.formula
    if (c.numFmt) cell.numFmt = c.numFmt
    if (c.style) cell.style = c.style
    if (c.hyperlink) cell.hyperlink = c.hyperlink
    sh.rows[row - 1][col - 1] = Object.keys(cell).length ? cell : null
  }
}

/** insert_rows { sheet, at (1-based), count, values? } */
function opInsertRows(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const at = Number(op.at)
  const count = op.count || 1
  if (!(at >= 1)) throw new Error('insert_rows: at (1-based) обязателен')
  ensureRows(sh, at - 1)
  const newRows = []
  for (let i = 0; i < count; i++) {
    if (op.values && Array.isArray(op.values) && op.values[i] !== undefined) {
      const v = op.values[i]
      newRows.push(Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : { value: x })) : [])
    } else {
      newRows.push([])
    }
  }
  sh.rows.splice(at - 1, 0, ...newRows)
  shiftSheetRefs(sh, 'row', at, count, true)
}

/** delete_rows { sheet, at, count } */
function opDeleteRows(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const at = Number(op.at)
  const count = op.count || 1
  if (!(at >= 1)) throw new Error('delete_rows: at (1-based) обязателен')
  ensureRows(sh, at + count - 1)
  sh.rows.splice(at - 1, count)
  shiftSheetRefs(sh, 'row', at, count, false)
}

/** insert_columns { sheet, at, count } */
function opInsertColumns(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const at = Number(op.at)
  const count = op.count || 1
  if (!(at >= 1)) throw new Error('insert_columns: at (1-based) обязателен')
  for (const row of sh.rows || []) {
    // строки — массивы ячеек (full-спека всегда отдаёт массивы)
    if (Array.isArray(row)) {
      for (let i = 0; i < count; i++) row.splice(at - 1, 0, null)
    } else if (row && Array.isArray(row.cells)) {
      for (let i = 0; i < count; i++) row.cells.splice(at - 1, 0, null)
    }
  }
  shiftSheetRefs(sh, 'col', at, count, true)
}

/** delete_columns { sheet, at, count } */
function opDeleteColumns(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const at = Number(op.at)
  const count = op.count || 1
  if (!(at >= 1)) throw new Error('delete_columns: at (1-based) обязателен')
  for (const row of sh.rows || []) {
    if (Array.isArray(row)) {
      row.splice(at - 1, count)
    } else if (row && Array.isArray(row.cells)) {
      row.cells.splice(at - 1, count)
    }
  }
  shiftSheetRefs(sh, 'col', at, count, false)
}

/** add_sheet { name, rows?, columns? } */
function opAddSheet(spec, op) {
  if (!op.name) throw new Error('add_sheet: name обязателен')
  if (spec.sheets.some((s) => s.name === op.name)) throw new Error('Лист уже существует: ' + op.name)
  spec.sheets.push({
    name: op.name,
    rows: op.rows || [],
    ...(op.columns ? { columns: op.columns } : {}),
  })
}

/** delete_sheet { name } */
function opDeleteSheet(spec, op) {
  const i = sheetIdx(spec, op.name)
  if (spec.sheets.length <= 1) throw new Error('Нельзя удалить единственный лист')
  spec.sheets.splice(i, 1)
}

/** rename_sheet { name, to } */
function opRenameSheet(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.name)]
  if (!op.to) throw new Error('rename_sheet: to обязателен')
  sh.name = op.to
}

/** set_column_width { sheet, column: 'B'|индекс, width } */
function opSetColumnWidth(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  let idx
  if (typeof op.column === 'string') idx = parseRef(op.column + '1').col
  else idx = Number(op.column)
  if (!(idx >= 1)) throw new Error('set_column_width: column обязателен')
  if (op.width == null) throw new Error('set_column_width: width обязателен')
  if (!Array.isArray(sh.columns)) {
    const maxCols = Math.max(idx, ...(sh.rows || []).map((r) => (Array.isArray(r) ? r.length : 0)))
    sh.columns = new Array(maxCols).fill(null)
  }
  while (sh.columns.length < idx) sh.columns.push(null)
  sh.columns[idx - 1] = Number(op.width)
}

/** merge { sheet, range } */
function opMerge(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!op.range) throw new Error('merge: range обязателен')
  if (!Array.isArray(sh.merged)) sh.merged = []
  if (!sh.merged.includes(op.range)) sh.merged.push(op.range)
}

/** freeze { sheet, ref } */
function opFreeze(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!op.ref) throw new Error('freeze: ref обязателен')
  parseRef(op.ref) // валидация
  sh.freeze = op.ref
}

/** auto_filter { sheet, range } */
function opAutoFilter(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!op.range) throw new Error('auto_filter: range обязателен')
  parseRange(op.range) // валидация
  sh.autoFilter = op.range
}

/** protect { sheet, password?, options? } */
function opProtect(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const prot = {}
  if (op.password) prot.password = op.password
  if (op.options && typeof op.options === 'object') Object.assign(prot, op.options)
  sh.protection = prot
}

/** sort { sheet, range, byColumn, ascending } — стабильная сортировка строк диапазона */
function opSort(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!op.range) throw new Error('sort: range обязателен')
  const rng = parseRange(op.range)
  let colIdx
  if (typeof op.byColumn === 'string') colIdx = parseRef(op.byColumn + '1').col
  else colIdx = Number(op.byColumn || rng.c1)
  if (!(colIdx >= rng.c1 && colIdx <= rng.c2)) throw new Error('sort: byColumn вне диапазона')
  const asc = op.ascending !== false

  ensureRows(sh, rng.r2, rng.c2)

  // Извлечь строки диапазона
  const slice = []
  for (let r = rng.r1; r <= rng.r2; r++) slice.push(sh.rows[r - 1])

  const keyOf = (row) => {
    const cell = row[colIdx - 1]
    if (!cell || typeof cell !== 'object') return cell == null ? null : cell
    if (cell.formula != null) return cell.value != null ? cell.value : null
    return cell.value !== undefined ? cell.value : null
  }
  const cmp = (a, b) => {
    const ka = keyOf(a); const kb = keyOf(b)
    if (ka == null && kb == null) return 0
    if (ka == null) return 1
    if (kb == null) return -1
    if (typeof ka === 'number' && typeof kb === 'number') return ka - kb
    return String(ka).localeCompare(String(kb), 'ru')
  }
  slice.sort((a, b) => (asc ? cmp(a, b) : -cmp(a, b)))

  for (let i = 0; i < slice.length; i++) sh.rows[rng.r1 - 1 + i] = slice[i]
}

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** set_row_height { sheet, row, height } */
function opSetRowHeight(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const row = Number(op.row)
  if (!(row >= 1)) throw new Error('set_row_height: row (1-based) обязателен')
  if (op.height == null) throw new Error('set_row_height: height обязателен')
  if (!sh.rowHeights || typeof sh.rowHeights !== 'object') sh.rowHeights = {}
  sh.rowHeights[row] = Number(op.height)
}

/** hide_rows / unhide_rows { sheet, at (1-based), count? } */
function opHideRows(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const at = Math.max(1, Number(op.at || op.row || 1))
  const count = Math.max(1, Number(op.count || 1))
  if (!Array.isArray(sh.hiddenRows)) sh.hiddenRows = []
  for (let i = 0; i < count; i++) {
    const n = at + i
    if (!sh.hiddenRows.includes(n)) sh.hiddenRows.push(n)
  }
}
function opUnhideRows(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const at = Math.max(1, Number(op.at || op.row || 1))
  const count = Math.max(1, Number(op.count || 1))
  sh.hiddenRows = (sh.hiddenRows || []).filter((n) => !(n >= at && n < at + count))
  if (!sh.hiddenRows.length) delete sh.hiddenRows
}

/** hide_columns / unhide_columns { sheet, at (1-based), count? } */
function opHideColumns(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const at = Math.max(1, Number(op.at || op.column || 1))
  const count = Math.max(1, Number(op.count || 1))
  if (!Array.isArray(sh.hiddenColumns)) sh.hiddenColumns = []
  for (let i = 0; i < count; i++) {
    const n = at + i
    if (!sh.hiddenColumns.includes(n)) sh.hiddenColumns.push(n)
  }
}
function opUnhideColumns(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  const at = Math.max(1, Number(op.at || op.column || 1))
  const count = Math.max(1, Number(op.count || 1))
  sh.hiddenColumns = (sh.hiddenColumns || []).filter((n) => !(n >= at && n < at + count))
  if (!sh.hiddenColumns.length) delete sh.hiddenColumns
}

/** clear_cells { sheet, range } — значения+стиль ячеек диапазона → null */
function opClearCells(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!op.range) throw new Error('clear_cells: range обязателен')
  const rng = parseRange(op.range)
  for (let r = rng.r1; r <= rng.r2; r++) {
    const row = sh.rows[r - 1]
    if (!Array.isArray(row)) continue
    for (let c = rng.c1; c <= rng.c2; c++) row[c - 1] = null
  }
}

/** find_replace { sheet, find, replace?, matchCase? } — замена в текстовых значениях */
function opFindReplace(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (op.find == null || op.find === '') throw new Error('find_replace: find обязателен')
  const find = String(op.find)
  const replace = op.replace == null ? '' : String(op.replace)
  const caseSensitive = !!op.matchCase
  const re = caseSensitive ? null : new RegExp(escapeRegExp(find), 'gi')
  let n = 0
  for (const row of sh.rows || []) {
    const cells = Array.isArray(row) ? row : row && row.cells
    if (!cells) continue
    for (const cell of cells) {
      if (!cell || typeof cell !== 'object' || typeof cell.value !== 'string') continue
      if (caseSensitive ? cell.value.includes(find) : re.test(cell.value)) {
        cell.value = caseSensitive ? cell.value.split(find).join(replace) : cell.value.replace(re, replace)
        n++
      }
    }
  }
  op._replaced = n
}

/** copy_range { sheet, from ("A1:B2"), to ("D1" — левый верхний угол) } */
function opCopyRange(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!op.from || !op.to) throw new Error('copy_range: from и to обязательны')
  const src = parseRange(op.from)
  const dst = parseRef(op.to)
  const h = src.r2 - src.r1 + 1
  const w = src.c2 - src.c1 + 1
  ensureRows(sh, dst.row + h - 1, dst.col + w - 1)
  const grid = []
  for (let r = 0; r < h; r++) {
    const rowArr = []
    for (let c = 0; c < w; c++) {
      const cell = sh.rows[src.r1 - 1 + r][src.c1 - 1 + c]
      rowArr.push(cell && typeof cell === 'object' ? JSON.parse(JSON.stringify(cell)) : cell)
    }
    grid.push(rowArr)
  }
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) sh.rows[dst.row - 1 + r][dst.col - 1 + c] = grid[r][c]
  }
}

/** set_cell_style { sheet, range, style?, numFmt? } — единый стиль/формат на диапазон */
function opSetCellStyle(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!op.range) throw new Error('set_cell_style: range обязателен')
  if (!op.style && !op.numFmt) throw new Error('set_cell_style: нужен style и/или numFmt')
  const rng = parseRange(op.range)
  ensureRows(sh, rng.r2, rng.c2)
  for (let r = rng.r1; r <= rng.r2; r++) {
    for (let c = rng.c1; c <= rng.c2; c++) {
      const cur = sh.rows[r - 1][c - 1]
      const cell = cur && typeof cur === 'object' ? cur : (cur == null ? {} : { value: cur })
      if (op.style) cell.style = Object.assign({}, cell.style, op.style)
      if (op.numFmt) cell.numFmt = op.numFmt
      sh.rows[r - 1][c - 1] = Object.keys(cell).length ? cell : null
    }
  }
}

/** set_tab_color { name, color (hex, напр. "FF0000") } */
function opSetTabColor(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.name || op.sheet)]
  if (!op.color) throw new Error('set_tab_color: color обязателен (hex, напр. "FF0000")')
  sh.tabColor = String(op.color).replace('#', '')
}

/** hide_sheet / unhide_sheet { name, veryHidden? } */
function opHideSheet(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.name)]
  sh.hidden = op.veryHidden ? 'veryHidden' : true
}
function opUnhideSheet(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.name)]
  delete sh.hidden
}

/** add_comment { sheet, ref, text, author? } */
function opAddComment(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!op.ref) throw new Error('add_comment: ref обязателен')
  if (op.text == null) throw new Error('add_comment: text обязателен')
  const { col, row } = parseRef(op.ref)
  ensureRows(sh, row, col)
  const cur = sh.rows[row - 1][col - 1]
  const cell = cur && typeof cur === 'object' ? cur : (cur == null ? {} : { value: cur })
  cell.comment = { text: String(op.text) }
  if (op.author) cell.comment.author = String(op.author)
  sh.rows[row - 1][col - 1] = cell
}

/** remove_comment { sheet, ref } */
function opRemoveComment(spec, op) {
  const sh = spec.sheets[sheetIdx(spec, op.sheet)]
  if (!op.ref) throw new Error('remove_comment: ref обязателен')
  const { col, row } = parseRef(op.ref)
  const rowArr = sh.rows[row - 1]
  if (!Array.isArray(rowArr)) return
  const cur = rowArr[col - 1]
  if (cur && typeof cur === 'object') {
    delete cur.comment
    if (!Object.keys(cur).length) rowArr[col - 1] = null
  }
}

const OPS = {
  set_cells: opSetCells,
  insert_rows: opInsertRows,
  delete_rows: opDeleteRows,
  insert_columns: opInsertColumns,
  delete_columns: opDeleteColumns,
  add_sheet: opAddSheet,
  delete_sheet: opDeleteSheet,
  rename_sheet: opRenameSheet,
  set_column_width: opSetColumnWidth,
  set_row_height: opSetRowHeight,
  hide_rows: opHideRows,
  unhide_rows: opUnhideRows,
  hide_columns: opHideColumns,
  unhide_columns: opUnhideColumns,
  clear_cells: opClearCells,
  find_replace: opFindReplace,
  copy_range: opCopyRange,
  set_cell_style: opSetCellStyle,
  set_tab_color: opSetTabColor,
  hide_sheet: opHideSheet,
  unhide_sheet: opUnhideSheet,
  add_comment: opAddComment,
  remove_comment: opRemoveComment,
  merge: opMerge,
  freeze: opFreeze,
  auto_filter: opAutoFilter,
  protect: opProtect,
  sort: opSort,
}

/** applyOps(path, ops) → { stats, preview, applied } */
async function applyOps(path, ops) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('ops (массив операций) обязателен')

  const full = await readWorkbook(path, { mode: 'full' })
  const spec = full.spec

  const applied = []
  for (const op of ops) {
    if (!op || !op.op || !OPS[op.op]) {
      throw new Error('Неизвестная операция: ' + (op && op.op) + '. Доступно: ' + Object.keys(OPS).join(', '))
    }
    OPS[op.op](spec, op)
    applied.push(describeOp(op))
  }

  const built = await buildWorkbook(spec)
  // Бэкап оригинала до перезаписи (best-effort, не валит edit при ошибке)
  const backup = backupFile(path)
  fs.writeFileSync(path, built.buffer)

  return { stats: built.stats, preview: built.preview, applied, backup }
}

function describeOp(op) {
  switch (op.op) {
    case 'set_cells': return 'set_cells: ' + (op.cells ? op.cells.length : 0) + ' яч. на "' + op.sheet + '"'
    case 'insert_rows': return 'insert_rows: ' + op.count + ' стр. на ' + op.at + ' "' + op.sheet + '"'
    case 'delete_rows': return 'delete_rows: ' + op.count + ' стр. с ' + op.at + ' "' + op.sheet + '"'
    case 'insert_columns': return 'insert_columns: ' + op.count + ' кол. на ' + op.at + ' "' + op.sheet + '"'
    case 'delete_columns': return 'delete_columns: ' + op.count + ' кол. с ' + op.at + ' "' + op.sheet + '"'
    case 'add_sheet': return 'add_sheet: "' + op.name + '"'
    case 'delete_sheet': return 'delete_sheet: "' + op.name + '"'
    case 'rename_sheet': return 'rename_sheet: "' + op.name + '" → "' + op.to + '"'
    case 'set_column_width': return 'set_column_width: ' + op.column + ' = ' + op.width + ' "' + op.sheet + '"'
    case 'merge': return 'merge: ' + op.range + ' "' + op.sheet + '"'
    case 'freeze': return 'freeze: ' + op.ref + ' "' + op.sheet + '"'
    case 'auto_filter': return 'auto_filter: ' + op.range + ' "' + op.sheet + '"'
    case 'protect': return 'protect: "' + op.sheet + '"' + (op.password ? ' (с паролем)' : '')
    case 'sort': return 'sort: ' + op.range + ' по ' + op.byColumn + (op.ascending !== false ? ' ↑' : ' ↓')
    case 'set_row_height': return 'set_row_height: строка ' + op.row + ' = ' + op.height + ' "' + op.sheet + '"'
    case 'hide_rows': return 'hide_rows: ' + (op.count || 1) + ' стр. с ' + (op.at || 1) + ' "' + op.sheet + '"'
    case 'unhide_rows': return 'unhide_rows: ' + (op.count || 1) + ' стр. с ' + (op.at || 1) + ' "' + op.sheet + '"'
    case 'hide_columns': return 'hide_columns: ' + (op.count || 1) + ' кол. с ' + (op.at || 1) + ' "' + op.sheet + '"'
    case 'unhide_columns': return 'unhide_columns: ' + (op.count || 1) + ' кол. с ' + (op.at || 1) + ' "' + op.sheet + '"'
    case 'clear_cells': return 'clear_cells: ' + op.range + ' "' + op.sheet + '"'
    case 'find_replace': return 'find_replace: "' + op.find + '" → "' + (op.replace == null ? '' : op.replace) + '" (' + (op._replaced || 0) + ' яч.) "' + op.sheet + '"'
    case 'copy_range': return 'copy_range: ' + op.from + ' → ' + op.to + ' "' + op.sheet + '"'
    case 'set_cell_style': return 'set_cell_style: ' + op.range + ' "' + op.sheet + '"'
    case 'set_tab_color': return 'set_tab_color: "' + (op.name || op.sheet) + '" = ' + op.color
    case 'hide_sheet': return 'hide_sheet: "' + op.name + '"' + (op.veryHidden ? ' (veryHidden)' : '')
    case 'unhide_sheet': return 'unhide_sheet: "' + op.name + '"'
    case 'add_comment': return 'add_comment: ' + op.ref + ' "' + op.sheet + '"'
    case 'remove_comment': return 'remove_comment: ' + op.ref + ' "' + op.sheet + '"'
    default: return op.op
  }
}

module.exports = { applyOps }
