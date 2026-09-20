// read — чтение .pptx через adm-zip (без MS Office).
// Режимы: meta | slides | full.
// slides: тексты + заметки по слайдам (компактно для AI).
// full: объекты с позициями (дюймы), таблицы, диаграммы, картинки → в файлы.
//
// Хелперы slideOrder/parseRels используются и в edit.js.

const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')

const EMU_PER_IN = 914400

/** XML-entity decode (&amp; &lt; &gt; &quot; &apos; &#NN;). */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** XML-entity encode для текстовых узлов. */
function encodeEntities(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** rels-XML → Map(rId → { type, target }). target — путь внутри zip (от корня). */
function parseRels(relsXml, baseDir) {
  const map = new Map()
  const re = /<Relationship\b[^>]*>/g
  let m
  while ((m = re.exec(relsXml))) {
    const tag = m[0]
    const id = attr(tag, 'Id')
    const type = attr(tag, 'Type') || ''
    let target = attr(tag, 'Target') || ''
    if (target.startsWith('/')) target = target.slice(1)
    else target = path.posix.normalize(path.posix.join(baseDir, target))
    map.set(id, { type, target, targetMode: attr(tag, 'TargetMode') })
  }
  return map
}

/** Атрибут XML-тега: attr('<p:cNvPr id="2" name="X"/>', 'name') → 'X'. */
function attr(tag, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(tag)
  return m ? decodeEntities(m[1]) : undefined
}

/** Открыть zip и вернуть { zip, presXml, presRels, slidePaths (по порядку!), core }. */
function loadPptx(filePath) {
  const zip = new AdmZip(filePath)
  const presXml = zip.readAsText('ppt/presentation.xml')
  if (!presXml) throw new Error('Не похоже на .pptx: нет ppt/presentation.xml (возможно, старый бинарный .ppt — конвертируй через office_save_as в .pptx)')
  const presRels = parseRels(zip.readAsText('ppt/_rels/presentation.xml.rels') || '', 'ppt')
  const core = zip.readAsText('docProps/core.xml') || ''

  // Порядок слайдов: p:sldIdLst → r:id → rels → slideN.xml
  const slidePaths = []
  const listRe = /<p:sldId\b[^>]*>/g
  let m
  while ((m = listRe.exec(presXml))) {
    const rid = attr(m[0], 'r:id')
    const rel = rid && presRels.get(rid)
    if (rel && rel.type.endsWith('/slide')) slidePaths.push(rel.target)
  }
  // Fallback: если sldIdLst пуст — берём slideN.xml по номерам
  if (!slidePaths.length) {
    const names = zip.getEntries().map((e) => e.entryName).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    names.sort((a, b) => slideNum(a) - slideNum(b))
    slidePaths.push(...names)
  }
  return { zip, presXml, presRels, slidePaths, core }
}

/** 'ppt/slides/slide7.xml' → 7. */
function slideNum(slidePath) {
  const m = /slide(\d+)\.xml$/.exec(slidePath)
  return m ? parseInt(m[1], 10) : 0
}

/** Размер слайда из presentation.xml → { widthIn, heightIn }. */
function slideSize(presXml) {
  const m = /<p:sldSz[^>]*>/.exec(presXml)
  const cx = m ? Number(attr(m[0], 'cx')) : 0
  const cy = m ? Number(attr(m[0], 'cy')) : 0
  return { widthIn: +(cx / EMU_PER_IN).toFixed(2), heightIn: +(cy / EMU_PER_IN).toFixed(2) }
}

/** Скрыт ли слайд: <p:sld show="0">. */
function isHidden(slideXml) {
  const m = /<p:sld\b[^>]*>/.exec(slideXml)
  return !!(m && attr(m[0], 'show') === '0')
}

/** Тексты txBody: массив абзацев (каждый — склейка a:t внутри a:p). */
function txBodyParagraphs(txBodyXml) {
  const paras = []
  const re = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>|<a:p\b[^>]*\/>/g
  let m
  while ((m = re.exec(txBodyXml))) {
    const inner = m[1] || ''
    const texts = []
    const tre = /<a:t>([\s\S]*?)<\/a:t>/g
    let t
    while ((t = tre.exec(inner))) texts.push(decodeEntities(t[1]))
    paras.push(texts.join(''))
  }
  return paras
}

/** Позиция spPr: { x, y, w, h } в дюймах (или null). */
function shapePos(spXml) {
  const spPr = /<p:spPr\b[^>]*\/>|<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/.exec(spXml)
  if (!spPr) return null
  const block = spPr[1] || ''
  const off = /<a:off\b[^>]*>/.exec(block)
  const ext = /<a:ext\b[^>]*>/.exec(block)
  if (!off || !ext) return null
  const x = Number(attr(off[0], 'x'))
  const y = Number(attr(off[0], 'y'))
  const w = Number(attr(ext[0], 'cx'))
  const h = Number(attr(ext[0], 'cy'))
  if (![x, y, w, h].every(Number.isFinite)) return null
  return { x: +(x / EMU_PER_IN).toFixed(2), y: +(y / EMU_PER_IN).toFixed(2), w: +(w / EMU_PER_IN).toFixed(2), h: +(h / EMU_PER_IN).toFixed(2) }
}

/** Все <p:sp>…</p:sp> блоки (включая внутри grpSp). */
function shapeBlocks(xml) {
  const out = []
  const re = /<p:sp>([\s\S]*?)<\/p:sp>/g
  let m
  while ((m = re.exec(xml))) out.push(m[0])
  return out
}

/** Тип плейсхолдера спейпа: 'title' | 'body' | … | undefined. */
function placeholderType(spXml) {
  const m = /<p:ph\b[^>]*\/?>/.exec(spXml)
  return m ? (attr(m[0], 'type') || 'body') : undefined
}

/** Имя фигуры из p:cNvPr. */
function shapeName(spXml) {
  const m = /<p:cNvPr\b[^>]*>/.exec(spXml)
  return m ? attr(m[0], 'name') : undefined
}

/** rels слайда: Map(rId → {type, target}). */
function slideRels(zip, slidePath) {
  const relsPath = slidePath.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')
  return parseRels(zip.readAsText(relsPath) || '', path.posix.dirname(slidePath))
}

/** Заметки слайда: текст body-плейсхолдера notesSlide (или все тексты). */
function readNotes(zip, slidePath, rels) {
  const rel = [...rels.values()].find((r) => r.type.endsWith('/notesSlide'))
  if (!rel) return null
  const xml = zip.readAsText(rel.target)
  if (!xml) return null
  const shapes = shapeBlocks(xml)
  const body = shapes.find((s) => placeholderType(s) === 'body')
  if (body) {
    const tx = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(body)
    if (tx) {
      const paras = txBodyParagraphs(tx[1]).filter((p) => p.trim() !== '')
      if (paras.length) return paras.join('\n')
    }
  }
  const texts = []
  const tre = /<a:t>([\s\S]*?)<\/a:t>/g
  let t
  while ((t = tre.exec(xml))) texts.push(decodeEntities(t[1]))
  return texts.length ? texts.join(' ') : null
}

/** Тип и данные chart XML: { chartType, series: [{ name, values }], categories }. */
function readChart(zip, chartPath) {
  const xml = zip.readAsText(chartPath)
  if (!xml) return null
  const typeMap = {
    barChart: 'bar', lineChart: 'line', pieChart: 'pie', doughnutChart: 'doughnut',
    areaChart: 'area', scatterChart: 'scatter', radarChart: 'radar', bubbleChart: 'bubble',
    bar3DChart: 'bar3d', line3DChart: 'line3d', pie3DChart: 'pie3d', ofPieChart: 'pie',
  }
  let chartType = 'unknown'
  for (const [tag, name] of Object.entries(typeMap)) {
    if (xml.includes('<c:' + tag + '>')) { chartType = name; break }
  }
  let barDir
  const bd = /<c:barDir\s+val="([^"]+)"/.exec(xml)
  if (bd) barDir = bd[1]

  const series = []
  let categories = []
  const serRe = /<c:ser>([\s\S]*?)<\/c:ser>/g
  let s
  while ((s = serRe.exec(xml))) {
    const serXml = s[0]
    const name = /<c:tx>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/.exec(serXml)
    const values = []
    const inner = /<c:val>([\s\S]*?)<\/c:val>/.exec(serXml)
    if (inner) {
      const vr = /<c:v>([\s\S]*?)<\/c:v>/g
      let v
      while ((v = vr.exec(inner[1]))) values.push(Number(v[1]))
    }
    series.push({ name: name ? decodeEntities(name[1]) : 'Series', values })
    // Категории — из первой серии
    if (!categories.length) {
      const cat = /<c:cat>([\s\S]*?)<\/c:cat>/.exec(serXml)
      if (cat) {
        const cr = /<c:v>([\s\S]*?)<\/c:v>/g
        let c
        while ((c = cr.exec(cat[1]))) categories.push(decodeEntities(c[1]))
      }
    }
  }
  return { chartType, ...(barDir ? { barDir } : {}), series, ...(categories.length ? { categories } : {}) }
}

