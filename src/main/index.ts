import { app, session } from 'electron'
import { join, relative, isAbsolute } from 'path'

// ── ВАЖНО: setPath ДО любых импортов которые создают electron-store ──
// electron-store при создании читает app.getPath('userData'). Если запустить
// electron.exe напрямую (не packaged), userData = AppData\Roaming\Electron\
// вместо AppData\Roaming\SynteeHelper\. setPath фиксит это, но должен
// выполниться ДО импорта tokenStore/gatewayClient (они создают Store при
// импорте). Поэтому setPath — первое что выполняется в модуле.
app.setName('SynteeHelper')
// SYNTEE_USER_DATA_DIR — изоляция профиля для тестов запусков (QA/CI):
// позволяет поднять второй инстанс с отдельным userData, не конфликтуя
// с singleton-lock и данными живого инстанса юзера.
app.setPath('userData', process.env.SYNTEE_USER_DATA_DIR || join(app.getPath('appData'), 'SynteeHelper'))

// Лимит дискового кэша Chromium (512 МБ, все партишны: приложение +
// встроенный браузер + spa-renderer). Без него кэш растёт по эвристике
// свободного места — партишн браузера уже съел 155 МБ за вечер.
// Свитч должен стоять до app ready.
app.commandLine.appendSwitch('disk-cache-size', String(512 * 1024 * 1024))

import { electronApp, optimizer } from '@electron-toolkit/utils'
import Store from 'electron-store'
import { DEFAULT_SETTINGS, DEFAULT_HOTKEYS } from '../shared/constants'
import { MainWindow } from './windows/MainWindow'
import { OverlayWindow } from './windows/OverlayWindow'
import { VoiceWindow } from './windows/VoiceWindow'
import { SpotlightWindow } from './windows/SpotlightWindow'
import { TrayMenuWindow } from './windows/TrayMenuWindow'
import { NotificationWindow } from './windows/NotificationWindow'
import { initOverlayManager, OverlayManager } from './overlay/OverlayManager'
import { TrayManager } from './tray/TrayManager'
import { HotkeyManager } from './hotkeys/HotkeyManager'
import { registerAllIPC } from './ipc'
import { registerChatIPC, flushAllActiveRuns } from './ipc/chat.ipc'
import { registerOverlayIPC } from './ipc/overlay.ipc'
import { registerVoiceIPC } from './ipc/voice.ipc'
import { registerAgentIPC } from './ipc/agent.ipc'
import { registerDotsIPC } from './ipc/dots.ipc'
import { registerBrowserIPC } from './ipc/browser.ipc'
import { browserManager } from './managers/BrowserManager'
import { log } from '../core/logger'
import { registerMemoryIPC } from './ipc/memory.ipc'
import { registerNotesIPC } from './ipc/notes.ipc'
import { registerProviderIPC } from './ipc/providers.ipc'
import { registerDebugIPC } from './ipc/debug.ipc'
import { registerImageIPC } from './ipc/image.ipc'
import { stopAllWatchers as stopAllFastContextWatchers } from '../core/context/fastContextWatcher'
import { stopSemanticIndexer } from '../core/memory/semanticIndex'
import { registerFsIPC } from './ipc/fs.ipc'
import { registerGitIPC } from './ipc/git.ipc'
import { registerSkillsIPC } from './ipc/skills.ipc'
import { registerMcpIPC } from './ipc/mcp.ipc'
import { registerPluginsIPC } from './ipc/plugins.ipc'
import { registerMarketplaceIPC } from './ipc/marketplace.ipc'
import { registerPtyIPC } from './ipc/pty.ipc'
import { registerFastContextIPC } from './ipc/fastContext.ipc'
import { registerCommandsIPC } from './ipc/commands.ipc'
import { registerMentionsIPC, shutdownMentions } from './ipc/mentions.ipc'
import { registerProtectedVarsIPC } from './ipc/protectedVars.ipc'
import { registerAuthIPC, registerDeepLinks } from './ipc/auth.ipc'
import { registerGatewayIPC } from './ipc/gateway.ipc'
import { registerBillingIPC } from './ipc/billing.ipc'
import { registerStatsIPC } from './ipc/stats.ipc'
import { registerMessengerIPC } from './ipc/messenger.ipc'
import { registerUpdatesIPC } from './ipc/updates.ipc'
import { registerAudioDevicesIPC, stopAudioDevicesIPC } from './ipc/audioDevices.ipc'
import { registerAudioVisualizerIPC, stopAudioVisualizerIPC } from './ipc/audioVisualizer.ipc'
import { registerNotificationIPC } from './ipc/notification.ipc'
import { initNotificationManager } from './managers/NotificationManager'
import { initActivityManager } from './managers/ActivityManager'
import { startUpdatePolling, stopUpdatePolling } from './updater/UpdateChecker'
import { ensureUpdater } from './updater/LauncherBridge'
import { initModelCatalog, refreshCatalog } from '../core/tokens/modelCatalog'
import { initSkillManager } from '../core/skills/skillManager'
import { initCommandManager } from '../core/commands/commandManager'
import { initMcpManager } from '../core/mcp/McpManager'
import { initPluginManager, getPluginManager } from '../core/plugins/pluginManager'
import { migrateGlobalMcpToFile } from '../core/mcp/mcpConfig'
import { ptyManager } from './managers/PtyManager'
import { ipcMain, clipboard, protocol } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'fs'
import { extname } from 'path'

