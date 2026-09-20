// read — чтение .docx через mammoth (docx → html → разбор → блоки спеки).
// Режимы: 'structure' (outline + blocks + stats), 'text' (plain text),
// 'full' (спека для пересборки через word_create / word_edit), 'stats'.
//
// ВАЖНО: встроенные картинки НЕ возвращаются как base64 (одна картинка
// в 400 КБ — это ~200k токенов мусора в контексте AI). Вместо этого они
// извлекаются в файлы (extractImages), а в блоках остаётся только path —
// по нему можно смотреть картинку через analyze_image и пересобирать документ.

const fs = require('fs')
const os = require('os')
const nodePath = require('path')
const mammoth = require('mammoth')
const { collectText } = require('./blocks')
const { pngSize, jpegSize } = require('./media')
const { extractMath, applyMath, sweepMathText } = require('./math')

// estimatePages из pagination.js (может отсутствовать в старой сборке — тогда fallback-формула)
let estimatePages = null
try { ({ estimatePages } = require('./pagination')) } catch { /* pagination недоступен */ }

// Известные форматы страницы (twips, w x h) → имя спеки
const PAGE_SIZES = {
  '11906x16838': 'a4',
  '12240x15840': 'letter',
  '12240x20160': 'legal',
  '8391x11906': 'a5',
  '16838x23811': 'a3',
}

/** Значение атрибута attr тега tag из xml (первое вхождение). */
function xmlAttr(xml, tag, attr) {
  const m = new RegExp('<' + tag + '[^>]*\\s' + attr + '="([^"]+)"').exec(xml || '')
  return m ? m[1] : null
}

const round2 = (v) => Math.round(v * 100) / 100
const twipsToCm = (t) => round2(Number(t) / 567)

/**
 * Page setup из .docx (adm-zip): word/document.xml <w:sectPr> + word/settings.xml.
 * Заголовки/колонтитулы НЕ парсим (ограничение: пересборка их не сохраняет).
 * @returns {object|undefined} spec.page или undefined при ошибке/отсутствии sectPr
 */
function readPageSetup(buffer) {
  try {
    const AdmZip = require('adm-zip')
    const zip = new AdmZip(buffer)
    const doc = zip.readAsText('word/document.xml')
    if (!doc) return undefined
    const sects = doc.match(/<w:sectPr[\s>][\s\S]*?<\/w:sectPr>/g)
    if (!sects || !sects.length) return undefined
    const sect = sects[sects.length - 1] // последний sectPr — финальная секция документа

    const page = {}
    const w = Number(xmlAttr(sect, 'w:pgSz', 'w:w'))
    const h = Number(xmlAttr(sect, 'w:pgSz', 'w:h'))
    if (w > 0 && h > 0) {
      const size = PAGE_SIZES[[Math.min(w, h), Math.max(w, h)].join('x')]
      if (size) page.size = size
    }
    if (xmlAttr(sect, 'w:pgSz', 'w:orient') === 'landscape') page.orientation = 'landscape'
    const margins = {}
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const t = Number(xmlAttr(sect, 'w:pgMar', 'w:' + side))
      if (t > 0) margins[side] = twipsToCm(t)
    }
    if (Object.keys(margins).length === 4) page.margins = margins
    const cols = Number(xmlAttr(sect, 'w:cols', 'w:num'))
    if (cols > 1) page.columns = cols
    if (/<w:titlePg\b/.test(sect)) page.differentFirstPage = true

    const settingsXml = zip.readAsText('word/settings.xml')
    if (settingsXml && /<w:evenAndOddHeaders\b/.test(settingsXml)) page.evenAndOdd = true

    return Object.keys(page).length ? page : undefined
  } catch {
    return undefined // ошибка парсинга — page просто отсутствует
  }
}

/**
 * Сноски из word/footnotes.xml (adm-zip). Mammoth отдаёт ссылки как <sup>N</sup>,
 * но теряет текст сноски — здесь восстанавливаем соответствие id → текст.
 * @returns {object|null} { byId: { [id]: text }, ordered: [text, …] } или null
 */
