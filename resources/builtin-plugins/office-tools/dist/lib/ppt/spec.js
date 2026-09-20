// spec — сборка .pptx из JSON-спеки (см. specDoc.js — полный контракт формата).
// buildPresentation(spec, ctx) → { buffer, stats }.
// ctx: { readImage?(path) → { base64, ext } } — картинки читаются через fs хоста.
//
// После pptxgenjs.write() в буфер инъектируются транзишены (<p:transition>),
// которых pptxgenjs не поддерживает.

const AdmZip = require('adm-zip')
const { applyTransitionToXml, normalizeTransition } = require('./transition')
const { THEMES, findTheme, applyTheme } = require('./themes')
const templateLib = require('./templateLib')

/**
 * Разрешение ссылки на шаблон: id встроенной темы | путь к файлу | объект-тема.
 * @returns {object|null} тема для applyTheme
 */
function resolveTemplate(ref) {
  if (!ref) return null
  if (typeof ref === 'object') {
    if (!ref.colors || !ref.colors.bg || !ref.colors.accent) {
      throw new Error('template-объект: обязательны colors.bg и colors.accent (см. ppt_spec_docs)')
    }
    return ref
  }
  const s = String(ref)
  // 1. Встроенная тема
  const theme = findTheme(s)
  if (theme) return theme
  // 2. Путь к файлу (.pptx/.potx/.thmx) — палитра+шрифты из его theme1.xml
  const looksPath = /[\\/]/.test(s) || /\.(pptx|potx|thmx|ppt)$/i.test(s)
  if (looksPath) {
    const fs = require('fs')
    if (!fs.existsSync(s)) {
      throw new Error('Файл шаблона не найден: ' + s + '. Встроенные темы: ' + THEMES.map((t) => t.id).join(', ') + '. Список файлов: тул ppt_templates')
    }
    if (!/\.(pptx|potx|thmx)$/i.test(s)) {
      throw new Error('Файл шаблона должен быть .pptx/.potx/.thmx (не .' + (s.split('.').pop() || '?') + '). Старый .ppt конвертируй: office_save_as → .pptx')
    }
    const t = templateLib.extractTheme(s)
    return {
      id: 'file:' + require('path').basename(s),
      name: require('path').basename(s),
      style: t.style,
      colors: t.colors,
      fonts: t.fonts,
    }
  }
  throw new Error('Шаблон не найден: ' + s + '. Встроенные темы: ' + THEMES.map((t) => t.id).join(', ') + '. Или путь к .pptx/.potx/.thmx (список: тул ppt_templates)')
}

/** Стандартные layout'ы pptxgenjs. */
const LAYOUTS = {
  '16x9': 'LAYOUT_16x9', // 10 × 5.625 in
  '16x10': 'LAYOUT_16x10', // 10 × 6.25 in
  '4x3': 'LAYOUT_4x3', // 10 × 7.5 in
  wide: 'LAYOUT_WIDE', // 13.33 × 7.5 in
}

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

/** Цвет: '#ff0000' | 'ff0000' | 'FF0000' → 'FF0000'. Остальное — как есть. */
function normColor(v) {
  if (typeof v !== 'string') return v
  const s = v.trim()
  return s.startsWith('#') ? s.slice(1).toUpperCase() : s.toUpperCase()
}

/** Нормализация опций объекта слайда: цвета, fill/line, chartColors. */
function normOpt(o) {
  if (!o || typeof o !== 'object') return o
  const out = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue
    if (k === 'color') out[k] = normColor(v)
    else if (k === 'fill') out[k] = typeof v === 'string' ? { color: normColor(v) } : normOpt(v)
    else if (k === 'line') {
      out[k] = typeof v === 'string' ? { color: normColor(v) } : normOpt(v)
    } else if (k === 'chartColors') {
      out[k] = Array.isArray(v) ? v.map(normColor) : v
    } else if (k === 'dataBorder' && v && typeof v === 'object') {
      out[k] = { ...v, color: v.color != null ? normColor(v.color) : v.color }
    } else {
      out[k] = v
    }
  }
  return out
}

