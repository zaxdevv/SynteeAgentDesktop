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

import * as path from 'path'
import type { AutoModeSettings, NetworkPolicy, ProjectPermissionOverride, ApprovalAllowlistEntry } from '../../shared/types'
import { DEFAULT_AUTO_MODE_SETTINGS } from '../../shared/types'

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
    // ':' в trailing-границе — иначе `http://...` не матчится как сетевое
    // слово (после 'http' идёт ':', которого не было в границах).
    const re = new RegExp(`(^|[\\s;|&>(])${w.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}([\\s;|&<(:]|$)`)
    return re.test(cmd)
  })
}

// ─── Категории для гранулярных настроек авто-режима ────────────────────────

/**
 * Сетевые команды: установка пакетов, загрузка/выгрузка, удалённый доступ.
 * Управляются настройкой autoMode.askNetwork (отдельно от warn-уровня,
 * т.к. npm install и т.п. классифицируются как safe, но ходят в интернет).
 */
export function isNetworkCommand(cmd: string): boolean {
  const c = normalize(cmd)
  // Менеджеры пакетов
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci|publish)\b/.test(c)) return true
  if (/\b(?:pip|pip3)\s+install\b/.test(c)) return true
  if (/\bpython(?:3)?\s+-m\s+pip\s+install\b/.test(c)) return true
  if (/\b(?:cargo|composer|gem|go)\s+(?:install|get)\b/.test(c)) return true
  if (/\b(?:winget|choco|scoop|brew|apt|apt-get|dnf|yum|pacman)\s+(?:install|upgrade|update|remove)\b/.test(c)) return true
  if (/\bdocker\s+(?:pull|push)\b/.test(c)) return true
  // HTTP-клиенты
  if (hasWord(c, 'curl', 'wget', 'http', 'https')) return true
  if (hasWord(c, 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm')) return true
  if (/\bnet\.webclient\b/.test(c)) return true
  // Git-сетевые операции (push отдельно — askGitPush)
  if (/\bgit\s+(?:clone|fetch|pull|remote|ls-remote)\b/.test(c)) return true
  // Удалённый доступ / передача файлов
  if (hasWord(c, 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet')) return true
  return false
}

/**
 * Нужно ли спрашивать сетевую команду при данной политике:
 *   'ask-all' — любую сетевую;
 *   'smart'   — пакеты из официальных реестров пропускаем (npm/pip install
 *               без --registry и git-URL, winget/apt из официальных репо,
 *               git clone с github/gitlab/bitbucket), произвольные URL,
 *               ssh и публикацию (npm publish, docker push) — спрашиваем;
 *   'off'     — не спрашивать.
 */
export function shouldAskNetwork(cmd: string, policy: NetworkPolicy): boolean {
  if (policy === 'off') return false
  if (policy === 'ask-all') return true
  // ── smart ──
  const c = normalize(cmd)
  const hasUrl = /https?:\/\//.test(c) || /\bgit\+https?:\/\//.test(c)
  // Пакетные менеджеры из официальных реестров — пропуск
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci)\b/.test(c)) {
    return hasUrl || has(c, '--registry', 'git+', 'ssh://')
  }
  if (/\b(?:pip|pip3)\s+install\b/.test(c) || /\bpython(?:3)?\s+-m\s+pip\s+install\b/.test(c)) {
    return hasUrl || has(c, 'git+', 'ssh://', '--index-url', '--extra-index-url')
  }
  if (/\b(?:cargo|composer|gem)\s+(?:install|require|add)\b/.test(c)) return hasUrl
  if (/\bgo\s+(?:get|install)\b/.test(c)) return hasUrl
  // Системные пакетные менеджеры — официальные репозитории
  if (/\b(?:winget|choco|scoop|brew|apt|apt-get|dnf|yum|pacman)\s+(?:install|upgrade|update|remove)\b/.test(c)) {
    return hasUrl
  }
  // docker pull — официальный реестр; push — публикация, спрашиваем
  if (/\bdocker\s+pull\b/.test(c)) return hasUrl
  // git clone/fetch/pull: доверенные хосты пропускаем, прочие URL — спрашиваем
  if (/\bgit\s+(?:clone|fetch|pull|remote|ls-remote)\b/.test(c)) {
    if (!hasUrl) return false
    return !/(?:github\.com|gitlab\.com|bitbucket\.org)/.test(c)
  }
  // Всё остальное сетевое (curl/wget/iwr/ssh/scp/npm publish...) — спрашиваем
  return true
}

// ─── Allowlist «Всегда разрешать» ───────────────────────────────────────────

/** Нормализованный ключ команды для сессионной памяти и allowlist. */
export function normalizeCommandKey(cmd: string): string {
  return normalize(cmd)
}

/** Совпадает ли команда с шаблоном allowlist ('npm install *' — префикс). */
export function commandMatchesPattern(key: string, pattern: string): boolean {
  const p = normalize(pattern)
  if (!p || !key) return false
  if (p.endsWith('*')) {
    const prefix = p.slice(0, -1).trimEnd()
    return key.startsWith(prefix)
  }
  return key === p
}

/**
 * Разрешено ли действие allowlist'ом (сессионная память + сохранённые
 * правила). Покрывает run_command (команда/шаблон) и файловые тулы (путь).
 * DANGEROUS-уровень НЕ разрешается allowlist'ом — это проверяет вызывающий.
 */
export function actionAllowlistKey(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'run_command') return `run_command|${normalizeCommandKey(String(args.command ?? ''))}`
  if (toolName === 'write_file' || toolName === 'edit_file') return `${toolName}|${normalizePath(String(args.path ?? ''))}`
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
    return JSON.stringify(value)
  }
  return `${toolName}|${canonical(args)}`
}

