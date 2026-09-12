// ── Plugins (локальные расширения приложения) ───────────────────────────
//
// Плагин — папка с plugin.json (манифест) + JS-базой (main) и опционально
// UI-частью. В отличие от MCP (внешний процесс с тулами) и Skills
// (markdown-инструкции), плагин — это код, исполняемый в изолированном
// utilityProcess внутри приложения, с доступом к host-API:
// registerTool / registerCommand / registerUi / хуки / KV-storage.
//
// Именование тулов плагина: plugin__{pluginId}__{toolName}.

/** Права плагина. Каждое гейтит соответствующую область host-API. */
export type PluginPermission =
  | 'net'            // исходящие HTTP- и WebSocket-запросы (host fetch / ws) + shell.openExternal
  | 'fs:read'        // чтение файлов (любые пути) + fs.watch + fs.stat
  | 'fs:write'       // запись файлов (только внутри папки плагина)
  | 'fs:write:any'   // запись/создание/удаление файлов и папок в ЛЮБЫХ путях
                    // (mkdir/delete/rename/copy/writeFiles вне песочницы плагина)
  | 'clipboard'      // буфер обмена
  | 'notifications'  // showNotification
  | 'ui'             // registerUi/registerPanel/виджеты/модалки/statusbar (UI приложения)
  | 'chat'           // chat.send / chat.reply (действия в чате от имени плагина)
  | 'chats:read'     // чтение списка чатов и их сообщений
  | 'chats:write'    // создание/переименование/удаление чатов, запись/правка сообщений
  | 'projects:read'  // чтение списка проектов + projects.current
  | 'projects:write' // создание проектов (projects.create)
  | 'memory'         // поиск/сохранение в долгосрочную память приложения
  | 'ai'             // доступ к LLM через хост (syntee.ai.chat)
  | 'scheduler'      // планировщик (scheduler.every/cron/at)
  | 'shortcuts'      // глобальные горячие клавиши (registerShortcut)
  | 'process:exec'   // запуск shell-команд через хост (process.exec)
  | 'overlay'        // показ контента в overlay-окне приложения
  | 'tray'           // пункты меню в трее
  | 'context'        // registerContextProvider — динамический контекст в system prompt
  | 'secrets'        // шифрованное хранилище секретов (syntee.secrets, safeStorage)
  | 'git'            // git-операции по workdir (syntee.git)
  | 'mcp'            // вызов тулов MCP-серверов приложения (syntee.mcp)
  | 'webhook'        // локальный HTTP-сервер — приём внешних запросов (net.listen)
  | 'agent'          // вызов host-тулов агента (syntee.agent.useTool)
  | 'hooks'          // подписка на хуки/события контента: chat:message,
                    // chat:before-send, chat:completed, message:delta,
                    // tool:call, tool:result, prompt:before-build
  | 'provider'       // регистрация провайдера моделей (provider.register —
                    // OpenAI-compatible endpoint появляется в настройках)
  | 'settings:read'  // чтение публичных настроек приложения (settings.get)
  | 'speech'         // синтез и распознавание речи (speech.tts/stt)

/** Вариант выбора для select/multiselect-полей настроек. */
export interface PluginConfigOption {
  value: string
  label: string
}

/** Поле настроек плагина — декларативная схема в манифесте,
 *  автоматически рендерится формой в карточке плагина. */
export interface PluginConfigField {
  key: string
  label: string
  /**
   * Тип контрола формы:
   *  - 'string'      — однострочный текст
   *  - 'password'    — текст со скрытием (API-ключи, токены)
   *  - 'number'      — число (min/max/step)
   *  - 'boolean'     — тумблер
   *  - 'select'      — выпадающий список (options)
   *  - 'multiselect' — несколько вариантов сразу (чипы; значение — string[])
   *  - 'textarea'    — многострочный текст
   *  - 'color'       — цвет (#rrggbb)
   */
  type: 'string' | 'password' | 'number' | 'boolean' | 'select' | 'multiselect' | 'textarea' | 'color'
  default?: string | number | boolean | string[]
  placeholder?: string
  description?: string
  /** Варианты для select/multiselect (строки или {value,label}). */
  options?: Array<string | PluginConfigOption>
  /** Границы и шаг для type:'number'. */
  min?: number
  max?: number
  step?: number
}

