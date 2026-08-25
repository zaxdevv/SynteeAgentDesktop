// ── remark-плагин: делает пути файлов/папок в сообщениях кликабельными ───
//
// Проходит по mdast, находит text- и inlineCode-ноды, regex-ом разбивает на
// сегменты: пути → link-ноды с URL scheme file-path:// (кликабельные).
//
// Матчит:
// - Файлы: src/foo/bar.ts, C:\Projects\file.ts, ~/notes.txt (+ кириллица)
// - Папки: src/components, C:\Projects\assets, /usr/local/bin, ~/docs
// - Суффиксы строк: src/foo.ts:42, src/foo.ts:42-58, стек-трейс src/foo.ts:42:15
// - Пути в бэктиках: `src/foo.ts` → кликабельный code-спан (AI пишет так чаще всего)
//
// Не применяется во время стриминга (для производительности).
// Используется в MessageBubble.tsx через createMdComponents.
//
// ВАЖНО: используем link-ноды (не html-ноды), т.к. react-markdown
// без rehype-raw НЕ рендерит raw HTML. Link-ноды рендерятся как <a>,
// а наш компонент `a` в createMdComponents перехватывает клик.

import type { Plugin } from 'unified'
import type { Root, Text, InlineCode, Parent, PhrasingContent, Link } from 'mdast'

// ── Regex для детекта путей ────────────────────────────────────────────────
//
// FILE — файл с расширением (как раньше):
//   относительные src/foo/bar.ts, абсолютные C:\..., /home/..., ~/...
// FOLDER — папка:
//   C:\Projects, C:/a/b — диск + 1+ сегментов (Windows-папки часто короткие);
//   ~/docs — дом + 1+ сегментов (ложных срабатываний у ~ нет);
//   /usr/local/bin — слэш + 2+ сегментов: односегментные «/g», «/div», «/p»
//   (regex-флаги, закрывающие HTML-теги </div>) — почти всегда мусор;
//   относительная — 2+ разделителя (src/renderer/src) всегда,
//   либо 1 разделитель с «техническим» первым сегментом (src/components,
//   node_modules/foo) — фильтр isLikelyFolder() отсекает прозу вида
//   «and/or», «read/write», «input/output».
//
// LINE — суффикс позиции: :42 | :42-58 | :42:15 (стек-трейсы).
// Захватывается в общий m[1] (отображается), парсится splitPathLine().
//
// Lookbehind (?<![\w~./\\-]) — путь подсвечивается и после скобки/кавычки/
// двоеточия/запятой — AI часто пишет пути в скобках «(src/foo.ts)».
// Trailing (?![\w-]) — не отрывать путь от продолжающегося слова.
// Не матчит: URL (https://site.com/a.ts — сегмент после домена закрыт
// lookbehind), email (@), версии (v1.2.3 без слэшей).
//
// Экспортируется — renderClickablePlainText в MessageBubble и link-provider
// терминала используют тот же regex, чтобы подсветка не разъезжалась.
const SEG = '[\\w.\\u0400-\\u04FF-]+'
const FILE_CORE = `(?:[a-zA-Z]:[\\\\/])?[~/]?(?:${SEG}[\\\\/])+${SEG}\\.\\w{1,10}`
const FOLDER_WIN = `[a-zA-Z]:[\\\\/](?:${SEG}[\\\\/])*${SEG}`
const FOLDER_HOME = `~/(?:${SEG}[\\\\/])*${SEG}`
const FOLDER_UNIX = `/(?:${SEG}[\\\\/])+${SEG}`
const FOLDER_ABS = `(?:${FOLDER_WIN}|${FOLDER_HOME}|${FOLDER_UNIX})`
const FOLDER_REL = `(?:${SEG}[\\\\/])+${SEG}`
const LINE_SUFFIX = '(?::\\d+(?:-\\d+)?)?(?::\\d+)?'

export const PATH_RE = new RegExp(
  `(?<![\\w~./\\\\-])((?:${FILE_CORE}|${FOLDER_ABS}|${FOLDER_REL})${LINE_SUFFIX})(?![\\w-])`,
  'g',
)