/** Чтение картинки: path через ctx.readImage, либо data (base64) как есть. */
async function loadImageData(img, ctx) {
  if (img.data) {
    // data — уже base64; mime из опционального mime/mimeType, иначе png
    const mime = img.mime || img.mimeType || 'image/png'
    return mime.startsWith('image/') ? mime + ';base64,' + img.data : img.data
  }
  if (img.path) {
    if (!ctx || typeof ctx.readImage !== 'function') {
      throw new Error('image.path требует ctx.readImage (нет доступа к fs)')
    }
    const r = await ctx.readImage(img.path)
    const mime = MIME[r.ext] || 'image/png'
    return mime + ';base64,' + r.base64
  }
  throw new Error('image: нужен path (локальный файл) или data (base64)')
}

/** Текстовое содержимое: text (строка) | runs | paragraphs → формат pptxgenjs. */
function textContent(obj) {
  if (obj.runs !== undefined) {
    if (!Array.isArray(obj.runs)) throw new Error('runs должен быть массивом [{ text, options? }]')
    return obj.runs.map((r) => ({
      text: String(r.text != null ? r.text : ''),
      options: normOpt(r.options || {}),
    }))
  }
  if (obj.paragraphs !== undefined) {
    if (!Array.isArray(obj.paragraphs)) throw new Error('paragraphs должен быть массивом')
    return obj.paragraphs.map((p, i) => {
      const item = typeof p === 'string' ? { text: p } : p
      const opts = normOpt(item.options || {})
      if (i < obj.paragraphs.length - 1) opts.breakLine = true
      return { text: String(item.text != null ? item.text : ''), options: opts }
    })
  }
  return obj.text != null ? String(obj.text) : ''
}

/** Ячейка таблицы: строка | { text, options } (options — как у run + colspan/rowspan). */
function normCell(cell) {
  if (cell == null) return { text: '' }
  if (typeof cell === 'string' || typeof cell === 'number') return { text: String(cell) }
  return { text: cell.text != null ? String(cell.text) : '', options: normOpt(cell.options || {}) }
}

function normTableRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('table.rows обязателен (массив массивов ячеек)')
  return rows.map((row) => {
    if (!Array.isArray(row)) throw new Error('table.rows: каждая строка — массив ячеек')
    return row.map(normCell)
  })
}

/** Фон слайда/мастера: { color } | { path } | { data }. */
async function normBackground(bg, ctx) {
  if (!bg || typeof bg !== 'object') return undefined
  if (bg.color) return { color: normColor(bg.color) }
  if (bg.path || bg.data) return { data: await loadImageData(bg, ctx) }
  throw new Error('background: нужен color, path или data')
}

/** Поиск имени фигуры pptxgenjs (ShapeType) без учёта регистра. */
function findShape(pptx, name) {
  if (!name) throw new Error('shape.shape обязателен (например "rect", "roundRect", "ellipse", "rightArrow")')
  const shapes = pptx.ShapeType || {}
  if (shapes[name]) return shapes[name]
  const key = String(name).toLowerCase()
  for (const [k, v] of Object.entries(shapes)) {
    if (k.toLowerCase() === key) return v
  }
  throw new Error('Неизвестная фигура: ' + name + '. Примеры: rect, roundRect, ellipse, triangle, chevron, rightArrow, line, pentagon, star5')
}

/** Маппинг имени типа диаграммы → ChartType. */
function chartTypeOf(pptx, name) {
  const types = pptx.ChartType || {}
  const key = String(name || '').toLowerCase()
  if (types[key]) return types[key]
  for (const [k, v] of Object.entries(types)) {
    if (k.toLowerCase() === key) return v
  }
  throw new Error('Неизвестный тип диаграммы: ' + name + '. Доступно: ' + Object.keys(types).join(', '))
}

/** Данные диаграммы: валидация + нормализация. */
function normChartData(data, chartType) {
  if (!Array.isArray(data) || !data.length) throw new Error('chart.data обязателен: [{ name, labels: [], values: [] }]')
  const isScatter = chartType === 'scatter'
  const isBubble = String(chartType).toLowerCase().startsWith('bubble')
  return data.map((s) => {
    if (!s || typeof s !== 'object' || !Array.isArray(s.values)) {
      throw new Error('chart.data: каждая серия — { name, values: [...] }' + (isScatter ? ' (scatter: первая серия — X, остальные — Y)' : ''))
    }
    const out = { name: String(s.name != null ? s.name : 'Series'), values: s.values.map(Number) }
    if (s.labels) out.labels = s.labels.map((v) => (v != null ? String(v) : ''))
    if (isBubble && s.sizes) out.sizes = s.sizes.map(Number)
    return out
  })
}

