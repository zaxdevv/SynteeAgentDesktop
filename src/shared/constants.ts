export const APP_NAME = 'Syntee Helper'
// Version is injected at build time by Vite define from package.json.
// Fallback '0.1.0' for non-Vite contexts (raw tsc, tests).
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0'

/** Подпись клиента для всех исходящих AI API-запросов (аналог Claude Code). */
export const CLIENT_USER_AGENT = `syntee-agent/${APP_VERSION}`

/**
 * Идентификационные заголовки клиента. Добавляются во все исходящие
 * запросы к AI-провайдерам (OpenAI, Anthropic, OpenRouter и т.д.) и
 * к Syntee-Gateway. Провайдеры и прокси/статистика могут использовать
 * их для определения источника запроса.
 */
export const CLIENT_IDENTITY_HEADERS: Record<string, string> = {
  'User-Agent': CLIENT_USER_AGENT,
  'X-Client-Name': 'syntee-agent',
  'X-Client-Version': APP_VERSION,
}

/**
 * Возвращает заголовки идентификации клиента для AI-запросов.
 * anonymous=true → пустой объект (SDK подставит свой стандартный User-Agent,
 * как у обычной openai-либы). anonymous=false → кастомные Syntee-заголовки.
 */
export function getIdentityHeaders(anonymous: boolean): Record<string, string> {
  return anonymous ? {} : CLIENT_IDENTITY_HEADERS
}

// ── OpenCode Zen: opencode-cli-совместимые заголовки ──
//
// Бэкенд Zen проверяет заголовки x-opencode-* для идентификации «официального»
// клиента. Без них запрос считается анонимным и получает жёсткие rate-лимиты
// (429 FreeUsageLimitError) — см. earendil-works/pi#2824. Официальный CLI шлёт:
//   x-opencode-client: "cli"
//   x-opencode-session: <random-id>   (стабилен в рамках сессии)
//   x-opencode-project: <random-id>   (стабилен в рамках проекта)
//   x-opencode-request: <random-id>   (уникален на каждый запрос)
//   User-Agent: "opencode/local ai-sdk/provider-utils/4.0.23 runtime/node.js/24"
// (UA снят с реального opencode CLI, работает 08.2026)

/** id провайдеров OpenCode Zen, которым нужны cli-заголовки. */
export const OPENCODE_PROVIDER_IDS = ['opencode-free', 'opencode', 'opencode-go']

export function isOpencodeProvider(providerId?: string, providerType?: string): boolean {
  return [providerId, providerType].some((v) => !!v && OPENCODE_PROVIDER_IDS.includes(v))
}

/** nanoid-подобный id (21 символ, a-z0-9) — как у реального opencode CLI. */
function randomZenId(): string {
  let id = ''
  for (let i = 0; i < 21; i++) id += Math.floor(Math.random() * 36).toString(36)
  return id
}

// Стабильные на весь запуск приложения id сессии и проекта (как у CLI),
// request-id генерируется на каждый вызов.
let zenSessionId: string | null = null
let zenProjectId: string | null = null

/**
 * Заголовки, имитирующие официальный opencode CLI для Zen-провайдеров.
 * x-opencode-request уникален на каждый вызов — генерируйте на каждый запрос.
 */
export function getOpencodeZenHeaders(): Record<string, string> {
  zenSessionId ??= randomZenId()
  zenProjectId ??= randomZenId()
  return {
    'x-opencode-client': 'cli',
    'x-opencode-session': zenSessionId,
    'x-opencode-project': zenProjectId,
    'x-opencode-request': randomZenId(),
    'User-Agent': 'opencode/local ai-sdk/provider-utils/4.0.23 runtime/node.js/24',
  }
}

/** Путь к файлу глобальных MCP-серверов (относительно home). */
export const GLOBAL_MCP_FILE = '.syntee/mcp.json'

