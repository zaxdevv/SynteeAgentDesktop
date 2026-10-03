import { resolve, normalize } from 'path'
import { estimateTokens, TOOL_SCHEMAS_OVERHEAD } from '../context/contextManager'
import { log } from '../logger'
import { TOOL_SCHEMAS } from '../tools/schemas'
import type { AgentMessage, AgentToolCallFingerprint, ToolRound } from './types'

export const FALLBACK_SYSTEM_PROMPT = 'You are a capable coding agent. Follow the provided system prompt and use tools when needed.'

// Число успешных file-edit тулов между авто-верификациями (упрощённый
// аналог PostToolUse-хука Claude Code) — фиксированное значение для MVP,
// можно вынести в AgentSettings позже если понадобится настройка в UI.
export const VERIFICATION_INTERVAL = 3

export function normalizeToolName(name: string, schemas: Array<{ function: { name: string } }>): string {
  const knownNames = schemas.map(s => s.function.name)
  if (knownNames.includes(name)) return name

  const parts = name.split('_')
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join('_')
    if (knownNames.includes(candidate)) return candidate
  }

  for (let i = parts.length - 1; i > 0; i--) {
    const candidate = parts.slice(0, i).join('_')
    if (knownNames.includes(candidate)) return candidate
  }

  for (const known of knownNames) {
    if (name.includes(known)) return known
  }

  return name
}

// Универсальная проверка обязательных аргументов по TOOL_SCHEMAS.required —
// одна проверка для всех тулов сразу, вместо точечных if-ов в executeTool.
// Ловит случаи когда модель не передала обязательное поле или JSON.parse
// аргументов тихо упал (args = {}) — раньше это доходило до низкоуровневых
// ошибок вида `The "paths[1]" argument must be of type string. Received
// undefined` внутри path.resolve(), непонятных и для модели, и для пользователя.
//
// Возвращает структурированный результат с типом и описанием каждого
// отсутствующего поля — модель быстрее исправляется, когда видит не просто
// "missing path", а "missing path (string): Path to the file".

export interface MissingArg {
  name: string
  expectedType: string
  description: string
}

export function findMissingRequiredArgs(
  name: string,
  args: Record<string, unknown>,
  schemas: Array<{ function: { name: string; parameters?: { required?: string[]; properties?: Record<string, unknown> } } }>,
): MissingArg[] {
  const schema = schemas.find(s => s.function.name === name)
  const required = schema?.function.parameters?.required
  if (!required?.length) return []
  const props = schema?.function.parameters?.properties ?? {}
  return required
    .filter(key => args[key] === undefined || args[key] === null || args[key] === '')
    .map(key => {
      const prop = props[key] as { type?: string; description?: string } | undefined
      return {
        name: key,
        expectedType: prop?.type ?? 'unknown',
        description: prop?.description ?? '',
      }
    })
}

/**
 * Форматирует список отсутствующих аргументов в понятное для модели сообщение.
 * Показывает имя, ожидаемый тип и описание каждого поля — модель быстрее
 * исправляется со структурированным фидбеком, чем с простым "missing: path, mode".
 */
export function formatMissingArgsMessage(toolName: string, missing: MissingArg[]): string {
  const lines = missing.map(a => {
    const desc = a.description ? ` — ${a.description.slice(0, 120)}` : ''
    return `  - ${a.name} (${a.expectedType})${desc}`
  })
  return `${toolName}: missing required arguments:\n${lines.join('\n')}\n\nRepeat the call with ALL required arguments.`
}

