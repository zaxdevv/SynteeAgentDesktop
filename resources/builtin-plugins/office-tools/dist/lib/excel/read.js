// read — чтение .xlsx (exceljs): meta | values | formulas | full
const fs = require('fs')
const ExcelJS = require('exceljs')
const { parseRange, rangeToString, cellToPlainValue, cellToFormula, cellToSpecValue, parseRef, numToLetters } = require('./cells')
const { unmapStyle } = require('./styles')

async function loadWorkbook(path) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  return wb
}

/** Использованный диапазон листа → { c1, r1, c2, r2 } */
function usedRange(ws) {
  let maxR = 0
  let maxC = 0
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn > maxR) maxR = rn
    row.eachCell({ includeEmpty: false }, (cell) => {
      const c = cell.col
      if (c > maxC) maxC = c
    })
  })
  if (maxR === 0 || maxC === 0) return { c1: 1, r1: 1, c2: 1, r2: 1, empty: true }
  return { c1: 1, r1: 1, c2: maxC, r2: maxR, empty: false }
}

/** Статы по всему workbook */
function workbookStats(wb) {
  const stats = { sheets: wb.worksheets.length, rows: 0, cells: 0, formulas: 0, merged: 0 }
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      stats.rows++
      row.eachCell({ includeEmpty: false }, (cell) => {
        stats.cells++
        if (cellToFormula(cell)) stats.formulas++
      })
    })
    stats.merged += ws.model && ws.model.merges ? ws.model.merges.length : 0
  }
  return stats
}

function findSheet(wb, sheetName) {
  if (!sheetName) return wb.worksheets[0]
  const ws = wb.getWorksheet(sheetName)
  if (!ws) {
    // Подсказка модели: какие листы ЕСТЬ (баг-репорт «не шарит что есть»).
    const names = wb.worksheets.map((w) => '"' + w.name + '"').join(', ')
    throw new Error('Лист не найден: ' + sheetName + '. Доступные листы: ' + names)
  }
  return ws
}

/** Матрица значений листа в диапазоне rng (plain values) */
function matrixValues(ws, rng, mode) {
  const out = []
  for (let r = rng.r1; r <= rng.r2; r++) {
    const rowArr = []
    for (let c = rng.c1; c <= rng.c2; c++) {
      const cell = ws.getRow(r).getCell(c)
      if (mode === 'formulas') {
        const f = cellToFormula(cell)
        rowArr.push(f || cellToPlainValue(cell))
      } else {
        rowArr.push(cellToPlainValue(cell))
      }
    }
    out.push(rowArr)
  }
  return out
}

/**
 * Адреса ячеек одной правила (dv/cf) → массив диапазонов.
 * Если адреса образуют прямоугольник — один диапазон "B2:B4",
 * иначе возвращаем отдельные адреса (каждый станет отдельной записью спеки).
 */
function compactAddrRanges(addrs) {
  if (!Array.isArray(addrs) || !addrs.length) return []
  if (addrs.length === 1) return [addrs[0]]
  const parsed = []
  for (const a of addrs) {
    try { const { col, row } = parseRef(a); parsed.push({ col, row }) } catch (e) { return addrs.slice() }
  }
  const minCol = Math.min(...parsed.map((p) => p.col))
  const maxCol = Math.max(...parsed.map((p) => p.col))
  const minRow = Math.min(...parsed.map((p) => p.row))
  const maxRow = Math.max(...parsed.map((p) => p.row))
  const expected = (maxCol - minCol + 1) * (maxRow - minRow + 1)
  if (parsed.length === expected) {
    return [numToLetters(minCol) + minRow + ':' + numToLetters(maxCol) + maxRow]
  }
  return addrs.slice()
}

/** exceljs CF rule → спека-правило (hex без #, cfvo/colors/iconSet) */
function cfRuleToSpec(r) {
  if (!r || !r.type) return null
  const rule = { type: r.type }
  if (r.priority != null) rule.priority = r.priority
  if (r.operator) rule.operator = r.operator
  if (Array.isArray(r.formulae) && r.formulae.length) rule.formulae = r.formulae.map(String)
  if (r.text != null) rule.text = String(r.text)
  if (r.rank != null) rule.rank = r.rank
  if (r.percent != null) rule.percent = r.percent
  if (r.bottom != null) rule.bottom = r.bottom
  if (r.showValue != null) rule.showValue = r.showValue
  if (r.reverse != null) rule.reverse = r.reverse
  if (r.iconSet) rule.iconSet = r.iconSet
  if (r.minLength != null) rule.minLength = r.minLength
  if (r.maxLength != null) rule.maxLength = r.maxLength
  if (Array.isArray(r.cfvo) && r.cfvo.length) rule.cfvo = r.cfvo
  const colors = Array.isArray(r.color) ? r.color : null
  if (colors) {
    const hexes = colors.map((c) => (c && c.argb ? String(c.argb).slice(2) : (typeof c === 'string' ? c : null))).filter(Boolean)
    if (hexes.length) { if (r.type === 'colorScale') rule.colors = hexes; else rule.color = hexes[0] }
  }
  if (r.style) {
    const st = {}
    const fill = r.style.fill
    const fillArgb = fill && ((fill.fgColor && fill.fgColor.argb) || (fill.bgColor && fill.bgColor.argb))
    if (fillArgb) st.fill = String(fillArgb).slice(2)
    if (r.style.font && r.style.font.color && r.style.font.color.argb) st.color = String(r.style.font.color.argb).slice(2)
    if (Object.keys(st).length) rule.style = st
  }
  return rule
}

