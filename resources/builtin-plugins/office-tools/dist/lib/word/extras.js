// extras — дополнительные типы блоков спеки: титульная страница (cover),
// закладки (bookmark) и внутренние ссылки (ref). Вынесено из blocks.js,
// чтобы тот не разросся. Сноски (footnote) живут в blocks.js (это run-опция).

const docx = require('docx')
const { buildImageParagraph } = require('./media')

const { Paragraph, TextRun, PageBreak, AlignmentType, Bookmark, InternalHyperlink } = docx

/**
 * id закладки: только [A-Za-z0-9_]; пробелы → '_', прочие символы вырезаются.
 * Пустой результат → ошибка (иначе Word не откроет документ).
 */
function sanitizeBookmarkId(id) {
  const s = String(id || '').replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '')
  if (!s) {
    throw new Error('bookmark/ref: id не задан или не содержит допустимых символов (A-Z, a-z, 0-9, _)')
  }
  return s
}

/**
 * cover-блок → массив children: отступ сверху (~1/4 страницы), title по центру
 * bold 28pt, subtitle 16pt, author/date 12pt, meta «label: value» по центру,
 * затем разрыв страницы. Всё кроме title опционально.
 */
async function buildCover(block, ctx, stats) {
  if (!block || !block.title) throw new Error('cover: title обязателен')
  const out = []
  // Отступ сверху ~1/4 страницы
  out.push(new Paragraph({ spacing: { before: 3000 } }))
  out.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 240 },
    children: [new TextRun({ text: String(block.title), bold: true, size: 56 })], // 28pt
  }))
  if (block.subtitle) {
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [new TextRun({ text: String(block.subtitle), size: 32 })], // 16pt
    }))
  }
  if (block.image) {
    // картинка на титуле: path/data + width/height, по центру
    out.push(await buildImageParagraph({ alignment: 'center', ...block.image }, ctx, stats))
  }
  if (block.author) {
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: String(block.author), size: 24 })], // 12pt
    }))
  }
  if (block.date) {
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: String(block.date), size: 24 })],
    }))
  }
  for (const m of block.meta || []) {
    if (!m) continue
    const label = m.label ? String(m.label) + ': ' : ''
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: label + String(m.value == null ? '' : m.value), size: 24 })],
    }))
  }
  out.push(new Paragraph({ children: [new PageBreak()] }))
  if (stats) stats.paragraphs += out.length
  return out
}

/** bookmark-блок → Paragraph с docx.Bookmark (якорь для внутренних ссылок). */
function buildBookmarkParagraph(block) {
  const id = sanitizeBookmarkId(block.id)
  return new Paragraph({
    children: [new Bookmark({ id, children: [new TextRun({ text: String(block.text || '') })] })],
  })
}

/** ref-блок → Paragraph с InternalHyperlink на закладку. */
function buildRefParagraph(block) {
  const anchor = sanitizeBookmarkId(block.bookmark || block.id)
  return new Paragraph({
    children: [new InternalHyperlink({
      anchor,
      children: [new TextRun({ text: String(block.text || anchor), style: 'Hyperlink' })],
    })],
  })
}

module.exports = { buildCover, buildBookmarkParagraph, buildRefParagraph, sanitizeBookmarkId }