/**
 * Попытка починить частые ошибки JSON в аргументах tool_call, которые
 * модели (особенно не-OpenAI) регулярно генерируют:
 *
 * 1. Незакавыченные значения enum: `"mode": apply_patch"` — модель забыла
 *    открывающую кавычку, закрывающая может быть, а может нет.
 *    Самый частый кейс (см. logs/debug.log).
 * 2. Опечатки в enum-значениях: `applyy_patch` → `apply_patch`.
 * 3. Trailing comma перед `}` или `]`.
 * 4. Незакрытая кавычка последнего строкового значения перед `}`.
 * 5. Одинарные кавычки вместо двойных.
 * 6. Литеральные newlines внутри строковых значений.
 * 7. Незакрытые скобки (обрыв стрима).
 * 8. Незакавыченные пути Windows с обратными слешами.
 *
 * Важно: функция применяется ТОЛЬКО когда JSON.parse уже упал —
 * валидный JSON она не трогает. Все исправления логируются через
 * возвращаемый `fixes` массив для трассировки.
 *
 * Границы: не пытаемся быть универсальным jsonrepair-парсером. Ловим
 * только наблюдаемые паттерны; если модель придумает новый — функция
 * расширяема.
 */
// ─── JSON repair helpers ───────────────────────────────────────────────────

/**
 * Levenshtein distance между двумя строками. Используется для fuzzy-коррекции
 * опечаток в enum-значениях (userr_fact → user_fact, applyy_patch → apply_patch).
 */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp: number[] = new Array(n + 1)
  for (let j = 0; j <= n; j++) dp[j] = j
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      prev = tmp
    }
  }
  return dp[n]
}

/**
 * Динамически строит карту enum-ключей из TOOL_SCHEMAS: { keyName → Set<allowedValues> }.
 * Рекурсивно обходит вложенные properties/items (update_todo status, ask_user type).
 * Покрывает: mode, shell, method, kind, scope, action, approval_mode, isolation,
 * status, type — и любые будущие enum-ключи без ручного обновления.
 */
function buildEnumKeyMap(
  schemas: Array<{ function: { parameters?: { properties?: Record<string, unknown> } } }>,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  const visitProps = (props: Record<string, unknown> | undefined) => {
    if (!props || typeof props !== 'object') return
    for (const [key, val] of Object.entries(props)) {
      const prop = val as Record<string, unknown>
      if (prop?.enum && Array.isArray(prop.enum)) {
        if (!map.has(key)) map.set(key, new Set())
        for (const e of prop.enum) map.get(key)!.add(String(e))
      }
      if (prop?.properties) visitProps(prop.properties as Record<string, unknown>)
      if (prop?.items) {
        const items = prop.items as Record<string, unknown>
        if (items.properties) visitProps(items.properties as Record<string, unknown>)
      }
    }
  }
  for (const schema of schemas) {
    const params = schema.function.parameters
    if (params?.properties) visitProps(params.properties)
  }
  return map
}

const ENUM_KEY_MAP = buildEnumKeyMap(
  TOOL_SCHEMAS as Array<{ function: { parameters?: { properties?: Record<string, unknown> } } }>,
)
const ENUM_KEY_NAMES = [...ENUM_KEY_MAP.keys()]

