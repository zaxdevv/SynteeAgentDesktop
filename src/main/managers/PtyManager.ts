/**
 * PTY-менеджер — настоящие интерактивные shell-сессии поверх node-pty.
 * Заменяет marker-based ShellSessionManager: те же возможности (cd/env
 * переживают между вызовами, AI-exec с маркером и exit code), но плюс
 * полноценный PTY — TUI-программы (vim, top, fzf), цвета, интерактивный
 * ввод, стриминг вывода в UI.
 *
 * Сессии per-chat (Map<sessionId, PtySession> + индекс по chatId).
 * AI run_command идёт через execInSession — пишет команду в PTY, ждёт
 * уникальный маркер с exit code; параллельно байты стримятся в xterm
 * (юзер видит команду и вывод живьём).
 *
 * Живёт в main-процессе (переживает перезапуск Worker'а на chat:send,
 * как и предыдущий ShellSessionManager).
 */
import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { stripAnsi } from '../../core/tools/_shared'
import { PtyOutputBatcher } from './ptyOutputBatcher'

export type ShellType = 'powershell' | 'cmd' | 'bash' | 'wsl' | 'nushell' | 'fish'

export interface ShellInfo {
  type: ShellType
  label: string
  /** Полный путь к исполняемому файлу или имя (если в PATH). */
  file: string
  args: string[]
  available: boolean
}

export interface SessionMeta {
  id: string
  chatId: string
  shell: ShellType
  title: string
  source: 'user' | 'agent'
  createdAt: number
  /** Помечена на удаление (процесс умер). */
  dead: boolean
}

interface PendingExec {
  markerId: string
  /** Скомпилированный регекс — создаётся один раз, не на каждый чанк. */
  markerRe: RegExp
  buf: string
  resolve: (r: { output: string; exitCode: number; timedOut?: boolean; interrupted?: boolean }) => void
  timer: NodeJS.Timeout
  /** Буфер для фильтрации маркеров из display-потока (pty:data → xterm). */
  displayBuf: string
  /** Первая строка команды (нормализованная) — для среза эха PTY из AI-вывода. */
  cmdFirstLine: string
  /** Эхо уже срезано — не пытаться повторно (флаг). */
  echoStripped: boolean
}

interface PtySession {
  id: string
  chatId: string
  shell: ShellType
  title: string
  source: 'user' | 'agent'
  createdAt: number
  proc: pty.IPty
  dead: boolean
  pending: PendingExec | null
  /** Буфер вывода до первого mount xterm — чтобы не потерять приглашение. */
  preMountBuf: string
  /** true после attach renderer'а: preMountBuf больше не копится (стрим идёт
   *  напрямую). Сбрасывается в false на detach/смене окна — чтобы при
   *  повторном mount не потерять вывод за время без терминала. */
  preMountConsumed: boolean
  /** Батчер display-потока (pty:data) + безопасный backpressure. */
  out: PtyOutputBatcher
  /** Прерывание в процессе (interruptByChat): ждём возврата промпта или kill. */
  interrupting: boolean
  interruptTimer: NodeJS.Timeout | undefined
  /** Последняя известная cwd сессии — чтобы не делать лишний cd перед командой. */
  lastCwd: string | undefined
  /** Таймер отложенного cleanup dead-сессии из Map (30с после onExit). */
  cleanupTimer: NodeJS.Timeout | undefined
}

// 200 колонок по умолчанию — больше не wrap-ит длинные команды и вывод при
// AI-exec (когда юзер не открыл терминал-панель, PTY остаётся на дефолтной
// ширине). При mount xterm вызывает fitTerminal → resize под реальную ширину.
const DEFAULT_COLS = 200
const DEFAULT_ROWS = 24
/** Кап pre-mount буфера — при превышении дропаем хвост с маркером обрезки.
 *  Без этого команда с мегабайтами вывода + открытие панели = синхронный
 *  term.write(весь_буфер) → фриз рендерера на секунды. */
const PRE_MOUNT_BUF_CAP = 256 * 1024

let cachedShells: ShellInfo[] | null = null