export function isAllowlisted(
  toolName: string,
  args: Record<string, unknown>,
  opts?: {
    entries?: ApprovalAllowlistEntry[]
    sessionKeys?: Set<string>
  },
): boolean {
  const exactKey = actionAllowlistKey(toolName, args)
  if (opts?.sessionKeys?.has(exactKey)) return true
  if (toolName !== 'run_command' && toolName !== 'write_file' && toolName !== 'edit_file') {
    return !!opts?.entries?.some(e => e.tool === toolName && (e.match === 'tool' || e.pattern === exactKey))
  }
  if (toolName === 'run_command') {
    const key = normalizeCommandKey(String(args.command ?? ''))
    if (!key) return false
    if (opts?.sessionKeys?.has(`run_command|${key}`)) return true
    return !!opts?.entries?.some(e => e.tool === 'run_command' && (e.match === 'tool' || commandMatchesPattern(key, e.pattern)))
  }
  if (toolName === 'write_file' || toolName === 'edit_file') {
    const p = String(args.path ?? '')
    if (!p) return false
    const np = normalizePath(p)
    if (opts?.sessionKeys?.has(`${toolName}|${np}`)) return true
    return !!opts?.entries?.some(e => e.tool === toolName && (e.match === 'tool' || normalizePath(e.pattern) === np))
  }
  return false
}

/**
 * git push без force (force — уже DANGEROUS). Отдельная настройка askGitPush.
 * Учитывает глобальные флаги git между «git» и «push» (`git -C <path> push`,
 * `git -c key=val push`) — раньше такие команды классифицировались как safe
 * и выполнялись в авто-режиме без вопроса.
 */
const GIT_PUSH_RE = /\bgit\s+(?:-[a-z-]+\s+(?:"[^"]*"|'[^']*'|[^\s"]+)\s+)*push\b/i

export function isGitPushCommand(cmd: string): boolean {
  const c = normalize(cmd)
  return GIT_PUSH_RE.test(c) && !has(c, '--force') && !has(c, ' -f')
}

/**
 * Находится ли путь вне рабочей директории (папки проекта).
 * Относительные пути резолвятся от workdir. true = вне песочницы проекта.
 */
export function isPathOutsideWorkdir(p: string, workdir: string): boolean {
  if (!p || !workdir) return false
  const abs = path.isAbsolute(p) ? p : path.resolve(workdir, p)
  const np = normalizePath(abs)
  const nw = normalizePath(workdir)
  if (!np || !nw) return false
  return !(np === nw || np.startsWith(nw + '\\'))
}

