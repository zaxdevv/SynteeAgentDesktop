// com — тулы office_open / word_export_pdf (COM-автоматизация MS Office)
const state = require('../state')
const recent = require('../lib/recent')

function extOf(p) {
  return (p.split('.').pop() || '').toLowerCase()
}

async function officeOpen({ path: p, app }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)

  const ext = extOf(p)
  if (ext === 'docx' || ext === 'doc' || app === 'word') {
    const com = require('../lib/com/word')
    await com.openDoc(p)
    return 'Открыто в Word: ' + p
  }
  if (ext === 'xlsx' || ext === 'xls' || app === 'excel') {
    const com = require('../lib/com/excel')
    await com.openBook(p)
    return 'Открыто в Excel: ' + p
  }
  if (ext === 'pptx' || ext === 'ppt' || ext === 'ppsx' || app === 'powerpoint') {
    const com = require('../lib/com/powerpoint')
    await com.openPres(p)
    return 'Открыто в PowerPoint: ' + p
  }
  const shell = require('../lib/com/shell')
  await shell.openWithDefault(p)
  return 'Открыто: ' + p
}

async function wordExportPdf({ path: p, out }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)
  if (extOf(p) !== 'docx' && extOf(p) !== 'doc') throw new Error('Ожидался .docx/.doc, получено .' + extOf(p))

  const com = require('../lib/com/word')
  const target = out || p.replace(/\.(docx|doc)$/i, '.pdf')
  await com.exportPdf(p, target)

  const st2 = await api.fs.stat(target)
  await recent.add({
    path: target,
    kind: 'pdf',
    op: 'export',
    name: target.split(/[\\/]/).pop(),
    size: st2.size,
  })
  return 'PDF создан: ' + target
}

const WORD_SAVE_FORMATS = { doc: 0, docx: 12, pdf: 17, html: 8, htm: 8, txt: 2, rtf: 7 }
const EXCEL_SAVE_FORMATS = { xls: 56, xlsx: 51, csv: 6 }
// PpSaveAsFileType: 1=ppt, 7=pps, 6=rtf, 12=html, 16=gif, 17=jpg, 18=png, 19=bmp,
// 24=pptx, 26=potx, 28=ppsx, 32=pdf, 33=xps, 34=wmv, 39=mp4
const PPT_SAVE_FORMATS = {
  ppt: 1, pps: 7, rtf: 6, html: 12, htm: 12, gif: 16, jpg: 17, jpeg: 17, png: 18,
  bmp: 19, pptx: 24, potx: 26, ppsx: 28, pdf: 32, xps: 33, wmv: 34, mp4: 39,
}

function guessWordFormat(dstExt) {
  return Object.prototype.hasOwnProperty.call(WORD_SAVE_FORMATS, dstExt) ? WORD_SAVE_FORMATS[dstExt] : null
}
function guessExcelFormat(dstExt) {
  return Object.prototype.hasOwnProperty.call(EXCEL_SAVE_FORMATS, dstExt) ? EXCEL_SAVE_FORMATS[dstExt] : null
}
function guessPptFormat(dstExt) {
  return Object.prototype.hasOwnProperty.call(PPT_SAVE_FORMATS, dstExt) ? PPT_SAVE_FORMATS[dstExt] : null
}

function requireDocx(p) {
  const ext = extOf(p)
  if (ext !== 'docx' && ext !== 'doc' && ext !== 'rtf') {
    throw new Error('Ожидался .docx/.doc/.rtf, получено .' + ext)
  }
}

async function officeUpdateFields({ path: p }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)
  requireDocx(p)
  const com = require('../lib/com/word')
  await com.updateFields(p)
  return 'Поля обновлены: ' + p
}

async function officeSaveAs({ path: p, out, format }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)
  if (!out) throw new Error('out обязателен (путь выходного файла)')

  const srcExt = extOf(p)
  const dstExt = extOf(out)
  const fmt = format != null && format !== '' ? Number(format) : null

  let com
  let usedFormat
  if (srcExt === 'docx' || srcExt === 'doc' || srcExt === 'rtf') {
    usedFormat = fmt != null ? fmt : guessWordFormat(dstExt)
    if (usedFormat == null) {
      throw new Error('Не удалось определить формат Word для .' + dstExt + '. Укажите format (0=doc, 12=docx, 17=pdf, 8=html, 2=txt, 7=rtf)')
    }
    com = require('../lib/com/word')
  } else if (srcExt === 'xlsx' || srcExt === 'xls') {
    usedFormat = fmt != null ? fmt : guessExcelFormat(dstExt)
    if (usedFormat == null) {
      throw new Error('Не удалось определить формат Excel для .' + dstExt + '. Укажите format (51=xlsx, 56=xls, 6=csv)')
    }
    com = require('../lib/com/excel')
  } else if (srcExt === 'pptx' || srcExt === 'ppt' || srcExt === 'pps' || srcExt === 'ppsx') {
    usedFormat = fmt != null ? fmt : guessPptFormat(dstExt)
    if (usedFormat == null) {
      throw new Error('Не удалось определить формат PowerPoint для .' + dstExt + '. Укажите format (1=ppt, 24=pptx, 28=ppsx, 32=pdf, 39=mp4, 18=png, 12=html)')
    }
    com = require('../lib/com/powerpoint')
  } else {
    throw new Error('office_save_as поддерживает .docx/.doc/.rtf (Word), .xlsx/.xls (Excel) и .pptx/.ppt/.ppsx (PowerPoint), получено .' + srcExt)
  }

  await com.saveAs(p, out, usedFormat)
  const st2 = await api.fs.stat(out)
  await recent.add({
    path: out,
    kind: dstExt === 'pdf' ? 'pdf' : (srcExt === 'xlsx' || srcExt === 'xls' ? 'excel' : (srcExt === 'pptx' || srcExt === 'ppt' || srcExt === 'ppsx' ? 'ppt' : 'word')),
    op: 'convert',
    name: out.split(/[\\/]/).pop(),
    size: st2.size,
  })
  return 'Сохранено: ' + out + ' (формат ' + usedFormat + ')'
}

