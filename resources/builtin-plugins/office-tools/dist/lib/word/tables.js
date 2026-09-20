// tables — таблицы спеки → docx Table: rows/cells, header-строка (повтор на
// новых страницах), columnWidths (см → twips), borders (style/size/color),
// заливка fill, colspan/rowspan, verticalAlign, пресеты стилей.

const docx = require('docx')
const { alignType, cmToTwips, runProps } = require('./styles')

const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, BorderStyle,
  ShadingType, VerticalAlign, AlignmentType } = docx

const BORDER_STYLES = {
  single: BorderStyle.SINGLE, double: BorderStyle.DOUBLE,
  dashed: BorderStyle.DASHED, dotted: BorderStyle.DOTTED,
  dashsmallgap: BorderStyle.DASH_SMALL_GAP, thick: BorderStyle.THICK,
  none: BorderStyle.NONE, nil: BorderStyle.NIL,
}

function borderStyle(s) {
  return BORDER_STYLES[String(s || 'single').toLowerCase()] || BorderStyle.SINGLE
}

/** borders-объект спеки { style, size, color } → docx-стороны (top/bottom/left/right). */
function specBorders(b) {
  if (!b) return undefined
  const side = {
    style: borderStyle(b.style),
    size: Math.round(Number(b.size) || 4),
    color: (b.color || 'auto').replace('#', ''),
  }
  return { top: side, bottom: side, left: side, right: side, insideHorizontal: side, insideVertical: side }
}

/** Пресеты стилей таблиц (поле block.style). */
const TABLE_PRESETS = {
  'table-grid': { borders: { style: 'single', size: 4, color: 'auto' } },
  'light-shading': { borders: { style: 'single', size: 4, color: 'auto' }, headerFill: 'DEEBF7' },
  'medium-shading-1': { borders: { style: 'single', size: 8, color: 'auto' }, headerFill: 'BDD6EE' },
  'no-border': { borders: { style: 'none', size: 0, color: 'auto' } },
}

const VALIGN = {
  top: VerticalAlign.TOP, center: VerticalAlign.CENTER, middle: VerticalAlign.CENTER,
  bottom: VerticalAlign.BOTTOM,
}

/** Ячейка спеки → docx TableCell. */
function buildCell(cell, opts) {
  const c = typeof cell === 'string' ? { text: cell } : cell || {}
  const runBase = runProps({
    bold: c.bold !== undefined ? c.bold : opts.forceBold,
    italic: c.italic,
    font: c.font,
    size: c.size,
    color: c.color,
  })
  const texts = c.runs
    ? null
    : String(c.text == null ? '' : c.text).split(/\n/)
  const paragraphs = c.runs
    ? [new Paragraph({
        alignment: alignType(c.align),
        children: c.runs.map((r) => new TextRun({ text: String(r && r.text != null ? r.text : r), ...runProps(r || {}), ...runBase })),
      })]
    : texts.map((t) => new Paragraph({
        alignment: alignType(c.align),
        children: [new TextRun({ text: t, ...runBase })],
      }))
  const cellOpts = { children: paragraphs }
  if (c.colspan && c.colspan > 1) cellOpts.columnSpan = Math.round(Number(c.colspan))
  if (c.rowspan && c.rowspan > 1) cellOpts.rowSpan = Math.round(Number(c.rowspan))
  if (c.fill && c.fill !== 'auto') {
    cellOpts.shading = { fill: String(c.fill).replace('#', ''), type: ShadingType.CLEAR, color: 'auto' }
  } else if (opts.headerFill) {
    cellOpts.shading = { fill: opts.headerFill, type: ShadingType.CLEAR, color: 'auto' }
  }
  if (c.verticalAlign) cellOpts.verticalAlign = VALIGN[String(c.verticalAlign).toLowerCase()]
  const cb = specBorders(c.borders)
  if (cb) cellOpts.borders = cb
  if (c.width) cellOpts.width = { size: cmToTwips(c.width), type: WidthType.DXA }
  return new TableCell(cellOpts)
}

/**
 * table-блок спеки → docx Table. Обновляет stats.tables (вызывает сам).
 * opts.smartBreaks → cantSplit у строк (не разрывать строку между страницами);
 * block.allowSplit === true отключает cantSplit для всей таблицы.
 */
function buildTable(block, stats, opts) {
  if (!Array.isArray(block.rows) || !block.rows.length) {
    throw new Error('table.rows (массив строк) обязателен')
  }
  const preset = TABLE_PRESETS[String(block.style || '').toLowerCase()] || {}
  const borders = specBorders(block.borders) || specBorders(preset.borders)
  const headerFill = block.headerFill || preset.headerFill
  const noSplit = !!(opts && opts.smartBreaks !== false) && block.allowSplit !== true

  const rows = block.rows.map((row, ri) => {
    const cells = (row || []).map((cell) => buildCell(cell, {
      forceBold: !!(block.header && ri === 0),
      headerFill: block.header && ri === 0 ? headerFill : undefined,
    }))
    if (!cells.length) cells.push(buildCell('', {}))
    return new TableRow({
      children: cells,
      ...(block.header && ri === 0 ? { tableHeader: true } : {}),
      ...(noSplit ? { cantSplit: true } : {}),
    })
  })

  const tableOpts = { rows }
  if (borders) tableOpts.borders = borders
  if (Array.isArray(block.columnWidths) && block.columnWidths.length) {
    tableOpts.columnWidths = block.columnWidths.map((cm) => cmToTwips(cm))
  }
  const widthPct = Number(block.width)
  if (widthPct > 0) tableOpts.width = { size: widthPct, type: WidthType.PERCENTAGE }
  else if (opts.columnWidths) {
    opts.width = { size: opts.columnWidths.reduce((a, b) => a + b, 0), type: WidthType.DXA }
  }
  if (block.align) tableOpts.alignment = alignType(block.align) || AlignmentType.CENTER
  return new Table(tableOpts)
}

module.exports = { buildTable, specBorders, TABLE_PRESETS }
