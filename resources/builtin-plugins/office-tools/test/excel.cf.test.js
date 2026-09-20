// excel.cf — регрессионный тест условного форматирования.
// Багфикс: exceljs падал 'Cannot read properties of undefined (reading forEach)'
// на colorScale/dataBar/iconSet без cfvo и на cellIs/expression без formulae.
const { buildWorkbook } = require('../dist/lib/excel/spec')

let pass = 0
let fail = 0

async function trySpec(label, spec, expectOk) {
  try {
    await buildWorkbook(spec)
    if (expectOk === false) { fail++; console.error('FAIL (ожидали ошибку):', label); return }
    pass++; console.log('ok  ', label)
  } catch (e) {
    if (expectOk === false && !e.message.includes('forEach')) { pass++; console.log('ok  ', label, '→ понятная ошибка:', e.message.slice(0, 60)); return }
    fail++; console.error('FAIL', label, '→', e.message)
  }
}

;(async () => {
  await trySpec('colorScale bare (дефолты)', { sheets: [{ name: 'S', rows: [[1, 5]], conditionalFormatting: [{ range: 'A1:A5', rules: [{ type: 'colorScale' }] }] }] })
  await trySpec('colorScale full', {
    sheets: [{ name: 'S', rows: [[1, 5]], conditionalFormatting: [{ range: 'A1:A5', rules: [{ type: 'colorScale', cfvo: [{ type: 'min' }, { type: 'percent', value: 50 }, { type: 'max' }], colors: ['F8696B', 'FFEB84', '63BE7B'] }] }] }],
  })
  await trySpec('dataBar bare', { sheets: [{ name: 'S', rows: [[1, 5]], conditionalFormatting: [{ range: 'A1:A5', rules: [{ type: 'dataBar' }] }] }] })
  await trySpec('dataBar color', { sheets: [{ name: 'S', rows: [[1, 5]], conditionalFormatting: [{ range: 'A1:A5', rules: [{ type: 'dataBar', color: '638EC6' }] }] }] })
  await trySpec('iconSet bare', { sheets: [{ name: 'S', rows: [[1, 5]], conditionalFormatting: [{ range: 'A1:A5', rules: [{ type: 'iconSet' }] }] }] })
  await trySpec('iconSet 5Rating', { sheets: [{ name: 'S', rows: [[1, 5]], conditionalFormatting: [{ range: 'A1:A5', rules: [{ type: 'iconSet', iconSet: '5Rating' }] }] }] })
  await trySpec('cellIs ok', { sheets: [{ name: 'S', rows: [[1]], conditionalFormatting: [{ range: 'A1:A5', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: ['100'], style: { fill: 'FFC7CE' } }] }] }] })
  await trySpec('top10', { sheets: [{ name: 'S', rows: [[1]], conditionalFormatting: [{ range: 'A1:A5', rules: [{ type: 'top10', rank: 5 }] }] }] })
  await trySpec('aboveAverage', { sheets: [{ name: 'S', rows: [[1]], conditionalFormatting: [{ range: 'A1:A5', rules: [{ type: 'aboveAverage' }] }] }] })
  await trySpec('cellIs без formulae → понятная ошибка', { sheets: [{ name: 'S', rows: [[1]], conditionalFormatting: [{ range: 'A1:A5', rules: [{ type: 'cellIs', operator: 'greaterThan' }] }] }] }, false)
  await trySpec('colorScale 3cfvo 2colors (выравнивание)', {
    sheets: [{ name: 'S', rows: [[1]], conditionalFormatting: [{ range: 'A1:A5', rules: [{ type: 'colorScale', cfvo: [{ type: 'min' }, { type: 'percent', value: 50 }, { type: 'max' }], colors: ['F8696B', '63BE7B'] }] }] }],
  })

  console.log(fail ? '\nFAILED: ' + fail : '\nPASSED: все проверки excel.cf.test.js прошли')
  process.exit(fail ? 1 : 0)
})()