function readFootnotes(buffer) {
  try {
    const AdmZip = require('adm-zip')
    const zip = new AdmZip(buffer)
    const xml = zip.readAsText('word/footnotes.xml')
    if (!xml) return null
    const byId = {}
    const ordered = []
    const fnRe = /<w:footnote\b[^>]*\sw:id="(-?\d+)"[^>]*>([\s\S]*?)<\/w:footnote>/g
    let m
    while ((m = fnRe.exec(xml))) {
      const id = parseInt(m[1], 10)
      if (!(id > 0)) continue // 0 и отрицательные — разделители/продолжения
      const parts = []
      const tRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
      let tm
      while ((tm = tRe.exec(m[2]))) parts.push(tm[1])
      const text = decodeEntities(parts.join('')).trim()
      if (!text) continue
      byId[id] = text
      ordered.push(text)
    }
    return ordered.length ? { byId, ordered } : null
  } catch {
    return null
  }
}

const VOID_TAGS = new Set(['img', 'br', 'hr'])
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–' }

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] !== undefined ? ENTITIES[name] : m)
}

function parseAttrs(str) {
  const attrs = {}
  const re = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(str))) attrs[m[1].toLowerCase()] = m[3] != null ? m[3] : m[4]
  return attrs
}

/** Мини-парсер mammoth-HTML → дерево { tag, attrs, children }. */
function parseHtml(html) {
  const root = { tag: 'root', attrs: {}, children: [] }
  const stack = [root]
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  let m, last = 0
  const pushText = (t) => { if (t) stack[stack.length - 1].children.push(t) }
  while ((m = re.exec(html))) {
    if (m.index > last) pushText(decodeEntities(html.slice(last, m.index)))
    last = re.lastIndex
    const tag = m[2].toLowerCase()
    const attrs = parseAttrs(m[3] || '')
    if (tag === 'br') {
      stack[stack.length - 1].children.push({ tag: 'br', attrs, children: [] })
    } else if (m[1] === '/') {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break }
      }
    } else if (VOID_TAGS.has(tag)) {
      stack[stack.length - 1].children.push({ tag, attrs, children: [] })
    } else {
      const node = { tag, attrs, children: [] }
      stack[stack.length - 1].children.push(node)
      stack.push(node)
    }
  }
  if (last < html.length) pushText(decodeEntities(html.slice(last)))
  return root
}

/** img-атрибуты (data URI) → image-блок спеки (+ sniffing размеров). */
function imageFromAttrs(attrs) {
  const src = attrs.src || ''
  const m = /^data:image\/([a-zA-Z0-9]+);base64,(.*)$/s.exec(src)
  if (!m) return { type: 'image', path: attrs.src || '' }
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg')
  const block = { type: 'image', data: m[2], ext: ext === 'jpg' ? 'jpeg' : ext }
  try {
    const buf = Buffer.from(m[2], 'base64')
    const nat = (ext === 'png' && pngSize(buf)) || ((ext === 'jpg') && jpegSize(buf))
    if (nat) { block.width = nat[0]; block.height = nat[1] }
  } catch { /* размеры неизвестны — buildDocument возьмёт дефолт */ }
  return block
}

function styleKey(r) {
  return [r.bold, r.italic, r.underline, r.strike, r.subscript, r.superscript, r.url].join('|')
}

/** Инлайн-узлы → runs спеки ({ text, bold, … }); картинки → { __image }. */
function inlineRuns(nodes, state, out) {
  state = state || {}
  for (const n of nodes || []) {
    if (typeof n === 'string') { pushRun(out, n, state); continue }
    if (n.tag === 'br') { pushRun(out, '\n', state); continue }
    if (n.tag === 'img') { out.push({ __image: imageFromAttrs(n.attrs) }); continue }
    const s = { ...state }
    if (n.tag === 'strong' || n.tag === 'b') s.bold = true
    else if (n.tag === 'em' || n.tag === 'i') s.italic = true
    else if (n.tag === 'u') s.underline = true
    else if (n.tag === 's' || n.tag === 'strike' || n.tag === 'del') s.strike = true
    else if (n.tag === 'sup') s.superscript = true
    else if (n.tag === 'sub') s.subscript = true
    else if (n.tag === 'a' && n.attrs.href) s.url = n.attrs.href
    inlineRuns(n.children, s, out)
  }
  return out
}