// ── syntee-plugin:// протокол (UI плагинов в sandboxed iframe) ───────────
// Схема ДОЛЖНА быть зарегистрирована как privileged ДО app.ready — иначе
// iframe с sandbox не сможет её грузить. Файлы отдаются ТОЛЬКО из папок
// установленных плагинов (path traversal закрыт), mime по расширению.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'syntee-plugin',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

/** Отдаёт файл плагина по syntee-plugin://{pluginId}/{relPath}.
 *  Валидирует: плагин существует (PluginManager), путь внутри его папки. */
function handlePluginProtocol(request: Request): Response {
  try {
    const url = new URL(request.url)
    const pluginId = url.hostname
    const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(pluginId)) {
      return new Response('Invalid plugin id', { status: 400 })
    }
    const pluginDir = getPluginManager().findPluginDir(pluginId)
    if (!pluginDir) {
      return new Response('Plugin not found', { status: 404 })
    }
    const filePath = join(pluginDir, relPath)
    // Path traversal: путь обязан оставаться ВНУТРИ pluginDir.
    // Префиксной проверки startsWith(pluginDir) недостаточно (...\pluginsX
    // начинается с ...\plugins) — проверяем через relative().
    const relToDir = relative(pluginDir, filePath)
    if (relToDir.startsWith('..') || isAbsolute(relToDir)) {
      return new Response('Forbidden', { status: 403 })
    }
    const st = statSync(filePath)
    if (!st.isFile()) {
      return new Response('Not found', { status: 404 })
    }
    const mime = PLUGIN_UI_MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    // Defense-in-depth: CSP запрещает загрузку УДАЛЁННЫХ скриптов/объектов/
    // вложенных iframe со страниц плагинов (инъекция удалённого кода в UI
    // плагина). Инлайн-скрипты разрешены — HTML плагинов одностраничные.
    // Картинки/медиа с https разрешены (легитимный кейс: иконки из API).
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https: data: blob:",
      "media-src 'self' https: data: blob:",
      "connect-src 'self' https: ws: wss:",
      "font-src 'self' data:",
      "object-src 'none'",
      "frame-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; ')
    return new Response(readFileSync(filePath), {
      headers: { 'Content-Type': mime, 'Content-Security-Policy': csp },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

const PLUGIN_UI_MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

// Single-instance lock — обязателен для deep-link flow (synteehelper://).
// Второй запуск с deep-link URL приходит в событие second-instance.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

// ── Краш-устойчивость main-процесса ────────────────────────────────────────
// Node ≥15 по умолчанию роняет процесс на unhandledRejection. В Electron
// benign-отклонения — норма (IPC, async-инициализация, гонки таймеров):
// молчаливый выход приложения через ~15с после старта без единой строки в
// логах. Логируем громко и живём дальше. uncaughtException уже обрабатывается
// ниже (последняя линия защиты).
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[unhandledRejection]', reason)
    log('[unhandledRejection] %s', reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason))
  } catch { /* noop */ }
  // НЕ вызываем flushAllActiveRuns — см. комментарий у uncaughtException ниже.
})

