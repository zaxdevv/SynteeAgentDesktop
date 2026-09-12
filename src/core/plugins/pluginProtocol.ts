/**
 * Протокол сообщений между PluginManager (main) и процессом плагина
 * (utilityProcess). Файл импортируется ОБЕИМИ сторонами — поэтому здесь
 * только типы и константы, без electron/node-зависимостей.
 *
 * Схема: main → plugin — команды (с requestId для RPC-ответов),
 * plugin → main — события и ответы.
 */

/** main → plugin: инициализация (после spawn). Несёт конфиг плагина. */
export interface PluginMsgInit {
  type: 'init'
  requestId: string
  /** Абсолютный путь до папки плагина (для чтения своих ресурсов). */
  pluginDir: string
  /** Права из манифеста (host уже отфильтровал по подтверждению). */
  permissions: string[]
  /** Глобальные настройки приложения, полезные плагину. */
  env: {
    platform: string
    appVersion: string
    locale: string
  }
  /** Для runtime:'python' — интерпретатор и папка SDK (PYTHONPATH),
   *  уже отрезолвленные main-процессом. */
  python?: {
    exe: string
    sdkDir: string
  }
}

/** main → plugin: RPC-вызов тула. */
export interface PluginMsgCallTool {
  type: 'callTool'
  requestId: string
  toolName: string
  args: Record<string, unknown>
}

/** main → plugin: RPC-вызов слэш-команды. */
export interface PluginMsgCallCommand {
  type: 'callCommand'
  requestId: string
  commandName: string
  /** Строка аргументов после /name. */
  args: string
}

/** main → plugin: graceful shutdown (перед kill). */
export interface PluginMsgShutdown {
  type: 'shutdown'
  requestId: string
}

/** main → plugin: событие хоста (chat:message и др.). Fire-and-forget. */
export interface PluginMsgEvent {
  type: 'event'
  event: string
  payload: Record<string, unknown>
}

/** main → plugin: сообщение из iframe-панели плагина. Fire-and-forget. */
export interface PluginMsgUiMessage {
  type: 'uiMessage'
  data: unknown
}

/** main → plugin: RPC-вызов из iframe-панели (мост synteeBridge.call). */
export interface PluginMsgUiCall {
  type: 'uiCall'
  requestId: string
  /** Имя метода, зарегистрированного через syntee.ui.handle(). */
  method: string
  args: Record<string, unknown>
}

/** main → plugin: хук с ответом (chat:before-send, tool:result,
 *  prompt:before-build). Плагин отвечает hookResult
 *  { action: 'allow' | 'modify' | 'reject', content? }.
 *  tool:result: payload { toolName, args, result } — content = новый
 *  результат тула (модификация до того, как его увидит модель).
 *  prompt:before-build: payload { chatId, prompt } — content = новый
 *  system prompt (последняя точка вмешательства). */
export interface PluginMsgHook {
  type: 'hook'
  requestId: string
  event: string
  payload: Record<string, unknown>
}

/** plugin → main: ответ на init (успех/ошибка активации). */
export interface PluginMsgInitResult {
  type: 'initResult'
  requestId: string
  ok: boolean
  error?: string
}

/** plugin → main: ответ на вызов тула. */
export interface PluginMsgCallToolResult {
  type: 'callToolResult'
  requestId: string
  ok: boolean
  /** Текстовый результат (строка — как у всех тулов агента). */
  output?: string
  error?: string
}

/** plugin → main: ответ на вызов слэш-команды. */
export interface PluginMsgCallCommandResult {
  type: 'callCommandResult'
  requestId: string
  ok: boolean
  output?: string
  error?: string
}

/** plugin → main: зарегистрировать слэш-команду. */
export interface PluginMsgRegisterCommand {
  type: 'registerCommand'
  name: string
  description: string
  icon?: string
}

/** plugin → main: снять регистрацию в рантайме (unregisterTool /
 *  unregisterCommand / unregisterPanel / unregisterPromptSection). */
export interface PluginMsgUnregister {
  type: 'unregisterTool' | 'unregisterCommand' | 'unregisterPanel' | 'unregisterPromptSection' | 'unregisterMessageTag' | 'unregisterSettingsSection'
  /** Имя тула / команды, id панели, id секции промпта, имя тега или id секции настроек. */
  name: string
}

/** plugin → main: зарегистрировать UI-вклад (кнопка/панель/таб в слоте). */
export interface PluginMsgRegisterUi {
  type: 'registerUi'
  slot: 'sidebar' | 'right' | 'modal' | 'page' | 'bottom'
  uiType: 'button' | 'panel'
  label: string
  icon?: string
  command?: string
  /** Для right/modal/page/bottom — уникальный id панели. */
  panelId?: string
  /** HTML-файл панели (по умолчанию — manifest.ui). */
  entry?: string
}

/** plugin → main: плагин подписался на события (для short-circuit хуков). */
export interface PluginMsgSubscribeEvents {
  type: 'subscribeEvents'
  events: string[]
}