/** Автодетект доступных shells на текущей системе (кешируется). */
export function detectShells(): ShellInfo[] {
  if (cachedShells) return cachedShells
  const isWin = process.platform === 'win32'
  const list: ShellInfo[] = []

  if (isWin) {
    // PowerShell — Windows PowerShell 5.1 (powershell.exe) или PowerShell 7+ (pwsh.exe).
    // Предпочитаем pwsh если установлен, иначе powershell.
    const pwsh = which('pwsh.exe') ?? which('powershell.exe')
    if (pwsh) {
      list.push({ type: 'powershell', label: 'PowerShell', file: pwsh, args: ['-NoLogo'], available: true })
    }

    // CMD
    const cmd = which('cmd.exe')
    if (cmd) {
      list.push({ type: 'cmd', label: 'Command Prompt', file: cmd, args: [], available: true })
    }

    // Git Bash — ищем в Program Files / Program Files (x86)
    const progFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const progFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const gitBashCandidates = [
      join(progFiles, 'Git', 'bin', 'bash.exe'),
      join(progFilesX86, 'Git', 'bin', 'bash.exe'),
    ]
    const gitBash = gitBashCandidates.find(p => existsSync(p))
    if (gitBash) {
      list.push({ type: 'bash', label: 'Git Bash', file: gitBash, args: ['-i', '-l'], available: true })
    }

    // WSL
    const wsl = which('wsl.exe')
    if (wsl) {
      list.push({ type: 'wsl', label: 'WSL (Ubuntu)', file: wsl, args: [], available: true })
    }

    // Nushell
    const nu = which('nu.exe')
    if (nu) {
      list.push({ type: 'nushell', label: 'Nushell', file: nu, args: ['-l'], available: true })
    }

    // Fish
    const fish = which('fish.exe')
    if (fish) {
      list.push({ type: 'fish', label: 'Fish', file: fish, args: ['-l'], available: true })
    }
  } else {
    // Unix
    const bash = which('bash') ?? '/bin/bash'
    list.push({ type: 'bash', label: 'Bash', file: bash, args: ['-l'], available: existsSync(bash) })
    const zsh = which('zsh')
    if (zsh) list.push({ type: 'bash', label: 'Zsh', file: zsh, args: ['-l'], available: true })
  }

  cachedShells = list
  return list
}

/** Имитация `which` — ищет executable в PATH, возвращает полный путь или undefined. */
function which(name: string): string | undefined {
  try {
    const isWin = process.platform === 'win32'
    const cmd = isWin ? `where ${name}` : `which ${name}`
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    // `where` может вернуть несколько строк — берём первую
    return out.split(/\r?\n/)[0] || undefined
  } catch {
    return undefined
  }
}

class PtyManager {
  private sessions = new Map<string, PtySession>()
  private byChat = new Map<string, Set<string>>()
  private sender: BrowserWindow | null = null

  setSender(w: BrowserWindow | null): void {
    if (this.sender === w) return
    this.sender = w
    // Новый webContents (dev-reload / пересоздание окна): renderer потерял все
    // xterm-инстансы. Снова копим preMount-буфер и снимаем backpressure, иначе
    // PTY останется на паузе, а вывод за время без окна пропадёт.
    for (const s of this.sessions.values()) {
      s.preMountConsumed = false
      s.out.releaseFlow()
    }
  }

  /** Безопасная отправка в renderer: окно могло закрыться/уничтожиться. */
  private sendEvent(channel: string, ...args: unknown[]): void {
    const w = this.sender
    if (!w || w.isDestroyed()) return
    try {
      w.webContents.send(channel, ...args)
    } catch {
      /* webContents уже уничтожен */
    }
  }

  /** Создаёт новую PTY-сессию. */
  create(chatId: string, shell: ShellType, cwd?: string, source: 'user' | 'agent' = 'user', title?: string): string {
    const shells = detectShells()
    const info = shells.find(s => s.type === shell) ?? shells[0]
    if (!info) throw new Error(`No shell available for type ${shell}`)

    const id = randomUUID()
    // Базовый env: UTF-8 для Python (PYTHONIOENCODING + PYTHONUTF8) и для
    // unix-шеллов (LANG/LC_ALL) — устраняет кракозябры в Git Bash/WSL при
    // выводе кириллицы нативными exe (git, tsc, aapt2) и python-скриптами.
    const isUnixLikeShell = info.type === 'bash' || info.type === 'wsl' || info.type === 'nushell' || info.type === 'fish'
    const env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      // #4,#12: убираем git pager (less), который виснет в non-interactive PTY
      GIT_PAGER: 'cat',
      ...(isUnixLikeShell ? { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } : {}),
    } as Record<string, string>
    const effectiveCwd = cwd || homedir()

