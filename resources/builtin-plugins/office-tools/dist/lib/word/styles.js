// styles — маппинг JSON-спеки (styles.*) в стили пакета docx.
// Единицы спеки: size = half-points (22 → 11pt), spacing/indent = twips,
// lineHeight = множитель (1.15 → 276 twips = 240 * 1.15).

const docx = require('docx')

/** см → twips (1 см = 567 twips). */
function cmToTwips(cm) {
  return Math.round(Number(cm) * 567)
}

/** lineHeight-множитель → twips (240 = одинарный). */
function lineHeightToTwips(lh) {
  const n = Number(lh)
  if (!isFinite(n) || n <= 0) return undefined
  return Math.round(n * 240)
}

/** Маппинг alignment-строк спеки → AlignmentType. */
const ALIGN = {
  left: docx.AlignmentType.LEFT,
  start: docx.AlignmentType.START,
  center: docx.AlignmentType.CENTER,
  right: docx.AlignmentType.RIGHT,
  end: docx.AlignmentType.END,
  justify: docx.AlignmentType.JUSTIFIED,
  both: docx.AlignmentType.JUSTIFIED,
}

function alignType(a) {
  if (!a) return undefined
  return ALIGN[String(a).toLowerCase()]
}

/** underline-описание спеки → docx underline. */
function underlineType(u) {
  if (!u) return undefined
  if (u === true) return { type: docx.UnderlineType.SINGLE }
  const map = {
    single: docx.UnderlineType.SINGLE,
    double: docx.UnderlineType.DOUBLE,
    wave: docx.UnderlineType.WAVE,
    dashed: docx.UnderlineType.DASHED,
    dotted: docx.UnderlineType.DOTTED,
    thick: docx.UnderlineType.THICK,
  }
  const t = map[String(u && u.type || u).toLowerCase()]
  return t ? { type: t } : { type: docx.UnderlineType.SINGLE }
}

/**
 * Run-свойства спеки (bold/italic/underline/strike/sub/super/font/size/color/
 * highlight/allCaps/caps) → объект опций TextRun.
 */
function runProps(style) {
  if (!style || typeof style !== 'object') return {}
  const p = {}
  if (style.bold !== undefined) p.bold = !!style.bold
  if (style.italic !== undefined) p.italics = !!style.italic
  if (style.underline !== undefined && style.underline !== false) p.underline = underlineType(style.underline)
  if (style.strike !== undefined) p.strike = !!style.strike
  if (style.subscript) p.subScript = true
  if (style.superscript) p.superScript = true
  if (style.font) p.font = String(style.font)
  if (style.size !== undefined) p.size = Math.round(Number(style.size))
  if (style.color && style.color !== 'auto') p.color = String(style.color).replace('#', '')
  if (style.highlight) p.highlight = String(style.highlight).replace('#', '')
  if (style.allCaps) p.allCaps = true
  if (style.caps) p.smallCaps = true
  return p
}

/** Стиль заголовка N из спеки → paragraphStyle для docx. */
function headingParagraphStyle(level, s) {
  const id = 'Heading' + level
  const run = runProps(s)
  const paragraph = {}
  if (s.spacingBefore !== undefined || s.spacingAfter !== undefined) {
    paragraph.spacing = {}
    if (s.spacingBefore !== undefined) paragraph.spacing.before = Math.round(Number(s.spacingBefore))
    if (s.spacingAfter !== undefined) paragraph.spacing.after = Math.round(Number(s.spacingAfter))
  }
  if (s.lineHeight !== undefined) {
    paragraph.spacing = paragraph.spacing || {}
    paragraph.spacing.line = lineHeightToTwips(s.lineHeight)
  }
  return {
    id,
    name: 'Heading ' + level,
    basedOn: 'Normal',
    next: 'Normal',
    quickFormat: true,
    ...(Object.keys(run).length ? { run } : {}),
    ...(Object.keys(paragraph).length ? { paragraph } : {}),
  }
}

/**
 * styles-секция спеки → объект styles для new Document(...).
 * styles.default задаёт шрифт/размер/цвет/межстрочку тела документа,
 * styles.heading1..6 переопределяют встроенные стили заголовков.
 */
function buildStyles(specStyles) {
  const s = specStyles || {}
  const styles = {
    default: {
      document: {
        run: {},
        paragraph: {},
      },
    },
    paragraphStyles: [],
    characterStyles: [
      {
        id: 'Hyperlink',
        name: 'Hyperlink',
        basedOn: 'DefaultParagraphFont',
        run: { color: '0563C1', underline: { type: docx.UnderlineType.SINGLE } },
      },
    ],
  }

  const d = s.default || {}
  const drun = runProps({ font: d.font, size: d.size, color: d.color })
  if (Object.keys(drun).length) styles.default.document.run = drun
  const spacing = {}
  if (d.lineHeight !== undefined) spacing.line = lineHeightToTwips(d.lineHeight)
  if (d.spacingAfter !== undefined) spacing.after = Math.round(Number(d.spacingAfter))
  if (Object.keys(spacing).length) styles.default.document.paragraph = { spacing }

  for (let lvl = 1; lvl <= 6; lvl++) {
    const hs = s['heading' + lvl]
    if (hs && typeof hs === 'object') {
      styles.paragraphStyles.push(headingParagraphStyle(lvl, hs))
    }
  }
  return styles
}

module.exports = { buildStyles, runProps, alignType, underlineType, cmToTwips, lineHeightToTwips }