export const DEFAULT_HOTKEYS = {
  mainWindow: 'CommandOrControl+Shift+Space',
  overlay: 'CommandOrControl+Shift+S',
  voice: 'CommandOrControl+Shift+V',
  // Alt+Space вместо CommandOrControl+Space — не конфликтует с IME-переключением
  // и частыми биндами в играх/редакторах.
  spotlight: 'Alt+Space',
  quickQuestion: 'Alt+Q',
  // ── In-app хоткеи (не глобальные, работают только внутри приложения) ──
  // Обрабатываются через keydown listener в ChatPage, не через globalShortcut.
  // Хранятся в settings.hotkeys для настраиваемости.
  // Ctrl+1/Ctrl+2 — когда правая панель закрыта (когда открыта — Ctrl+1..6 = табы).
  chatAskMode: 'Ctrl+1',
  chatPlanningMode: 'Ctrl+2',
}

export const DEFAULT_SETTINGS = {
  theme: 'dark' as const,
  accentColor: '#ffffff',
  language: 'ru',
  fontFamily: 'Inter',
  fontMono: 'JetBrains Mono',
  customFonts: [] as { id: string; name: string }[],
  fontSize: 'medium',
  animatedBackground: true,
  animatedBgOpacity: 60,
  animatedBgSpeed: 1,
  sounds: true,
  soundVolume: 70,
  soundAssignments: {} as Record<string, string | null>,
  bgImageEnabled: true,
  autostart: false,
  onboardingCompleted: false,
  // Гостевой режим: true если юзер нажал «Продолжить как гость» на экране
  // входа. Проверяется первым при старте (App.tsx) — если true, gateway не
  // дёргается и экран входа не показывается. Сбрасывается в false при явном
  // входе в аккаунт.
  loginSkipped: false,
  userName: '',
  // Глобальные apiKey/apiEndpoint больше не используются для OnlySQ —
  // модели идут через мульти-провайдерную систему (providers + assignments).
  // Поле оставлено для обратной совместимости со старым кодом AIClient.
  apiKey: '',
  apiEndpoint: '',
  mainModel: 'claude-sonnet-4-6',
  fastModel: 'claude-haiku-4-5',
  visionModel: 'gemini-3.5-flash',
  sttModel: 'gemini-3-flash',
  ttsModel: 'gemini-3-flash',
  embeddingModel: 'gemini-embedding-2',
  memoryModel: 'claude-haiku-4-5',
  imageModel: 'imagen-3-flash',
  watcherModel: 'gemini-3-flash',
  summaryModel: 'gpt-5.2',
  routerModel: 'nano-banana',
  emotionModel: 'gpt-5-mini',
  voiceId: 'alloy',
  wakeWord: 'синти',
  // ─── Голосовой ввод (STT) в инпут-баре ──
  // sttProvider: 'local' — локальный Whisper через @huggingface/transformers
  //   (оффлайн, без лимитов/ключей), 'groq' — Groq Whisper API (нужен groqApiKey).
  sttProvider: 'local' as 'local' | 'groq',
  // Размер модели локального Whisper: 'tiny' (~40MB, DEFAULT — быстро,
  // экономно, достаточно для коротких запросов) или 'base' (~140MB, точнее
  // на русском но тяжелее). small убрана — слишком тяжёлая для desktop.
  sttModelSize: 'tiny' as 'tiny' | 'base',
  // API key для Groq fallback (https://console.groq.com/keys).
  groqApiKey: '',
  themeSchedule: { enabled: false, lightFrom: '08:00', darkFrom: '20:00' },
  agentPermissions: {
    confirmDangerous: true,
    dryRunMode: false,
    forbiddenPaths: ['C:\\Windows', 'C:\\Program Files\\SynteeHelper'],
    // Гранулярные настройки авто-режима (см. AutoModeSettings в types/provider).
    // confirmDangerous — legacy-поле, мигрируется в autoMode.askOnDangerous
    // через resolveAutoModeSettings() при чтении.
    autoMode: {
      askOnDangerous: true,
      askOnWarn: false,
      askGitPush: true,
      networkPolicy: 'smart',
      askOutsideWorkdir: true,
    },
  },
  // Per-project переопределение разрешений: { [projectId]: ProjectPermissionOverride }
  projectPermissions: {} as Record<string, import('./types').ProjectPermissionOverride>,
  backupEnabled: true,
  memoryEnabled: true,
  globalMemoryEnabled: true,
  projectMemoryEnabled: true,
  chatMemoryEnabled: true,
  autoMemoryEnabled: true,
  backupPath: '',
  agentPanelWidth: 420,
  agentPanelOpen: false,
  hotkeys: DEFAULT_HOTKEYS,
  integrations: {
    telegram: { token: '', chatId: '' },
    discord: { token: '', guildId: '' },
    github: { token: '' },
    spotify: { clientId: '', clientSecret: '' },
    tavily: { key: '' },
    brave: { key: '' },
  },
  // ─── MCP (Model Context Protocol) ──
  // Глобальные серверы хранятся в файле ~/.syntee/mcp.json (редактируется
  // агентом через edit_file). Здесь — только runtime-состояние:
  // { [serverName]: { enabled, scope, toolStates } }
  mcpGlobalState: {} as Record<string, {
    enabled: boolean
    scope: import('./types').ExtensionScope
    toolStates: Record<string, import('./types').McpToolState>
  }>,
  // Per-tool/per-scope состояние проектных серверов: { [projectId]: { [serverName]: { toolStates, scope, enabled } } }
  mcpProjectState: {} as Record<string, {
    toolStates: Record<string, import('./types').McpToolState>
    scope: import('./types').ExtensionScope
    enabled: boolean
  }>,
  // ─── Skills ──
  // Per-skill состояние по id скилла. Само тело скилла читается из .md-файла.
  skillsState: {} as Record<string, import('./types').SkillState>,
  // ─── Уведомления (overlay) ──
  // Глобальный вкл/выкл + per-type конфиг: enabled + showWhen
  // showWhen: 'inactive' — только когда главное окно свёрнуто/неактивно,
  //          'always' — показывать всегда (даже поверх активного окна),
  //          'minimized' — только когда окно явно свёрнуто.
  notifications: {
    enabled: true,
    types: {
      ai_response: { enabled: true, showWhen: 'inactive' as const },
      agent_done: { enabled: true, showWhen: 'inactive' as const },
      permission: { enabled: true, showWhen: 'always' as const },
      messenger: { enabled: true, showWhen: 'always' as const },
      updates: { enabled: true, showWhen: 'always' as const },
      system: { enabled: true, showWhen: 'inactive' as const },
      ask_user: { enabled: true, showWhen: 'always' as const },
    },
  },
}

