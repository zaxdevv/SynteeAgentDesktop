// blocks — построение docx-элементов из блоков спеки (content/header/footer).
// Заголовки, параграфы с runs (включая сноски footnote), списки (bullet/
// numbered/multilevel/numberingId), hyperlink, pageBreak, hr, toc.
// Таблицы и картинки — в tables.js / media.js; cover/bookmark/ref — в extras.js.
//
// Layout-опции (передаются из spec.js, см. settings.layoutDefaults):
//   firstLineIndent — красная строка 709 twips (1.25 см) для body-абзацев;
//   compactLists — компактные отступы списков (360 вместо 720 twips);
//   smartBreaks — keepNext у заголовков, cantSplit у строк таблиц.

const docx = require('docx')
const { runProps, alignType, lineHeightToTwips } = require('./styles')
const { buildTable } = require('./tables')
const { buildImageParagraph } = require('./media')
const { estimatePages } = require('./pagination')
const { buildCover, buildBookmarkParagraph, buildRefParagraph } = require('./extras')
const { latexToMathElement } = require('./math')

const { Paragraph, TextRun, HeadingLevel, AlignmentType, LevelFormat, BorderStyle,
  PageBreak, ExternalHyperlink, TableOfContents, FootnoteReferenceRun } = docx

const FIRST_LINE_TWIPS = 709 // красная строка: 1.25 см

const HEADING_IDS = {
  1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6,
}

const LEVEL_FORMATS = {
  decimal: LevelFormat.DECIMAL, number: LevelFormat.DECIMAL,
  lowerletter: LevelFormat.LOWER_LETTER, loweralpha: LevelFormat.LOWER_LETTER,
  upperletter: LevelFormat.UPPER_LETTER, upperalpha: LevelFormat.UPPER_LETTER,
  lowerroman: LevelFormat.LOWER_ROMAN, upperroman: LevelFormat.UPPER_ROMAN,
  bullet: LevelFormat.BULLET, none: LevelFormat.NONE,
}

const BULLET_CHARS = ['\u25CF', '\u25CB', '\u25A0', '\u25CB', '\u25A0', '\u25CF']
const ORDERED_FORMATS = ['decimal', 'lowerLetter', 'lowerRoman', 'decimal', 'lowerLetter', 'lowerRoman']
const ORDERED_TEXT = ['%1.', '%2)', '%3.', '%4)', '%5.', '%6)']

/**
 * Runs-массив спеки → TextRun[] (style-объекты применяются к каждому run).
 * Run с полем footnote → после него FootnoteReferenceRun (номер из builder).
 * Run с полем math → инлайн-формула (docx Math, LaTeX-синтаксис).
 */
function buildRuns(runs, extraProps, builder) {
  const out = []
  for (const r of runs || []) {
    if (r == null) continue
    if (typeof r === 'string') {
      if (r) out.push(new TextRun({ text: r, ...extraProps }))
      continue
    }
    if (r.math) {
      out.push(latexToMathElement(r.math))
      continue
    }
    if (!r.text && !r.break) continue
    const props = { ...runProps(r.style || {}), ...runProps(r), ...extraProps }
    if (r.break) out.push(new TextRun({ text: r.text || '', break: r.break, ...props }))
    else out.push(new TextRun({ text: String(r.text), ...props }))
    if (r.footnote && builder) {
      out.push(new FootnoteReferenceRun(builder._addFootnote(r.footnote)))
    }
  }
  return out
}

/** Сбор всего текста блока (для stats.words и определения кириллицы). */
function collectText(block, acc) {
  if (!block || typeof block !== 'object') return acc
  if (typeof block.text === 'string') acc.push(block.text)
  if (typeof block.latex === 'string') acc.push(block.latex)
  if (Array.isArray(block.runs)) {
    for (const r of block.runs) {
      if (typeof r === 'string') acc.push(r)
      else if (r && typeof r === 'object') acc.push(r.math || r.text || '')
    }
  }
  if (Array.isArray(block.items)) {
    for (const it of block.items) {
      if (typeof it === 'string') acc.push(it)
      else if (it && typeof it === 'object') acc.push(it.text || '')
    }
  }
  if (Array.isArray(block.rows)) {
    for (const row of block.rows) {
      for (const c of row || []) {
        if (typeof c === 'string') acc.push(c)
        else if (c && typeof c === 'object') {
          if (typeof c.text === 'string') acc.push(c.text)
          if (Array.isArray(c.runs)) for (const r of c.runs) acc.push(typeof r === 'string' ? r : (r && r.text) || '')
        }
      }
    }
  }
  return acc
}

/**
 * Построитель блоков. Накапливает children (docx-элементы), numbering-конфиги
 * (для Document), сноски footnotes, stats и outline. add() асинхронный
 * (картинки читаются с диска).
 */
