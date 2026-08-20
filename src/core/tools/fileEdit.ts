import { existsSync } from 'fs'
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises'
import { resolveToolPath, ensureDirFor, makeDiff, countChangedLines, normalizeLineEndings, type ToolResult } from './_shared'

export interface EditResult extends ToolResult {
  diff?: string
}

// Запись файла с авто-добавлением UTF-8 BOM для .ps1. PowerShell 5.1 (он же
// Windows PowerShell, powershell.exe) читает текстовые файлы без BOM как
// cp1251 — кириллические строки в .ps1 превращаются в мусор, падает парсер.
// pwsh 7+ UTF-8 по умолчанию и BOM переваривает нормально. Поэтому всегда
// добавляем BOM для .ps1: файл остаётся читаемым и в PS 5.1, и в pwsh 7+,
// и в VS Code. Node при `readFile(path,'utf-8')` BOM автоматически стрипает,
// так что все diff/patch-сравнения работают с чистым контентом без BOM.
export function writeWithOptionalBom(filePath: string, content: string): Promise<void> {
  if (/\.ps1$/i.test(filePath)) {
    // EF BB BF — UTF-8 BOM
    const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(content, 'utf-8')])
    return fsWriteFile(filePath, buf)
  }
  return fsWriteFile(filePath, content, 'utf-8')
}

export async function writeFile(path: string, content: string, opts?: { dryRun?: boolean; workdir?: string }): Promise<ToolResult> {
  try {
    path = resolveToolPath(path, opts?.workdir)
    // write_file — запись файла целиком: создаёт новый или перезаписывает
    // существующий. Для точечных правок используй edit_file (old_str/new_str).
    let originalContent: string | null = null
    if (existsSync(path)) {
      originalContent = await fsReadFile(path, 'utf-8')
    }
    // dryRun — do not write, only return a diff preview
    if (opts?.dryRun) {
      const diff = makeDiff(originalContent ?? '', content, path)
      return { success: true, output: `[DRY RUN] CREATING new file: ${path}\n${diff}`.slice(0, 4000), diff }
    }
    await ensureDirFor(path)
    await writeWithOptionalBom(path, content)
    const lines = content.split('\n').length
    const diff = makeDiff(originalContent ?? '', content, path)
    return { success: true, output: `File created: ${path} (${lines} lines)`, diff, originalContent }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// str_replace: 9-replacer pipeline (OpenCode-style, adapted from
// cline/diff-apply and gemini-cli/editCorrector).
//
// Каждый Replacer — генератор, который выдаёт кандидатов (строки, которые
// МОГУТ быть вхождением old_str в content). Функция replace() перебирает
// replacers по очереди: первый, выдавший уникальное совпадение — побеждает.
// Если ни один не нашёл — ошибка "old_str not found". Если несколько
// совпадений — ошибка "multiple matches".
// ════════════════════════════════════════════════════════════════════════════

type Replacer = (content: string, find: string) => Generator<string, void, unknown>

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65

/**
 * Levenshtein distance — для fuzzy-матчинга в BlockAnchorReplacer.
 */
function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') return Math.max(a.length, b.length)
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

// 1. SimpleReplacer — точное совпадение
const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

// 2. LineTrimmedReplacer — сравнение по строкам, обрезав пробелы в начале/конце
const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')
  if (searchLines[searchLines.length - 1] === '') searchLines.pop()

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) { matches = false; break }
    }
    if (matches) {
      let start = 0
      for (let k = 0; k < i; k++) start += originalLines[k].length + 1
      let end = start
      for (let k = 0; k < searchLines.length; k++) {
        end += originalLines[i + k].length
        if (k < searchLines.length - 1) end++
      }
      yield content.substring(start, end)
    }
  }
}