export function tryRepairJson(raw: string): { repaired: string; fixed: boolean; fixes: string[] } {
  let result = raw
  const fixes: string[] = []

  // Проход 1: исправляем незакавыченные значения после ЛЮБЫХ enum-ключей
  // из TOOL_SCHEMAS (mode, shell, kind, scope, action, approval_mode, isolation,
  // status, type, method, ...). Динамически — нулевое обслуживание.
  //
  // Матчит все варианты незакавыченного enum-значения:
  //   "mode": apply_patch"    ← есть закрывающая кавычка (нужно съесть)
  //   "mode": apply_patch,    ← нет кавычек, запятая
  //   "mode": apply_patch}    ← нет кавычек, скобка
  //   "mode": apply_patch     ← нет кавычек, конец строки
  //
  // КЛЮЧЕВОЙ ФИКС: `"?` ОПЦИОНАЛЬНО СЪЕДАЕТ закрывающую кавычку.
  // Раньше был lookahead `(?=...)` который НЕ потреблял кавычку →
  // получалось `"mode": "apply_patch""` (двойная кавычка) → JSON.parse падал.
  // Теперь `"?` съедает существующую кавычку, мы добавляем свои → чисто.
  //
  // Также: Levenshtein ≤ 2 для опечаток (applyy_patch → apply_patch).
  //
  // КРИТИЧНО: capture group для prefix (ключ + двоеточие + пробелы),
  // чтобы replacement восстанавливал ключ.
  if (ENUM_KEY_NAMES.length > 0) {
    const keyPattern = ENUM_KEY_NAMES.join('|')
    const unquotedEnum = new RegExp(
      `("(?:${keyPattern})":\\s*)(?!")([a-zA-Z_][a-zA-Z0-9_-]*)"?(?=[,}\\]]|$)`,
      'gi',
    )
    result = result.replace(unquotedEnum, (_m, prefix: string, val: string) => {
      const keyMatch = prefix.match(/^"([^"]+)"/)
      const keyName = keyMatch?.[1] ?? ''
      const allowed = ENUM_KEY_MAP.get(keyName)
      let corrected = val
      if (allowed && !allowed.has(val)) {
        // Fuzzy typo correction: ближайший enum с Levenshtein ≤ 2
        let bestDist = Infinity
        let bestMatch = val
        for (const candidate of allowed) {
          const dist = levenshtein(val.toLowerCase(), candidate.toLowerCase())
          if (dist < bestDist) {
            bestDist = dist
            bestMatch = candidate
          }
        }
        if (bestDist <= 2) corrected = bestMatch
      }
      if (corrected !== val) fixes.push(`typo: ${val} → ${corrected}`)
      fixes.push(`unquoted enum: ${val}`)
      return `${prefix}"${corrected}"`
    })
  }

  // Проход 2: trailing comma перед } или ]
  if (/,\s*[}\]]/.test(result)) {
    result = result.replace(/,(\s*[}\]])/g, '$1')
    fixes.push('trailing comma')
  }

  // Проход 3: незакрытая кавычка последнего строкового значения перед }
  const unclosedString = /:\s*"([^"]*[^"\\])\s*(\})\s*$/
  if (unclosedString.test(result) && !result.endsWith('"')) {
    result = result.replace(unclosedString, ': "$1"$2')
    fixes.push('unclosed string quote')
  }

  // Проход 4: одинарные кавычки вместо двойных.
  // Модель (особенно DeepSeek) иногда генерирует: 'path': 'src/foo.ts'
  // вместо 'path': "src/foo.ts". JSON требует двойные кавычки.
  // Ловим только key:value пары с одинарными кавычками, не трогаем
  // двойные (внутри которых могут быть апострофы: "don't").
  const beforeSingleQuotes = result
  result = result.replace(
    /'([^'\\]*(?:\\.[^'\\]*)*)'(\s*[:,\]}])/g,
    (_m, content: string, suffix: string) => `"${content}"${suffix}`,
  )
  if (result !== beforeSingleQuotes) fixes.push('single quotes → double quotes')

  // Проход 5: литеральные newlines внутри строковых значений.
  // Модель шлёт реальный \n внутри "content": "строка1\nстрока2"
  // (с настоящим переводом строки, а не escape-последовательностью).
  // JSON.parse падает на этом. Заменяем литеральный \n на \\n.
  if (/:\s*"[^"]*\n[^"]*"/.test(result)) {
    // Внутри строковых значений заменяем реальные newlines на \n
    // Идём по строке, отслеживая контекст (внутри/вне строки)
    let inString = false
    let escaped = false
    let out = ''
    for (let i = 0; i < result.length; i++) {
      const ch = result[i]
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === '\\' && inString) {
        out += ch
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        out += ch
        continue
      }
      if (ch === '\n' && inString) {
        out += '\\n'
        continue
      }
      if (ch === '\r' && inString) {
        // \r и \r\n → \n
        if (result[i + 1] === '\n') i++ // skip \n
        out += '\\n'
        continue
      }
      if (ch === '\t' && inString) {
        out += '\\t'
        continue
      }
      out += ch
    }
    result = out
    fixes.push('literal newline → \\n')
  }

  // Проход 6: незакрытые скобки — JSON обрезан на середине (обрыв стрима).
  // Считаем баланс {/[ и }/]. Если есть недостающие закрывающие — добавляем.
  // Это безопасно: лишние } в конце JSON валидны (парсится внешний объект).
  {
    const opens = (result.match(/[[{]/g) ?? []).length
    const closes = (result.match(/[}\]]/g) ?? []).length
    const diff = opens - closes
    if (diff > 0 && diff <= 4) {
      // Нужно добавить diff закрывающих скобок. Но порядок важен:
      // } и ] должны соответствовать открывающим. Простой подход:
      // парсим стеком, добавляем в обратном порядке.
      const stack: string[] = []
      let inStr = false
      let esc = false
      for (let i = 0; i < result.length; i++) {
        const ch = result[i]
        if (esc) { esc = false; continue }
        if (ch === '\\' && inStr) { esc = true; continue }
        if (ch === '"') { inStr = !inStr; continue }
        if (inStr) continue
        if (ch === '{') stack.push('}')
        else if (ch === '[') stack.push(']')
        else if (ch === '}' || ch === ']') stack.pop()
      }
      if (stack.length > 0 && stack.length <= 4) {
        // Добавляем закрывающие в обратном порядке (стек уже LIFO)
        result = result + stack.reverse().join('')
        fixes.push(`added ${stack.length} missing closing bracket(s)`)
      }
    }
  }

  // Проход 7: незакавыченные пути Windows с обратными слешами.
  // Модель шлёт: "path": C:\Projects\foo.ts → "path": "C:\\Projects\\foo.ts"
  // Ловим только для path/cwd/url ключей, и только если значение
  // начинается с буквы диска (C:\, D:\) или / — признаки пути.
  const pathKeyPattern = /("(?:path|cwd|url)":\s*)(?!")([A-Za-z]:\\[^\s,}\]]+|[\\/][^\s,}\]]+)/g
  const beforePaths = result
  result = result.replace(pathKeyPattern, (_m, prefix: string, val: string) => {
    // Экранируем обратные слеши для JSON
    const escaped = val.replace(/\\/g, '\\\\')
    return `${prefix}"${escaped}"`
  })
  if (result !== beforePaths) fixes.push('unquoted Windows path')

  return { repaired: result, fixed: fixes.length > 0, fixes }
}