function pushRun(out, text, state) {
  if (!text) return
  const last = out.length && out[out.length - 1]
  if (last && !last.__image && styleKey(last) === styleKey(state)) {
    last.text += text
    return
  }
  const r = { text }
  for (const k of ['bold', 'italic', 'underline', 'strike', 'subscript', 'superscript']) {
    if (state[k]) r[k] = true
  }
  if (state.url) r.url = state.url
  out.push(r)
}

/** Узел → текст (для заголовков/предпросмотра). */
function textOf(nodes) {
  return inlineRuns(nodes || [], {}, []).filter((r) => !r.__image).map((r) => r.text).join('')
}

/**
 * Привязка текста сносок к runs: суперскрипт-номер (из <sup>N</sup>) заменяется
 * на footnote-ссылку — текст сноски вешается на предыдущий run, номер убирается.
 * byId — соответствие id→текст, ordered — по порядку (fallback, если id не совпал).
 */
function applyFootnotes(blocks, footnotes) {
  if (!footnotes) return
  const { byId, ordered } = footnotes
  for (const b of blocks || []) {
    if (!b || !Array.isArray(b.runs)) continue
    for (let i = 0; i < b.runs.length; i++) {
      const r = b.runs[i]
      if (!r || !r.superscript || !/^\d+$/.test(String(r.text || '').trim())) continue
      const n = parseInt(String(r.text).trim(), 10)
      const text = byId[n] || ordered[n - 1]
      if (!text) continue
      if (i > 0) {
        b.runs[i - 1].footnote = text // текст сноски вешается на предыдущий run
        b.runs.splice(i, 1)           // номер-маркер удаляем (сноска нумеруется при сборке)
        i--
      } else {
        r.text = ''
        delete r.url
        r.footnote = text
      }
    }
  }
}

/** p-узел → блоки спеки (paragraph | hyperlink | image). */
function paragraphBlocks(node) {
  const runs = inlineRuns(node.children, {}, [])
  const images = runs.filter((r) => r.__image).map((r) => r.__image)
  const textRuns = runs.filter((r) => !r.__image)
  const out = [...images]
  if (!textRuns.length) return out
  const nonEmpty = textRuns.filter((r) => r.text)
  // Параграф целиком = одна ссылка → hyperlink-блок
  if (nonEmpty.length === 1 && nonEmpty[0].url && nonEmpty.every((r) => r.url === nonEmpty[0].url)) {
    out.push({ type: 'hyperlink', text: nonEmpty.map((r) => r.text).join(''), url: nonEmpty[0].url })
    return out
  }
  const block = { type: 'paragraph' }
  const plain = nonEmpty.map((r) => r.text).join('')
  const hasStyle = nonEmpty.some((r) => r.bold || r.italic || r.underline || r.strike || r.subscript || r.superscript)
  if (hasStyle) {
    block.runs = nonEmpty.map((r) => {
      const { url, ...rest } = r
      return rest
    })
  } else {
    block.text = plain
  }
  if (node.attrs && node.attrs.style && /text-align:\s*center/i.test(node.attrs.style)) block.alignment = 'center'
  out.push(block)
  return out
}

/** ul/ol-узел → list-блок (вложенные списки → level). */
function listBlocks(node, ordered, depth, items) {
  for (const li of node.children || []) {
    if (typeof li === 'string' || li.tag !== 'li') continue
    const inline = []
    const nested = []
    for (const c of li.children || []) {
      if (typeof c === 'string') { inline.push(c); continue }
      if (c.tag === 'ul' || c.tag === 'ol') nested.push(c)
      else inline.push(c)
    }
    const runs = inlineRuns(inline, {}, []).filter((r) => !r.__image)
    const text = runs.map((r) => r.text).join('').trim()
    const item = { text, level: depth }
    if (runs.some((r) => r.bold || r.italic || r.underline)) {
      item.runs = runs.map((r) => { const { url, ...rest } = r; return rest })
    }
    items.push(item)
    for (const nl of nested) listBlocks(nl, nl.tag === 'ol', depth + 1, items)
  }
  return items
}