    const proc = pty.spawn(info.file, info.args, {
      name: 'xterm-color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: effectiveCwd,
      env,
    })

    // Принудительная установка UTF-8 в коде страницы шелла на старте сессии.
    // Без этого на русской локали Windows PS 5.1 держит cp866 в консоли, а
    // cmd — cp866: нативные exe (aapt2/git/tsc) пишут логи в OEM-кодировке,
    // и AI видит `attr/??` вместо реального имени атрибута.
    //
    // Дополнительно для PowerShell определяем helper-функцию __SDE — она
    // инкапсулирует длинную логику извлечения exit code ($LASTEXITCODE с
    // fallback на $?) и вывода маркера. Без неё суффикс каждой AI-команды
    // был бы ~160 символов: эхо PTY wrap-ит его на 80 колонках → в выводе
    // появляется месиво из обрезанных строк и PS prompt-продолжения ($>).
    // С функцией суффикс = `__SDE 12345678` (15 символов, влезает в 1 строку).
    // Clear-Host в конце — затирает эхо строки инициализации (функция + UTF-8)
    // чтобы юзер видел чистый промпт, а не 3 строки технического мусора.
    //
    //   PS 5.1: $OutputEncoding относится только к pipe-вводу в нативные exe,
    //   поэтому ставим [Console]::OutputEncoding И InputEncoding.
    //   pwsh 7+: UTF-8 по умолчанию, строки безвредны (idempotent).
    //   cmd: `chcp 65001` переключает code page для последующих команд.
    //   nushell/fish — UTF-8 по умолчанию, ничего не делаем.
    // Пишем ВНУТРЬ PTY (\r = Enter); не в pending-exec — это одноразовая
    // инициализация, она не должна матчить маркер (pending всё равно null).
    const utf8Init = info.type === 'powershell'
      ? `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[Console]::InputEncoding=[System.Text.Encoding]::UTF8;function __SDE([string]$i){$e=if($LASTEXITCODE-ne$null){[int]$LASTEXITCODE}else{[int](-not$?)};Write-Output "__SYNTEE_DONE_\${i}__:$e"};Clear-Host\r`
      : info.type === 'cmd'
        ? 'chcp 65001 >nul\r'
        : ''
    if (utf8Init) proc.write(utf8Init)

    // Батчер display-потока: коалесит чанки (меньше IPC при массовом выводе) и
    // включает безопасный backpressure. pause() вызывается ТОЛЬКО когда
    // renderer подтверждает потребление (ACK) — иначе AI-exec с закрытой
    // панелью терминала мог бы заблокироваться навсегда.
    const out = new PtyOutputBatcher({
      send: (data) => this.sendEvent('pty:data', id, data),
      pause: () => { try { proc.pause() } catch { /* pty dying */ } },
      resume: () => { try { proc.resume() } catch { /* pty dying */ } },
    })

    const session: PtySession = {
      id,
      chatId,
      shell: info.type,
      title: title ?? info.label,
      source,
      createdAt: Date.now(),
      proc,
      dead: false,
      pending: null,
      preMountBuf: '',
      preMountConsumed: false,
      out,
      interrupting: false,
      interruptTimer: undefined,
      lastCwd: effectiveCwd,
      cleanupTimer: undefined,
    }