/**
 * Проверка «вне workdir» для конкретного тула:
 *  - write_file/edit_file — по args.path;
 *  - run_command — по args.cwd (если задан явно).
 * Пути внутри текста команды не парсим — слишком эвристично.
 */
export function isToolOutsideWorkdir(
  toolName: string,
  args: Record<string, unknown>,
  workdir?: string,
): boolean {
  if (!workdir) return false
  if (toolName === 'write_file' || toolName === 'edit_file') {
    const p = String(args.path ?? '')
    return !!p && isPathOutsideWorkdir(p, workdir)
  }
  if (toolName === 'run_command') {
    const cwd = String(args.cwd ?? '')
    return !!cwd && isPathOutsideWorkdir(cwd, workdir)
  }
  return false
}

// ─── Секретные файлы ────────────────────────────────────────────────────────

/** Basename файлов, содержащих секреты: .env, ключи, сертификаты, креды. */
const SECRET_BASENAME_RE =
  /(?:^|[/\\])(\.env(?:\.[^/\\]*)?|[^/\\]*\.pem|[^/\\]*\.key|id_rsa[^/\\]*|id_ed25519[^/\\]*|id_ecdsa[^/\\]*|[^/\\]*\.p12|[^/\\]*\.pfx|[^/\\]*\.kdbx|[^/\\]*\.keystore|credentials[^/\\]*|secrets?\.[^/\\]*)$/i

/**
 * Является ли путь файлом с секретами (.env, *.pem, id_rsa, credentials...).
 * Изменение — dangerous, чтение — warn + маскирование значений.
 */
export function isSecretPath(p: string): boolean {
  if (!p) return false
  const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  if (!base) return false
  return SECRET_BASENAME_RE.test(base)
}

/**
 * Маскирует значения секретов в тексте (KEY=VALUE → KEY=***), чтобы модель
 * получала структуру .env, но не сами секреты. Применяется к результатам
 * read_file по секретным путям.
 */
