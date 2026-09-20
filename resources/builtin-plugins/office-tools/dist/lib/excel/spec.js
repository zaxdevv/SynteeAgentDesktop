// spec — сборка .xlsx из JSON-спеки (exceljs). Контракт: dist/lib/excel/specDoc.js
const ExcelJS = require('exceljs')
const { mapCellStyle } = require('./styles')
const { parseRef, specValueToCell } = require('./cells')

const SHEET_NAME_RE = /[\[\]:*?/\\]/

/** Применить стиль ячейки из спеки (numFmt + style) */
function applyCellSpec(cell, cellSpec) {
  if (cellSpec.numFmt) cell.numFmt = String(cellSpec.numFmt)
  const st = mapCellStyle(cellSpec.style)
  if (st) cell.style = Object.assign({}, cell.style, st)
}

/** hex → argb-объект цвета для CF (exceljs ColorXform) */
function cfColor(hex) {
  if (!hex || typeof hex !== 'string') return undefined
  let h = hex.replace('#', '').toUpperCase()
  if (h.length === 6) h = 'FF' + h
  return { argb: h }
}

/**
 * Нормализация правила условного форматирования.
 * exceljs требует обязательные поля ПРЯМО на правиле (cfvo/color/formulae),
 * иначе падает 'Cannot read properties of undefined (reading forEach)'.
 * Здесь — дефолты и валидация с понятной ошибкой.
 */
function mapCfRule(r) {
  if (!r || typeof r !== 'object') return null
  const type = r.type || 'cellIs'
  const rule = { type }

  // Общие поля
  if (r.priority != null) rule.priority = Number(r.priority)
  if (r.operator) rule.operator = r.operator
  if (r.style) {
    const st = {}
    if (r.style.fill) st.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + String(r.style.fill).replace('#', '').toUpperCase() } }
    if (r.style.color) st.font = { color: { argb: 'FF' + String(r.style.color).replace('#', '').toUpperCase() } }
    if (Object.keys(st).length) rule.style = st
  }

  if (type === 'colorScale') {
    // cfvo: точки шкалы; color: цвета (по числу точек)
    rule.cfvo = Array.isArray(r.cfvo) && r.cfvo.length
      ? r.cfvo.map((c) => (typeof c === 'string' ? { type: c } : c))
      : [{ type: 'min' }, { type: 'max' }]
    const colors = Array.isArray(r.colors) ? r.colors : Array.isArray(r.color) ? r.color : null
    rule.color = (colors || ['F8696B', '63BE7B']).map(cfColor).filter(Boolean)
    if (rule.color.length !== rule.cfvo.length) {
      // выравниваем количество цветов под точки
      while (rule.color.length < rule.cfvo.length) rule.color.push(rule.color[rule.color.length - 1])
      rule.color = rule.color.slice(0, rule.cfvo.length)
    }
    return rule
  }

  if (type === 'dataBar') {
    rule.cfvo = Array.isArray(r.cfvo) && r.cfvo.length
      ? r.cfvo.map((c) => (typeof c === 'string' ? { type: c } : c))
      : [{ type: 'min' }, { type: 'max' }]
    const c = r.color || r.barColor
    rule.color = c ? (typeof c === 'string' ? cfColor(c) : c) : undefined
    if (r.minLength != null) rule.minLength = Number(r.minLength)
    if (r.maxLength != null) rule.maxLength = Number(r.maxLength)
    if (r.showValue != null) rule.showValue = !!r.showValue
    return rule
  }

  if (type === 'iconSet') {
    rule.iconSet = r.iconSet || '3TrafficLights'
    if (r.reverse != null) rule.reverse = !!r.reverse
    if (r.showValue != null) rule.showValue = !!r.showValue
    rule.cfvo = Array.isArray(r.cfvo) && r.cfvo.length
      ? r.cfvo.map((c) => (typeof c === 'string' ? { type: c } : c))
      : [{ type: 'percent', value: 0 }, { type: 'percent', value: 33 }, { type: 'percent', value: 67 }]
    return rule
  }

  if (type === 'top10' || type === 'aboveAverage') {
    if (r.rank != null) rule.rank = Number(r.rank)
    if (r.percent != null) rule.percent = !!r.percent
    if (r.bottom != null) rule.bottom = !!r.bottom
    return rule
  }

  if (type === 'containsText' || type === 'timePeriod') {
    if (r.text) rule.text = String(r.text)
    return rule
  }

  // cellIs / expression — требуют formulae
  if (!Array.isArray(r.formulae) || !r.formulae.length) {
    throw new Error(
      'conditionalFormatting: правило ' + type + ' требует formulae (массив, например ["100"] или ["A1>0"])',
    )
  }
  rule.formulae = r.formulae.map(String)
  return rule
}

