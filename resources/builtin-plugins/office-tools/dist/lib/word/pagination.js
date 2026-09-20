// pagination — контент-ориентированная оценка числа страниц документа.
// Используется и при сборке (BlockBuilder._finishStats), и при чтении
// (read.js blocksStats). Единственный источник правды про approxPages.
//
// Оценка высоты каждого блока в twips с учётом геометрии страницы
// (размер/поля/ориентация/колонки), шрифта и межстрочного интервала.
// Это оценка, а не рендер: реальная вёрстка Word может отличаться на ±1
// страницу, но порядок и зависимость от контента — правильные.

const PAGE_SIZES = { // twips, портрет (синхронизировано с spec.js)
  a4: [11906, 16838],
  a3: [16838, 23811],
  a5: [8391, 11906],
  letter: [12240, 15840],
  legal: [12240, 20160],
}

const HEADING_SIZES = [32, 28, 26, 24, 22, 22] // half-points, уровни 1..6 (если стили не переопределены)

function cmToTwips(cm) {
  return Math.round(Number(cm) * 567)
}

/** Геометрия страницы + метрики строки из opts. */
function geometry(opts) {
  const page = (opts && opts.page) || {}
  const dims = PAGE_SIZES[String(page.size || 'a4').toLowerCase()] || PAGE_SIZES.a4
  const landscape = String(page.orientation || 'portrait').toLowerCase() === 'landscape'
  const pageW = landscape ? dims[1] : dims[0]
  const pageH = landscape ? dims[0] : dims[1]

  const m = page.margins || {}
  const top = m.top !== undefined ? cmToTwips(m.top) : 1134 // 2 см — дефолт настроек ГОСТ
  const bottom = m.bottom !== undefined ? cmToTwips(m.bottom) : 1134
  const left = m.left !== undefined ? cmToTwips(m.left) : 1701 // 3 см
  const right = m.right !== undefined ? cmToTwips(m.right) : 850 // 1.5 см

  const cols = Math.max(1, Math.min(4, Number(page.columns) || 1))
  const usableW = Math.max(1000, pageW - left - right - (cols - 1) * 708)
  const colW = Math.floor(usableW / cols)
  const usableH = Math.max(2000, pageH - top - bottom)

  const styles = (opts && opts.styles) || {}
  const d = styles.default || {}
  const sizeHp = Number(d.size) || 22 // 11pt
  const sizePt = sizeHp / 2
  const lineMult = Number(d.lineHeight) || 1.15
  const lineTwips = Math.max(240, Math.round(sizePt * 20 * lineMult))
  const spacingAfter = Number(d.spacingAfter) || 0
  // Средняя ширина символа: кириллица/латиница Calibri ≈ 0.52 размера шрифта
  const charTwips = Math.max(40, sizePt * 0.52 * 20)
  const charsPerLine = Math.max(10, Math.floor(colW / charTwips))

  return { pageW, pageH, usableH, colW, lineTwips, spacingAfter, charsPerLine, sizePt }
}

/** Текст блока/элемента (без импорта blocks.js — против циклической зависимости). */
function textOf(node) {
  if (node == null) return ''
  if (typeof node === 'string') return node
  let t = ''
  if (typeof node.text === 'string') t += node.text
  if (Array.isArray(node.runs)) {
    for (const r of node.runs) t += typeof r === 'string' ? r : (r && r.text) || ''
  }
  if (Array.isArray(node.items)) {
    for (const it of node.items) t += ' ' + textOf(it)
  }
  if (Array.isArray(node.rows)) {
    for (const row of node.rows) {
      for (const c of row || []) t += ' ' + (typeof c === 'string' ? c : (c && c.text) || '')
    }
  }
  return t
}

function lines(text, charsPerLine) {
  const len = String(text || '').length
  if (!len) return 1
  return Math.max(1, Math.ceil(len / charsPerLine))
}

/**
 * Оценка числа страниц по блокам спеки.
 * @param {Array} blocks блоки content (формат word_create)
 * @param {object} opts { page: {size, orientation, margins, columns}, styles: {default, heading1..6}, compactLists }
 * @returns {number} целое ≥ 1
 */
function estimatePages(blocks, opts) {
  const g = geometry(opts)
  const compact = opts && opts.compactLists !== false
  const styles = (opts && opts.styles) || {}
  let h = 0 // накопленная высота, twips

  const addBlock = (b) => {
    if (!b || typeof b !== 'object') return
    switch (b.type) {
      case 'heading': {
        const lvl = Math.min(6, Math.max(1, Number(b.level) || 1))
        const hp = Number(styles['heading' + lvl] && styles['heading' + lvl].size) || HEADING_SIZES[lvl - 1]
        const line = Math.max(240, Math.round((hp / 2) * 20 * 1.15))
        h += lines(textOf(b), Math.max(10, Math.floor(g.colW / ((hp / 2) * 0.52 * 20)))) * line + 360
        break
      }
      case 'paragraph': {
        const indent = b.indent && (b.indent.left || b.indent.firstLine) ? 400 : 0
        const cpl = Math.max(10, g.charsPerLine - Math.floor(indent / (g.sizePt * 0.52 * 20)))
        const sp = b.spacing || {}
        h += lines(textOf(b), cpl) * g.lineTwips
          + (Number(sp.before) || 0) + (sp.after !== undefined ? Number(sp.after) : g.spacingAfter)
        break
      }
      case 'list': {
        for (const it of b.items || []) {
          const lvl = (typeof it === 'object' && Number(it.level)) || 0
          const indent = (compact ? 360 : 720) * (lvl + 1)
          const cpl = Math.max(10, g.charsPerLine - Math.floor(indent / (g.sizePt * 0.52 * 20)))
          h += lines(textOf(it), cpl) * g.lineTwips + 40
        }
        break
      }
      case 'table': {
        const rows = b.rows || []
        const nCols = Math.max(1, (rows[0] || []).length)
        let colW = g.colW
        if (Array.isArray(b.columnWidths) && b.columnWidths.length === nCols) {
          const total = b.columnWidths.reduce((a, c) => a + cmToTwips(c), 0)
          if (total > 500) colW = total
        }
        const cellCpl = Math.max(6, Math.floor((colW / nCols) / (g.sizePt * 0.52 * 20)))
        for (const row of rows) {
          let maxLines = 1
          for (const c of row || []) {
            const t = typeof c === 'string' ? c : (c && c.text) || ''
            maxLines = Math.max(maxLines, lines(t, cellCpl))
          }
          h += maxLines * g.lineTwips + 60
        }
        h += 120
        break
      }
      case 'image': {
        h += (Number(b.height) || 300) * 15 + 240 // px → twips (96 dpi)
        break
      }
      case 'pageBreak': {
        const pageN = Math.ceil(h / g.usableH)
        h = pageN * g.usableH // следующее начинается с новой страницы
        break
      }
      case 'cover': {
        h += Math.floor(g.usableH * 0.45) + 200
        const pageN = Math.ceil(h / g.usableH)
        h = pageN * g.usableH
        break
      }
      case 'toc': {
        h += g.lineTwips * 14
        break
      }
      case 'hr': {
        h += 240
        break
      }
      default: {
        // hyperlink, bookmark, ref и пр. — одна строка
        h += g.lineTwips + g.spacingAfter
      }
    }
  }

  for (const b of blocks || []) addBlock(b)
  return Math.max(1, Math.ceil(h / g.usableH))
}

module.exports = { estimatePages, geometry, PAGE_SIZES }