/** Таблица из a:tbl → { rows: [[строка,…]], cols }. */
function readTable(graphicFrameXml) {
  const tbl = /<a:tbl>([\s\S]*?)<\/a:tbl>/.exec(graphicFrameXml)
  if (!tbl) return null
  const rows = []
  const trRe = /<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g
  let r
  while ((r = trRe.exec(tbl[1]))) {
    const cells = []
    const tcRe = /<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g
    let c
    while ((c = tcRe.exec(r[1]))) {
      const texts = []
      const tre = /<a:t>([\s\S]*?)<\/a:t>/g
      let t
      while ((t = tre.exec(c[1]))) texts.push(decodeEntities(t[1]))
      cells.push(texts.join(''))
    }
    rows.push(cells)
  }
  const cols = (tbl[1].match(/<a:gridCol\b/g) || []).length
  return { rows, cols }
}

/** Извлечь картинку media в файл → { index, path }. */
function extractImage(zip, mediaPath, imageDir, slideIdx, imgIdx) {
  const data = zip.readFile(mediaPath)
  if (!data) return null
  const ext = path.posix.extname(mediaPath).slice(1) || 'png'
  if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true })
  const file = path.join(imageDir, 'slide' + slideIdx + '-img' + imgIdx + '.' + ext)
  fs.writeFileSync(file, data)
  return { index: imgIdx, path: file }
}

