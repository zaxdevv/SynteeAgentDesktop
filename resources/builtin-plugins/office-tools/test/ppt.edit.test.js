// ppt.edit.test — правки .pptx: find_replace, set_notes, hide, move, delete, transition, .bak
const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const { buildPresentation } = require('../dist/lib/ppt/spec')
const { readPresentation } = require('../dist/lib/ppt/read')
const { applyOps } = require('../dist/lib/ppt/edit')

const TMP = path.join(__dirname, '.tmp')
fs.mkdirSync(TMP, { recursive: true })

let passed = 0
let failed = 0
function ok(cond, label) {
  if (cond) { passed++; console.log('  ok: ' + label) }
  else { failed++; console.log('  FAIL: ' + label) }
}

async function main() {
  // Дека: 4 слайда, у первого заметки, у второго нет
  const spec = {
    layout: '16x9',
    slides: [
      { notes: 'Старые заметки', objects: [{ type: 'text', text: 'Alpha заголовок', x: 0.5, y: 0.5, w: 9, h: 0.8, options: { fontSize: 32, bold: true } }] },
      { objects: [{ type: 'text', text: 'Beta & Gamma', x: 0.5, y: 0.5, w: 9, h: 0.8, options: { fontSize: 32 } }] },
      { objects: [{ type: 'text', text: 'Delta слайд', x: 0.5, y: 0.5, w: 9, h: 0.8, options: { fontSize: 32 } }] },
      { objects: [{ type: 'text', text: 'Alpha финал', x: 0.5, y: 0.5, w: 9, h: 0.8, options: { fontSize: 32 } }] },
    ],
  }
  const file = path.join(TMP, 'ppt-edit.pptx')
  const built = await buildPresentation(spec, { async readImage() { throw new Error('no images') } })
  fs.writeFileSync(file, built.buffer)
  if (fs.existsSync(file + '.bak')) fs.unlinkSync(file + '.bak')

  console.log('== [1] find_replace (вкл. XML-entity &) ==')
  let res = applyOps(file, [{ op: 'find_replace', find: 'Alpha', replace: 'Omega' }])
  let deck = readPresentation(file, 'slides')
  ok(deck.slides[0].texts[0] === 'Omega заголовок', 'slide1: ' + deck.slides[0].texts[0])
  ok(deck.slides[3].texts[0] === 'Omega финал', 'slide4: ' + deck.slides[3].texts[0])
  ok(deck.slides[1].texts[0] === 'Beta & Gamma', 'slide2 не тронут: ' + deck.slides[1].texts[0])
  ok(res.applied[0].includes('2 замен'), 'отчёт: ' + res.applied[0])

  // Замена текста с &
  res = applyOps(file, [{ op: 'find_replace', find: 'Beta & Gamma', replace: 'Beta и Gamma' }])
  deck = readPresentation(file, 'slides')
  ok(deck.slides[1].texts[0] === 'Beta и Gamma', 'entity-замена: ' + deck.slides[1].texts[0])

  console.log('== [2] set_notes: существующие и новые ==')
  applyOps(file, [
    { op: 'set_notes', slide: 1, notes: 'Новые заметки докладчика' },
    { op: 'set_notes', slide: 2, notes: 'Заметки созданы с нуля' },
  ])
  deck = readPresentation(file, 'slides')
  ok(deck.slides[0].notes === 'Новые заметки докладчика', 'slide1.notes: ' + deck.slides[0].notes)
  ok(deck.slides[1].notes === 'Заметки созданы с нуля', 'slide2.notes (создан): ' + deck.slides[1].notes)
  const zip = new AdmZip(file)
  ok(zip.readAsText('ppt/notesSlides/notesSlide2.xml').includes('Заметки созданы с нуля'), 'notesSlide2.xml в zip')
  const ct = zip.readAsText('[Content_Types].xml')
  ok(ct.includes('/ppt/notesSlides/notesSlide2.xml'), 'Content_Types: override для notesSlide2')

  console.log('== [3] find_replace в заметках ==')
  applyOps(file, [{ op: 'find_replace', find: 'заметки', replace: 'ЗАМЕТКИ' }])
  deck = readPresentation(file, 'slides')
  ok(deck.slides[0].notes === 'Новые ЗАМЕТКИ докладчика', 'notes заменены: ' + deck.slides[0].notes)

  console.log('== [4] hide_slide / set_transition ==')
  applyOps(file, [
    { op: 'hide_slide', slide: 3 },
    { op: 'set_transition', transition: { type: 'push', dir: 'l', spd: 'med' } },
  ])
  deck = readPresentation(file, 'slides')
  ok(deck.slides[2].hidden === true, 'slide3 скрыт')
  const z2 = new AdmZip(file)
  const s3 = z2.readAsText('ppt/slides/slide3.xml')
  const s1 = z2.readAsText('ppt/slides/slide1.xml')
  ok(/<p:transition spd="med"><p:push dir="l"\/>/.test(s1), 'slide1: push-транзишен')
  ok(/<p:transition/.test(s3), 'slide3: транзишен (все слайды)')
  ok(/show="0"/.test(s3), 'slide3: show="0"')

  console.log('== [5] move_slide ==')
  applyOps(file, [{ op: 'move_slide', slide: 4, to: 1 }])
  deck = readPresentation(file, 'slides')
  // порядок после move 4→1: [Omega финал, Omega заголовок, Beta и Gamma, Delta(скрыт)]
  ok(deck.slides[0].texts[0] === 'Omega финал', 'после move: slide1 = ' + deck.slides[0].texts[0])
  ok(deck.slides[1].texts[0] === 'Omega заголовок', 'после move: slide2 = ' + deck.slides[1].texts[0])
  ok(deck.slides[3].texts[0] === 'Delta слайд', 'после move: slide4 = ' + deck.slides[3].texts[0])
  ok(deck.slides[3].hidden === true, 'скрытый Delta переехал на позицию 4')

  console.log('== [6] delete_slide (удаляем скрытый Delta, теперь он №4) ==')
  applyOps(file, [{ op: 'delete_slide', slide: 4 }])
  deck = readPresentation(file, 'slides')
  ok(deck.slideCount === 3, 'slideCount = ' + deck.slideCount)
  ok(deck.slides.map((s) => s.texts[0]).join('|') === 'Omega финал|Omega заголовок|Beta и Gamma', 'порядок: ' + deck.slides.map((s) => s.texts[0]).join('|'))
  const z3 = new AdmZip(file)
  ok(!z3.getEntries().some((e) => e.entryName === 'ppt/slides/slide3.xml'), 'slide3.xml (Delta) удалён из zip')
  const ct2 = z3.readAsText('[Content_Types].xml')
  ok(!ct2.includes('/ppt/slides/slide3.xml'), 'Content_Types: override слайда 3 удалён')
  const pres = z3.readAsText('ppt/presentation.xml')
  const sldIds = (pres.match(/<p:sldId\b/g) || []).length
  ok(sldIds === 3, 'sldIdLst: ' + sldIds + ' записи')

  console.log('== [7] .bak бэкап ==')
  ok(fs.existsSync(file + '.bak'), '.bak создан')

  console.log('== [8] Валидация ошибок ==')
  let threw = false
  try { applyOps(file, [{ op: 'delete_slide', slide: 99 }]) } catch (e) { threw = /slide/.test(e.message) }
  ok(threw, 'delete_slide 99 → ошибка')
  threw = false
  try { applyOps(file, [{ op: 'nope' }]) } catch (e) { threw = /операция/i.test(e.message) }
  ok(threw, 'неизвестная op → ошибка')

  console.log('\nИтог: ' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('CRASH:', e)
  process.exit(1)
})