export function maskSecretValues(text: string): string {
  return text
    .split('\n')
    .map(line => {
      const m = line.match(/^(\s*(?:export\s+)?["']?[\w.-]*(?:secret|token|password|passwd|api[_-]?key|apikey|private|auth|credential|key)["']?\s*[=:]\s*)(.+)$/)
      if (m && m[2].length > 0) return `${m[1]}***`
      return line
    })
    .join('\n')
}

// ─── Анти-экфильтрация через web-туры ───────────────────────────────────────

/**
 * Похоже ли значение (URL / поисковый запрос) на попытку слить данные:
 * секретные ключи в query-параметрах или аномально длинная query-string.
 */
export function looksLikeExfiltration(value: string): boolean {
  if (!value) return false
  if (/[?&](?:token|key|secret|password|passwd|api_key|apikey|auth|session)=/i.test(value)) return true
  const q = value.match(/\?([^#\s]*)/)?.[1] ?? ''
  if (q.length > 150) return true
  // Поисковый запрос-простыня (base64/длинный blob) — тоже подозрителен
  if (value.length > 300 && /[a-z0-9+/=]{200,}/i.test(value)) return true
  return false
}

/**
 * Каскадное разрешение эффективных настроек авто-режима:
 *   DEFAULT_AUTO_MODE_SETTINGS → глобальные agentPermissions.autoMode
 *   → (legacy confirmDangerous → askOnDangerous) → projectOverride.auto.
 */
export function resolveAutoModeSettings(
  globalPerms?: { confirmDangerous?: boolean; autoMode?: Partial<AutoModeSettings> },
  projOverride?: ProjectPermissionOverride,
): AutoModeSettings {
  const g = globalPerms?.autoMode ?? {}
  const out: AutoModeSettings = { ...DEFAULT_AUTO_MODE_SETTINGS, ...g }
  // Legacy-миграция: старые хранилища имеют confirmDangerous, но не autoMode.
  if (g.askOnDangerous === undefined && globalPerms?.confirmDangerous !== undefined) {
    out.askOnDangerous = !!globalPerms.confirmDangerous
  }
  // Legacy-миграция askNetwork → networkPolicy (true→smart, false→off).
  // Явный networkPolicy всегда побеждает.
  if (g.networkPolicy === undefined && g.askNetwork !== undefined) {
    out.networkPolicy = g.askNetwork ? 'smart' : 'off'
  }
  delete out.askNetwork
  if (projOverride?.auto) {
    Object.assign(out, projOverride.auto)
    if (projOverride.auto.networkPolicy === undefined && projOverride.auto.askNetwork !== undefined) {
      out.networkPolicy = projOverride.auto.askNetwork ? 'smart' : 'off'
    }
  }
  return out
}

/** Мерж запрещённых путей: глобальные + проектный override. */
export function mergeForbiddenPaths(
  globalPaths?: string[],
  projOverride?: ProjectPermissionOverride,
): string[] | undefined {
  const proj = projOverride?.forbiddenPaths
  if (!globalPaths?.length && !proj?.length) return undefined
  return [...(globalPaths ?? []), ...(proj ?? [])]
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
  // ── PowerShell обфусцированный payload — base64 скрывает любое содержимое ──
  {
    test: cmd => /\b(?:powershell|pwsh)(?:\.exe)?\b.*\s-(?:e|ec|enc|encodedcommand)\s/.test(cmd),
    reason: 'PowerShell -EncodedCommand — обфусцированный payload, содержимое скрыто',
  },
  // Скрытое окно + отключённый профиль — классическая комбинация вредоносов
  {
    test: cmd => /\b(?:powershell|pwsh)(?:\.exe)?\s+.*-(?:w|windowstyle)\s+(?:hidden|h)\b/.test(cmd)
      && /-(?:nop|noprofile|noninteractive)\b/.test(cmd),
    reason: 'PowerShell со скрытым окном и без профиля — типичное поведение вредоносного скрипта',
  },
  // ── LOLBins: загрузка/выполнение через системные утилиты ──
  {
    test: cmd => /\bcertutil\s+.*-(?:urlcache|verifyctl)\b/.test(cmd),
    reason: 'certutil -urlcache — загрузка файла через системную утилиту (LOLBin)',
  },
  {
    test: cmd => hasWord(cmd, 'mshta'),
    reason: 'mshta — выполнение HTA-скрипта (LOLBin, частый вектор RCE)',
  },
  {
    test: cmd => /\bbitsadmin\s+.*\/transfer\b/.test(cmd),
    reason: 'bitsadmin /transfer — скрытая загрузка файла (LOLBin)',
  },
  {
    test: cmd => /\bmsiexec\s+.*\/i\s+https?:\/\//.test(cmd),
    reason: 'msiexec /i с URL — установка пакета из интернета',
  },
  {
    test: cmd => /(?:downloadstring|downloadfile|downloaddata)\s*\(/.test(cmd),
    reason: 'Net.WebClient загрузка кода/файла — типичный вектор доставки вредоносов',
  },
  // ── Ransomware-паттерны: уничтожение теневых копий и бэкапов ──
  {
    test: cmd => /\bvssadmin\s+delete\s+shadows\b/.test(cmd) || /\bwbadmin\s+delete\b/.test(cmd),
    reason: 'Удаление теневых копий/бэкапов — классический шаг ransomware',
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
    // Флаги git между «git» и подкомандой учитываются: `git -C <path> push --force` тоже dangerous
    test: cmd => /\bgit\s+(?:-[a-z-]+\s+(?:"[^"]*"|'[^']*'|[^\s"]+)\s+)*(?:push|p)\b[^|;&]*(?:-f\b|--force)/i.test(cmd),
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

  // ── Инфраструктура / учётные записи ──
  {
    test: cmd => /\bnet\s+(?:user|localgroup)\s+.*\/add\b/.test(cmd),
    reason: 'Создание учётной записи / добавление в группу (net user /add)',
  },
  {
    test: cmd => /\bwmic\s+process\s+call\s+create\b/.test(cmd),
    reason: 'Запуск процесса через WMI (wmic process call create)',
  },

  // ── Персистентность: автозагрузка через профиль шелла / crontab ──
  {
    test: cmd => (has(cmd, '$profile', '${profile}', '.bashrc', '.zshrc', '.profile')
      && has(cmd, '>>', 'add-content', 'set-content', 'out-file', 'echo', 'tee ')),
    reason: 'Запись в профиль шелла — закрепление (persistence)',
  },
  {
    test: cmd => hasWord(cmd, 'crontab') && !has(cmd, ' -l') && !has(cmd, '--list'),
    reason: 'Изменение crontab — закрепление (persistence)',
  },

  // ── Скрытый запуск процессов ──
  {
    test: cmd => /start-process\s+.*-windowstyle\s+(?:hidden|h)\b/.test(cmd),
    reason: 'Start-Process со скрытым окном — скрытое выполнение',
  },
  {
    test: cmd => /\b(?:powershell|pwsh)(?:\.exe)?\s+.*-(?:w|windowstyle)\s+(?:hidden|h)\b/.test(cmd),
    reason: 'PowerShell со скрытым окном',
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
  // Git push (без force) — тот же regex, что isGitPushCommand (учитывает `git -C <path> push`)
  {
    test: cmd => GIT_PUSH_RE.test(cmd) && !has(cmd, '--force') && !has(cmd, ' -f'),
    reason: 'Git push в удалённый репозиторий',
  },
]

// ─── Классификация файловых тулов ───────────────────────────────────────────

/**
 * Классифицирует опасность файлового тула (write_file/edit_file).
 *
 * Правила:
 *   - Путь в forbiddenPaths → BLOCKED (нельзя трогать системные папки)
 *   - Секретный путь (.env, *.pem, id_rsa...) → DANGEROUS
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

  // 2. Секретные файлы — изменение требует подтверждения всегда
  if ((toolName === 'write_file' || toolName === 'edit_file') && isSecretPath(path)) {
    return {
      level: 'dangerous',
      reason: `Изменение файла с секретами: "${path}" (.env/ключи/креды)`,
      matchedPattern: 'secret_write',
    }
  }

  // 3. write_file — теперь всегда safe: создаёт только новый файл, перезапись
  //    существующего блокируется в fileEdit.ts (вернёт ошибку модели).
  if (toolName === 'write_file') {
    if (!path) {
      return { level: 'warn', reason: 'write_file без path — нельзя проверить путь', matchedPattern: 'write_no_path' }
    }
    return { level: 'safe', reason: 'Создание нового файла (перезапись запрещена)', matchedPattern: 'write_create' }
  }

  // 4. edit_file — точечные правки, безопасны (есть diff)
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

  // Чтение секретных файлов — warn (в авто-режиме спрашиваем всегда,
  // значения маскируются перед отдачей модели).
  if (toolName === 'read_file' && isSecretPath(String(args.path ?? ''))) {
    return {
      level: 'warn',
      reason: `Чтение файла с секретами: "${String(args.path)}" (значения будут скрыты)`,
      matchedPattern: 'secret_read',
    }
  }

  // Web-туры: read-only, но URL/запрос могут быть каналом эксфильтрации —
  // секреты в query-параметрах или аномально длинная query-string.
  if (toolName === 'fetch_page' || toolName === 'search_web' || toolName === 'search_images') {
    const target = String(args.url ?? args.query ?? '')
    if (looksLikeExfiltration(target)) {
      return {
        level: 'warn',
        reason: 'Запрос выглядит как передача данных (секреты или большой payload в URL/запросе)',
        matchedPattern: 'exfiltration',
      }
    }
    return { level: 'safe', reason: 'Web read-only tool — no side effects', matchedPattern: 'web_read' }
  }

  // Прочие тулы (read_file, и т.д.) — безопасны по умолчанию.
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
 * auto:    умный режим — решение по гранулярным настройкам AutoModeSettings:
 *          askOnDangerous / askOnWarn / askGitPush / networkPolicy /
 *          askOutsideWorkdir. Чтение секретных файлов спрашивает всегда.
 * ask:     спрашивать каждый тул
 * full:    полный доступ — всё пропускается без проверок
 *
 * Опции:
 *   auto             — эффективные настройки авто-режима (resolveAutoModeSettings)
 *   confirmDangerous — legacy (agentPermissions.confirmDangerous), применяется
 *                      только если auto.askOnDangerous не задан явно
 *   forbiddenPaths   — глобальные + проектные запрещённые пути (mergeForbiddenPaths)
 *   workdir          — рабочая директория чата (для askOutsideWorkdir)
 *
 * Возвращает level классификации — вызывающий код использует его, чтобы
 * не применять allowlist к dangerous-действиям.
 */
export function needsApproval(
  toolName: string,
  args: Record<string, unknown>,
  mode: 'auto' | 'ask' | 'full',
  opts?: {
    auto?: Partial<AutoModeSettings>
    confirmDangerous?: boolean
    forbiddenPaths?: string[]
    workdir?: string
  },
): { confirm: boolean; block: boolean; reason: string; level: DangerLevel } {
  // full — полный доступ, ничего не проверяем
  if (mode === 'full') {
    return { confirm: false, block: false, reason: '', level: 'safe' }
  }

  // Единая классификация (покрывает и run_command, и файловые тулы)
  const result = classifyTool(toolName, args, { forbiddenPaths: opts?.forbiddenPaths, workdir: opts?.workdir })

  // blocked — блокировать везде, диалога нет
  if (result.level === 'blocked') {
    return { confirm: false, block: true, reason: result.reason, level: 'blocked' }
  }

  // ask — спрашивать каждый тул кроме скрытых (вызывающий код фильтрует hidden)
  if (mode === 'ask') {
    return { confirm: true, block: false, reason: result.reason || 'Режим "спрашивать" — подтверждение на каждый тул', level: result.level }
  }

  // ── auto — гранулярные настройки ──
  const auto: AutoModeSettings = { ...DEFAULT_AUTO_MODE_SETTINGS, ...(opts?.auto ?? {}) }
  // Legacy: confirmDangerous=false и нет явного auto.askOnDangerous → не спрашивать dangerous
  if (opts?.auto?.askOnDangerous === undefined && opts?.confirmDangerous === false) {
    auto.askOnDangerous = false
  }
  // Legacy: askNetwork без явного networkPolicy
  if (opts?.auto?.networkPolicy === undefined && opts?.auto?.askNetwork !== undefined) {
    auto.networkPolicy = opts.auto.askNetwork ? 'smart' : 'off'
  }

  const reasons: string[] = []
  const cmd = toolName === 'run_command' ? String(args.command ?? '') : ''
  const gitPush = cmd ? isGitPushCommand(cmd) : false
  const network = cmd ? isNetworkCommand(cmd) : false

  if (result.level === 'dangerous' && auto.askOnDangerous) {
    reasons.push(result.reason)
  }
  if (gitPush && auto.askGitPush) {
    reasons.push('Git push в удалённый репозиторий')
  }
  if (network && shouldAskNetwork(cmd, auto.networkPolicy)) {
    reasons.push('Сетевая команда (произвольный URL / удалённый доступ)')
  }
  // warn-уровень: git push уже покрыт отдельной настройкой — не дублируем
  if (result.level === 'warn' && auto.askOnWarn && !gitPush) {
    reasons.push(result.reason)
  }
  // Чтение секретных файлов — спрашиваем ВСЕГДА в авто-режиме (не отключается):
  // утечка .env/ключей в LLM-запрос необратима.
  if (toolName === 'read_file' && isSecretPath(String(args.path ?? ''))) {
    reasons.push(`Чтение файла с секретами: "${String(args.path ?? '')}"`)
  }
  if (auto.askOutsideWorkdir && isToolOutsideWorkdir(toolName, args, opts?.workdir)) {
    reasons.push('Действие вне папки проекта (workdir)')
  }

  if (reasons.length > 0) {
    return { confirm: true, block: false, reason: reasons.join('; '), level: result.level }
  }
  return { confirm: false, block: false, reason: '', level: result.level }
}
