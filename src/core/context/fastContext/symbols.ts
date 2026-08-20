import { readFile } from 'fs/promises'
import { getLangForFile, getParser, loadLanguage, type TSNode, type TSLanguage } from './state'

// ─── Symbol extraction ──────────────────────────────────────────────────────
// Унифицированный список типов узлов tree-sitter, представляющих определения.
// Разные грамматики используют разные имена — покрываем все встреченные.

const DEFINITION_NODE_TYPES = new Set([
  // functions / methods
  'function_declaration', 'function_definition', 'function_item',
  'method_definition', 'method_declaration', 'function_declarator',
  'arrow_function', 'function_expression',
  // classes / structs / interfaces / traits
  'class_declaration', 'class_definition', 'class_specifier',
  'interface_declaration', 'interface_declaration_first',
  'trait_item', 'impl_item', 'impl_block',
  'struct_declaration', 'struct_specifier', 'struct_item',
  'enum_declaration', 'enum_specifier', 'enum_item',
  'union_specifier', 'union_declaration',
  'type_declaration', 'type_alias_declaration', 'type_definition',
  'type_specifier',
  // module / namespace / package
  'module_declaration', 'module_definition', 'namespace_declaration',
  'package_declaration', 'package_clause',
  // variables (top-level / exports)
  'variable_declaration', 'lexical_declaration',
  'const_declaration', 'const_item', 'static_variable_declaration',
  // misc
  'constructor_declaration', 'destructor_declaration',
  'decorator', 'decorator_definition', 'attribute_item',
  'macro_definition', 'macro_rules',
  'protocol_declaration', 'protocol_', // swift/erlang
])

// Контейнерные типы — в них рекурсивно ищем методы/поля (class→method, interface→method)
const CONTAINER_NODE_TYPES = new Set([
  'class_declaration', 'class_definition', 'class_specifier',
  'interface_declaration', 'interface_declaration_first',
  'trait_item', 'impl_item', 'impl_block',
  'struct_declaration', 'struct_specifier', 'struct_item',
  'enum_declaration', 'enum_specifier', 'enum_item',
  'union_specifier', 'union_declaration',
  'module_declaration', 'module_definition', 'namespace_declaration',
  'package_declaration', 'package_clause',
])

// Типы узлов для ссылок (imports / requires / from-imports)
const IMPORT_NODE_TYPES = new Set([
  'import_statement', 'import_declaration', 'import_from_statement',
  'import_specifier', 'import_clause', 'use_declaration', 'use_statement',
  'package_clause', 'extern_crate_declaration', 'mod_item',
  'include_directive', 'preproc_include',
  'require_statement', 'require_expression',
  'from_import_statement',
])

export interface SymbolDef {
  name: string
  kind: string  // 'function' | 'class' | 'method' | 'variable' | ...
  lineStart: number
  lineEnd: number
  signature: string  // первая строка определения (для repo-map)
  parentName?: string  // имя родительского класса/интерфейса (для иерархии)
}

export interface FileSymbols {
  definitions: SymbolDef[]
  imports: string[]  // имена импортируемых модулей/файлов (raw строка)
  references: string[]  // уникальные идентификаторы из исходника (для call-site graph edges)
}

/** Извлекает имя определения из узла (ищет именованное поле name/declarator, затем первый identifier). */
function extractName(node: TSNode): string {
  // 1. Именованные поля (web-tree-sitter API: childForFieldName)
  if (node.childForFieldName) {
    for (const field of ['name', 'declarator', 'type', 'key']) {
      const child = node.childForFieldName(field)
      if (child && child.text) return child.text
    }
  }
  // 2. Fallback — первый named child с типом identifier
  for (const c of node.namedChildren) {
    if (c.type === 'identifier' || c.type === 'type_identifier' ||
        c.type === 'property_identifier' || c.type === 'field_identifier' ||
        c.type === 'constructor') {
      return c.text
    }
  }
  return ''
}

/** Краткая сигнатура: первая строка определения, обрезанная до 100 символов. */
function extractSignature(node: TSNode): string {
  const text = node.text || ''
  const firstLine = text.split('\n')[0]?.trim() || ''
  return firstLine.slice(0, 100)
}