// 3. BlockAnchorReplacer — первая+последняя строка как "якоря", середина — fuzzy по Levenshtein
const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')
  if (searchLines.length < 3) return
  if (searchLines[searchLines.length - 1] === '') searchLines.pop()

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25))

  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) continue
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        if (Math.abs(j - i + 1 - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j })
        }
        break
      }
    }
  }
  if (candidates.length === 0) return

  // Single candidate — check similarity
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1
    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const origLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(origLine.length, searchLine.length)
        if (maxLen === 0) continue
        similarity += (1 - levenshtein(origLine, searchLine) / maxLen) / linesToCheck
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break
      }
    } else {
      similarity = 1.0
    }
    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let start = 0
      for (let k = 0; k < startLine; k++) start += originalLines[k].length + 1
      let end = start
      for (let k = startLine; k <= endLine; k++) {
        end += originalLines[k].length
        if (k < endLine) end++
      }
      yield content.substring(start, end)
    }
    return
  }

  // Multiple candidates — pick best similarity
  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSim = -1
  for (const cand of candidates) {
    const { startLine, endLine } = cand
    const actualBlockSize = endLine - startLine + 1
    let sim = 0
    const toCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    if (toCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const origLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(origLine.length, searchLine.length)
        if (maxLen === 0) continue
        sim += 1 - levenshtein(origLine, searchLine) / maxLen
      }
      sim /= toCheck
    } else {
      sim = 1.0
    }
    if (sim > maxSim) { maxSim = sim; bestMatch = cand }
  }
  if (maxSim >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let start = 0
    for (let k = 0; k < startLine; k++) start += originalLines[k].length + 1
    let end = start
    for (let k = startLine; k <= endLine; k++) {
      end += originalLines[k].length
      if (k < endLine) end++
    }
    yield content.substring(start, end)
  }
}

// 4. WhitespaceNormalizedReplacer — нормализует все whitespace в одну пробелу
const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const norm = (text: string) => text.replace(/\s+/g, ' ').trim()
  const normFind = norm(find)
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (norm(lines[i]) === normFind) yield lines[i]
  }
  const findLines = find.split('\n')
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (norm(block.join('\n')) === normFind) yield block.join('\n')
    }
  }
}

// 5. IndentationFlexibleReplacer — игнорирует отступы (tabs vs spaces)
const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndent = (text: string) => {
    const lines = text.split('\n')
    const nonEmpty = lines.filter(l => l.trim().length > 0)
    if (nonEmpty.length === 0) return text
    const minIndent = Math.min(...nonEmpty.map(l => { const m = l.match(/^(\s*)/); return m ? m[1].length : 0 }))
    return lines.map(l => l.trim().length === 0 ? l : l.slice(minIndent)).join('\n')
  }
  const normFind = removeIndent(find)
  const contentLines = content.split('\n')
  const findLines = find.split('\n')
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n')
    if (removeIndent(block) === normFind) yield block
  }
}

// 6. EscapeNormalizedReplacer — нормализует escape-последовательности
const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescape = (str: string): string =>
    str.replace(/\\(n|t|r|'|"|`|\\|\$)/g, (m, c: string) => {
      switch (c) {
        case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r'
        case "'": return "'"; case '"': return '"'; case '`': return '`'
        case '\\': return '\\'; case '$': return '$'; default: return m
      }
    })
  const unescapedFind = unescape(find)
  if (content.includes(unescapedFind)) yield unescapedFind
  const lines = content.split('\n')
  const findLines = unescapedFind.split('\n')
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')
    if (unescape(block) === unescapedFind) yield block
  }
}

// 7. TrimmedBoundaryReplacer — ищет trimmed-версию old_str
const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()
  if (trimmedFind === find) return
  if (content.includes(trimmedFind)) yield trimmedFind
  const lines = content.split('\n')
  const findLines = find.split('\n')
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')
    if (block.trim() === trimmedFind) yield block
  }
}