// Chromium utility/GPU сбои не являются Node exceptions. Пишем отдельно
// по дням в userData: следующий запуск не затирает диагностику сбоя.
app.on('child-process-gone', (_event, details) => {
  const message = `[chromium-process-gone] ${JSON.stringify(details)}`
  console.error(message)
  log(message)
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const date = new Date().toISOString()
    appendFileSync(join(dir, `chromium-${date.slice(0, 10)}.log`), `[${date}] ${message}\n`)
  } catch { /* best-effort диагностика */ }
  // Network Service Chromium перезапускает сам. Не reload здорового UI:
  // это потеряет черновик и не исправит причину падения utility-процесса.
})

// Инициализируем store с дефолтными настройками.
// Явно указываем generic <Record<string, unknown>> — без него TS выводит тип
// из DEFAULT_SETTINGS (конкретная форма объекта), и store перестаёт быть
// совместим с сигнатурами register*IPC(store: Store), которые типизированы
// через `import type Store from 'electron-store'` (дефолтный generic —
// Record<string, unknown>).
const store = new Store<Record<string, unknown>>({ defaults: DEFAULT_SETTINGS, name: 'config', cwd: undefined })

// ── Merge hotkeys: добавляем недостающие ключи из DEFAULT_HOTKEYS ──────
// Для существующих юзеров, у которых hotkeys сохранён до добавления
// chatAskMode/chatPlanningMode — записываем их в config.json, чтобы
// in-app кейбинды работали сразу при старте (без открытия настроек).
// conf делает shallow merge defaults+fileStore, поэтому вложенные ключи
// hotkeys из файла полностью перезаписывают defaults.hotkeys — нужно
// явно merge и записать обратно.
{
  const stored = store.get('hotkeys') as Record<string, string> | undefined
  if (stored && typeof stored === 'object') {
    const merged = { ...DEFAULT_HOTKEYS, ...stored }
    const hasNewKeys = (merged.chatAskMode !== stored.chatAskMode)
      || (merged.chatPlanningMode !== stored.chatPlanningMode)
    if (hasNewKeys) {
      store.set('hotkeys', merged)
    }
  }
}

