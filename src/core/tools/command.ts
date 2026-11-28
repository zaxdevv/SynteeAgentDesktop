import { homedir } from 'os'
import { execAsync, smartTrimOutput, type ToolResult } from './_shared'

/**
 * Claude Code approach: persistent cwd через pwd marker.
 *
 * Каждая команда выполняется в fresh subprocess (child_process.exec),
 * но после команды мы добавляем уникальный маркер `__SYNTEE_CWD__:<path>`,
 * который выводит текущую рабочую директорию. Маркер парсится из вывода,
 * путь сохраняется и передаётся как cwd в следующий runCommand — так cd
 * переживает между вызовами без PTY-сессии.
 *
 * Преимущества над PTY-путём:
 * - Нет ConPTY багов (reprint, clear screen, resize crash, write truncation)
 * - && работает нативно (через cmd.exe или bash)
 * - Ctrl+C / timeout через child_process работает надёжно
 * - Нет echo stripping проблем (pipes не эхоят ввод)
 * - Маркеры не нужны для exit code — он приходит напрямую
 * - Параллельность: несколько runCommand через Promise.all
 * - Стабильно на любой версии Windows
 */

/** Маркер для извлечения cwd из вывода команды. */
const CWD_MARKER = '__SYNTEE_CWD__'

/** Строит суффикс-команду для маркера cwd в зависимости от шелла. */
function buildCwdMarkerSuffix(shell: string | undefined, isWin: boolean): string {
  if (isWin && shell === 'cmd') {
    // CALL expands the escaped variables after the user command runs.
    return ` & call set __syntee_status=%^errorlevel%& for %I in (.) do @echo ${CWD_MARKER}:%~fI& call exit /b %^__syntee_status%`
  } else if (isWin) {
    return `; $__syntee_ok = $?; $__syntee_status = $LASTEXITCODE; Write-Output "${CWD_MARKER}:$($PWD.Path)"; if (!$__syntee_ok) { if ($__syntee_status) { exit $__syntee_status }; exit 1 }; exit 0`
  } else {
    // bash/zsh — pwd -P возвращает физический путь (без symlink'ов)
    return `\n__syntee_status=$?; echo "${CWD_MARKER}:$(pwd -P)"; exit "$__syntee_status"`
  }
}

/**
 * Извлекает cwd-маркер из stdout, удаляет его из вывода.
 * Возвращает { stdout, cwd } — очищенный stdout и путь (или undefined).
 */
function extractCwdMarker(stdout: string): { stdout: string; cwd?: string } {
  const re = new RegExp(`${CWD_MARKER}:(.+?)[\\r\\n]*$`, 'm')
  const m = stdout.match(re)
  if (!m) return { stdout }
  const cwd = m[1].trim()
  const cleaned = stdout.replace(new RegExp(re.source, re.flags + 'g'), '').replace(/\n{3}/g, '\n\n').trim()
  return { stdout: cleaned, cwd }
}

