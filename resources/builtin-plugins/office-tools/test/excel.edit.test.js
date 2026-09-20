// excel.edit.test.js — applyOps: set_cells, insert_rows, add_sheet, set_column_width, sort
const fs = require('fs')
const path = require('path')
const { buildWorkbook } = require('../dist/lib/excel/spec')
const { readWorkbook } = require('../dist/lib/excel/read')
const { applyOps } = require('../dist/lib/excel/edit')

const TMP = path.join(__dirname, '.tmp')
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })
const FILE = path.join(TMP, 'excel-edit.xlsx')

let failed = 0
function check(name, cond) {
  if (cond) console.log('  ok: ' + name)
  else { failed++; console.log('  FAIL: ' + name) }
}

async function main() {
  // Исходник: 5 строк, сортируемая колонка B
  const built = await buildWorkbook({
    sheets: [{
      name: 'Товары',
      columns: [18, 12, 12],
      rows: [
        [{ value: 'Название', style: { font: { bold: true } } }, { value: 'Цена', style: { font: { bold: true } } }, { value: 'Остаток', style: { font: { bold: true } } }],
        [{ value: 'Груша' }, { value: 120 }, { value: 5 }],
        [{ value: 'Апельсин' }, { value: 80 }, { value: 12 }],
        [{ value: 'Яблоко' }, { value: 100 }, { value: 8 }],
        [{ value: 'Итого' }, { formula: '=SUM(B2:B4)' }, { formula: '=SUM(C2:C4)' }],
      ],
    }],
  })
  fs.writeFileSync(FILE, built.buffer)

  console.log('== applyOps ==')
  const res = await applyOps(FILE, [
    { op: 'set_cells', sheet: 'Товары', cells: [
      { ref: 'B2', value: 150 },
      { ref: 'C2', value: 3 },
      { ref: 'A1', style: { font: { bold: true, color: '1F4E78' }, fill: 'DEEBF7' } },
      { ref: 'D1', value: 'Скидка', numFmt: '0%' },
    ] },
    { op: 'insert_rows', sheet: 'Товары', at: 2, count: 1, values: [['Банан', 60, 20]] },
    { op: 'add_sheet', name: 'Итоги', rows: [[{ value: 'Всего' }, { formula: '=Товары!B6' }]] },
    { op: 'set_column_width', sheet: 'Товары', column: 'A', width: 30 },
    { op: 'sort', sheet: 'Товары', range: 'A3:D5', byColumn: 'B', ascending: true },
  ])

  check('applied.length=5', res.applied.length === 5)
  check('stats.sheets=2', res.stats.sheets === 2)
  check('preview.name=Товары', res.preview.name === 'Товары')

  console.log('== проверка чтением ==')
  const vals = await readWorkbook(FILE, { mode: 'values' })
  // после insert_rows на позицию 2: r1 заголовок, r2 Банан, r3-5 данные (отсортированы по B: 80,100,150), r6 Итого
  check('B2=60 (inserted Банан)', vals.values[1][1] === 60)
  check('A2=Банан', vals.values[1][0] === 'Банан')
  check('A3=Апельсин (сортировка)', vals.values[2][0] === 'Апельсин')
  check('B3=80', vals.values[2][1] === 80)
  check('A4=Яблоко', vals.values[3][0] === 'Яблоко')
  check('A5=Груша (B=150 после set_cells)', vals.values[4][0] === 'Груша')
  check('B5=150 (set_cells)', vals.values[4][1] === 150)
  check('C5=3 (set_cells)', vals.values[4][2] === 3)
  check('D1=Скидка (set_cells новая ячейка)', vals.values[0][3] === 'Скидка')
  check('totalRows=6', vals.preview.totalRows === 6)

  const f = await readWorkbook(FILE, { mode: 'formulas' })
  check('формула Итого сдвинулась (insert_rows)', f.values[5][1] === '=SUM(B3:B5)')

  const full = await readWorkbook(FILE, { mode: 'full' })
  check('лист Итоги добавлен', full.spec.sheets.some((s) => s.name === 'Итоги'))
  check('ширина A=30', Math.abs((full.spec.sheets[0].columns || [])[0] - 30) < 2)
  check('fill сохранился после set_cells', JSON.stringify(full.spec.sheets[0].rows).includes('DEEBF7'))

  console.log('== delete/rename/merge/freeze ==')
  const res2 = await applyOps(FILE, [
    { op: 'rename_sheet', name: 'Итоги', to: 'Сводка' },
    { op: 'merge', sheet: 'Товары', range: 'A1:B1' },
    { op: 'freeze', sheet: 'Товары', ref: 'A2' },
    { op: 'delete_rows', sheet: 'Товары', at: 6, count: 1 },
  ])
  check('applied2=4', res2.applied.length === 4)
  const m2 = await readWorkbook(FILE, { mode: 'meta' })
  check('лист переименован', m2.sheets.some((s) => s.name === 'Сводка'))
  check('merged A1:B1', JSON.stringify(m2.sheets[0].merged).includes('A1:B1'))
  const full2 = await readWorkbook(FILE, { mode: 'full' })
  check('freeze=A2', full2.spec.sheets[0].freeze === 'A2')
  check('строка Итого удалена', full2.spec.sheets[0].rows.length === 5)

  if (failed) {
    console.log('\nFAILED: ' + failed + ' проверок')
    process.exit(1)
  }
  console.log('\nPASSED: все проверки excel.edit.test.js')
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1) })
