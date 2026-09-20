// convert.test.js — xlsx→csv→xlsx round-trip: кириллица, числа, даты, BOM, экранирование
const fs = require('fs')
const path = require('path')
const { buildWorkbook } = require('../dist/lib/excel/spec')
const { readWorkbook } = require('../dist/lib/excel/read')
const { xlsxToCsv, csvToXlsx } = require('../dist/lib/convert/csv')

const TMP = path.join(__dirname, '.tmp')
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })
const XLSX = path.join(TMP, 'convert-src.xlsx')
const CSV = path.join(TMP, 'convert-out.csv')
const XLSX2 = path.join(TMP, 'convert-back.xlsx')

let failed = 0
function check(name, cond) {
  if (cond) console.log('  ok: ' + name)
  else { failed++; console.log('  FAIL: ' + name) }
}

async function main() {
  console.log('== xlsx → csv ==')
  const built = await buildWorkbook({
    sheets: [{
      name: 'Прайс',
      columns: [20, 12, 12],
      rows: [
        [{ value: 'Товар' }, { value: 'Цена' }, { value: 'Дата' }],
        [{ value: 'Молоток; стальной' }, { value: 450.5 }, { value: '15.03.2025', numFmt: 'dd.mm.yyyy' }],
        [{ value: 'Гвозди "крупные"' }, { value: 80 }, { value: '01.02.2025', numFmt: 'dd.mm.yyyy' }],
        [{ value: 'Пила' }, { value: 1200 }, { value: '31.12.2024', numFmt: 'dd.mm.yyyy' }],
      ],
    }],
  })
  fs.writeFileSync(XLSX, built.buffer)

  const res = await xlsxToCsv(XLSX, CSV, {})
  check('size > 0', res.size > 0)
  check('summary "4 строк, 3 колонок"', /4 строк, 3 колонок/.test(res.summary))

  const raw = fs.readFileSync(CSV)
  check('BOM присутствует', raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF)
  const text = raw.toString('utf-8').replace(/^\uFEFF/, '')
  check('кириллица читается', text.includes('Молоток'))
  check('разделитель ;', text.split('\r\n')[0] === 'Товар;Цена;Дата')
  check('экранирование ; в поле', text.includes('"Молоток; стальной"'))
  check('экранирование кавычек', text.includes('"Гвозди ""крупные"""'))
  check('число 450.5', text.includes('450.5'))
  check('дата dd.mm.yyyy', text.includes('15.03.2025'))

  console.log('== csv → xlsx ==')
  const res2 = await csvToXlsx(CSV, XLSX2, { sheetName: 'Импорт' })
  check('size > 0', res2.size > 0)
  check('summary "4 строк, 3 колонок"', /4 строк, 3 колонок/.test(res2.summary))

  const vals = await readWorkbook(XLSX2, { mode: 'values' })
  check('лист называется Импорт', vals.preview.name === 'Импорт')
  check('кириллица сохранилась', vals.values[1][0] === 'Молоток; стальной')
  check('кавычки раскручены', vals.values[2][0] === 'Гвозди "крупные"')
  check('число распознано как число', vals.values[1][1] === 450.5)
  check('дата распознана → dd.mm.yyyy', vals.values[1][2] === '15.03.2025')
  check('вторая дата', vals.values[2][2] === '01.02.2025')

  const full = await readWorkbook(XLSX2, { mode: 'full' })
  check('numFmt даты проставлен', JSON.stringify(full.spec.sheets[0].rows).includes('dd.mm.yyyy'))
  const w = (full.spec.sheets[0].columns || [])[0]
  check('ширина колонки по длине', w >= 17 && w <= 25)

  console.log('== кастомный разделитель ==')
  const CSV2 = path.join(TMP, 'convert-comma.csv')
  await xlsxToCsv(XLSX, CSV2, { delimiter: ',' })
  const t2 = fs.readFileSync(CSV2, 'utf-8').replace(/^\uFEFF/, '')
  check('запятая как разделитель', t2.split('\r\n')[0] === 'Товар,Цена,Дата')
  const res3 = await csvToXlsx(CSV2, path.join(TMP, 'convert-comma.xlsx'), { delimiter: ',' })
  check('csv с , разобран', /4 строк, 3 колонок/.test(res3.summary))

  if (failed) {
    console.log('\nFAILED: ' + failed + ' проверок')
    process.exit(1)
  }
  console.log('\nPASSED: все проверки convert.test.js')
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1) })
