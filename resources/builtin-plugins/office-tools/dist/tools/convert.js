// convert — тулы конвертации: xlsx↔csv, docx→markdown/txt/html, xlsx/docx → pdf
const fs = require('fs')
const state = require('../state')
const recent = require('../lib/recent')

function extOf(p) {
  return (p.split('.').pop() || '').toLowerCase()
}

/** docx → markdown / txt / html (mammoth, без MS Office). */
async function convertDocx(p, dstExt, out) {
  const mammoth = require('mammoth')
  const md = require('../lib/word/md')
  const target = out || p.replace(/\.docx$/i, '.' + (dstExt === 'markdown' ? 'md' : dstExt))
  let content
  let label
  if (dstExt === 'markdown' || dstExt === 'md') {
    content = await md.docxToMarkdown(p)
    label = 'Markdown'
  } else if (dstExt === 'txt') {
    content = await md.docxToText(p)
    label = 'TXT'
  } else if (dstExt === 'html') {
    const r = await mammoth.convertToHtml({ path: p })
    content = '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n' + r.value + '\n</body>\n</html>\n'
    label = 'HTML'
  } else {
    throw new Error('Неподдерживаемый формат: .' + dstExt)
  }
  fs.writeFileSync(target, content, 'utf-8')
  await recent.add({ path: target, kind: 'word', op: 'convert', name: target.split(/[\\/]/).pop(), size: fs.statSync(target).size })
  return label + ' создан: ' + target + ' (' + content.length + ' символов)'
}

/** pptx → markdown / txt (свои парсер, без MS Office). */
async function convertPptx(p, dstExt, out) {
  const reader = require('../lib/ppt/read')
  const meta = reader.readPresentation(p, 'meta')
  const deck = reader.readPresentation(p, 'slides')
  const target = out || p.replace(/\.pptx$/i, '.' + (dstExt === 'markdown' ? 'md' : dstExt))

  const lines = []
  if (dstExt === 'markdown' || dstExt === 'md') {
    lines.push('# ' + (meta.title || p.split(/[\\/]/).pop().replace(/\.pptx$/i, '')))
    lines.push('')
    for (const s of deck.slides) {
      const head = 'Слайд ' + s.index + (s.title ? ': ' + s.title : '') + (s.hidden ? ' (скрыт)' : '')
      lines.push('## ' + head)
      lines.push('')
      for (const t of s.texts || []) {
        for (const line of String(t).split('\n')) lines.push(line)
      }
      if (s.notes) {
        lines.push('')
        lines.push('> Заметки: ' + s.notes)
      }
      lines.push('')
    }
  } else {
    // txt
    lines.push((meta.title || p.split(/[\\/]/).pop().replace(/\.pptx$/i, '')))
    lines.push('')
    for (const s of deck.slides) {
      lines.push('=== Слайд ' + s.index + (s.title ? ': ' + s.title : '') + (s.hidden ? ' (скрыт)' : '') + ' ===')
      for (const t of s.texts || []) lines.push(String(t))
      if (s.notes) lines.push('[Заметки] ' + s.notes)
      lines.push('')
    }
  }
  const content = lines.join('\n')
  fs.writeFileSync(target, content, 'utf-8')
  await recent.add({ path: target, kind: 'ppt', op: 'convert', name: target.split(/[\\/]/).pop(), size: Buffer.byteLength(content) })
  return (dstExt === 'markdown' || dstExt === 'md' ? 'Markdown' : 'TXT') + ' создан: ' + target + ' (' + deck.slideCount + ' слайдов)'
}