/** Манифест плагина — plugin.json в корне папки плагина. */
export interface PluginManifest {
  /** Уникальный id (slug). Должен совпадать с именем папки. */
  id: string
  /** Отображаемое имя. */
  name: string
  version: string
  author?: string
  /** Короткое описание для списка в UI. */
  description?: string
  /**
   * Короткое описание для system prompt (~200 символов) — AI видит
   * включённые плагины и понимает, зачем они и какие тулы дают.
   */
  promptDescription?: string
  /** Entry point основной логики (относительный путь, CJS). */
  main: string
  /** HTML-файл кастомного UI (рендерится в sandboxed iframe через
   *  syntee-plugin://{id}/... протокол). Относительный путь. */
  ui?: string
  /** Относительный путь до полного описания (markdown) для карточки UI. */
  readme?: string
  /** Кастомный UI настроек (HTML-файл, рендерится iframe в карточке плагина
   *  ВМЕСТО декларативной формы config). Панель общается с плагином через
   *  synteeBridge.call → ui.handle, сохраняет через свой хендлер. */
  configUi?: string
  /** Права, запрашиваемые плагином. */
  permissions?: PluginPermission[]
  /** Версия plugin API, под которую написан плагин ('1' — текущая).
   *  При мажорных изменениях API хост предупредит в журнале, если
   *  плагин рассчитан на другую версию. */
  apiVersion?: string
  /** Схема настроек — форма в карточке плагина, значения через syntee.config. */
  config?: PluginConfigField[]
  /**
   * События активации (пока информационные; onLoad — дефолт).
   * Задел на будущее: 'onLoad' | 'chat:message' | 'command:<name>'.
   */
  activation?: string[]
  /**
   * Встроенный плагин (поставляется с приложением из resources/builtin-plugins).
   * Синхронизируется в {userData}/plugins при каждом запуске (обновляется
   * вместе с приложением), не удаляется через UI. Пользователь может
   * только включить/выключить его.
   */
  builtin?: boolean
  /**
   * Рантайм основной логики. 'node' (по умолчанию — CJS require в
   * utilityProcess) или 'python' — логика на Python: хост спавнит
   * sidecar-процесс `python {main}` и проксирует те же JSON-сообщения
   * протокола через stdin/stdout. Python-плагин импортирует SDK:
   * `from syntee import syntee` (SDK кладётся в PYTHONPATH хостом).
   */
  runtime?: 'node' | 'python'
  /**
   * Явный путь до интерпретатора Python для runtime:'python'
   * (override авто-детекта python → python3 → py). Может быть venv.
   */
  runtimePath?: string
  /**
   * Python-зависимости (pip-спецификации: 'requests', 'rich>=13').
   * Устанавливаются автоматически при первом запуске плагина и кнопкой
   * в карточке UI; статус показывается в карточке.
   */
  requirements?: string[]
  /**
   * npm-зависимости Node-плагина ('lodash', 'dayjs@1.11'). Устанавливаются
   * через `npm install` в папку плагина (node_modules резолвится из
   * utilityProcess стандартным алгоритмом Node) автоматически при первом
   * запуске и кнопкой в карточке UI. Ограничения: пакеты должны быть
   * CJS-совместимыми (require), нативные .node-модули не гарантированы.
   */
  dependencies?: string[]
}

/** Загруженный плагин (манифест + метаданные расположения). */
export interface Plugin {
  /** = manifest.id. */
  id: string
  manifest: PluginManifest
  /** Абсолютный путь до папки плагина. */
  dir: string
  /** 'global' ({userData}/plugins) или 'project' ({workdir}/.syntee/plugins). */
  source: 'global' | 'project'
  /** Для проектных — id проекта. */
  projectId?: string
  /** Полное описание (readme.md), прочитанное loader-ом (для карточки UI). */
  readmeContent?: string
}

/** Per-plugin состояние (включён + область применения), в electron-store. */
export interface PluginState {
  enabled: boolean
  scope: import('./mcp').ExtensionScope
  /** Пользователь подтвердил права плагина (consent-диалог при первом
   *  включении). Без consent плагин с permissions не включается. */
  consented?: boolean
}

/** Статус процесса плагина. */
export type PluginStatus = 'stopped' | 'starting' | 'running' | 'error'

/** Запись журнала плагина (кольцевой буфер в main). */
export interface PluginLogEntry {
  /** Unix ms. */
  ts: number
  level: 'info' | 'warn' | 'error'
  message: string
}

