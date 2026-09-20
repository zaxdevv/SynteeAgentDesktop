// spec — сборка .docx из JSON-спеки (см. specDoc.js — полный контракт формата).
// buildDocument(spec, ctx) → { buffer, stats, outline }.
// ctx: { readImage?, defaults? }, defaults = settings.layoutDefaults():
//   { margins: {top,right,bottom,left}|null, firstLineIndent, compactLists, smartBreaks }.

const docx = require('docx')
const { buildStyles, cmToTwips } = require('./styles')
const { BlockBuilder, collectText } = require('./blocks')
const { buildHeaderFooter } = require('./media')

const { Document, Packer, PageOrientation } = docx

/** Размеры бумаги в twips (портрет). */
const PAGE_SIZES = {
  a4: [11906, 16838],
  a3: [16838, 23811],
  a5: [8391, 11906],
  letter: [12240, 15840],
  legal: [12240, 20160],
}

/** page-секция спеки → docx page setup (size/orientation/margins/pageNumbers). */
function buildPageSetup(page, footer, defaults) {
  const p = page || {}
  const sizeKey = String(p.size || 'a4').toLowerCase()
  const dims = PAGE_SIZES[sizeKey] || PAGE_SIZES.a4
  const landscape = String(p.orientation || 'portrait').toLowerCase() === 'landscape'
  const out = {
    size: {
      width: dims[0],
      height: dims[1],
      // docx сам меняет w/h местами при landscape — передаём портретные размеры
      ...(landscape ? { orientation: PageOrientation.LANDSCAPE } : {}),
    },
  }
  // Поля: спека выигрывает; иначе дефолт настроек (null → docx сам ставит 1 дюйм)
  const m = (p.margins && typeof p.margins === 'object' && Object.keys(p.margins).length)
    ? p.margins
    : (defaults && defaults.margins) || null
  if (m) {
    out.margin = {}
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (m[side] !== undefined) out.margin[side] = cmToTwips(m[side])
    }
  }
  // Стартовый номер страницы (footer.pageNumber.start)
  const start = footer && footer.pageNumber && Number(footer.pageNumber.start)
  if (Number.isFinite(start) && start > 0) {
    out.pageNumbers = { start: Math.round(start) }
  }
  return out
}

/** Доля кириллицы среди букв текста всех блоков (для firstLineIndent: 'auto'). */
function cyrillicRatio(blocks) {
  let cyr = 0
  let total = 0
  for (const b of blocks || []) {
    for (const t of collectText(b, [])) {
      for (const ch of String(t)) {
        if (/[а-яё]/i.test(ch)) { cyr++; total++ }
        else if (/[a-z]/i.test(ch)) total++
      }
    }
  }
  return total ? cyr / total : 0
}

/**
 * header/footer-спека → { default?, first?, even? }.
 * Старый формат { blocks, pageNumber? } = default-колонтитул.
 * Новый формат { default: {blocks}, first: {blocks}, even: {blocks} }.
 * ensureDefault → создать пустой default (нужно для watermark).
 */
function normalizeHF(hf, ensureDefault) {
  if (!hf || typeof hf !== 'object') return ensureDefault ? { default: { blocks: [] } } : null
  if (Array.isArray(hf.blocks) || hf.pageNumber !== undefined) return { default: hf }
  const out = {}
  for (const k of ['default', 'first', 'even']) if (hf[k]) out[k] = hf[k]
  if (!Object.keys(out).length) return { default: hf }
  if (ensureDefault && !out.default) out.default = { blocks: [] }
  return out
}

/**
 * Главная функция: JSON-спека → Buffer .docx.
 * @param {object} spec спека документа (word_create / word_read full)
 * @param {object} ctx { readImage(path), defaults? } — картинки и layout-дефолты
 * @returns {Promise<{buffer: Buffer, stats: object, outline: Array}>}
 */
async function buildDocument(spec, ctx) {
  if (!spec || typeof spec !== 'object') throw new Error('spec (объект документа) обязателен')
  if (!Array.isArray(spec.content)) throw new Error('spec.content (массив блоков) обязателен')

  ctx = ctx || {}
  const defaults = ctx.defaults || {}
  const page = spec.page || {}

  // Эффективные layout-опции: спека > настройки плагина (ctx.defaults) > дефолты
  const fliMode = page.firstLineIndent || defaults.firstLineIndent || 'auto'
  const firstLineIndent = fliMode === 'on'
    ? true
    : fliMode === 'off' ? false : cyrillicRatio(spec.content) > 0.3
  const compactLists = page.compactLists !== undefined
    ? !!page.compactLists
    : defaults.compactLists !== undefined ? !!defaults.compactLists : true
  const smartBreaks = page.smartBreaks !== undefined
    ? !!page.smartBreaks
    : defaults.smartBreaks !== undefined ? !!defaults.smartBreaks : true

  const builder = new BlockBuilder({
    ctx,
    numberingSpec: spec.numbering || {},
    layout: { firstLineIndent, compactLists, smartBreaks },
  })
  builder.setLayout(spec)
  await builder.addMany(spec.content)

  const section = {
    properties: {
      page: buildPageSetup(page, spec.footer, defaults),
      // Отдельный колонтитул первой страницы
      ...(page.differentFirstPage ? { titlePage: true } : {}),
    },
    children: builder.children,
  }
  // Колонки текста (page.columns)
  const cols = Number(spec.page && spec.page.columns)
  if (Number.isFinite(cols) && cols > 1) {
    section.properties.column = { count: Math.min(4, Math.round(cols)), space: 708 }
  }
  // Колонтитулы: старый формат { blocks } = default; новый — default/first/even.
  // Watermark инъектируется в default header (VML-шейп первым элементом).
  const wm = page.watermark && page.watermark.text ? page.watermark : null
  const hNorm = normalizeHF(spec.header, !!wm)
  if (hNorm) {
    section.headers = {}
    for (const k of Object.keys(hNorm)) {
      section.headers[k] = await buildHeaderFooter(hNorm[k], 'header', ctx, spec.numbering || {}, {
        watermark: k === 'default' ? wm : null,
      })
    }
  }
  const fNorm = normalizeHF(spec.footer)
  if (fNorm) {
    section.footers = {}
    for (const k of Object.keys(fNorm)) {
      section.footers[k] = await buildHeaderFooter(fNorm[k], 'footer', ctx, spec.numbering || {})
    }
  }

  const doc = new Document({
    styles: buildStyles(spec.styles),
    ...(builder.numberingConfigs.length ? { numbering: { config: builder.numberingConfigs } } : {}),
    ...(Object.keys(builder.footnotes).length ? { footnotes: builder.footnotes } : {}),
    ...(page.evenAndOdd ? { evenAndOddHeaderAndFooters: true } : {}),
    features: { updateFields: true }, // Word предложит обновить TOC (Ctrl+A, F9)
    sections: [section],
  })

  const buffer = await Packer.toBuffer(doc)
  return { buffer, stats: builder.stats, outline: builder.outline }
}

module.exports = { buildDocument, buildPageSetup, normalizeHF, cyrillicRatio, PAGE_SIZES }
