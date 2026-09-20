// excelCreate — тул excel_create: .xlsx из JSON-спеки + excel_spec_docs
const state = require('../state')
const paths = require('../lib/paths')
const settings = require('../lib/settings')
const recent = require('../lib/recent')
const widgets = require('../ui/widgets')

async function createExcelFile({ path: p, name, spec, open }) {
  const api = state.api
  if (!spec || !Array.isArray(spec.sheets) || !spec.sheets.length) {
    throw new Error('spec.sheets (массив листов) обязателен. Формат спеки: тул excel_spec_docs')
  }
  const builder = require('../lib/excel/spec')
  const target = await paths.resolveTarget({ path: p, name, ext: '.xlsx' })

  const built = await builder.buildWorkbook(spec)
  await api.fs.writeFile(target, Buffer.from(built.buffer).toString('base64'), { encoding: 'base64' })

  const st = await api.fs.stat(target)
  await recent.add({
    path: target,
    kind: 'excel',
    op: 'create',
    name: target.split(/[\\/]/).pop(),
    size: st.size,
    stats: built.stats,
    preview: built.preview,
  })

  let extra = ''
  if (open) {
    try {
      const com = require('../lib/com/excel')
      await com.openBook(target)
    } catch (e) {
      extra = '\n(Excel не открылся: ' + e.message + ')'
    }
  }

  const s = await settings.get()
  if (!s.showPreview) {
    return 'Создан файл: ' + target + '\n' + JSON.stringify(built.stats) + extra
  }
  return widgets.fileCard({
    entry: {
      path: target,
      kind: 'excel',
      op: 'create',
      name: target.split(/[\\/]/).pop(),
      size: st.size,
      stats: built.stats,
      outline: null,
    },
  }) + extra
}

function registerExcelTools(syntee) {
  syntee.registerTool({
    name: 'excel_create',
    description:
      'Create an Excel .xlsx workbook from a JSON spec. Supports: multiple sheets, cell values/formulas/number formats, full cell styling (fonts, fills, borders, alignment), merged cells, column widths, row heights, freeze panes, autofilter, data validation, conditional formatting, named ranges, sheet protection. Call excel_spec_docs first for the exact spec format. Returns a file card widget.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute output .xlsx path. Omit to auto-save into the configured save dir' },
        name: { type: 'string', description: 'File name without extension (used when path omitted)' },
        spec: {
          type: 'object',
          description: 'Workbook spec: { sheets: [sheet, ...], definedNames? }. See excel_spec_docs',
        },
        open: { type: 'boolean', description: 'Open the file in MS Excel after creation (default false)' },
      },
      required: ['spec'],
    },
    handler: createExcelFile,
  })

  syntee.registerTool({
    name: 'excel_spec_docs',
    description:
      'Returns the full reference for the excel_create JSON spec format: sheets, rows, cells (values/formulas/numFmt), styles, merges, validation, conditional formatting, protection, named ranges. Read it before building complex workbooks.',
    parameters: { type: 'object', properties: {} },
    handler: async () => require('../lib/excel/specDoc').specDoc(),
  })
}

module.exports = { registerExcelTools, createExcelFile }
