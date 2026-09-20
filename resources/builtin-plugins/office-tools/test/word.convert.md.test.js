// word.convert.md.test.js — конвертация .docx → Markdown / txt (lib/word/md.js).
// Документ собирается buildDocument с заголовком, жирным текстом, списком и таблицей.
// Запуск: node test/word.convert.md.test.js (cwd = папка плагина)

const fs = require('fs')
const path = require('path')
const mammoth = require('mammoth')
const { buildDocument } = require('../dist/lib/word/spec')
const { docxToMarkdown, docxToText } = require('../dist/lib/word/md')

const TMP = path.join(__dirname, '.tmp')
const DOCX = path.join(TMP, 'word-convert-md.docx')

let failures = 0
function check(name, cond, extra) {
  if (cond) {
    console.log('  ok  ' + name)
  } else {
    failures++
    console.error('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''))
  }
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true })

  console.log('[1] сборка документа с заголовком/жирным/списком/таблицей')
  const built = await buildDocument({
    content: [
      { type: 'heading', level: 1, text: 'Конвертация в Markdown' },
      { type: 'paragraph', runs: [
        { text: 'Обычный текст, ' },
        { text: 'жирный фрагмент', bold: true },
        { text: ' и ' },
        { text: 'курсив', italic: true },
      ] },
      { type: 'list', ordered: false, items: ['первый пункт', 'второй пункт'] },
      {
        type: 'table',
        header: true,
        rows: [
          [{ text: 'Колонка A' }, { text: 'Колонка B' }],
          [{ text: 'значение 1' }, { text: 'значение 2' }],
        ],
      },
      { type: 'hyperlink', text: 'Сайт docx', url: 'https://docx.js.org/' },
      { type: 'pageBreak' },
      { type: 'heading', level: 2, text: 'После разрыва' },
    ],
  }, {})
  fs.writeFileSync(DOCX, built.buffer)
  check('docx собран', built.buffer.length > 1000, built.buffer.length)

  console.log('[2] docxToMarkdown')
  const md = await docxToMarkdown(DOCX)
  check('md — строка', typeof md === 'string' && md.length > 50, typeof md)
  check('md: заголовок h1 (# )', /(^|\n)# Конвертация в Markdown/.test(md), md.slice(0, 120))
  check('md: жирный (**)', md.includes('**жирный фрагмент**'), md)
  check('md: курсив (*)', md.includes('*курсив*'), md)
  check('md: список (- )', /(^|\n)- первый пункт/.test(md) && /(^|\n)- второй пункт/.test(md), md)
  check('md: таблица (|)', md.includes('| Колонка A | Колонка B |'), md)
  check('md: разделитель таблицы (---)', /\| --- \| --- \|/.test(md), md)
  check('md: ссылка [text](url)', md.includes('[Сайт docx](https://docx.js.org/)'), md)
  // mammoth не отдаёт разрывы страниц в html — маппинг pageBreak проверяем напрямую
  const { blockMd } = require('../dist/lib/word/md')
  check('md: pageBreak → ---', blockMd({ type: 'pageBreak' }) === '---', blockMd({ type: 'pageBreak' }))
  check('md: заголовок h2 (## )', /(^|\n)## После разрыва/.test(md), md)

  console.log('[3] docxToText')
  const txt = await docxToText(DOCX)
  check('txt: содержит заголовок', txt.includes('Конвертация в Markdown'), txt.slice(0, 100))
  check('txt: содержит текст параграфа', txt.includes('жирный фрагмент') && txt.includes('курсив'))
  check('txt: содержит пункт списка', txt.includes('первый пункт'))
  check('txt: содержит ячейку таблицы', txt.includes('значение 1'))

  console.log('[4] html-цепочка (как в tools/convert.js)')
  const html = await mammoth.convertToHtml({ path: DOCX })
  check('html: <h1>', html.value.includes('<h1>'), html.value.slice(0, 100))
  check('html: <strong>', html.value.includes('<strong>'))
  check('html: <table>', html.value.includes('<table>'))

  if (failures) {
    console.error('\nFAILED: ' + failures + ' проверок не прошло')
    process.exit(1)
  }
  console.log('\nPASSED: все проверки word.convert.md.test.js прошли')
}

if (require.main === module) {
  main().catch((e) => {
    console.error('TEST ERROR:', e)
    process.exit(1)
  })
}

module.exports = {}