/** readWorkbook(path, { sheet, range, mode }) */
async function readWorkbook(path, opts) {
  const { sheet, range, mode } = opts || {}
  const wb = await loadWorkbook(path)

  if (mode === 'meta') {
    const sheets = wb.worksheets.map((ws) => {
      const ur = usedRange(ws)
      const hasFormulas = (() => {
        let has = false
        ws.eachRow({ includeEmpty: false }, (row) => {
          row.eachCell({ includeEmpty: false }, (cell) => {
            if (cellToFormula(cell)) has = true
          })
        })
        return has
      })()
      const merged = ws.model && ws.model.merges ? ws.model.merges.slice() : []
      return {
        name: ws.name,
        rowCount: ur.empty ? 0 : ur.r2,
        columnCount: ur.empty ? 0 : ur.c2,
        merged,
        hasFormulas,
      }
    })
    return { meta: { stats: workbookStats(wb) }, sheets }
  }

  if (mode === 'full') {
    const spec = { sheets: [] }
    for (const ws of wb.worksheets) {
      const sheetSpec = { name: ws.name, rows: [] }
      const ur = usedRange(ws)

      // Ширины колонок
      const widths = []
      for (let c = 1; c <= ur.c2; c++) {
        const col = ws.getColumn(c)
        if (col && col.width != null) widths.push(Math.round(col.width * 10) / 10)
        else widths.push(null)
      }
      let lastNonNull = -1
      widths.forEach((w, i) => { if (w != null) lastNonNull = i })
      if (lastNonNull >= 0) {
        sheetSpec.columns = widths.slice(0, lastNonNull + 1).map((w) => (w == null ? 8.43 : w))
      }

      // Ячейки
      for (let r = 1; r <= ur.r2; r++) {
        const rowCells = []
        let any = false
        for (let c = 1; c <= ur.c2; c++) {
          const cell = ws.getRow(r).getCell(c)
          const val = cellToSpecValue(cell)
          const hasVal = val.formula != null || val.value !== null && val.value !== undefined && val.value !== ''
          const style = unmapStyle(cell)
          const numFmt = cell.numFmt && cell.numFmt !== 'General' ? cell.numFmt : null
          const note = cell.note
          let comment = null
          if (note) {
            const text = typeof note === 'string' ? note : (Array.isArray(note.texts) ? note.texts.map((t) => (t && t.text) || '').join('') : '')
            if (text) comment = { text }
          }
          if (hasVal || style || numFmt || val.hyperlink || comment) {
            any = true
            const cs = {}
            if (val.formula != null) cs.formula = val.formula
            else if (val.value !== null && val.value !== undefined) cs.value = val.value
            if (val.hyperlink) cs.hyperlink = val.hyperlink
            if (numFmt) cs.numFmt = numFmt
            if (style) cs.style = style
            if (comment) cs.comment = comment
            rowCells.push(cs)
          } else {
            rowCells.push(null)
          }
        }
        if (any) sheetSpec.rows.push(rowCells)
        else sheetSpec.rows.push([])
      }
      // Обрезаем пустые строки в конце
      while (sheetSpec.rows.length && sheetSpec.rows[sheetSpec.rows.length - 1].length === 0) sheetSpec.rows.pop()

      // Merged
      if (ws.model && ws.model.merges && ws.model.merges.length) {
        sheetSpec.merged = ws.model.merges.slice()
      }

      // Freeze
      const view = ws.views && ws.views[0]
      if (view && view.state === 'frozen') {
        const ref = require('./cells').numToLetters((view.xSplit || 0) + 1) + ((view.ySplit || 0) + 1)
        sheetSpec.freeze = ref
      }

      // AutoFilter
      if (ws.autoFilter) {
        const af = ws.autoFilter
        sheetSpec.autoFilter = typeof af === 'string' ? af : rangeToString({ c1: af.from.col, r1: af.from.row, c2: af.to.col, r2: af.to.row })
      }

      // Защита
      if (ws.sheetProtection && (ws.sheetProtection.sheet || Object.keys(ws.sheetProtection).some((k) => k !== 'sheet'))) {
        const sp = ws.sheetProtection
        const prot = {}
        for (const k of ['selectLockedCells', 'selectUnlockedCells', 'formatCells', 'formatColumns', 'formatRows', 'insertRows', 'insertColumns', 'insertHyperlinks', 'deleteRows', 'deleteColumns', 'sort', 'autoFilter', 'pivotTables']) {
          if (sp[k] != null) prot[k] = !!sp[k]
        }
        if (Object.keys(prot).length) sheetSpec.protection = prot
      }

      // Data validation (сохраняем при edit: иначе правило теряется на пересборке)
      const dvModel = ws.dataValidations && ws.dataValidations.model
      if (dvModel && Object.keys(dvModel).length) {
        const groups = new Map() // validation obj (по ссылке) → [адреса]
        for (const [addr, dv] of Object.entries(dvModel)) {
          if (!dv) continue
          if (!groups.has(dv)) groups.set(dv, [])
          groups.get(dv).push(addr)
        }
        const dvList = []
        for (const [dv, addrs] of groups) {
          for (const range of compactAddrRanges(addrs)) {
            const entry = { range }
            if (dv.type && dv.type !== 'any') entry.type = dv.type
            if (dv.allowBlank === false) entry.allowBlank = false
            if (dv.showErrorMessage === false) entry.showErrorMessage = false
            if (dv.operator) entry.operator = dv.operator
            if (Array.isArray(dv.formulae) && dv.formulae.length) entry.formulae = dv.formulae.map(String)
            if (dv.prompt) entry.prompt = dv.prompt
            if (dv.promptTitle) entry.promptTitle = dv.promptTitle
            if (dv.errorTitle) entry.errorTitle = dv.errorTitle
            if (dv.error) entry.error = dv.error
            dvList.push(entry)
          }
        }
        if (dvList.length) sheetSpec.dataValidation = dvList
      }

      // Conditional formatting (сохраняем при edit: иначе правило теряется на пересборке)
      if (Array.isArray(ws.conditionalFormattings) && ws.conditionalFormattings.length) {
        const cfList = []
        for (const cf of ws.conditionalFormattings) {
          if (!cf || !cf.ref || !Array.isArray(cf.rules) || !cf.rules.length) continue
          const rules = cf.rules.map(cfRuleToSpec).filter(Boolean)
          if (rules.length) cfList.push({ range: String(cf.ref), rules })
        }
        if (cfList.length) sheetSpec.conditionalFormatting = cfList
      }

      // Высоты и скрытие строк
      const rowHeights = {}
      const hiddenRows = []
      ws.eachRow({ includeEmpty: false }, (row) => {
        if (row.height != null) rowHeights[row.number] = row.height
        if (row.hidden) hiddenRows.push(row.number)
      })
      if (Object.keys(rowHeights).length) sheetSpec.rowHeights = rowHeights
      if (hiddenRows.length) sheetSpec.hiddenRows = hiddenRows

      // Скрытие колонок
      const hiddenColumns = []
      for (let c = 1; c <= ur.c2; c++) {
        const col = ws.getColumn(c)
        if (col && col.hidden) hiddenColumns.push(c)
      }
      if (hiddenColumns.length) sheetSpec.hiddenColumns = hiddenColumns

      // Цвет ярлыка листа
      const tabColor = ws.properties && ws.properties.tabColor
      if (tabColor && tabColor.argb) sheetSpec.tabColor = String(tabColor.argb).slice(2)

      // Скрытый лист
      if (ws.state && ws.state !== 'visible') sheetSpec.hidden = ws.state === 'veryHidden' ? 'veryHidden' : true

      spec.sheets.push(sheetSpec)
    }
    return { spec }
  }

  // values | formulas (default values)
  const ws = findSheet(wb, sheet)
  const ur = usedRange(ws)
  let rng = ur
  if (range) {
    const pr = parseRange(range)
    rng = { c1: pr.c1, r1: pr.r1, c2: pr.c2, r2: pr.r2 }
  }
  const values = matrixValues(ws, rng, mode === 'formulas' ? 'formulas' : 'values')

  // preview: первые 10 строк used range (без range-ограничения)
  const previewRows = matrixValues(ws, { c1: ur.c1, r1: ur.r1, c2: ur.c2, r2: Math.min(ur.r2, ur.r1 + 9) }, 'values')

  return {
    preview: {
      name: ws.name,
      rows: previewRows,
      totalRows: ur.empty ? 0 : ur.r2,
      totalCols: ur.empty ? 0 : ur.c2,
    },
    meta: { stats: workbookStats(wb) },
    values,
  }
}

module.exports = { readWorkbook, loadWorkbook, usedRange, workbookStats }