/** Runtime-тул плагина — регистрируется плагином, агрегируется менеджером. */
export interface PluginToolRuntime {
  pluginId: string
  /** Полное имя тула: plugin__{pluginId}__{toolName}. */
  name: string
  /** Короткое имя (без префикса). */
  shortName: string
  description: string
  inputSchema: Record<string, unknown>
  /** Мутабельный тул: вызов требует подтверждения пользователя
   *  (approval-диалог агента) независимо от режима. */
  requiresApproval?: boolean
}

/** Слэш-команда плагина (registerCommand). */
export interface PluginCommandRuntime {
  pluginId: string
  /** Имя без слэша: 'weather' → команда /weather. */
  name: string
  description: string
  icon?: string
}

/** UI-вклад плагина (registerUi/registerPanel) — кнопка/панель/таб в слоте. */
export interface PluginUiContribution {
  pluginId: string
  /** Слот: 'sidebar' — низ сайдбара; 'right' — таб правой панели;
   *  'modal' — модальная iframe-панель; 'page' — полноэкранная страница
   *  (вкладка в навигации приложения); 'bottom' — таб нижнего дока. */
  slot: 'sidebar' | 'right' | 'modal' | 'page' | 'bottom'
  /** 'button' — выполняет command плагина; 'panel' — открывает iframe-панель/таб. */
  type: 'button' | 'panel'
  label: string
  icon?: string
  /** Для type='button' — имя команды плагина (без слэша). */
  command?: string
  /** Уникальный id панели (для right/modal/page/bottom: openPanel/closePanel/setBadge). */
  panelId?: string
  /** HTML-файл панели (относительный путь; по умолчанию — manifest.ui). */
  entry?: string
}

/** Инлайн-виджет плагина (registerWidget) — iframe-карточка в сообщении чата.
 *  Тул плагина возвращает JSON PluginUiWidgetPayload → renderer рендерит
 *  iframe с entry виджета и передаёт data. */
export interface PluginWidgetRuntime {
  pluginId: string
  /** Короткое имя виджета ([a-zA-Z][a-zA-Z0-9_-]*). */
  name: string
  /** HTML-файл виджета (относительный путь в папке плагина). */
  entry: string
  /** Высота карточки по умолчанию (px). */
  height?: number
  /** Описание для AI — когда и зачем вставлять этот виджет. */
  description?: string
}

/** Элемент status bar от плагина (низ окна, как в VS Code). */
export interface PluginStatusbarItem {
  pluginId: string
  /** Уникальный id элемента (в рамках плагина). */
  id: string
  /** Текст (короткий, 1-2 слова + значение). */
  text: string
  /** Тултип при наведении. */
  tooltip?: string
  /** Имя команды плагина — клик по элементу выполняет её (без слэша). */
  command?: string
}

/** Информация о теме для UI плагина (ui.getTheme / событие theme:changed). */
export interface PluginThemeInfo {
  /** Имя темы ('dark', 'light', 'nord', ...). */
  theme: string
  /** Акцентный цвет (#rrggbb). */
  accentColor: string
  /** true для тёмных тем. */
  dark: boolean
}

/** Context provider плагина (registerContextProvider) — поставляет
 *  динамический markdown-контент, который попадает в system prompt
 *  перед КАЖДЫМ запросом агента (с таймаутом). */
export interface PluginContextProviderRuntime {
  pluginId: string
  /** Уникальное имя провайдера ([a-zA-Z][a-zA-Z0-9_-]*). */
  name: string
  /** Короткое описание — что этот контекст содержит. */
  description?: string
}

/** Кастомный рендерер markdown-кодоблоков (registerMarkdownRenderer):
 *  кодоблок ```language в сообщении рендерится iframe-панелью плагина
 *  (как mermaid), код передаётся в data. */
export interface PluginMarkdownRendererRuntime {
  pluginId: string
  /** Язык кодоблока (регистронезависимо: 'plantuml', 'kroki', ...). */
  language: string
  /** HTML-файл рендерера (относительный путь в папке плагина). */
  entry: string
  /** Высота iframe по умолчанию (px). */
  height?: number
}

/** Кастомный тег сообщения (registerMessageTag) — парный тег
 *  <tag attr="...">…</tag> в тексте сообщения рендерится iframe-виджетом
 *  плагина (механика та же, что у инлайн-виджетов). Незарегистрированный
 *  тег остаётся обычным текстом. */