/** Экспорт .pptx → .pdf через реальный PowerPoint (COM). */
async function pptExportPdf({ path: p, out }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)
  const ext = extOf(p)
  if (ext !== 'pptx' && ext !== 'ppt' && ext !== 'ppsx') {
    throw new Error('Ожидался .pptx/.ppt/.ppsx, получено .' + ext)
  }
  const com = require('../lib/com/powerpoint')
  const target = out || p.replace(/\.(pptx|ppt|ppsx)$/i, '.pdf')
  await com.exportPdf(p, target)
  const st2 = await api.fs.stat(target)
  await recent.add({
    path: target,
    kind: 'pdf',
    op: 'export',
    name: target.split(/[\\/]/).pop(),
    size: st2.size,
  })
  return 'PDF создан: ' + target
}

async function officeFindReplace({ path: p, find, replace, matchCase, wholeWord }) {
  if (!p) throw new Error('path обязателен')
  if (find == null || find === '') throw new Error('find обязателен (текст для поиска)')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)
  requireDocx(p)
  const com = require('../lib/com/word')
  const res = await com.findReplace(p, find, replace == null ? '' : replace, !!matchCase, !!wholeWord)
  return 'Замена выполнена в ' + p + ' (' + res + ')'
}

async function officeAcceptChanges({ path: p }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)
  requireDocx(p)
  const com = require('../lib/com/word')
  await com.acceptChanges(p)
  return 'Все изменения приняты: ' + p
}

async function officeRejectChanges({ path: p }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)
  requireDocx(p)
  const com = require('../lib/com/word')
  await com.rejectChanges(p)
  return 'Все изменения отклонены: ' + p
}

