/**
 * pluginHost — рантайм ВНУТРИ utilityProcess плагина.
 *
 * Этот файл бандлится отдельной точкой входа (out/main/plugin-host.js,
 * см. electron.vite.config.ts) и форкается через utilityProcess.fork()
 * из pluginProcess.ts. Он НЕ импортируется main-бандлом.
 *
 * Обязанности:
 *   - принять 'init' от main, загрузить entry плагина (require, CJS)
 *   - собрать PluginHostApi (registerTool / storage / clipboard / net / ...)
 *     и вызвать activate(syntee) экспортируемый плагином
 *   - маршрутизировать RPC: callTool → handler плагина, hostRequest → main
 *   - graceful shutdown: вызвать deactivate() плагина и ответить
 *
 * Плагин получает доступ к Node API своего процесса (это изоляция процесса,
 * а не песочница) — права из манифеста гейтят host-мосты (net.fetch,
 * clipboard, notifications) и показываются пользователю при включении.
 */

// Локальный тип parentPort (Electron utilityProcess) — без импорта electron,
// чтобы файл остался чистым Node-модулём и не тянул main-зависимости.
interface ParentPortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): void
  postMessage(message: unknown): void
  start(): void
}

const port = (process as unknown as { parentPort: ParentPortLike }).parentPort

import type {
  PluginMsgHostToPlugin,
  PluginMsgPluginToHost,
  PluginMsgHostRequest,
} from './pluginProtocol'

// ── Python sidecar (runtime:'python') ──────────────────────────────────────
//
// Для Python-плагинов utilityProcess становится чистым мостом:
//   MessagePort (main) ⇄ stdin/stdout child-процесса `python {main}`.
// Сообщения протокола ходят 1:1 (JSON Lines). Локальные Maps (tools,
// commands, …) не используются — Python-SDK регистрирует всё сам в main.

interface ChildProcessLike {
  stdin: { write(s: string): void } | null
  stdout: { on(ev: 'data', fn: (d: Buffer) => void): void } | null
  stderr: { on(ev: 'data', fn: (d: Buffer) => void): void } | null
  on(ev: 'close' | 'exit' | 'error', fn: (arg: unknown) => void): void
  kill(): void
}
let pyChild: ChildProcessLike | null = null
/** initResult ещё не ушёл — краш python-процесса = ошибка активации. */
let pyInitDone = false
/** Хвост stderr для диагностики краша (трейсбек и т.п.). */
let pyStderrTail = ''

function forwardToPython(msg: PluginMsgHostToPlugin): void {
  if (!pyChild?.stdin) return
  try {
    pyChild.stdin.write(JSON.stringify(msg) + '\n')
  } catch {
    // Процесс умер — сообщение теряется, exit-хендлер разберётся.
  }
}

/** Спавнит python-процесс и подключает мост. Бросает при ошибке spawn. */
function startPythonBridge(
  entryAbs: string,
  python: { exe: string; sdkDir: string },
  pluginDirLocal: string,
  initRequestId: string,
): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('child_process') as typeof import('child_process')
  const child = cp.spawn(python.exe, [entryAbs], {
    cwd: pluginDirLocal,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      // Критично для JSON Lines: без буферизации сообщения застревают в pipe.
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONPATH: python.sdkDir,
    },
  })
  pyChild = child as ChildProcessLike
  pyStderrTail = ''

  // stdout → main: JSON Lines, каждая строка — сообщение протокола.
  let buf = ''
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf-8')
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as PluginMsgPluginToHost
        if (msg.type === 'initResult' && msg.ok) pyInitDone = true
        send(msg)
      } catch {
        send({ type: 'log', level: 'error', message: `[python] не-JSON в stdout: ${line.slice(0, 300)}` })
      }
    }
  })

  // stderr → журнал плагина (трейсбеки, предупреждения библиотек).
  child.stderr?.on('data', (d: Buffer) => {
    const text = d.toString('utf-8')
    pyStderrTail = (pyStderrTail + text).slice(-4000)
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim()
      if (l) send({ type: 'log', level: 'warn', message: `[python] ${l}` })
    }
  })

  child.on('error', (err: unknown) => {
    const message = (err as NodeJS.ErrnoException).message ?? String(err)
    if (pyInitDone) {
      send({ type: 'log', level: 'error', message: `[python] ошибка процесса: ${message}` })
      setTimeout(() => process.exit(1), 100)
    } else {
      send({ type: 'initResult', requestId: initRequestId, ok: false, error: `Не удалось запустить Python (${python.exe}): ${message}` })
      setTimeout(() => process.exit(1), 100)
    }
  })

  child.on('close', (code: number | null) => {
    if (pyInitDone) {
      // Живой плагин умер (краш или shutdown). При graceful shutdown
      // (код 0) просто выходим; при краше — код 1, чтобы main пометил
      // плагин ошибкой.
      send({ type: 'log', level: code === 0 ? 'info' : 'error', message: `[python] процесс завершён (code ${code ?? '?'})` })
      setTimeout(() => process.exit(code === 0 ? 0 : 1), 100)
    } else {
      // Умер до initResult — это ошибка активации (синтаксис, import и т.п.).
      const tail = pyStderrTail.trim().split(/\r?\n/).slice(-12).join('\n')
      send({
        type: 'initResult',
        requestId: initRequestId,
        ok: false,
        error: tail || `Python-процесс завершился до активации (code ${code ?? '?'})`,
      })
      setTimeout(() => process.exit(1), 100)
    }
  })
}

// ── Состояние хоста ────────────────────────────────────────────────────────

interface RegisteredTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => unknown
}

interface RegisteredCommand {
  name: string
  description: string
  icon?: string
  handler: (args: string) => unknown
}

type EventHandler = (payload: Record<string, unknown>) => void | Record<string, unknown> | undefined | Promise<Record<string, unknown> | void | undefined>
type UiMessageHandler = (data: unknown) => void
type UiRpcHandler = (args: Record<string, unknown>) => unknown

type ContextProviderHandler = (ctx: { chatId: string }) => string | Promise<string>
type SearchProviderHandler = (q: { query: string } | { click: Record<string, unknown> }) => unknown | Promise<unknown>
type AutocompleteHandler = (q: { query: string }) => unknown | Promise<unknown>
type ContextMenuHandler = (payload: { messageId?: string; chatId?: string; content?: string; selection?: string }) => void | Promise<void>
type WebhookHandler = (req: { method: string; path: string; body: string }) => void

const tools = new Map<string, RegisteredTool>()
const commands = new Map<string, RegisteredCommand>()
const eventHandlers = new Map<string, Set<EventHandler>>()
const uiMessageHandlers = new Set<UiMessageHandler>()
const uiRpcHandlers = new Map<string, UiRpcHandler>()
/** scheduler: jobId → handler (тик приходит событием 'scheduler:tick' {id}). */
const schedulerHandlers = new Map<string, () => void | Promise<void>>()
/** shortcut: accelerator → handler (событие 'shortcut' {accelerator}). */
const shortcutHandlers = new Map<string, () => void>()
/** fs.watch: watchId → handler (событие 'fs:change' {id, event, file}). */
const fsWatchHandlers = new Map<string, (p: { event: string; file: string }) => void>()
/** context providers: name → handler (вызов через callHandler kind 'context'). */
const contextProviders = new Map<string, ContextProviderHandler>()
/** search providers: id → handler (callHandler kind 'search'). */
const searchProviders = new Map<string, SearchProviderHandler>()
/** autocomplete: trigger → handler (callHandler kind 'autocomplete'). */
const autocompleteHandlers = new Map<string, AutocompleteHandler>()
/** context menu: itemId → handler (callHandler kind 'menu'). */
const contextMenuHandlers = new Map<string, ContextMenuHandler>()
/** webhook: port → handler (событие 'webhook:request' {port, method, path, body}). */
const webhookHandlers = new Map<number, WebhookHandler>()
/** ai:delta: requestId → onDelta (событие 'ai:delta' {requestId, delta}). */
const aiDeltaWaiters = new Map<string, (delta: string) => void>()
/** ai.chat opts.tools: name → handler (вызов через callHandler kind 'aiTool'). */
const aiToolHandlers = new Map<string, (args: Record<string, unknown>) => unknown>()
let deactivateFn: (() => void | Promise<void>) | null = null
let active = false
let permissions: Set<string> = new Set()
let pluginDir = ''
let hostVersion = ''
let idCounter = 0

const nextId = (prefix: string): string => `${prefix}-${++idCounter}-${Date.now().toString(36)}`

const send = (msg: PluginMsgPluginToHost): void => {
  try { port.postMessage(msg) } catch { /* процесс умирает — ок */ }
}

// ── RPC в main (hostRequest → hostResponse) ────────────────────────────────

const hostWaiters = new Map<string, (resp: { ok: boolean; result?: unknown; error?: string }) => void>()