/** plugin → main: ответ на RPC-вызов из iframe (ui.handle). */
export interface PluginMsgUiCallResult {
  type: 'uiCallResult'
  requestId: string
  ok: boolean
  result?: unknown
  error?: string
}

/** plugin → main: ответ на хук (chat:before-send). */
export interface PluginMsgHookResult {
  type: 'hookResult'
  requestId: string
  ok: boolean
  /** 'allow' (по умолчанию) | 'modify' | 'reject'. */
  action?: 'allow' | 'modify' | 'reject'
  /** Новое содержимое при action='modify'. */
  content?: string
  error?: string
}

/** plugin → main: сообщение в свою iframe-панель (renderer перешлёт в iframe). */
export interface PluginMsgUiPostMessage {
  type: 'uiPostMessage'
  data: unknown
}

/** plugin → main: ответ на shutdown. */
export interface PluginMsgShutdownResult {
  type: 'shutdownResult'
  requestId: string
}

/** plugin → main: зарегистрировать тул. */
export interface PluginMsgRegisterTool {
  type: 'registerTool'
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Мутабельный тул — вызов требует подтверждения пользователя. */
  requiresApproval?: boolean
}

/** plugin → main: зарегистрировать context provider — динамический
 *  markdown, попадающий в system prompt перед каждым запросом агента. */
export interface PluginMsgRegisterContextProvider {
  type: 'registerContextProvider'
  name: string
  description?: string
}

/** plugin → main: зарегистрировать рендерер markdown-кодоблоков. */
export interface PluginMsgRegisterMarkdownRenderer {
  type: 'registerMarkdownRenderer'
  language: string
  entry: string
  height?: number
}

/** plugin → main: зарегистрировать кастомный тег сообщений —
 *  парный тег <tag>…</tag> в тексте сообщения рендерится
 *  iframe-виджетом плагина. */
export interface PluginMsgRegisterMessageTag {
  type: 'registerMessageTag'
  tag: string
  entry: string
  height?: number
  description?: string
}

/** plugin → main: зарегистрировать статическую секцию system prompt
 *  (registerPromptSection). */
export interface PluginMsgRegisterPromptSection {
  type: 'registerPromptSection'
  id: string
  title: string
  content: string
}

/** plugin → main: зарегистрировать секцию настроек в SettingsPage
 *  (registerSettingsSection). */
export interface PluginMsgRegisterSettingsSection {
  type: 'registerSettingsSection'
  id: string
  title: string
  entry: string
  icon?: string
}

/** plugin → main: зарегистрировать search provider (Spotlight). */
export interface PluginMsgRegisterSearchProvider {
  type: 'registerSearchProvider'
  id: string
  label: string
}

/** plugin → main: зарегистрировать autocomplete-провайдер инпута. */
export interface PluginMsgRegisterAutocomplete {
  type: 'registerAutocomplete'
  trigger: string
}

/** plugin → main: зарегистрировать пункт контекстного меню сообщений. */
export interface PluginMsgRegisterContextMenu {
  type: 'registerContextMenu'
  id: string
  label: string
  icon?: string
  scope: 'message' | 'selection'
  /** true — кнопка в ряду действий сообщения (не в меню «⋯»). */
  button?: boolean
}

/** plugin → main: зарегистрировать кнопку над полем ввода чата. */
export interface PluginMsgRegisterInputAction {
  type: 'registerInputAction'
  id: string
  label: string
  icon?: string
  tooltip?: string
  command?: string
}

/** plugin → main: зарегистрировать тему (CSS-переменные → ThemePicker). */
export interface PluginMsgRegisterTheme {
  type: 'registerTheme'
  name: string
  dark: boolean
  colors: Record<string, string>
}

/** plugin → main: зарегистрировать фон (AnimatedBackground picker). */
export interface PluginMsgRegisterBackground {
  type: 'registerBackground'
  id: string
  name: string
  kind: 'shader' | 'video' | 'image'
  src: string
}

/** main → plugin: вызов зарегистрированного провайдера/хендлера
 *  (context provider, search, autocomplete, context menu, ai-tool).
 *  kind: 'context' — name = имя провайдера, payload { chatId };
 *        'search'  — name = id провайдера, payload { query };
 *        'autocomplete' — name = trigger, payload { query };
 *        'menu'    — name = id пункта, payload { messageId?, selection?, chatId? };
 *        'aiTool'  — name = имя тула из opts.tools ai.chat, payload { args }. */
export interface PluginMsgCallHandler {
  type: 'callHandler'
  requestId: string
  kind: 'context' | 'search' | 'autocomplete' | 'menu' | 'aiTool'
  name: string
  payload: Record<string, unknown>
}

/** plugin → main: ответ на callHandler.
 *  context: result — markdown-строка;
 *  search: result — Array<{ id, label, sub?, icon? }>;
 *  autocomplete: result — Array<{ label, insertText?, command? }>;
 *  menu: result — игнорируется (побочные эффекты). */
export interface PluginMsgCallHandlerResult {
  type: 'callHandlerResult'
  requestId: string
  ok: boolean
  result?: unknown
  error?: string
}