function registerComTools(syntee) {
  syntee.registerTool({
    name: 'office_open',
    description:
      'Open a document in the real MS Office application (Word via COM for .docx/.doc, Excel for .xlsx/.xls, PowerPoint for .pptx/.ppt/.ppsx, default app otherwise). The Office window becomes visible on screen.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        app: { type: 'string', enum: ['word', 'excel', 'powerpoint'], description: 'Force app (optional, auto-detected by extension)' },
      },
      required: ['path'],
    },
    handler: officeOpen,
    requiresApproval: true, // запускает внешнее приложение
  })

  syntee.registerTool({
    name: 'word_export_pdf',
    description:
      'Export a .docx document to PDF using installed MS Word (COM ExportAsFixedFormat). Requires Word installed. Returns the PDF path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx' },
        out: { type: 'string', description: 'Output .pdf path (default: same name .pdf)' },
      },
      required: ['path'],
    },
    handler: wordExportPdf,
    requiresApproval: true,
  })

  syntee.registerTool({
    name: 'excel_chart',
    description:
      'Add an embedded chart to an existing .xlsx sheet via real MS Excel COM (exceljs cannot create charts). Types: bar, column, line, pie, doughnut, area, scatter, radar. The chart is anchored to a cell and the workbook is saved. Requires Excel installed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .xlsx' },
        sheet: { type: 'string', description: 'Sheet name' },
        type: { type: 'string', enum: ['bar', 'column', 'line', 'pie', 'doughnut', 'area', 'scatter', 'radar'] },
        dataRange: { type: 'string', description: 'Data range on the sheet, e.g. "A1:B10" (include headers row for legend)' },
        title: { type: 'string', description: 'Chart title (optional)' },
        anchor: { type: 'string', description: 'Top-left anchor cell, e.g. "D2" (default D2)' },
        width: { type: 'number', description: 'Chart width px (default 480)' },
        height: { type: 'number', description: 'Chart height px (default 300)' },
      },
      required: ['path', 'sheet', 'type', 'dataRange'],
    },
    handler: async ({ path: p, ...rest }) => {
      if (!p) throw new Error('path обязателен')
      const api = state.api
      const st = await api.fs.stat(p)
      if (!st.exists) throw new Error('Файл не найден: ' + p)
      // Превалидация ДО COM: понятные ошибки вместо криптичного PS-вывода.
      if (!rest.sheet) throw new Error('sheet обязателен (имя листа). Узнать листы: excel_read mode "meta"')
      if (!rest.dataRange) throw new Error('dataRange обязателен, например "A1:B10" (включите строку заголовков для легенды)')
      if (!/^[A-Za-z]+[0-9]+:[A-Za-z]+[0-9]+$/.test(String(rest.dataRange).replace(/\$/g, '').replace(/'/g, ''))) {
        throw new Error('dataRange должен быть диапазоном вида "A1:B10", получено: ' + rest.dataRange)
      }
      const reader = require('../lib/excel/read')
      const meta = await reader.readWorkbook(p, { mode: 'meta' })
      const found = (meta.sheets || []).find((s) => s.name === rest.sheet)
      if (!found) {
        const names = (meta.sheets || []).map((s) => '"' + s.name + '" (' + s.rowCount + 'x' + s.columnCount + ')').join(', ')
        throw new Error('Лист не найден: ' + rest.sheet + '. Листы в файле: ' + names)
      }
      const com = require('../lib/com/excel')
      await com.addChart({ path: p, ...rest })
      return 'Диаграмма добавлена: ' + p + ' (лист ' + rest.sheet + ', ' + rest.type + ' ' + rest.dataRange + ')'
    },
    requiresApproval: true, // запускает реальный Excel и мутирует файл
  })

  syntee.registerTool({
    name: 'office_update_fields',
    description:
      'Update ALL fields in a .docx (TOC, PAGE/NUMPAGES, DATE, cross-references, headers/footers) via real MS Word COM and save. Makes a generated TOC show real page numbers. Requires Word installed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx/.doc' },
      },
      required: ['path'],
    },
    handler: officeUpdateFields,
    requiresApproval: true, // запускает реальный Word и мутирует файл
  })

  syntee.registerTool({
    name: 'office_save_as',
    description:
      'Save a document in a different format via Word/Excel/PowerPoint COM (also converts legacy formats). Word formats: doc=0, docx=12, pdf=17, html=8, txt=2, rtf=7. Excel formats: xlsx=51, xls=56, csv=6. PowerPoint formats: ppt=1, pptx=24, ppsx=28, pdf=32, mp4=39 (VIDEO!), wmv=34, png=18, jpg=17, html=12, rtf=6. Common cases: .doc→.docx (12), .ppt→.pptx (24), .pptx→.pdf (32), .pptx→.mp4 (39), .xlsx→.csv (6). Format is auto-detected from the out extension when omitted. Requires MS Office installed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source (.docx/.doc/.rtf, .xlsx/.xls or .pptx/.ppt/.ppsx)' },
        out: { type: 'string', description: 'Absolute output path with target extension' },
        format: { type: 'number', description: 'Explicit format code (optional; auto-detected from out extension)' },
      },
      required: ['path', 'out'],
    },
    handler: officeSaveAs,
    requiresApproval: true,
  })

  syntee.registerTool({
    name: 'ppt_export_pdf',
    description:
      'Export a .pptx presentation to PDF using installed MS PowerPoint (COM SaveAs format 32). Requires PowerPoint installed. Returns the PDF path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .pptx/.ppt' },
        out: { type: 'string', description: 'Output .pdf path (default: same name .pdf)' },
      },
      required: ['path'],
    },
    handler: pptExportPdf,
    requiresApproval: true,
  })

  syntee.registerTool({
    name: 'office_find_replace',
    description:
      'Find and replace text in a .docx/.doc via real MS Word COM. LOSSLESS: preserves ALL formatting (styles, headers/footers, footnotes, tracked changes, comments). Prefer this over word_edit replace_text for simple textual substitutions. Optionally case-sensitive and whole-word. Requires Word installed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx/.doc' },
        find: { type: 'string', description: 'Text to search for' },
        replace: { type: 'string', description: 'Replacement text (empty string deletes matches)' },
        matchCase: { type: 'boolean', description: 'Case-sensitive match (default false)' },
        wholeWord: { type: 'boolean', description: 'Match whole words only (default false)' },
      },
      required: ['path', 'find'],
    },
    handler: officeFindReplace,
    requiresApproval: true,
  })

  syntee.registerTool({
    name: 'office_accept_changes',
    description:
      'Accept ALL tracked changes (revisions) in a .docx via real MS Word COM and save. Requires Word installed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx/.doc' },
      },
      required: ['path'],
    },
    handler: officeAcceptChanges,
    requiresApproval: true,
  })

  syntee.registerTool({
    name: 'office_reject_changes',
    description:
      'Reject ALL tracked changes (revisions) in a .docx via real MS Word COM and save. Requires Word installed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx/.doc' },
      },
      required: ['path'],
    },
    handler: officeRejectChanges,
    requiresApproval: true,
  })
}

module.exports = {
  registerComTools,
  officeOpen,
  wordExportPdf,
  pptExportPdf,
  officeUpdateFields,
  officeSaveAs,
  officeFindReplace,
  officeAcceptChanges,
  officeRejectChanges,
}