class BlockBuilder {
  constructor({ ctx, numberingSpec, layout }) {
    this.ctx = ctx || {}
    this.children = []
    this.numberingConfigs = []
    this.footnotes = {} // { [n]: { children: [Paragraph] } } для Document
    this._fnSeq = 0
    this._numberingSpec = numberingSpec || {}
    this._autoListSeq = 0
    this._rawBlocks = [] // сырые блоки — для estimatePages
    this._specPage = null
    this._specStyles = null
    this.stats = { paragraphs: 0, words: 0, tables: 0, images: 0, lists: 0, approxPages: 1 }
    this.outline = []
    this._texts = []
    this.layout = layout || {}
  }

  /** Запомнить page/styles спеки — для точной оценки approxPages. */
  setLayout(spec) {
    this._specPage = (spec && spec.page) || null
    this._specStyles = (spec && spec.styles) || null
  }

  /** Текст сноски → номер (нумерация с 1). */
  _addFootnote(text) {
    const n = ++this._fnSeq
    this.footnotes[n] = { children: [new Paragraph({ children: [new TextRun({ text: String(text) })] })] }
    return n
  }

  _countWords(block) {
    this._texts.push(...collectText(block, []))
  }

  _finishStats() {
    const words = this._texts.join(' ').split(/\s+/).filter(Boolean).length
    this.stats.words = words
    // Контент-ориентированная оценка страниц (pagination.js)
    this.stats.approxPages = estimatePages(this._rawBlocks, {
      page: this._specPage || {},
      styles: this._specStyles || {},
      compactLists: this.layout.compactLists !== false,
    })
  }

  /** numbering-конфиг для списка: кастомный (numberingId) или авто. */
  _listNumbering(block) {
    if (block.numberingId && this._numberingSpec[block.numberingId]) {
      const id = block.numberingId
      if (!this.numberingConfigs.some((c) => c.reference === id)) {
        this.numberingConfigs.push(this._customNumbering(id, this._numberingSpec[id]))
      }
      return { reference: id, instance: 0 }
    }
    const ref = '__list' + ++this._autoListSeq
    this.numberingConfigs.push(
      block.ordered
        ? this._autoNumbering(ref, ORDERED_FORMATS, ORDERED_TEXT)
        : this._autoNumbering(ref, null, null),
    )
    return { reference: ref, instance: 0 }
  }

  _autoNumbering(ref, formats, texts) {
    // Компактные списки: отступ 360*(level+1), иначе 720*(level+1)
    const step = this.layout.compactLists !== false ? 360 : 720
    const levels = []
    for (let i = 0; i < 6; i++) {
      levels.push({
        level: i,
        format: formats ? LEVEL_FORMATS[(formats[i] || 'decimal').toLowerCase()] : LevelFormat.BULLET,
        text: formats ? texts[i] : BULLET_CHARS[i],
        alignment: AlignmentType.START,
        style: { paragraph: { indent: { left: step * (i + 1), hanging: 360 } } },
      })
    }
    return { reference: ref, levels }
  }

  _customNumbering(id, def) {
    const levels = (def && Array.isArray(def.levels) && def.levels.length
      ? def.levels
      : [{ format: def && def.type, text: '%1.', indent: 720 }]
    ).map((l, i) => ({
      level: i,
      format: LEVEL_FORMATS[String(l.format || l.type || 'decimal').toLowerCase()] || LevelFormat.DECIMAL,
      text: l.text || '%1.',
      alignment: alignType(l.alignment) || AlignmentType.START,
      style: { paragraph: { indent: { left: Math.round(Number(l.indent) || 720 * (i + 1)), hanging: 360 } } },
    }))
    return { reference: id, levels }
  }

  /** Красная строка применима к body-абзацу? (не заголовок/список/центр и т.п.) */
  _firstLineApplies(block) {
    if (!this.layout.firstLineIndent) return false
    if (block.indent && block.indent.firstLine !== undefined) return false
    const a = String(block.alignment || '').toLowerCase()
    if (a === 'center' || a === 'right' || a === 'end') return false
    return !!(block.text || (Array.isArray(block.runs) && block.runs.length))
  }