// ── Фильтр ложных срабатываний для относительных папок с 1 разделителем ──
// «src/components» — да; «and/or», «read/write» — нет. Первый сегмент должен
// быть известной корневой папкой либо содержать «технические» символы
// (цифра, точка, подчёркивание, дефис, кириллицу).
const KNOWN_ROOT_DIRS = new Set([
  'src', 'lib', 'test', 'tests', 'spec', 'e2e', 'app', 'apps', 'core', 'main',
  'renderer', 'preload', 'shared', 'public', 'static', 'assets', 'docs', 'doc',
  'scripts', 'config', 'configs', 'tools', 'utils', 'util', 'components',
  'pages', 'views', 'store', 'stores', 'styles', 'style', 'types',
  'interfaces', 'api', 'ui', 'node_modules', 'resources', 'examples',
  'packages', 'plugins', 'modules', 'services', 'models', 'routes',
  'handlers', 'commands', 'events', 'hooks', 'contexts', 'layouts',
  'features', 'widgets', 'constants', 'helpers', 'fixtures', 'mocks',
  'data', 'bin', 'coverage', 'migrations', 'seeds', 'server', 'client',
  'web', 'desktop', 'mobile', 'common', 'infra', 'devops', '.github',
  '.vscode', '.planning', '.idea',
])

/** true, если совпадение FOLDER_REL похоже на настоящую папку, а не на прозу.
 *  Консервативно: ложный пропуск лучше ложной подсветки — визуально путь
 *  всё равно подсветится только если существует на диске (pathStatus-гейтинг
 *  в FilePathLink), а вот лишние IPC-статы на прозе нам не нужны. */
