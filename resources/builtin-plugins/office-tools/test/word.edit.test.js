// word.edit.test.js — применение ops (append_blocks, replace_text,
// insert_table, set_style, delete_block) к .docx и проверка чтением.
// Запуск: node test/word.edit.test.js (cwd = папка плагина)

const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const { buildDocument } = require('../dist/lib/word/spec')
const { readDocument } = require('../dist/lib/word/read')
const { applyOps } = require('../dist/lib/word/edit')
const { buildTestSpec, TMP_DIR, PNG_1X1 } = require('./word.test')

/** Текст entry (word/document.xml и т.п.) из .docx. */
function xmlOf(docxPath, entry) {
  return new AdmZip(docxPath).readAsText(entry)
}

/** Поддерживает ли текущая build-часть watermark (v:shape в header*.xml). */
async function watermarkSupported() {
  const b = await buildDocument(
    { page: { watermark: { text: 'тест' } }, content: [{ type: 'paragraph', text: 'x' }] }, {},
  )
  const zip = new AdmZip(b.buffer)
  const headerXml = zip.getEntries()
    .filter((e) => /^word\/header\d*\.xml$/.test(e.entryName))
    .map((e) => zip.readAsText(e))
    .join('')
  return headerXml.includes('v:shape')
}

const EDIT_DOCX = path.join(TMP_DIR, 'word-edit.docx')

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
  fs.mkdirSync(TMP_DIR, { recursive: true })

  console.log('[1] создание исходного документа')
  const built = await buildDocument(buildTestSpec(), {})
  fs.writeFileSync(EDIT_DOCX, built.buffer)
  const before = await readDocument(EDIT_DOCX, 'structure')
  check('исходник: 1 таблица', before.stats.tables === 1, before.stats)
  const beforeBlocks = before.blocks.length

  console.log('[2] applyOps: append_blocks + replace_text + insert_table + set_style + delete_block')
  const res = await applyOps(EDIT_DOCX, [
    {
      op: 'append_blocks',
      blocks: [
        { type: 'heading', level: 2, text: 'Приложение после правки' },
        { type: 'paragraph', text: 'Дописанный абзац через word_edit.' },
      ],
    },
    { op: 'replace_text', find: 'Конец документа', replace: 'Финал документа' },
    {
      op: 'insert_table',
      after: 1,
      table: {
        header: true,
        style: 'table-grid',
        rows: [
          [{ text: 'Новая' }, { text: 'таблица' }],
          [{ text: 'x', fill: 'FFF2CC' }, { text: 'y' }],
        ],
      },
    },
    { op: 'set_style', index: 1, style: { bold: true, color: 'C00000' } },
    { op: 'delete_block', index: 3 },
  ])

  check('applied: 5 строк', Array.isArray(res.applied) && res.applied.length === 5, res.applied)
  check('applied[0] append_blocks', /append_blocks: \+2/.test(res.applied[0]), res.applied[0])
  check('applied[1] replace_text: 1 замена', /replace_text .*: 1 замен/.test(res.applied[1]), res.applied[1])
  check('applied[2] insert_table', /insert_table/.test(res.applied[2]), res.applied[2])
  check('res.stats.tables = 2', res.stats.tables === 2, res.stats)
  check('res.outline содержит новый заголовок',
    res.outline.some((h) => h.text === 'Приложение после правки'), res.outline)

  console.log('[3] проверка результата чтением')
  const text = await readDocument(EDIT_DOCX, 'text')
  check('текст: замена применена', text.includes('Финал документа'), text.slice(-200))
  check('текст: старой фразы нет', !text.includes('Конец документа'))
  check('текст: дописанный абзац есть', text.includes('Дописанный абзац через word_edit.'))
  check('текст: новая таблица читается', text.includes('Новая') && text.includes('таблица'))

  const after = await readDocument(EDIT_DOCX, 'structure')
  check('structure: таблиц стало 2', after.stats.tables === 2, after.stats)
  check('structure: outline вырос',
    after.outline.length > before.outline.length, { before: before.outline.length, after: after.outline.length })
  // +2 append, +1 insert_table, -1 delete_block
  check('structure: блоков = исходник + 2',
    after.blocks.length === beforeBlocks + 2, { before: beforeBlocks, after: after.blocks.length })

  console.log('[4] add_footer с номером страницы + patch_document')
  const res2 = await applyOps(EDIT_DOCX, [
    { op: 'add_footer', blocks: [{ type: 'paragraph', text: 'Отчёт', alignment: 'left' }], pageNumber: { alignment: 'center' } },
    { op: 'patch_document', content: [{ type: 'heading', level: 1, text: 'Полная замена' }, { type: 'paragraph', text: 'Документ перезаписан целиком.' }] },
  ])
  check('applied (2-я партия): 2 строки', res2.applied.length === 2, res2.applied)
  check('res2.stats: 1 параграф + 1 заголовок', res2.stats.paragraphs === 2, res2.stats)
  const text2 = await readDocument(EDIT_DOCX, 'text')
  check('текст после patch_document', text2.includes('Полная замена') && text2.includes('целиком'), text2)

  console.log('[5] ошибки: неверный индекс и неизвестная операция')
  let threw = 0
  try { await applyOps(EDIT_DOCX, [{ op: 'delete_block', index: 99 }]) } catch { threw++ }
  try { await applyOps(EDIT_DOCX, [{ op: 'no_such_op' }]) } catch { threw++ }
  try { await applyOps(EDIT_DOCX, []) } catch { threw++ }
  check('все 3 ошибочных вызова бросили исключения', threw === 3, threw)

  console.log('[6] set_page: поля страницы + page setup в full-чтении')
  const beforeXml = xmlOf(EDIT_DOCX, 'word/document.xml')
  const beforeTop = /<w:pgMar[^>]*w:top="(\d+)"/.exec(beforeXml)
  const resPage = await applyOps(EDIT_DOCX, [
    { op: 'set_page', page: { margins: { top: 1.11, bottom: 1.5 } } },
  ])
  check('applied: set_page', /set_page: margins/.test(resPage.applied[0]), resPage.applied)
  const afterXml = xmlOf(EDIT_DOCX, 'word/document.xml')
  const afterTop = /<w:pgMar[^>]*w:top="(\d+)"/.exec(afterXml)
  const afterBottom = /<w:pgMar[^>]*w:bottom="(\d+)"/.exec(afterXml)
  check('w:pgMar w:top изменился (1.11 см ≈ 629 twips)',
    afterTop && afterTop[1] !== (beforeTop ? beforeTop[1] : '') && Math.abs(Number(afterTop[1]) - 629) <= 2,
    { before: beforeTop && beforeTop[1], after: afterTop && afterTop[1] })
  check('w:pgMar w:bottom = 1.5 см ≈ 850 twips',
    afterBottom && Math.abs(Number(afterBottom[1]) - 850) <= 2, afterBottom && afterBottom[1])
  // full-чтение теперь возвращает page setup (task 1)
  const fullP = await readDocument(EDIT_DOCX, 'full')
  check('full: spec.page.margins.top ≈ 1.11',
    fullP.spec.page && fullP.spec.page.margins && Math.abs(fullP.spec.page.margins.top - 1.11) < 0.02,
    fullP.spec.page)

  console.log('[7] insert_at / replace_block / move_block')
  const resBlocks = await applyOps(EDIT_DOCX, [
    { op: 'patch_document', content: [
      { type: 'heading', level: 1, text: 'Первый' },
      { type: 'paragraph', text: 'Второй' },
      { type: 'paragraph', text: 'Третий' },
    ] },
  ])
  check('patch для [7] применён', resBlocks.applied.length === 1, resBlocks.applied)
  const resIns = await applyOps(EDIT_DOCX, [
    { op: 'insert_at', index: 1, blocks: [{ type: 'paragraph', text: 'ВСТАВКА' }] },
  ])
  check('applied: insert_at', /insert_at: 1 блок/.test(resIns.applied[0]), resIns.applied)
  let struct = await readDocument(EDIT_DOCX, 'structure')
  check('insert_at: блок перед индексом 1', struct.blocks[1].preview === 'ВСТАВКА', struct.blocks.map((b) => b.preview))
  const resRep = await applyOps(EDIT_DOCX, [
    { op: 'replace_block', index: 2, block: { type: 'paragraph', text: 'ЗАМЕНА' } },
  ])
  check('applied: replace_block', /replace_block: 2 → paragraph/.test(resRep.applied[0]), resRep.applied)
  struct = await readDocument(EDIT_DOCX, 'structure')
  check('replace_block: блок 2 заменён', struct.blocks[2].preview === 'ЗАМЕНА', struct.blocks.map((b) => b.preview))
  const resMove = await applyOps(EDIT_DOCX, [
    { op: 'move_block', from: 3, to: 0 },
  ])
  check('applied: move_block', /move_block: 3 → 0/.test(resMove.applied[0]), resMove.applied)
  struct = await readDocument(EDIT_DOCX, 'structure')
  check('move_block: «Третий» встал первым', struct.blocks[0].preview === 'Третий', struct.blocks.map((b) => b.preview))
  check('move_block: порядок сохранён',
    struct.blocks.map((b) => b.preview).join('|') === 'Третий|Первый|ВСТАВКА|ЗАМЕНА',
    struct.blocks.map((b) => b.preview))

  console.log('[8] add_watermark / remove_watermark / set_typography / remove_header / remove_footer')
  const wmOk = await watermarkSupported()
  const resWm = await applyOps(EDIT_DOCX, [
    { op: 'add_watermark', text: 'ЧЕРНОВИК', color: 'C00000', opacity: 0.3 },
    { op: 'set_typography', firstLineIndent: 'on', compactLists: true },
  ])
  check('applied: add_watermark', /add_watermark: "ЧЕРНОВИК"/.test(resWm.applied[0]), resWm.applied)
  check('applied: set_typography', /set_typography: firstLineIndent, compactLists/.test(resWm.applied[1]), resWm.applied)
  if (wmOk) {
    const headerXml = new AdmZip(EDIT_DOCX).getEntries()
      .filter((e) => /^word\/header\d*\.xml$/.test(e.entryName))
      .map((e) => new AdmZip(EDIT_DOCX).readAsText(e.entryName)).join('')
    check('watermark: v:shape в header xml', headerXml.includes('v:shape'), 'нет v:shape')
  } else {
    console.log('  skip watermark v:shape — build-часть без поддержки watermark (добавляется отдельным агентом)')
  }
  const resWm2 = await applyOps(EDIT_DOCX, [
    { op: 'remove_watermark' },
    { op: 'remove_header' },
    { op: 'remove_footer' },
  ])
  check('applied: remove_watermark/header/footer', resWm2.applied.length === 3, resWm2.applied)
  // документ остался валидным после всех правок
  const textFinal = await readDocument(EDIT_DOCX, 'text')
  check('финальный документ читается', textFinal.includes('Третий') && textFinal.includes('ЗАМЕНА'), textFinal)

  if (failures) {
    console.error('\nFAILED: ' + failures + ' проверок не прошло')
    process.exit(1)
  }
  console.log('\nPASSED: все проверки word.edit.test.js прошли')
}

if (require.main === module) {
  main().catch((e) => {
    console.error('TEST ERROR:', e)
    process.exit(1)
  })
}

module.exports = { PNG_1X1 }