export interface PluginMessageTagRuntime {
  pluginId: string
  /** Имя тега ([a-zA-Z][a-zA-Z0-9-]*). */
  tag: string
  /** HTML-файл виджета (относительный путь в папке плагина). */
  entry: string
  /** Высота карточки по умолчанию (px). */
  height?: number
  /** Описание для AI — когда и зачем вставлять тег в ответ. */
  description?: string
}

/** Статическая секция system prompt (registerPromptSection) —
 *  неизменяемый markdown-блок, добавляемый в промпт на время работы
 *  плагина (в отличие от context provider — без вызова на каждый запрос). */
export interface PluginPromptSectionRuntime {
  pluginId: string
  /** Уникальный id секции (для unregisterPromptSection). */
  id: string
  /** Заголовок (### {title} в промпте). */
  title: string
  /** Markdown-контент секции. */
  content: string
}

/** Search provider плагина (registerSearchProvider) — результаты
 *  в глобальном поиске (Spotlight). */
export interface PluginSearchProviderRuntime {
  pluginId: string
  /** Уникальный id провайдера. */
  id: string
  /** Отображаемое имя секции результатов. */
  label: string
}

/** Autocomplete-провайдер плагина (registerAutocomplete) — подсказки
 *  в поле ввода чата при вводе триггер-слова. */
export interface PluginAutocompleteRuntime {
  pluginId: string
  /** Триггер-слово (без пробела в конце): 'jira', 'todo', ... — подсказки
 *  показываются после ввода "jira " до конца слова. */
  trigger: string
}

/** Пункт контекстного меню сообщений (registerContextMenu). */
export interface PluginContextMenuRuntime {
  pluginId: string
  /** Уникальный id пункта. */
  id: string
  /** Подпись пункта меню. */
  label: string
  /** Имя иконки AppIcon (опционально). */
  icon?: string
  /** 'message' — пункт в меню сообщения; 'selection' — для выделенного
   *  текста (payload.selection). */
  scope: 'message' | 'selection'
  /** true — рендерится НЕ в меню «⋯», а отдельной кнопкой в ряду действий
   *  сообщения (copy/pin/reply). Клик — тот же callHandler 'menu'. */
  button?: boolean
}

/** Кнопка плагина над полем ввода чата (registerInputAction) —
 *  ряд быстрых действий рядом с «+». Клик: command → слэш-команда
 *  плагина, без command — событие 'input-action' в процесс плагина. */
export interface PluginInputActionRuntime {
  pluginId: string
  /** Уникальный id действия. */
  id: string
  /** Подпись (короткая, 1-2 слова). */
  label: string
  /** Имя иконки AppIcon. */
  icon?: string
  /** Тултип. */
  tooltip?: string
  /** Имя слэш-команды плагина (без слэша) — клик выполняет её. */
  command?: string
}

/** Тема от плагина (registerTheme) — набор CSS-переменных, появляется
 *  в ThemePicker наравне со встроенными. */
export interface PluginThemeContribution {
  pluginId: string
  /** Отображаемое имя темы. */
  name: string
  dark: boolean
  /** CSS-переменные: { '--bg': '#1e1e2e', '--accent': '#89b4fa', ... }. */
  colors: Record<string, string>
}

/** Фон от плагина (registerBackground) — появляется в пикере фонов
 *  AnimatedBackground. */
export interface PluginBackgroundContribution {
  pluginId: string
  /** Уникальный id фона. */
  id: string
  /** Отображаемое имя. */
  name: string
  /** 'shader' — GLSL-файл (src — .frag путь); 'video' — видеофайл;
   *  'image' — картинка. Все пути относительные, отдаются через
   *  syntee-plugin:// протокол. */
  kind: 'shader' | 'video' | 'image'
  /** Файл ресурса (относительный путь в папке плагина). */
  src: string
}

/** Секция настроек плагина (registerSettingsSection) — своя вкладка
 *  в SettingsPage (iframe с entry), для богатой конфигурации. */
export interface PluginSettingsSectionRuntime {
  pluginId: string
  /** Уникальный id секции. */
  id: string
  /** Заголовок в навигации настроек. */
  title: string
  /** HTML-файл секции (относительный путь в папке плагина). */
  entry: string
  /** Имя иконки AppIcon (опционально). */
  icon?: string
}

