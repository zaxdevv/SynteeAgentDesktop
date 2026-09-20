// word.test.js — генерация .docx со ВСЕМИ фичами спеки + чтение обратно.
// Запуск: node test/word.test.js (cwd = папка плагина)

const fs = require('fs')
const path = require('path')
const { buildDocument } = require('../dist/lib/word/spec')
const { readDocument } = require('../dist/lib/word/read')
const { pngSize } = require('../dist/lib/word/media')

const TMP_DIR = path.join(__dirname, '.tmp')
const TEST_DOCX = path.join(TMP_DIR, 'word-test.docx')

// 1x1 PNG (захардкожен)
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let failures = 0
function check(name, cond, extra) {
  if (cond) {
    console.log('  ok  ' + name)
  } else {
    failures++
    console.error('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''))
  }
}

/** Спека, покрывающая все возможности формата. */
function buildTestSpec() {
  return {
    page: {
      size: 'A4',
      orientation: 'portrait',
      margins: { top: 2, right: 1.5, bottom: 2, left: 3 },
    },
    styles: {
      default: { font: 'Calibri', size: 22, color: '1F1F1F', lineHeight: 1.15, spacingAfter: 160 },
      heading1: { font: 'Calibri', size: 32, bold: true, color: '2E74B5', spacingBefore: 240, spacingAfter: 120 },
      heading2: { size: 26, bold: true, color: '2E74B5' },
    },
    numbering: {
      testlist: {
        type: 'decimal',
        levels: [
          { format: 'decimal', text: '%1.', alignment: 'start', indent: 720 },
          { format: 'lowerLetter', text: '%2)', alignment: 'start', indent: 1080 },
        ],
      },
    },
    header: { blocks: [{ type: 'paragraph', text: 'Office Tools — тестовый документ', alignment: 'right' }] },
    footer: {
      blocks: [{ type: 'paragraph', text: 'стр.', alignment: 'left' }],
      pageNumber: { alignment: 'center', start: 1 },
    },
    content: [
      { type: 'heading', level: 1, text: 'Тестовый документ' },
      { type: 'heading', level: 2, text: 'Стили текста' },
      {
        type: 'paragraph',
        runs: [
          { text: 'Обычный ', },
          { text: 'жирный ', bold: true },
          { text: 'курсив ', italic: true },
          { text: 'подчёркнутый ', underline: { type: 'double' } },
          { text: 'зачёркнутый ', strike: true },
          { text: 'нижний ', subscript: true },
          { text: 'верхний ', superscript: true },
          { text: 'шрифт ', font: 'Times New Roman', size: 28, color: 'FF0000' },
          { text: 'маркер ', highlight: 'yellow' },
          { text: 'КАПС', allCaps: true },
        ],
      },
      {
        type: 'paragraph',
        text: 'Абзац с выравниванием, отступами и межстрочным интервалом.',
        alignment: 'justify',
        spacing: { before: 120, after: 120, line: 276 },
        indent: { firstLine: 720, left: 360 },
        style: { italic: true, color: '333333' },
      },
      { type: 'hyperlink', text: 'Документация docx', url: 'https://docx.js.org/' },
      { type: 'heading', level: 2, text: 'Списки' },
      { type: 'list', ordered: false, items: ['первый пункт', 'второй пункт', 'третий пункт'] },
      {
        type: 'list',
        ordered: true,
        items: [
          { text: 'уровень 1', level: 0 },
          { text: 'уровень 2', level: 1 },
          { text: 'уровень 3', level: 2 },
        ],
      },
      { type: 'list', ordered: true, numberingId: 'testlist', items: ['кастомный A', 'кастомный B'] },
      { type: 'heading', level: 2, text: 'Таблица' },
      {
        type: 'table',
        header: true,
        style: 'light-shading',
        columnWidths: [4, 6, 3],
        width: 100,
        borders: { style: 'single', size: 4, color: 'auto' },
        align: 'center',
        rows: [
          [{ text: 'Колонка 1' }, { text: 'Колонка 2' }, { text: 'Колонка 3' }],
          [
            { text: 'объединённая ячейка', colspan: 2, fill: 'DEEBF7', align: 'center', verticalAlign: 'center' },
            { text: 'B2', rowspan: 2, bold: true },
          ],
          [{ text: 'A3', color: '333333' }, { text: 'B3', italic: true }],
        ],
      },
      { type: 'heading', level: 2, text: 'Картинка и разметка' },
      { type: 'image', data: PNG_1X1, ext: 'png', width: 96, height: 96, alignment: 'center' },
      { type: 'hr' },
      { type: 'hyperlink', text: 'Ссылка после разделителя', url: 'https://example.com/after-hr' },
      { type: 'pageBreak' },
      { type: 'heading', level: 2, text: 'Содержание' },
      { type: 'toc', title: 'Оглавление', levels: 3 },
      { type: 'paragraph', text: 'Конец документа. Финальный абзац после оглавления.' },
    ],
  }
}

async function main() {
  console.log('[1] сборка документа')
  fs.mkdirSync(TMP_DIR, { recursive: true })
  const spec = buildTestSpec()
  const ctx = {
    async readImage(p) {
      return { base64: fs.readFileSync(p).toString('base64'), ext: path.extname(p).slice(1) }
    },
  }
  const built = await buildDocument(spec, ctx)
  fs.writeFileSync(TEST_DOCX, built.buffer)

  // --- Проверки сборки ---
  check('возвращён Buffer', Buffer.isBuffer(built.buffer) && built.buffer.length > 1000, built.buffer.length)
  check('валидный zip (PK\\x03\\x04)', built.buffer[0] === 0x50 && built.buffer[1] === 0x4b)
  check('stats.paragraphs = 19', built.stats.paragraphs === 19, built.stats)
  check('stats.tables = 1', built.stats.tables === 1)
  check('stats.images = 1', built.stats.images === 1)
  check('stats.lists = 3', built.stats.lists === 3)
  check('stats.words > 30', built.stats.words > 30, built.stats.words)
  check('stats.approxPages >= 1', built.stats.approxPages >= 1)
  // 6 заголовков контента + заголовок "Оглавление" перед TOC
  check('outline: 7 заголовков', built.outline.length === 7, built.outline)
  check('outline[0] = h1', built.outline[0].level === 1 && built.outline[0].text === 'Тестовый документ')

  // --- sniffing размеров PNG ---
  check('pngSize(1x1) = [1,1]', JSON.stringify(pngSize(Buffer.from(PNG_1X1, 'base64'))) === '[1,1]')

  console.log('[2] чтение: mode=structure')
  const st = await readDocument(TEST_DOCX, 'structure')
  check('structure.outline >= 6 заголовков', st.outline.length >= 6, st.outline)
  check('structure.outline[0].text', st.outline[0] && st.outline[0].text === 'Тестовый документ', st.outline[0])
  check('structure.blocks — массив с типами', Array.isArray(st.blocks) && st.blocks.length >= 15, st.blocks.length)
  check('structure.blocks[0].type = heading', st.blocks[0] && st.blocks[0].type === 'heading')
  const types = new Set(st.blocks.map((b) => b.type))
  check('есть блоки table/list/image/hyperlink',
    types.has('table') && types.has('list') && types.has('image') && types.has('hyperlink'), [...types])
  check('structure.stats.tables = 1', st.stats.tables === 1, st.stats)
  check('structure.stats.images = 1', st.stats.images === 1, st.stats)
  // mammoth склеивает соседние однотипные списки → 2 вместо 3
  check('structure.stats.lists = 2 (mammoth merge)', st.stats.lists === 2, st.stats)

  console.log('[3] чтение: mode=text')
  const text = await readDocument(TEST_DOCX, 'text')
  check('text — строка', typeof text === 'string')
  check('text содержит заголовок', text.includes('Тестовый документ'))
  check('text содержит жирный run', text.includes('жирный'))
  check('text содержит ячейку таблицы', text.includes('объединённая ячейка'))
  check('text содержит пункт списка', text.includes('кастомный A'))
  check('text содержит финальный абзац', text.includes('Конец документа'))

  console.log('[4] чтение: mode=stats')
  const statsOnly = await readDocument(TEST_DOCX, 'stats')
  check('stats.tables = 1', statsOnly.stats.tables === 1, statsOnly.stats)
  check('stats.words > 30', statsOnly.stats.words > 30, statsOnly.stats)
  console.log('[5] чтение: mode=full')
  const full = await readDocument(TEST_DOCX, 'full')
  const content = full.spec.content
  check('full.spec.content — массив', Array.isArray(content) && content.length >= 15, content.length)
  const fullTypes = new Set(content.map((b) => b.type))
  check('full: есть heading/paragraph/list/table/image/hyperlink',
    ['heading', 'paragraph', 'list', 'table', 'image', 'hyperlink'].every((t) => fullTypes.has(t)), [...fullTypes])
  const readList = content.find((b) => b.type === 'list' && b.items.some((i) => i.level === 2))
  check('full: многоуровневый список сохранён (level 2)', !!readList, readList)
  const readRuns = content.find((b) => b.type === 'paragraph' && Array.isArray(b.runs))
  check('full: styled runs распознаны (bold/italic)', !!readRuns && readRuns.runs.some((r) => r.bold || r.italic), readRuns)

  // --- Картинки извлекаются в файлы, base64 не возвращается (регрессия контекста) ---
  const imgBlock = content.find((b) => b.type === 'image')
  check('full: у image-блока есть path', !!imgBlock && typeof imgBlock.path === 'string' && imgBlock.path.length > 0, imgBlock)
  check('full: у image-блока НЕТ base64 data', !!imgBlock && imgBlock.data === undefined, imgBlock && { data: imgBlock.data && imgBlock.data.slice(0, 30) })
  check('full: файл картинки существует на диске', !!imgBlock && fs.existsSync(imgBlock.path), imgBlock && imgBlock.path)
  check('full: файл картинки не пустой', !!imgBlock && fs.statSync(imgBlock.path).size > 50, imgBlock && imgBlock.path)
  check('full: res.images — список с path', Array.isArray(full.images) && full.images.length === 1 && full.images[0].path === imgBlock.path, full.images)
  check('full: JSON результата без base64 (компактен)', JSON.stringify(full).length < 30000, JSON.stringify(full).length)
  // structure-превью тоже показывает путь
  const stImg = st.blocks.find((b) => b.type === 'image')
  check('structure: превью картинки содержит путь', !!stImg && stImg.preview.includes('→'), stImg && stImg.preview)

  // --- Пересборка full-спеки (round-trip) ---
  console.log('[6] round-trip: пересборка full-спеки')
  const rebuilt = await buildDocument(full.spec, ctx)
  const RT = path.join(TMP_DIR, 'word-roundtrip.docx')
  fs.writeFileSync(RT, rebuilt.buffer)
  check('round-trip: валидный zip', rebuilt.buffer[0] === 0x50 && rebuilt.buffer[1] === 0x4b)
  check('round-trip: картинка пересобрана из файла (images = 1)', rebuilt.stats.images === 1, rebuilt.stats)
  const rtText = await readDocument(RT, 'text')
  check('round-trip: текст совпадает по ключевым фрагментам',
    rtText.includes('Тестовый документ') && rtText.includes('объединённая ячейка') && rtText.includes('кастомный A'))

  if (failures) {
    console.error('\nFAILED: ' + failures + ' проверок не прошло')
    process.exit(1)
  }
  console.log('\nPASSED: все проверки word.test.js прошли')
}

if (require.main === module) {
  main().catch((e) => {
    console.error('TEST ERROR:', e)
    process.exit(1)
  })
}

module.exports = { buildTestSpec, TMP_DIR, TEST_DOCX, PNG_1X1 }
