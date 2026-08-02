import { resolve as pathResolve } from 'path'
import { execAsync, execFileAsync, DEFAULT_IGNORE_DIRS, type ToolResult } from './_shared'

// ── search_code — поиск по коду (ripgrep/grep/Select-String) ─────────────

// Кэшируем путь к rg один раз.
// На win32 используем where.exe — `where` в PowerShell это алиас Where-Object
// (возвращает объекты, а не текст), что ломало бы парсинг stdout.
let rgBin: string | null | undefined = undefined
async function findRg(): Promise<string | null> {
  if (rgBin !== undefined) return rgBin
  try {
    const cmd = process.platform === 'win32' ? 'where.exe rg' : 'which rg'
    const { stdout } = await execAsync(cmd, { timeout: 3000 })
    rgBin = stdout.trim().split('\n')[0].trim() || null
  } catch { rgBin = null }
  return rgBin
}

// Дополнительные glob-исключения для поиска: секреты и артефакты, которые
// не стоит тащить в контекст модели. .git исключаем отдельно при --hidden
// (иначе rg честно пройдётся по всей истории репозитория — очень медленно).
const SEARCH_EXTRA_IGNORE = ['.git', '.env', '.env.*', '*.pem', '*.key', '*.min.js', '*.map']

export async function searchCode(
  pattern: string,
  searchPath: string,
  opts?: { fileGlob?: string; ignoreCase?: boolean; maxResults?: number; context?: number; maxChars?: number; literal?: boolean; workdir?: string }
): Promise<ToolResult> {
  // totalMax — потолок совпадений по всем файлам (широтный режим: больше
  // файлов, меньше контекста на каждое). perFileMax ограничивает строки
  // в одном файле, чтобы один «жирный» файл не вытеснил остальные.
  const totalMax = opts?.maxResults ?? 100
  const perFileMax = Math.max(1, Math.min(10, Math.ceil(totalMax / 10)))
  const contextLines = opts?.context ?? 3
  const maxChars = opts?.maxChars ?? 20000

  // Нормализуем путь — относительный → абсолютный (через workdir чата если задан)
  const absPath = pathResolve(opts?.workdir ?? process.cwd(), searchPath)

  const caseFlag = opts?.ignoreCase ? '-i' : '-s'

  const rg = await findRg()

  if (rg) {
    // Используем execFile с массивом аргументов вместо exec со строкой —
    // это полностью исключает command injection (pattern передаётся как
    // отдельный аргумент, shell не вызывается, метасимволы не интерпретируются).
    //
    // -H/--with-filename: rg НЕ печатает путь для одиночного файла — без этого
    // formatRgOutput не парсит вывод и возвращает «Совпадений не найдено».
    // --hidden: по умолчанию rg пропускает dot-директории (.vscode/.planning/
    // .hermes/...), даже не перечисленные в .gitignore — это причина «не находит».
    // .gitignore уважается (по умолчанию) — node_modules/dist/.mimocode пропускаются.
    // -F: literal-режим, паттерн ищется дословно (без regex-интерпретации).
    // -m здесь per-file, поэтому делаем потолок perFileMax; total-срез делает formatRgOutput.
    const args = ['--line-number', '--no-heading', '--with-filename', '--hidden', caseFlag]
    if (opts?.literal) args.push('--fixed-strings')
    if (opts?.fileGlob) args.push('--glob', opts.fileGlob)
    for (const g of SEARCH_EXTRA_IGNORE) args.push('--glob', `!${g}`)
    args.push('-C', String(contextLines), '-m', String(perFileMax), pattern, absPath)
    try {
      const { stdout } = await execFileAsync(rg, args, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 })
      const out = formatRgOutput(stdout.trim(), totalMax, { pattern: opts?.literal ? undefined : pattern, ignoreCase: !!opts?.ignoreCase })
      if (out.formatted) {
        const full = out.formatted
        const truncated = full.length > maxChars
        const body = truncated ? sliceOnFileBoundary(full, maxChars) : full
        return {
          success: true,
          output: body + (truncated
            ? `\n...[обрезано, показано ${body.length} из ${full.length} символов — увеличь max_chars или сузь file_glob/path]`
            : ''),
        }
      }
      return { success: true, output: buildEmptyHint(opts) }
    } catch (e: any) {
      // rg exit code 1 = нет совпадений (не ошибка)
      if (e.code === 1) return { success: true, output: buildEmptyHint(opts) }
      // Реальная ошибка — логируем и идём дальше
      const rgErr = `[rg error: ${e.message?.slice(0, 100)}]`

      // Fallback PowerShell с пометкой
      const psResult = await searchCodePowerShell(pattern, absPath, opts)
      if (psResult.success) {
        return { success: true, output: `${rgErr}\n${psResult.output}` }
      }
      return psResult
    }
  }

  // rg не найден — сразу PowerShell
  return searchCodePowerShell(pattern, absPath, opts)
}

