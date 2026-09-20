// excel.roundtrip.test.js — регрессия: excel_read full сохраняет dataValidation,
// conditionalFormatting, комментарии, высоты/скрытие строк-колонок, цвет ярлыка;
// excel_edit пишет .bak-бэкап; новые операции применяются.
const fs = require('fs')
const path = require('path')
const { buildWorkbook } = require('../dist/lib/excel/spec')
const { readWorkbook } = require('../dist/lib/excel/read')
const { applyOps } = require('../dist/lib/excel/edit')

const TMP = path.join(__dirname, '.tmp')
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })
const FILE = path.join(TMP, 'excel-roundtrip.xlsx')

let failed = 0
function check(name, cond, extra) {
  if (cond) console.log('  ok: ' + name)
  else { failed++; console.log('  FAIL: ' + name, extra !== undefined ? JSON.stringify(extra) : '') }
}

async function main() {
  const built = await buildWorkbook({
    sheets: [{
      name: 'Данные',
      rows: [
        [{ value: 'A' }, { value: 'B' }],
        [{ value: 1 }, { value: 'да' }],
        [{ value: 2 }],
      ],
      dataValidation: [{ range: 'B2:B10', type: 'list', formulae: ['"да,нет"'], allowBlank: true, prompt: 'Выберите', promptTitle: 'Тип' }],
      conditionalFormatting: [{ range: 'A2:A10', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: ['0'], style: { fill: 'FFC7CE', color: '9C0006' } }] }],
      rowHeights: { 1: 20 },
      hiddenColumns: [2],
      tabColor: 'FF0000',
    }],
  })
  fs.writeFileSync(FILE, built.buffer)

  console.log('== applyOps (новые операции + бэкап) ==')
  const res = await applyOps(FILE, [
    { op: 'set_cells', sheet: 'Данные', cells: [{ ref: 'A4', value: 'новое' }] },
    { op: 'set_row_height', sheet: 'Данные', row: 2, height: 30 },
    { op: 'add_comment', sheet: 'Данные', ref: 'B2', text: 'привет' },
    { op: 'find_replace', sheet: 'Данные', find: 'новое', replace: 'заменено' },
  ])
  check('applied.length=4', res.applied.length === 4, res.applied)
  check('.bak бэкап создан', !!res.backup && fs.existsSync(res.backup), res.backup)

  console.log('== read full: сохранение фич ==')
  const full = await readWorkbook(FILE, { mode: 'full' })
  const sh = full.spec.sheets[0]
  check('dataValidation сохранён', Array.isArray(sh.dataValidation) && sh.dataValidation.length >= 1, sh.dataValidation)
  check('dataValidation type=list', !!sh.dataValidation && sh.dataValidation[0].type === 'list')
  check('dataValidation formulae', !!sh.dataValidation && JSON.stringify(sh.dataValidation[0].formulae || []).includes('да'))
  check('conditionalFormatting сохранён', Array.isArray(sh.conditionalFormatting) && sh.conditionalFormatting.length >= 1, sh.conditionalFormatting)
  check('CF rule type=cellIs', !!sh.conditionalFormatting && sh.conditionalFormatting[0].rules[0].type === 'cellIs')
  check('rowHeights 1:20 и 2:30', !!sh.rowHeights && Number(sh.rowHeights['1']) === 20 && Number(sh.rowHeights['2']) === 30, sh.rowHeights)
  check('hiddenColumns=[2]', Array.isArray(sh.hiddenColumns) && sh.hiddenColumns.includes(2), sh.hiddenColumns)
  check('tabColor=FF0000', String(sh.tabColor || '').toUpperCase().endsWith('FF0000'), sh.tabColor)
  check('комментарий сохранён', JSON.stringify(sh.rows).includes('привет'))
  check('find_replace применён', JSON.stringify(sh.rows).includes('заменено') && !JSON.stringify(sh.rows).includes('новое'))

  console.log('== clear_cells / copy_range / hide_* ==')
  const res2 = await applyOps(FILE, [
    { op: 'copy_range', sheet: 'Данные', from: 'A1:B1', to: 'A6' },
    { op: 'clear_cells', sheet: 'Данные', range: 'A6:B6' },
    { op: 'hide_rows', sheet: 'Данные', at: 3, count: 1 },
    { op: 'set_tab_color', sheet: 'Данные', color: '00B050' },
    { op: 'hide_sheet', name: 'Данные' },
  ])
  check('applied2.length=5', res2.applied.length === 5, res2.applied)
  const full2 = await readWorkbook(FILE, { mode: 'full' })
  const sh2 = full2.spec.sheets[0]
  const countA = (JSON.stringify(sh2.rows).match(/"A"/g) || []).length
  check('clear_cells очистил копию A6 (осталась 1 "A")', countA === 1, countA)
  check('hide_rows добавил [3]', Array.isArray(sh2.hiddenRows) && sh2.hiddenRows.includes(3), sh2.hiddenRows)
  check('tabColor=00B050', String(sh2.tabColor || '').toUpperCase().endsWith('00B050'), sh2.tabColor)
  check('hide_sheet сохранён', !!sh2.hidden, sh2.hidden)

  if (failed) {
    console.log('\nFAILED: ' + failed + ' проверок')
    process.exit(1)
  }
  console.log('\nPASSED: excel.roundtrip.test.js')
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1) })
