// excelRead — тул excel_read: чтение .xlsx (meta | values | formulas | full)
const state = require('../state')
const settings = require('../lib/settings')
const recent = require('../lib/recent')
const widgets = require('../ui/widgets')

async function readExcel({ path: p, sheet, range, mode }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)

  const reader = require('../lib/excel/read')
  const m = mode || 'values'
  const res = await reader.readWorkbook(p, { sheet, range, mode: m })

  // Журнал + превью панели
  if (res.meta) {
    await recent.add({
      path: p,
      kind: 'excel',
      op: 'read',
      name: p.split(/[\\/]/).pop(),
      size: st.size,
      stats: res.meta.stats || null,
      preview: res.meta.preview || null,
    })
  }

  // Виджет-превью таблицы для values-режима
  const s = await settings.get()
  if (m === 'values' && s.showPreview && res.preview) {
    return (
      widgets.tablePreview({
        path: p,
        name: p.split(/[\\/]/).pop(),
        sheet: res.preview.name,
        rows: res.preview.rows,
        totalRows: res.preview.totalRows,
        totalCols: res.preview.totalCols,
      }) + '\n' + JSON.stringify(res.meta.stats)
    )
  }
  return typeof res === 'string' ? res : JSON.stringify(res, null, 1)
}

function registerExcelReadTools(syntee) {
  syntee.registerTool({
    name: 'excel_read',
    description:
      'Read an .xlsx file. Modes: "meta" (sheets list: name/rows/cols/merged/hasFormulas), "values" (cell values of a sheet, default — returns a table preview widget), "formulas" (values + formula strings), "full" (full JSON spec suitable for rebuilding via excel_create/excel_edit: cells, styles, merges, freeze, filters, protection, data validation, conditional formatting, comments, row heights, hidden rows/columns/sheets, tab color). Optional sheet name (default first) and range like "A1:C20".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .xlsx' },
        sheet: { type: 'string', description: 'Sheet name (default: first sheet)' },
        range: { type: 'string', description: 'Range like "A1:C20" (default: used range)' },
        mode: { type: 'string', enum: ['meta', 'values', 'formulas', 'full'] },
      },
      required: ['path'],
    },
    handler: readExcel,
  })
}

module.exports = { registerExcelReadTools, readExcel }