/** Один объект слайда → вызов add* на слайде. */
async function addObject(slide, obj, pptx, ctx, stats) {
  if (!obj || !obj.type) throw new Error('Объект слайда без type: ' + JSON.stringify(obj).slice(0, 120))
  switch (obj.type) {
    case 'text': {
      const content = textContent(obj)
      const opts = normOpt(obj.options || {})
      // Позиция может лежать в самом объекте (x,y,w,h) — переносим в options
      for (const k of ['x', 'y', 'w', 'h']) if (obj[k] !== undefined) opts[k] = obj[k]
      slide.addText(content, opts)
      stats.texts++
      break
    }
    case 'table': {
      const rows = normTableRows(obj.rows)
      const opts = normOpt(obj.options || {})
      for (const k of ['x', 'y', 'w', 'h', 'colW', 'rowH', 'autoPage', 'autoPageRepeatHeader']) {
        if (obj[k] !== undefined) opts[k] = obj[k]
      }
      slide.addTable(rows, opts)
      stats.tables++
      break
    }
    case 'image': {
      const data = await loadImageData(obj, ctx)
      const opts = normOpt(obj.options || {})
      for (const k of ['x', 'y', 'w', 'h', 'sizing', 'rotate', 'rounding', 'shadow', 'flipH', 'flipV', 'transparency', 'altText']) {
        if (obj[k] !== undefined) opts[k] = obj[k]
      }
      slide.addImage({ data, ...opts })
      stats.images++
      break
    }
    case 'shape': {
      const shape = findShape(pptx, obj.shape)
      const opts = normOpt(obj.options || {})
      for (const k of ['x', 'y', 'w', 'h', 'rotate', 'flipH', 'flipV', 'rectRadius', 'shadow', 'display']) {
        if (obj[k] !== undefined) opts[k] = obj[k]
      }
      if (obj.text !== undefined) {
        // Текст внутри фигуры — addText с shape
        slide.addText(textContent({ text: obj.text, runs: obj.runs, paragraphs: obj.paragraphs }), {
          shape,
          ...opts,
          ...(obj.textOptions ? normOpt(obj.textOptions) : {}),
        })
      } else {
        slide.addShape(shape, opts)
      }
      stats.shapes++
      break
    }
    case 'chart': {
      const opts = normOpt(obj.options || {})
      for (const k of ['x', 'y', 'w', 'h']) if (obj[k] !== undefined) opts[k] = obj[k]
      if (String(obj.chartType).toLowerCase() === 'combo') {
        // Комбо-диаграмма: series: [{ chartType, data, options? }]
        if (!Array.isArray(obj.series) || !obj.series.length) {
          throw new Error('chart combo: series обязателен — [{ chartType, data, options? }]')
        }
        const combo = obj.series.map((s) => ({
          type: chartTypeOf(pptx, s.chartType),
          data: normChartData(s.data, s.chartType),
          options: normOpt(s.options || {}),
        }))
        slide.addChart(combo, opts)
      } else {
        const type = chartTypeOf(pptx, obj.chartType)
        const data = normChartData(obj.data, obj.chartType)
        slide.addChart(type, data, opts)
      }
      stats.charts++
      break
    }
    case 'media': {
      const opts = normOpt(obj.options || {})
      for (const k of ['x', 'y', 'w', 'h', 'poster', 'autoplay', 'loop']) {
        if (obj[k] !== undefined) opts[k] = obj[k]
      }
      const mediaType = String(obj.mediaType || obj.mtype || 'video').toLowerCase()
      if (mediaType === 'online' || obj.link) {
        if (!obj.link) throw new Error('media online: link обязателен (URL, например YouTube)')
        slide.addMedia({ type: 'online', link: obj.link, ...opts })
      } else if (obj.path) {
        // Локальный файл читается в base64 (видео/аудио)
        if (!ctx || typeof ctx.readImage !== 'function') {
          throw new Error('media.path требует ctx.readImage (нет доступа к fs)')
        }
        const r = await ctx.readImage(obj.path)
        const ext = (r.ext || '').toLowerCase()
        const mime = ext === 'mp4' ? 'video/mp4' : ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : ext === 'webm' ? 'video/webm' : 'application/octet-stream'
        slide.addMedia({ type: mediaType === 'audio' ? 'audio' : 'video', data: mime + ';base64,' + r.base64, ...opts })
      } else {
        throw new Error('media: нужен path (локальный файл) или link (URL) + mediaType: video|audio|online')
      }
      stats.media++
      break
    }
    default:
      throw new Error('Неизвестный тип объекта слайда: ' + obj.type + ' (доступно: text, table, image, shape, chart, media)')
  }
}