    proc.onData(data => {
      // 1. Копим pre-mount буфер (до первого xterm attach) — с капом чтобы
      //    избежать unbounded growth и фриза при flushPreMount. Полный
      //    вывод уже стримится в renderer через pty:data — preMountBuf
      //    нужен только для первого attach xterm. После attach (renderer
      //    подтвердил получение snapshot'а) больше не копим.
      if (!session.dead && !session.preMountConsumed) {
        if (session.preMountBuf.length < PRE_MOUNT_BUF_CAP) {
          session.preMountBuf += data
          if (session.preMountBuf.length > PRE_MOUNT_BUF_CAP) {
            session.preMountBuf =
              session.preMountBuf.slice(0, PRE_MOUNT_BUF_CAP) +
              '\r\n\x1b[2m[…pre-mount buffer truncated]\x1b[0m'
          }
        }
      }
      // 2. Стримим в renderer через батчер: коалесинг мелких чанков в один
      //    IPC за окно + безопасный backpressure (pause только при активных
      //    ACK). НО фильтруем маркеры если есть pending exec.
      //    Маркеры __SDE <hex> (echo суффикса) и __SYNTEE_DONE_<hex>__:N
      //    (вывод функции) не должны попадать в xterm-дисплей.
      if (session.pending) {
        const filtered = this.filterDisplayData(session, data)
        if (filtered) session.out.push(filtered)
        // 3. Копим для pending exec (AI) — сырые данные, без фильтрации
        this.feedExec(session, data)
      } else {
        // Если interrupting — новые data означают что шелл вернулся после Ctrl+C
        if (session.interrupting) {
          clearTimeout(session.interruptTimer)
          session.interrupting = false
          session.interruptTimer = undefined
        }
        session.out.push(data)
      }
    })

    proc.onExit(({ exitCode }) => {
      session.dead = true
      // Сначала досылаем накопленный вывод, только потом exit-маркер — иначе
      // он обгонит ещё не отправленные чанки (в renderer маркер ставится в ту
      // же FIFO-очередь и окажется выше финального вывода).
      try { session.out.flush() } catch { /* ignore */ }
      // Resolve pending ACK flow before disposing; the renderer still needs the
      // final queued data and exit marker, and late ACKs become harmless no-ops.
      session.out.releaseFlow()
      this.sendEvent('pty:exit', id, exitCode)
      this.sendEvent('pty:session-list-changed', chatId)
      session.out.dispose()
      // Резолвим pending если был (процесс упал)
      if (session.pending) {
        const p = session.pending
        clearTimeout(p.timer)
        session.pending = null
        p.resolve({ output: p.buf, exitCode: exitCode ?? 1, timedOut: false })
      }
      // Отложенный cleanup: через 30с убираем dead-сессию из Map.
      // Даёт UI время показать финальный вывод, но не утекает бесконечно.
      session.cleanupTimer = setTimeout(() => {
        this.sessions.delete(id)
        const set = this.byChat.get(chatId)
        set?.delete(id)
        if (set && set.size === 0) this.byChat.delete(chatId)
      }, 30_000)
    })

