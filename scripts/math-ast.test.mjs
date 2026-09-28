// Тест: как remark-math 6 парсит разные варианты записи математики.
// Запуск: node scripts/math-ast.test.mjs
/* eslint-disable no-undef -- standalone node-скрипт, запускается напрямую */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'

const cases = [
  '$x$',                    // 1: классика inline
  '$$x$$',                  // 2: display на одной строке, без пробелов
  '$$\nx\n$$',              // 3: display блок на отдельных строках
  '$ x$',                   // 4: пробел после открывающего $
  '$x $',                   // 5: пробел перед закрывающим $
  '$$ x $$',                // 6: display с пробелами
  '$$ x\n$$',               // 7: display, пробел после $$, перенос перед $$
  'text $$x$$ text',        // 8: display inline внутри параграфа
  'a\n$$\nb\n$$\nc',        // 9: блоки вокруг текста
  '$$\\begin{align}x\\end{align}$$', // 10: display с env внутри
  'text $5 and $10',        // 11: валюты (не должно стать math)
  '$$\\frac{a}{b}$$',       // 12: display с командами
]

const processor = unified().use(remarkParse).use(remarkMath)

const walk = (n, out = []) => {
  if (n.type === 'inlineMath' || n.type === 'math') {
    out.push(`${n.type}(${JSON.stringify(n.value)})`)
  }
  ;(n.children || []).forEach(c => walk(c, out))
  return out
}

for (const c of cases) {
  const tree = processor.parse(c)
  const found = walk(tree)
  console.log(
    `${JSON.stringify(c).padEnd(42)} -> ${found.length ? found.join(', ') : '(NO MATH)'}`
  )
}
