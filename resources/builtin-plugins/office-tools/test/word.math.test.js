// word.math.test — математические формулы: LaTeX → OMML → создание → чтение (roundtrip) → правка
const fs = require('fs')
const path = require('path')
const { buildDocument } = require('../dist/lib/word/spec')
const { readDocument } = require('../dist/lib/word/read')
const { applyOps } = require('../dist/lib/word/edit')
const { latexToMathElement, ommlToLatex } = require('../dist/lib/word/math')
const AdmZip = require('adm-zip')

const TMP = path.join(__dirname, '.tmp', 'math')
fs.mkdirSync(TMP, { recursive: true })

let passed = 0
let failed = 0
function ok(cond, label) {
  if (cond) { passed++; console.log('  ok: ' + label) }
  else { failed++; console.log('  FAIL: ' + label) }
}

const ctx = {
  async readImage() { throw new Error('no images expected') },
}

async function main() {
  console.log('== [1] latexToMathElement: базовые конструкции ==')
  const cases = [
    ['\\frac{a}{b}', '<m:f>'],
    ['\\sqrt{x}', '<m:rad>'],
    ['\\sqrt[3]{x}', '<m:deg>'],
    ['x^2', '<m:sSup>'],
    ['x_i', '<m:sSub>'],
    ['x_i^2', '<m:sSubSup>'],
    ['\\sum_{i=1}^{n} i', '<m:nary>'],
    ['\\int_0^1 dx', '<m:nary>'],
    ['\\lim_{x \\to 0} f(x)', '<m:limLow>'],
    ['\\sin x', '<m:func>'],
    ['\\left( a \\right)', '<m:d>'],
    ['\\begin{matrix} a & b \\\\ c & d \\end{matrix}', '<m:m>'],
    ['\\hat{x}', '<m:acc>'],
    ['\\alpha \\beta \\pi', 'α'],
    ['x \\leq y \\neq z', '≤'],
  ]
  const { Document, Packer, Paragraph } = require('docx')
  for (const [latex, marker] of cases) {
    const el = latexToMathElement(latex)
    const doc = new Document({ sections: [{ children: [new Paragraph({ children: [el] })] }] })
    const buf = await Packer.toBuffer(doc)
    const xml = new AdmZip(buf).readAsText('word/document.xml')
    ok(xml.includes('<m:oMath>') && xml.includes(marker), latex + ' → ' + marker)
  }

  console.log('== [2] word_create с math-блоками и инлайн-формулами ==')
  const spec = {
    content: [
      { type: 'heading', level: 1, text: 'Формулы' },
      { type: 'paragraph', text: 'Квадратное уравнение имеет корни:' },
      { type: 'math', latex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}' },
      { type: 'math', latex: '\\sum_{i=1}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}' },
      { type: 'paragraph', runs: [
        { text: 'Масса-энергия: ' },
        { math: 'E = mc^2' },
        { text: ' — знаменитая формула.' },
      ] },
      { type: 'math', latex: '\\int_0^{\\infty} e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}' },
      { type: 'math', latex: '\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix} \\cdot \\begin{pmatrix} x \\\\ y \\end{pmatrix}' },
      { type: 'math', latex: 'f(x) = \\begin{cases} 1, & x \\geq 0 \\\\ -1, & x < 0 \\end{cases}' },
    ],
  }
  const file1 = path.join(TMP, 'formulas.docx')
  const built = await buildDocument(spec, ctx)
  fs.writeFileSync(file1, built.buffer)
  ok(built.stats.paragraphs >= 8, 'stats.paragraphs = ' + built.stats.paragraphs)

  const xml1 = new AdmZip(file1).readAsText('word/document.xml')
  const omathCount = (xml1.match(/<m:oMath>/g) || []).length
  ok(omathCount === 6, 'формул в документе: ' + omathCount + ' (ожидалось 6: 5 блоков + 1 инлайн)')
  ok(xml1.includes('<m:f>'), 'есть дроби m:f')
  ok(xml1.includes('<m:rad>'), 'есть корни m:rad')
  ok(xml1.includes('<m:nary'), 'есть суммы/интегралы m:nary')
  ok(xml1.includes('<m:m>'), 'есть матрицы m:m')
  ok(xml1.includes('∑'), 'есть знак ∑')
  ok(xml1.includes('±'), 'есть знак ±')

  console.log('== [3] word_read full: roundtrip формул ==')
  const full = await readDocument(file1, 'full')
  const mathBlocks = full.spec.content.filter((b) => b.type === 'math')
  ok(mathBlocks.length === 5, 'math-блоков прочитано: ' + mathBlocks.length + ' (ожидалось 5)')
  const q = mathBlocks[0] && mathBlocks[0].latex || ''
  ok(q.includes('\\frac') && q.includes('\\sqrt') && q.includes('b'), 'квадратное уравнение: ' + q)
  ok(mathBlocks[0].display === true, 'display=true по умолчанию')
  const sum = mathBlocks[1] && mathBlocks[1].latex || ''
  ok(sum.includes('\\sum') && sum.includes('_{i=1}'), 'сумма: ' + sum)
  const integ = mathBlocks[2] && mathBlocks[2].latex || ''
  ok(integ.includes('\\int') && integ.includes('\\infty'), 'интеграл: ' + integ)
  const mat = mathBlocks[3] && mathBlocks[3].latex || ''
  ok(mat.includes('matrix'), 'матрица: ' + mat)
  const casesLat = mathBlocks[4] && mathBlocks[4].latex || ''
  ok(casesLat.includes('cases') || casesLat.includes('matrix'), 'cases: ' + casesLat)

  // инлайн-формула в параграфе
  const inlinePara = full.spec.content.find((b) => b.type === 'paragraph' && Array.isArray(b.runs) && b.runs.some((r) => r && r.math))
  ok(!!inlinePara, 'инлайн-формула в runs прочитана')
  const inlineMath = inlinePara && inlinePara.runs.find((r) => r && r.math)
  ok(inlineMath && /E\s*=\s*m\{?c\}?\^\{?2/.test(inlineMath.math), 'инлайн latex: ' + (inlineMath && inlineMath.math))

  console.log('== [4] word_read structure: превью формул ==')
  const struct = await readDocument(file1, 'structure')
  const mathStruct = struct.blocks.filter((b) => b.type === 'math')
  ok(mathStruct.length === 5, 'structure: math-блоков ' + mathStruct.length)
  ok(mathStruct[0] && mathStruct[0].preview.includes('[formula]'), 'превью: ' + (mathStruct[0] && mathStruct[0].preview))

  console.log('== [5] word_read text: формулы как latex-текст ==')
  const text = await readDocument(file1, 'text')
  ok(text.includes('\\frac') || text.includes('frac'), 'text-режим содержит latex формул')
  ok(!text.includes('⟦MATH:'), 'плейсхолдеров не осталось')

  console.log('== [6] word_edit insert_math + сохранение формул ==')
  const file2 = path.join(TMP, 'formulas-edit.docx')
  fs.copyFileSync(file1, file2)
  const res = await applyOps(file2, [
    { op: 'insert_math', latex: '\\vec{F} = m \\vec{a}', after: 1 },
    { op: 'append_blocks', blocks: [{ type: 'paragraph', text: 'Конец документа' }] },
  ])
  ok(res.applied.length === 2, 'применено 2 ops')
  ok(res.applied[0].includes('insert_math'), 'insert_math в applied')

  const xml2 = new AdmZip(file2).readAsText('word/document.xml')
  const omathCount2 = (xml2.match(/<m:oMath>/g) || []).length
  ok(omathCount2 === 7, 'формул после правки: ' + omathCount2 + ' (6 старых + 1 новая)')
  ok(xml2.includes('→') || xml2.includes('\u20D7'), 'векторная формула добавлена')

  // старые формулы не потерялись при пересборке
  const full2 = await readDocument(file2, 'full')
  const mathBlocks2 = full2.spec.content.filter((b) => b.type === 'math')
  ok(mathBlocks2.length === 6, 'после пересборки math-блоков: ' + mathBlocks2.length)
  const q2 = mathBlocks2.find((b) => b.latex && b.latex.includes('\\frac') && b.latex.includes('sqrt'))
  ok(!!q2, 'квадратное уравнение пережило пересборку')

  console.log('== [7] edge cases: graceful degradation ==')
  ok(typeof latexToMathElement('') === 'object', 'пустая строка не падает')
  ok(typeof latexToMathElement('\\unknowncmd{x}') === 'object', 'неизвестная команда не падает')
  ok(typeof latexToMathElement('{unclosed') === 'object', 'незакрытая скобка не падает')
  ok(typeof latexToMathElement('a^{') === 'object', 'обрыв скрипта не падает')
  const el2 = latexToMathElement('\\begin{matrix} a & b') // незакрытая матрица
  ok(typeof el2 === 'object', 'незакрытая матрица не падает')

  console.log('== [8] .bak бэкап ==')
  ok(fs.existsSync(file2 + '.bak'), '.bak создан при word_edit')

  console.log('')
  if (failed) {
    console.log('FAILED: ' + failed + ' проверок (из ' + (passed + failed) + ')')
    process.exit(1)
  }
  console.log('PASSED: все ' + passed + ' проверок word.math.test.js')
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1) })