/**
 * Salvage mode для edit_file: если jsonrepair и tryRepairJson оба не справились,
 * пытаемся извлечь path, old_str, new_str из битого JSON по регексу.
 * mode дефолтим к str_replace (единственный режим правки существующих файлов).
 *
 * old_str/new_str могут быть усечены — это БЕЗОПАСНО: если old_str обрезан —
 * strReplaceCore не найдёт совпадение → тул вернёт "old_str not found" →
 * модель перечитает файл и retry. Никакая неправильная правка не применится.
 *
 * Возвращает null если path или old_str не найдены — тогда parseError остаётся.
 */
export function salvageEditFileArgs(raw: string): Record<string, unknown> | null {
  // path — всегда в начале JSON, обычно intact (короткое значение)
  const pathMatch = raw.match(/"path":\s*"([^"]+)"/)
  if (!pathMatch) return null

  // Извлекаем строковое значение по имени ключа из битого JSON.
  // Берём максимально жадно: до закрывающей кавычки. Если стрим обрезан — берём до конца.
  const extractString = (key: string): string | null => {
    const keyIdx = raw.indexOf(`"${key}"`)
    if (keyIdx === -1) return null
    const colonIdx = raw.indexOf(':', keyIdx)
    if (colonIdx === -1) return null
    let i = colonIdx + 1
    while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n')) i++
    if (i >= raw.length || raw[i] !== '"') return null
    i++ // пропускаем открывающую кавычку

    let result = ''
    let escaped = false
    while (i < raw.length) {
      const ch = raw[i]
      if (escaped) {
        if (ch === 'n') result += '\n'
        else if (ch === 't') result += '\t'
        else if (ch === 'r') result += '\r'
        else if (ch === '"') result += '"'
        else if (ch === '\\') result += '\\'
        else if (ch === '/') result += '/'
        else result += ch
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        break
      } else {
        result += ch
      }
      i++
    }
    return result
  }

  const oldStr = extractString('old_str')
  if (!oldStr || !oldStr.trim()) return null

  // new_str опционален для salvage — если нет, дефолтим к пустой строке
  // (означает удаление old_str). Лучше попытаться, чем сдаться.
  const newStr = extractString('new_str') ?? ''

  return {
    path: pathMatch[1],
    old_str: oldStr,
    new_str: newStr,
  }
}