/** xlsx → csv (exceljs) или csv → xlsx. */
async function convertTable({ path: p, to, out, sheet, delimiter, encoding }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)

  const srcExt = extOf(p)
  const dstExt = (to || '').toLowerCase().replace('.', '')

  // docx → markdown / txt / html (чистый JS, без MS Office)
  if (srcExt === 'docx' && ['markdown', 'md', 'txt', 'html'].includes(dstExt)) {
    return convertDocx(p, dstExt, out)
  }

  // pptx → markdown / txt (чистый JS, без MS Office)
  if (srcExt === 'pptx' && ['markdown', 'md', 'txt'].includes(dstExt)) {
    return convertPptx(p, dstExt, out)
  }

  const convert = require('../lib/convert/csv')

  if (srcExt === 'xlsx' && (dstExt === 'csv' || dstExt === 'txt')) {
    const target = out || p.replace(/\.xlsx$/i, '.csv')
    const res = await convert.xlsxToCsv(p, target, { sheet, delimiter, encoding })
    await recent.add({ path: target, kind: 'excel', op: 'convert', name: target.split(/[\\/]/).pop(), size: res.size })
    return 'CSV создан: ' + target + '\n' + res.summary
  }
  if (srcExt === 'csv' && dstExt === 'xlsx') {
    const target = out || p.replace(/\.csv$/i, '.xlsx')
    const res = await convert.csvToXlsx(p, target, { delimiter, sheetName: sheet, encoding })
    await recent.add({ path: target, kind: 'excel', op: 'convert', name: target.split(/[\\/]/).pop(), size: res.size })
    return 'XLSX создан: ' + target + '\n' + res.summary
  }
  throw new Error(
    'Неподдерживаемая конвертация: .' + srcExt + ' → .' + dstExt +
    ' (доступно: xlsx→csv, csv→xlsx, docx→markdown/txt/html, pptx→markdown/txt)',
  )
}

/** xlsx/docx/pptx → pdf (COM: реальный Excel/Word/PowerPoint). */
async function convertPdf({ path: p, out }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)
  const target = out || p.replace(/\.(xlsx|xls|docx|doc|pptx|ppt|ppsx)$/i, '.pdf')

  if (extOf(p) === 'xlsx' || extOf(p) === 'xls') {
    const com = require('../lib/com/excel')
    await com.exportPdf(p, target)
  } else if (extOf(p) === 'pptx' || extOf(p) === 'ppt' || extOf(p) === 'ppsx') {
    const com = require('../lib/com/powerpoint')
    await com.exportPdf(p, target)
  } else {
    const com = require('../lib/com/word')
    await com.exportPdf(p, target)
  }
  const st2 = await api.fs.stat(target)
  await recent.add({ path: target, kind: 'pdf', op: 'export', name: target.split(/[\\/]/).pop(), size: st2.size })
  return 'PDF создан: ' + target
}

function registerConvertTools(syntee) {
  syntee.registerTool({
    name: 'office_convert',
    description:
      'Convert office documents. Supported: xlsx→csv (sheet/delimiter/encoding options), csv→xlsx (encoding option for legacy RU encodings), docx→markdown (also "md"), docx→txt, docx→html (pure JS via mammoth, no MS Office needed), pptx→markdown/txt (pure JS, slides + notes), xlsx/docx/pptx→pdf (via real MS Office COM — requires Office installed; see office_export_pdf). Returns the output path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source file' },
        to: { type: 'string', enum: ['csv', 'xlsx', 'pdf', 'markdown', 'md', 'txt', 'html'], description: 'Target format' },
        out: { type: 'string', description: 'Output path (default: same name with new extension)' },
        sheet: { type: 'string', description: 'xlsx→csv: sheet name; csv→xlsx: new sheet name' },
        delimiter: { type: 'string', description: 'csv delimiter (default ";")' },
        encoding: { type: 'string', description: 'csv encoding. csv→xlsx reads with this encoding (utf-8 default; also windows-1251, cp866, koi8-r, iso-8859-1). xlsx→csv supports only utf-8 (with BOM).' },
      },
      required: ['path', 'to'],
    },
    handler: convertTable,
  })

  // PDF-конвертация — отдельный тул: запускает реальный Office (approval)
  syntee.registerTool({
    name: 'office_export_pdf',
    description:
      'Export a document to PDF using installed MS Office (COM): .docx via Word, .xlsx via Excel, .pptx via PowerPoint. Requires Office installed. Returns the PDF path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx/.xlsx/.pptx' },
        out: { type: 'string', description: 'Output .pdf path (default: same name .pdf)' },
      },
      required: ['path'],
    },
    handler: convertPdf,
    requiresApproval: true,
  })
}

module.exports = { registerConvertTools, convertTable, convertPdf }