export const WINDOW_SIZES = {
  main: { width: 1200, height: 800 },
  spotlight: { width: 600, height: 80 },
  spotlightExpanded: { width: 600, height: 500 },
  voice: { width: 300, height: 300 },
  overlayChat: { width: 400, height: 600 },
  // Кастомное трей-меню (frameless glass-окно у иконки трея).
  // width — ширина карточки; height — базовая (свернутый «О программе»).
  // С раскрытым блоком about высота растёт, окно пересоздаёт размер через
  // setContentSize. Позиция считается динамически от tray.getBounds().
  trayMenu: { width: 268, height: 392 },
  trayMenuExpanded: { width: 268, height: 472 },
}

export const IPC_EVENTS = {
  CHAT_STREAM_TOKEN: 'chat:stream:token',
  CHAT_STREAM_DONE: 'chat:stream:done',
  CHAT_STREAM_ERROR: 'chat:stream:error',
  CHAT_RUN_STATUS: 'chat:run:status',
  TASK_SUMMARY_CHANGED: 'task-summary:changed',
  CHAT_QUEUE_UPDATED: 'chat:queue:updated',
  CHAT_CHECKPOINT_CREATED: 'chat:checkpoint:created',
  CHAT_REWOUND: 'chat:rewound',
  CHAT_FILES_RESTORED: 'chat:files:restored',
  CHAT_COMPACTED: 'chat:compacted',
  CHAT_COMPACT_STREAM: 'chat:compact-stream',
  CONTEXT_USAGE: 'context:usage',
  MEMORY_MEMORIZED: 'memory:memorized',
  AGENT_ACTION: 'agent:action',
  AGENT_PERMISSION_REQUEST: 'agent:permission:request',
  SYSTEM_STATS: 'system:stats',
  RATE_LIMIT: 'ai:rate_limit',
  VOICE_STATE: 'voice:state',
  WATCHER_NOTIFICATION: 'watcher:notification',
  SCHEDULER_TASK_DONE: 'scheduler:task_done',
  TRAY_ANIMATE: 'tray:animate',
  // MCP push-events: статус подключения сервера, обновление списка тулов,
  // и поток журнала подключения (для лог-вьюера в UI).
  MCP_STATUS: 'mcp:status',
  MCP_TOOLS_UPDATED: 'mcp:tools:updated',
  MCP_LOGS: 'mcp:logs',
  // Список серверов изменился (новые/удалённые в .mcp.json) — renderer
  // должен перезагрузить mcpServers и activeMcpServerIds для бейджа.
  MCP_SERVERS_CHANGED: 'mcp:servers-changed',
  // Fast Context: live progress при реиндексе + уведомление об обновлении индекса
  FASTCONTEXT_PROGRESS: 'fastcontext:progress',
  FASTCONTEXT_UPDATED: 'fastcontext:updated',
  // Skills: пуш при изменении .syntee/skills/ (watcher обнаружил новые/удалённые .md)
  SKILLS_UPDATED: 'skills:updated',
  // Plugins: список/статус/тулы плагинов изменились — renderer перезагружает
  // список целиком (он небольшой). PLUGINS_LOGS — стрим журнала плагина.
  // PLUGINS_UI_MESSAGE — сообщение плагина в его iframe-панель.
  PLUGINS_CHANGED: 'plugins:changed',
  PLUGINS_LOGS: 'plugins:logs',
  PLUGINS_UI_MESSAGE: 'plugins:ui-message',
  // Плагин просит открыть/закрыть свою панель (right-таб или modal):
  // { pluginId, action: 'open'|'close', panelId }
  PLUGINS_PANEL_ACTION: 'plugins:panel-action',
  // Бейдж на табе панели плагина: { pluginId, panelId, badge: number|null }
  PLUGINS_BADGE: 'plugins:badge',
  // Тост от плагина: { text, kind: 'info'|'success'|'error' }
  PLUGINS_TOAST: 'plugins:toast',
  // Действие плагина в чате: { action: 'send'|'reply', text }.
  // 'send' — отправить сообщение от пользователя (запускает агент),
  // 'reply' — вставить ответ от имени плагина.
  PLUGINS_CHAT_ACTION: 'plugins:chat-action',
  // Стриминг ответа плагина (chat.beginReply/appendChunk/endReply):
  // { action: 'begin'|'chunk'|'end', chatId, messageId, content } —
  // content всегда ПОЛНЫЙ текст сообщения (не дельта).
  PLUGINS_REPLY_CHUNK: 'plugins:reply-chunk',
  // Live-карточка прогресса тула плагина (ui.beginProgress):
  // { pluginId, progressId, action: 'begin'|'update'|'finish', label }.
  PLUGINS_TOOL_PROGRESS: 'plugins:tool-progress',
  // Плагин просит проиграть звук приложения: { soundId } (renderer → Web Audio).
  PLUGINS_PLAY_SOUND: 'plugins:play-sound',
  // Элементы status bar от плагина (снапшот): { pluginId, items: PluginStatusbarItem[] }.
  // Пустой items = плагин убрал все свои элементы.
  PLUGINS_STATUSBAR: 'plugins:statusbar',
  // Плагин просит открыть/закрыть модальную iframe-панель:
  // { pluginId, action: 'open'|'close', entry?, title?, width?, height? }
  PLUGINS_MODAL_ACTION: 'plugins:modal-action',
  // Chat overlay: iframe-оверлей плагина ПОВЕРХ области чата в главном окне:
  // { pluginId, action: 'show'|'hide', entry?, title?, width?, height?, position? }
  PLUGINS_CHAT_OVERLAY: 'plugins:chat-overlay',
  // ── Notification overlay ──
  // main → renderer: отправить данные уведомления в overlay-окно
  NOTIFICATION_PUSH: 'notification:push',
  // renderer → main: пользователь кликнул action на уведомлении
  NOTIFICATION_ACTION: 'notification:action',
  // ── Dots (always-on фоновые агенты) ──
  // main → renderer: список/конфиги Dot'ов изменились (CRUD) — перезагрузить
  DOTS_CHANGED: 'dots:changed',
  // main → renderer: живое состояние Dot'ов (статус/lastRun/nextRun)
  DOTS_STATE: 'dots:state',
  // main → renderer: ран Dot'а завершился ({chatId, dotId, status}) —
  // DotChat перезагружает ленту (silent удалил сообщения, report добавил)
  DOTS_RUN_FINISHED: 'dots:run-finished',
  // main → renderer: Dot проснулся — wake-ран стартовал ({dotId, name, trigger}).
  // App.tsx показывает тост (кроме manual — там фидбек даёт сама кнопка).
  DOTS_WAKE: 'dots:wake',
  // ── Browser (встроенный браузер в правой панели) ──
  // main → renderer: состояние табов браузера изменилось (URL/title/loading/
  // favicon активного таба) — BrowserPanel обновляет UI.
  BROWSER_TAB_STATE: 'browser:tab-state',
  // main → renderer: AI вызвал request_access — показать диалог подтверждения
  // включения управления браузером ({chatId, reason}).
  BROWSER_REQUEST_ACCESS: 'browser:request-access',
  // renderer → main: ответ пользователя на диалог request_access
  // ({chatId, approved}).
  BROWSER_REQUEST_ACCESS_REPLY: 'browser:request-access-reply',
  // main → renderer: browserMode чата переключён (тумблером или через
  // подтверждение AI) — ChatPage синхронизирует чип/тумблер ({chatId, enabled}).
  BROWSER_MODE_CHANGED: 'browser:mode-changed',
}

