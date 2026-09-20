// ppt.themes.test — дизайн-темы: структура, applyTheme, buildPresentation с template,
// extractTheme из файла, resolveTemplate, isOfficeZip
const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const { THEMES, findTheme, applyTheme, luminance, themeSummary } = require('../dist/lib/ppt/themes')
const templateLib = require('../dist/lib/ppt/templateLib')
const { buildPresentation, resolveTemplate } = require('../dist/lib/ppt/spec')

const TMP = path.join(__dirname, '.tmp')
fs.mkdirSync(TMP, { recursive: true })

let passed = 0
let failed = 0
function ok(cond, label) {
  if (cond) { passed++; console.log('  ok: ' + label) }
  else { failed++; console.log('  FAIL: ' + label) }
}

async function main() {
  console.log('== [1] Структура 10 тем ==')
  ok(THEMES.length === 10, 'тем ровно 10: ' + THEMES.length)
  const ids = THEMES.map((t) => t.id)
  ok(new Set(ids).size === 10, 'id уникальны')
  for (const t of THEMES) {
    const valid = t.id && t.name && t.description && ['dark', 'light'].includes(t.style) &&
      t.colors.bg && t.colors.accent && t.colors.accent2 && t.colors.text && t.colors.textMuted &&
      t.fonts.head && t.fonts.body && typeof t.masterObjects === 'function'
    if (!valid) { ok(false, 'тема ' + t.id + ' невалидна'); continue }
  }
  ok(THEMES.every((t) => t.colors.bg && t.colors.accent), 'все темы валидны')
  ok(THEMES.filter((t) => t.style === 'dark').length >= 3, 'есть тёмные темы')
  ok(!!findTheme('MIDNIGHT') && !!findTheme('Corporate-Blue '), 'findTheme без регистра (с пробелом)')
  ok(findTheme('nope') === null, 'findTheme нет темы → null')

  console.log('== [2] luminance ==')
  ok(luminance('FFFFFF') > 0.9, 'белый яркий')
  ok(luminance('000000') < 0.1, 'чёрный тёмный')
  ok(luminance('#0F172A') < 0.2, '#hex тоже работает')

  console.log('== [3] applyTheme: тёмная тема (midnight) ==')
  const spec1 = {
    slides: [
      { objects: [{ type: 'text', text: 'Титул', x: 1, y: 1, w: 8, h: 1, options: { fontSize: 44 } }] },
      {
        objects: [
          { type: 'text', text: 'Заголовок', x: 0.5, y: 0.3, w: 9, h: 0.6, options: { fontSize: 30, bold: true } },
          { type: 'text', text: 'Обычный текст', x: 0.5, y: 1.2, w: 9, h: 0.5 },
          { type: 'text', text: 'Свой цвет', x: 0.5, y: 2, w: 9, h: 0.5, options: { color: 'FF0000' } },
          { type: 'chart', chartType: 'bar', data: [{ name: 'S', labels: ['a'], values: [1] }] },
          { type: 'table', rows: [['a', 'b']] },
        ],
      },
    ],
  }
  const midnight = findTheme('midnight')
  applyTheme(spec1, midnight)
  ok(spec1.theme.headFontFace === 'Segoe UI', 'шрифты применены: ' + spec1.theme.headFontFace)
  ok(spec1.masters && spec1.masters.length === 1 && spec1.masters[0].id === 'THEME', 'мастер THEME создан')
  ok(spec1.masters[0].objects.length > 0, 'декор мастера: ' + spec1.masters[0].objects.length + ' элементов')
  ok(spec1.slides[0].master === 'THEME' && spec1.slides[1].master === 'THEME', 'слайды привязаны к мастеру')
  ok(spec1.slides[0].background.color === '0F172A', 'фон титула: ' + spec1.slides[0].background.color)
  ok(spec1.slides[1].background.color === '0F172A', 'фон слайда 2')
  const title = spec1.slides[0].objects[0]
  ok(title.options.color === '22D3EE', 'титул без цвета → accent: ' + title.options.color)
  const heading = spec1.slides[1].objects[0]
  ok(heading.options.color === '22D3EE', 'заголовок (bold+30пт) → accent')
  const body = spec1.slides[1].objects[1]
  ok(body.options.color === 'E2E8F0', 'обычный текст на dark → светлый: ' + body.options.color)
  const custom = spec1.slides[1].objects[2]
  ok(custom.options.color === 'FF0000', 'явный цвет не тронут')
  const chart = spec1.slides[1].objects[3]
  ok(JSON.stringify(chart.options.chartColors.slice(0, 2)) === '["22D3EE","818CF8"]', 'chartColors из темы')
  const table = spec1.slides[1].objects[4]
  ok(table.options.color === 'E2E8F0', 'таблица на dark → светлый текст')

  console.log('== [4] applyTheme: светлая тема + свои мастера выигрывают ==')
  const spec2 = {
    masters: [{ id: 'MY', background: { color: '123456' }, objects: [] }],
    slides: [
      { master: 'MY', background: { color: 'ABCDEF' }, objects: [{ type: 'text', text: 'Hi', x: 1, y: 1, w: 5, h: 1 }] },
    ],
  }
  applyTheme(spec2, findTheme('minimal'))
  ok(spec2.masters.length === 1 && spec2.masters[0].id === 'MY', 'свои мастера не заменены')
  ok(spec2.slides[0].background.color === 'ABCDEF', 'свой фон не тронут')
  ok(spec2.slides[0].objects[0].options.color === '0F0F0F', 'текст на light → тёмный')

  console.log('== [5] buildPresentation с template: "sunset" ==')
  const built = await buildPresentation({
    layout: '16x9',
    title: 'Themed deck',
    template: 'sunset',
    slides: [
      { objects: [{ type: 'text', text: 'Sunset title', x: 0.5, y: 2, w: 9, h: 1, options: { fontSize: 48 } }] },
      { objects: [{ type: 'text', text: 'Body text', x: 0.5, y: 1, w: 9, h: 0.5 }] },
    ],
  }, { async readImage() { throw new Error('no images') } })
  ok(built.stats.slides === 2, 'сборка ок')
  const file = path.join(TMP, 'ppt-themed.pptx')
  fs.writeFileSync(file, built.buffer)
  const zip = new AdmZip(file)
  const presXml = zip.readAsText('ppt/presentation.xml')
  const sldMaster = zip.readAsText('ppt/slideMasters/slideMaster1.xml')
  const themeXml = zip.readAsText('ppt/theme/theme1.xml')
  ok(!!presXml && !!sldMaster, 'структура pptx целая')
  ok(themeXml.includes('Trebuchet MS'), 'шрифт темы в theme1.xml')
  ok(sldMaster.includes('1E1B4B'), 'фон мастера 1E1B4B (инъекция p:bg)')
  // Декор мастера: sunset/diagCorner = 2 rect с rotate + 1 rect-полоса + slideNumber
  ok((sldMaster.match(/rot="/g) || []).length >= 2, 'повёрнутые rect в мастере (rotate)')
  ok((sldMaster.match(/prst="rect"/g) || []).length >= 3, 'rect-фигуры в мастере: ' + (sldMaster.match(/prst="rect"/g) || []).length)
  ok(sldMaster.includes('a:alpha'), 'transparency → a:alpha')
  ok(sldMaster.includes('fld'), 'slideNumber (fld)')
  const s1 = zip.readAsText('ppt/slides/slide1.xml')
  ok(s1.includes('FB7185'), 'титул окрашен accent (FB7185)')
  ok(s1.includes('F1F5F9') || s1.includes('1E1B4B'), 'цвета темы в слайде')

  console.log('== [5b] декор midnight: ellipse-свечение в мастере ==')
  const builtM = await buildPresentation({
    template: 'midnight',
    slides: [{ objects: [{ type: 'text', text: 'X', x: 1, y: 1, w: 8, h: 1 }] }],
  }, { async readImage() { throw new Error('no images') } })
  const zm = new AdmZip(builtM.buffer)
  const mm = zm.readAsText('ppt/slideMasters/slideMaster1.xml')
  ok(mm.includes('prst="ellipse"'), 'ellipse в мастере midnight')
  ok(mm.includes('0F172A'), 'фон midnight в мастере')

  console.log('== [5c] декор minimal: line в мастере ==')
  const builtL = await buildPresentation({
    template: 'minimal',
    slides: [{ objects: [{ type: 'text', text: 'X', x: 1, y: 1, w: 8, h: 1 }] }],
  }, { async readImage() { throw new Error('no images') } })
  const zl = new AdmZip(builtL.buffer)
  const ml = zl.readAsText('ppt/slideMasters/slideMaster1.xml')
  ok(ml.includes('prst="line"') && ml.includes('<a:ln'), 'line в мастере minimal')

  console.log('== [6] extractTheme из реального файла ==')
  // Из сгенерированной sunset-деки: шрифты Trebuchet MS
  const t1 = templateLib.extractTheme(file)
  ok(t1.fonts.head === 'Trebuchet MS', 'шрифты извлечены: ' + t1.fonts.head)
  ok(['light', 'dark'].includes(t1.style), 'style определён: ' + t1.style)
  ok(t1.colors.accent && /^[0-9A-F]{6}$/.test(t1.colors.accent), 'accent извлечён: ' + t1.colors.accent)
  // Из ppt-test.pptx (Calibri)
  const testFile = path.join(TMP, 'ppt-test.pptx')
  if (fs.existsSync(testFile)) {
    const t2 = templateLib.extractTheme(testFile)
    ok(t2.fonts.head === 'Calibri', 'Calibri из ppt-test.pptx: ' + t2.fonts.head)
  } else {
    ok(true, 'ppt-test.pptx нет — пропуск (запусти ppt.test.js первым)')
  }

  console.log('== [7] resolveTemplate ==')
  ok(resolveTemplate('ocean').id === 'ocean', 'id темы')
  ok(resolveTemplate(file).id.startsWith('file:'), 'путь к файлу → тема файла: ' + resolveTemplate(file).id)
  const customTheme = resolveTemplate({ colors: { bg: '000000', accent: 'FF0000', text: 'FFFFFF' }, fonts: { head: 'Arial' } })
  ok(customTheme.colors.accent === 'FF0000', 'кастомный объект-тема')
  let threw = false
  try { resolveTemplate('C:/nonexistent.pptx') } catch (e) { threw = /Шаблон не найден|не найден/i.test(e.message) }
  ok(threw, 'несуществующий файл → понятная ошибка')

  console.log('== [8] isOfficeZip ==')
  ok(templateLib.isOfficeZip(fs.readFileSync(file)) === true, 'валидный pptx → true')
  ok(templateLib.isOfficeZip(Buffer.from('garbage data not a zip at all')) === false, 'мусор → false')
  ok(templateLib.isOfficeZip(Buffer.alloc(0)) === false, 'пустой буфер → false')

  console.log('== [9] buildPresentation: template-объект + 4x3 адаптив ==')
  const built43 = await buildPresentation({
    layout: '4x3',
    template: { colors: { bg: '111111', accent: '00FF00', text: 'EEEEEE' }, fonts: { head: 'Arial' }, style: 'dark' },
    slides: [{ objects: [{ type: 'text', text: 'X', x: 1, y: 1, w: 5, h: 1 }] }],
  }, { async readImage() { throw new Error('no images') } })
  ok(built43.stats.slides === 1, '4x3 сборка ок')
  const z43 = new AdmZip(built43.buffer)
  const m43 = z43.readAsText('ppt/slideMasters/slideMaster1.xml')
  // slideNumber мастера должен быть у низа 7.5" слайда (y ~ 7.2 → EMU ~ 6578000+)
  ok(m43.includes('111111'), 'кастомная тема: фон мастера 111111')

  console.log('== [10] themeSummary ==')
  const sum = themeSummary(THEMES[0])
  ok(sum.id && sum.palette.length === 4 && sum.fonts.head, 'summary структура')

  console.log('\nИтог: ' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('CRASH:', e)
  process.exit(1)
})