/** Категория kind из типа узла. */
function kindFromNodeType(type: string): string {
  if (type.includes('function') || type.includes('method')) return 'function'
  if (type.includes('class')) return 'class'
  if (type.includes('interface') || type.includes('protocol')) return 'interface'
  if (type.includes('struct')) return 'struct'
  if (type.includes('enum')) return 'enum'
  if (type.includes('trait') || type.includes('impl')) return 'impl'
  if (type.includes('type')) return 'type'
  if (type.includes('module') || type.includes('namespace') || type.includes('package')) return 'module'
  if (type.includes('const') || type.includes('variable')) return 'variable'
  if (type.includes('constructor')) return 'constructor'
  if (type.includes('macro')) return 'macro'
  return 'definition'
}

/** Walk AST и собирает definitions + imports. Рекурсивно входит в классы/интерфейсы
 *  для извлечения методов с parentName (иерархия Class→method). */
function walkAndExtract(root: TSNode): FileSymbols {
  const definitions: SymbolDef[] = []
  const imports: string[] = []

  // Стек хранит узел + имя родительского контейнера (для методов внутри классов)
  const stack: Array<{ node: TSNode; parentName: string | null }> = [{ node: root, parentName: null }]
  const visited = new Set<TSNode>()
  let nodeCount = 0
  // 20k AST-узлов хватит для файлов до ~5-8k строк. Cap снижает CPU на огромных
  // файлах (минифицированные/сгенерированные) и не блокирует воркер надолго.
  const MAX_NODES = 20000

  while (stack.length > 0 && nodeCount < MAX_NODES) {
    const { node, parentName } = stack.pop()!
    if (visited.has(node)) continue
    visited.add(node)
    nodeCount++

    if (DEFINITION_NODE_TYPES.has(node.type)) {
      const name = extractName(node)
      if (name) {
        definitions.push({
          name,
          kind: kindFromNodeType(node.type),
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          signature: extractSignature(node),
          parentName: parentName ?? undefined,
        })
      }
      // Контейнерные типы — рекурсивно ищем методы/поля внутри
      if (CONTAINER_NODE_TYPES.has(node.type) && name) {
        if (node.children && node.children.length > 0) {
          for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push({ node: node.children[i], parentName: name })
          }
        }
      }
      continue
    }

    if (IMPORT_NODE_TYPES.has(node.type)) {
      const text = node.text?.split('\n')[0]?.trim() || ''
      if (text) imports.push(text.slice(0, 120))
      continue
    }

    if (node.children && node.children.length > 0) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i], parentName })
      }
    }
  }

  return { definitions, imports, references: [] }
}

/** Парсит файл и извлекает символы. null = не удалось (нет грамматики / ошибка).
 *  maxFileSizeBytes — лимит размера файла (default 1.5MB).
 *  skipReferencesAboveBytes — пропустить regex-scan references (call-site graph
 *  edges) для файлов крупнее этого размера. Снижает CPU на больших файлах. */