/** plugin → main: лог (уходит в кольцевой буфер + UI). */
export interface PluginMsgLog {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
}

/** plugin → main: запрос к host-API (storage, clipboard, notifications, net,
 *  fs, config, ui.*, chat.*, chats.*, projects.*, memory.*, window.*,
 *  ai.*, bus, scheduler.*, shortcut.*, process.exec, overlay.*, statusbar.*,
 *  tray.*). */
export interface PluginMsgHostRequest {
  type: 'hostRequest'
  requestId: string
  method: 'storage.get' | 'storage.set' | 'storage.delete'
    | 'clipboard.readText' | 'clipboard.writeText'
    | 'notification.show'
    | 'net.fetch'
    | 'net.ws.connect' | 'net.ws.send' | 'net.ws.close'
    | 'fs.readFile' | 'fs.writeFile' | 'fs.listDir' | 'fs.watch' | 'fs.unwatch'
    | 'fs.mkdir' | 'fs.delete' | 'fs.rename' | 'fs.copy' | 'fs.stat' | 'fs.writeFiles'
    | 'config.get' | 'config.getAll'
    | 'ui.openPanel' | 'ui.closePanel' | 'ui.setBadge' | 'ui.getTheme'
    | 'ui.openModal' | 'ui.closeModal' | 'ui.registerWidget'
    | 'ui.showChatOverlay' | 'ui.hideChatOverlay'
    | 'chat.send' | 'chat.reply'
    | 'chat.beginReply' | 'chat.appendChunk' | 'chat.endReply'
    | 'chat.getActive'
    | 'prompt.get'
    | 'chats.list' | 'chats.get'
    | 'chats.create' | 'chats.rename' | 'chats.delete'
    | 'chats.appendMessage' | 'chats.editMessage' | 'chats.deleteMessage'
    | 'chats.open' | 'chats.getAttachments'
    | 'projects.list' | 'projects.current' | 'projects.create'
    | 'memory.search' | 'memory.save'
    | 'window.toast' | 'window.dialog'
    | 'ai.chat'
    | 'bus.emit'
    | 'scheduler.every' | 'scheduler.cron' | 'scheduler.at' | 'scheduler.cancel'
    | 'shortcut.register' | 'shortcut.unregister'
    | 'process.exec'
    | 'overlay.show' | 'overlay.hide'
    | 'statusbar.set' | 'statusbar.clear'
    | 'tray.setMenu' | 'tray.clearMenu'
    | 'ai.chatStream'
    | 'ai.embed'
    | 'ai.listModels'
    | 'ai.generateImage'
    | 'agent.run'
    | 'sound.play'
    | 'shell.openExternal'
    | 'agent.useTool'
    | 'mcp.listTools' | 'mcp.call'
    | 'secrets.get' | 'secrets.set' | 'secrets.delete'
    | 'net.listen' | 'net.close'
    | 'git.status' | 'git.diff' | 'git.log' | 'git.commit' | 'git.branches'
    | 'fs.pickFile' | 'fs.pickDir'
    | 'fs.pickFiles' | 'fs.saveDialog'
    | 'memory.chat.get' | 'memory.chat.set' | 'memory.chat.delete'
    | 'chats.getMessages'
    | 'ui.progress'
    | 'settings.get'
    | 'provider.register' | 'provider.unregister'
    | 'speech.tts' | 'speech.stt'
  params: Record<string, unknown>
}

/** main → plugin: ответ на host-запрос. */
export interface PluginMsgHostResponse {
  type: 'hostResponse'
  requestId: string
  ok: boolean
  result?: unknown
  error?: string
}

export type PluginMsgHostToPlugin =
  | PluginMsgInit
  | PluginMsgCallTool
  | PluginMsgCallCommand
  | PluginMsgShutdown
  | PluginMsgEvent
  | PluginMsgUiMessage
  | PluginMsgUiCall
  | PluginMsgHook
  | PluginMsgHostResponse
  | PluginMsgCallHandler

export type PluginMsgPluginToHost =
  | PluginMsgInitResult
  | PluginMsgCallToolResult
  | PluginMsgCallCommandResult
  | PluginMsgShutdownResult
  | PluginMsgRegisterTool
  | PluginMsgRegisterCommand
  | PluginMsgRegisterUi
  | PluginMsgSubscribeEvents
  | PluginMsgUiCallResult
  | PluginMsgHookResult
  | PluginMsgLog
  | PluginMsgHostRequest
  | PluginMsgUiPostMessage
  | PluginMsgRegisterContextProvider
  | PluginMsgRegisterMarkdownRenderer
  | PluginMsgRegisterMessageTag
  | PluginMsgRegisterPromptSection
  | PluginMsgRegisterSettingsSection
  | PluginMsgRegisterSearchProvider
  | PluginMsgRegisterAutocomplete
  | PluginMsgRegisterContextMenu
  | PluginMsgRegisterInputAction
  | PluginMsgRegisterTheme
  | PluginMsgRegisterBackground
  | PluginMsgUnregister
  | PluginMsgCallHandlerResult