async function searchCodePowerShell(
  pattern: string,
  absPath: string,
  opts?: { fileGlob?: string; ignoreCase?: boolean; maxResults?: number; context?: number; literal?: boolean }
): Promise<ToolResult> {
  const maxResults = opts?.maxResults ?? 100
  // '*' вместо '*.*' — иначе файлы без расширения (Makefile, Dockerfile, LICENSE) не ищутся.
  const psGlob = opts?.fileGlob ?? '*'
  const context = opts?.context ?? 3
  // Экранирование одинарной кавычки для PS-строки в одинарных кавычках: ' →''
  // Без этого паттерн с апострофом ломал весь скрипт (а -EncodedCommand не спасает,
  // т.к. скрипт мы собираем строковой интерполяцией до кодирования).
  const sq = (s: string) => s.replace(/'/g, "''")
  // -Force: включаем скрытые/dot-файлы (parity с rg --hidden).
  // -SimpleMatch: literal-режим (parity с rg -F), иначе Select-String трактует Pattern как regex.
  const strFlags = opts?.literal ? '-SimpleMatch' : (opts?.ignoreCase ? '' : '-CaseSensitive')
  // Игнор-директории + секреты (.env/.pem/.key/.git) — parity с rg-вариантом.
  const ignoreParts = [...DEFAULT_IGNORE_DIRS, '.env', '\\.env\\..*', '\\.pem$', '\\.key$', '.git']
    .map(d => d.replace(/\./g, '\\.').replace(/\*/g, '.*'))
  const ignoreRegex = ignoreParts.join('|')

  const psScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
    `$r = Get-ChildItem -Path '${sq(absPath)}' -Recurse -Force -Filter '${sq(psGlob)}' -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.FullName -notmatch '${ignoreRegex}' -and -not $_.PSIsContainer } | ` +
    `Select-String ${strFlags} -Pattern '${sq(pattern)}' -Context ${context},${context} -ErrorAction SilentlyContinue | ` +
    `Select-Object -First ${maxResults}; ` +
    `if ($r) { $r | ForEach-Object { $_.Filename + ':' + $_.LineNumber + ': ' + $_.Line.Trim() } } else { 'Совпадений не найдено' }`
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
  const psCmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
  try {
    const { stdout } = await execAsync(psCmd, { timeout: 25000, maxBuffer: 10 * 1024 * 1024 })
    const trimmed = stdout.trim()
    if (!trimmed || trimmed === 'Совпадений не найдено') {
      return { success: true, output: buildEmptyHint(opts) }
    }
    return { success: true, output: trimmed }
  } catch (e: any) {
    return { success: false, output: '', error: 'search_code: ' + e.message }
  }
}

/** Подсказка при пустом результате — направляет модель к альтернативам вместо слепых ретраев. */
function buildEmptyHint(opts?: { literal?: boolean; fileGlob?: string; ignoreCase?: boolean }): string {
  const hints: string[] = ['Совпадений не найдено.']
  if (!opts?.literal) hints.push('Для дословного поиска со спецсимволами (точки, $, [], () ) используй literal=true.')
  if (!opts?.fileGlob) hints.push('Сузь file_glob (напр. "*.ts") или path к подпапке.')
  if (!opts?.ignoreCase) hints.push('Попробуй ignore_case=true если регистр не важен.')
  hints.push('Для структуры файла используй read_file с outline_only=true; для навигации по проекту — get_fast_context.')
  return hints.join(' ')
}

/** Обрезает вывод так, чтобы не разрезать блок файла (между маркерами `●`).
 *  Ищет последний маркер `●` в пределах [0, maxChars] и режет перед ним —
 *  тогда «висячих» номеров строк без заголовка файла не остаётся. */
function sliceOnFileBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  // окно с запасом, чтобы найти маркер внутри maxChars
  const window = text.slice(0, maxChars)
  const lastMarker = window.lastIndexOf('\n● ')
  if (lastMarker > maxChars * 0.5) return text.slice(0, lastMarker)
  // маркера нет в первой половине — режем ровно по maxChars (нечастый случай)
  return text.slice(0, maxChars)
}