/** Нормализовать строку спеки → { cells: [...], height, style } */
function normalizeRow(row) {
  if (row === null || row === undefined) return { cells: [], height: null, style: null }
  if (Array.isArray(row)) return { cells: row, height: null, style: null }
  if (typeof row === 'object') {
    return {
      cells: Array.isArray(row.cells) ? row.cells : [],
      height: row.height != null ? Number(row.height) : null,
      style: row.style || null,
    }
  }
  return { cells: [row], height: null, style: null }
}

/** Нормализовать cell → объектная форма */
function normalizeCell(cell) {
  if (cell === null || cell === undefined) return null
  if (typeof cell !== 'object' || Array.isArray(cell)) {
    return { value: cell }
  }
  return cell
}

/** Собрать workbook из спеки. → { buffer, stats, preview } */
async function buildWorkbook(spec) {
  if (!spec || !Array.isArray(spec.sheets) || !spec.sheets.length) {
    throw new Error('spec.sheets (массив листов) обязателен')
  }
  const wb = new ExcelJS.Workbook()
  const stats = { sheets: 0, rows: 0, cells: 0, formulas: 0, merged: 0 }
  let firstSheetName = null
  let firstSheetRows = null // массив значений для превью

  for (const sheetSpec of spec.sheets) {
    if (!sheetSpec || typeof sheetSpec !== 'object') throw new Error('Лист должен быть объектом')
    const name = String(sheetSpec.name || 'Sheet' + (stats.sheets + 1))
    if (name.length > 31 || SHEET_NAME_RE.test(name)) {
      throw new Error('Недопустимое имя листа: ' + name + ' (≤31 символ, без []:*?/\\)')
    }
    const ws = wb.addWorksheet(name)

    // Ширины колонок
    if (Array.isArray(sheetSpec.columns)) {
      sheetSpec.columns.forEach((c, i) => {
        const w = typeof c === 'object' && c ? c.width : c
        if (w != null) ws.getColumn(i + 1).width = Number(w)
      })
    }

    // Строки и ячейки
    const rowsSpec = Array.isArray(sheetSpec.rows) ? sheetSpec.rows : []
    for (let r = 0; r < rowsSpec.length; r++) {
      const rowSpec = normalizeRow(rowsSpec[r])
      stats.rows++
      const xlsxRow = ws.getRow(r + 1)
      if (rowSpec.height != null) xlsxRow.height = rowSpec.height
      const rowStyle = mapCellStyle(rowSpec.style)
      for (let c = 0; c < rowSpec.cells.length; c++) {
        const cellSpec = normalizeCell(rowSpec.cells[c])
        if (!cellSpec) continue
        const cell = xlsxRow.getCell(c + 1)
        cell.value = specValueToCell(cellSpec)
        if (cellSpec.formula) stats.formulas++
        stats.cells++
        if (rowStyle) cell.style = Object.assign({}, cell.style, rowStyle)
        applyCellSpec(cell, cellSpec)
        if (cellSpec.hyperlink && typeof cellSpec.hyperlink === 'string') {
          cell.value = { text: String(cellSpec.value != null ? cellSpec.value : cellSpec.hyperlink), hyperlink: cellSpec.hyperlink }
        }
        if (cellSpec.comment) {
          const cm = cellSpec.comment
          const text = typeof cm === 'string' ? cm : (cm && cm.text) || ''
          if (text) cell.note = { texts: [{ text: String(text) }] }
        }
      }
    }

    // Высоты строк и скрытие строк/колонок
    if (sheetSpec.rowHeights && typeof sheetSpec.rowHeights === 'object') {
      for (const [k, v] of Object.entries(sheetSpec.rowHeights)) {
        const n = parseInt(k, 10)
        if (n >= 1 && v != null) ws.getRow(n).height = Number(v)
      }
    }
    if (Array.isArray(sheetSpec.hiddenRows)) {
      for (const n of sheetSpec.hiddenRows) { if (Number(n) >= 1) ws.getRow(Number(n)).hidden = true }
    }
    if (Array.isArray(sheetSpec.hiddenColumns)) {
      for (const n of sheetSpec.hiddenColumns) { if (Number(n) >= 1) ws.getColumn(Number(n)).hidden = true }
    }

    // Цвет ярлыка листа
    if (sheetSpec.tabColor) {
      if (!ws.properties) ws.properties = {}
      ws.properties.tabColor = cfColor(sheetSpec.tabColor) || undefined
    }

    // Скрытый лист (state: visible | hidden | veryHidden)
    if (sheetSpec.hidden) {
      try { ws.state = sheetSpec.hidden === 'veryHidden' ? 'veryHidden' : 'hidden' } catch (e) { /* ignore: экзотический exceljs */ }
    }

    // Merged
    if (Array.isArray(sheetSpec.merged)) {
      for (const range of sheetSpec.merged) {
        ws.mergeCells(String(range))
        stats.merged++
      }
    }

    // Freeze
    if (sheetSpec.freeze) {
      const { col, row } = parseRef(sheetSpec.freeze)
      ws.views = [{ state: 'frozen', xSplit: col - 1, ySplit: row - 1 }]
    }

    // AutoFilter
    if (sheetSpec.autoFilter) ws.autoFilter = String(sheetSpec.autoFilter)

    // Data validation
    if (Array.isArray(sheetSpec.dataValidation)) {
      for (const dv of sheetSpec.dataValidation) {
        if (!dv || !dv.range) continue
        const rule = {
          type: dv.type || 'list',
          allowBlank: dv.allowBlank !== false,
          showErrorMessage: dv.showErrorMessage !== false,
        }
        if (dv.operator) rule.operator = dv.operator
        if (Array.isArray(dv.formulae)) rule.formulae = dv.formulae.map(String)
        if (dv.promptTitle) rule.promptTitle = dv.promptTitle
        if (dv.prompt) rule.prompt = dv.prompt
        if (dv.errorTitle) rule.errorTitle = dv.errorTitle
        if (dv.error) rule.error = dv.error
        ws.getCell(dv.range).dataValidation = rule
      }
    }

    // Conditional formatting
    if (Array.isArray(sheetSpec.conditionalFormatting)) {
      for (const cf of sheetSpec.conditionalFormatting) {
        if (!cf || !cf.range || !Array.isArray(cf.rules)) continue
        const rules = cf.rules.map((r) => mapCfRule(r)).filter(Boolean)
        if (rules.length) ws.addConditionalFormatting({ ref: String(cf.range), rules })
      }
    }

    // Защита листа — ПОСЛЕ заполнения
    if (sheetSpec.protection && typeof sheetSpec.protection === 'object') {
      const pr = sheetSpec.protection
      const opts = {}
      for (const k of ['selectLockedCells', 'selectUnlockedCells', 'formatCells', 'formatColumns', 'formatRows', 'insertRows', 'insertColumns', 'insertHyperlinks', 'deleteRows', 'deleteColumns', 'sort', 'autoFilter', 'pivotTables', 'objects', 'scenarios']) {
        if (pr[k] != null) opts[k] = !!pr[k]
      }
      ws.protect(pr.password || undefined, Object.keys(opts).length ? opts : undefined)
    }

    stats.sheets++

    // Превью первого листа
    if (firstSheetRows === null) {
      firstSheetName = name
      firstSheetRows = []
      for (let r = 0; r < Math.min(rowsSpec.length, 10); r++) {
        const rowSpec = normalizeRow(rowsSpec[r])
        const vals = []
        for (let c = 0; c < rowSpec.cells.length; c++) {
          const cs = normalizeCell(rowSpec.cells[c])
          if (!cs) { vals.push(null); continue }
          if (cs.formula) vals.push(cs.value != null ? cs.value : null)
          else vals.push(cs.value === undefined ? null : cs.value)
        }
        firstSheetRows.push(vals)
      }
    }
  }

  // Named ranges
  if (Array.isArray(spec.definedNames)) {
    for (const dn of spec.definedNames) {
      if (!dn || !dn.name || !dn.range) continue
      wb.definedNames.add(String(dn.range), String(dn.name))
    }
  }

  const buffer = await wb.xlsx.writeBuffer()

  // totalRows/totalCols первого листа
  let totalRows = 0
  let totalCols = 0
  const rowsSpec0 = Array.isArray(spec.sheets[0].rows) ? spec.sheets[0].rows : []
  totalRows = rowsSpec0.length
  for (const row of rowsSpec0) {
    const rs = normalizeRow(row)
    if (rs.cells.length > totalCols) totalCols = rs.cells.length
  }

  return {
    buffer: Buffer.from(buffer),
    stats,
    preview: { name: firstSheetName, rows: firstSheetRows, totalRows, totalCols },
  }
}

module.exports = { buildWorkbook }