/** table-узел → table-блок спеки (mammoth оборачивает строки в thead/tbody). */
function tableBlock(node) {
  const rows = []
  let header = false
  const walkRows = (n, inHead) => {
    for (const child of n.children || []) {
      if (typeof child === 'string') continue
      if (child.tag === 'thead') { walkRows(child, true); continue }
      if (child.tag === 'tbody' || child.tag === 'tfoot' || child.tag === 'table') { walkRows(child, inHead); continue }
      if (child.tag !== 'tr') continue
      const cells = []
      for (const td of child.children || []) {
        if (typeof td === 'string') continue
        if (td.tag !== 'td' && td.tag !== 'th') continue
        const runs = inlineRuns(td.children, {}, []).filter((r) => !r.__image)
        const cell = { text: runs.map((r) => r.text).join('').trim() }
        if (td.tag === 'th' || inHead || runs.some((r) => r.bold)) cell.bold = true
        if (td.attrs && td.attrs.colspan) cell.colspan = Number(td.attrs.colspan)
        if (td.attrs && td.attrs.rowspan) cell.rowspan = Number(td.attrs.rowspan)
        cells.push(cell)
      }
      if (cells.length) {
        if (inHead && !rows.length) header = true
        rows.push(cells)
      }
    }
  }
  walkRows(node, false)
  return rows.length ? { type: 'table', rows, header } : null
}

/** Дерево html → блоки спеки. */
function htmlToBlocks(root) {
  const blocks = []
  for (const n of root.children || []) {
    if (typeof n === 'string') {
      if (n.trim()) blocks.push({ type: 'paragraph', text: n.trim() })
      continue
    }
    if (/^h[1-6]$/.test(n.tag)) {
      blocks.push({ type: 'heading', level: Number(n.tag[1]), text: textOf(n.children) })
    } else if (n.tag === 'p') {
      blocks.push(...paragraphBlocks(n))
    } else if (n.tag === 'ul' || n.tag === 'ol') {
      const items = listBlocks(n, n.tag === 'ol', 0, [])
      if (items.length) blocks.push({ type: 'list', ordered: n.tag === 'ol', items })
    } else if (n.tag === 'table') {
      const t = tableBlock(n)
      if (t) blocks.push(t)
    } else if (n.tag === 'img') {
      blocks.push(imageFromAttrs(n.attrs))
    } else {
      blocks.push(...htmlToBlocks(n))
    }
  }
  return blocks
}

/** Блоки → stats (как у buildDocument). page — известный page setup (для estimatePages). */
function blocksStats(blocks, page) {
  const stats = { paragraphs: 0, words: 0, tables: 0, images: 0, lists: 0, approxPages: 1 }
  const texts = []
  for (const b of blocks) {
    if (b.type === 'list') {
      stats.lists++
      stats.paragraphs += (b.items || []).length
      for (const it of b.items || []) texts.push(it.text || '')
    } else if (b.type === 'table') {
      stats.tables++
    } else if (b.type === 'image') {
      stats.images++
    } else {
      stats.paragraphs++
    }
    collectText(b, texts)
  }
  stats.words = texts.join(' ').split(/\s+/).filter(Boolean).length
  // Точная оценка страниц через pagination.js; при его отсутствии — грубая формула
  if (typeof estimatePages === 'function') {
    try {
      stats.approxPages = Math.max(1, estimatePages(blocks, { page: page || undefined, compactLists: true }))
    } catch {
      stats.approxPages = fallbackPages(stats)
    }
  } else {
    stats.approxPages = fallbackPages(stats)
  }
  return stats
}

function fallbackPages(stats) {
  const est = stats.words / 400 + stats.tables * 0.25 + stats.images * 0.15 + stats.paragraphs * 0.02
  return Math.max(1, Math.ceil(est))
}

