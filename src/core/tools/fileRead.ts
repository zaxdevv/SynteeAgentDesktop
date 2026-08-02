import { existsSync } from 'fs'
import { readFile as fsReadFile, stat as fsStat } from 'fs/promises'
import { resolveToolPath, isBinaryFile, formatSize, type ToolResult } from './_shared'
import { extractSymbolsFromSource, type SymbolDef } from '../context/fastContext'

const MAX_READ_FILE_SIZE = 20 * 1024 * 1024  // 20MB — больше не читаем целиком в память

export async function readFile(path: string, offset?: number, limit?: number, outlineOnly?: boolean, workdir?: string): Promise<ToolResult> {
  try {
    path = resolveToolPath(path, workdir)
    if (!existsSync(path)) return { success: false, output: '', error: 'Файл не найден: ' + path }
    // Проверяем размер — не читаем огромные файлы целиком в память
    const fileStat = await fsStat(path)
    if (fileStat.size > MAX_READ_FILE_SIZE) {
      return { success: false, output: '', error: `Файл слишком большой (${formatSize(fileStat.size)}). Используйте offset/limit для чтения по частям или run_command для просмотра.` }
    }
    if (await isBinaryFile(path)) return { success: false, output: '', error: 'Файл выглядит как бинарный, текстовое чтение не поддерживается: ' + path }
    const content = await fsReadFile(path, 'utf-8')
    const lines = content.split('\n')
    const totalLines = lines.length

    // outline_only — возвращаем только структуру файла
    if (outlineOnly) {
      return await getFileOutline(path, content)
    }

    if (offset !== undefined || limit !== undefined) {
      const from = Math.max(0, (offset ?? 1) - 1)  // offset 1-indexed
      const count = limit ?? 200
      const slice = lines.slice(from, from + count)
      const numbered = slice.map((l, i) => `${from + i + 1}|${l}`).join('\n')
      const hasMore = from + count < totalLines
      const truncatedInfo = hasMore
        ? `\n...[показано ${slice.length} из ${totalLines} строк | ещё ${totalLines - from - count} строк | используй offset=${from + count + 1} для продолжения]`
        : ''
      return {
        success: true,
        output: `[Файл: ${path} | Строки ${from + 1}-${from + slice.length} из ${totalLines}]${truncatedInfo}\n${numbered}`,
      }
    }

    // Без offset — читаем первые 200 строк, если файл больше — добавляем авто-outline
    const DEFAULT_LINES = 200
    const truncated = totalLines > DEFAULT_LINES
    const slice = lines.slice(0, DEFAULT_LINES)
    const numbered = slice.map((l, i) => `${i + 1}|${l}`).join('\n')

    let suffix = ''
    if (truncated) {
      suffix = `\n...[показано ${DEFAULT_LINES} из ${totalLines} строк | используй offset/limit для чтения по частям или outline_only=true для структуры]`
      // Авто-outline для больших файлов — агент сразу видит структуру и может
      // прыгать к нужной строке через offset. tree-sitter покрывает 20+ языков;
      // для неподдерживаемых — regex-fallback (см. getFileOutline).
      const outlineResult = await getFileOutline(path, content)
      if (outlineResult.success) suffix += `\n\n${outlineResult.output}`
    }
    return {
      success: true,
      output: `[Файл: ${path} | ${totalLines} строк]${suffix}\n${numbered}`,
    }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

// ── get_file_outline — структура файла (функции/классы/экспорты) ──────────
// Использует tree-sitter (через fastContext.extractSymbolsFromSource) для
// точной навигации: функции/методы/классы/интерфейсы/imports с номерами
// строк. Покрывает 20+ языков (js/ts/tsx/py/rs/go/c/cpp/java/cs/rb/php/
// swift/kt/scala/lua/bash/dart/elixir). Для неподдерживаемых языков —
// regex-fallback (улучшенный: plain-методы класса, React-компоненты).
export async function getFileOutline(filePath: string, alreadyReadContent?: string): Promise<ToolResult> {
  if (!existsSync(filePath)) return { success: false, output: '', error: 'Файл не найден: ' + filePath }
  try {
    const content = alreadyReadContent ?? await fsReadFile(filePath, 'utf-8')
    const lines = content.split('\n')
    const totalLines = lines.length

    // 1. tree-sitter (точный AST-обход) — покрывает 20+ языков
    const symbols = await extractSymbolsFromSource(filePath, content)
    if (symbols && (symbols.definitions.length || symbols.imports.length)) {
      return renderOutlineFromSymbols(filePath, totalLines, symbols.definitions, symbols.imports)
    }

    // 2. Regex-fallback — для языков без tree-sitter грамматики (.vue/.svelte/.css/.md/.sql/.yml/...)
    const regexOutline = renderOutlineRegex(filePath, lines)
    if (regexOutline) {
      return { success: true, output: regexOutline }
    }

    // 3. Ничего не нашли — честная заглушка с action-подсказкой
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    return {
      success: true,
      output: `[Outline: ${filePath} | ${totalLines} строк]\n  Структура не определена для .${ext}. Используй offset/limit для чтения по частям.`,
    }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

function renderOutlineFromSymbols(filePath: string, totalLines: number, definitions: SymbolDef[], imports: string[]): ToolResult {
  const outline: string[] = [`[Outline: ${filePath} | ${totalLines} строк]`]
  if (imports.length) {
    outline.push(`  imports(${imports.length}): ${imports.slice(0, 5).join(', ')}${imports.length > 5 ? ` +${imports.length - 5}` : ''}`)
  }
  // Сортируем по строке начала (методы класса идут после класса, но с parentName)
  const sorted = [...definitions].sort((a, b) => a.lineStart - b.lineStart)
  for (const d of sorted) {
    const parent = d.parentName ? `${d.parentName} → ` : ''
    outline.push(`  ${d.lineStart}: [${d.kind}] ${parent}${d.name}  — ${d.signature}`)
  }
  return { success: true, output: outline.join('\n') }
}

// Regex-fallback для языков без tree-sitter грамматики.
// Возвращает строку outline или null если ничего не найдено.
function renderOutlineRegex(filePath: string, lines: string[]): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  // Расширенные TS/JS-паттерны (дополняют tree-sitter если он не сработал):
  // теперь ловим plain-методы класса (methodName() {) — самый частый кейс,
  // который старый regex пропускал.
  const tsPatterns: Array<{ re: RegExp; label: string }> = [
    { re: /^export\s+default\s+(async\s+)?(function|class)\s*(\w*)/, label: 'export default' },
    { re: /^export\s+(async\s+)?function\s+(\w+)/, label: 'export fn' },
    { re: /^export\s+(const|let)\s+(\w+)\s*[:=].*(?:=>|\bfunction\b)/, label: 'export const fn' },
    { re: /^export\s+(?:abstract\s+)?class\s+(\w+)/, label: 'class' },
    { re: /^export\s+(?:interface|type|enum)\s+(\w+)/, label: 'type' },
    // Plain-метод класса: отступ 2+ пробела, имя(...), после ) — : или { или =>
    // (раньше требовался public/private/... — теряли большинство методов).
    { re: /^ {2,}(\w+)\s*\([^)]*\)\s*[:{]/, label: 'method' },
    { re: /^ {2,}(?:public|private|protected|static|async|\bget\b|\bset\b)\s+(?:async\s+)?(\w+)\s*[(<]/, label: 'method' },
    { re: /^(?:async\s+)?function\s+(\w+)/, label: 'fn' },
    { re: /^(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/, label: 'fn' },
    { re: /^(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/, label: 'fn' },
    { re: /^import\s+.*\s+from\s+['"](.+)['"]/, label: 'import' },
  ]
  const pyPatterns: Array<{ re: RegExp; label: string }> = [
    { re: /^(?:async\s+)?def\s+(\w+)/, label: 'def' },
    { re: /^class\s+(\w+)/, label: 'class' },
    { re: /^(?:from\s+\S+\s+)?import\s+(\S+)/, label: 'import' },
  ]
  // Базовые паттерны для остальных языков (css/html/markdown/config)
  const genericPatterns: Array<{ re: RegExp; label: string }> = [
    { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, label: 'fn' },
    { re: /^\s*(?:export\s+)?class\s+(\w+)/, label: 'class' },
  ]
  const activePatterns = ext === 'py' ? pyPatterns
    : ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(ext) ? tsPatterns
    : genericPatterns
  const outline: string[] = [`[Outline: ${filePath} | ${lines.length} строк]`]
  const imports: string[] = []
  let pastImports = false
  let foundAny = false
  lines.forEach((line, i) => {
    for (const { re, label } of activePatterns) {
      const m = line.match(re)
      if (!m) continue
      const name = (m[3] || m[2] || m[1] || '').trim() || line.slice(0, 50)
      if (label === 'import') { if (!pastImports) imports.push(name); return }
      if (!pastImports) {
        if (imports.length) outline.push(`  imports(${imports.length}): ${imports.slice(0, 5).join(', ')}${imports.length > 5 ? ` +${imports.length - 5}` : ''}`)
        pastImports = true
      }
      outline.push(`  ${i + 1}: [${label}] ${name}`)
      foundAny = true
      return
    }
    if (!pastImports && line.trim() && !line.startsWith('//') && !line.startsWith(' *') && !line.startsWith('*')) pastImports = true
  })
  if (!pastImports && imports.length) outline.push(`  imports(${imports.length}): ${imports.slice(0, 5).join(', ')}`)
  return foundAny || imports.length ? outline.join('\n') : null
}

// ── read_files — читать несколько файлов за раз ──────────────────────────
export async function readFiles(paths: string[], workdir?: string): Promise<ToolResult> {
  const results: string[] = []
  for (const p of paths.slice(0, 10)) {
    const rp = resolveToolPath(p, workdir)
    if (!existsSync(rp)) {
      results.push(`=== ${p} ===\n[Файл не найден]`)
      continue
    }
    try {
      if (await isBinaryFile(rp)) {
        results.push(`=== ${p} ===\n[Бинарный файл, текстовое чтение не поддерживается]`)
        continue
      }
      const content = await fsReadFile(rp, 'utf-8')
      const lines = content.split('\n')
      const MAX_LINES = 150
      const truncated = lines.length > MAX_LINES
      const slice = lines.slice(0, MAX_LINES).map((l, i) => `${i + 1}|${l}`).join('\n')
      const info = truncated
        ? `\n...[показано ${MAX_LINES} из ${lines.length} строк | используй read_file с offset для продолжения]`
        : ''
      results.push(`=== ${p} | ${lines.length} строк ===\n${slice}${info}`)
    } catch (e: any) {
      results.push(`=== ${p} ===\n[Ошибка чтения: ${e.message}]`)
    }
  }
  return { success: true, output: results.join('\n\n') }
}
