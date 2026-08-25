/**
 * commandSafety.ts — единый источник правды для классификации опасности
 * действий агента. Покрывает как run_command, так и файловые тулы
 * (write_file/edit_file). UI (AgentConfirmDialog) должен
 * импортировать классификацию отсюда, а не дублировать шаблоны.
 *
 * Уровни опасности:
 *   SAFE      — безопасно, выполнять без подтверждения
 *   WARN      — потенциально опасно, но обратимо (ask режим спрашивает)
 *   DANGEROUS — необратимо опасно (auto блокирует, ask спрашивает)
 *   BLOCKED   — всегда блокировать независимо от режима (fork bomb, disk wipe и т.д.)
 */

export type DangerLevel = 'safe' | 'warn' | 'dangerous' | 'blocked'

export interface SafetyResult {
  level: DangerLevel
  reason: string
  matchedPattern?: string
}

// ─── Опции классификации ────────────────────────────────────────────────────

export interface ClassifyOpts {
  /** Список запрещённых путей из agentPermissions.forbiddenPaths */
  forbiddenPaths?: string[]
  /** Рабочая директория чата — для резолва относительных путей при проверке
   *  существования файла (write_file). Если не задана — fallback на process.cwd(). */
  workdir?: string
}

// ─── Path guard: проверка пути against forbiddenPaths (sandbox) ──────────────

/** Нормализует путь для сравнения (lowercase, обратные слеши, без trailing sep). */
function normalizePath(p: string): string {
  return p
    .toLowerCase()
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .trim()
}

/**
 * Проверяет, попадает ли путь в список запрещённых.
 * Сравнение по префиксу: путь запрещён, если он равен или находится внутри
 * одной из forbiddenPaths. Например forbiddenPath "C:\Windows" блокирует
 * "C:\Windows\System32\drivers\etc\hosts".
 */
export function isPathForbidden(path: string, forbiddenPaths?: string[]): boolean {
  if (!forbiddenPaths || forbiddenPaths.length === 0) return false
  const norm = normalizePath(path)
  if (!norm) return false
  return forbiddenPaths.some(fp => {
    const nfp = normalizePath(fp)
    if (!nfp) return false
    // Точное совпадение или путь внутри запрещённой директории
    return norm === nfp || norm.startsWith(nfp + '\\')
  })
}

/**
 * Эвристическая проверка: упоминается ли один из forbiddenPaths в команде.
 * Грубо, но ловит очевидные случаи (rm C:\Windows\...).
 */