export function getToolErrorHint(toolName: string, error: string): string {
  const e = error.toLowerCase()
  // Русско-английская нормализация: тулы возвращают русские сообщения
  // («не найден», «таймаут», «отказано в доступе»), а hint'ы раньше
  // матчили только английские подстроки → 5 из 7 hint'ов никогда не
  // срабатывали. Теперь матчим оба языка.
  const ruE = error.toLowerCase()
  const matchAny = (...subs: string[]) => subs.some(s => e.includes(s) || ruE.includes(s.toLowerCase()))

  // edit_file: old_str/SEARCH не найден — подсказка перечитать файл.
  // Покрывает: replace ("old_str не найден"), apply_patch ("SEARCH не найден"),
  // fuzzy-fail, и английский "not found".
  if (toolName === 'edit_file' && matchAny('not found', 'old_str', 'search', 'не найден')) {
    return '\n\n[Hint: файл мог измениться. Перечитай его read_file и используй актуальный фрагмент как old_str / SEARCH.]'
  }
  if ((toolName === 'read_file' || toolName === 'write_file') && matchAny('no such file', 'enoent', 'not found', 'не найден')) {
    return '\n\n[Hint: путь не существует. Используй find_files чтобы найти правильный путь.]'
  }
  if (toolName === 'run_command') {
    if (matchAny('not recognized', 'command not found', 'не распознан', 'не является внутренней или внешней')) {
      return '\n\n[Hint: команда не найдена. Проверь что она установлена, или используй известную альтернативу.]'
    }
    if (matchAny('permission', 'access denied', 'отказано в доступе', 'нет доступа', 'eperm', 'eacces')) {
      return '\n\n[Hint: нет прав. Возможно нужен другой путь, запуск от администратора, или файл занят другим процессом.]'
    }
    if (matchAny('timed out', 'timeout', 'превысил таймаут', 'превысила таймаут', 'timeout:', 'процесс убит')) {
      return '\n\n[Hint: команда превысила таймаут. Передай большее значение timeout (120/300) или разбей на более короткие шаги.]'
    }
    if (matchAny('ebusy', 'resource busy', 'занят другим процессом')) {
      return '\n\n[Hint: файл/ресурс занят другим процессом. Закрой редактор/приложение которое держит файл, и повтори.]'
    }
  }
  if (toolName === 'search_code' && matchAny('rg', 'ripgrep', 'not found', 'не найден', 'совпадений не найдено')) {
    return '\n\n[Hint: ripgrep недоступен — задействован PowerShell-фолбэк. Если поиск пуст, проверь path и pattern, либо используй literal=true для дословного поиска. Убедись что path существует.]'
  }
  if (toolName === 'fetch_page' && matchAny('timed out', 'timeout', 'превысил таймаут')) {
    return '\n\n[Hint: страница слишком тяжёлая или сайт медленно отвечает. Попробуй позже или используй search_web для краткого содержания.]'
  }
  if (toolName === 'find_files' && matchAny('not found', 'не найдено', 'файлов не найдено')) {
    return '\n\n[Hint: упрости pattern (например *.ts) или проверь path. Используй search_code если нужно найти по содержимому.]'
  }
  if (toolName === 'list_directory' && matchAny('not found', 'не найден', 'eacces', 'отказано')) {
    return '\n\n[Hint: папка недоступна или не существует. Проверь путь или права доступа.]'
  }
  if (toolName === 'get_diagnostics' && matchAny('не запустился', 'не смог запуститься', 'tsc не', 'eslint не')) {
    return '\n\n[Hint: диагностическая команда упала — проверка не отработала. Запусти run_command "npx tsc --noEmit" вручную чтобы увидеть причину.]'
  }
  return ''
}