/** Маркер инлайн-виджета: тул плагина возвращает JSON этого вида —
 *  renderer рендерит iframe-карточку вместо текста. */
export interface PluginUiWidgetPayload {
  __plugin_ui__: true
  pluginId: string
  /** HTML-файл виджета (относительный путь в папке плагина). */
  entry: string
  /** Данные, которые получит виджет при загрузке (postMessage). */
  data?: unknown
  /** Высота карточки в px (по умолчанию 260). */
  height?: number
  /** 'diff' — нативный diff-виджет хоста (без iframe): поля diff/title/
   *  language обязательны, entry игнорируется.
   *  'badge' — инлайн-бейдж (пилюля) в тексте сообщения: поля text
   *  обязательны, entry игнорируется. */
  kind?: 'iframe' | 'diff' | 'badge'
  /** Для kind='diff': unified diff-текст. */
  diff?: string
  /** Для kind='diff': заголовок карточки (имя файла и т.п.). */
  title?: string
  /** Для kind='diff': язык подсветки. */
  language?: string
  /** Для kind='badge': текст бейджа. */
  text?: string
  /** Для kind='badge': цвет (CSS-цвет; по умолчанию акцент темы). */
  color?: string
  /** Action-кнопки под карточкой (kind='iframe'): клик выполняет
   *  слэш-команду плагина (с payload виджета как args-контекстом)
   *  или открывает его панель. */
  actions?: Array<{
    label: string
    /** Слэш-команда плагина (без слэша). */
    command?: string
    /** id панели плагина (registerPanel) — открыть по клику. */
    panel?: string
  }>
}

/** Полное состояние плагина для UI. */
export interface PluginRuntime extends Plugin {
  state: PluginState
  status: PluginStatus
  error?: string
  tools: PluginToolRuntime[]
  commands: PluginCommandRuntime[]
  ui: PluginUiContribution[]
  /** Зарегистрированные инлайн-виджеты (registerWidget). */
  widgets: PluginWidgetRuntime[]
  /** Context providers (registerContextProvider). */
  contextProviders: PluginContextProviderRuntime[]
  /** Кастомные рендереры кодоблоков (registerMarkdownRenderer). */
  markdownRenderers: PluginMarkdownRendererRuntime[]
  /** Search providers для Spotlight (registerSearchProvider). */
  searchProviders: PluginSearchProviderRuntime[]
  /** Autocomplete-провайдеры для инпута (registerAutocomplete). */
  autocomplete: PluginAutocompleteRuntime[]
  /** Пункты контекстного меню сообщений (registerContextMenu). */
  contextMenu: PluginContextMenuRuntime[]
  /** Кнопки над полем ввода (registerInputAction). */
  inputActions: PluginInputActionRuntime[]
  /** Секции настроек в SettingsPage (registerSettingsSection). */
  settingsSections: PluginSettingsSectionRuntime[]
  /** Кастомные теги сообщений (registerMessageTag). */
  messageTags: PluginMessageTagRuntime[]
  /** Статические секции system prompt (registerPromptSection). */
  promptSections: PluginPromptSectionRuntime[]
  /** Темы от плагина (registerTheme). */
  themes: PluginThemeContribution[]
  /** Фоны от плагина (registerBackground). */
  backgrounds: PluginBackgroundContribution[]
  /** Текущие значения настроек (config из манифеста + сохранённые). */
  configValues: Record<string, unknown>
  /** Статус зависимостей плагина (python: requirements, node: dependencies). */
  deps?: {
    /** Спецификации из манифеста (pip или npm). */
    required: string[]
    /** Установлены ли (маркер в папке плагина совпадает с текущим списком). */
    installed: boolean
  }
  logs: PluginLogEntry[]
}

/** Компактная инфа о плагине для system prompt. */
export interface PluginPromptInfo {
  id: string
  name: string
  promptDescription?: string
  tools: string[]
  /** Инлайн-виджеты: AI может попросить тул плагина вернуть виджет-карточку. */
  widgets?: Array<{ name: string; description?: string }>
  /** Кастомные теги сообщений: AI может вставлять <tag>…</tag> в ответы. */
  messageTags?: Array<{ tag: string; description?: string }>
  /** Context providers — их контент уже включён в промпт отдельным блоком;
   *  здесь только имена, чтобы AI знал источник. */
  contextProviders?: string[]
}