function commandTouchesForbiddenPath(cmd: string, forbiddenPaths?: string[]): boolean {
  if (!forbiddenPaths || forbiddenPaths.length === 0) return false
  const lowerCmd = cmd.toLowerCase()
  return forbiddenPaths.some(fp => {
    const nfp = fp.toLowerCase().replace(/\//g, '\\')
    return nfp && lowerCmd.includes(nfp)
  })
}

// ─── Нормализация ──────────────────────────────────────────────────────────

function normalize(cmd: string): string {
  return cmd
    .toLowerCase()
    .replace(/\r?\n/g, ' ')       // многострочные → одна строка
    .replace(/\s+/g, ' ')         // множественные пробелы
    .replace(/`\s*/g, ' ')        // PowerShell backtick line continuation
    .replace(/\\\s*/g, ' ')       // bash line continuation
    .trim()
}

// ─── Утилиты ───────────────────────────────────────────────────────────────

function has(cmd: string, ...patterns: string[]): boolean {
  return patterns.some(p => cmd.includes(p))
}

function hasWord(cmd: string, ...words: string[]): boolean {
  return words.some(w => {
    const re = new RegExp(`(^|[\\s;|&>(])${w.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}([\\s;|&<(]|$)`)
    return re.test(cmd)
  })
}

// ─── BLOCKED — всегда отклонять ────────────────────────────────────────────

const BLOCKED_CHECKS: Array<{ test: (cmd: string) => boolean; reason: string }> = [
  // Fork bomb
  {
    test: cmd => has(cmd, ':(){ :|:& };:', ':(){:|:&};:', ':(){ :|: & };:'),
    reason: 'Fork bomb — бесконечное порождение процессов',
  },
  // Перезапись блочных устройств
  {
    test: cmd => /dd\s+(?:.*\s+)?of=\/dev\/(sd|hd|nvme|vd|xvd|mmcblk)/.test(cmd),
    reason: 'Запись напрямую на блочное устройство — уничтожение данных диска',
  },
  // Уничтожение корневой ФС
  {
    test: cmd => has(cmd, 'rm -rf /', 'rm -rf/', 'rm --no-preserve-root -rf /', 'rm -rf --no-preserve-root /'),
    reason: 'Рекурсивное удаление корня файловой системы',
  },
  {
    test: cmd => /wipefs\s+.*\/dev\/(sd|hd|nvme)/.test(cmd),
    reason: 'Уничтожение файловой системы на диске',
  },
  {
    test: cmd => /mkfs\s+.*\/dev\/(sd|hd|nvme)/.test(cmd),
    reason: 'Форматирование блочного устройства',
  },
  // Pipe shell execution (curl/wget | sh/bash/python)
  {
    test: cmd => /(?:curl|wget)\s+.*\|\s*(?:sh|bash|zsh|python|python3|perl|ruby|node)/.test(cmd),
    reason: 'Выполнение кода загруженного из интернета — потенциальный RCE',
  },
  // PowerShell invoke-expression с URL
  {
    test: cmd => /(?:invoke-expression|iex)\s*[\(&].*(?:http|www\.|net\.webclient)/.test(cmd),
    reason: 'PowerShell IEX с загрузкой из интернета — потенциальный RCE',
  },
  // Запись в MBR/GPT
  {
    test: cmd => /dd\s+.*of=\/dev\/[a-z]+\s+bs=512\s+count=1/.test(cmd),
    reason: 'Перезапись MBR/GPT — уничтожение загрузчика',
  },
]

// ─── DANGEROUS — необратимо, требует подтверждения ─────────────────────────

const DANGEROUS_CHECKS: Array<{ test: (cmd: string) => boolean; reason: string }> = [
  // ── Удаление файлов/папок (bash/sh) ──
  {
    test: cmd => /rm\s+(-[^\s]*r[^\s]*|-r[^\s]*)\s/.test(cmd) || /rm\s+-rf?\s/.test(cmd),
    reason: 'Рекурсивное удаление файлов (rm -r/-rf)',
  },
  {
    test: cmd => hasWord(cmd, 'rmdir') && has(cmd, '/s'),
    reason: 'Удаление папки со всем содержимым (rmdir /s)',
  },
  {
    test: cmd => hasWord(cmd, 'rd') && has(cmd, '/s'),
    reason: 'Удаление папки со всем содержимым (rd /s)',
  },
  {
    test: cmd => /del\s+.*\/[sfq]/.test(cmd),
    reason: 'Принудительное/тихое удаление файлов (del /s /f /q)',
  },

  // ── PowerShell удаление ──
  {
    test: cmd => /remove-item\s+.*(-recurse|-r|-force|-fo|-rec)/.test(cmd) || /\bri\s+.*(-recurse|-force)/.test(cmd),
    reason: 'PowerShell: рекурсивное/принудительное удаление (Remove-Item -Recurse/-Force)',
  },
  {
    test: cmd => /remove-item\s+.*\*/.test(cmd),
    reason: 'PowerShell: удаление по маске (Remove-Item *)',
  },

  // ── Форматирование ──
  {
    test: cmd => /^format\s+[a-z]:/i.test(cmd) || /format\s+\/fs:/i.test(cmd),
    reason: 'Форматирование диска (format)',
  },
  {
    test: cmd => /format-volume\s/.test(cmd),
    reason: 'PowerShell: форматирование тома (Format-Volume)',
  },
  {
    test: cmd => hasWord(cmd, 'diskpart'),
    reason: 'DiskPart — изменение разделов диска',
  },

  // ── Уничтожение данных ──
  {
    test: cmd => hasWord(cmd, 'shred') || hasWord(cmd, 'sdelete') || hasWord(cmd, 'wipe'),
    reason: 'Безвозвратное уничтожение данных (shred/sdelete/wipe)',
  },
  {
    test: cmd => /cipher\s+.*\/w/.test(cmd),
    reason: 'Перезапись свободного места (cipher /w) — медленно и необратимо',
  },

  // ── Системные изменения ──
  {
    test: cmd => hasWord(cmd, 'shutdown') || has(cmd, 'stop-computer') || has(cmd, 'restart-computer'),
    reason: 'Выключение/перезагрузка системы',
  },
  {
    test: cmd => /taskkill\s+.*\/f/i.test(cmd) || /taskkill\s+.*\/im\s+\*/i.test(cmd),
    reason: 'Принудительное завершение процессов (taskkill /f)',
  },
  {
    test: cmd => /kill\s+-9/.test(cmd) || hasWord(cmd, 'killall') || has(cmd, 'stop-process -force'),
    reason: 'Принудительное завершение процессов (kill -9/killall)',
  },

  // ── Реестр Windows ──
  {
    test: cmd => /reg\s+(delete|add|import|export|copy)\s/i.test(cmd),
    reason: 'Изменение реестра Windows (reg add/delete)',
  },
  {
    test: cmd => /remove-item\s+.*hk(lm|cu|cr|u|cc):/i.test(cmd) || /ri\s+.*hk(lm|cu):/i.test(cmd),
    reason: 'PowerShell: удаление ключей реестра',
  },
  {
    test: cmd => /set-itemproperty\s+.*hk(lm|cu|cr):/i.test(cmd),
    reason: 'PowerShell: изменение значений реестра',
  },

  // ── Загрузчик и системные утилиты ──
  {
    test: cmd => hasWord(cmd, 'bcdedit') || hasWord(cmd, 'bootrec') || hasWord(cmd, 'bootsect'),
    reason: 'Изменение загрузчика Windows (bcdedit/bootrec)',
  },

  // ── Сетевые настройки ──
  {
    test: cmd => /netsh\s+(interface|firewall|wlan|advfirewall)\s+(delete|reset|set|add)/i.test(cmd),
    reason: 'Изменение сетевых настроек/файервола (netsh)',
  },

  // ── Службы Windows ──
  {
    test: cmd => /sc\s+(delete|stop|create)\s/i.test(cmd) || /stop-service\s/i.test(cmd),
    reason: 'Управление службами Windows (sc delete/stop)',
  },

  // ── Git деструктивные ──
  {
    test: cmd => /git\s+(push|p)\s+.*(-f\b|--force)/.test(cmd),
    reason: 'Git force push — перезапись истории на удалённом репозитории',
  },
  {
    test: cmd => /git\s+reset\s+--hard/.test(cmd),
    reason: 'Git reset --hard — безвозвратная потеря незакоммиченных изменений',
  },
  {
    test: cmd => /git\s+clean\s+.*-f/.test(cmd),
    reason: 'Git clean -f — удаление неотслеживаемых файлов',
  },

  // ── chmod/chown опасные ──
  {
    test: cmd => /chmod\s+.*-r\s+.*777\s+\//.test(cmd) || /chmod\s+777\s+\//.test(cmd),
    reason: 'chmod 777 на системных директориях — критическая уязвимость',
  },
  {
    test: cmd => /chown\s+.*-r\s+.*:\s*\//.test(cmd),
    reason: 'Рекурсивное изменение владельца системных директорий',
  },

  // ── PowerShell обход безопасности ──
  {
    test: cmd => /set-executionpolicy\s+(unrestricted|bypass)/i.test(cmd),
    reason: 'Отключение политики выполнения PowerShell',
  },
  {
    test: cmd => /disable-computerrestore/i.test(cmd),
    reason: 'Отключение восстановления системы',
  },
  {
    test: cmd => /[system.io.file]::delete/i.test(cmd),
    reason: 'Прямое удаление файла через .NET API',
  },

  // ── Переменные окружения PATH/критические ──
  {
    test: cmd => /setx\s+(path|pathext)\s+/i.test(cmd) && !has(cmd, '%path%'),
    reason: 'Перезапись системной переменной PATH (без сохранения текущего значения)',
  },
]

// ─── WARN — потенциально опасно, но обратимо ──────────────────────────────

const WARN_CHECKS: Array<{ test: (cmd: string) => boolean; reason: string }> = [
  // Удаление без рекурсии (один файл)
  {
    test: cmd => hasWord(cmd, 'rm') && !has(cmd, '-r') && !has(cmd, '--recursive'),
    reason: 'Удаление файла (rm без -r)',
  },
  {
    test: cmd => /remove-item\s+(?!.*-recurse)(?!.*-r\b)/.test(cmd),
    reason: 'PowerShell: удаление файла (Remove-Item без -Recurse)',
  },
  // Изменение прав доступа
  {
    test: cmd => hasWord(cmd, 'chmod') || hasWord(cmd, 'chown') || hasWord(cmd, 'icacls'),
    reason: 'Изменение прав доступа к файлам',
  },
  // Сетевые подключения
  {
    test: cmd => has(cmd, 'invoke-webrequest') || has(cmd, 'invoke-restmethod'),
    reason: 'PowerShell: сетевой запрос',
  },
  // Запись в системные директории
  {
    test: cmd => /(?:cp|copy|mv|move|xcopy|robocopy)\s+.*(?:\/system32|\/program files|\/windows\/)/i.test(cmd),
    reason: 'Копирование/перемещение в системную директорию',
  },
  // Планировщик задач
  {
    test: cmd => /schtasks\s+\/(create|delete|change)/i.test(cmd) || has(cmd, 'register-scheduledtask'),
    reason: 'Создание/изменение задач планировщика',
  },
  // eval/exec
  {
    test: cmd => hasWord(cmd, 'eval') || hasWord(cmd, 'exec'),
    reason: 'Динамическое выполнение кода (eval/exec)',
  },
  // Git push (без force)
  {
    test: cmd => /git\s+push\b/.test(cmd) && !has(cmd, '--force') && !has(cmd, ' -f'),
    reason: 'Git push в удалённый репозиторий',
  },
]

// ─── Классификация файловых тулов ───────────────────────────────────────────

/**
 * Классифицирует опасность файлового тула (write_file/edit_file).
 *
 * Правила:
 *   - Путь в forbiddenPaths → BLOCKED (нельзя трогать системные папки)
 *   - write_file → SAFE (создание нового файла; перезапись запрещена в fileEdit.ts)
 *   - edit_file → SAFE (точечные правки, есть diff)
 */
export function classifyFileTool(
  toolName: string,
  args: Record<string, unknown>,
  opts?: ClassifyOpts,
): SafetyResult {
  const path = String(args.path ?? '')

  // 1. forbiddenPaths — всегда блок
  if (path && isPathForbidden(path, opts?.forbiddenPaths)) {
    return {
      level: 'blocked',
      reason: `Путь "${path}" в списке запрещённых (forbiddenPaths). Действие заблокировано.`,
      matchedPattern: 'forbidden_path',
    }
  }

  // 2. write_file — теперь всегда safe: создаёт только новый файл, перезапись
  //    существующего блокируется в fileEdit.ts (вернёт ошибку модели).
  if (toolName === 'write_file') {
    if (!path) {
      return { level: 'warn', reason: 'write_file без path — нельзя проверить путь', matchedPattern: 'write_no_path' }
    }
    return { level: 'safe', reason: 'Создание нового файла (перезапись запрещена)', matchedPattern: 'write_create' }
  }

  // 3. edit_file — точечные правки, безопасны (есть diff)
  return { level: 'safe', reason: 'Точечная правка файла (есть diff для отката)' }
}

/**
 * Единый диспетчер классификации любого тула. UI должен использовать эту
 * функцию вместо дублирования шаблонов.
 */
export function classifyTool(
  toolName: string,
  args: Record<string, unknown>,
  opts?: ClassifyOpts,
): SafetyResult {
  if (toolName === 'run_command') {
    const base = classifyCommand(String(args.command ?? ''))
    // Дополнительно: команда затрагивает запрещённый путь → блок
    if (base.level !== 'blocked' && commandTouchesForbiddenPath(String(args.command ?? ''), opts?.forbiddenPaths)) {
      return {
        level: 'blocked',
        reason: 'Команда затрагивает запрещённый путь (forbiddenPaths)',
        matchedPattern: 'forbidden_path',
      }
    }
    return base
  }

  if (toolName === 'write_file' || toolName === 'edit_file') {
    return classifyFileTool(toolName, args, opts)
  }

  // fetch_page / search_images — read-only web tools, always safe.
  // fetch_page downloads a URL and returns text; search_images queries DDG.
  // Neither sends data or modifies external state.
  if (toolName === 'fetch_page' || toolName === 'search_images') {
    return { level: 'safe', reason: 'Web read-only tool — no side effects', matchedPattern: 'web_read' }
  }

  // Прочие тулы (read_file, search_web, и т.д.) — безопасны по умолчанию.
  // read_file тоже проверяем against forbiddenPaths? План говорит про
  // запись/удаление — чтение оставляем разрешённым (агент-ассистент должен
  // уметь читать любой файл по запросу пользователя).
  return { level: 'safe', reason: 'Инструмент только для чтения/без побочных эффектов' }
}

// ─── Главная функция классификации ────────────────────────────────────────

export function classifyCommand(cmd: string): SafetyResult {
  const normalized = normalize(cmd)

  // 1. BLOCKED — всегда отклонять
  for (const check of BLOCKED_CHECKS) {
    if (check.test(normalized)) {
      return { level: 'blocked', reason: check.reason, matchedPattern: 'blocked' }
    }
  }

  // 2. DANGEROUS — необратимо
  for (const check of DANGEROUS_CHECKS) {
    if (check.test(normalized)) {
      return { level: 'dangerous', reason: check.reason, matchedPattern: 'dangerous' }
    }
  }

  // 3. WARN — потенциально опасно
  for (const check of WARN_CHECKS) {
    if (check.test(normalized)) {
      return { level: 'warn', reason: check.reason, matchedPattern: 'warn' }
    }
  }

  return { level: 'safe', reason: 'Команда безопасна' }
}

/**
 * Нужно ли подтверждение для данного тула и режима?
 *
 * blocked: блокировать везде независимо от режима
 * auto:    умный режим — dangerous+warn спрашивать, safe пропускать.
 *          Если confirmDangerous=false, dangerous пропускается без подтверждения
 *          (только blocked блокируется) — более перmissive режим.
 * ask:     спрашивать каждый тул
 * full:    полный доступ — всё пропускается без проверок
 *
 * Опции:
 *   confirmDangerous — из agentPermissions.confirmDangerous (по умолч. true)
 *   forbiddenPaths   — из agentPermissions.forbiddenPaths
 */
export function needsApproval(
  toolName: string,
  args: Record<string, unknown>,
  mode: 'auto' | 'ask' | 'full',
  opts?: { confirmDangerous?: boolean; forbiddenPaths?: string[]; workdir?: string },
): { confirm: boolean; block: boolean; reason: string } {
  // full — полный доступ, ничего не проверяем
  if (mode === 'full') {
    return { confirm: false, block: false, reason: '' }
  }

  // Единая классификация (покрывает и run_command, и файловые тулы)
  const result = classifyTool(toolName, args, { forbiddenPaths: opts?.forbiddenPaths, workdir: opts?.workdir })
  const confirmDangerous = opts?.confirmDangerous !== false // по умолч. true

  // blocked — блокировать везде, диалога нет
  if (result.level === 'blocked') {
    return { confirm: false, block: true, reason: result.reason }
  }

  // ask — спрашивать каждый тул кроме скрытых (вызывающий код фильтрует hidden)
  if (mode === 'ask') {
    return { confirm: true, block: false, reason: result.reason || 'Режим "спрашивать" — подтверждение на каждый тул' }
  }

  // auto — умная детекция
  if (result.level === 'dangerous') {
    // confirmDangerous=false → не спрашивать dangerous (только blocked ловим выше)
    return { confirm: confirmDangerous, block: false, reason: result.reason }
  }
  if (result.level === 'warn') {
    return { confirm: true, block: false, reason: result.reason }
  }

  return { confirm: false, block: false, reason: '' }
}