/** EMU из дюймов. */
function emu(inch) {
  return Math.round(Number(inch) * 914400)
}

/** XML-escape текста. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * XML декоративного объекта мастера (rect/ellipse/line/text) — pptxgenjs
 * генерирует в defineSlideMaster только rect-без-rotate и slideNumber,
 * остальные объекты инъектируем сами.
 */
function masterObjectXml(obj, id) {
  const kind = Object.keys(obj || {})[0]
  const o = obj[kind] || {}
  const nv = '<p:nvSpPr><p:cNvPr id="' + id + '" name="Master Decor ' + id + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
  const xfrm = (rot) =>
    '<a:xfrm' + (rot ? ' rot="' + Math.round(Number(rot) * 60000) + '"' : '') +
    '><a:off x="' + emu(o.x) + '" y="' + emu(o.y) + '"/><a:ext cx="' + emu(o.w) + '" cy="' + emu(o.h) + '"/></a:xfrm>'

  if (kind === 'line') {
    const ln = o.line || {}
    const w = ln.width != null ? Math.round(Number(ln.width) * 12700) : 9525 // 0.75pt
    return '<p:sp>' + nv + '<p:spPr>' + xfrm() +
      '<a:prstGeom prst="line"><a:avLst/></a:prstGeom>' +
      '<a:ln w="' + w + '"><a:solidFill><a:srgbClr val="' + normColor(ln.color || '000000') + '"/></a:solidFill></a:ln>' +
      '</p:spPr></p:sp>'
  }
  if (kind === 'text') {
    const t = o
    const opts = t.options || {}
    const sz = opts.fontSize ? Math.round(Number(opts.fontSize) * 100) : 1200
    const color = opts.color ? '<a:solidFill><a:srgbClr val="' + normColor(opts.color) + '"/></a:solidFill>' : ''
    const font = opts.fontFace ? '<a:latin typeface="' + esc(opts.fontFace) + '"/>' : ''
    const b = opts.bold ? ' b="1"' : ''
    const algn = opts.align === 'center' ? ' algn="ctr"' : opts.align === 'right' ? ' algn="r"' : opts.align === 'justify' ? ' algn="just"' : ''
    return '<p:sp>' + nv + '<p:spPr>' + xfrm() +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
      '<p:txBody><a:bodyPr/><a:lstStyle/><a:p' + algn + '><a:r><a:rPr lang="ru-RU" sz="' + sz + '"' + b + ' dirty="0">' +
      color + font + '</a:rPr><a:t>' + esc(t.text != null ? t.text : '') + '</a:t></a:r></a:p></p:txBody></p:sp>'
  }
  // rect / ellipse
  const prst = kind === 'ellipse' ? 'ellipse' : 'rect'
  let fillXml = '<a:noFill/>'
  const f = o.fill
  if (f) {
    const fc = typeof f === 'string' ? { color: f } : f
    const alpha = fc.transparency != null ? '<a:alpha val="' + Math.round((100 - Number(fc.transparency)) * 1000) + '"/>' : ''
    fillXml = '<a:solidFill><a:srgbClr val="' + normColor(fc.color || '000000') + '">' + alpha + '</a:srgbClr></a:solidFill>'
  }
  return '<p:sp>' + nv + '<p:spPr>' + xfrm(o.rotate) +
    '<a:prstGeom prst="' + prst + '"><a:avLst/></a:prstGeom>' + fillXml + '</p:spPr></p:sp>'
}

/** Инъекция декоративных объектов в slideMasterN.xml (после сборки pptxgenjs).
 *  mastersExtra[i] — массив объектов мастера i (rect+rotate / ellipse / line / text). */