// 8. ContextAwareReplacer — первая+последняя строка как контекст, середина ≥50% совпадения
const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split('\n')
  if (findLines.length < 3) return
  if (findLines[findLines.length - 1] === '') findLines.pop()
  const contentLines = content.split('\n')
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        const blockLines = contentLines.slice(i, j + 1)
        if (blockLines.length === findLines.length) {
          let matching = 0, total = 0
          for (let k = 1; k < blockLines.length - 1; k++) {
            const bl = blockLines[k].trim()
            const fl = findLines[k].trim()
            if (bl.length > 0 || fl.length > 0) {
              total++
              if (bl === fl) matching++
            }
          }
          if (total === 0 || matching / total >= 0.5) {
            yield blockLines.join('\n')
            break
          }
        }
        break
      }
    }
  }
}

// 9. MultiOccurrenceReplacer — выдаёт все точные совпадения
const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let start = 0
  while (true) {
    const idx = content.indexOf(find, start)
    if (idx === -1) break
    yield find
    start = idx + find.length
  }
}

// Защита от "съело пол-файла": если найденный кусок сильно больше old_str — отказ.
function isDisproportionateMatch(search: string, oldString: string): boolean {
  const oldLines = oldString.split('\n').length
  const searchLines = search.split('\n').length
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
}

/**
 * Главная функция замены — перебирает 9 replacers, первый уникальный матч побеждает.
 * Бросает Error с понятным сообщением если old_str не найден или найдён многократно.
 */
function strReplaceCore(content: string, oldStr: string, newStr: string): string {
  if (oldStr === newStr) {
    throw new Error('old_str and new_str are identical — nothing to change.')
  }
  if (oldStr === '') {
    throw new Error('old_str cannot be empty. Provide the exact text to replace.')
  }

  let notFound = true

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  ]) {
    for (const search of replacer(content, oldStr)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (isDisproportionateMatch(search, oldStr)) {
        throw new Error(
          'Refusing replacement because the matched span is much larger than old_str. Re-read the file and provide the full exact old_str for the intended replacement.',
        )
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue // multiple matches — skip, try next replacer
      return content.substring(0, index) + newStr + content.substring(index + search.length)
    }
  }

  if (notFound) {
    throw new Error(
      buildNotFoundSnippetError(content, oldStr, 'edit_file') +
      '\n\nTip: old_str must match the file exactly (including whitespace and indentation). Reread the file with read_file and copy the exact content.',
    )
  }
  throw new Error(
    'Found multiple matches for old_str. Provide more surrounding lines in old_str to make it unique.',
  )
}

// ════════════════════════════════════════════════════════════════════════════

