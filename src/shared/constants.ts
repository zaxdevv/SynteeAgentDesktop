export const APP_NAME = 'Syntee Helper'
export const APP_VERSION = '0.1.0'

/** Путь к файлу глобальных MCP-серверов (относительно home). */
export const GLOBAL_MCP_FILE = '.syntee/mcp.json'

export const DEFAULT_HOTKEYS = {
  mainWindow: 'CommandOrControl+Shift+Space',
  overlay: 'CommandOrControl+Shift+S',
  voice: 'CommandOrControl+Shift+V',
  spotlight: 'CommandOrControl+Space',
  quickQuestion: 'Alt+Q',
  readAloud: 'Alt+R',
  translate: 'Alt+T',
  screenshot: 'Alt+S',
}

export const DEFAULT_SETTINGS = {
  theme: 'dark' as const,
  accentColor: '#ffffff',
  language: 'ru',
  fontFamily: 'Inter',
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
  themeSchedule: { enabled: false, lightFrom: '08:00', darkFrom: '20:00' },
  agentPermissions: {
    confirmDangerous: true,
    dryRunMode: false,
    forbiddenPaths: ['C:\\Windows', 'C:\\Program Files\\SynteeHelper'],
  },
  backupEnabled: true,
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
}

export const WINDOW_SIZES = {
  main: { width: 1200, height: 800 },
  spotlight: { width: 600, height: 80 },
  spotlightExpanded: { width: 600, height: 420 },
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
  CHAT_QUEUE_UPDATED: 'chat:queue:updated',
  CHAT_CHECKPOINT_CREATED: 'chat:checkpoint:created',
  CHAT_REWOUND: 'chat:rewound',
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
  // Fast Context: live progress при реиндексе + уведомление об обновлении индекса
  FASTCONTEXT_PROGRESS: 'fastcontext:progress',
  FASTCONTEXT_UPDATED: 'fastcontext:updated',
}