function injectMasterObjects(buffer, mastersExtra) {
  const zip = new AdmZip(buffer)
  mastersExtra.forEach((extra, idx) => {
    if (!extra || !extra.length) return
    const file = 'ppt/slideMasters/slideMaster' + (idx + 1) + '.xml'
    let xml = zip.readAsText(file)
    if (!xml || !xml.includes('</p:spTree>')) return
    const shapes = extra.map((o, i) => masterObjectXml(o, 90 + i)).join('')
    xml = xml.replace('</p:spTree>', shapes + '</p:spTree>')
    zip.updateFile(file, Buffer.from(xml, 'utf-8'))
  })
  return zip.toBuffer()
}

/** Мастер слайдов → defineSlideMaster. Возвращает extraShapes — объекты,
 *  которые pptxgenjs не генерирует (инъектируются постпроцессингом). */
async function defineMaster(pptx, m, ctx) {
  if (!m || !m.id) throw new Error('masters[]: id обязателен')
  const def = { title: String(m.id) }
  const bg = await normBackground(m.background, ctx)
  if (bg) def.background = bg
  const extraShapes = []
  if (m.objects) {
    if (!Array.isArray(m.objects)) throw new Error('masters[].objects — массив')
    def.objects = []
    for (const o of m.objects) {
      // Формат pptxgenjs: { rect } | { text } | { line } | { image } | { placeholder } | { ellipse }
      const kind = Object.keys(o || {}).find((k) => ['rect', 'text', 'line', 'image', 'placeholder', 'ellipse'].includes(k))
      if (!kind) throw new Error('masters[].objects: ключ rect|text|line|image|placeholder|ellipse, получено ' + JSON.stringify(o).slice(0, 80))
      // pptxgenjs 4.0.1 в defineSlideMaster генерирует ТОЛЬКО background/slideNumber/
      // placeholder — все декоративные объекты (rect/ellipse/line/text) теряются.
      // Поэтому их инъектируем сами постпроцессингом; нативно — только image/placeholder.
      const native = kind === 'image' || kind === 'placeholder'
      if (native) {
        if (kind === 'image') {
          const img = o.image
          def.objects.push({ image: { x: img.x, y: img.y, w: img.w, h: img.h, data: await loadImageData(img, ctx) } })
        } else {
          def.objects.push({ placeholder: o.placeholder })
        }
      } else {
        // rect (любой) / ellipse / line / text → инъекция постпроцессингом
        extraShapes.push(o)
      }
    }
  }
  if (m.slideNumber) def.slideNumber = normOpt(m.slideNumber)
  pptx.defineSlideMaster(def)
  return extraShapes
}

/**
 * Главная функция: JSON-спека → Buffer .pptx.
 * @param {object} spec { layout?, title?, author?, theme?, masters?, slides: [...] }
 * @param {object} ctx { readImage? }
 * @returns {Promise<{buffer: Buffer, stats: object}>}
 */