export async function runCommand(cmd: string, cwd?: string, shell?: string, timeout?: number): Promise<ToolResult> {
  let effectiveTimeout = timeout ?? 60
  try {
    const isWin = process.platform === 'win32'

    // ── Pre-processing команды ──
    let processedCmd = cmd

    // #5: PowerShell 5.1 не поддерживает && — заменяем на ; (с note)
    let ampersandNote = ''
    if (isWin && (shell !== 'cmd') && processedCmd.includes('&&')) {
      processedCmd = processedCmd.replace(/&&/g, '; ')
      ampersandNote = '[note: && replaced with ; for PowerShell 5.1 compatibility]\n'
    }

    // #4,#12: git --no-pager + GIT_PAGER=cat — убираем pager (less), который
    // виснет в non-interactive PTY, ожидая нажатия q.
    if (/^\s*git\s+/.test(processedCmd)) {
      processedCmd = processedCmd.replace(/^(\s*)git\s+/, '$1git --no-pager ')
    }

    // #6: tsc/eslint — --pretty false убирает ANSI escape-последовательности,
    // которые забивают PTY-буфер и замедляют вывод. Для tsc увеличиваем timeout.
    const isTsc = /\btsc\b/.test(processedCmd) && !/--pretty\s+false/.test(processedCmd) && !/--pretty\s+true/.test(processedCmd)
    if (isTsc) {
      processedCmd = processedCmd.replace(/\btsc\b/, 'tsc --pretty false')
    }

    // ── Claude Code approach: append cwd marker ──
    // После команды добавляем echo-маркер с текущей директорией.
    // Маркер парсится из stdout после выполнения — cwd переживает между вызовами.
    processedCmd += buildCwdMarkerSuffix(shell, isWin)

    if (isTsc && timeout === undefined) effectiveTimeout = 120
    const timeoutMs = effectiveTimeout * 1000
    const maxBuffer = 10 * 1024 * 1024  // 10MB — иначе Node падает с ERR_CHILD_PROCESS_STDOUT_MAXBUFFER до smartTrimOutput

    let execCmd: string
    let execOpts: Parameters<typeof execAsync>[1]

    if (isWin) {
      // Windows: PowerShell по умолчанию — понимает ls/cat/rm/mkdir/grep и т.д.
      // cmd только если явно указан shell: 'cmd'
      if (shell === 'cmd') {
        // chcp 65001 переключает code page консоли на UTF-8 ДО запуска
        // пользовательской команды. Без этого нативные exe (aapt2, git,
        // tsc) пишут логи в OEM-кодировке (cp866 на русской локали) —
        // Node декодирует stdout как utf8 и получает `attr/??` вместо
        // реальных кириллических имён. `>nul` глушит вывод "65001" из
        // chcp, чтобы он не засорял результат команды.
        execCmd = `chcp 65001 >nul && ${processedCmd}`
        execOpts = {
          cwd: cwd || homedir(),
          timeout: timeoutMs,
          shell: 'cmd.exe',
          encoding: 'utf8',
          maxBuffer,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', GIT_PAGER: 'cat' },
        }
      } else {
        // PowerShell: используем -EncodedCommand (base64 UTF-16LE) вместо
        // встраивания команды в двойные кавычки. Это полностью устраняет
        // проблему экранирования (", $(), backtick и т.д.) — команда передаётся
        // как данные, а не как часть shell-строки.
        // OutputEncoding — как PS декодирует stdout нативных exe в строки.
        // InputEncoding — как PS кодирует строки при записи в консоль и
        // pipe; без него кириллица в аргументах/pipe ломается в PS 5.1.
        // pwsh 7+ UTF-8 по умолчанию — обе строки безвредны (idempotent).
        const psScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::InputEncoding=[System.Text.Encoding]::UTF8; ${processedCmd}`
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
        execCmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
        execOpts = {
          cwd: cwd || homedir(),
          timeout: timeoutMs,
          encoding: 'utf8',
          maxBuffer,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', GIT_PAGER: 'cat' },
        }
      }
    } else {
      // C.UTF-8 is available on Linux even when no locales have been generated.
      const utf8Locale = process.platform === 'linux' ? 'C.UTF-8' : 'en_US.UTF-8'
      execCmd = processedCmd
      execOpts = {
        cwd: cwd || homedir(),
        timeout: timeoutMs,
        shell: '/bin/bash',
        encoding: 'utf8',
        maxBuffer,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          LANG: utf8Locale,
          LC_ALL: utf8Locale,
          GIT_PAGER: 'cat',
        },
      }
    }

    const { stdout, stderr } = await execAsync(execCmd, execOpts)

    // ── Извлекаем cwd-маркер из stdout ──
    const { stdout: stdoutNoMarker, cwd: detectedCwd } = extractCwdMarker((stdout as string) || '')

    // #4: Фильтр git LF/CRLF warnings — забивают вывод и вызывают таймауты
    const gitWarnRe = /^warning:.*LF will be replaced by CRLF.*$/gm
    const stdoutClean = stdoutNoMarker.replace(gitWarnRe, '').replace(/\n{3}/g, '\n\n').trim() || ''
    const stderrClean = ((stderr as string) || '').replace(gitWarnRe, '').replace(/\n{3}/g, '\n\n').trim() || ''
    let out = smartTrimOutput(stdoutClean) || '(no output)'
    if (stderrClean) out += `\n[stderr]:\n${smartTrimOutput(stderrClean)}`
    return {
      success: true,
      output: `${ampersandNote}[exit: 0]\n${out}`,
      ...(detectedCwd ? { cwd: detectedCwd } : {}),
    }
  } catch (e: any) {
    const stderrPart = smartTrimOutput(e.stderr?.trim() || '')

    // Пытаемся извлечь cwd-маркер даже из ошибочного вывода — cd мог успеть
    // сработать до того, как команда упала.
    const { stdout, cwd: detectedCwd } = extractCwdMarker(e.stdout?.trim() || '')
    const stdoutPart = smartTrimOutput(stdout)

    // Node child_process marks a process killed by timeout: e.killed=true,
    // e.signal='SIGTERM' (sometimes null, but killed=true). execAsync throws
    // with e.code = null/string (not a number) in this case. Without an
    // explicit check, the timeout was masked as "Command failed" exit:1 —
    // the AI did not understand the command timed out and retried the same
    // call in a loop.
    const timedOut = e.killed === true || e.signal === 'SIGTERM'
    if (timedOut) {
      let out = `[timeout: ${effectiveTimeout}s — process killed]`
      if (stdoutPart) out += `\n[stdout before kill]:\n${stdoutPart}`
      if (stderrPart) out += `\n[stderr before kill]:\n${stderrPart}`
      return {
        success: false,
        output: out,
        error: `Command exceeded the timeout (${effectiveTimeout}s). Pass a larger timeout (e.g. 120 or 300), run the command in the background, or break it into shorter steps.`,
        ...(detectedCwd ? { cwd: detectedCwd } : {}),
      }
    }
    // maxBuffer exceeded — Node кидает ERR_CHILD_PROCESS_STDOUT_MAXBUFFER
    // с e.code = 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER'. Без явной проверки
    // это маскировалось как "Command failed" exit:1.
    if (e.code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER') {
      let out = `[output exceeded 10MB limit — truncated]\n[stdout (partial)]:\n${stdoutPart}`
      if (stderrPart) out += `\n[stderr]:\n${stderrPart}`
      return {
        success: false,
        output: out,
        error: 'Command output exceeded the 10MB maxBuffer limit. Pipe to a file or break into smaller steps.',
        ...(detectedCwd ? { cwd: detectedCwd } : {}),
      }
    }
    const exitCode = typeof e.code === 'number' ? e.code : 1
    let out = `[exit: ${exitCode}]`
    if (stdoutPart) out += `\n[stdout]:\n${stdoutPart}`
    if (stderrPart) out += `\n[stderr]:\n${stderrPart}`
    return {
      success: false,
      output: out,
      error: stderrPart || e.message?.replace(/Command failed:.+\n?/, '').trim() || 'Command failed',
      ...(detectedCwd ? { cwd: detectedCwd } : {}),
    }
  }
}
