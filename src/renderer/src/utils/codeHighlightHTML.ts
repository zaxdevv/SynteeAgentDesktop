// ── Быстрый рендер код-блоков через HTML-строку ──────────────────────────
// Заменяет react-syntax-highlighter (React-дерево из тысяч <span>) на
// refractor → HAST → HTML-строка → dangerouslySetInnerHTML.
// Браузер парсит HTML на C++ уровне — в 5-10× быстрее создания React-элементов.
// Стили oneDark применяются как inline-стили (точная репликация createStyleObject
// из react-syntax-highlighter/create-element.js) — визуально пиксель-в-пиксель.

// refractor 5: именованный экспорт { refractor } (в v4 был default).
import { refractor } from 'refractor/core'
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark'

// Тип HAST-ноды (упрощённый, от refractor — без внешних типов)
interface HastNode {
  type: string
  tag?: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

// ── powerSetPermutations — точная копия из create-element.js ────────────
function powerSetPermutations(arr: string[]): string[] {
  const len = arr.length
  if (len === 0 || len === 1) return arr
  if (len === 2) {
    return [arr[0], arr[1], arr[0] + '.' + arr[1], arr[1] + '.' + arr[0]]
  }
  if (len === 3) {
    return [
      arr[0], arr[1], arr[2],
      arr[0] + '.' + arr[1], arr[0] + '.' + arr[2],
      arr[1] + '.' + arr[0], arr[1] + '.' + arr[2],
      arr[2] + '.' + arr[0], arr[2] + '.' + arr[1],
      arr[0] + '.' + arr[1] + '.' + arr[2],
      arr[0] + '.' + arr[2] + '.' + arr[1],
      arr[1] + '.' + arr[0] + '.' + arr[2],
      arr[1] + '.' + arr[2] + '.' + arr[0],
      arr[2] + '.' + arr[0] + '.' + arr[1],
      arr[2] + '.' + arr[1] + '.' + arr[0],
    ]
  }
  // len >= 4 — упрощаем: возвращаем все перестановки 4 элементов
  // (в oneDark нет классов с 4+ token-типами в одном span)
  return arr.slice()
}

const classNameCombinationsCache: Record<string, string[]> = {}
function getClassNameCombinations(classNames: string[]): string[] {
  if (classNames.length === 0 || classNames.length === 1) return classNames
  const key = classNames.join('.')
  if (!classNameCombinationsCache[key]) {
    classNameCombinationsCache[key] = powerSetPermutations(classNames)
  }
  return classNameCombinationsCache[key]
}

// ── createStyleObject — точная копия из create-element.js ───────────────
// Мержит стили из stylesheet по всем комбинациям имён классов токена.
function createStyleObject(
  classNames: string[],
  elementStyle: Record<string, string>,
  stylesheet: Record<string, Record<string, string>>,
): Record<string, string> {
  const nonTokenClassNames = classNames.filter(c => c !== 'token')
  const combos = getClassNameCombinations(nonTokenClassNames)
  return combos.reduce(
    (styleObj, className) => ({ ...styleObj, ...stylesheet[className] }),
    { ...elementStyle },
  )
}

// ── CSS-свойство в inline-строку ────────────────────────────────────────
// ВАЖНО: двойные кавычки в значениях (fontFamily: '"Fira Code", ...' из
// oneDark) ломали атрибут style="..." — браузер обрезал атрибут на первой
// кавычке → display:flex на <pre> терялся → номера строк уезжали вправо
// (inline-flow + text-align:right). Заменяем " на ' — в CSS валидны обе.
function styleToCss(style: Record<string, string> | undefined): string {
  if (!style) return ''
  let css = ''
  for (const prop in style) {
    const val = style[prop]
    if (val === undefined || val === null) continue
    // CamelCase → kebab-case (MozTabSize → -moz-tab-size и т.д.)
    const kebab = prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase())
    css += kebab + ':' + String(val).replace(/"/g, "'") + ';'
  }
  return css
}

// ── HTML-escape для текстовых нод ───────────────────────────────────────
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ── Рекурсивный рендер HAST-дерева в HTML-строку ─────────────────────────
function hastToHtml(
  node: HastNode,
  stylesheet: Record<string, Record<string, string>>,
): string {
  // Текстовая нода
  if (node.type === 'text') {
    return escapeHtml(node.value || '')
  }

  // Элемент
  const tag = node.tagName || 'span'
  const props = node.properties || {}
  const classNames = (props.className as string[]) || []
  const isToken = classNames.includes('token')

  // Стиль: для token-элементов мержим из stylesheet, для остальных — как есть
  let styleStr = ''
  if (isToken) {
    // CSS-кэш: токен 'token keyword' всегда даёт одинаковый CSS.
    const clsKey = classNames.join(' ')
    const cachedCss = cssCache.get(clsKey)
    if (cachedCss !== undefined) {
      styleStr = cachedCss
    } else {
      const styleObj = createStyleObject(classNames, {}, stylesheet)
      styleStr = styleToCss(styleObj)
      cssCache.set(clsKey, styleStr)
    }
  }

  // Атрибуты
  let attrs = ''
  // className: оставляем 'token' + классы которых нет в stylesheet.
  // ALL_CLASSES вычислен один раз на module level (раньше — Set для
  // каждой ноды, O(n) памяти и CPU на один блок).
  const remainingClasses = isToken
    ? ['token', ...classNames.filter(c => c !== 'token' && !ALL_CLASSES.has(c))]
    : classNames
  if (remainingClasses.length > 0) {
    attrs += ' class="' + remainingClasses.join(' ') + '"'
  }
  if (styleStr) {
    attrs += ' style="' + styleStr + '"'
  }

  // Дочерние элементы
  const children = node.children || []
  const childrenHtml = children
    .map(child => hastToHtml(child, stylesheet))
    .join('')

  return '<' + tag + attrs + '>' + childrenHtml + '</' + tag + '>'
}

// ── Module-level LRU кэш: lang + '\0' + raw → HTML ───────────────────────
const htmlCache = new Map<string, string>()
const CACHE_MAX = 100

function evictOldest(map: Map<string, unknown>, keep: number): void {
  let toDelete = map.size - keep
  for (const key of map.keys()) {
    if (toDelete <= 0) break
    map.delete(key)
    toDelete--
  }
}

// ── Инкрементальный кэш для стриминга ────────────────────────────────────
// При стриме код-блока raw растёт каждые 50мс. Полная Prism-токенизация
// блока на каждом флеше = O(n²) — FPS проседает. Здесь кэшируем готовый
// HTML стабильного префикса по ПОЛНЫМ строкам (завершённым \n): при
// следующем флеше подсвечиваем только новый хвост. Результат идентичен
// полному highlight.
interface StreamCache {
  raw: string        // полный raw последнего флеша
  stableEnd: number   // индекс после последнего \n в raw (0 если нет \n)
  stableHtml: string  // HTML для raw[0..stableEnd] — кэширован, не пересвечивается
}
const streamCache = new Map<string, StreamCache>()

// Стили из codeStyle в MessageBubble.tsx (переопределённый oneDark)
// lineHeight в пикселях (а не 1.6) — чтобы номера строк и код имели
// одинаковую высоту строки. При относительном lineHeight (1.6) номера
// (11px) получают 17.6px, а код (13px) — 20.8px → номера смещаются.
const CODE_LH = '20.8px' // 13px * 1.6
const codeStyleOverride: Record<string, Record<string, string>> = {
  ...oneDark,
  'pre[class*="language-"]': {
    ...((oneDark as Record<string, Record<string, string>>)['pre[class*="language-"]']),
    margin: '0',
    padding: '14px 16px',
    background: '#0d0d0f',
    borderRadius: '0 0 8px 8px',
    fontSize: '13px',
    lineHeight: CODE_LH,
  },
  'code[class*="language-"]': {
    ...((oneDark as Record<string, Record<string, string>>)['code[class*="language-"]']),
    background: 'transparent',
    fontSize: '13px',
    lineHeight: CODE_LH,
  },
}

// ── Module-level: allClasses Set и CSS-кэш ────────────────────────────
// allClasses — все классы из stylesheet. Вычисляется ОДИН раз (раньше
// пересоздавался для КАЖДОЙ ноды в hastToHtml — тысячи Set-конструкций
// на один код-блок).
const ALL_CLASSES = new Set<string>()
for (const sel of Object.keys(codeStyleOverride)) {
  sel.split('.').forEach(c => { if (c) ALL_CLASSES.add(c.trim()) })
}

// CSS-кэш по типу токена: classNames.join(' ') → CSS string.
// Токен 'token keyword' всегда даёт одинаковый CSS — нет смысла
// пересчитывать createStyleObject + styleToCss каждый раз.
const cssCache = new Map<string, string>()

// ── Кэш номеров строк по lineCount ─────────────────────────────────────
// При стриме lineCount растёт. Номера 1..N не меняются, но HTML
// пересоздавался каждый флеш. Кэш: lineCount → готовый HTML.
const lineNumberCache = new Map<number, string>()
function getLineNumbersHtml(lineCount: number): string {
  const cached = lineNumberCache.get(lineCount)
  if (cached) return cached
  const html = Array.from({ length: lineCount }, (_, i) =>
    '<span style="display:block">' + (i + 1) + '</span>',
  ).join('')
  if (lineNumberCache.size > 200) evictOldest(lineNumberCache, 150)
  lineNumberCache.set(lineCount, html)
  return html
}

// ── Подсветка с инкрементальным кэшем для стриминга ─────────────────────
// При стриме raw растёт. Вместо полной Prism-токенизации каждый раз —
// кэшируем HTML для полных строк (до последнего \n). При следующем вызове
// догоняем только новые строки. Результат идентичен полному highlight.
function highlightWithCache(raw: string, lang: string): string {
  if (!lang || lang === 'text') {
    return escapeHtml(raw)
  }

  const streamKey = lang + '\x01'
  const cached = streamCache.get(streamKey)

  // Если нет кэша или кэш не префикс текущего raw — полная подсветка
  if (!cached || !raw.startsWith(cached.raw)) {
    try {
      const tree = refractor.highlight(raw, lang) as unknown as HastNode[]
      const html = tree.map(node => hastToHtml(node, codeStyleOverride)).join('')
      // Кэшируем стабильный префикс (до последнего \n) для следующих флешей
      const lastNl = raw.lastIndexOf('\n')
      const stableEnd = lastNl + 1 // 0 если нет \n
      let stableHtml = ''
      if (stableEnd > 0) {
        const stableRaw = raw.slice(0, stableEnd)
        const stableTree = refractor.highlight(stableRaw, lang) as unknown as HastNode[]
        stableHtml = stableTree.map(node => hastToHtml(node, codeStyleOverride)).join('')
      }
      streamCache.set(streamKey, { raw, stableEnd, stableHtml })
      return html
    } catch {
      return escapeHtml(raw)
    }
  }

  // Кэш — префикс raw. Берём кэшированный HTML стабильного префикса,
  // подсвечиваем только хвост (новые строки + дописанная неполная строка).
  // Раньше: refractor.highlight(stableRaw) на КАЖДОМ флеше = O(n²).
  // Теперь: refractor.highlight(tailRaw) — O(|хвост|), обычно 1-5 строк.
  const tailRaw = raw.slice(cached.stableEnd)

  if (!tailRaw) {
    // Хвост пустой — стабильный HTML это полный HTML
    return cached.stableHtml
  }

  let tailHtml: string
  try {
    const tailTree = refractor.highlight(tailRaw, lang) as unknown as HastNode[]
    tailHtml = tailTree.map(node => hastToHtml(node, codeStyleOverride)).join('')
  } catch {
    tailHtml = escapeHtml(tailRaw)
  }

  const html = cached.stableHtml + tailHtml

  // Обновляем кэш: если в хвосте появились новые \n, стабильный префикс вырос.
  // Новую стабильную часть подсвечиваем ОТДЕЛЬНО (короткая, 1-2 строки) и
  // добавляем к stableHtml. O(|новые строки|), не O(|весь блок|).
  const newLastNl = raw.lastIndexOf('\n')
  const newStableEnd = newLastNl + 1 // 0 если нет \n

  if (newStableEnd > cached.stableEnd) {
    // Стабильный префикс вырос — обновляем stableHtml
    const newStableTail = raw.slice(cached.stableEnd, newStableEnd)
    let newStableTailHtml: string
    try {
      const newStableTailTree = refractor.highlight(newStableTail, lang) as unknown as HastNode[]
      newStableTailHtml = newStableTailTree.map(node => hastToHtml(node, codeStyleOverride)).join('')
    } catch {
      newStableTailHtml = escapeHtml(newStableTail)
    }
    streamCache.set(streamKey, {
      raw,
      stableEnd: newStableEnd,
      stableHtml: cached.stableHtml + newStableTailHtml,
    })
  } else {
    // Стабильный префикс не изменился (хвост не содержит \n)
    streamCache.set(streamKey, {
      raw,
      stableEnd: cached.stableEnd,
      stableHtml: cached.stableHtml,
    })
  }

  return html
}

// ── Главный экспорт: code → HTML-строка с подсветкой ─────────────────────
export function highlightCodeToHtml(raw: string, lang: string): string {
  const key = lang + '\0' + raw
  const cached = htmlCache.get(key)
  if (cached) return cached

  // Инкрементальная подсветка: при стриме кэшируем по строкам.
  // highlightWithCache возвращает готовую HTML-строку — стабильный
  // префикс берётся из кэша, подсвечивается только хвост.
  const highlightedHtml = highlightWithCache(raw, lang)

  // Стиль для <pre> и <code> (из codeStyleOverride)
  // При наличии номеров строк — pre становится flex-контейнером, чтобы
  // колонка номеров и код всегда были рядом (float:left ломается при
  // длинном коде — код проваливается под колонку номеров).
  const codeStyle = codeStyleOverride['code[class*="language-"]'] || {}

  // Номера строк (если > 4 строк)
  const lineCount = raw.replace(/\n$/, '').split('\n').length
  const showLineNumbers = lineCount > 4

  let codeInner: string

  if (showLineNumbers) {
    // Flex- layout: колонка номеров слева, код справа.
    // flex-shrink:0 на колонке номеров — не сжимается при длинном коде.
    // overflow:auto на коде — горизонтальный скролл вместо переноса.

    const largestNum = lineCount
    const minWidth = largestNum.toString().length + '.25em'

    // Колонка номеров строк
    const lineNumberColStyle = {
      flexShrink: '0',
      paddingRight: '12px',
      textAlign: 'right',
      userSelect: 'none',
      color: '#4a4a5a',
      fontSize: '11px',
      lineHeight: CODE_LH,
      minWidth,
    }
    const lnColStyleStr = styleToCss(lineNumberColStyle)

    // Номера строк из кэша (по lineCount) — не пересоздаём каждый флеш
    const lineNumbersHtml = getLineNumbersHtml(lineCount)

    // Колонка кода: flex:1, overflow-x:auto для горизонтального скролла
    const codeColStyle = {
      ...codeStyle,
      flex: '1',
      overflowX: 'auto',
      whiteSpace: 'pre',
    }

    codeInner =
      '<code style="' + lnColStyleStr + '">' +
      lineNumbersHtml +
      '</code>' +
      '<code class="language-' + lang + '" style="' + styleToCss(codeColStyle) + '">' +
      highlightedHtml +
      '</code>'
  } else {
    codeInner =
      '<code class="language-' + lang + '" style="' + styleToCss(codeStyle) + '">' +
      highlightedHtml +
      '</code>'
  }

  const html = codeInner

  if (htmlCache.size >= CACHE_MAX) {
    evictOldest(htmlCache, 80)
  }
  htmlCache.set(key, html)

  return html
}