// ── Browser: partition webview-сессии ─────────────────────────────────────
/** Персистентная сессия встроенного браузера (partition webview). Отдельная
 *  от сессии приложения: свои куки/логины/расширения, переживает рестарт.
 *  Расширения (electron-chrome-extensions) грузятся именно в неё. */
export const BROWSER_PARTITION = 'persist:syntee-browser'
/** Старый partition дефолтного профиля. Новые профили получают отдельные сессии. */
export const DEFAULT_BROWSER_PROFILE_ID = 'default'

// ── Plugins: iframe-мост ─────────────────────────────────────────────────
/** Прямые host-методы, доступные iframe-панелям плагинов через
 *  synteeBridge.call БЕЗ хопа через ui.handle процесса плагина.
 *  ЕДИНЫЙ источник истины для main (plugins:iframeCall — валидация)
 *  и renderer (PluginIframe — роутинг iframeCall vs uiCall).
 *  Права проверяются в main по манифесту (METHOD_PERMS в plugins.ipc.ts). */
export const IFRAME_HOST_METHODS: readonly string[] = [
  'fs.readFile', 'fs.listDir', 'fs.stat',
  'config.get', 'config.getAll',
  'ui.getTheme',
  'clipboard.readText', 'clipboard.writeText',
  'storage.get', 'storage.set', 'storage.delete',
  'chats.list', 'chats.get',
  'projects.list', 'projects.current',
  'memory.search',
  'ai.listModels',
]
