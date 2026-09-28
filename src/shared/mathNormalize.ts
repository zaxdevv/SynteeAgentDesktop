/**
 * Нормализация LaTeX-разделителей математики к $ / $$ для remark-math.
 *
 * remark-math (micromark-extension-math) понимает ТОЛЬКО `$...$` / `$$...$$`.
 * Многие модели (GPT, GLM, DeepSeek, Qwen…) пишут формулы в LaTeX-стиле:
 *   `\( ... \)`  — инлайн-математика
 *   `\[ ... \]`  — display-математика
 * а иногда и вовсе голые окружения `\begin{align}...\end{align}`.
 * Без нормализации всё это рендерится как текст с обратными слэшами.
 *
 * Правила конвертации (поведение remark-math 6 проверено scripts/math-ast.test.mjs):
 *   `\( x \)`                     → `$x$`            (inline)
 *   `\[ x \]` на отдельной строке → `$$\n x \n$$`    (display-блок: `$$x$$`
 *                                                      в одну строку даёт
 *                                                      inlineMath, а не блок)
 *   `\[ x \]` внутри строки       → `$$x$$`          (inline — перенос строк
 *                                                      сломал бы таблицы/списки)
 *   голый `\begin{env}...\end{env}` → `$$\n...\n$$`  (если уже не внутри $/$$)
 *   `$$ x` с контентом на строке открытия `$$` — контент является «метой»
 *   fence и МОЛЧА УДАЛЯЕТСЯ парсером → контент переносится на следующую строку.
 *
 * Код-блоки (``` / ~~, в т.ч. незакрытые во время стрима) и инлайн-код
 * (`...`) не затрагиваются. Экранированные литеральные скобки (\[1\],
 * \[примечание\] — без математических маркеров внутри) тоже не трогаются.
 */

/** Быстрая проверка: есть ли маркеры, требующие нормализации. */
const NEEDS_NORMALIZE = /\\\(|\\\[|\\begin\{|\$\$[ \t]+\S/

/**
 * Сегменты кода: закрытые fenced-блоки, незакрытые fenced-блоки (хвост
 * стрима — fence до конца текста) и инлайн-код. Нечётные индексы сплита —
 * код, математика внутри них не нормализуется.
 */
const CODE_SPLIT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|```[\s\S]*$|~~~[\s\S]*$|`[^`\n]+`)/g

/** Display-окружения, которые модели иногда пишут без $$-обёртки. */
const DISPLAY_ENV =
  '(?:align|aligned|alignat|flalign|equation|eqnarray|gather|multline|cases|split|array|[pbvBV]?matrix)\\*?'

/**
 * `\( ... \)` / `\[ ... \]` — с negative lookbehind, чтобы не задеть `\\(`
 * (перенос строки `\\` перед скобкой внутри матриц: `a \\ (b)`).
 */
const INLINE_MATH_RE = /(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)/g
const DISPLAY_MATH_RE = /(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g

/** Голое окружение `\begin{env}...\end{env}` (env в \1 для парности). */
const BEGIN_END_RE = new RegExp(
  `\\\\begin\\{(${DISPLAY_ENV})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`,
  'g',
)

/** `$$ x` — контент на строке открытия $$ станет «метой» и удалится парсером. */
const DOLLAR_META_RE = /^([ \t]{0,3})\$\$[ \t]+(\S[^\n]*)$/gm

/** `\begin{...}` стоит в начале строки (перед ним на строке только пробелы). */
function isLineStartOnly(before: string): boolean {
  return /^[ \t]*$/.test(before.slice(before.lastIndexOf('\n') + 1))
}

/** `\end{...}` стоит в конце строки (после него только пробелы). */
function isLineEndOnly(after: string): boolean {
  const nl = after.indexOf('\n')
  return /^[ \t]*$/.test(nl === -1 ? after : after.slice(0, nl))
}

/**
 * Похоже ли содержимое \[...\] на математику. Модели иногда экранируют
 * литеральные скобки (\[1\], \[примечание\]) — их конвертировать нельзя.
 * Математика почти всегда содержит операторы/команды: `\ ^ _ { } = +`.
 */
const MATHISH = /[\\^_{}=+]/

function normalizeSegment(seg: string): string {
  let out = seg

  // 1. \[ ... \] → $$...$$
  out = out.replace(
    DISPLAY_MATH_RE,
    (m: string, body: string, offset: number, s: string) => {
      if (!MATHISH.test(body)) return m // литеральные скобки — не трогаем
      const before = s.slice(0, offset)
      const after = s.slice(offset + m.length)
      // Блочная форма — для многострочных формул и формул на отдельной
      // строке. Инлайн-форма — внутри строки (таблицы, списки), чтобы
      // переносами не ломать структуру.
      if (body.includes('\n') || (isLineStartOnly(before) && isLineEndOnly(after))) {
        // Отступ строки сохраняем у fence (≤3 пробелов — иначе не fence),
        // контент — как есть.
        const indentRaw = before.slice(before.lastIndexOf('\n') + 1)
        const ind = indentRaw.length <= 3 ? indentRaw : ''
        return `\n${ind}$$\n${body.trim()}\n${ind}$$\n`
      }
      return `$$${body.trim()}$$`
    },
  )

  // 2. \( ... \) → $...$
  out = out.replace(INLINE_MATH_RE, (_m: string, body: string) => `$${body.trim()}$`)

  // 3. Голое \begin{env}...\end{env} → блок $$...$$ (если уже не внутри $/$$)
  out = out.replace(
    BEGIN_END_RE,
    (m: string, _env: string, _inner: string, offset: number, s: string) => {
      const before = s.slice(0, offset)
      const after = s.slice(offset + m.length)
      if (before.trimEnd().endsWith('$') || after.trimStart().startsWith('$')) return m
      return `\n$$\n${m}\n$$\n`
    },
  )

  // 4. «$$ x» на строке открытия: x — мета fence, парсер её УДАЛЯЕТ.
  //    Переносим x на следующую строку, если $$ не закрыт на этой же строке.
  out = out.replace(DOLLAR_META_RE, (m: string, indent: string, rest: string) => {
    if (rest.includes('$$')) return m // закрыт на той же строке — inline math
    return `${indent}$$\n${indent}${rest}`
  })

  return out
}

/**
 * Приводит LaTeX-разделители к $ / $$ для remark-math.
 * Код-блоки и инлайн-код не затрагиваются. Идемпотентна.
 */
export function normalizeMathDelimiters(text: string): string {
  if (!text || !NEEDS_NORMALIZE.test(text)) return text
  const parts = text.split(CODE_SPLIT)
  return parts.map((p, i) => (i % 2 === 1 ? p : normalizeSegment(p))).join('')
}

/**
 * Есть ли в сыром тексте маркеры математики (до нормализации).
 * Используется для решения, подключать ли remark-math/rehype-katex.
 */
export function containsMathMarkers(text: string): boolean {
  return /\$|\\\(|\\\[|\\begin\{/.test(text)
}
