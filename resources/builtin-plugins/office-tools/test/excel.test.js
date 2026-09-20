// excel.test.js — полный прогон: build со всеми фичами спеки → read (4 режима) → проверки
const fs = require('fs')
const path = require('path')
const { buildWorkbook } = require('../dist/lib/excel/spec')
const { readWorkbook } = require('../dist/lib/excel/read')

const TMP = path.join(__dirname, '.tmp')
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })
const FILE = path.join(TMP, 'excel-test.xlsx')

let failed = 0
function check(name, cond) {
  if (cond) console.log('  ok: ' + name)
  else { failed++; console.log('  FAIL: ' + name) }
}

async function main() {
  console.log('== build ==')
  const spec = {
    definedNames: [{ name: 'TaxRate', range: 'Данные!$A$1' }],
    sheets: [
      {
        name: 'Данные',
        columns: [20, 14, 14, 12],
        rows: [
          [
            { value: 'Отчёт', style: { font: { bold: true, size: 14, color: '1F4E78' }, fill: 'DEEBF7', alignment: { horizontal: 'center' } } },
          ],
          [
            { value: 'Наименование', style: { font: { bold: true }, fill: 'D9E1F2', border: { bottom: { style: 'thin', color: '000000' } }, alignment: { horizontal: 'center', vertical: 'middle' } } },
            { value: 'Кол-во', style: { font: { bold: true }, fill: 'D9E1F2', border: { bottom: { style: 'thin' } } } },
            { value: 'Цена', style: { font: { bold: true }, fill: 'D9E1F2', border: { bottom: { style: 'thin' } } } },
            { value: 'Сумма', style: { font: { bold: true }, fill: 'D9E1F2', border: { bottom: { style: 'thin' } } } },
          ],
          [
            { value: 'Стул' },
            { value: 4 },
            { value: 2500, numFmt: '#,##0.00 ₽' },
            { formula: '=B3*C3', numFmt: '#,##0.00 ₽' },
          ],
          [
            { value: 'Стол' },
            { value: 2 },
            { value: 8500, numFmt: '#,##0.00 ₽' },
            { formula: '=B4*C4', numFmt: '#,##0.00 ₽' },
          ],
          { height: 24, cells: [
            { value: 'Итого', style: { font: { bold: true } } },
            { formula: '=SUM(B3:B4)', style: { font: { bold: true } } },
            null,
            { formula: '=SUM(D3:D4)', numFmt: '#,##0.00 ₽', style: { font: { bold: true }, fill: 'FFF2CC', border: { top: { style: 'medium' } } } },
          ] },
          [
            { value: 'Дата', style: { font: { italic: true } } },
            { value: '01.03.2025', numFmt: 'dd.mm.yyyy' },
            { value: 0.15, numFmt: '0%' },
            { value: 'https://example.com', hyperlink: 'https://example.com' },
          ],
        ],
        freeze: 'A3',
        autoFilter: 'A2:D4',
        merged: ['A1:D1'],
        dataValidation: [
          { range: 'B3:B4', type: 'whole', operator: 'greaterThan', formulae: ['0'] },
          { range: 'C3:C10', type: 'list', allowBlank: true, formulae: ['"Да,Нет"'] },
        ],
        conditionalFormatting: [
          { range: 'D3:D4', rules: [{ type: 'cellIs', operator: 'greaterThan', priority: 1, formulae: ['10000'], style: { fill: 'FFC7CE', color: '9C0006' } }] },
        ],
        protection: { selectLockedCells: true, insertRows: false },
      },
      {
        name: 'Справочник',
        rows: [
          [{ value: 'Код' }, { value: 'Название' }],
          [{ value: 1 }, { value: 'Первый' }],
          [{ value: 2 }, { value: 'Второй' }],
        ],
      },
    ],
  }

  const built = await buildWorkbook(spec)
  check('buffer is Buffer', Buffer.isBuffer(built.buffer) && built.buffer.length > 4000)
  check('stats.sheets=2', built.stats.sheets === 2)
  check('stats.rows=9', built.stats.rows === 9)
  check('stats.cells=26', built.stats.cells === 26)
  check('stats.formulas=4', built.stats.formulas === 4)
  check('stats.merged=1', built.stats.merged === 1)
  check('preview.name=Данные', built.preview.name === 'Данные')
  check('preview.rows=6', built.preview.rows.length === 6)
  check('preview.rows[0][0]=Отчёт', built.preview.rows[0][0] === 'Отчёт')
  check('preview.totalRows=6', built.preview.totalRows === 6)
  check('preview.totalCols=4', built.preview.totalCols === 4)

  fs.writeFileSync(FILE, built.buffer)

  console.log('== read: meta ==')
  const meta = await readWorkbook(FILE, { mode: 'meta' })
  check('meta.sheets[0].name=Данные', meta.sheets[0].name === 'Данные')
  check('meta.sheets[0].rowCount=6', meta.sheets[0].rowCount === 6)
  check('meta.sheets[0].columnCount=4', meta.sheets[0].columnCount === 4)
  check('meta.sheets[0].merged содержит A1:D1', JSON.stringify(meta.sheets[0].merged).includes('A1:D1'))
  check('meta.sheets[0].hasFormulas', meta.sheets[0].hasFormulas === true)
  check('meta.sheets[1].hasFormulas=false', meta.sheets[1].hasFormulas === false)
  check('meta.stats.sheets=2', meta.meta.stats.sheets === 2)
  check('meta.stats.formulas=4', meta.meta.stats.formulas === 4)

  console.log('== read: values ==')
  const values = await readWorkbook(FILE, { mode: 'values' })
  check('values.preview.name=Данные', values.preview.name === 'Данные')
  check('values.preview.totalRows=6', values.preview.totalRows === 6)
  check('values[2][0]=Стул', values.values[2][0] === 'Стул')
  check('values[2][2]=2500', values.values[2][2] === 2500)
  check('values[4][1] формула → result/null', values.values[4][1] === null || values.values[4][1] === 6)
  check('values[5][1] дата строкой dd.mm.yyyy', values.values[5][1] === '01.03.2025')
  check('values[5][3] hyperlink текст', values.values[5][3] === 'https://example.com')

  console.log('== read: values + range ==')
  const ranged = await readWorkbook(FILE, { mode: 'values', range: 'A2:D3' })
  check('range: 2 строки', ranged.values.length === 2)
  check('range: A2=Наименование', ranged.values[0][0] === 'Наименование')
  check('range: B3=4', ranged.values[1][1] === 4)

  console.log('== read: values + sheet ==')
  const sheet2 = await readWorkbook(FILE, { mode: 'values', sheet: 'Справочник' })
  check('sheet2: preview.name=Справочник', sheet2.preview.name === 'Справочник')
  check('sheet2: values[1][1]=Первый', sheet2.values[1][1] === 'Первый')

  console.log('== read: formulas ==')
  const formulas = await readWorkbook(FILE, { mode: 'formulas' })
  check('formulas[2][3]= =B3*C3', formulas.values[2][3] === '=B3*C3')
  check('formulas[4][3]= =SUM(D3:D4)', formulas.values[4][3] === '=SUM(D3:D4)')
  check('formulas[4][1]= =SUM(B3:B4)', formulas.values[4][1] === '=SUM(B3:B4)')
  check('formulas[2][0]=Стул (не формула)', formulas.values[2][0] === 'Стул')

  console.log('== read: full ==')
  const full = await readWorkbook(FILE, { mode: 'full' })
  const s0 = full.spec.sheets[0]
  check('full: 2 листа', full.spec.sheets.length === 2)
  check('full: name=Данные', s0.name === 'Данные')
  check('full: merged A1:D1', JSON.stringify(s0.merged).includes('A1:D1'))
  check('full: freeze=A3', s0.freeze === 'A3')
  check('full: autoFilter=A2:D4', s0.autoFilter === 'A2:D4')
  check('full: columns[0]=20', Math.abs((s0.columns || [])[0] - 20) < 2)
  check('full: формула сохранена', JSON.stringify(s0.rows).includes('SUM(B3:B4)'))
  check('full: numFmt сохранён', JSON.stringify(s0.rows).includes('#,##0.00'))
  check('full: fill сохранён', JSON.stringify(s0.rows).includes('DEEBF7'))
  check('full: font bold сохранён', /"bold"\s*:\s*true/.test(JSON.stringify(s0.rows)))
  check('full: дата ISO', JSON.stringify(s0.rows).includes('2025-03-01'))

  console.log('== round-trip: full → buildWorkbook ==')
  const rebuilt = await buildWorkbook(full.spec)
  const FILE2 = path.join(TMP, 'excel-rebuilt.xlsx')
  fs.writeFileSync(FILE2, rebuilt.buffer)
  const reread = await readWorkbook(FILE2, { mode: 'values' })
  check('round-trip: значения совпали', JSON.stringify(reread.values) === JSON.stringify(values.values))
  const reF = await readWorkbook(FILE2, { mode: 'formulas' })
  check('round-trip: формулы совпали', JSON.stringify(reF.values) === JSON.stringify(formulas.values))
  const reM = await readWorkbook(FILE2, { mode: 'meta' })
  check('round-trip: merged сохранился', JSON.stringify(reM.sheets[0].merged).includes('A1:D1'))
  check('round-trip: freeze сохранился', (await readWorkbook(FILE2, { mode: 'full' })).spec.sheets[0].freeze === 'A3')

  if (failed) {
    console.log('\nFAILED: ' + failed + ' проверок')
    process.exit(1)
  }
  console.log('\nPASSED: все проверки excel.test.js')
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1) })