  async add(block) {
    if (!block || typeof block !== 'object') return
    switch (block.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(block.level) || 1))
        const props = { heading: HEADING_IDS[level], ...(block.pageBreakBefore ? { pageBreakBefore: true } : {}) }
        if (block.alignment) props.alignment = alignType(block.alignment)
        // Умные разрывы: не отрывать заголовок от следующего текста и не рвать сам
        if (this.layout.smartBreaks !== false) {
          props.keepNext = true
          props.keepLines = true
        }
        this.children.push(new Paragraph({
          ...props,
          children: block.runs ? buildRuns(block.runs, undefined, this) : [new TextRun({ text: String(block.text || '') })],
        }))
        this.stats.paragraphs++
        this.outline.push({ level, text: String(block.text || '') })
        this._countWords(block)
        break
      }
      case 'paragraph': {
        const base = runProps(block.style || {})
        const p = { children: block.runs ? buildRuns(block.runs, base, this) : [new TextRun({ text: String(block.text || ''), ...base })] }
        if (block.alignment) p.alignment = alignType(block.alignment)
        const sp = {}
        if (block.spacing) {
          if (block.spacing.before !== undefined) sp.before = Math.round(Number(block.spacing.before))
          if (block.spacing.after !== undefined) sp.after = Math.round(Number(block.spacing.after))
          if (block.spacing.line !== undefined) sp.line = Math.round(Number(block.spacing.line))
          else if (block.spacing.lineHeight !== undefined) sp.line = lineHeightToTwips(block.spacing.lineHeight)
          if (Object.keys(sp).length) p.spacing = sp
        }
        if (block.indent) {
          p.indent = {}
          for (const k of ['firstLine', 'left', 'right', 'hanging', 'start', 'end']) {
            if (block.indent[k] !== undefined) p.indent[k] = Math.round(Number(block.indent[k]))
          }
        }
        // Красная строка (если нет явного indent.firstLine)
        if (this._firstLineApplies(block)) {
          p.indent = { firstLine: FIRST_LINE_TWIPS, ...(p.indent || {}) }
        }
        // Сноска в конце абзаца: paragraph.footnote
        if (block.footnote) {
          p.children = [...p.children, new FootnoteReferenceRun(this._addFootnote(block.footnote))]
        }
        if (block.pageBreakBefore) p.pageBreakBefore = true
        this.children.push(new Paragraph(p))
        this.stats.paragraphs++
        this._countWords(block)
        break
      }
      case 'list': {
        const num = this._listNumbering(block)
        const base = runProps(block.style || {})
        for (const item of block.items || []) {
          const it = typeof item === 'string' ? { text: item } : item || {}
          const level = Math.max(0, Math.min(5, Number(it.level) || 0))
          this.children.push(new Paragraph({
            numbering: { reference: num.reference, level, instance: num.instance },
            children: it.runs
              ? buildRuns(it.runs, undefined, this)
              : [new TextRun({ text: String(it.text || ''), ...runProps(it.style || {}), ...base })],
          }))
          this.stats.paragraphs++
          this._countWords({ text: it.text, runs: it.runs })
        }
        this.stats.lists++
        break
      }
      case 'hyperlink': {
        this.children.push(new Paragraph({
          alignment: block.alignment ? alignType(block.alignment) : undefined,
          children: [new ExternalHyperlink({
            link: String(block.url || ''),
            children: [new TextRun({ text: String(block.text || block.url || ''), style: 'Hyperlink' })],
          })],
        }))
        this.stats.paragraphs++
        this._countWords(block)
        break
      }
      case 'math': {
        // Формула (LaTeX → OMML, нативный формат Word Equation Editor).
        // display=true (по умолчанию) — отдельный центрированный абзац,
        // display=false — абзац без выравнивания (в строке слева).
        const el = latexToMathElement(block.latex)
        const p = { children: [el] }
        if (block.display !== false) {
          p.alignment = AlignmentType.CENTER
          p.spacing = { before: 120, after: 120 }
        }
        this.children.push(new Paragraph(p))
        this.stats.paragraphs++
        this._countWords({ text: block.latex })
        break
      }
      case 'table': {
        this.children.push(buildTable(block, this.stats, { smartBreaks: this.layout.smartBreaks !== false }))
        this.stats.tables++
        this._countWords(block)
        break
      }
      case 'image': {
        // stats.images инкрементируется внутри buildImageParagraph (media.js)
        this.children.push(await buildImageParagraph(block, this.ctx, this.stats))
        break
      }
      case 'cover': {
        // Титульная страница (extras.js): параграфы + разрыв страницы
        this.children.push(...(await buildCover(block, this.ctx, this.stats)))
        this._countWords({
          text: [block.title, block.subtitle, block.author, block.date,
            ...(block.meta || []).map((m) => m && m.label ? m.label + ' ' + (m.value || '') : '')]
            .filter(Boolean).join(' '),
        })
        break
      }
      case 'bookmark': {
        this.children.push(buildBookmarkParagraph(block))
        this.stats.paragraphs++
        if (block.text) this._countWords(block)
        break
      }
      case 'ref': {
        this.children.push(buildRefParagraph(block))
        this.stats.paragraphs++
        this._countWords(block)
        break
      }
      case 'pageBreak': {
        this.children.push(new Paragraph({ children: [new PageBreak()] }))
        break
      }
      case 'hr': {
        this.children.push(new Paragraph({
          spacing: { before: 60, after: 60 },
          border: { bottom: { color: 'auto', space: 1, style: BorderStyle.SINGLE, size: 6 } },
        }))
        break
      }
      case 'toc': {
        const levels = Math.min(6, Math.max(1, Number(block.levels) || 3))
        if (block.title) {
          this.children.push(new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: String(block.title) })],
          }))
          this.outline.push({ level: 1, text: String(block.title) })
        }
        this.children.push(new TableOfContents(String(block.title || 'Contents'), {
          hyperlink: true,
          headingStyleRange: '1-' + levels,
        }))
        break
      }
      default:
        throw new Error('Неизвестный тип блока: ' + JSON.stringify(block.type))
    }
  }

  async addMany(blocks) {
    this._rawBlocks = Array.isArray(blocks) ? blocks : []
    for (const b of blocks || []) await this.add(b)
    this._finishStats()
    return this
  }
}

module.exports = { BlockBuilder, buildRuns, collectText, FIRST_LINE_TWIPS }
