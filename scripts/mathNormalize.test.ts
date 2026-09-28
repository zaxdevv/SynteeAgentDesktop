/**
 * E2E-тест нормализации математики: normalizeMathDelimiters → remark-parse +
 * remark-math → проверяем math-узлы. Запуск:
 *   npx esbuild scripts/mathNormalize.test.ts --bundle --format=esm --outfile=.tmp-math-e2e.mjs && node .tmp-math-e2e.mjs
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import { normalizeMathDelimiters, containsMathMarkers } from '../src/shared/mathNormalize'

const proc = unified().use(remarkParse).use(remarkMath)

const walk = (n: any, out: string[] = []): string[] => {
  if (n.type === 'inlineMath' || n.type === 'math') {
    out.push(`${n.type}(${n.value.replace(/\n/g, '⏎')})`)
  }
  ;(n.children || []).forEach((c: any) => walk(c, out))
  return out
}

let failures = 0

function check(name: string, input: string, expect: string[]): void {
  const norm = normalizeMathDelimiters(input)
  const got = walk(proc.parse(norm))
  const ok = JSON.stringify(got) === JSON.stringify(expect)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    console.log(`      normalized: ${JSON.stringify(norm)}`)
    console.log(`      got:      ${JSON.stringify(got)}`)
    console.log(`      expected: ${JSON.stringify(expect)}`)
  }
}

// 1. Инлайн \( ... \)
check('inline \\(...\\)', String.raw`Формула \(E = mc^2\) внутри текста`, [
  'inlineMath(E = mc^2)',
])

// 2. Display на отдельной строке → блок
check('display own-line', String.raw`Энергия:

\[ E = mc^2 \]

далее`, ['math(E = mc^2)'])

// 3. Display внутри строки → inline (таблицы/списки не ломаем)
check('display mid-line', String.raw`Равенство \[ a^2 + b^2 = c^2 \] верно`, [
  'inlineMath(a^2 + b^2 = c^2)',
])

// 4. Многострочный display → блок (LaTeX-перенос \\ сохраняется)
check('multi-line display', String.raw`\[
x = y \\
y = z
\]`, ['math(x = y \\\\⏎y = z)'])

// 5. Голое окружение без $$
check('bare align env', String.raw`Формула:

\begin{align}
x = y
\end{align}

конец`, ['math(\\begin{align}⏎x = y⏎\\end{align})'])

// 6. Уже обёрнутое $$...$$ — не трогаем
check('already wrapped', String.raw`$$\begin{align}x\end{align}$$`, [
  'inlineMath(\\begin{align}x\\end{align})',
])

// 7. Код-блок с LaTeX внутри — защита
check(
  'code fence protected',
  'Код:\n```latex\n\\[ x \\]\n```\nконец',
  [],
)

// 8. Инлайн-код — защита
check('inline code protected', 'Инлайн `\\(x\\)` код', [])

// 9. Незакрытый fence (стрим) — защита до конца текста
check(
  'unclosed fence protected (stream)',
  '```latex\n\\[ x \\]\nи ещё \\(y\\)',
  [],
)

// 10. Матрица с \\( — lookbehind не даёт конвертировать
check('matrix \\\\( intact', String.raw`$$\begin{pmatrix} a \\(b) \end{pmatrix}$$`, [
  'inlineMath(\\begin{pmatrix} a \\\\(b) \\end{pmatrix})',
])

// 11. «$$ x» — контент на строке открытия не должен теряться
check(
  'dollar meta-drop fixed',
  String.raw`$$ E = mc^2
F = ma
$$`,
  ['math(E = mc^2⏎F = ma)'],
)

// 12. Таблица — формулы в ячейках остаются inline, структура не ломается
check(
  'table cells',
  String.raw`| Формула | Инлайн |
|---|---|
| \[ x^2 = 4 \] | \(y\) |`,
  ['inlineMath(x^2 = 4)', 'inlineMath(y)'],
)

// 13. Валюты без LaTeX-маркеров — текст не меняется
{
  const cur = 'Цена $5 и $10'
  const norm = normalizeMathDelimiters(cur)
  const ok = norm === cur
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  currency untouched (${JSON.stringify(norm)})`)
}

// 14. \\[ — экранированная скобка не трогается
check('escaped bracket intact', String.raw`Путь C:\\[folder] указан`, [])

// 14a. Экранированные литеральные скобки без математики внутри — не конвертируем
check('literal citation brackets', String.raw`Примечание \[1\] и \[2\], см. \[примечание\]`, [])

// 14b. Но \[ x = y \] с оператором — конвертируем
check('display with operator converts', String.raw`Формула \[ x = y \] верна`, [
  'inlineMath(x = y)',
])

// 15. containsMathMarkers
{
  const cases: Array<[string, boolean]> = [
    ['x \\(y\\) z', true],
    ['\\[x\\]', true],
    ['\\begin{align}', true],
    ['$$x$$', true],
    ['plain text', false],
  ]
  for (const [t, e] of cases) {
    const got = containsMathMarkers(t)
    if (got !== e) {
      failures++
      console.log(`FAIL  containsMathMarkers(${JSON.stringify(t)}) = ${got}, expected ${e}`)
    }
  }
  console.log('PASS  containsMathMarkers (all)')
}

// 16. Идемпотентность: normalize(normalize(x)) === normalize(x)
{
  const inputs = [
    String.raw`Формула \(E = mc^2\) внутри`,
    String.raw`\[ x \]`,
    String.raw`\begin{align}x\end{align}`,
    String.raw`$$ E = mc^2
$$`,
    '```latex\n\\[ x \\]\n```',
    String.raw`| \[ x \] | \(y\) |`,
  ]
  let ok = true
  for (const t of inputs) {
    const once = normalizeMathDelimiters(t)
    const twice = normalizeMathDelimiters(once)
    if (once !== twice) {
      ok = false
      failures++
      console.log(`FAIL  not idempotent: ${JSON.stringify(t)}\n      1: ${JSON.stringify(once)}\n      2: ${JSON.stringify(twice)}`)
    }
  }
  if (ok) console.log('PASS  idempotency (all)')
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
