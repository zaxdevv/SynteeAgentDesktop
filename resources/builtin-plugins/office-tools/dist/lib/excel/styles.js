// styles — маппинг спека-стилей в exceljs
// Спека: fill "DEEBF7" (hex без #), border thin/medium/..., font.color "FF0000"
// exceljs: fill { type:'pattern', pattern:'solid', fgColor:{argb:'FFDEEBF7'} }

const BORDER_STYLES = ['thin', 'medium', 'thick', 'double', 'dashed', 'dotted', 'hair', 'dashDot', 'dashDotDot', 'slantDashDot']

/** hex "DEEBF7" | "#DEEBF7" | "FFDEEBF7" → argb "FFDEEBF7" */
function toArgb(hex) {
  if (!hex || typeof hex !== 'string') return 'FF000000'
  let h = hex.replace('#', '').toUpperCase()
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length === 6) h = 'FF' + h
  if (h.length !== 8 || !/^[0-9A-F]+$/.test(h)) return 'FF000000'
  return h
}

/** font из спека → exceljs font */
function mapFont(font) {
  if (!font || typeof font !== 'object') return undefined
  const f = {}
  if (font.name) f.name = String(font.name)
  if (font.size != null) f.size = Number(font.size)
  if (font.bold != null) f.bold = !!font.bold
  if (font.italic != null) f.italic = !!font.italic
  if (font.strike != null) f.strike = !!font.strike
  if (font.underline === true) f.underline = true
  else if (typeof font.underline === 'string') f.underline = font.underline
  if (font.color) f.color = { argb: toArgb(font.color) }
  return f
}

/** fill из спека (hex-строка) → exceljs pattern fill */
function mapFill(fill) {
  if (!fill) return undefined
  if (typeof fill === 'string') {
    return { type: 'pattern', pattern: 'solid', fgColor: { argb: toArgb(fill) } }
  }
  if (typeof fill === 'object' && fill.color) {
    return { type: 'pattern', pattern: 'solid', fgColor: { argb: toArgb(fill.color) } }
  }
  return undefined
}

/** border из спека → exceljs border */
function mapBorder(border) {
  if (!border || typeof border !== 'object') return undefined
  const out = {}
  let any = false
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const b = border[side]
    if (!b) continue
    if (typeof b === 'string') {
      out[side] = { style: b, color: { argb: 'FF000000' } }
      any = true
    } else if (typeof b === 'object') {
      const style = b.style || 'thin'
      if (!BORDER_STYLES.includes(style)) continue
      out[side] = { style, color: { argb: toArgb(b.color || '000000') } }
      any = true
    }
  }
  return any ? out : undefined
}

/** alignment из спека → exceljs alignment (vertical middle → middle ok) */
function mapAlignment(al) {
  if (!al || typeof al !== 'object') return undefined
  const out = {}
  if (al.horizontal) out.horizontal = al.horizontal
  if (al.vertical) out.vertical = al.vertical
  if (al.wrapText != null) out.wrapText = !!al.wrapText
  if (al.shrinkToFit != null) out.shrinkToFit = !!al.shrinkToFit
  if (al.textRotation != null) out.textRotation = Number(al.textRotation)
  return Object.keys(out).length ? out : undefined
}

/** полный cell style из спека → exceljs style-объект (без numFmt) */
function mapCellStyle(style) {
  if (!style || typeof style !== 'object') return null
  const out = {}
  const font = mapFont(style.font)
  if (font) out.font = font
  const fill = mapFill(style.fill)
  if (fill) out.fill = fill
  const border = mapBorder(style.border)
  if (border) out.border = border
  const al = mapAlignment(style.alignment)
  if (al) out.alignment = al
  return Object.keys(out).length ? out : null
}

/** exceljs cell.style → упрощённый спека-style (для read full) */
function unmapStyle(cell) {
  const st = cell.style || {}
  const out = {}
  if (st.font && (st.font.name || st.font.bold || st.font.italic || st.font.underline || st.font.strike || st.font.size || (st.font.color && st.font.color.argb && st.font.color.argb !== 'FF000000'))) {
    const f = {}
    if (st.font.name) f.name = st.font.name
    if (st.font.size != null) f.size = st.font.size
    if (st.font.bold) f.bold = true
    if (st.font.italic) f.italic = true
    if (st.font.underline) f.underline = true
    if (st.font.strike) f.strike = true
    if (st.font.color && st.font.color.argb && st.font.color.argb !== 'FF000000') f.color = st.font.color.argb.slice(2)
    out.font = f
  }
  if (st.fill && st.fill.type === 'pattern' && st.fill.fgColor && st.fill.fgColor.argb && st.fill.pattern === 'solid') {
    out.fill = st.fill.fgColor.argb.slice(2)
  }
  if (st.border && typeof st.border === 'object') {
    const b = {}
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const s = st.border[side]
      if (s && s.style) b[side] = { style: s.style, color: s.color && s.color.argb ? s.color.argb.slice(2) : '000000' }
    }
    if (Object.keys(b).length) out.border = b
  }
  if (st.alignment && typeof st.alignment === 'object') {
    const a = {}
    if (st.alignment.horizontal) a.horizontal = st.alignment.horizontal
    if (st.alignment.vertical) a.vertical = st.alignment.vertical
    if (st.alignment.wrapText) a.wrapText = true
    if (st.alignment.shrinkToFit) a.shrinkToFit = true
    if (st.alignment.textRotation != null && st.alignment.textRotation !== 0) a.textRotation = st.alignment.textRotation
    if (Object.keys(a).length) out.alignment = a
  }
  return Object.keys(out).length ? out : null
}

module.exports = { toArgb, mapFont, mapFill, mapBorder, mapAlignment, mapCellStyle, unmapStyle, BORDER_STYLES }
