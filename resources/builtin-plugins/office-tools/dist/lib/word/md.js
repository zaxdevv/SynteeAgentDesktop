// md — конвертация .docx в Markdown / plain text.
// Цепочка: mammoth → html → блоки спеки (read.js) → markdown.
// Формулы: extractMath заменяет m:oMath на плейсхолдеры → math-блоки
// → $latex$ (стандартная md-нотация формул).

const fs = require('fs')
const mammoth = require('mammoth')
const { htmlToBlocks, parseHtml } = require('./read')
const { extractMath, applyMath, sweepMathText } = require('./math')

/** Runs/текст блока → инлайн-markdown (**bold**, *italic*, ~~strike~~, <u>, [text](url), $формулы$). */
function inlineMd(block) {
  if (Array.isArray(block.runs) && block.runs.length) {
    return block.runs.map(runMd).join('')
  }
  return String(block.text || '')
}

function runMd(r) {
  if (r && r.math) return '$' + String(r.math) + '$'
  let t = String((r && r.text) || '')
  if (!t) return ''
  if (r.url) return '[' + t + '](' + r.url + ')'
  if (r.bold) t = '**' + t + '**'
  if (r.italic) t = '*' + t + '*'
  if (r.strike) t = '~~' + t + '~~'
  if (r.underline) t = '<u>' + t + '</u>'
  return t
}

/** Экранирование | внутри ячеек md-таблицы. */
const escCell = (s) => String(s || '').replace(/\|/g, '\\|')

/** table-блок → md-таблица (colspan/rowspan игнорируются — пишется текст). */
function tableMd(b) {
  const rows = b.rows || []
  if (!rows.length) return ''
  const norm = rows.map((row) => (row || []).map((c) => escCell(typeof c === 'string' ? c : c.text || '')))
  const width = Math.max(...norm.map((r) => r.length))
  const line = (cells) => '| ' + cells.join(' | ') + ' |'
  const out = [line(norm[0])]
  if (b.header) out.push('| ' + Array(width).fill('---').join(' | ') + ' |')
  for (let i = 1; i < norm.length; i++) out.push(line(norm[i]))
  return out.join('\n')
}

/** list-блок → маркированный/нумерованный список с отступами по level. */
function listMd(b) {
  const out = []
  let n = 0
  for (const it of b.items || []) {
    const item = typeof it === 'string' ? { text: it } : it
    const level = item.level || 0
    const indent = '  '.repeat(level)
    if (b.ordered) {
      n = level === 0 ? n + 1 : 1
      out.push(indent + n + '. ' + inlineMd(item))
    } else {
      out.push(indent + '- ' + inlineMd(item))
    }
  }
  return out.join('\n')
}

/** Один блок спеки → markdown (строка или многострочный фрагмент). */
function blockMd(b) {
  switch (b.type) {
    case 'heading':
      return '#'.repeat(Math.min(6, Math.max(1, b.level || 1))) + ' ' + String(b.text || '')
    case 'math':
      return '$$' + String(b.latex || '') + '$$'
    case 'paragraph':
      return inlineMd(b)
    case 'hyperlink':
      return '[' + (b.text || b.url || '') + '](' + (b.url || '') + ')'
    case 'list':
      return listMd(b)
    case 'table':
      return tableMd(b)
    case 'image':
      return b.alt ? '![' + b.alt + '](' + (b.path || '') + ')' : '[изображение]'
    case 'pageBreak':
    case 'hr':
      return '---'
    case 'toc':
      return '[Содержание]'
    case 'cover': {
      const lines = []
      if (b.title) lines.push('# ' + b.title)
      for (const k of ['subtitle', 'author', 'date']) {
        if (b[k]) lines.push(String(b[k]))
      }
      return lines.join('\n')
    }
    default:
      return inlineMd(b)
  }
}

/**
 * .docx → Markdown.
 * @param {string} path путь до .docx
 * @returns {Promise<string>} markdown-текст
 */
async function docxToMarkdown(path) {
  const buffer = fs.readFileSync(path)
  const math = extractMath(buffer)
  const r = await mammoth.convertToHtml({ buffer: math.buffer })
  const blocks = htmlToBlocks(parseHtml(r.value))
  applyMath(blocks, math.latex)
  sweepMathText(blocks, math.latex)
  return blocks.map(blockMd).filter((s) => s !== '').join('\n\n')
}

/**
 * .docx → plain text (без форматирования).
 * @param {string} path путь до .docx
 * @returns {Promise<string>}
 */
async function docxToText(path) {
  const buffer = fs.readFileSync(path)
  const math = extractMath(buffer)
  const r = await mammoth.extractRawText({ buffer: math.buffer })
  if (!math.latex.length) return r.value
  return r.value.replace(/⟦MATH:(\d+)⟧/g, (_, i) => ' ' + (math.latex[Number(i)] || '') + ' ')
}

module.exports = { docxToMarkdown, docxToText, blockMd }