export async function extractSymbols(
  filePath: string,
  opts: { maxFileSizeBytes?: number; skipReferencesAboveBytes?: number } = {},
): Promise<FileSymbols | null> {
  const maxBytes = opts.maxFileSizeBytes ?? 1_500_000
  const skipRefsAbove = opts.skipReferencesAboveBytes ?? Infinity
  const langId = getLangForFile(filePath)
  if (!langId) return null

  const lang = await loadLanguage(langId)
  if (!lang) return null

  let source: string
  try {
    source = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
  if (!source || source.length > maxBytes) return null

  return extractSymbolsFromSource(filePath, source, lang, { skipReferencesAboveBytes: skipRefsAbove })
}

// ─── Common local names blacklist ───────────────────────────────────────────
// Эти имена встречаются в коде повсеместно как локальные переменные/параметры,
// но почти никогда не являются external function calls. Включение их в
// references создаёт ложные edges в PageRank (файл A "ссылается" на файл B
// только потому что оба используют переменную "result"). Фильтруем.
const COMMON_LOCAL_NAMES = new Set([
  'result', 'error', 'data', 'value', 'values', 'item', 'items', 'index',
  'count', 'length', 'size', 'name', 'type', 'types', 'path', 'paths',
  'file', 'files', 'self', 'this', 'that', 'args', 'opts', 'options',
  'config', 'state', 'props', 'event', 'target', 'source', 'target',
  'callback', 'resolve', 'reject', 'promise', 'response', 'request',
  'context', 'ctx', 'req', 'res', 'next', 'prev', 'start', 'end',
  'text', 'content', 'body', 'head', 'tail', 'first', 'last', 'curr',
  'current', 'entry', 'exit', 'status', 'code', 'message', 'reason',
  'object', 'array', 'string', 'number', 'boolean', 'function',
  'console', 'window', 'document', 'global', 'process', 'module',
  'exports', 'require', 'import', 'default', 'class', 'return',
  'const', 'let', 'var', 'null', 'true', 'false', 'undefined',
  'then', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
  'push', 'pop', 'slice', 'splice', 'split', 'join', 'map', 'filter',
  'reduce', 'forEach', 'some', 'every', 'find', 'keys', 'entries',
  'assign', 'create', 'freeze', 'from', 'isArray', 'parse', 'stringify',
  'log', 'warn', 'error_fn', 'info', 'debug', 'trace',
])

/** Извлекает символы из уже прочитанного исходника (не делает I/O).
 *  Используется тулом read_file (outline_only) чтобы не читать файл дважды.
 *  lang — уже загруженная грамматика (loadLanguage); если не передана —
 *  определяется по расширению и загружается. null = язык не поддерживается. */
export async function extractSymbolsFromSource(
  filePath: string,
  source: string,
  lang?: unknown,
  opts: { skipReferencesAboveBytes?: number } = {},
): Promise<FileSymbols | null> {
  if (!source) return null
  const skipRefsAbove = opts.skipReferencesAboveBytes ?? Infinity
  let loadedLang = lang
  if (!loadedLang) {
    const langId = getLangForFile(filePath)
    if (!langId) return null
    loadedLang = await loadLanguage(langId)
    if (!loadedLang) return null
  }
  try {
    const parser = await getParser()
    parser.setLanguage(loadedLang as TSLanguage)
    const tree = parser.parse(source)
    if (!tree) return null
    // web-tree-sitter: parse() возвращает Tree с .rootNode, но тип TSParser
    // объявляет возврат как TSNode — каст через unknown чтобы достать rootNode.
    const root = (tree as unknown as { rootNode: TSNode }).rootNode
    if (!root) return null
    const result = walkAndExtract(root)
    // Лёгкий regex-скан исходника для call-site references (имена функций/типов
    // которые используются в файле). Быстрее AST-обхода тел функций и даёт
    // сигнал для graph ranking: файл A вызывает функцию из файла B → edge A→B.
    // Пропускаем для больших файлов — regex matchAll по >100кб строке дорогой
    // и блокирует воркер; graph edges от огромных файлов не критичны.
    // Фильтр: ≥ 4 символов + blacklist common local names — убираем шум
    // (локальные переменные type res/err/ctx/data/result), которые не
    // резолвятся ни к одному определению в проекте и только мешают PageRank.
    if (source.length <= skipRefsAbove) {
      const refSet = new Set<string>()
      const idMatches = source.matchAll(/[a-zA-Z_$][\w$]{3,}/g)  // ≥4 chars (was ≥3)
      const localDefNames = new Set(result.definitions.map(d => d.name))
      for (const m of idMatches) {
        const name = m[0]
        if (refSet.has(name)) continue
        // Не включаем собственные определения файла — нас интересуют внешние ссылки
        if (localDefNames.has(name)) continue
        // Фильтр common local names — они не резолвятся к определениям проекта
        if (COMMON_LOCAL_NAMES.has(name)) continue
        refSet.add(name)
        if (refSet.size >= 200) break
      }
      result.references = Array.from(refSet)
    }
    return result
  } catch (e) {
    console.warn(`[fastContext] parse error for ${filePath}:`, e)
    return null
  }
}