function isLikelyFolder(match: string): boolean {
  const norm = match.replace(/\\/g, '/')
  // Абсолютные пути (C:/, /, ~/) — всегда валидны, фильтр только для относительных
  if (/^[a-zA-Z]:\//.test(norm) || norm.startsWith('/') || norm.startsWith('~/')) return true
  const seps = (norm.match(/\//g) || []).length
  if (seps >= 2) return true
  // 1 разделитель: только известные корневые папки (src/components).
  // Никаких эвристик «цифра/точка/кириллица» — они пропускали прозу
  // «24/7», «и/или», «10/15» (главный источник жалоб на лишнюю подсветку).
  const first = norm.split('/')[0]
  return KNOWN_ROOT_DIRS.has(first.toLowerCase())
}

/** Проверяет валидность совпадения PATH_RE (после splitPathLine). */
export function isValidPathMatch(full: string): boolean {
  const { path } = splitPathLine(full)
  const hasExt = /\.\w{1,10}$/.test(path)
  if (hasExt) return true // файл — матчится только FILE-альтернативой
  return isLikelyFolder(path)
}

// ── Парсинг «path:line-col» ───────────────────────────────────────────────
export interface ParsedFilePath {
  /** Путь без суффикса позиции */
  path: string
  /** :42 — строка */
  line?: number
  /** :42-58 — конец диапазона */
  lineEnd?: number
  /** :42:15 — колонка (стек-трейсы) */
  col?: number
}

/** Отделяет от пути суффикс позиции: `src/foo.ts:42-58` → path + line 42..58. */
export function splitPathLine(raw: string): ParsedFilePath {
  const m = /^(.*?)(?::(\d+)(?:-(\d+))?(?::(\d+))?)?$/.exec(raw)
  if (!m) return { path: raw }
  return {
    path: m[1] || raw,
    line: m[2] ? Number(m[2]) : undefined,
    lineEnd: m[3] ? Number(m[3]) : undefined,
    col: m[4] ? Number(m[4]) : undefined,
  }
}

function isInsideLink(parents: Parent[]): boolean {
  return parents.some(p => p.type === 'link')
}

// Простой обход дерева без unist-util-visit. Посещаем text и inlineCode —
// AI чаще всего пишет пути именно в бэктиках, а value inlineCode не является
// text-нодой (нет children), поэтому раньше они не подсвечивались.
function visitPathNodes(
  tree: Root,
  visitor: (node: Text | InlineCode, index: number, parent: Parent) => [number, Parent] | void,
) {
  const walk = (node: Parent, parents: Parent[]) => {
    const children = node.children
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if ((child.type === 'text' || child.type === 'inlineCode') && !isInsideLink(parents)) {
        const result = visitor(child as Text | InlineCode, i, node)
        if (result) {
          i = result[0]
        }
        continue
      }
      if (child && typeof child === 'object' && 'children' in child) {
        walk(child as Parent, [...parents, child as Parent])
      }
    }
  }
  walk(tree, [])
}

export const remarkFilePaths: Plugin<[], Root> = () => {
  return (tree: Root) => {
    visitPathNodes(tree, (node, index, parent) => {
      const text = node.value
      if (!text.includes('/') && !text.includes('\\')) return

      const segments: Array<{ text: string; isPath: boolean }> = []
      let lastIdx = 0
      let m: RegExpExecArray | null
      const re = new RegExp(PATH_RE.source, 'g')
      let found = false

      while ((m = re.exec(text)) !== null) {
        const full = m[1]
        // Папка-«проза» (and/or) — пропускаем, оставляем простым текстом
        if (!isValidPathMatch(full)) continue
        found = true
        const pathStart = m.index + (m[0].length - m[1].length)
        if (pathStart > lastIdx) {
          segments.push({ text: text.slice(lastIdx, pathStart), isPath: false })
        }
        segments.push({ text: full, isPath: true })
        lastIdx = pathStart + full.length
      }

      if (!found) return

      if (lastIdx < text.length) {
        segments.push({ text: text.slice(lastIdx), isPath: false })
      }

      // Заменяем ноду на массив нод (text/inlineCode + link).
      // Link-ноды с URL scheme file-path:// рендерятся react-markdown как <a>,
      // а наш компонент `a` перехватывает клик. Для inlineCode-источника
      // сохраняем code-стайлинг: link > inlineCode.
      const wasCode = node.type === 'inlineCode'
      const newNodes: PhrasingContent[] = segments.map(seg => {
        if (seg.isPath) {
          const linkNode: Link = {
            type: 'link',
            url: `file-path://${encodeURIComponent(seg.text)}`,
            children: [wasCode
              ? { type: 'inlineCode', value: seg.text }
              : { type: 'text', value: seg.text }],
          }
          return linkNode as unknown as PhrasingContent
        }
        return (wasCode
          ? { type: 'inlineCode', value: seg.text }
          : { type: 'text', value: seg.text }) as unknown as PhrasingContent
      })

      parent.children.splice(index, 1, ...newNodes)
      return [index + newNodes.length - 1, parent]
    })
  }
}

/**
 * Резолв относительного пути от workdir.
 * Если путь уже абсолютный — возвращает как есть.
 */
export function resolveFilePath(rawPath: string, workdir?: string): string {
  // Нормализуем Windows-слэши
  const p = rawPath.replace(/\\/g, '/')

  // Абсолютный путь
  if (/^[a-zA-Z]:\//.test(p) || p.startsWith('/') || p.startsWith('~')) {
    return p
  }

  // Относительный — резолв от workdir
  if (workdir) {
    const wd = workdir.replace(/\\/g, '/').replace(/\/$/, '')
    return `${wd}/${p}`
  }

  return p
}

/**
 * Лексическая нормализация: сворачивает сегменты `.` и `..` БЕЗ обращения к
 * диску. `C:/a/b/../c` → `C:/a/c`; относительный `../x` остаётся `../x`
 * (вышел за корень). Нужна до inside-проверки workdir: иначе relPath с `..`
 * уходит в fs:readFile → safeJoin режет его с ошибкой «Path outside root».
 */
export function normalizePath(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const prefixMatch = /^([a-zA-Z]:\/|\/|~\/)/.exec(norm)
  const prefix = prefixMatch ? prefixMatch[1] : ''
  const rest = norm.slice(prefix.length)
  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop()
      } else if (!prefix) {
        out.push('..') // относительный путь выше «корня» — сохраняем
      }
      // с префиксом (C:/, /) — выше корня не поднимаемся, клампим
      continue
    }
    out.push(seg)
  }
  return prefix + out.join('/')
}