interface FormatResult { formatted: string; matchCount: number; fileCount: number; totalFilesHint: number }

// Группирует вывод rg по файлам (поддерживает Windows пути C:\...).
// С -H/--with-filename rg ВСЕГДА печатает путь — даже для одиночного файла,
// поэтому парсинг надёжный. Контекстные строки помечаются двоеточием/дефисом
// после номера ( rg: file:42:match / file:42-context), а просто путь без
// двоеточия-числа игнорируем (раньше такой «мусор» приписывался к последнему
// файлу через опасный fallback — мог ломать группировку).
function formatRgOutput(raw: string, max: number, _opts?: { pattern?: string; ignoreCase?: boolean }): FormatResult {
  if (!raw) return { formatted: '', matchCount: 0, fileCount: 0, totalFilesHint: 0 }
  const lines = raw.split('\n')
  const files = new Map<string, { rows: string[]; matches: number }>()
  let totalMatches = 0
  let droppedFiles = 0
  let seenFiles = 0
  for (const line of lines) {
    if (line === '--') continue  // разделитель контекста между файлами
    // rg с -H: путь:номер:содержимое (совпадение) или путь-номер-содержимое (контекст).
    // Non-greedy (.+?) + \d+ корректно парсит Unix и Windows (C:\...) пути.
    const m = line.match(/^(.+?)[-:](\d+)[:-](.*)$/)
    if (m) {
      const [, file, lineNum, content] = m
      let entry = files.get(file)
      if (!entry) {
        seenFiles++
        if (totalMatches >= max) {
          droppedFiles++
          continue
        }
        entry = { rows: [], matches: 0 }
        files.set(file, entry)
      }
      // Строки match (с `:` после номера) считаем как совпадения; контекст (с `-`) — нет.
      const isMatch = /^(\d+):/.test(line.slice(file.length + 1))
      if (isMatch) {
        entry.matches++
        totalMatches++
      }
      entry.rows.push(`  ${lineNum}: ${content}`)
    }
    // строки без path:num:content (мусор/пустые) — игнорируем, не приписываем
  }
  const out: string[] = []
  const fileCount = files.size
  const matchCount = totalMatches
  out.push(`[search_code: ${matchCount} совпадений в ${fileCount} файлах${droppedFiles > 0 ? `, показано ${fileCount} из ${seenFiles} (лимит ${max})` : ''}]`)
  files.forEach((entry, file) => {
    out.push(`\n● ${file}`)
    out.push(...entry.rows.slice(0, 30))
    if (entry.rows.length > 30) out.push(`  ... ещё ${entry.rows.length - 30} строк`)
  })
  if (droppedFiles > 0) {
    out.push(`\n... [лимит ${max} совпадений — ещё совпадения в ${droppedFiles} файлах не показаны. Сузь file_glob или path к подпапке, либо подними max_results.]`)
  }
  return { formatted: out.join('\n').trim(), matchCount, fileCount, totalFilesHint: seenFiles }
}