function hostRequest(method: PluginMsgHostRequest['method'], params: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const requestId = `hr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    hostWaiters.set(requestId, resolve)
    send({ type: 'hostRequest', requestId, method, params })
    // Страховка: если main не ответил за 30с — резолвим ошибкой, чтобы
    // промис плагина не висел вечно.
    setTimeout(() => {
      const w = hostWaiters.get(requestId)
      if (w) {
        hostWaiters.delete(requestId)
        w({ ok: false, error: `hostRequest timeout: ${method}` })
      }
    }, 30_000)
  })
}

/** Fire-and-forget hostRequest для синхронных API (registerShortcut,
 *  scheduler, statusbar, tray, ui.openModal…): ошибка НЕ бросается в код
 *  плагина, но логируется в его журнал (level 'error') — иначе занятый
 *  accelerator/порт/лимит молча терялись и разработчик не понимал,
 *  почему ничего не работает. */
function fireAndForget(method: PluginMsgHostRequest['method'], params: Record<string, unknown>, what: string): void {
  const requestId = nextId('ff')
  hostWaiters.set(requestId, resp => {
    if (!resp.ok) {
      send({ type: 'log', level: 'error', message: `${what}: ${resp.error || 'ошибка'}` })
    }
  })
  send({ type: 'hostRequest', requestId, method, params })
}

// ── PluginHostApi — то, что получает плагин в activate(syntee) ─────────────

export interface SynteePluginApi {
  /** Абсолютный путь до папки плагина (свои ресурсы). */
  pluginDir: string
  /** Права, выданные плагину (из манифеста, подтверждённые пользователем). */
  permissions: string[]
  /** Версия хоста (приложения) — для совместимости API. */
  version: string
  /** Зарегистрировать тул для AI. Имя — короткое (без plugin__ префикса).
   *  requiresApproval: true — мутабельный тул: каждый вызов требует
   *  подтверждения пользователя (approval-диалог агента), независимо
   *  от режима подтверждений. */
  registerTool(def: {
    name: string
    description: string
    parameters?: Record<string, unknown>
    handler: (args: Record<string, unknown>) => unknown
    requiresApproval?: boolean
  }): void
  /** Зарегистрировать слэш-команду: /name args → handler(args).
   *  Имя без слэша, [a-zA-Z][a-zA-Z0-9_]*. */
  registerCommand(def: {
    name: string
    description: string
    icon?: string
    handler: (args: string) => unknown
  }): void
  /** Зарегистрировать UI-вклад: кнопку или панель в слоте приложения.
   *  slot 'sidebar' — низ сайдбара. type 'button' — клик выполняет command
   *  (имя команды плагина); 'panel' — открывает iframe-панель с ui-файлом
   *  из манифеста (требует permission 'ui'). */
  registerUi(def: {
    slot: 'sidebar'
    type: 'button' | 'panel'
    label: string
    icon?: string
    command?: string
  }): void
  /** Зарегистрировать панель плагина в слоте приложения (permission 'ui').
   *  slot 'right' — таб в правой панели (с бейджами, keep-alive);
   *  slot 'modal' — модальная iframe-панель; slot 'sidebar' — как registerUi.
   *  id — уникальный id панели (для openPanel/setBadge), entry — HTML-файл
   *  относительно папки плагина (по умолчанию manifest.ui). */
  registerPanel(def: {
    id: string
    slot?: 'right' | 'modal' | 'sidebar'
    title: string
    icon?: string
    entry?: string
  }): void
  /** Снять регистрацию в рантайме. Тул/команда исчезают из списка,
   *  панель закрывается у пользователя. */
  unregisterTool(name: string): void
  unregisterCommand(name: string): void
  unregisterPanel(panelId: string): void
  /** Зарегистрировать context provider (permission 'context') —
   *  динамический markdown, попадающий в system prompt перед каждым
   *  запросом агента. handler получает { chatId }. */
  registerContextProvider(def: {
    name: string
    description?: string
    handler: ContextProviderHandler
  }): void
  /** Зарегистрировать рендерер markdown-кодоблоков (permission 'ui'):
   *  кодоблок ```language рендерится iframe с entry, код — в data. */
  registerMarkdownRenderer(def: { language: string; entry: string; height?: number }): void
  /** Зарегистрировать кастомный тег сообщений (permission 'ui'):
   *  парный тег <tag attr="...">…</tag> в тексте сообщения рендерится
   *  iframe-виджетом плагина (entry + data { attrs, inner }).
   *  Имя тега: [a-zA-Z][a-zA-Z0-9-]*. Тег попадает в system prompt —
   *  AI знает, что может вставлять его в ответы. */
  registerMessageTag(def: { tag: string; entry: string; height?: number; description?: string }): void
  /** Снять регистрацию тега сообщений (имя тега). */
  unregisterMessageTag(tag: string): void
  /** Зарегистрировать статическую секцию system prompt (permission
   *  'context'): markdown-блок «### title» в промпте на время работы
   *  плагина. Для динамического контекста (на каждый запрос) —
   *  registerContextProvider. */
  registerPromptSection(def: { id?: string; title: string; content: string }): void
  /** Снять секцию промпта (id из registerPromptSection). */
  unregisterPromptSection(id: string): void
  /** Зарегистрировать секцию настроек в SettingsPage (permission 'ui'):
   *  своя вкладка с iframe (entry) — для богатой конфигурации,
   *  которая не влезает в декларативную форму config манифеста. */
  registerSettingsSection(def: { id: string; title: string; entry: string; icon?: string }): void
  unregisterSettingsSection(id: string): void
  /** Зарегистрировать search provider (permission 'ui') — результаты
   *  в глобальном поиске (Spotlight). handler: { query } → items[]
   *  или { click: item } при клике по результату. */
  registerSearchProvider(def: {
    id: string
    label: string
    handler: SearchProviderHandler
  }): void
  /** Зарегистрировать autocomplete-провайдер (permission 'ui'):
   *  подсказки в поле ввода после ввода триггер-слова. */
  registerAutocomplete(def: {
    trigger: string
    handler: AutocompleteHandler
  }): void
  /** Зарегистрировать пункт контекстного меню сообщений (permission 'ui').
   *  button: true — рендерится отдельной кнопкой в ряду действий сообщения
   *  (copy/pin/reply), а не в меню «⋯». */
  registerContextMenu(def: {
    id: string
    label: string
    icon?: string
    scope: 'message' | 'selection'
    button?: boolean
    handler: ContextMenuHandler
  }): void
  /** Зарегистрировать кнопку над полем ввода чата (permission 'ui') —
   *  ряд быстрых действий рядом с «+». Клик: command → слэш-команда
   *  плагина, без command — событие 'input-action' { id }. */
  registerInputAction(def: {
    id: string
    label: string
    icon?: string
    tooltip?: string
    command?: string
  }): void
  /** Зарегистрировать тему (permission 'ui') — CSS-переменные,
   *  появляется в ThemePicker. */
  registerTheme(def: { name: string; dark: boolean; colors: Record<string, string> }): void
  /** Зарегистрировать фон (permission 'ui') — появляется в пикере фонов. */
  registerBackground(def: {
    id: string
    name: string
    kind: 'shader' | 'video' | 'image'
    src: string
  }): void
  /** Подписаться на событие хоста:
   *   'chat:message'     — { chatId, content, role, messageId, attachments? },
   *                        fire-and-forget (role='user' при отправке);
   *   'chat:before-send' — { chatId, content }, хук с ответом: вернуть
   *                        undefined/'allow' | { action:'modify', content }
   *                        | { action:'reject', reason? };
   *   'tool:call'        — { toolName, args }, fire-and-forget;
   *   'tool:result'      — { toolName, args, result }, хук с ответом
   *                        (modify → content = новый результат тула);
   *   'prompt:before-build' — { chatId, prompt }, хук с ответом
   *                        (modify → content = новый system prompt);
   *   'theme:changed'    — { theme, accentColor, dark };
   *   'agent:status'     — { chatId, status: 'started'|'finished'|'error', toolName? };
   *   'message:delta'    — { chatId, delta } (троттлинг 250мс);
   *   'chat:completed'   — { chatId };
   *   'chat:switched'    — { chatId } (пользователь переключил активный чат);
   *   'app:focus'        — {} (главное окно получило фокус);
   *   'input-action'     — { id } (клик по кнопке плагина над инпутом без command);
   *   'fs:change'        — { id, event, file } (fs.watch);
   *   'ws:open'/'ws:message'/'ws:close'/'ws:error' — { id, ... } (net.ws);
   *   'scheduler:tick'   — { id } (scheduler);
   *   'shortcut'         — { accelerator } (registerShortcut);
   *   'tray:action'      — { label } (клик по пункту трея без command);
   *   'webhook:request'  — { port, method, path, body } (net.listen);
   *   'bus:<name>'       — { data, from } (шина между плагинами). */
  on(event: 'chat:message' | 'chat:before-send' | 'tool:call' | 'tool:result' | 'prompt:before-build' | 'theme:changed'
    | 'agent:status' | 'message:delta' | 'chat:completed' | 'chat:switched' | 'app:focus' | 'input-action'
    | 'panel:opened' | 'panel:closed'
    | 'fs:change' | 'ws:open' | 'ws:message' | 'ws:close' | 'ws:error'
    | 'scheduler:tick' | 'shortcut' | 'tray:action' | 'webhook:request' | `bus:${string}`,
     handler: (payload: Record<string, unknown>) => void | Record<string, unknown> | undefined | Promise<Record<string, unknown> | void | undefined>): void
  /** Лог в журнал плагина (виден в UI вкладки Плагины). Вызов как функции
   *  = info; уровни: log.info / log.warn / log.error. */
  log: {
    (...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
  /** Per-plugin KV-хранилище (персистится в main, изолировано по pluginId). */
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
  /** Настройки плагина (схема в манифесте config, форма — в UI приложения).
   *  Значения редактирует пользователь в карточке плагина. */
  config: {
    get<T = unknown>(key: string): Promise<T | undefined>
    getAll(): Promise<Record<string, unknown>>
  }
  /** Файлы. readFile/listDir/stat — любые пути (permission 'fs:read');
   *  запись (writeFile/mkdir/delete/rename/copy/writeFiles) внутри папки
   *  плагина — permission 'fs:write', ВНЕ папки — 'fs:write:any';
   *  watch — наблюдение за файлом/папкой, события через колбэк
   *  (permission 'fs:read'); возвращает cancel-функцию. */
  fs: {
    /** encoding: 'base64' → бинарное содержимое (картинки и т.п.) как base64. */
    readFile(path: string, opts?: { encoding?: 'utf-8' | 'base64' }): Promise<string>
    /** encoding: 'base64' → content — base64 бинарных данных. */
    writeFile(path: string, content: string, opts?: { encoding?: 'utf-8' | 'base64' }): Promise<void>
    listDir(path: string): Promise<string[]>
    /** Метаданные пути: { exists, isFile, isDir, size, mtime }. */
    stat(path: string): Promise<{ exists: boolean; isFile: boolean; isDir: boolean; size: number; mtime: number }>
    /** Создать папку (recursive по умолчанию). */
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
    /** Удалить файл или папку (папку — рекурсивно). */
    delete(path: string): Promise<void>
    /** Переместить/переименовать файл или папку. */
    rename(from: string, to: string): Promise<void>
    /** Копировать файл (папку — рекурсивно). */
    copy(from: string, to: string): Promise<void>
    /** Батч-запись для скаффолдинга: { 'src/index.ts': '...', ... }.
     *  baseDir — общий префикс путей (родительские папки создаются сами). */
    writeFiles(files: Record<string, string>, opts?: { baseDir?: string }): Promise<void>
    watch(path: string, handler: (p: { event: string; file: string }) => void, opts?: { recursive?: boolean }): () => void
    /** Нативный диалог выбора файла (permission 'ui'). null — отмена. */
    pickFile(opts?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>
    /** Нативный диалог выбора папки (permission 'ui'). null — отмена. */
    pickDir(opts?: { title?: string }): Promise<string | null>
    /** Нативный диалог выбора НЕСКОЛЬКИХ файлов (permission 'ui'). [] — отмена. */
    pickFiles(opts?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string[]>
    /** Нативный диалог «Сохранить как» (permission 'ui'). null — отмена. */
    saveDialog(opts?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>
  }
  /** Буфер обмена (требует permission 'clipboard'). */
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<void>
  }
  /** Уведомление (требует permission 'notifications'). actions — кнопки:
   *  клик выполняет слэш-команду плагина (command) или открывает его
   *  панель (panel — id из registerPanel). */
  notifications: {
    show(title: string, body: string, opts?: { actions?: Array<{ label: string; command?: string; panel?: string }> }): Promise<void>
  }
  /** HTTP-запрос через main (требует permission 'net'). Возвращает
   *  { status, headers, body } — body это текст (до 1 МБ).
   *  ws — WebSocket через main: connect/send/close, данные приходят
   *  событиями 'ws:open'/'ws:message'/'ws:close'/'ws:error' (поле id).
   *  listen — локальный HTTP-сервер (permission 'webhook'): запросы
   *  приходят хендлером (событие 'webhook:request'). */
  net: {
    /** binary: true → ответ с bodyBase64 (бинарные данные: картинки,
     *  архивы). Иначе body — текст (utf-8, лимит 1 МБ). */
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; binary?: boolean }): Promise<{ status: number; headers: Record<string, string>; body: string; bodyBase64?: string }>
    ws: {
      connect(id: string, url: string): Promise<void>
      send(id: string, data: string): void
      close(id: string): void
    }
    listen(port: number, handler: WebhookHandler): Promise<void>
    close(port: number): Promise<void>
  }
  /** LLM через хост (permission 'ai') — модель/провайдер приложения,
   *  биллинг централизован. prompt — строка или массив сообщений
   *  (vision: { type:'image', path|url|base64 }). stream: true —
   *  дельты в opts.onDelta, промис резолвится полным текстом.
   *  embed — вектор текста (хостовый эмбеддер). */
  ai: {
    chat(prompt: string | Array<{ type: 'text'; text: string } | { type: 'image'; path?: string; url?: string; base64?: string }>, opts?: {
      system?: string
      model?: string
      maxTokens?: number
      stream?: boolean
      onDelta?: (delta: string) => void
      /** Function calling: свои тулы внутри одного вызова — модель может
       *  их вызывать, хост исполняет handler и возвращает результат в цикле. */
      tools?: Array<{
        name: string
        description?: string
        parameters?: Record<string, unknown>
        handler: (args: Record<string, unknown>) => unknown
      }>
      /** Подмешать историю чата (chatId, по умолчанию активный) в контекст. */
      chatContext?: boolean
      /** Для chatContext — какой чат (по умолчанию активный). */
      chatId?: string
    }): Promise<string>
    embed(text: string): Promise<number[]>
    /** Доступные модели приложения: [{ id, providerId, name, contextWindow }]. */
    listModels(): Promise<Array<{ id: string; providerId: string; name: string; contextWindow: number }>>
    /** Сгенерировать изображение через image-провайдер приложения.
     *  Возвращает markdown ![...](url) с временной ссылкой. */
    generateImage(prompt: string, opts?: { model?: string; size?: string; quality?: string; style?: string }): Promise<string>
  }
  /** Открыть ссылку в системном браузере (permission 'net'). */
  shell: {
    openExternal(url: string): Promise<void>
  }
  /** Звуки приложения (permission 'ui'). soundId — id из BUILTIN_SOUNDS
   *  ('synth.send', 'synth.done', 'synth.confirm', ...) или путь к
   *  кастомному звуку в папке плагина. */
  sound: {
    play(soundId: string): Promise<void>
  }
  /** Вызов host-тулов агента (permission 'agent'): read_file,
   *  search_code, list_directory, find_files, search_web — read-only;
   *  write_file / edit_file — запись (дополнительно требует 'fs:write:any'). */
  agent: {
    useTool(tool: string, args: Record<string, unknown>): Promise<unknown>
    /** Запустить полноценный субагента хоста (воркер + тулы + планировщик).
     *  Возвращает { agentId, summary } по завершении. Пишущие тулы —
     *  дополнительно требует 'fs:write:any'. */
    run(task: string, opts?: { model?: string; workdir?: string }): Promise<{ agentId: string; summary: string }>
  }
  /** Доступ к тулам MCP-серверов приложения (permission 'mcp'). */
  mcp: {
    listTools(): Promise<Array<{ server: string; name: string; description?: string }>>
    call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown>
  }
  /** Шифрованное хранилище секретов (permission 'secrets') — API-ключи
   *  и токены плагина, не светятся в plugin.json/storage. */
  secrets: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }
  /** Речь (permission 'speech'): tts — синтез через TTS-провайдер
   *  приложения (возвращает base64 mp3); stt — распознавание WAV-файла
   *  (локальный Whisper; 16kHz mono лучше всего). */
  speech: {
    tts(text: string, opts?: { model?: string; voice?: string }): Promise<string>
    stt(wavPath: string): Promise<string>
  }
  /** Публичные настройки приложения (permission 'settings:read') —
   *  только чтение: тема, стриминг, язык интерфейса и т.п. */
  settings: {
    get(): Promise<Record<string, unknown>>
  }
  /** Регистрация провайдера моделей (permission 'provider'):
   *  OpenAI-compatible endpoint появляется в Настройках → Провайдеры,
   *  его модели можно назначать на роли. Провайдер живёт, пока плагин
   *  запущен; id неймспейсится (plugin-{pluginId}-{id}). */
  provider: {
    register(def: {
      id: string
      name: string
      baseUrl: string
      apiKey?: string
      /** Список моделей (id); иначе подтянутся из /models endpoint. */
      models?: string[]
    }): Promise<void>
    unregister(id: string): Promise<void>
  }
  /** Git-операции по workdir (permission 'git'). */
  git: {
    status(workdir: string): Promise<{ branch: string | null; ahead: number; behind: number; clean: boolean; files: Array<{ path: string; status: string }> }>
    diff(workdir: string, opts?: { staged?: boolean; file?: string }): Promise<string>
    log(workdir: string, limit?: number): Promise<Array<{ hash: string; author: string; date: string; message: string }>>
    commit(workdir: string, message: string, opts?: { add?: boolean; addAll?: boolean }): Promise<string>
    branches(workdir: string): Promise<Array<{ name: string; current: boolean }>>
  }
  /** Запуск shell-команд через main (permission 'process:exec'). */
  process: {
    exec(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }>
  }
  /** Шина событий между плагинами: emit — всем запущенным (включая
   *  отправителя, поле from), on — подписка (события 'bus:<name>'). */
  bus: {
    emit(event: string, data?: unknown): void
    on(event: string, handler: (data: unknown) => void): void
  }
  /** Планировщик (permission 'scheduler'). Возвращает cancel-функцию. */
  scheduler: {
    every(intervalMs: number, handler: () => void | Promise<void>): () => void
    cron(expr: string, handler: () => void | Promise<void>): () => void
    at(delayMs: number, handler: () => void | Promise<void>): () => void
  }
  /** Глобальная горячая клавиша (permission 'shortcuts'), формат Electron:
   *  'Ctrl+Shift+P', 'Alt+1' и т.д. Срабатывание — handler. */
  registerShortcut(accelerator: string, handler: () => void): void
  unregisterShortcut(accelerator: string): void
  /** Overlay-окно приложения (permission 'overlay'): показать HTML
   *  плагина поверх всего (frameless, always-on-top). */
  overlay: {
    show(opts: { entry: string; data?: unknown; width?: number; height?: number; timeoutMs?: number }): Promise<void>
    hide(): Promise<void>
  }
  /** Status bar — полоса внизу главного окна (permission 'ui'). */
  statusbar: {
    set(id: string, text: string, opts?: { tooltip?: string; command?: string }): void
    clear(id: string): void
  }
  /** Пункты в меню трея (permission 'tray'). Клик по пункту с command
   *  выполняет слэш-команду плагина, без command — событие 'tray:action'. */
  tray: {
    setMenu(items: Array<{ label: string; command?: string; type?: 'item' | 'separator' }>): void
    clearMenu(): void
  }
  /** Мост к iframe-панелям плагина. Каналы:
   *   - legacy postMessage: панель → onMessage, postMessage → все панели;
   *   - RPC: панель вызывает synteeBridge.call(method, args) → handle(method);
   *   - push: emit(method, data) → все панели (synteeBridge.on). */
  ui: {
    onMessage(handler: (data: unknown) => void): void
    postMessage(data: unknown): void
    /** RPC-хендлер: вызывается из iframe через synteeBridge.call(method, args). */
    handle(method: string, handler: (args: Record<string, unknown>) => unknown): void
    /** Push в все iframe-панели плагина (synteeBridge.on(method, cb) в панели). */
    emit(method: string, data?: unknown): void
    /** Тема приложения (для стилизации панели). */
    getTheme(): Promise<{ theme: string; accentColor: string; dark: boolean }>
    /** Инлайн-виджет: iframe-карточка в сообщении чата. Тул плагина
     *  возвращает JSON {"__plugin_ui__":true,...} — renderer подставит
     *  entry и data этого виджета. */
    registerWidget(def: { name: string; entry: string; height?: number; description?: string }): void
    /** Открыть модальную iframe-панель (entry по умолчанию — manifest.ui). */
    openModal(def?: { entry?: string; title?: string; width?: number; height?: number }): void
    /** Закрыть модальную панель плагина. */
    closeModal(): void
    /** Бейдж на панели (slot 'right'): число или null — сбросить. */
    setBadge(panelId: string, badge: number | null): void
    /** Chat overlay: плавающий iframe-оверлей ПОВЕРХ области чата в
     *  главном окне (не отдельное окно, как overlay.show). position:
     *  'right' (по умолчанию) | 'left' | 'center'. */
    showChatOverlay(def: { entry?: string; title?: string; width?: number; height?: number; position?: 'left' | 'right' | 'center' }): void
    /** Скрыть chat overlay плагина. */
    hideChatOverlay(): void
    /** Live-карточка прогресса (для долгих операций тула): плавающая
     *  карточка в чате. update меняет текст, finish убирает карточку. */
    beginProgress(def: { label: string }): {
      update(text: string): void
      finish(): void
    }
  }
  /** Действия в чате (permission 'chat'). */
  chat: {
    /** Отправить сообщение от имени пользователя (запускает агент).
     *  opts.silent — только вставить текст в инпут, не отправлять.
     *  opts.attachments — файлы к сообщению (пути), обрабатываются
     *  движком вложений (текст инлайном, картинки → vision). */
    send(text: string, opts?: { silent?: boolean; attachments?: Array<{ path: string; name?: string; kind?: 'file' | 'image' }> }): Promise<void>
    /** Вставить ответ от имени плагина в текущий чат. */
    reply(text: string): Promise<void>
    /** Стриминг ответа плагина: beginReply создаёт пустое
     *  assistant-сообщение и возвращает replyId; appendChunk дописывает
     *  дельту (троттлинг ~120мс, UI обновляется живьём); endReply
     *  финализирует сообщение. Между begin/end НЕ вызывайте reply. */
    beginReply(): Promise<string>
    appendChunk(replyId: string, delta: string): Promise<void>
    endReply(replyId: string): Promise<void>
    /** Активный чат пользователя: { chatId } или { chatId: null },
     *  если чат не открыт (permission 'chats:read'). */
    getActive(): Promise<{ chatId: string | null }>
  }
  /** System prompt агента (permission 'hooks'). get — финальный
   *  собранный промпт для чата (без хука prompt:before-build — иначе
   *  рекурсия; свой вклад плагины и так знают). Только чтение —
   *  менять промпт можно хуком prompt:before-build или секциями. */
  prompt: {
    get(chatId?: string): Promise<string>
  }
  /** Чтение/изменение чатов приложения. list/get — 'chats:read';
   *  create/rename/delete/appendMessage/editMessage/deleteMessage — 'chats:write'. */
  chats: {
    list(): Promise<Array<{ id: string; title: string; createdAt: number; updatedAt: number }>>
    get(chatId: string): Promise<{ chat: Record<string, unknown>; messages: Array<Record<string, unknown>> } | null>
    create(title?: string, projectId?: string): Promise<{ id: string }>
    rename(chatId: string, title: string): Promise<void>
    delete(chatId: string): Promise<void>
    appendMessage(chatId: string, role: 'user' | 'assistant', content: string): Promise<{ id: string }>
    editMessage(messageId: string, content: string): Promise<void>
    deleteMessage(messageId: string): Promise<void>
    /** Открыть чат пользователю (переключить активный чат в UI). */
    open(chatId: string): Promise<void>
    /** Вложения сообщения (файлы/картинки): [{ id, kind, name, path, mime, size }]. */
    getAttachments(messageId: string): Promise<Array<Record<string, unknown>>>
    /** Сообщения чата с пагинацией (permission 'chats:read'): последние
     *  limit (по умолчанию 50, макс 200) либо старее курсора
     *  (beforeCreatedAt, beforeId из последнего элемента страницы).
     *  Возвращает { messages, hasMore }. */
    getMessages(chatId: string, opts?: { limit?: number; beforeCreatedAt?: number; beforeId?: string }): Promise<{ messages: Array<Record<string, unknown>>; hasMore: boolean }>
  }
  /** Проекты приложения. list/current — 'projects:read'; create — 'projects:write'. */
  projects: {
    list(): Promise<Array<{ id: string; name: string; workdir: string }>>
    /** Активный чат и его проект: { chatId, projectId?, projectName?, workdir? }. */
    current(): Promise<{ chatId: string | null; projectId?: string; projectName?: string; workdir?: string }>
    /** Создать проект по workdir (папка должна существовать). */
    create(workdir: string, opts?: { name?: string; projectContext?: string }): Promise<{ id: string; name: string; workdir: string }>
  }
  /** Долговременная память приложения (permission 'memory').
   *  chat — заметки плагина, привязанные к чату (попадают в контекст
   *  при наличии context provider у плагина). */
  memory: {
    search(query: string): Promise<Array<Record<string, unknown>>>
    save(key: string, value: string, category?: string): Promise<void>
    chat: {
      get<T = unknown>(chatId: string, key: string): Promise<T | undefined>
      set(chatId: string, key: string, value: unknown): Promise<void>
      delete(chatId: string, key: string): Promise<void>
    }
  }
  /** Окно приложения: тосты и диалоги (permission 'ui'). */
  window: {
    toast(text: string, kind?: 'info' | 'success' | 'error'): Promise<void>
    /** Нативный диалог. Возвращает индекс нажатой кнопки (0 — default OK). */
    dialog(title: string, body: string, buttons?: string[]): Promise<number>
  }
}

function requirePermission(perm: string, what: string): void {
  // fs:write:any — надмножество fs:write: плагин с правом записи в ЛЮБЫЕ
  // пути может писать и внутри своей папки (баг: fs.mkdir(pluginDir/cache)
  // падал «требует fs:write» при permissions: ["fs:write:any"]).
  const ok =
    permissions.has(perm) ||
    (perm === 'fs:write' && permissions.has('fs:write:any'))
  if (!ok) {
    throw new Error(`Permission denied: ${what} требует "${perm}" — добавьте его в permissions в plugin.json`)
  }
}

/** Запись файлов: внутри папки плагина — permission 'fs:write',
 *  любой путь вне её — 'fs:write:any' (согласуется пользователем отдельно). */
function requireWritePermission(what: string, ...paths: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require('path') as typeof import('path')
  const base = pluginDir ? pathMod.resolve(pluginDir) : ''
  const inside = base !== '' && paths.every(p => {
    const r = pathMod.resolve(String(p ?? ''))
    return r === base || r.startsWith(base + pathMod.sep)
  })
  requirePermission(inside ? 'fs:write' : 'fs:write:any', what)
}

function buildApi(): SynteePluginApi {
  return {
    pluginDir,
    permissions: [...permissions],
    version: hostVersion,
    registerTool(def) {
      if (!def || typeof def.name !== 'string' || !def.name) {
        throw new Error('registerTool: name обязателен')
      }
      if (typeof def.handler !== 'function') {
        throw new Error(`registerTool(${def.name}): handler обязателен`)
      }
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(def.name)) {
        throw new Error(`registerTool: имя "${def.name}" должно быть [a-zA-Z][a-zA-Z0-9_]*`)
      }
      tools.set(def.name, {
        name: def.name,
        description: def.description || `Tool ${def.name}`,
        inputSchema: def.parameters ?? { type: 'object', properties: {} },
        handler: def.handler,
      })
      send({ type: 'registerTool', name: def.name, description: def.description || '', inputSchema: def.parameters ?? { type: 'object', properties: {} }, requiresApproval: def.requiresApproval === true })
    },
    unregisterTool(name: string) {
      if (tools.delete(name)) {
        send({ type: 'unregisterTool', name })
      }
    },
    unregisterCommand(name: string) {
      if (commands.delete(name)) {
        send({ type: 'unregisterCommand', name })
      }
    },
    unregisterPanel(panelId: string) {
      send({ type: 'unregisterPanel', name: panelId })
    },
    registerCommand(def) {
      if (!def || typeof def.name !== 'string' || !def.name) {
        throw new Error('registerCommand: name обязателен')
      }
      if (typeof def.handler !== 'function') {
        throw new Error(`registerCommand(${def.name}): handler обязателен`)
      }
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(def.name)) {
        throw new Error(`registerCommand: имя "${def.name}" должно быть [a-zA-Z][a-zA-Z0-9_]*`)
      }
      commands.set(def.name, {
        name: def.name,
        description: def.description || `Command ${def.name}`,
        icon: def.icon,
        handler: def.handler,
      })
      send({ type: 'registerCommand', name: def.name, description: def.description || '', icon: def.icon })
    },
    registerUi(def) {
      requirePermission('ui', 'registerUi')
      if (!def || typeof def.label !== 'string' || !def.label) {
        throw new Error('registerUi: label обязателен')
      }
      if (def.type === 'button' && !def.command) {
        throw new Error('registerUi: type "button" требует command (имя команды плагина)')
      }
      send({
        type: 'registerUi',
        slot: def.slot ?? 'sidebar',
        uiType: def.type ?? 'button',
        label: def.label,
        icon: def.icon,
        command: def.command,
      })
    },
    registerShortcut(accelerator: string, handler: () => void) {
      requirePermission('shortcuts', 'registerShortcut')
      if (typeof accelerator !== 'string' || !accelerator) {
        throw new Error('registerShortcut: accelerator обязателен (например "Ctrl+Shift+P")')
      }
      if (typeof handler !== 'function') {
        throw new Error('registerShortcut: handler обязателен')
      }
      shortcutHandlers.set(accelerator, handler)
      fireAndForget('shortcut.register', { accelerator }, 'shortcut.register')
    },
    unregisterShortcut(accelerator: string) {
      requirePermission('shortcuts', 'unregisterShortcut')
      shortcutHandlers.delete(accelerator)
      fireAndForget('shortcut.unregister', { accelerator }, 'shortcut.unregister')
    },
    registerPanel(def) {
      requirePermission('ui', 'registerPanel')
      if (!def || typeof def.id !== 'string' || !def.id) {
        throw new Error('registerPanel: id обязателен')
      }
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(def.id)) {
        throw new Error(`registerPanel: id "${def.id}" должно быть [a-zA-Z][a-zA-Z0-9_-]*`)
      }
      if (!def.title) throw new Error('registerPanel: title обязателен')
      send({
        type: 'registerUi',
        slot: def.slot ?? 'right',
        uiType: 'panel',
        label: def.title,
        icon: def.icon,
        panelId: def.id,
        entry: def.entry,
      })
    },
    registerContextProvider(def) {
      requirePermission('context', 'registerContextProvider')
      if (!def || typeof def.name !== 'string' || !def.name) {
        throw new Error('registerContextProvider: name обязателен')
      }
      if (typeof def.handler !== 'function') {
        throw new Error(`registerContextProvider(${def.name}): handler обязателен`)
      }
      contextProviders.set(def.name, def.handler)
      send({ type: 'registerContextProvider', name: def.name, description: def.description })
    },
    registerMarkdownRenderer(def) {
      requirePermission('ui', 'registerMarkdownRenderer')
      if (!def || typeof def.language !== 'string' || !def.language) {
        throw new Error('registerMarkdownRenderer: language обязателен')
      }
      if (typeof def.entry !== 'string' || !def.entry) {
        throw new Error('registerMarkdownRenderer: entry обязателен (HTML-файл относительно папки плагина)')
      }
      send({ type: 'registerMarkdownRenderer', language: def.language, entry: def.entry, height: def.height })
    },
    registerMessageTag(def) {
      requirePermission('ui', 'registerMessageTag')
      if (!def || typeof def.tag !== 'string' || !def.tag) {
        throw new Error('registerMessageTag: tag обязателен')
      }
      if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(def.tag)) {
        throw new Error(`registerMessageTag: имя тега "${def.tag}" должно быть [a-zA-Z][a-zA-Z0-9-]*`)
      }
      if (typeof def.entry !== 'string' || !def.entry) {
        throw new Error('registerMessageTag: entry обязателен (HTML-файл относительно папки плагина)')
      }
      send({ type: 'registerMessageTag', tag: def.tag, entry: def.entry, height: def.height, description: def.description })
    },
    unregisterMessageTag(tag) {
      requirePermission('ui', 'unregisterMessageTag')
      send({ type: 'unregisterMessageTag', name: tag })
    },
    registerPromptSection(def) {
      requirePermission('context', 'registerPromptSection')
      if (!def || typeof def.title !== 'string' || !def.title) {
        throw new Error('registerPromptSection: title обязателен')
      }
      if (typeof def.content !== 'string') {
        throw new Error('registerPromptSection: content обязателен (markdown-строка)')
      }
      const id = def.id || def.title
      send({ type: 'registerPromptSection', id, title: def.title, content: def.content })
    },
    unregisterPromptSection(id) {
      requirePermission('context', 'unregisterPromptSection')
      send({ type: 'unregisterPromptSection', name: id })
    },
    registerSettingsSection(def) {
      requirePermission('ui', 'registerSettingsSection')
      if (!def || typeof def.id !== 'string' || !def.id) {
        throw new Error('registerSettingsSection: id обязателен')
      }
      if (typeof def.title !== 'string' || !def.title) {
        throw new Error('registerSettingsSection: title обязателен')
      }
      if (typeof def.entry !== 'string' || !def.entry) {
        throw new Error('registerSettingsSection: entry обязателен (HTML-файл относительно папки плагина)')
      }
      send({ type: 'registerSettingsSection', id: def.id, title: def.title, entry: def.entry, icon: def.icon })
    },
    unregisterSettingsSection(id) {
      requirePermission('ui', 'unregisterSettingsSection')
      send({ type: 'unregisterSettingsSection', name: id })
    },
    registerSearchProvider(def) {
      requirePermission('ui', 'registerSearchProvider')
      if (!def || typeof def.id !== 'string' || !def.id) {
        throw new Error('registerSearchProvider: id обязателен')
      }
      if (typeof def.handler !== 'function') {
        throw new Error(`registerSearchProvider(${def.id}): handler обязателен`)
      }
      searchProviders.set(def.id, def.handler)
      send({ type: 'registerSearchProvider', id: def.id, label: def.label || def.id })
    },
    registerAutocomplete(def) {
      requirePermission('ui', 'registerAutocomplete')
      if (!def || typeof def.trigger !== 'string' || !def.trigger) {
        throw new Error('registerAutocomplete: trigger обязателен')
      }
      if (typeof def.handler !== 'function') {
        throw new Error(`registerAutocomplete(${def.trigger}): handler обязателен`)
      }
      autocompleteHandlers.set(def.trigger, def.handler)
      send({ type: 'registerAutocomplete', trigger: def.trigger })
    },
    registerContextMenu(def) {
      requirePermission('ui', 'registerContextMenu')
      if (!def || typeof def.id !== 'string' || !def.id) {
        throw new Error('registerContextMenu: id обязателен')
      }
      if (typeof def.handler !== 'function') {
        throw new Error(`registerContextMenu(${def.id}): handler обязателен`)
      }
      contextMenuHandlers.set(def.id, def.handler)
      send({
        type: 'registerContextMenu',
        id: def.id,
        label: def.label || def.id,
        icon: def.icon,
        scope: def.scope === 'selection' ? 'selection' : 'message',
        button: def.button === true,
      })
    },
    registerInputAction(def) {
      requirePermission('ui', 'registerInputAction')
      if (!def || typeof def.id !== 'string' || !def.id) {
        throw new Error('registerInputAction: id обязателен')
      }
      if (!def.label) throw new Error('registerInputAction: label обязателен')
      send({
        type: 'registerInputAction',
        id: def.id,
        label: def.label,
        icon: def.icon,
        tooltip: def.tooltip,
        command: def.command,
      })
    },
    registerTheme(def) {
      requirePermission('ui', 'registerTheme')
      if (!def || typeof def.name !== 'string' || !def.name) {
        throw new Error('registerTheme: name обязателен')
      }
      send({ type: 'registerTheme', name: def.name, dark: def.dark !== false, colors: def.colors ?? {} })
    },
    registerBackground(def) {
      requirePermission('ui', 'registerBackground')
      if (!def || typeof def.id !== 'string' || !def.id) {
        throw new Error('registerBackground: id обязателен')
      }
      if (typeof def.src !== 'string' || !def.src) {
        throw new Error('registerBackground: src обязателен (файл относительно папки плагина)')
      }
      send({
        type: 'registerBackground',
        id: def.id,
        name: def.name || def.id,
        kind: def.kind === 'video' ? 'video' : (def.kind === 'image' ? 'image' : 'shader'),
        src: def.src,
      })
    },
    on(event, handler) {
      if (typeof handler !== 'function') return
      // События контента (текст чата, вызовы тулов, system prompt) —
      // отдельный permission 'hooks': без него плагин с 0 прав не может
      // читать/менять переписку и промпт.
      const HOOK_EVENTS = new Set([
        'chat:message', 'chat:before-send', 'chat:completed', 'message:delta',
        'tool:call', 'tool:result', 'prompt:before-build',
      ])
      if (HOOK_EVENTS.has(event)) {
        requirePermission('hooks', `on('${event}')`)
      }
      if (!eventHandlers.has(event)) eventHandlers.set(event, new Set())
      eventHandlers.get(event)!.add(handler)
      // Сообщаем main, на какие события есть подписчики (short-circuit хуков).
      send({ type: 'subscribeEvents', events: [...eventHandlers.keys()] })
    },
    log: (() => {
      const sendLog = (level: 'info' | 'warn' | 'error', args: unknown[]) => {
        send({ type: 'log', level, message: args.map(a => (typeof a === 'string' ? a : safeStringify(a))).join(' ') })
      }
      const fn = (...args: unknown[]) => sendLog('info', args)
      fn.info = (...args: unknown[]) => sendLog('info', args)
      fn.warn = (...args: unknown[]) => sendLog('warn', args)
      fn.error = (...args: unknown[]) => sendLog('error', args)
      return fn
    })(),
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        const r = await hostRequest('storage.get', { key })
        if (!r.ok) throw new Error(r.error || 'storage.get failed')
        return r.result as T | undefined
      },
      async set(key: string, value: unknown) {
        const r = await hostRequest('storage.set', { key, value })
        if (!r.ok) throw new Error(r.error || 'storage.set failed')
      },
      async delete(key: string) {
        const r = await hostRequest('storage.delete', { key })
        if (!r.ok) throw new Error(r.error || 'storage.delete failed')
      },
    },
    clipboard: {
      async readText() {
        requirePermission('clipboard', 'clipboard.readText')
        const r = await hostRequest('clipboard.readText', {})
        if (!r.ok) throw new Error(r.error || 'clipboard.readText failed')
        return (r.result as string) ?? ''
      },
      async writeText(text: string) {
        requirePermission('clipboard', 'clipboard.writeText')
        const r = await hostRequest('clipboard.writeText', { text })
        if (!r.ok) throw new Error(r.error || 'clipboard.writeText failed')
      },
    },
    notifications: {
      async show(title: string, body: string, opts?: { actions?: Array<{ label: string; command?: string; panel?: string }> }) {
        requirePermission('notifications', 'notifications.show')
        const r = await hostRequest('notification.show', {
          title, body,
          actions: opts?.actions?.map(a => ({
            label: String(a.label ?? ''),
            command: a.command ? String(a.command) : undefined,
            panel: a.panel ? String(a.panel) : undefined,
          })) ?? [],
        })
        if (!r.ok) throw new Error(r.error || 'notification.show failed')
      },
    },
    net: {
      async fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; binary?: boolean }) {
        requirePermission('net', 'net.fetch')
        const r = await hostRequest('net.fetch', { url, init: init ?? {}, binary: init?.binary === true })
        if (!r.ok) throw new Error(r.error || 'net.fetch failed')
        return r.result as { status: number; headers: Record<string, string>; body: string; bodyBase64?: string }
      },
      ws: {
        async connect(id: string, url: string): Promise<void> {
          requirePermission('net', 'net.ws.connect')
          const r = await hostRequest('net.ws.connect', { id, url })
          if (!r.ok) throw new Error(r.error || 'net.ws.connect failed')
        },
        send(id: string, data: string): void {
          requirePermission('net', 'net.ws.send')
          fireAndForget('net.ws.send', { id, data }, 'net.ws.send')
        },
        close(id: string): void {
          requirePermission('net', 'net.ws.close')
          fireAndForget('net.ws.close', { id }, 'net.ws.close')
        },
      },
      async listen(port: number, handler: WebhookHandler): Promise<void> {
        requirePermission('webhook', 'net.listen')
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error('net.listen: port должен быть 1..65535')
        }
        if (typeof handler !== 'function') {
          throw new Error('net.listen: handler обязателен')
        }
        webhookHandlers.set(port, handler)
        const r = await hostRequest('net.listen', { port })
        if (!r.ok) {
          webhookHandlers.delete(port)
          throw new Error(r.error || 'net.listen failed')
        }
      },
      async close(port: number): Promise<void> {
        requirePermission('webhook', 'net.close')
        webhookHandlers.delete(port)
        const r = await hostRequest('net.close', { port })
        if (!r.ok) throw new Error(r.error || 'net.close failed')
      },
    },
    ai: {
      async chat(
        prompt: string | Array<{ type: 'text'; text: string } | { type: 'image'; path?: string; url?: string; base64?: string }>,
        opts?: {
          system?: string; model?: string; maxTokens?: number; stream?: boolean; onDelta?: (delta: string) => void
          tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown>; handler: (args: Record<string, unknown>) => unknown }>
          chatContext?: boolean; chatId?: string
        },
      ): Promise<string> {
        requirePermission('ai', 'ai.chat')
        const params: Record<string, unknown> = {
          system: opts?.system,
          model: opts?.model,
          maxTokens: opts?.maxTokens,
        }
        if (Array.isArray(prompt)) {
          params.messages = prompt
        } else {
          params.prompt = prompt
        }
        // Function calling: хендлеры остаются в процессе плагина — в main
        // уходит только декларация; вызовы приходят callHandler 'aiTool'.
        if (opts?.tools?.length) {
          params.tools = opts.tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          }))
          for (const t of opts.tools) aiToolHandlers.set(t.name, t.handler)
        }
        if (opts?.chatContext) {
          params.chatContext = true
          params.chatId = opts.chatId
        }
        if (opts?.stream) {
          // Стриминг: дельты приходят событием 'ai:delta' { requestId, delta },
          // финальный hostResponse несёт полный текст.
          const requestId = nextId('ais')
          if (typeof opts.onDelta === 'function') {
            aiDeltaWaiters.set(requestId, opts.onDelta)
          }
          const r = await new Promise<{ ok: boolean; result?: unknown; error?: string }>(resolve => {
            hostWaiters.set(requestId, resolve)
            send({ type: 'hostRequest', requestId, method: 'ai.chatStream', params })
            setTimeout(() => {
              const w = hostWaiters.get(requestId)
              if (w) {
                hostWaiters.delete(requestId)
                aiDeltaWaiters.delete(requestId)
                w({ ok: false, error: 'hostRequest timeout: ai.chatStream' })
              }
            }, 120_000)
          })
          aiDeltaWaiters.delete(requestId)
          if (!r.ok) throw new Error(r.error || 'ai.chat failed')
          return String(r.result ?? '')
        }
        const r = await hostRequest('ai.chat', params)
        if (!r.ok) throw new Error(r.error || 'ai.chat failed')
        return String(r.result ?? '')
      },
      async embed(text: string): Promise<number[]> {
        requirePermission('ai', 'ai.embed')
        const r = await hostRequest('ai.embed', { text })
        if (!r.ok) throw new Error(r.error || 'ai.embed failed')
        return (r.result as number[]) ?? []
      },
      async listModels(): Promise<Array<{ id: string; providerId: string; name: string; contextWindow: number }>> {
        requirePermission('ai', 'ai.listModels')
        const r = await hostRequest('ai.listModels', {})
        if (!r.ok) throw new Error(r.error || 'ai.listModels failed')
        return (r.result as Array<{ id: string; providerId: string; name: string; contextWindow: number }>) ?? []
      },
      async generateImage(prompt: string, opts?: { model?: string; size?: string; quality?: string; style?: string }): Promise<string> {
        requirePermission('ai', 'ai.generateImage')
        const r = await hostRequest('ai.generateImage', {
          prompt,
          model: opts?.model,
          size: opts?.size,
          quality: opts?.quality,
          style: opts?.style,
        })
        if (!r.ok) throw new Error(r.error || 'ai.generateImage failed')
        return String(r.result ?? '')
      },
    },
    shell: {
      async openExternal(url: string): Promise<void> {
        requirePermission('net', 'shell.openExternal')
        const r = await hostRequest('shell.openExternal', { url })
        if (!r.ok) throw new Error(r.error || 'shell.openExternal failed')
      },
    },
    sound: {
      async play(soundId: string): Promise<void> {
        requirePermission('ui', 'sound.play')
        const r = await hostRequest('sound.play', { soundId })
        if (!r.ok) throw new Error(r.error || 'sound.play failed')
      },
    },
    agent: {
      async useTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
        requirePermission('agent', 'agent.useTool')
        // write_file/edit_file пишут в файловую систему — двойной гейт.
        if (tool === 'write_file' || tool === 'edit_file') {
          requirePermission('fs:write:any', `agent.useTool(${tool})`)
        }
        const r = await hostRequest('agent.useTool', { tool, args: args ?? {} })
        if (!r.ok) throw new Error(r.error || 'agent.useTool failed')
        return r.result
      },
      async run(task: string, opts?: { model?: string; workdir?: string }): Promise<{ agentId: string; summary: string }> {
        requirePermission('agent', 'agent.run')
        // Субагент получает пишущие тулы — двойной гейт (как useTool write).
        requirePermission('fs:write:any', 'agent.run')
        const r = await hostRequest('agent.run', { task, model: opts?.model, workdir: opts?.workdir })
        if (!r.ok) throw new Error(r.error || 'agent.run failed')
        return (r.result as { agentId: string; summary: string }) ?? { agentId: '', summary: '' }
      },
    },
    mcp: {
      async listTools(): Promise<Array<{ server: string; name: string; description?: string }>> {
        requirePermission('mcp', 'mcp.listTools')
        const r = await hostRequest('mcp.listTools', {})
        if (!r.ok) throw new Error(r.error || 'mcp.listTools failed')
        return (r.result as Array<{ server: string; name: string; description?: string }>) ?? []
      },
      async call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
        requirePermission('mcp', 'mcp.call')
        const r = await hostRequest('mcp.call', { server, tool, args: args ?? {} })
        if (!r.ok) throw new Error(r.error || 'mcp.call failed')
        return r.result
      },
    },
    secrets: {
      async get(key: string): Promise<string | undefined> {
        requirePermission('secrets', 'secrets.get')
        const r = await hostRequest('secrets.get', { key })
        if (!r.ok) throw new Error(r.error || 'secrets.get failed')
        return r.result as string | undefined
      },
      async set(key: string, value: string): Promise<void> {
        requirePermission('secrets', 'secrets.set')
        const r = await hostRequest('secrets.set', { key, value })
        if (!r.ok) throw new Error(r.error || 'secrets.set failed')
      },
      async delete(key: string): Promise<void> {
        requirePermission('secrets', 'secrets.delete')
        const r = await hostRequest('secrets.delete', { key })
        if (!r.ok) throw new Error(r.error || 'secrets.delete failed')
      },
    },
    speech: {
      async tts(text: string, opts?: { model?: string; voice?: string }): Promise<string> {
        requirePermission('speech', 'speech.tts')
        const r = await hostRequest('speech.tts', { text, model: opts?.model, voice: opts?.voice })
        if (!r.ok) throw new Error(r.error || 'speech.tts failed')
        return String(r.result ?? '')
      },
      async stt(wavPath: string): Promise<string> {
        requirePermission('speech', 'speech.stt')
        const r = await hostRequest('speech.stt', { path: wavPath })
        if (!r.ok) throw new Error(r.error || 'speech.stt failed')
        return String(r.result ?? '')
      },
    },
    settings: {
      async get(): Promise<Record<string, unknown>> {
        requirePermission('settings:read', 'settings.get')
        const r = await hostRequest('settings.get', {})
        if (!r.ok) throw new Error(r.error || 'settings.get failed')
        return (r.result as Record<string, unknown>) ?? {}
      },
    },
    provider: {
      async register(def: { id: string; name: string; baseUrl: string; apiKey?: string; models?: string[] }): Promise<void> {
        requirePermission('provider', 'provider.register')
        if (!def || typeof def.id !== 'string' || !def.id) {
          throw new Error('provider.register: id обязателен')
        }
        if (typeof def.baseUrl !== 'string' || !/^https?:\/\//.test(def.baseUrl)) {
          throw new Error('provider.register: baseUrl обязателен (http/https)')
        }
        const r = await hostRequest('provider.register', {
          id: def.id, name: def.name, baseUrl: def.baseUrl, apiKey: def.apiKey, models: def.models,
        })
        if (!r.ok) throw new Error(r.error || 'provider.register failed')
      },
      async unregister(id: string): Promise<void> {
        requirePermission('provider', 'provider.unregister')
        const r = await hostRequest('provider.unregister', { id })
        if (!r.ok) throw new Error(r.error || 'provider.unregister failed')
      },
    },
    git: {
      async status(workdir: string) {
        requirePermission('git', 'git.status')
        const r = await hostRequest('git.status', { workdir })
        if (!r.ok) throw new Error(r.error || 'git.status failed')
        return r.result as { branch: string | null; ahead: number; behind: number; clean: boolean; files: Array<{ path: string; status: string }> }
      },
      async diff(workdir: string, opts?: { staged?: boolean; file?: string }) {
        requirePermission('git', 'git.diff')
        const r = await hostRequest('git.diff', { workdir, staged: opts?.staged, file: opts?.file })
        if (!r.ok) throw new Error(r.error || 'git.diff failed')
        return String(r.result ?? '')
      },
      async log(workdir: string, limit?: number) {
        requirePermission('git', 'git.log')
        const r = await hostRequest('git.log', { workdir, limit })
        if (!r.ok) throw new Error(r.error || 'git.log failed')
        return (r.result as Array<{ hash: string; author: string; date: string; message: string }>) ?? []
      },
      async commit(workdir: string, message: string, opts?: { add?: boolean; addAll?: boolean }) {
        requirePermission('git', 'git.commit')
        const r = await hostRequest('git.commit', { workdir, message, add: opts?.add, addAll: opts?.addAll })
        if (!r.ok) throw new Error(r.error || 'git.commit failed')
        return String(r.result ?? '')
      },
      async branches(workdir: string) {
        requirePermission('git', 'git.branches')
        const r = await hostRequest('git.branches', { workdir })
        if (!r.ok) throw new Error(r.error || 'git.branches failed')
        return (r.result as Array<{ name: string; current: boolean }>) ?? []
      },
    },
    process: {
      async exec(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }> {
        requirePermission('process:exec', 'process.exec')
        const r = await hostRequest('process.exec', { command, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs })
        if (!r.ok) throw new Error(r.error || 'process.exec failed')
        return (r.result as { stdout: string; stderr: string; code: number }) ?? { stdout: '', stderr: '', code: -1 }
      },
    },
    bus: {
      emit(event: string, data?: unknown): void {
        if (typeof event !== 'string' || !event) throw new Error('bus.emit: event обязателен')
        fireAndForget('bus.emit', { event, data }, 'bus.emit')
      },
      on(event: string, handler: (data: unknown) => void): void {
        if (typeof event !== 'string' || !event) throw new Error('bus.on: event обязателен')
        if (typeof handler !== 'function') return
        const key = `bus:${event}`
        if (!eventHandlers.has(key)) eventHandlers.set(key, new Set())
        eventHandlers.get(key)!.add(handler as EventHandler)
        send({ type: 'subscribeEvents', events: [...eventHandlers.keys()] })
      },
    },
    scheduler: {
      every(intervalMs: number, handler: () => void | Promise<void>): () => void {
        requirePermission('scheduler', 'scheduler.every')
        if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
          throw new Error('scheduler.every: intervalMs должен быть >= 1000')
        }
        const id = nextId('sch')
        schedulerHandlers.set(id, handler)
        fireAndForget('scheduler.every', { id, intervalMs }, 'scheduler.every')
        return () => {
          schedulerHandlers.delete(id)
          fireAndForget('scheduler.cancel', { id }, 'scheduler.cancel')
        }
      },
      cron(expr: string, handler: () => void | Promise<void>): () => void {
        requirePermission('scheduler', 'scheduler.cron')
        if (typeof expr !== 'string' || expr.trim().split(/\s+/).length !== 5) {
          throw new Error('scheduler.cron: expr должен быть из 5 полей (min hour dom month dow)')
        }
        const id = nextId('sch')
        schedulerHandlers.set(id, handler)
        fireAndForget('scheduler.cron', { id, expr }, 'scheduler.cron')
        return () => {
          schedulerHandlers.delete(id)
          fireAndForget('scheduler.cancel', { id }, 'scheduler.cancel')
        }
      },
      at(delayMs: number, handler: () => void | Promise<void>): () => void {
        requirePermission('scheduler', 'scheduler.at')
        if (!Number.isFinite(delayMs) || delayMs < 0) {
          throw new Error('scheduler.at: delayMs должен быть >= 0')
        }
        const id = nextId('sch')
        schedulerHandlers.set(id, handler)
        fireAndForget('scheduler.at', { id, delayMs }, 'scheduler.at')
        return () => {
          schedulerHandlers.delete(id)
          fireAndForget('scheduler.cancel', { id }, 'scheduler.cancel')
        }
      },
    },
    overlay: {
      async show(opts: { entry: string; data?: unknown; width?: number; height?: number; timeoutMs?: number }): Promise<void> {
        requirePermission('overlay', 'overlay.show')
        const r = await hostRequest('overlay.show', {
          entry: opts?.entry, data: opts?.data,
          width: opts?.width, height: opts?.height, timeoutMs: opts?.timeoutMs,
        })
        if (!r.ok) throw new Error(r.error || 'overlay.show failed')
      },
      async hide(): Promise<void> {
        requirePermission('overlay', 'overlay.hide')
        const r = await hostRequest('overlay.hide', {})
        if (!r.ok) throw new Error(r.error || 'overlay.hide failed')
      },
    },
    statusbar: {
      set(id: string, text: string, opts?: { tooltip?: string; command?: string }): void {
        requirePermission('ui', 'statusbar.set')
        fireAndForget('statusbar.set', { id, text, tooltip: opts?.tooltip, command: opts?.command }, 'statusbar.set')
      },
      clear(id: string): void {
        requirePermission('ui', 'statusbar.clear')
        fireAndForget('statusbar.clear', { id }, 'statusbar.clear')
      },
    },
    tray: {
      setMenu(items: Array<{ label: string; command?: string; type?: 'item' | 'separator' }>): void {
        requirePermission('tray', 'tray.setMenu')
        fireAndForget('tray.setMenu', { items: items ?? [] }, 'tray.setMenu')
      },
      clearMenu(): void {
        requirePermission('tray', 'tray.clearMenu')
        fireAndForget('tray.clearMenu', {}, 'tray.clearMenu')
      },
    },
    config: {
      async get<T>(key: string): Promise<T | undefined> {
        const r = await hostRequest('config.get', { key })
        if (!r.ok) throw new Error(r.error || 'config.get failed')
        return r.result as T | undefined
      },
      async getAll(): Promise<Record<string, unknown>> {
        const r = await hostRequest('config.getAll', {})
        if (!r.ok) throw new Error(r.error || 'config.getAll failed')
        return (r.result as Record<string, unknown>) ?? {}
      },
    },
    fs: {
      async readFile(path: string, opts?: { encoding?: 'utf-8' | 'base64' }): Promise<string> {
        requirePermission('fs:read', 'fs.readFile')
        const r = await hostRequest('fs.readFile', { path, encoding: opts?.encoding })
        if (!r.ok) throw new Error(r.error || 'fs.readFile failed')
        return (r.result as string) ?? ''
      },
      async writeFile(path: string, content: string, opts?: { encoding?: 'utf-8' | 'base64' }): Promise<void> {
        requireWritePermission('fs.writeFile', path)
        const r = await hostRequest('fs.writeFile', { path, content, encoding: opts?.encoding })
        if (!r.ok) throw new Error(r.error || 'fs.writeFile failed')
      },
      async stat(path: string): Promise<{ exists: boolean; isFile: boolean; isDir: boolean; size: number; mtime: number }> {
        requirePermission('fs:read', 'fs.stat')
        const r = await hostRequest('fs.stat', { path })
        if (!r.ok) throw new Error(r.error || 'fs.stat failed')
        return (r.result as { exists: boolean; isFile: boolean; isDir: boolean; size: number; mtime: number })
          ?? { exists: false, isFile: false, isDir: false, size: 0, mtime: 0 }
      },
      async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
        requireWritePermission('fs.mkdir', path)
        const r = await hostRequest('fs.mkdir', { path, recursive: opts?.recursive !== false })
        if (!r.ok) throw new Error(r.error || 'fs.mkdir failed')
      },
      async delete(path: string): Promise<void> {
        requireWritePermission('fs.delete', path)
        const r = await hostRequest('fs.delete', { path })
        if (!r.ok) throw new Error(r.error || 'fs.delete failed')
      },
      async rename(from: string, to: string): Promise<void> {
        requireWritePermission('fs.rename', from, to)
        const r = await hostRequest('fs.rename', { from, to })
        if (!r.ok) throw new Error(r.error || 'fs.rename failed')
      },
      async copy(from: string, to: string): Promise<void> {
        requireWritePermission('fs.copy', from, to)
        const r = await hostRequest('fs.copy', { from, to })
        if (!r.ok) throw new Error(r.error || 'fs.copy failed')
      },
      async writeFiles(files: Record<string, string>, opts?: { baseDir?: string }): Promise<void> {
        if (!files || typeof files !== 'object') throw new Error('fs.writeFiles: files обязателен')
        const baseDir = opts?.baseDir
        const paths = Object.keys(files).map(p => (baseDir ? `${baseDir}/${p}` : p))
        requireWritePermission('fs.writeFiles', ...paths)
        const r = await hostRequest('fs.writeFiles', { files, baseDir })
        if (!r.ok) throw new Error(r.error || 'fs.writeFiles failed')
      },
      async listDir(path: string): Promise<string[]> {
        requirePermission('fs:read', 'fs.listDir')
        const r = await hostRequest('fs.listDir', { path })
        if (!r.ok) throw new Error(r.error || 'fs.listDir failed')
        return (r.result as string[]) ?? []
      },
      watch(path: string, handler: (p: { event: string; file: string }) => void, opts?: { recursive?: boolean }): () => void {
        requirePermission('fs:read', 'fs.watch')
        if (typeof path !== 'string' || !path) {
          throw new Error('fs.watch: path обязателен')
        }
        if (typeof handler !== 'function') {
          throw new Error('fs.watch: handler обязателен')
        }
        const id = nextId('fsw')
        fsWatchHandlers.set(id, handler)
        fireAndForget('fs.watch', { id, path, recursive: opts?.recursive ?? false }, 'fs.watch')
        return () => {
          fsWatchHandlers.delete(id)
          fireAndForget('fs.unwatch', { id }, 'fs.unwatch')
        }
      },
      async pickFile(opts?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null> {
        requirePermission('ui', 'fs.pickFile')
        const r = await hostRequest('fs.pickFile', { title: opts?.title, filters: opts?.filters })
        if (!r.ok) throw new Error(r.error || 'fs.pickFile failed')
        return (r.result as string | null) ?? null
      },
      async pickDir(opts?: { title?: string }): Promise<string | null> {
        requirePermission('ui', 'fs.pickDir')
        const r = await hostRequest('fs.pickDir', { title: opts?.title })
        if (!r.ok) throw new Error(r.error || 'fs.pickDir failed')
        return (r.result as string | null) ?? null
      },
      async pickFiles(opts?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string[]> {
        requirePermission('ui', 'fs.pickFiles')
        const r = await hostRequest('fs.pickFiles', { title: opts?.title, filters: opts?.filters })
        if (!r.ok) throw new Error(r.error || 'fs.pickFiles failed')
        return (r.result as string[]) ?? []
      },
      async saveDialog(opts?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null> {
        requirePermission('ui', 'fs.saveDialog')
        const r = await hostRequest('fs.saveDialog', { title: opts?.title, defaultPath: opts?.defaultPath, filters: opts?.filters })
        if (!r.ok) throw new Error(r.error || 'fs.saveDialog failed')
        return (r.result as string | null) ?? null
      },
    },
    ui: {
      onMessage(handler: (data: unknown) => void): void {
        if (typeof handler === 'function') uiMessageHandlers.add(handler)
      },
      postMessage(data: unknown): void {
        send({ type: 'uiPostMessage', data })
      },
      handle(method: string, handler: (args: Record<string, unknown>) => unknown): void {
        uiRpcHandlers.set(method, handler)
      },
      emit(method: string, data?: unknown): void {
        send({ type: 'uiPostMessage', data: { __rpc__: true, method, data: data ?? null } })
      },
      async getTheme() {
        const r = await hostRequest('ui.getTheme', {})
        if (!r.ok) throw new Error(r.error || 'ui.getTheme failed')
        return (r.result as { theme: string; accentColor: string; dark: boolean }) ?? { theme: 'dark', accentColor: '#22d3ee', dark: true }
      },
      registerWidget(def: { name: string; entry: string; height?: number; description?: string }): void {
        requirePermission('ui', 'registerWidget')
        if (!def || typeof def.name !== 'string' || !def.name) {
          throw new Error('registerWidget: name обязателен')
        }
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(def.name)) {
          throw new Error(`registerWidget: имя "${def.name}" должно быть [a-zA-Z][a-zA-Z0-9_-]*`)
        }
        if (typeof def.entry !== 'string' || !def.entry) {
          throw new Error('registerWidget: entry обязателен (HTML-файл относительно папки плагина)')
        }
        fireAndForget('ui.registerWidget', { name: def.name, entry: def.entry, height: def.height, description: def.description }, 'ui.registerWidget')
      },
      openModal(def?: { entry?: string; title?: string; width?: number; height?: number }): void {
        requirePermission('ui', 'openModal')
        fireAndForget('ui.openModal', { entry: def?.entry, title: def?.title, width: def?.width, height: def?.height }, 'ui.openModal')
      },
      closeModal(): void {
        requirePermission('ui', 'closeModal')
        fireAndForget('ui.closeModal', {}, 'ui.closeModal')
      },
      setBadge(panelId: string, badge: number | null): void {
        requirePermission('ui', 'setBadge')
        fireAndForget('ui.setBadge', { panelId, badge }, 'ui.setBadge')
      },
      showChatOverlay(def: { entry?: string; title?: string; width?: number; height?: number; position?: 'left' | 'right' | 'center' }): void {
        requirePermission('ui', 'showChatOverlay')
        fireAndForget('ui.showChatOverlay', {
          entry: def?.entry,
          title: def?.title,
          width: def?.width,
          height: def?.height,
          position: def?.position,
        }, 'ui.showChatOverlay')
      },
      hideChatOverlay(): void {
        requirePermission('ui', 'hideChatOverlay')
        fireAndForget('ui.hideChatOverlay', {}, 'ui.hideChatOverlay')
      },
      beginProgress(def: { label: string }) {
        requirePermission('ui', 'beginProgress')
        if (!def || typeof def.label !== 'string' || !def.label) {
          throw new Error('beginProgress: label обязателен')
        }
        const progressId = `pg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        fireAndForget('ui.progress', { progressId, action: 'begin', label: def.label }, 'ui.progress')
        return {
          update(text: string): void {
            fireAndForget('ui.progress', { progressId, action: 'update', label: String(text ?? '') }, 'ui.progress')
          },
          finish(): void {
            fireAndForget('ui.progress', { progressId, action: 'finish' }, 'ui.progress')
          },
        }
      },
    },
    chat: {
      async send(text: string, opts?: { silent?: boolean; attachments?: Array<{ path: string; name?: string; kind?: 'file' | 'image' }> }) {
        requirePermission('chat', 'chat.send')
        const r = await hostRequest('chat.send', {
          text,
          silent: opts?.silent ?? false,
          attachments: opts?.attachments,
        })
        if (!r.ok) throw new Error(r.error || 'chat.send failed')
      },
      async reply(text: string) {
        requirePermission('chat', 'chat.reply')
        const r = await hostRequest('chat.reply', { text })
        if (!r.ok) throw new Error(r.error || 'chat.reply failed')
      },
      async beginReply() {
        requirePermission('chat', 'chat.beginReply')
        const r = await hostRequest('chat.beginReply', {})
        if (!r.ok) throw new Error(r.error || 'chat.beginReply failed')
        return String(r.result ?? '')
      },
      async appendChunk(replyId: string, delta: string) {
        requirePermission('chat', 'chat.appendChunk')
        const r = await hostRequest('chat.appendChunk', { replyId, delta })
        if (!r.ok) throw new Error(r.error || 'chat.appendChunk failed')
      },
      async endReply(replyId: string) {
        requirePermission('chat', 'chat.endReply')
        const r = await hostRequest('chat.endReply', { replyId })
        if (!r.ok) throw new Error(r.error || 'chat.endReply failed')
      },
      async getActive() {
        requirePermission('chats:read', 'chat.getActive')
        const r = await hostRequest('chat.getActive', {})
        if (!r.ok) throw new Error(r.error || 'chat.getActive failed')
        return (r.result as { chatId: string | null }) ?? { chatId: null }
      },
    },
    prompt: {
      async get(chatId?: string) {
        requirePermission('hooks', 'prompt.get')
        const r = await hostRequest('prompt.get', { chatId })
        if (!r.ok) throw new Error(r.error || 'prompt.get failed')
        return String(r.result ?? '')
      },
    },
    chats: {
      async list() {
        requirePermission('chats:read', 'chats.list')
        const r = await hostRequest('chats.list', {})
        if (!r.ok) throw new Error(r.error || 'chats.list failed')
        return (r.result as Array<{ id: string; title: string; createdAt: number; updatedAt: number }>) ?? []
      },
      async get(chatId: string) {
        requirePermission('chats:read', 'chats.get')
        const r = await hostRequest('chats.get', { chatId })
        if (!r.ok) throw new Error(r.error || 'chats.get failed')
        return r.result as { chat: Record<string, unknown>; messages: Array<Record<string, unknown>> } | null
      },
      async create(title?: string, projectId?: string) {
        requirePermission('chats:write', 'chats.create')
        const r = await hostRequest('chats.create', { title, projectId })
        if (!r.ok) throw new Error(r.error || 'chats.create failed')
        return (r.result as { id: string }) ?? { id: '' }
      },
      async rename(chatId: string, title: string) {
        requirePermission('chats:write', 'chats.rename')
        const r = await hostRequest('chats.rename', { chatId, title })
        if (!r.ok) throw new Error(r.error || 'chats.rename failed')
      },
      async delete(chatId: string) {
        requirePermission('chats:write', 'chats.delete')
        const r = await hostRequest('chats.delete', { chatId })
        if (!r.ok) throw new Error(r.error || 'chats.delete failed')
      },
      async appendMessage(chatId: string, role: 'user' | 'assistant', content: string) {
        requirePermission('chats:write', 'chats.appendMessage')
        const r = await hostRequest('chats.appendMessage', { chatId, role, content })
        if (!r.ok) throw new Error(r.error || 'chats.appendMessage failed')
        return (r.result as { id: string }) ?? { id: '' }
      },
      async editMessage(messageId: string, content: string) {
        requirePermission('chats:write', 'chats.editMessage')
        const r = await hostRequest('chats.editMessage', { messageId, content })
        if (!r.ok) throw new Error(r.error || 'chats.editMessage failed')
      },
      async deleteMessage(messageId: string) {
        requirePermission('chats:write', 'chats.deleteMessage')
        const r = await hostRequest('chats.deleteMessage', { messageId })
        if (!r.ok) throw new Error(r.error || 'chats.deleteMessage failed')
      },
      async open(chatId: string) {
        requirePermission('chats:read', 'chats.open')
        const r = await hostRequest('chats.open', { chatId })
        if (!r.ok) throw new Error(r.error || 'chats.open failed')
      },
      async getAttachments(messageId: string) {
        requirePermission('chats:read', 'chats.getAttachments')
        const r = await hostRequest('chats.getAttachments', { messageId })
        if (!r.ok) throw new Error(r.error || 'chats.getAttachments failed')
        return (r.result as Array<Record<string, unknown>>) ?? []
      },
      async getMessages(chatId: string, opts?: { limit?: number; beforeCreatedAt?: number; beforeId?: string }) {
        requirePermission('chats:read', 'chats.getMessages')
        const r = await hostRequest('chats.getMessages', {
          chatId,
          limit: opts?.limit,
          beforeCreatedAt: opts?.beforeCreatedAt,
          beforeId: opts?.beforeId,
        })
        if (!r.ok) throw new Error(r.error || 'chats.getMessages failed')
        return (r.result as { messages: Array<Record<string, unknown>>; hasMore: boolean }) ?? { messages: [], hasMore: false }
      },
    },
    projects: {
      async list() {
        requirePermission('projects:read', 'projects.list')
        const r = await hostRequest('projects.list', {})
        if (!r.ok) throw new Error(r.error || 'projects.list failed')
        return (r.result as Array<{ id: string; name: string; workdir: string }>) ?? []
      },
      async current() {
        requirePermission('projects:read', 'projects.current')
        const r = await hostRequest('projects.current', {})
        if (!r.ok) throw new Error(r.error || 'projects.current failed')
        return (r.result as { chatId: string | null; projectId?: string; projectName?: string; workdir?: string })
          ?? { chatId: null }
      },
      async create(workdir: string, opts?: { name?: string; projectContext?: string }) {
        requirePermission('projects:write', 'projects.create')
        const r = await hostRequest('projects.create', { workdir, name: opts?.name, projectContext: opts?.projectContext })
        if (!r.ok) throw new Error(r.error || 'projects.create failed')
        return (r.result as { id: string; name: string; workdir: string }) ?? { id: '', name: '', workdir }
      },
    },
    memory: {
      async search(query: string) {
        requirePermission('memory', 'memory.search')
        const r = await hostRequest('memory.search', { query })
        if (!r.ok) throw new Error(r.error || 'memory.search failed')
        return (r.result as Array<Record<string, unknown>>) ?? []
      },
      async save(key: string, value: string, category?: string) {
        requirePermission('memory', 'memory.save')
        const r = await hostRequest('memory.save', { key, value, category })
        if (!r.ok) throw new Error(r.error || 'memory.save failed')
      },
      chat: {
        async get<T>(chatId: string, key: string): Promise<T | undefined> {
          requirePermission('memory', 'memory.chat.get')
          const r = await hostRequest('memory.chat.get', { chatId, key })
          if (!r.ok) throw new Error(r.error || 'memory.chat.get failed')
          return r.result as T | undefined
        },
        async set(chatId: string, key: string, value: unknown): Promise<void> {
          requirePermission('memory', 'memory.chat.set')
          const r = await hostRequest('memory.chat.set', { chatId, key, value })
          if (!r.ok) throw new Error(r.error || 'memory.chat.set failed')
        },
        async delete(chatId: string, key: string): Promise<void> {
          requirePermission('memory', 'memory.chat.delete')
          const r = await hostRequest('memory.chat.delete', { chatId, key })
          if (!r.ok) throw new Error(r.error || 'memory.chat.delete failed')
        },
      },
    },
    window: {
      async toast(text: string, kind?: 'info' | 'success' | 'error') {
        requirePermission('ui', 'window.toast')
        const r = await hostRequest('window.toast', { text, kind: kind ?? 'info' })
        if (!r.ok) throw new Error(r.error || 'window.toast failed')
      },
      async dialog(title: string, body: string, buttons?: string[]) {
        requirePermission('ui', 'window.dialog')
        const r = await hostRequest('window.dialog', { title, body, buttons })
        if (!r.ok) throw new Error(r.error || 'window.dialog failed')
        return (r.result as number) ?? 0
      },
    },
  }
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}

// ── Обработка сообщений от main ────────────────────────────────────────────

port.on('message', (e) => {
  const msg = e.data as PluginMsgHostToPlugin
  // Python sidecar: ВСЕ сообщения main уходят в python-процесс 1:1,
  // ответы приходят обратно через stdout-мост. Локальная диспетчеризация
  // (tools/commands Maps) не используется.
  if (pyChild) {
    forwardToPython(msg)
    return
  }
  switch (msg.type) {
    case 'init': {
      ;(async () => {
        try {
          pluginDir = msg.pluginDir
          permissions = new Set(msg.permissions ?? [])
          hostVersion = msg.env?.appVersion ?? ''
          // Динамическая загрузка кода плагина — только через require в рантайме
          // (путь приходит из манифеста, статический импорт невозможен).
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const manifest = require(`${pluginDir}/plugin.json`) as {
            main?: string
            runtime?: 'node' | 'python'
          }
          const entryRel = manifest.main || 'dist/index.js'
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const entry = require('path').join(pluginDir, entryRel)
          if (manifest.runtime === 'python') {
            // Python-плагин: спавним sidecar и становимся мостом.
            if (!msg.python?.exe) {
              throw new Error('runtime:"python", но main не передал интерпретатор (устаревший host?)')
            }
            startPythonBridge(entry, msg.python, pluginDir, msg.requestId)
            // initResult придёт от python-SDK через stdout-мост.
            return
          }
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const mod = require(entry) as {
            activate?: (api: SynteePluginApi) => void | Promise<void>
            deactivate?: () => void | Promise<void>
          }
          if (typeof mod.activate !== 'function') {
            throw new Error(`entry ${entryRel} не экспортирует activate(syntee)`)
          }
          deactivateFn = mod.deactivate ?? null
          await mod.activate(buildApi())
          active = true
          send({ type: 'initResult', requestId: msg.requestId, ok: true })
        } catch (err) {
          send({ type: 'initResult', requestId: msg.requestId, ok: false, error: (err as Error).message })
          // Активация не удалась — процесс больше не нужен.
          setTimeout(() => process.exit(1), 100)
        }
      })()
      break
    }
    case 'callCommand': {
      ;(async () => {
        try {
          if (!active) throw new Error('Плагин не активен')
          const cmd = commands.get(msg.commandName)
          if (!cmd) throw new Error(`Команда не зарегистрирована: ${msg.commandName}`)
          const result = await cmd.handler(msg.args ?? '')
          const output = typeof result === 'string' ? result : safeStringify(result)
          send({ type: 'callCommandResult', requestId: msg.requestId, ok: true, output })
        } catch (err) {
          send({ type: 'callCommandResult', requestId: msg.requestId, ok: false, error: (err as Error).message })
        }
      })()
      break
    }
    case 'event': {
      // Fire-and-forget: хост не ждёт ответа. Ошибки хендлеров — в лог.
      // Спец-события с колбэками (scheduler/shortcut/fs.watch/ai:delta/
      // webhook) диспетчеризуются в свои Map, остальные — в eventHandlers
      // (syntee.on).
      if (msg.event === 'scheduler:tick') {
        const h = schedulerHandlers.get(String(msg.payload?.id ?? ''))
        if (h) {
          try {
            const r = h() as unknown
            if (r && typeof (r as Promise<void>).catch === 'function') {
              ;(r as Promise<void>).catch(e => {
                send({ type: 'log', level: 'error', message: `scheduler handler error: ${(e as Error).message}` })
              })
            }
          } catch (e) {
            send({ type: 'log', level: 'error', message: `scheduler handler error: ${(e as Error).message}` })
          }
        }
        break
      }
      if (msg.event === 'shortcut') {
        const h = shortcutHandlers.get(String(msg.payload?.accelerator ?? ''))
        if (h) {
          try { h() } catch (e) {
            send({ type: 'log', level: 'error', message: `shortcut handler error: ${(e as Error).message}` })
          }
        }
        break
      }
      if (msg.event === 'fs:change') {
        const h = fsWatchHandlers.get(String(msg.payload?.id ?? ''))
        if (h) {
          try { h({ event: String(msg.payload?.event ?? ''), file: String(msg.payload?.file ?? '') }) } catch (e) {
            send({ type: 'log', level: 'error', message: `fs.watch handler error: ${(e as Error).message}` })
          }
        }
        break
      }
      if (msg.event === 'ai:delta') {
        // Дельта стриминга ai.chat: маршрутизируем по requestId.
        const rid = String(msg.payload?.requestId ?? '')
        const h = aiDeltaWaiters.get(rid)
        if (h) {
          try { h(String(msg.payload?.delta ?? '')) } catch { /* ignore */ }
        }
        break
      }
      if (msg.event === 'webhook:request') {
        const port = Number(msg.payload?.port ?? 0)
        const h = webhookHandlers.get(port)
        if (h) {
          try {
            h({
              method: String(msg.payload?.method ?? 'GET'),
              path: String(msg.payload?.path ?? '/'),
              body: String(msg.payload?.body ?? ''),
            })
          } catch (e) {
            send({ type: 'log', level: 'error', message: `webhook handler error: ${(e as Error).message}` })
          }
        }
        break
      }
      const handlers = eventHandlers.get(msg.event)
      if (handlers) {
        for (const h of handlers) {
          try {
            const r = h(msg.payload ?? {}) as unknown
            if (r && typeof (r as Promise<void>).catch === 'function') {
              ;(r as Promise<void>).catch(e => {
                send({ type: 'log', level: 'error', message: `event ${msg.event} handler error: ${(e as Error).message}` })
              })
            }
          } catch (e) {
            send({ type: 'log', level: 'error', message: `event ${msg.event} handler error: ${(e as Error).message}` })
          }
        }
      }
      break
    }
    case 'uiMessage': {
      for (const h of uiMessageHandlers) {
        try { h(msg.data) } catch (e) {
          send({ type: 'log', level: 'error', message: `uiMessage handler error: ${(e as Error).message}` })
        }
      }
      break
    }
    case 'uiCall': {
      ;(async () => {
        try {
          const handler = uiRpcHandlers.get(msg.method)
          if (!handler) throw new Error(`Метод не зарегистрирован: ${msg.method} (syntee.ui.handle)`)
          const result = await handler(msg.args ?? {})
          send({ type: 'uiCallResult', requestId: msg.requestId, ok: true, result: result === undefined ? null : result })
        } catch (err) {
          send({ type: 'uiCallResult', requestId: msg.requestId, ok: false, error: (err as Error).message })
        }
      })()
      break
    }
    case 'hook': {
      ;(async () => {
        try {
          const handlers = eventHandlers.get(msg.event)
          let action: 'allow' | 'modify' | 'reject' = 'allow'
          let content: string | undefined
          let error: string | undefined
          if (handlers && handlers.size > 0) {
            // Последовательное применение: каждый хендлер может модифицировать
            // контент или отклонить. Первый reject — финален.
            for (const h of handlers) {
              try {
                const cur = msg.payload ?? {}
                const res = await h(content !== undefined ? { ...cur, content } : cur)
                const r = res as { action?: string; content?: string; reason?: string } | void | undefined
                if (r && typeof r === 'object') {
                  if (r.action === 'reject') {
                    action = 'reject'
                    error = r.reason
                    break
                  }
                  if (r.action === 'modify' && typeof r.content === 'string') {
                    action = 'modify'
                    content = r.content
                  }
                }
              } catch (e) {
                // Ошибка хендлера — не блокируем отправку, логируем.
                send({ type: 'log', level: 'error', message: `hook ${msg.event} handler error: ${(e as Error).message}` })
              }
            }
          }
          send({ type: 'hookResult', requestId: msg.requestId, ok: action !== 'reject', action, content, error })
        } catch (err) {
          send({ type: 'hookResult', requestId: msg.requestId, ok: true, action: 'allow', error: (err as Error).message })
        }
      })()
      break
    }
    case 'callTool': {
      ;(async () => {
        try {
          if (!active) throw new Error('Плагин не активен')
          const tool = tools.get(msg.toolName)
          if (!tool) throw new Error(`Тул не зарегистрирован: ${msg.toolName}`)
          const result = await tool.handler(msg.args ?? {})
          const output = typeof result === 'string' ? result : safeStringify(result)
          send({ type: 'callToolResult', requestId: msg.requestId, ok: true, output })
        } catch (err) {
          send({ type: 'callToolResult', requestId: msg.requestId, ok: false, error: (err as Error).message })
        }
      })()
      break
    }
    case 'callHandler': {
      ;(async () => {
        try {
          if (!active) throw new Error('Плагин не активен')
          let result: unknown
          if (msg.kind === 'context') {
            const h = contextProviders.get(msg.name)
            if (!h) throw new Error(`Context provider не зарегистрирован: ${msg.name}`)
            result = await h(msg.payload as { chatId: string })
          } else if (msg.kind === 'search') {
            const h = searchProviders.get(msg.name)
            if (!h) throw new Error(`Search provider не зарегистрирован: ${msg.name}`)
            result = await h(msg.payload as { query: string } | { click: Record<string, unknown> })
          } else if (msg.kind === 'autocomplete') {
            const h = autocompleteHandlers.get(msg.name)
            if (!h) throw new Error(`Autocomplete-провайдер не зарегистрирован: ${msg.name}`)
            result = await h(msg.payload as { query: string })
          } else if (msg.kind === 'menu') {
            const h = contextMenuHandlers.get(msg.name)
            if (!h) throw new Error(`Пункт меню не зарегистрирован: ${msg.name}`)
            await h(msg.payload as { messageId?: string; chatId?: string; content?: string; selection?: string })
          } else if (msg.kind === 'aiTool') {
            const h = aiToolHandlers.get(msg.name)
            if (!h) throw new Error(`AI-tool handler не зарегистрирован: ${msg.name}`)
            result = await h((msg.payload as { args?: Record<string, unknown> })?.args ?? {})
          } else {
            throw new Error(`Неизвестный kind: ${msg.kind}`)
          }
          send({ type: 'callHandlerResult', requestId: msg.requestId, ok: true, result: result === undefined ? null : result })
        } catch (err) {
          send({ type: 'callHandlerResult', requestId: msg.requestId, ok: false, error: (err as Error).message })
        }
      })()
      break
    }
    case 'shutdown': {
      ;(async () => {
        try {
          if (deactivateFn) await deactivateFn()
        } catch { /* деактивация упала — всё равно выходим */ }
        send({ type: 'shutdownResult', requestId: msg.requestId })
        setTimeout(() => process.exit(0), 50)
      })()
      break
    }
    case 'hostResponse': {
      const waiter = hostWaiters.get(msg.requestId)
      if (waiter) {
        hostWaiters.delete(msg.requestId)
        waiter({ ok: msg.ok, result: msg.result, error: msg.error })
      }
      break
    }
  }
})

port.start()