/** Заголовок слайда: текст title/ctrTitle-плейсхолдера (или самый верхний крупный текст). */
function slideTitle(slideXml) {
  for (const sp of shapeBlocks(slideXml)) {
    const ph = placeholderType(sp)
    if (ph === 'title' || ph === 'ctrTitle') {
      const tx = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(sp)
      if (tx) return txBodyParagraphs(tx[1]).join(' ').trim() || null
    }
  }
  return null
}

/**
 * Чтение .pptx.
 * @param {string} filePath абсолютный путь
 * @param {string} mode 'meta' | 'slides' | 'full'
 * @param {object} [opts] { imageDir } — куда извлекать картинки (full)
 */
function readPresentation(filePath, mode, opts) {
  const m = mode || 'slides'
  const { zip, presXml, slidePaths, core } = loadPptx(filePath)
  const size = slideSize(presXml)

  const coreTitle = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(core)
  const coreAuthor = /<dc:creator>([\s\S]*?)<\/dc:creator>/.exec(core)

  if (m === 'meta') {
    let hidden = 0
    let notes = 0
    const titles = []
    for (const sp of slidePaths) {
      const xml = zip.readAsText(sp)
      if (isHidden(xml)) hidden++
      if (readNotesHas(zip, sp)) notes++
      const t = slideTitle(xml)
      titles.push(t || '')
    }
    return {
      slideCount: slidePaths.length,
      size: size.widthIn + 'x' + size.heightIn + ' in',
      widthIn: size.widthIn,
      heightIn: size.heightIn,
      title: coreTitle ? decodeEntities(coreTitle[1]) : null,
      author: coreAuthor ? decodeEntities(coreAuthor[1]) : null,
      hiddenSlides: hidden,
      slidesWithNotes: notes,
      slideTitles: titles,
    }
  }

  const images = []
  const slides = []

  for (let i = 0; i < slidePaths.length; i++) {
    const slidePath = slidePaths[i]
    const xml = zip.readAsText(slidePath)
    const rels = slideRels(zip, slidePath)
    const entry = {
      index: i + 1,
      hidden: isHidden(xml) || undefined,
      title: slideTitle(xml) || undefined,
      notes: readNotes(zip, slidePath, rels) || undefined,
    }

    if (m === 'slides') {
      // Компактно: тексты всех фигур
      const texts = []
      for (const sp of shapeBlocks(xml)) {
        const ph = placeholderType(sp)
        if (ph === 'sldImg' || ph === 'sldNum' || ph === 'ftr' || ph === 'dt') continue
        const tx = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(sp)
        if (!tx) continue
        const paras = txBodyParagraphs(tx[1]).filter((p) => p !== '')
        if (paras.length) texts.push(paras.join('\n'))
      }
      // Таблицы
      const gfRe = /<p:graphicFrame>([\s\S]*?)<\/p:graphicFrame>/g
      let gf
      while ((gf = gfRe.exec(xml))) {
        const tbl = readTable(gf[0])
        if (tbl) texts.push('[таблица ' + tbl.rows.length + 'x' + tbl.cols + ']')
      }
      if (texts.length) entry.texts = texts
      slides.push(entry)
      continue
    }

    // ── full: объекты с позициями ──
    const objects = []
    let imgIdx = 0

    for (const sp of shapeBlocks(xml)) {
      const ph = placeholderType(sp)
      const kind = ph ? 'placeholder:' + ph : 'shape'
      const tx = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(sp)
      const paras = tx ? txBodyParagraphs(tx[1]).filter((p) => p !== '') : []
      const obj = {
        kind,
        name: shapeName(sp) || undefined,
        ...shapePos(sp),
      }
      if (paras.length) obj.text = paras.join('\n')
      if (!obj.text && kind === 'shape') continue // пустые декоративные фигуры без текста пропускаем
      objects.push(obj)
    }

    // Картинки и медиа (видео/аудио тоже в p:pic — различаем по videoFile/audioFile)
    const picRe = /<p:pic>([\s\S]*?)<\/p:pic>/g
    let pic
    while ((pic = picRe.exec(xml))) {
      imgIdx++
      const isVideo = /<a:videoFile\b/.test(pic[0])
      const isAudio = /<a:audioFile\b/.test(pic[0])
      if (isVideo || isAudio) {
        objects.push({ kind: isVideo ? 'video' : 'audio', name: shapeName(pic[0]) || undefined, ...shapePos(pic[0]) })
        continue
      }
      const blip = /<a:blip\b[^>]*>/.exec(pic[0])
      const rid = blip ? attr(blip[0], 'r:embed') : undefined
      const rel = rid && rels.get(rid)
      const obj = { kind: 'image', name: shapeName(pic[0]) || undefined, ...shapePos(pic[0]) }
      if (rel && rel.type.endsWith('/image')) {
        if (opts && opts.imageDir) {
          const ex = extractImage(zip, rel.target, opts.imageDir, i + 1, imgIdx)
          if (ex) { images.push(ex); obj.path = ex.path }
        }
        obj.media = rel.target.split('/').pop()
      }
      objects.push(obj)
    }

    // graphicFrame: таблицы и диаграммы
    const gfRe = /<p:graphicFrame>([\s\S]*?)<\/p:graphicFrame>/g
    let gf
    while ((gf = gfRe.exec(xml))) {
      const frameXml = gf[0]
      const pos = shapePos(frameXml)
      const chartRef = /<c:chart\b[^>]*>/.exec(frameXml)
      if (chartRef) {
        const rid = attr(chartRef[0], 'r:id')
        const rel = rid && rels.get(rid)
        const obj = { kind: 'chart', name: shapeName(frameXml) || undefined, ...pos }
        if (rel && rel.type.endsWith('/chart')) {
          const ch = readChart(zip, rel.target)
          if (ch) Object.assign(obj, ch)
        }
        objects.push(obj)
      } else {
        const tbl = readTable(frameXml)
        if (tbl) {
          objects.push({ kind: 'table', name: shapeName(frameXml) || undefined, ...pos, rows: tbl.rows, cols: tbl.cols })
        }
      }
    }

    entry.objects = objects
    slides.push(entry)
  }

  const res = { slideCount: slidePaths.length, size, slides }
  if (images.length) res.images = images
  return res
}

/** Есть ли заметки у слайда (для meta). */
function readNotesHas(zip, slidePath) {
  const rels = slideRels(zip, slidePath)
  return [...rels.values()].some((r) => r.type.endsWith('/notesSlide'))
}

module.exports = {
  readPresentation,
  loadPptx,
  parseRels,
  slideRels,
  slideNum,
  slideSize,
  isHidden,
  shapeBlocks,
  shapePos,
  placeholderType,
  shapeName,
  txBodyParagraphs,
  readNotes,
  readChart,
  readTable,
  decodeEntities,
  encodeEntities,
  attr,
}