export async function editFile(params: {
  path: string
  old_str: string
  new_str: string
  create_if_not_exists?: boolean
  dryRun?: boolean
  workdir?: string
}): Promise<EditResult> {
  try {
    params.path = resolveToolPath(params.path, params.workdir)
    const fileExists = existsSync(params.path)

    // create_if_not_exists — создать файл если не существует
    if (!fileExists) {
      if (params.create_if_not_exists) {
        const initial = params.new_str ?? ''
        if (params.dryRun) {
          const diff = makeDiff('', initial, params.path)
          return { success: true, output: `[DRY RUN] CREATING new file: ${params.path}\n${diff}`.slice(0, 4000), diff }
        }
        await ensureDirFor(params.path)
        await writeWithOptionalBom(params.path, initial)
        const diff = makeDiff('', initial, params.path)
        return { success: true, output: `File created: ${params.path}`, diff }
      }
      return { success: false, output: '', error: 'File not found: ' + params.path }
    }

    // Size guard before reading. read_file has MAX_READ_FILE_SIZE=20MB,
    // edit_file did not. Editing a 500MB log → OOM / long pause without a
    // clear error. Matches the read_file limit for consistency.
    try {
      const stat = await import('fs/promises').then(m => m.stat(params.path))
      if (stat.size > 20 * 1024 * 1024) {
        return {
          success: false,
          output: '',
          error: `File too large (${Math.round(stat.size / 1024 / 1024)}MB). edit_file works with files up to 20MB. Use read_file with offset/limit for partial editing or run_command.`,
        }
      }
    } catch { /* stat failed — continue, fsReadFile below will give a clear error */ }

    const original = await fsReadFile(params.path, 'utf-8')
    let updated = original

    // Defense-in-depth: old_str/new_str теперь required в schema, но на случай
    // если args пришли через salvageEditFileArgs или другой обход валидации.
    if (params.old_str === undefined) {
      return { success: false, output: '', error: 'edit_file: old_str is required' }
    }
    if (params.new_str === undefined) {
      return { success: false, output: '', error: 'edit_file: new_str is required. If you want to delete old_str — pass new_str: "" explicitly.' }
    }

    // Normalize CRLF → LF for comparison, preserve original line endings in result
    const normOrig = normalizeLineEndings(original)
    const normOld = normalizeLineEndings(params.old_str)
    const normNew = normalizeLineEndings(params.new_str)
    const replaced = strReplaceCore(normOrig, normOld, normNew)
    // Restore CRLF if original had it
    if (original.includes('\r\n')) {
      updated = replaced.replace(/\r?\n/g, '\r\n')
    } else {
      updated = replaced
    }

    const diff = makeDiff(original, updated, params.path)
    // If the edit changed nothing — that is suspicious (the model called
    // edit_file but passed no changes). Report explicitly, do not write the file.
    if (updated === original) {
      return {
        success: false,
        output: '',
        error: `edit_file: the edit did not change the file (old_str not found or new_str matches old_str). Check the arguments or reread the file with read_file.`,
      }
    }
    if (params.dryRun) {
      const changedLines = countChangedLines(diff)
      return { success: true, output: `[DRY RUN] Edit for: ${params.path} (${changedLines} lines changed)\n${diff}`.slice(0, 4000), diff }
    }
    await writeWithOptionalBom(params.path, updated)
    const changedLines2 = countChangedLines(diff)
    const outMsg = `File updated: ${params.path} (${changedLines2} lines changed)`
    return { success: true, output: outMsg, diff, originalContent: original }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

// ── Snippet-хелпер для ошибок "not found" ──────────────────────────────────
// Когда old_str не найден в файле, включаем в сообщение об ошибке
// фрагмент актуального содержимого файла (30 строк) с номерами строк. Это
// позволяет AI скорректировать old_str без отдельного вызова read_file —
// экономит round-trip и снижает количество ошибок редактирования.
function buildNotFoundSnippetError(normOrig: string, normOld: string, context: string): string {
  const lines = normOrig.split('\n')
  // Пытаемся найти ЛЮБУЮ строку из old_str в файле (не только первую).
  const oldLines = normOld.split('\n').map(l => l.trimStart()).filter(l => l.length > 0)
  let partialIdx = -1
  for (const oldLine of oldLines) {
    const probe = oldLine.slice(0, 40)
    if (probe) {
      partialIdx = lines.findIndex(l => l.includes(probe))
      if (partialIdx >= 0) break
    }
  }
  const snippetStart = Math.max(0, (partialIdx >= 0 ? partialIdx : 0) - 5)
  const SNIPPET_LINES = 30
  const snippetLines = lines.slice(snippetStart, snippetStart + SNIPPET_LINES)
  const snippet = snippetLines
    .map((l, i) => {
      const lineNum = snippetStart + i + 1
      const truncated = l.length > 200 ? l.slice(0, 200) + '…' : l
      return `${lineNum}: ${truncated}`
    })
    .join('\n')
  return `edit_file ${context}: old_str not found in the file. Here is the actual content (lines ${snippetStart + 1}-${snippetStart + snippetLines.length}):\n\n${snippet}\n\nUse this actual content to correct old_str, or reread the file with read_file.`
}