export function isSequentialTool(name: string): boolean {
  // run_command — sequential: lastShellCwd это shared state, и при
  // Promise.all параллельные команды читают/пишут его одновременно
  // (cd project + npm test в одном раунде → npm test запустится в wrong cwd).
  // run_command вернули в sequential: lastShellCwd — shared state, и при
  // Promise.all параллельные команды читают/пишут его одновременно
  // (cd project + npm test в одном раунде → npm test в wrong cwd).
  return name === 'write_file' ||
    name === 'edit_file' ||
    name === 'manage_chats' ||
    name === 'run_command'
}

export function stableStringify(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${stableStringify(v)}`)
    return `{${entries.join(',')}}`
  }
  return String(value)
}

export function buildToolFingerprint(toolName: string, args: Record<string, unknown>): AgentToolCallFingerprint {
  const normalizedArgs: Record<string, unknown> = { ...args }
  // Truncation head+tail (80+80) вместо head-only (160): правки в КОНЦЕ
  // patch/old_str/new_str теперь дают другой fingerprint. Раньше модель
  // правила конец SEARCH-блока при retry, первые 160 символов совпадали →
  // loop-guard считал это повтором → hard block убивал edit_file на сессии.
  for (const key of ['content', 'old_str', 'new_str', 'patch']) {
    if (typeof normalizedArgs[key] === 'string' && normalizedArgs[key].length > 160) {
      const s = normalizedArgs[key] as string
      normalizedArgs[key] = `${s.slice(0, 80)}...${s.slice(-80)}`
    }
  }
  // Для search_code нормализуем `pattern` так, чтобы косметические вариации
  // (foo / Foo / foo( / " foo " / foo$) давали ОДИНАКОВЫЙ fingerprint — иначе
  // loop-guard на N повторов не срабатывает и модель десятками шагов перебирает
  // паттерны в надежде найти то же самое. Семантически они идентичны.
  // ignore_case / literal флаги не учитываем — они не меняют суть поиска.
  if (toolName === 'search_code' && typeof normalizedArgs.pattern === 'string') {
    normalizedArgs.pattern = (normalizedArgs.pattern as string)
      .toLowerCase()
      .replace(/[\s\t\r\n]+/g, '')
      .replace(/[(){}[\].,*+?^$|\\/-]/g, '')
    normalizedArgs.ignore_case = undefined
    normalizedArgs.literal = undefined
    if (typeof normalizedArgs.pattern === 'string' && normalizedArgs.pattern.length > 120) {
      normalizedArgs.pattern = (normalizedArgs.pattern as string).slice(0, 120)
    }
  }
  // Для read_file / read_files нормализуем `path` (и `paths`) так, чтобы
  // косметические вариации (./src/foo.ts, src\foo.ts, src/foo.ts) давали
  // ОДИНАКОВЫЙ fingerprint — иначе loop-guard не ловит повторное чтение
  // того же файла с чуть другим путём. normalize() убирает ./ и нормализует
  // разделители; resolve() делает путь абсолютным (от cwd), что дополнительно
  // унифицирует относительные и абсолютные пути.
  // ВАЖНО: offset/limit НЕ убираем из fingerprint — auto-advance в Agent.ts
  // вызывает read_file без offset, но каждый раз получает РАЗНЫЙ чанк.
  // Если стереть offset/limit, все вызовы получают одинаковый fingerprint →
  // loop guard ложно срабатывает на auto-advance.
  if (toolName === 'read_file' && typeof normalizedArgs.path === 'string') {
    try { normalizedArgs.path = resolve(normalize(normalizedArgs.path as string)) } catch { /* ok */ }
  }
  if (toolName === 'read_files' && Array.isArray(normalizedArgs.paths)) {
    normalizedArgs.paths = (normalizedArgs.paths as string[]).map((p) => {
      try { return resolve(normalize(p)) } catch { return p }
    })
  }
  return {
    toolName,
    argsKey: stableStringify(normalizedArgs),
  }
}

export function getToolRounds(messages: AgentMessage[]): ToolRound[] {
  const rounds: ToolRound[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as AgentMessage & { tool_calls?: Array<{ function?: { name?: string } }> }
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue
    const toolIndices: number[] = []
    let j = i + 1
    while (j < messages.length && messages[j].role === 'tool') {
      toolIndices.push(j)
      j++
    }
    rounds.push({
      assistantIndex: i,
      toolIndices,
      toolNames: msg.tool_calls.map((tc: { function?: { name?: string } }) => tc.function?.name || 'tool'),
    })
  }
  return rounds
}

/**
 * Аварийный клапан: если токены сообщений реально подбираются к лимиту модели
 * (hardLimitTokens, см. getHardLimitTokens) — физически удаляем самые старые
 * целые tool-раунды (assistant+tool сообщения целиком), без замены на
 * текст-резюме. Это защита от hard-fail API, а не проактивное сжатие:
 * срабатывает исключительно на грани реального предела.
 *
 * Гистерезис: при срабатывании дропаем НЕ до hardLimitTokens, а до
 * targetTokens (значительно ниже) — иначе следующий же раунд тулов сразу
 * снова превышает hardLimitTokens и клапан триггерится повторно на каждом
 * шаге, давая пилообразный (то много, то мало) реальный prompt_tokens вместо
 * плавного роста. targetTokens задаёт запас, в который новые раунды могут
 * расти, прежде чем клапан сработает снова.
 */
export function dropOldestRoundsIfOverflow(
  messages: AgentMessage[],
  hardLimitTokens: number,
  targetTokens: number,
): AgentMessage[] {
  const estimated = messages.reduce((sum, msg) => sum + estimateTokens(typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.map(p => 'text' in p ? p.text : '').join('') : '')) + 4, TOOL_SCHEMAS_OVERHEAD)
  if (estimated <= hardLimitTokens) return messages

  const rounds = getToolRounds(messages)
  if (rounds.length === 0) return messages

  // Удаляем раунды с начала (самые старые), пока не уложимся в targetTokens
  // (не hardLimitTokens — см. комментарий выше про гистерезис).
  // Сохраняем system-сообщения и последнее user-сообщение.
  const removeIndices = new Set<number>()
  let currentEstimate = estimated
  for (const round of rounds) {
    if (currentEstimate <= targetTokens) break
    removeIndices.add(round.assistantIndex)
    for (const toolIndex of round.toolIndices) removeIndices.add(toolIndex)
    for (const idx of [round.assistantIndex, ...round.toolIndices]) {
      const c = messages[idx].content
      currentEstimate -= estimateTokens(typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => 'text' in p ? p.text : '').join('') : '')) + 4
    }
  }

  if (removeIndices.size === 0) return messages

  const result = messages.filter((_, index) => !removeIndices.has(index))
  // Вставляем короткую метку чтобы модель знала что старые раунды были удалены
  const firstNonSystem = result.findIndex(msg => msg.role !== 'system')
  const insertAt = firstNonSystem === -1 ? result.length : firstNonSystem
  result.splice(insertAt, 0, {
    role: 'system',
    content: `[Старые tool-раунды удалены для экономии контекста — ${removeIndices.size} сообщений]`,
  })
  log('[Agent] dropOldestRoundsIfOverflow сработал: estimated=%s hardLimitTokens=%s targetTokens=%s removedMessages=%s остаток~=%s',
    estimated, hardLimitTokens, targetTokens, removeIndices.size, currentEstimate)
  return result
}

/**
 * Извлекает имя MCP-сервера из полного имени тула `mcp__server__tool`.
 * Возвращает undefined для встроенных тулов. Sanitized-имя сервера может
 * содержать подчёркивания, поэтому берём всё между первым и последним `__`.
 */
export function extractMcpServerName(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined
  const rest = toolName.slice(5) // убираем 'mcp__'
  const firstSep = rest.indexOf('__')
  if (firstSep === -1) return undefined
  const lastSep = rest.lastIndexOf('__')
  if (lastSep === firstSep) {
    // Только один `__` — сервер до него, тул после
    return rest.slice(0, firstSep)
  }
  // Несколько `__` — сервер между первым и последним, но имя сервера
  // это всё до последнего `__` (т.к. тул — последний сегмент)
  return rest.slice(0, lastSep)
}