    this.sessions.set(id, session)
    let set = this.byChat.get(chatId)
    if (!set) { set = new Set(); this.byChat.set(chatId, set) }
    set.add(id)
    this.sendEvent('pty:session-list-changed', chatId)
    return id
  }

  /**
   * Фильтрует маркеры __SDE <hex> и __SYNTEE_DONE_<hex>__:N из display-потока
   * (pty:data → xterm). Маркеры накапливаются в pending.displayBuf, вырезаются
   * regex'ом, очищенный текст отправляется в xterm. Хвост буфера (до 64 bytes)
   * задерживается если маркер может быть разрезан между чанками.
   */
  private filterDisplayData(session: PtySession, data: string): string {
    const p = session.pending
    if (!p) return data
    p.displayBuf += data
    // Кап displayBuf — не должен расти безгранично (аналог preMountBuf).
    if (p.displayBuf.length > 256 * 1024) {
      p.displayBuf = p.displayBuf.slice(-128 * 1024)
    }
    // Regex для вырезания маркеров. __SDE <8hex> — echo суффикса (PowerShell),
    // __SYNTEE_DONE_<8hex>__:<digits> — вывод функции/echo (все шеллы).
    // Учитываем возможные \r\n вокруг маркера.
    let cleaned = p.displayBuf
      .replace(/__SDE [a-f0-9]{8}[\r\n]*/g, '')
      .replace(/__SYNTEE_DONE_[a-f0-9]{8}__:\d+[\r\n]*/g, '')
    // Проверяем: может хвост cleaned содержит начало незавершённого маркера?
    // Если да — задерживаем этот кусок до следующего чанка.
    const tailLen = Math.min(64, cleaned.length)
    const tail = cleaned.slice(-tailLen)
    // Ищем потенциальное начало маркера в хвосте
    const partialMatch = tail.search(/__S(?:DE |YNTEE_DONE_)[a-f0-9]{0,8}$/)
    if (partialMatch >= 0) {
      // Задерживаем от partialMatch до конца
      const holdStart = cleaned.length - tailLen + partialMatch
      const hold = cleaned.slice(holdStart)
      p.displayBuf = hold
      cleaned = cleaned.slice(0, holdStart)
    } else {
      p.displayBuf = ''
    }
    return cleaned
  }

  private feedExec(session: PtySession, data: string): void {
    const p = session.pending
    if (!p) return
    p.buf += data

    // ── Срез эха команды из AI-вывода ──────────────────────────────
    // PTY эхоит введённую команду в поток данных. Для xterm (display) это
    // нужно — юзер видит что выполняется. Но AI не должен видеть свою
    // команду в начале вывода. Срезаем эхо один раз, по первой строке.
    if (!p.echoStripped && p.cmdFirstLine && p.buf.length >= p.cmdFirstLine.length) {
      // \r → \n (не удалять!) — иначе строки эха склеиваются.
      // PTY echo использует bare \r как терминатор строки.
      const norm = stripAnsi(p.buf).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      const searchZone = norm.slice(0, Math.min(500, norm.length))
      const echoIdx = searchZone.indexOf(p.cmdFirstLine)
      if (echoIdx >= 0) {
        const afterEcho = norm.slice(echoIdx + p.cmdFirstLine.length)
        const nlIdx = afterEcho.indexOf('\n')
        if (nlIdx >= 0) {
          // Эхо найдено И \n пришёл — срезаем
          p.buf = norm.slice(echoIdx + p.cmdFirstLine.length + nlIdx + 1)
          p.echoStripped = true
        }
        // Если nlIdx < 0 — \n ещё не пришёл, попробуем на следующем чанке
      } else if (p.buf.length > 2000) {
        // Эхо не найдено в первых 500 символах и буфер большой — сдаёмся
        p.echoStripped = true
      }
    }

    // Ищем маркер только в хвосте буфера — новый data + backfill на случай
    // если маркер разрезан между чанками. Маркер ~30 chars, backfill 128.
    // Раньше было p.buf.match(new RegExp(...)) на КАЖДОМ чанке по ВЕСЬ буфер
    // → O(n²) для команды с N чанков вывода → блокировка main process.
    const backfill = Math.min(128, p.buf.length - data.length)
    const searchStart = Math.max(0, p.buf.length - data.length - backfill)
    const m = p.markerRe.exec(p.buf.slice(searchStart))
    if (!m || m.index === undefined) return
    const actualIndex = searchStart + m.index
    const exitCode = Number(m[1])
    // Обрезаем вывод до маркера (маркер не должен попасть в результат AI)
    const output = p.buf.slice(0, actualIndex)
    // Маркеры уже отфильтрованы из display-потока (filterDisplayData),
    // старый cleanup через \r\x1b[A\x1b[J больше не нужен — он ломал вывод
    // при разной ширине терминала и wrap-е строк.
    // Резолв через wrapper — он же чистит timer/pending (см. execInSession).
    p.resolve({ output, exitCode, timedOut: false })
  }

  /** Экранирует путь для cd-команды в зависимости от шелла. */
  private buildCdCommand(shell: ShellType, cwd: string): string | null {
    const escaped = cwd.replace(/'/g, "'\\''")
    switch (shell) {
      case 'powershell':
        return `Set-Location -LiteralPath '${escaped}'`
      case 'cmd':
        return `cd /d "${cwd.replace(/"/g, '""')}"`
      default: // bash, wsl, fish, nushell
        return `cd '${escaped}'`
    }
  }

  /** AI-exec: пишет команду в PTY, ждёт маркер с exit code. */
  async execInSession(
    sessionId: string,
    command: string,
    timeoutSec: number,
    cwd?: string,
  ): Promise<{ output: string; exitCode: number; timedOut?: boolean; interrupted?: boolean }> {
    const session = this.sessions.get(sessionId)
    if (!session) return { output: '', exitCode: 1 }
    if (session.dead) return { output: '[shell process exited]', exitCode: 1 }

    // Shell busy recovery: вместо немедленного return '[shell busy]' пытаемся
    // освободить шелл. Это происходит когда предыдущая команда зависла или
    // interruptByChat не успел очистить pending.
    if (session.pending) {
      // Shell busy recovery: немедленный Ctrl+C + 1с (вместо 500мс+2с=2.5с)
      try { session.proc.write('\x03') } catch { /* dead */ }
      await new Promise<void>(r => setTimeout(r, 1000))
      if (session.dead) return { output: '[shell process exited]', exitCode: 1 }
      if (session.pending) {
        const partial = session.pending.buf ?? ''
        try { session.proc.kill() } catch { /* already dead */ }
        session.dead = true
        session.pending = null
        return { output: partial || '[shell recovered — previous command killed]', exitCode: 1 }
      }
    }

    // Сбрасываем interrupting-флаг если он остался от предыдущего interrupt
    if (session.interrupting) {
      clearTimeout(session.interruptTimer)
      session.interrupting = false
      session.interruptTimer = undefined
    }

    // 8 hex chars = 32 bits = ~4 млрд комбинаций. Маркер живёт ~1 секунду
    // (время выполнения команды до прихода echo), коллизия невозможна.
    // Раньше был 32-char UUID — суффикс получался ~160 символов, wrap-ился
    // на 80 колонках и ломал PS prompt-продолжением ($>).
    const markerHex = randomUUID().replace(/-/g, '').slice(0, 8)
    const markerId = `__SYNTEE_DONE_${markerHex}__`
    // Маркер завершения команды + exit code. Синтаксис зависит от шелла:
    //   powershell: вызов helper-функции __SDE (определена в create()).
    //     Инкапсулирует $LASTEXITCODE с fallback на $? для cmdlets.
    //     Суффикс = 15 символов вместо ~160 — не wrap-ится, не ломает вывод.
    //     Если функцию удалили (Remove-Item Function:__SDE) — суффикс
    //     вызовет несуществующую функцию → нет маркера → timeout → новая
    //     сессия с пересозданной функцией (self-healing).
    //   cmd: %errorlevel% — аналог $LASTEXITCODE для cmd.exe.
    //   bash/wsl: $? — стандартный exit code последней команды.
    //   fish: $status (fish НЕ понимает $? — это bashism).
    //   nushell: $env.LAST_EXIT_CODE (nushell не имеет $?, использует env).
    const suffix = (() => {
      switch (session.shell) {
        case 'powershell':
          return `__SDE ${markerHex}`
        case 'cmd':
          return `echo ${markerId}:%errorlevel%`
        case 'fish':
          return `echo "${markerId}:$status"`
        case 'nushell':
          return `echo $"${markerId}:($env.LAST_EXIT_CODE)"`
        default: // bash, wsl
          return `echo "${markerId}:$?"`
      }
    })()

    return new Promise(resolve => {
      let settled = false
      let killTimer: NodeJS.Timeout | undefined

      // Единый выход — гарантирует что resolve позвется ровно один раз
      // (dbl-resolve возможен: feedExec по маркеру + timeout-fallback),
      // и чистит ВСЕ таймеры + session.pending.
      const settle = (r: { output: string; exitCode: number; timedOut?: boolean; interrupted?: boolean }) => {
        if (settled) return
        settled = true
        if (killTimer) { clearTimeout(killTimer); killTimer = undefined }
        if (session.pending) {
          clearTimeout(session.pending.timer)
          session.pending = null
        }
        resolve(r)
      }

      const timer = setTimeout(() => {
        if (settled) return
        // Ctrl+C в PTY — прерывает текущую команду (npm install / build /
        // node / git и т.п.). Shell вернётся к промпту, env/cwd/история
        // сессии сохранятся — следующий run_command продолжится в той же
        // сессии, без "shell busy".
        try { session.proc.write('\x03') } catch { /* dead */ }
        // Даём shell 2с на возврат промпта. Если за это время в поток успел
        // вывалиться маркер (часто так — echo уже стояло в очереди PTY
        // после C-c) — feedExec его сматчит и вызовет settle() с обычным
        // exitCode; fallback не сработает. Если за 2с промпт не вернулся
        // (висим в интерактивной проге типа vim/top, где Ctrl+C не помог) —
        // kill PTY и помечаем dead; chat.ipc.ts на следующем
        // run_command увидит `!s.dead` и создаст новую сессию.
        killTimer = setTimeout(() => {
          if (settled) return
          // Сохраняем partial output — то, что команда успела напечатать
          // до таймаута (раньше это терялось — AI видел пустую строку).
          const partial = session.pending?.buf ?? ''
          // НЕ kill — сессия остаётся живой. Shell-busy recovery на следующей
          // команде сделает kill если Ctrl+C не поможет.
          settle({ output: partial, exitCode: 1, timedOut: true })
        }, 2000)
      }, Math.max(1, timeoutSec) * 1000)

      // Phase 1: cwd — синхронизация рабочей директории
      let fullCommand = command
      if (cwd && cwd !== session.lastCwd) {
        const cdCmd = this.buildCdCommand(session.shell, cwd)
        if (cdCmd) fullCommand = `${cdCmd}\r${command}`
      }
      const cmdFirstLine = command.split(/\r?\n/)[0].trim()
      session.pending = {
        markerId, markerRe: new RegExp(`${markerId}:(\\d+)`), buf: '',
        resolve: settle, timer, displayBuf: '',
        cmdFirstLine, echoStripped: false,
      }
      try {
        session.proc.write(fullCommand + '\r')
        session.proc.write(suffix + '\r')
        if (cwd) session.lastCwd = cwd
      } catch {
        settle({ output: '[shell process exited]', exitCode: 1 })
      }
    })
  }

  write(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId)
    // Блокируем ввод пока AI-команда выполняется (session.pending !== null).
    // Иначе юзер может напечатать в agent-сессию и испортить вывод/маркер →
    // execInSession не сматчит маркер → timeout → пустой/битый output.
    if (s && !s.dead && !s.pending) s.proc.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId)
    if (s && !s.dead) {
      try { s.proc.resize(Math.max(1, cols), Math.max(1, rows)) } catch { /* proc might be dying */ }
    }
  }

  kill(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    // Резолвим pending Promise ДО очистки — иначе worker виснет навсегда на
    // await onShellExec (proc.onExit не сработает т.к. s.pending уже null).
    if (s.pending) {
      clearTimeout(s.pending.timer)
      const p = s.pending
      s.pending = null
      p.resolve({ output: p.buf, exitCode: 1, timedOut: false })
    }
    // Чистим interrupting-таймер если был
    if (s.interruptTimer) {
      clearTimeout(s.interruptTimer)
      s.interruptTimer = undefined
    }
    s.interrupting = false
    if (s.cleanupTimer) { clearTimeout(s.cleanupTimer); s.cleanupTimer = undefined }
    // Гасим батчер: снимаем backpressure (resume PTY) и очищаем таймеры —
    // иначе осиротевший таймер мог бы дёрнуть pause/resume мёртвой сессии.
    s.out.dispose()
    try { s.proc.kill() } catch { /* already dead */ }
    this.sessions.delete(sessionId)
    const set = this.byChat.get(s.chatId)
    set?.delete(sessionId)
    if (set && set.size === 0) this.byChat.delete(s.chatId)
    this.sendEvent('pty:session-list-changed', s.chatId)
  }

  killByChat(chatId: string): void {
    const set = this.byChat.get(chatId)
    if (!set) return
    for (const id of Array.from(set)) this.kill(id)
  }

  /** Прерывает все pending exec для чата (используется при chat:stop).
   *  Worker уже терминирован — Promise resolve бесполезен, но нужно:
   *  1) Send Ctrl+C чтобы прервать текущую команду (shell вернётся к промпту).
   *  2) Очистить session.pending — иначе следующий execInSession получит
   *     '[shell busy]' и зависнет (chat.ipc.ts не создаст новую сессию
   *     т.к. !s.dead, но pending занят).
   *  3) Установить interrupting-флаг: если за 3с шелл не вернётся (команда
   *     игнорит Ctrl+C) — kill PTY, помечаем dead. Следующий run_command
   *     создаст новую сессию (self-healing). */
  interruptByChat(chatId: string): void {
    const set = this.byChat.get(chatId)
    if (!set) return
    for (const id of set) {
      const s = this.sessions.get(id)
      if (!s || !s.pending) continue
      try { s.proc.write('\x03') } catch { /* dead */ }
      clearTimeout(s.pending.timer)
      // Резолвим Promise иначе worker виснет на await onShellExec.
      // Раньше relied solely on worker.terminate() — но если interrupt
      // вызван без terminate (future-proof), Promise завис бы навсегда.
      const partial = s.pending.buf ?? ''
      const resolve = s.pending.resolve
      s.pending = null
      resolve({ output: partial, exitCode: 1, timedOut: false, interrupted: true })
      // Устанавливаем interrupting-флаг с 3с kill-fallback.
      // Если за 3с в onData придут новые данные — interrupting снимется
      // (шелл вернулся к промпту). Если нет — kill.
      if (!s.dead) {
        s.interrupting = true
        s.interruptTimer = setTimeout(() => {
          if (s.interrupting && !s.dead) {
            try { s.proc.kill() } catch { /* already dead */ }
            s.dead = true
            s.interrupting = false
            s.interruptTimer = undefined
            try { s.out.flush() } catch { /* ignore */ }
            s.out.releaseFlow()
            this.sendEvent('pty:exit', id, 1)
            this.sendEvent('pty:session-list-changed', s.chatId)
            s.out.dispose()
          }
        }, 3000)
      }
    }
  }

  listByChat(chatId: string): SessionMeta[] {
    const set = this.byChat.get(chatId)
    if (!set) return []
    const out: SessionMeta[] = []
    for (const id of set) {
      const s = this.sessions.get(id)
      if (!s) continue
      out.push({
        id: s.id, chatId: s.chatId, shell: s.shell, title: s.title,
        source: s.source, createdAt: s.createdAt, dead: s.dead,
      })
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Достать pre-mount буфер (для xterm при первом attach) и сбросить его. */
  consumePreMount(sessionId: string): string {
    const s = this.sessions.get(sessionId)
    if (!s) return ''
    const buf = s.preMountBuf
    s.preMountBuf = ''
    return buf
  }

  /**
   * Renderer смонтировал xterm для сессии. Сначала досылаем накопленный батч
   * (чтобы он пришёл ДО snapshot-события), затем помечаем preMountBuf
   * израсходованным, забираем его как snapshot и отправляем событием
   * pty:premount. Renderer по этому событию перестаёт «держать» входящие
   * чанки и пишет snapshot первым — порядок гарантирован, потому что оба
   * сообщения идут через webContents.send одного канала.
   */
  attach(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) {
      // Сессия уже убита/очищена — всё равно отвечаем premount'ом (пустой
      // snapshot), чтобы renderer снял hold и не копил входящие чанки.
      this.sendEvent('pty:premount', sessionId, '')
      return
    }
    try { s.out.flush() } catch { /* ignore */ }
    // Everything before the snapshot is replayed once by the renderer.
    // Flow-control becomes active only after the renderer's real xterm.write
    // callback sends the first ACK; never synthesize consumption here.
    s.out.releaseFlow()
    s.preMountConsumed = true
    const snapshot = s.preMountBuf
    s.preMountBuf = ''
    this.sendEvent('pty:premount', sessionId, snapshot)
  }

  /**
   * Renderer уничтожил xterm-инстанс (закрытие сессии/окна). Снимаем
   * backpressure и снова начинаем копить preMountBuf — чтобы при повторном
   * монтировании отдать вывод, накопленный за время без терминала.
   */
  detach(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.out.releaseFlow()
    if (!s.dead) s.preMountConsumed = false
  }

  /** Renderer подтвердил потребление N байт display-потока (term.write cb). */
  ack(sessionId: string, bytes: number): void {
    this.sessions.get(sessionId)?.out.ack(bytes)
  }

  getMeta(sessionId: string): SessionMeta | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    return {
      id: s.id, chatId: s.chatId, shell: s.shell, title: s.title,
      source: s.source, createdAt: s.createdAt, dead: s.dead,
    }
  }

  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) this.kill(id)
  }
}

export const ptyManager = new PtyManager()
