// ppt.test — создание .pptx из спеки (pptxgenjs + транзишены) и чтение (roundtrip)
const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const { buildPresentation } = require('../dist/lib/ppt/spec')
const { readPresentation } = require('../dist/lib/ppt/read')
const { specDoc } = require('../dist/lib/ppt/specDoc')

const TMP = path.join(__dirname, '.tmp')
fs.mkdirSync(TMP, { recursive: true })

let passed = 0
let failed = 0
function ok(cond, label) {
  if (cond) { passed++; console.log('  ok: ' + label) }
  else { failed++; console.log('  FAIL: ' + label) }
}

// 1x1 красный PNG
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const ctx = {
  async readImage() { throw new Error('no fs images expected in this test') },
}

async function main() {
  console.log('== [1] specDoc ==')
  const doc = specDoc()
  ok(typeof doc === 'string' && doc.length > 2000 && doc.includes('TRANSITIONS'), 'specDoc ' + doc.length + ' chars')

  console.log('== [2] buildPresentation: богатая спека ==')
  const spec = {
    layout: '16x9',
    title: 'Тестовая дека',
    author: 'Luneex',
    theme: { headFontFace: 'Calibri', bodyFontFace: 'Calibri' },
    masters: [
      {
        id: 'MAIN',
        background: { color: 'FFFFFF' },
        objects: [
          { rect: { x: 0, y: 5.35, w: 10, h: 0.275, fill: { color: '2563EB' } } },
          { text: { text: 'Office Tools', options: { x: 0.4, y: 5.32, w: 3, h: 0.3, fontSize: 10, color: '888888' } } },
        ],
        slideNumber: { x: 9.4, y: 5.32, color: '888888', fontSize: 10 },
      },
    ],
    slides: [
      {
        master: 'MAIN',
        background: { color: '1A1A2E' },
        transition: { type: 'fade', spd: 'fast' },
        notes: 'Заметки титульного слайда',
        objects: [
          {
            type: 'text',
            x: 0.5, y: 1.8, w: 9, h: 1.2,
            runs: [
              { text: 'Тестовая ', options: { bold: true, color: 'FFFFFF', fontSize: 44 } },
              { text: 'дека', options: { color: 'E94560', fontSize: 44 } },
            ],
            options: { align: 'center' },
          },
          { type: 'text', text: 'Подзаголовок & детали', x: 0.5, y: 3.1, w: 9, h: 0.5, options: { color: 'AAAAAA', fontSize: 20, align: 'center' } },
        ],
      },
      {
        master: 'MAIN',
        transition: 'push',
        objects: [
          { type: 'text', text: 'Список задач', x: 0.5, y: 0.4, w: 9, h: 0.7, options: { bold: true, fontSize: 30, color: '1F2937' } },
          {
            type: 'text',
            x: 0.8, y: 1.3, w: 8, h: 2.5,
            paragraphs: [
              { text: 'Первая строка', options: { bullet: true, fontSize: 20 } },
              { text: 'Вторая строка', options: { bullet: true, fontSize: 20 } },
              { text: 'Третья строка', options: { bullet: true, fontSize: 20 } },
            ],
          },
          {
            type: 'table',
            x: 0.8, y: 4.0, w: 8.4,
            rows: [
              [
                { text: 'Продукт', options: { bold: true, fill: '1F4E79', color: 'FFFFFF' } },
                { text: 'Цена', options: { bold: true, fill: '1F4E79', color: 'FFFFFF' } },
              ],
              ['Лицензия Pro', { text: '4 900 ₽', options: { align: 'right' } }],
              ['Лицензия Max', { text: '9 900 ₽', options: { align: 'right', fill: 'F2F2F2' } }],
            ],
            colW: [5.4, 3],
            options: { border: { pt: 1, color: 'DDDDDD' }, fontSize: 14 },
          },
        ],
      },
      {
        hidden: true,
        objects: [
          { type: 'text', text: 'Скрытый слайд', x: 0.5, y: 0.4, w: 9, h: 0.6, options: { bold: true, fontSize: 28 } },
          { type: 'image', data: RED_PNG, x: 1, y: 1.5, w: 2, h: 1.2 },
          { type: 'shape', shape: 'roundRect', x: 4, y: 1.5, w: 3, h: 1.2, fill: '2563EB', rectRadius: 0.15, text: 'Фигура с текстом', textOptions: { color: 'FFFFFF', fontSize: 16, align: 'center' } },
          {
            type: 'chart',
            chartType: 'bar',
            data: [
              { name: 'Продажи', labels: ['Q1', 'Q2', 'Q3'], values: [12, 25, 18] },
              { name: 'План', labels: ['Q1', 'Q2', 'Q3'], values: [15, 20, 22] },
            ],
            x: 0.8, y: 3, w: 8, h: 2.2,
            options: { showLegend: true, legendPos: 'b', chartColors: ['2563EB', 'ED7D31'], showValue: true },
          },
        ],
      },
      {
        objects: [
          {
            type: 'chart',
            chartType: 'pie',
            data: [{ name: 'Доли', labels: ['A', 'B', 'C'], values: [40, 35, 25] }],
            x: 3, y: 1, w: 4, h: 3.5,
            options: { holeSize: 50, showLegend: true, legendPos: 'r' },
          },
        ],
      },
    ],
  }

  const built = await buildPresentation(spec, ctx)
  ok(Buffer.isBuffer(built.buffer) && built.buffer.length > 5000, 'buffer ' + built.buffer.length + ' bytes')
  ok(built.stats.slides === 4, 'stats.slides = ' + built.stats.slides)
  ok(built.stats.tables === 1, 'stats.tables = ' + built.stats.tables)
  ok(built.stats.images === 1, 'stats.images = ' + built.stats.images)
  ok(built.stats.shapes === 1, 'stats.shapes = ' + built.stats.shapes)
  ok(built.stats.charts === 2, 'stats.charts = ' + built.stats.charts)
  ok(built.stats.notes === 1, 'stats.notes = ' + built.stats.notes)
  ok(built.stats.hidden === 1, 'stats.hidden = ' + built.stats.hidden)
  ok(built.stats.transitions === 2, 'stats.transitions = ' + built.stats.transitions)

  const file = path.join(TMP, 'ppt-test.pptx')
  fs.writeFileSync(file, built.buffer)

  console.log('== [3] XML: транзишены, скрытие, диаграммы ==')
  const zip = new AdmZip(file)
  const s1 = zip.readAsText('ppt/slides/slide1.xml')
  const s2 = zip.readAsText('ppt/slides/slide2.xml')
  const s3 = zip.readAsText('ppt/slides/slide3.xml')
  ok(s1.includes('<p:transition spd="fast"><p:fade'), 'slide1: fade-транзишен')
  ok(s2.includes('<p:push dir='), 'slide2: push-транзишен')
  ok(/<p:sld\b[^>]*show="0"/.test(s3), 'slide3: show="0" (скрыт)')
  const chartFiles = zip.getEntries().map((e) => e.entryName).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))
  ok(chartFiles.length === 2, 'chart XML: ' + chartFiles.length + ' файла')
  ok(zip.readAsText('ppt/notesSlides/notesSlide1.xml').includes('Заметки титульного слайда'), 'notesSlide1 существует')

  console.log('== [4] readPresentation: meta ==')
  const meta = readPresentation(file, 'meta')
  ok(meta.slideCount === 4, 'meta.slideCount = ' + meta.slideCount)
  ok(meta.hiddenSlides === 1, 'meta.hiddenSlides = ' + meta.hiddenSlides)
  ok(meta.title === 'Тестовая дека', 'meta.title = ' + JSON.stringify(meta.title))
  ok(meta.size === '10x5.63 in' || meta.size === '10x5.62 in' || (meta.widthIn === 10 && meta.heightIn > 5.6), 'meta.size = ' + meta.size)

  console.log('== [5] readPresentation: slides ==')
  const deck = readPresentation(file, 'slides')
  ok(deck.slideCount === 4, 'slides.slideCount')
  const s1r = deck.slides[0]
  ok(s1r.notes === 'Заметки титульного слайда', 'slides[0].notes')
  ok((s1r.texts || []).some((t) => t.includes('Тестовая') && t.includes('дека')), 'slides[0] тексты: титул')
  ok((s1r.texts || []).some((t) => t.includes('Подзаголовок & детали')), 'slides[0]: XML-entity & декодирован')
  ok(deck.slides[2].hidden === true, 'slides[2].hidden')
  ok((deck.slides[1].texts || []).some((t) => t.includes('Первая строка')), 'slides[1]: буллеты')

  console.log('== [6] readPresentation: full ==')
  const mediaDir = path.join(TMP, 'ppt-media')
  const full = readPresentation(file, 'full', { imageDir: mediaDir })
  const s3f = full.slides[2]
  const chartObj = (s3f.objects || []).find((o) => o.kind === 'chart')
  ok(!!chartObj, 'full: chart-объект на слайде 3')
  if (chartObj) {
    ok(chartObj.chartType === 'bar', 'chart.chartType = ' + chartObj.chartType)
    ok(chartObj.series.length === 2 && chartObj.series[0].name === 'Продажи', 'chart.series: ' + (chartObj.series || []).map((s) => s.name).join(','))
    ok(JSON.stringify(chartObj.series[0].values) === '[12,25,18]', 'chart.series[0].values = ' + JSON.stringify(chartObj.series[0].values))
    ok(JSON.stringify(chartObj.categories) === '["Q1","Q2","Q3"]', 'chart.categories = ' + JSON.stringify(chartObj.categories))
  }
  const tableObj = (full.slides[1].objects || []).find((o) => o.kind === 'table')
  ok(!!tableObj && tableObj.rows.length === 3 && tableObj.cols === 2, 'full: таблица 3x2')
  ok(tableObj && tableObj.rows[0][0] === 'Продукт', 'full: ячейка [0][0] = ' + (tableObj && tableObj.rows[0][0]))
  const imgObj = (s3f.objects || []).find((o) => o.kind === 'image')
  ok(!!imgObj && imgObj.path && fs.existsSync(imgObj.path), 'full: картинка извлечена → ' + (imgObj && imgObj.path))
  const pieObj = (full.slides[3].objects || []).find((o) => o.kind === 'chart')
  ok(!!pieObj && (pieObj.chartType === 'pie' || pieObj.chartType === 'doughnut'), 'full: pie/doughnut на слайде 4 (' + (pieObj && pieObj.chartType) + ')')
  const shapeObj = (s3f.objects || []).find((o) => o.kind === 'shape' && o.text && o.text.includes('Фигура'))
  ok(!!shapeObj, 'full: фигура с текстом')

  console.log('== [7] Валидация ошибок ==')
  let threw = false
  try { await buildPresentation({ slides: [] }, ctx) } catch (e) { threw = /slides/.test(e.message) }
  ok(threw, 'пустые slides → ошибка')
  threw = false
  try { await buildPresentation({ slides: [{ objects: [{ type: 'chart', chartType: 'nope', data: [] }] }] }, ctx) } catch (e) { threw = /диаграмм/i.test(e.message) }
  ok(threw, 'неизвестный chartType → ошибка')
  threw = false
  try { await buildPresentation({ slides: [{ transition: 'nope' }] }, ctx) } catch (e) { threw = /транзишен/i.test(e.message) }
  ok(threw, 'неизвестный transition → ошибка')

  console.log('\nИтог: ' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('CRASH:', e)
  process.exit(1)
})