// Глобальные окна
let mainWindow: MainWindow
let overlayWindow: OverlayWindow
let voiceWindow: VoiceWindow
let spotlightWindow: SpotlightWindow
let trayMenuWindow: TrayMenuWindow
let notificationWindow: NotificationWindow
let overlayManager: OverlayManager
let notificationManager: ReturnType<typeof initNotificationManager>
let activityManager: ReturnType<typeof initActivityManager>
let trayManager: TrayManager
let hotkeyManager: HotkeyManager

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.synteehelper.app')

  // ── syntee-plugin:// — файлы UI плагинов (iframe-панели) ──
  protocol.handle('syntee-plugin', handlePluginProtocol)

  // Захват системного звука для визуализатора — WASAPI loopback с выбранного
  // устройства через vendored NativeAudioSDK (audioVisualizer.ipc.ts).
  // Прежний Chromium getDisplayMedia-loopback убран: он умел только устройство
  // по умолчанию, из-за чего «выбор устройства» приходилось делать сменой
  // системного дефолта.

  // Microphone permission supports the existing voice input.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const name = permission as string
    if (name === 'media' || name === 'audioCapture' || name === 'display-capture') callback(true)
    else callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => true)

  // Оптимизация dev tools
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Создаём окна (конструкторы — без загрузки контента)
  mainWindow = new MainWindow(store)
  overlayWindow = new OverlayWindow()
  voiceWindow = new VoiceWindow()
  spotlightWindow = new SpotlightWindow()
  trayMenuWindow = new TrayMenuWindow()
  notificationWindow = new NotificationWindow()

  // ── OverlayManager — единая точка управления overlay-поверхностями ──
  // Владеет hub-окном (NotificationWindow: уведомления + activity) и plugin
  // overlay окнами; координирует скрытие всех overlay-окон (hideAll).
  // Мышь: hit-testing в renderer hub-окна → overlay:setInteractive (без
  // polling-а курсора в main процессе).
  overlayManager = initOverlayManager(notificationWindow)
  // Внешние overlay-окна — участвуют в координированном скрытии (hideAll)
  overlayManager.registerExternal('spotlight', { hide: () => spotlightWindow.hide() })
  overlayManager.registerExternal('tray-menu', { hide: () => trayMenuWindow.hide() })
  overlayManager.registerExternal('capture', { hide: () => overlayWindow.hide() })

  // ── Менеджеры ( ДО окон) ──────────────────────────────────────────
  // IPC-хендлеры используют эти менеджеры, поэтому инициализируем их
  // ДО регистрации IPC и ДО загрузки URL в окна (рендереры сразу стреляют
  // IPC-вызовами при монтировании — хендлеры должны быть готовы).

  // Каталог моделей (models.dev) — из диск-кэша синхронно.
  const catalogCachePath = join(app.getPath('userData'), 'modelsCatalog.json')
  initModelCatalog(catalogCachePath)
  refreshCatalog(catalogCachePath).catch(() => { /* ok — работаем на кэше/fallback */ })
  setInterval(() => { refreshCatalog(catalogCachePath).catch(() => {}) }, 86_400_000)

  // Skills-менеджер (загрузка .md-скиллов, состояние вкл/выкл, scope).
  initSkillManager(store)

  // Commands-менеджер (загрузка .md-кастомных slash-команд).
  initCommandManager()

  // Миграция: переносим старые глобальные MCP из electron-store в файл
  // ~/.syntee/mcp.json (чтобы агент мог редактировать их через edit_file).
  migrateGlobalMcpToFile(store)

  // MCP-менеджер (подключение серверов, тулы, approval). setWindow — ниже,
  // после создания BrowserWindow.
  const mcpManager = initMcpManager(store)

  // Plugins-менеджер (локальные расширения: тулы + логика в utilityProcess).
  const pluginManager = initPluginManager(store)
  // Пункты трея от плагинов изменились → пушим в живое окно трей-меню.
  pluginManager.onTrayItemsChanged = () => trayMenuWindow.pushPluginItems()
  // Plugin overlay: window-менеджмент делегирован OverlayManager
  // (валидация entry/pluginDir остаётся в pluginManager).
  pluginManager.overlayDelegate = {
    show: (p) => overlayManager.showPluginOverlay(p),
    hide: () => overlayManager.hidePluginOverlay(),
  }

  // ── IPC (ДО загрузки URL в окна) ──────────────────────────────────
  // Регистрируем ВСЕ хендлеры до .create(), чтобы рендереры при монтировании
  // находили готовые хендлеры (убирает flood "No handler registered").

  // Горячие клавиши — создаём ДО registerAllIPC, чтобы IPC-хендлер
  // settings:set мог вызвать hotkeyManager.reload() при смене биндингов.
  // Окна уже созданы выше, callbacks безопасно ссылаются на них.
  hotkeyManager = new HotkeyManager(store, {
    toggleMain: () => mainWindow.toggle(),
    showOverlay: () => overlayWindow.show(),
    toggleVoice: () => voiceWindow.toggle(),
    toggleSpotlight: () => spotlightWindow.toggle(),
    quickQuestion: () => spotlightWindow.showQuick(),
  })
  hotkeyManager.registerAll()

  registerAllIPC({ store, mainWindow, overlayWindow, voiceWindow, spotlightWindow, trayMenuWindow, hotkeyManager })
  registerChatIPC(store, mainWindow)
  registerOverlayIPC(store, overlayWindow)
  registerVoiceIPC(store, () => mainWindow.getWindow())
  // Whisper worker создаётся лениво при первом voice:transcribe —
  // не держим ~40-80MB ONNX-модели в памяти с момента старта.
  registerAgentIPC(store, () => mainWindow.getWindow())
  // Dots (always-on агенты): ПОСЛЕ registerChatIPC — DotManager будит Dot'ов
  // через programmatic chat:send (chatSendImpl установлен в registerChatIPC).
  registerDotsIPC(store, () => mainWindow.getWindow())
  // Встроенный браузер (правая панель, webview): регистрация табов +
  // browserMode чата + расширения. BrowserManager — ленивый геттер окна:
  // окно создаётся ниже (mainWindow.create()), eager-значение здесь было бы
  // null навсегда → pushTabState no-op → белый экран браузера.
  registerBrowserIPC(store, () => mainWindow.getWindow())
  browserManager.setWindowGetter(() => mainWindow.getWindow())
  // Расширения браузера: автозагрузка установленных при старте.
  import('./browser/extensions')
    .then(({ loadExtensionsOnBoot }) => loadExtensionsOnBoot(store))
    .catch(err => console.warn('[browser:ext] boot load failed:', err))
  registerMemoryIPC(store)
  registerNotesIPC(() => mainWindow.getWindow())
  registerProviderIPC(store)
  registerDebugIPC(store)
  registerImageIPC(store, mainWindow)
  registerFsIPC()
  registerGitIPC()
  registerSkillsIPC(store)
  registerMcpIPC(store, () => mainWindow.getWindow())
  registerPluginsIPC(store, () => mainWindow.getWindow())
  registerMarketplaceIPC(store)
  registerPtyIPC(mainWindow)
  registerFastContextIPC(store, () => mainWindow.getWindow())
  registerCommandsIPC()
  registerMentionsIPC()
  // Защищённые переменные (секреты юзера → system prompt)
  registerProtectedVarsIPC()

  // Syntee-Gateway auth + profile + deep-link (synteehelper://)
  registerDeepLinks(() => mainWindow.getWindow())
  registerAuthIPC(() => mainWindow.getWindow())
  // Syntee-Gateway models & status (фаза 2)
  registerGatewayIPC()
  // Syntee-Gateway биллинг (фаза 3)
  registerBillingIPC()
  // Локальная статистика использования (Настройки → Статистика)
  registerStatsIPC()
  // Syntee-Gateway мессенджер: друзья + ЛС (фаза 1)
  registerMessengerIPC(() => mainWindow.getWindow())
  // In-app update checker (informational; the Go launcher does the actual apply)
  registerUpdatesIPC(() => mainWindow.getWindow())
  registerAudioDevicesIPC(mainWindow)
  registerAudioVisualizerIPC(mainWindow)
  startUpdatePolling()

  // ── Notification overlay ──────────────────────────────────────────
  // NotificationManager решает показывать ли уведомление (по состоянию окна
  // и настройкам), затем отправляет в overlay-хаб через OverlayManager.
  notificationManager = initNotificationManager(store, mainWindow, overlayManager)
  registerNotificationIPC(overlayManager, mainWindow, (payload) => {
    notificationManager.handleAction(payload)
  })

  // ── Activity overlay (информер активности ИИ) ──────────────────────
  // ActivityManager решает показывать ли activity-виджет в overlay-хабе
  // (по настройке activityMonitor.enabled + состоянию окна).
  activityManager = initActivityManager(store, mainWindow, overlayManager)

  // Лёгкий обработчик оценки токенов текущего ввода (для live-обновления кольца при печати)
  ipcMain.handle('context:estimateInput', (_e, params: { text: string }) => {
    try {
      // estimateTokens импортируется лениково, чтобы не тащить tiktoken в main-бандл раньше времени
      const { estimateTokens } = require('../core/tokens/usageTracker') as typeof import('../core/tokens/usageTracker')
      return { tokens: estimateTokens(params.text || '') }
    } catch {
      return { tokens: 0 }
    }
  })

  // ── Clipboard: нативный буфер обмена через Electron (работает на file://) ──
  // navigator.clipboard.writeText падает в production (file:// — не secure
  // context), поэтому копирование идёт через IPC → electron.clipboard.
  ipcMain.handle('clipboard:writeText', (_e, text: string) => {
    try {
      clipboard.writeText(String(text ?? ''))
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('clipboard:readText', () => {
    try {
      return clipboard.readText()
    } catch {
      return ''
    }
  })


  // ── Загрузка контента в окна (теперь IPC-хендлеры готовы) ──────────
  // Только главное окно создаётся при старте. Вспомогательные окна
  // (overlay/voice/spotlight/trayMenu) создаются лениво при первом
  // show() — это экономит ~4 renderer-процесса и сотни МБ RAM в фоне.
  const main = mainWindow.create()
  // Подписываемся сразу, ДО warmup/first-run await: ready-to-show одноразовый
  // и мог пройти, пока мы инициализировали фоновые сервисы.
  main.once('ready-to-show', () => {
    main.show()
    const devtools = process.env.NODE_ENV === 'development'
      || process.env.ELECTRON_ENABLE_DEVTOOLS === '1'
      || process.argv.includes('--devtools')
    if (devtools) main.webContents.openDevTools({ mode: 'detach' })
  })

  // Прикрепляем listeners на главное окно (теперь оно создано).
  notificationManager.attachWindowListeners()
  activityManager.attachWindowListeners()

  // MCP: фиксируем sender + прогреваем глобальные серверы (нужно окно).
  mcpManager.setWindow(mainWindow.getWindow())
  mcpManager.warmupGlobalServers()

  // Plugins: фиксируем окно (push-события) + автозапуск включённых
  // глобальных плагинов в фоне (не блокируем старт приложения).
  pluginManager.setWindow(mainWindow.getWindow())
  pluginManager.scan()
  // Плагинам: событие 'app:focus' при фокусе главного окна.
  mainWindow.getWindow()?.on('focus', () => pluginManager.emitAppFocus())
  for (const p of pluginManager.getAllWithState({})) {
    if (p.state.enabled && p.source === 'global') {
      pluginManager.start(p.id).catch(e => {
        console.warn(`[plugins] autostart failed: ${p.id}:`, (e as Error).message)
      })
    }
  }

  // Предзагрузка контента трей-меню (после IPC + создания окна).
  trayMenuWindow.warmup()
  // Pre-warm notification overlay — создаёт скрытое окно и грузит контент
  // в фоне. НЕ лагает курсор: create() ставит setIgnoreMouseEvents(true) без
  // forward:true (forward включается только в show() когда есть уведомление).
  // Без warmup первое уведомление пропускается (пока окно грузится — loading screen).
  overlayManager.warmupHub()

  // Трей
  trayManager = new TrayManager({
    showMain: () => mainWindow.show(),
    showSpotlight: () => spotlightWindow.show(),
    showVoice: () => voiceWindow.show(),
    quit: () => app.quit(),
  }, trayMenuWindow)
  trayManager.init()

  // Ensure updater.exe exists next to the client; download from website if missing.
  ensureUpdater().catch((e) => console.error('[updater] ensureUpdater failed:', e))

  // PTY-менеджер: фиксируем sender для стриминга данных в renderer.
  ptyManager.setSender(mainWindow.getWindow())

  // Первый запуск
  if (!store.get('firstRunComplete')) {
    await onFirstRun()
  }

  // Показ окна подписан сразу после create(), выше.
})

async function onFirstRun(): Promise<void> {
  // require вместо await import: нативный import() не работает в V8-байткоде
  // (join уже импортирован наверху файла)
  const { mkdirSync } = require('fs')
  const userData = app.getPath('userData')

  // Создаём нужные папки но НЕ ставим firstRunComplete —
  // это делает renderer после завершения онбординга
  const dirs = [
    join(userData, 'generated'),
    join(userData, 'recordings'),
    join(userData, 'backups'),
    join(userData, 'voices'),
    join(userData, 'screenshots'),
    join(userData, 'logs'),
    join(userData, 'sounds'),
  ]
  dirs.forEach(d => mkdirSync(d, { recursive: true }))
}

// Не закрывать при закрытии всех окон — живём в трее.
// window-all-closed не передаёт Event и не имеет preventDefault (в отличие
// от will-quit) — просто подписка на событие уже отключает Electron'овское
// поведение "quit по умолчанию", вызывать preventDefault не нужно и раньше
// это было опечаткой, из-за которой tsc не мог сматчить сигнатуру listener'а.
app.on('window-all-closed', () => {})

// Реальный выход (а не скрытие в трей) — сохраняем размер/позицию главного окна.
// 'close' на окне перехватывается для hide(), поэтому persistim здесь.
// ── Последняя линия защиты: uncaughtException ──
// При soft-crash (uncaught exception) даём последний шанс сохранить
// накопленный стриминг в БД. ВАЖНО: НЕ вызываем flushAllActiveRuns() при
// unhandledRejection — в Electron часто бывают benign unhandled rejections
// (IPC, async-операции), и flushAllActiveRuns вызовет sendDone с частичным
// bufferedText → doneSent=true → финальный 'done' от воркера станет no-op
// → потеря половины ответа при нормальной работе.
// uncaughtException — более серьёзный сигнал, но тоже не гарантия краша.
// Если процесс выживет после uncaughtException, sendDone с частичным
// контентом перезапишет полный — но checkpoint-таймер (каждые 3с) уже
// сохранил прогресс в БД, так что даже в этом случае данные не теряются.
process.on('uncaughtException', (err) => {
  try { console.error('[uncaughtException]', err) } catch { /* noop */ }
  // НЕ вызываем flushAllActiveRuns — может перезаписать полный ответ
  // частичным при benign exceptions. Checkpoint-таймер уже сохранил
  // прогресс в БД каждые 3с. before-quit/will-quit — окончательный флеш.
})

app.on('before-quit', () => {
  // Флешим все активные стримящиеся ответы в БД — ПЕРВЫМ, до любых cleanup,
  // чтобы частичный ответ ассистента не потерялся при резком выходе.
  try { flushAllActiveRuns() } catch { /* ok — best-effort */ }
  mainWindow?.flushBounds()
  ptyManager.killAll()
  // Останавливаем опрос обновлений.
  stopUpdatePolling()
  stopAudioDevicesIPC()
  stopAudioVisualizerIPC()
  // Останавливаем все fast context watchers (chokidar) — иначе process может зависеть.
  stopAllFastContextWatchers().catch(() => { /* watchers опциональны */ })
  // Останавливаем фоновую semantic E5-индексацию (semantic_embeddings):
  // снимаем таймеры, останавливаем текущий цикл, освобождаем ONNX pipeline.
  try { stopSemanticIndexer() } catch { /* ok — best-effort */ }
  // Останавливаем file indexer для @mention-пикера.
  shutdownMentions().catch(() => { /* indexer опционален */ })
  // Уничтожаем пул SPA-renderer BrowserWindow — чтобы не было утечки.
  import('./tools/spaRenderer')
    .then(({ destroySpaPool }) => destroySpaPool())
    .catch(() => { /* spaRenderer опционален */ })
})

app.on('will-quit', () => {
  // Подстраховка: если before-quit не отработал — повторный флеш.
  // saveMessage UPSERT (INSERT OR REPLACE) — идемпотентен, безопасен.
  try { flushAllActiveRuns() } catch { /* ok — best-effort */ }
  hotkeyManager?.unregisterAll()
  // Плагины: graceful stop процессов + флеш KV-хранилищ.
  try { getPluginManager().shutdownAll() } catch { /* ok — best-effort */ }
})

app.on('activate', () => {
  mainWindow?.show()
})
