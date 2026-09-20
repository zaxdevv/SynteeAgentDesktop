// word.compare.test.js — сравнение двух .docx через compareDocuments (blocks + text).
// Документы собираются buildDocument во временной папке os.tmpdir().
// Запуск: node test/word.compare.test.js (cwd = папка плагина)

const fs = require('fs')
const path = require('path')
const os = require('os')
const { buildDocument } = require('../dist/lib/word/spec')
const { compareDocuments } = require('../dist/lib/word/compare')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'word-compare-'))
const DOC_A = path.join(TMP, 'a.docx')
const DOC_B = path.join(TMP, 'b.docx')

let failures = 0
function check(name, cond, extra) {
  if (cond) {
    console.log('  ok  ' + name)
  } else {
    failures++
    console.error('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''))
  }
}

/** Спека с настраиваемым набором блоков. */
function specOf(content) {
  return { content }
}

const COMMON = [
  { type: 'heading', level: 1, text: 'Отчёт v1' },
  { type: 'paragraph', text: 'Общее введение.' },
]

async function main() {
  console.log('[1] сборка двух документов с общими и разными блоками')
  const a = await buildDocument(specOf([
    ...COMMON,
    { type: 'paragraph', text: 'Старый вывод.' },
    { type: 'paragraph', text: 'Общее заключение.' },
  ]), {})
  fs.writeFileSync(DOC_A, a.buffer)
  const b = await buildDocument(specOf([
    ...COMMON,
    { type: 'paragraph', text: 'Новый вывод.' },
    { type: 'paragraph', text: 'Общее заключение.' },
    { type: 'paragraph', text: 'Добавленный итог.' },
  ]), {})
  fs.writeFileSync(DOC_B, b.buffer)
  check('документ A собран', a.buffer.length > 1000, a.buffer.length)
  check('документ B собран', b.buffer.length > 1000, b.buffer.length)

  console.log('[2] compareDocuments: mode blocks (по умолчанию)')
  const res = await compareDocuments(DOC_A, DOC_B)
  // 1 блок удалён (Старый вывод.) — как removed или changed-old
  check('удалений (removed + changed) = 1', res.removed + res.changed === 1,
    { added: res.added, removed: res.removed, changed: res.changed })
  // 2 блока добавлены (Новый вывод., Добавленный итог.) — как added или changed-new
  check('добавлений (added + changed) = 2', res.added + res.changed === 2,
    { added: res.added, removed: res.removed, changed: res.changed })
  check('details: длина = added+removed+changed', res.details.length === res.added + res.removed + res.changed, res.details)
  check('summary — строка с различиями', typeof res.summary === 'string' && /Различия/.test(res.summary), res.summary)
  const texts = res.details.map((d) => [d.oldText, d.newText].filter(Boolean).join(''))
  check('details: упоминаются старый/новый/добавленный тексты',
    texts.some((t) => t.includes('Старый вывод')) &&
    texts.some((t) => t.includes('Новый вывод')) &&
    texts.some((t) => t.includes('Добавленный итог')), texts)
  const changed = res.details.find((d) => d.kind === 'changed')
  if (changed) {
    check('changed: oldText и newText заполнены', changed.oldText && changed.newText, changed)
  }

  console.log('[3] compareDocuments: одинаковые документы')
  const same = await compareDocuments(DOC_A, DOC_A)
  check('идентичны: 0 изменений', same.added === 0 && same.removed === 0 && same.changed === 0, same)
  check('идентичны: summary', /идентичны/.test(same.summary), same.summary)

  console.log('[4] compareDocuments: mode text')
  const resText = await compareDocuments(DOC_A, DOC_B, { mode: 'text' })
  check('text: удалений >= 1', resText.removed + resText.changed >= 1,
    { added: resText.added, removed: resText.removed, changed: resText.changed })
  check('text: добавлений >= 2', resText.added + resText.changed >= 2,
    { added: resText.added, removed: resText.removed, changed: resText.changed })
  check('text: summary про строки', /строк/.test(resText.summary), resText.summary)

  console.log('[5] ошибки: неизвестный режим')
  let threw = 0
  try { await compareDocuments(DOC_A, DOC_B, { mode: 'nope' }) } catch { threw++ }
  check('неизвестный режим бросает исключение', threw === 1, threw)

  if (failures) {
    console.error('\nFAILED: ' + failures + ' проверок не прошло')
    process.exit(1)
  }
  console.log('\nPASSED: все проверки word.compare.test.js прошли')
}

if (require.main === module) {
  main().catch((e) => {
    console.error('TEST ERROR:', e)
    process.exit(1)
  })
}

module.exports = { TMP }