function previewOf(block) {
  let t = ''
  if (block.type === 'heading') t = block.text
  else if (block.type === 'math') t = '[formula] ' + (block.latex || '')
  else if (block.type === 'list') t = (block.items || []).map((i) => (typeof i === 'string' ? i : i.text)).join(' · ')
  else if (block.type === 'table') t = '[' + (block.rows || []).length + 'x' + ((block.rows || [])[0] || []).length + '] ' + ((block.rows || [])[0] || []).map((c) => (typeof c === 'string' ? c : c.text)).join(' | ')
  else if (block.type === 'image') t = '[image' + (block.width ? ' ' + block.width + 'x' + block.height : '') + (block.path ? ' → ' + block.path : '') + ']'
  else t = block.text || (block.runs || []).map((r) => r.text).join('') || block.url || ''
  t = String(t || '').replace(/\s+/g, ' ').trim()
  return t.length > 80 ? t.slice(0, 77) + '…' : t
}

/**
 * Извлечение встроенных картинок в файлы: у image-блоков data (base64)
 * заменяется на path. Возвращает список { index, path, ext, width, height }.
 * Имена детерминированы (docName-imgN.ext) — повторное чтение перезаписывает.
 * При ошибке записи data всё равно удаляется (base64 не должен попадать в контекст).
 */
function extractImages(blocks, docxPath, imageDir) {
  const dir = imageDir || nodePath.join(os.tmpdir(), 'office-tools-media')
  const base = nodePath.basename(String(docxPath || 'doc')).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'doc'
  const out = []
  let n = 0
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (!b || b.type !== 'image' || !b.data) continue
    n++
    const ext = String(b.ext || 'png').toLowerCase()
    const file = nodePath.join(dir, base + '-img' + n + '.' + ext)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, Buffer.from(b.data, 'base64'))
      b.path = file
      out.push({ index: i, path: file, ext, width: b.width, height: b.height })
    } catch {
      b.note = 'извлечение в файл не удалось'
    }
    delete b.data // base64 никогда не возвращается наружу
  }
  return out
}

/**
 * Чтение .docx. Файл читается напрямую через require('fs').
 * @param {object} [opts] { imageDir } — куда извлекать встроенные картинки
 *   (по умолчанию os.tmpdir()/office-tools-media).
 * @returns {Promise<object|string>} — зависит от mode. В 'full' и 'structure'
 *   картинки — файлами (path), в 'full' добавляется список res.images.
 */
async function readDocument(path, mode, opts) {
  const m = mode || 'structure'
  if (!['structure', 'text', 'full', 'stats'].includes(m)) {
    throw new Error('Неизвестный режим: ' + m + ' (structure | text | full | stats)')
  }
  const buffer = fs.readFileSync(path)

  // Формулы: mammoth выбрасывает m:oMath — заменяем на плейсхолдеры,
  // читаем OMML напрямую и восстанавливаем latex в блоках (roundtrip).
  const math = extractMath(buffer)

  if (m === 'text') {
    const r = await mammoth.extractRawText({ buffer: math.buffer })
    let text = r.value
    if (math.latex.length) {
      text = text.replace(/\u27E6MATH:(\d+)\u27E7/g, (_, i) => ' ' + (math.latex[Number(i)] || '') + ' ')
    }
    return text
  }

  const html = await mammoth.convertToHtml({ buffer: math.buffer })
  const blocks = htmlToBlocks(parseHtml(html.value))
  applyFootnotes(blocks, readFootnotes(buffer))
  applyMath(blocks, math.latex)
  sweepMathText(blocks, math.latex)
  // Картинки → файлы: base64 не должен попадать в контекст AI
  const images = m === 'full' || m === 'structure'
    ? extractImages(blocks, path, opts && opts.imageDir)
    : []
  const page = m === 'full' ? readPageSetup(buffer) : undefined
  const stats = blocksStats(blocks, page)

  if (m === 'stats') return { stats }

  if (m === 'full') {
    // page setup сохраняется для пересборки через word_edit / word_create
    return { spec: { content: blocks, ...(page ? { page } : {}) }, stats, ...(images.length ? { images } : {}) }
  }

  // structure
  const outline = []
  const structBlocks = blocks.map((b, index) => {
    if (b.type === 'heading') outline.push({ level: b.level, text: b.text })
    return { index, type: b.type, preview: previewOf(b) }
  })
  return { outline, blocks: structBlocks, stats }
}

module.exports = { readDocument, htmlToBlocks, parseHtml, blocksStats, readPageSetup, readFootnotes, extractImages }