async function buildPresentation(spec, ctx) {
  if (!spec || typeof spec !== 'object') throw new Error('spec (объект презентации) обязателен')
  if (!Array.isArray(spec.slides) || !spec.slides.length) throw new Error('spec.slides (массив слайдов) обязателен')

  // Дизайн-тема: встроенная (id) / файл-шаблон (.pptx/.potx/.thmx) / объект.
  // Применяется ДО сборки: мастера, фоны, автоцвета, шрифты, chartColors.
  let themeMasterBg = null
  if (spec.template) {
    const theme = resolveTemplate(spec.template)
    if (theme) {
      const applied = applyTheme(spec, theme)
      // pptxgenjs не пишет фон мастера в XML — инъектируем постпроцессингом
      if (applied.createdMaster) themeMasterBg = applied.bg
    }
  }

  ctx = ctx || {}
  const mod = require('pptxgenjs')
  const PptxGenJS = mod.default || mod
  const pptx = new PptxGenJS()

  // ── Layout: строка из LAYOUTS или { name, width, height } ──
  const layout = spec.layout || '16x9'
  if (typeof layout === 'string') {
    const key = layout.toLowerCase().replace(/[\s_-]/g, '')
    const name = LAYOUTS[key] || LAYOUTS[key.replace('layout', '')]
    if (!name) throw new Error('Неизвестный layout: ' + layout + ' (доступно: 16x9, 16x10, 4x3, wide или { name, width, height })')
    pptx.layout = name
  } else if (layout && typeof layout === 'object') {
    if (!layout.name || !layout.width || !layout.height) {
      throw new Error('layout-объект: name, width, height обязательны (дюймы)')
    }
    pptx.defineLayout({ name: String(layout.name), width: Number(layout.width), height: Number(layout.height) })
    pptx.layout = String(layout.name)
  } else {
    throw new Error('layout: строка (16x9|16x10|4x3|wide) или объект { name, width, height }')
  }

  // ── Метаданные и тема ──
  if (spec.title) pptx.title = String(spec.title)
  if (spec.author) pptx.author = String(spec.author)
  if (spec.company) pptx.company = String(spec.company)
  if (spec.subject) pptx.subject = String(spec.subject)
  if (spec.theme && typeof spec.theme === 'object') {
    pptx.theme = { headFontFace: spec.theme.headFontFace, bodyFontFace: spec.theme.bodyFontFace }
  }

  // ── Мастера ──
  const mastersExtra = [] // объекты, которые pptxgenjs не генерирует (инъекция после write)
  if (spec.masters) {
    if (!Array.isArray(spec.masters)) throw new Error('masters — массив [{ id, background?, objects?, slideNumber? }]')
    for (const m of spec.masters) mastersExtra.push(await defineMaster(pptx, m, ctx))
  }

  const stats = { slides: 0, texts: 0, tables: 0, images: 0, shapes: 0, charts: 0, media: 0, notes: 0, hidden: 0, transitions: 0 }
  const transitions = new Map() // № слайда (1-based) → спека транзишена

  // ── Слайды ──
  for (let i = 0; i < spec.slides.length; i++) {
    const s = spec.slides[i]
    if (!s || typeof s !== 'object') throw new Error('slides[' + i + '] — объект')

    const slideOpts = s.master ? { masterName: String(s.master) } : {}
    const slide = pptx.addSlide(slideOpts)
    stats.slides++

    const bg = await normBackground(s.background, ctx)
    if (bg) slide.background = bg
    if (s.hidden) { slide.hidden = true; stats.hidden++ }
    if (s.notes) { slide.addNotes(String(s.notes)); stats.notes++ }
    if (s.slideNumber) slide.slideNumber = normOpt(s.slideNumber)

    if (s.transition) {
      normalizeTransition(s.transition) // ранняя валидация с понятной ошибкой
      transitions.set(i + 1, s.transition)
    }

    if (s.objects) {
      if (!Array.isArray(s.objects)) throw new Error('slides[' + i + '].objects — массив объектов')
      for (const obj of s.objects) await addObject(slide, obj, pptx, ctx, stats)
    }
  }

  // ── Сборка + инъекции постпроцессинга ──
  let buffer = await pptx.write({ outputType: 'nodebuffer' })
  if (transitions.size) {
    buffer = injectTransitions(buffer, transitions)
    stats.transitions = transitions.size
  }
  if (themeMasterBg) {
    buffer = injectMasterBg(buffer, themeMasterBg)
  }
  if (mastersExtra.some((e) => e && e.length)) {
    buffer = injectMasterObjects(buffer, mastersExtra)
  }
  return { buffer, stats }
}

/** Инъекция <p:transition> в slideN.xml готового буфера. */
function injectTransitions(buffer, transitions) {
  const zip = new AdmZip(buffer)
  for (const [num, tr] of transitions) {
    const file = 'ppt/slides/slide' + num + '.xml'
    const xml = zip.readAsText(file)
    if (!xml) throw new Error('Инъекция транзишена: не найден ' + file)
    zip.updateFile(file, Buffer.from(applyTransitionToXml(xml, tr), 'utf-8'))
  }
  return zip.toBuffer()
}

/** Инъекция <p:bg> в slideMasterN.xml (pptxgenjs не пишет фон мастера). */
function injectMasterBg(buffer, bgColor) {
  const zip = new AdmZip(buffer)
  const bg = '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="' + bgColor + '"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
  for (const e of zip.getEntries()) {
    if (!/^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(e.entryName)) continue
    let xml = zip.readAsText(e.entryName)
    if (/<p:bg>/.test(xml)) continue
    // p:bg — первый дочерний элемент p:cSld (до p:spTree)
    xml = xml.replace(/<p:cSld>\s*<p:spTree>/, '<p:cSld>' + bg + '<p:spTree>')
    zip.updateFile(e.entryName, Buffer.from(xml, 'utf-8'))
  }
  return zip.toBuffer()
}

module.exports = { buildPresentation, normColor, textContent, LAYOUTS, resolveTemplate }
