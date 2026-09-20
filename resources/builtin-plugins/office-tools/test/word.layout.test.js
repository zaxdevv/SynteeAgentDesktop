// word.layout.test.js — layout-фичи сборки: дефолтные поля, красная строка,
// компактные списки, умные разрывы, cover/bookmark/ref/footnotes, watermark,
// колонтитулы first/even/odd, approxPages. Проверки — по XML внутри .docx.
// Запуск: node test/word.layout.test.js (cwd = папка плагина)

const { buildDocument } = require('../dist/lib/word/spec')
const { estimatePages } = require('../dist/lib/word/pagination')
const AdmZip = require('adm-zip')

const GOST = { top: 2, right: 1.5, bottom: 2, left: 3 }
const DEFAULTS = { margins: GOST, firstLineIndent: 'auto', compactLists: true, smartBreaks: true }

let failures = 0
function check(name, cond, extra) {
  if (cond) {
    console.log('  ok  ' + name)
  } else {
    failures++
    console.error('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''))
  }
}

async function build(spec, defaults) {
  return buildDocument(spec, { defaults })
}

function docXml(buf) {
  return new AdmZip(buf).readAsText('word/document.xml')
}

function readEntry(buf, name) {
  return new AdmZip(buf).readAsText(name)
}

async function main() {
  console.log('[1] дефолтные поля ГОСТ (margins не заданы)')
  const d1 = await build({ content: [{ type: 'paragraph', text: 'x' }] }, DEFAULTS)
  const x1 = docXml(d1.buffer)
  check('w:pgMar w:left="1701"', x1.includes('w:left="1701"'), 'left=3см')
  check('w:pgMar w:top="1134"', x1.includes('w:top="1134"'), 'top=2см')

  console.log('[2] spec.margins выигрывает у дефолтов')
  const d2 = await build({
    page: { margins: { top: 1, right: 1, bottom: 1, left: 1 } },
    content: [{ type: 'paragraph', text: 'x' }],
  }, DEFAULTS)
  const x2 = docXml(d2.buffer)
  check('w:pgMar w:left="567" (спека)', x2.includes('w:left="567"') && !x2.includes('w:left="1701"'))

  console.log('[3] красная строка (auto/on/off)')
  const ruPara = { type: 'paragraph', text: 'Привет мир, это русский текст для проверки красной строки в абзаце.' }
  const enPara = { type: 'paragraph', text: 'Hello world this is english text for first line indent check.' }
  const ru = docXml((await build({ content: [ruPara] }, DEFAULTS)).buffer)
  check('auto + русский → w:ind w:firstLine="709"', ru.includes('w:firstLine="709"'))
  const en = docXml((await build({ content: [enPara] }, DEFAULTS)).buffer)
  check('auto + английский → нет firstLine', !en.includes('w:firstLine="709"'))
  const off = docXml((await build(
    { content: [ruPara] },
    { ...DEFAULTS, firstLineIndent: 'off' },
  )).buffer)
  check('off + русский → нет firstLine', !off.includes('w:firstLine="709"'))
  const onEn = docXml((await build(
    { content: [enPara] },
    { ...DEFAULTS, firstLineIndent: 'on' },
  )).buffer)
  check('on + английский → firstLine="709"', onEn.includes('w:firstLine="709"'))
  const centered = docXml((await build(
    { content: [{ ...ruPara, alignment: 'center' }] }, DEFAULTS,
  )).buffer)
  check('alignment=center → нет firstLine', !centered.includes('w:firstLine="709"'))

  console.log('[4] компактные списки')
  const d4 = await build({ content: [{ type: 'list', ordered: true, items: ['a', 'b'] }] }, DEFAULTS)
  const num = readEntry(d4.buffer, 'word/numbering.xml')
  check('compact: w:ind w:left="360" (level 0)', num.includes('w:left="360"'))
  const d4b = await build(
    { content: [{ type: 'list', ordered: true, items: ['a', 'b'] }] },
    { ...DEFAULTS, compactLists: false },
  )
  const numB = readEntry(d4b.buffer, 'word/numbering.xml')
  check('не-compact: w:left="720"', numB.includes('w:left="720"'))

  console.log('[5] умные разрывы: заголовки keepNext')
  const d5 = await build({ content: [{ type: 'heading', level: 1, text: 'H' }] }, DEFAULTS)
  check('w:keepNext в document.xml', docXml(d5.buffer).includes('w:keepNext'))
  const d5b = await build(
    { content: [{ type: 'heading', level: 1, text: 'H' }] },
    { ...DEFAULTS, smartBreaks: false },
  )
  check('smartBreaks=false → нет keepNext', !docXml(d5b.buffer).includes('w:keepNext'))

  console.log('[6] таблицы: cantSplit')
  const tbl = { type: 'table', rows: [['a', 'b'], ['c', 'd']] }
  const d6 = docXml((await build({ content: [tbl] }, DEFAULTS)).buffer)
  check('w:cantSplit в w:trPr', /<w:trPr>[^<]*<w:cantSplit/.test(d6) || d6.includes('<w:cantSplit'))
  const d6b = docXml((await build(
    { content: [{ ...tbl, allowSplit: true }] }, DEFAULTS,
  )).buffer)
  check('allowSplit=true → нет cantSplit', !d6b.includes('<w:cantSplit'))

  console.log('[7] cover / bookmark / ref / footnotes')
  const d7 = await build({
    content: [
      { type: 'cover', title: 'Отчёт', subtitle: 'по практике', author: 'И. Иванов', date: '2026', meta: [{ label: 'Группа', value: '101' }] },
      { type: 'bookmark', id: 'intro', text: 'Введение' },
      { type: 'ref', bookmark: 'intro', text: 'см. Введение' },
      { type: 'paragraph', text: 'Текст со сноской в абзаце.', footnote: 'абзацная сноска' },
      { type: 'paragraph', runs: [{ text: 'Run со сноской.', footnote: 'run-сноска' }] },
    ],
  }, { ...DEFAULTS, firstLineIndent: 'off' })
  const zip7 = new AdmZip(d7.buffer)
  check('cover/bookmark/ref/footnote строятся без ошибок', d7.buffer.length > 1000)
  check('stats.paragraphs учтён (cover + блоки)', d7.stats.paragraphs >= 5, d7.stats.paragraphs)
  check('outline не содержит cover', d7.outline.length === 0, d7.outline)
  const fnXml = readEntry(d7.buffer, 'word/footnotes.xml')
  check('word/footnotes.xml существует', !!fnXml)
  check('footnotes.xml содержит тексты сносок',
    fnXml.includes('абзацная сноска') && fnXml.includes('run-сноска'))
  const x7 = docXml(d7.buffer)
  check('document.xml: закладка intro', x7.includes('w:name="intro"'))
  check('document.xml: ссылка на якорь intro', x7.includes('w:anchor="intro"'))

  console.log('[8] watermark')
  const d8 = await build({
    page: { watermark: { text: 'ЧЕРНОВИК', color: 'C0C0C0', opacity: 0.4 } },
    content: [{ type: 'paragraph', text: 'Текст с водяным знаком.' }],
  }, DEFAULTS)
  const zip8 = new AdmZip(d8.buffer)
  const headerEntries = zip8.getEntries().filter((e) => /^word\/header\d+\.xml$/.test(e.entryName))
  check('есть headerN.xml', headerEntries.length >= 1, headerEntries.map((e) => e.entryName))
  const wmXml = headerEntries.map((e) => e.getData().toString('utf-8')).join('\n')
  check('v:shape в header', wmXml.includes('v:shape'))
  check('текст watermark в header', wmXml.includes('ЧЕРНОВИК'))
  // watermark при заданном header — VML первым элементом
  const d8b = await build({
    page: { watermark: { text: 'DRAFT' } },
    header: { blocks: [{ type: 'paragraph', text: 'header text' }] },
    content: [{ type: 'paragraph', text: 'x' }],
  }, DEFAULTS)
  const wmB = new AdmZip(d8b.buffer).getEntries()
    .filter((e) => /^word\/header\d+\.xml$/.test(e.entryName))
    .map((e) => e.getData().toString('utf-8')).join('\n')
  check('watermark + заданный header сосуществуют', wmB.includes('v:shape') && wmB.includes('header text'))

  console.log('[9] колонтитулы first/even/odd')
  const hf = (t) => ({ blocks: [{ type: 'paragraph', text: t }] })
  const d9 = await build({
    page: { differentFirstPage: true, evenAndOdd: true },
    header: { default: hf('hdr-default'), first: hf('hdr-first'), even: hf('hdr-even') },
    footer: { default: hf('ftr-default'), first: hf('ftr-first'), even: hf('ftr-even') },
    content: [{ type: 'paragraph', text: 'x' }],
  }, DEFAULTS)
  const x9 = docXml(d9.buffer)
  check('w:titlePg в sectPr', x9.includes('w:titlePg'))
  const zip9 = new AdmZip(d9.buffer)
  const hdrCount = zip9.getEntries().filter((e) => /^word\/header\d+\.xml$/.test(e.entryName)).length
  check('3 header-файла при full формате', hdrCount === 3, hdrCount)
  const ftrCount = zip9.getEntries().filter((e) => /^word\/footer\d+\.xml$/.test(e.entryName)).length
  check('3 footer-файла при full формате', ftrCount === 3, ftrCount)
  const settings9 = readEntry(d9.buffer, 'word/settings.xml')
  check('evenAndOddHeaders в settings.xml', settings9.includes('evenAndOddHeaders'))
  // Обратная совместимость: header: { blocks } = default
  const d9b = await build({
    header: hf('legacy'),
    content: [{ type: 'paragraph', text: 'x' }],
  }, DEFAULTS)
  const hdrB = new AdmZip(d9b.buffer).getEntries()
    .filter((e) => /^word\/header\d+\.xml$/.test(e.entryName))
    .map((e) => e.getData().toString('utf-8')).join('\n')
  check('старый формат header: { blocks } работает', hdrB.includes('legacy'))

  console.log('[10] approxPages')
  // ~3 страницы текста: A4, поля ГОСТ, ~11pt (≈81 символ/строку, ≈57 строк/стр.)
  const longText = 'слово '.repeat(80).trim() // ~480 символов ≈ 6 строк на абзац
  const bigSpec = {
    page: { margins: GOST },
    content: Array.from({ length: 28 }, () => ({ type: 'paragraph', text: longText })),
  }
  const d10 = await build(bigSpec, DEFAULTS)
  check('3 страницы текста → 2..4', d10.stats.approxPages >= 2 && d10.stats.approxPages <= 4, d10.stats.approxPages)
  const d10b = await build({ content: [{ type: 'paragraph', text: 'Один абзац.' }] }, DEFAULTS)
  check('1 абзац → 1 страница', d10b.stats.approxPages === 1, d10b.stats.approxPages)
  // estimatePages напрямую: pageBreak выравнивает на границу страницы
  const est = estimatePages(
    [{ type: 'paragraph', text: longText }, { type: 'pageBreak' }, { type: 'paragraph', text: longText }],
    { page: { margins: GOST } },
  )
  check('estimatePages: pageBreak → 2', est === 2, est)

  if (failures) {
    console.error('\nFAILED: ' + failures + ' проверок не прошло')
    process.exit(1)
  }
  console.log('\nPASSED: все проверки word.layout.test.js прошли')
}

main().catch((e) => {
  console.error('TEST ERROR:', e)
  process.exit(1)
})
