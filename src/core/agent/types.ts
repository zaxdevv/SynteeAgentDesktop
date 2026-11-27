import type { FileCacheEntry } from '../context/fileCacheTypes'
import type { QuestionSpec, QuestionAnswer, AllowScope, SteerAttachmentMeta } from '../../shared/types'
import type Store from 'electron-store'

export interface AgentStep {
  // tool_call_pending — модель только начала генерировать этот вызов (имя
  // уже известно, аргументы ещё стримятся) — ранний сигнал для UI, чтобы
  // блок тула появлялся сразу, а не после долгой генерации большого diff/content.
  type: 'thought' | 'tool_call_pending' | 'tool_call' | 'tool_result' | 'tool_result_update' | 'answer' | 'steer' | 'hint' | 'janitor'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  imageUrl?: string
  /** Saved raster paths for restoring visual tool results (no base64 in DB). */
  imagePaths?: string[]
  /** Loading pixels is distinct from receiving the model's next response. */
  visualAnalysis?: { status: 'pending' | 'responded' | 'failed'; findings?: string }
  diff?: string
  callId?: string
  hidden?: boolean
  /** Имя MCP-сервера (для MCP-тулов mcp__server__tool). */
  serverName?: string
  /** type:'steer' — id внедрённой реплики пользователя (ключ оптимистичной
   *  карточки в renderer) и флаг, что она уже вставлена в messages. */
  steerId?: string
  steerApplied?: boolean
  /** type:'steer' — вложения реплики (чипы/миниатюры в карточке, БД шага). */
  attachments?: SteerAttachmentMeta[]
  // Связывает финальный tool_call с более ранним tool_call_pending той же
  // генерации (см. onToolCallStarted) — фронтенд заменяет pending-карточку
  // на настоящую вместо создания второго блока.
  pendingCallId?: string
  /** Code Mode execution source and internal tool trace, rendered by expandable tool UI. */
  codeMode?: { code: string; trace: Array<{ id?: string; name: string; args: unknown; result: string; status: 'success' | 'failure' | 'running' }> }
  /** type:'hint' — подсказка от watcher-агента, инжектированная между ходами. */
  hintSource?: import('../../shared/assistants').HintSource
  hintId?: string
  /** type:'janitor' — действие по оптимизации контекста. */
  janitorKind?: string
  janitorTokensSaved?: number
  janitorArchiveId?: string
  /** type:'janitor' — все действия одного скана (одна карточка на скан). */
  janitorActions?: Array<{ kind: string; description: string; tokensSaved: number; archiveId?: string }>
}

export interface ContextCountedInfo {
  promptTokens: number
  breakdown: {
    history: number
    system: number
    tools: number
    current: number
    toolResults?: number
  }
}

export interface AgentCallbacks {
  onStep: (step: AgentStep) => void
  /**
   * Живой трейс вложенных тулов execute_code: запись приходит ДВАЖДЫ —
   * сначала со status:'running' (вызов начался), затем финальная
   * (success/failure) с тем же id. UI апсертит строку по id, поэтому видно
   * «что выполняется сейчас», а не только итог скрипта.
   */
  onCodeTrace?: (entry: { id?: string; name: string; args: unknown; result: string; status: 'success' | 'failure' | 'running'; diff?: string }) => void
  /**
   * §rollback-live — файл изменён тулом (write_file/edit_file): отдаём
   * {path, contentBefore} СРАЗУ после правки, а не только в финальном
   * onDone(details.fileSnapshots).
   *
   * Зачем: при Stop (worker.terminate) и при краше воркера финальный
   * fileSnapshots не приходит вообще → чекпоинт сохранялся с filesChanged=0 и
   * откатить правки прогона было НЕЛЬЗЯ. Воркер стримит снапшоты в main по
   * одному, main копит их в ActiveRun.liveSnapshots и использует, если
   * финальный список пуст/отсутствует.
   */
  onFileSnapshot?: (snapshot: { path: string; contentBefore: string | null }) => void
  onDone: (answer: string, details?: AgentSummaryDetails) => void
  onError: (error: Error) => void
  onStatus?: (text: string) => void
  onRateLimit?: (waitSec: number) => void
  onRetry?: (attempt: number, reason: string, waitSec?: number, maxAttempts?: number) => void
  /** Конец раунда: оценка контекста на актуальном массиве messages
   *  (system[0] + history с tool_calls + current user + любые инъекции).
   *  breakdown консистентен с computeContextSnapshot. */
  onContextUpdate?: (info: ContextCountedInfo) => void
  onUsage?: (promptTokens: number, completionTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number) => void
  /**
   * Подтверждение действия. Возвращает boolean (одноразовое решение) или
   * объект с always — записать «Всегда разрешать» в выбранный scope
   * (см. Agent.recordAllowlist).
   */
  onConfirm?: (toolName: string, args: Record<string, unknown>) => Promise<boolean | { approved: boolean; always?: AllowScope; match?: 'action' | 'tool' }>
  approvalMode?: import('../../shared/types').ApprovalMode
  onSpawnAgent?: (opts: { id: string; task: string; model?: string; isolation?: 'auto' | 'worktree' | 'none'; role?: string; callId?: string }) => Promise<{ summary: string; error?: string }>
  onGetAgentStatus?: (agentId: string) => Promise<{ status: string; currentStep?: string; stepsCount: number } | null>
  /**
   * SPA-fallback для fetch_page: рендерит страницу через скрытый BrowserWindow
   * (встроенный Chromium) в main-процессе. Возвращает структурный markdown
   * (walker пробивает shadow DOM) + HTML для совместимости.
   * Round-trip worker → main → BrowserWindow → worker.
   */
  onRenderPage?: (url: string, opts: { waitSelector?: string; timeoutMs?: number }) => Promise<{ html: string; title?: string; error?: string; text?: string; apiEndpoints?: string[] }>
  /** Логгер тулов с каскадами (fetch_page, search_images): стадии и диагностика. */
  onLog?: (msg: string) => void
  /** Начало раунда: tiktoken-оценка того, что уйдёт в запрос (system+history
   *  с tool_calls+current user+tools schemas). breakdown консистентен. */
  onContextCounted?: (info: ContextCountedInfo) => void
  onTodoUpdate?: (items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>) => void
  onThinkingToken?: (token: string) => void
  onThinkingDone?: (ms: number) => void
  // Side-chat-only: запросить сообщения основного чата из БД (в worker
  // нет доступа к БД, поэтому идёт round-trip через main-процесс).
  onGetMainChatMessages?: (params: { limit?: number; search?: string }) => Promise<string>
  /**
   * Вызов MCP-тула (round-trip в main-процесс, где живёт McpManager).
   * fullToolName = mcp__serverName__toolName. Возвращает {success, output, error?}.
   */
  onMcpCall?: (fullToolName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ success: boolean; output: string; error?: string }>
  /**
   * Проверка, нужно ли подтверждение для MCP-тула. Если вернёт true —
   * агент запросит одобрение через onConfirm (как для опасных тулов).
   */
  onMcpRequiresApproval?: (fullToolName: string) => boolean
  /**
   * Проверка, требует ли тул плагина подтверждения (registerTool
   * с requiresApproval: true). Если вернёт true — агент запросит
   * одобрение через onConfirm.
   */
  onPluginRequiresApproval?: (fullToolName: string) => boolean
  /**
   * Вызов тула плагина (round-trip в main-процесс, где живёт PluginManager).
   * fullToolName = plugin__{pluginId}__{toolName}.
   */
  onPluginCall?: (fullToolName: string, args: Record<string, unknown>) => Promise<{ success: boolean; output: string; error?: string }>
  /**
   * Уведомление о вызове ЛЮБОГО тула (fire-and-forget, для события
   * tool:call у плагинов). Не влияет на выполнение.
   */
  onToolCall?: (name: string, args: Record<string, unknown>) => void
  /**
   * Запрос списка установленных расширений (MCP-серверы + skills).
   * Round-trip в main-процесс, где есть доступ к McpManager и SkillManager.
   * Возвращает текстовый отчёт для агента.
   */
  onListExtensions?: () => Promise<string>
  /**
   * Получить инструкции скила по имени. Round-trip в main-процесс.
   * Возвращает текст инструкций.
   */
  onGetSkill?: (name: string) => Promise<string>
  /**
   * ask_user-тул: задать уточняющие вопросы пользователю через UI-панель.
   * Round-trip через main-процесс → renderer (QuestionPanel). Блокирует
   * агент до ответа пользователя. Возвращает ответы по каждому вопросу.
   */
  onQuestion?: (questions: QuestionSpec[]) => Promise<QuestionAnswer[]>
  /**
   * Progress callback для долгих тулов:
   * транслирует stage-прогресс в main для live-индикации этапов в UI.
   */
  onToolProgress?: (p: { toolName: string; stage: string; detail?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }> }) => void
  /**
   * §orchestration — прогресс фазового рана. Одно событие на переход фазы:
   * 'running' при входе в фазу, 'done'/'blocked' при выходе. UI накапливает
   * фазы по startedAt (см. renderer/utils/orchestrationProgress.ts).
   * Не приходит для обычных (неоркестрированных) ранов.
   */
  onOrchestrationProgress?: (progress: import('../../shared/orchestration').OrchestrationProgress) => void
  /** AbortSignal для долгих тулов — позволяет отменить долгий tool-call. */
  signal?: AbortSignal
  /**
   * save_memory-тул: сохранить факт в долгосрочную память. Round-trip в main-
   * процесс, где есть доступ к БД (MemoryStore). Возвращает {success, id?, error?}.
   */
  onSaveMemory?: (params: {
    content: string
    kind: string
    scope?: string
    key?: string
    category?: string
    importance?: number
    projectId?: string
    chatId?: string
  }) => Promise<{ success: boolean; id?: string; error?: string }>
  /**
   * recall_memory-тул: multi-source поиск (5 источников параллельно).
   * Round-trip в main-процесс. Возвращает {success, results, error?}.
   * results — массив с source полем (memory|messages|summaries|agent_logs|pinned)
   * и метаданными (chatId, chatTitle, messageId, role, date для chat-источников).
   */
  onRecallMemory?: (params: {
    query: string
    kind?: string
    scope?: string
    projectId?: string
    limit?: number
    sources?: string[] // 'memory' | 'messages' | 'summaries' | 'agent_logs' | 'pinned'
    crossProject?: boolean
  }) => Promise<{
    success: boolean
    results: Array<{
      source: string
      title: string | null
      content: string
      score: number
      // memory-specific:
      kind?: string
      scope?: string
      key?: string | null
      // chat-specific (messages/pinned/summaries/agent_logs):
      chatId?: string
      chatTitle?: string
      messageId?: string
      role?: string
      date?: number
    }>
    error?: string
  }>
  /**
   * project_map-тул: чтение графа кода (code_map_* + семантика). Round-trip
   * в main-процесс: в worker-потоке БД не инициализирована (getDB бросает
   * «DB not initialized»). Возвращает готовый ToolResult — вся логика тула
   * (mapStore/mapSemantic/sidecar) выполняется в main.
   */
  onProjectMap?: (args: {
    action: 'search' | 'semantic' | 'callers' | 'callees' | 'file' | 'overview'
      | 'god' | 'communities' | 'path' | 'explain' | 'affected'
    query?: string
    /** Второй узел для action=path. */
    to?: string
    path?: string
    nodeId?: string
    limit?: number
    /** Макс. глубина для path/affected. */
    depth?: number
    /** Ограничение типов рёбер для path/affected. */
    relations?: Array<'calls' | 'references' | 'imports'>
    /** Бюджет ответа в токенах. */
    budget?: number
    /** Проект чата — тул работает только в контексте проекта. */
    projectId?: string
  }) => Promise<{ success: boolean; output: string; error?: string }>
  /**
   * manage_dots-тул: управление Dot'ами (always-on фоновые агенты).
   * Round-trip в main-процесс, где живёт DotManager. Возвращает
   * готовый текстовый отчёт для модели (форматирование в main).
   */
  onManageChats?: (params: import('../../shared/delegatedChats').ManageChatsParams) => Promise<import('../../shared/delegatedChats').ManageChatsResult>
  onManageDots?: (params: {
    action: 'create' | 'list' | 'get' | 'update' | 'delete' | 'wake'
    dotId?: string
    name?: string
    purpose?: string
    rules?: string
    scheduleKind?: 'cron' | 'interval'
    scheduleValue?: string
    watchPaths?: string[]
    webhookEnabled?: boolean
    modelId?: string | null
    modelProvider?: string | null
    enabled?: boolean
    icon?: string
    color?: string
  }) => Promise<{ success: boolean; error?: string; text?: string }>
  /**
   * browser_*-тулы + request_access: управление встроенным браузером.
   * Round-trip в main-процесс (browser_op), где живёт BrowserManager с
   * реестром webview-табов. imageBase64 — скриншот для vision-модели.
   */
  onBrowserAction?: (params: {
    action: string
    args?: Record<string, unknown>
    timeoutMs?: number
    frameId?: number
    snapshotId?: string
    locator?: { type: 'css' | 'role' | 'text' | 'label' | 'placeholder' | 'testid'; value: string; name?: string; exact?: boolean }
    selector?: string
    value?: string | number
    source?: string
    url?: string
    ref?: string
    text?: string
    submit?: boolean
    key?: string
    direction?: 'up' | 'down' | 'left' | 'right'
    amount?: number
    tabId?: string
    reason?: string
    capability?: 'browser_control' | 'image_generation'
    ms?: number
  }) => Promise<{ success: boolean; output?: string; error?: string; enabled?: boolean; capability?: 'browser_control' | 'image_generation'; imageBase64?: string }>
}

export interface AgentSummaryDetails {
  modifiedFiles: string[]
  diffs: Array<{ file: string; summary: string }>
  commandsRun: Array<{ command: string; exitCode?: string; success: boolean }>
  filesRead: string[]
  // §1.8 — снимок undoStack на конец turn'а: {path, contentBefore} для каждого
  // изменённого файла. contentBefore = null = файл был создан этим turn'ом.
  // Перегоняется в file_snapshots (DB) на main-стороне для checkpoint/rewind.
  fileSnapshots: Array<{ path: string; contentBefore: string | null }>
  /** §orchestration — атрибуция по моделям-ролям и история фаз (только для
   *  оркестрированных ранов; undefined у обычных). */
  orchestration?: import('./orchestration').OrchestrationRunSummary
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }


export type AgentMessage = {
  role: string
  content: string | ContentPart[]
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
  /** Internal compaction metadata; never part of a provider message. */
  janitorProtected?: boolean
  // Anthropic extended thinking blocks. When the model returns thinking
  // followed by tool_use, the thinking blocks MUST be echoed back in the
  // next round alongside the assistant's tool_use — otherwise Anthropic
  // returns 400 "thinking blocks must be followed by a tool_use or text
  // block". Each block needs both `thinking` (text) and `signature`
  // (verification token from the API). Without these, multi-round agentic
  // loops break on Claude with extended thinking enabled.
  thinking_blocks?: Array<{ thinking: string; signature: string }>
  // OpenAI-compatible reasoning_content (GLM/DeepSeek/Qwen thinking mode).
  // Some providers (LiteLLM proxy for glm-* / deepseek-r1) return 400 if the
  // assistant message that produced reasoning_content is echoed back in the
  // next round WITHOUT the reasoning_content field — the proxy validates
  // that thinking-mode output is round-tripped. Populated from response.reasoning
  // in Agent.ts and from message.thinking in chatContextHelpers. Anthropic
  // native path ignores this field (convertMessagesToAnthropic doesn't read it).
  reasoning_content?: string
}

export type NormalizedToolCall = {
  call: unknown
  callId: string
  fn: { name: string; arguments: string }
  args: Record<string, unknown>
  isHiddenTool: boolean
  pendingCallId: string
  /** Когда JSON.parse аргументов тула упал — несёт сообщение об ошибке и
   *  короткий фрагмент сырого JSON, чтобы executeCall выдал модели точное
   *  сообщение «invalid JSON» вместо вводящего в заблуждение «missing
   *  required arguments». undefined = парсинг прошёл успешно. */
  parseError?: { message: string; snippet: string }
}

export type AgentRuntimeOptions = {
  autoMemoryInterval?: number
  readFileCache?: boolean
  maxRepeatedToolCalls?: number
  maxRepeatedErrors?: number
  fileCacheSnapshot?: Record<string, FileCacheEntry>
  /** Режим планирования активен — defense-in-depth в executeTool выдаёт
    *  явное напоминание вместо generic-блока (см. Agent.ts ~line 469). */
  planningMode?: boolean
  /** §roles — role of this sub-agent (researcher/editor/implementer/...).
    *  When set, defense-in-depth in executeTool issues a role-specific
    *  blocked message for tools outside the role's allowlist. */
  subagentRole?: string
  /** Изображения для прямой передачи в основную модель (когда она
    *  поддерживает vision). Agent.run встраивает их в user-сообщение
    *  как multipart content вместо текстового описания от vision-модели. */
  imageParts?: ContentPart[]
  /**
   * §orchestration — снимок фазовых моделей. Если задан, тот же самый цикл
   * Agent.run() исполняет фазы planning → executing → reviewing/replanning
   * на ЯВНО выбранных моделях с read-only allowlist'ом для исследовательских
   * фаз. undefined = обычное поведение без изменений.
   */
  orchestration?: import('../../shared/orchestration').OrchestrationRun

}

export type AgentToolCallFingerprint = {
  toolName: string
  argsKey: string
}

export type ToolRound = {
  assistantIndex: number
  toolIndices: number[]
  toolNames: string[]
}

/**
 * Контекст, который Agent передаёт в ToolDispatcher — всё состояние, к
 * которому обращается executeTool. Dispatcher владеет собственными mutable
 * кэшами (readFileCache, fileCache, readFileMaxLine, filesReadInSession,
 * fileMap, lastShellCwd, commandsRun) и мутирует их при выполнении тулов.
 */
export interface ToolDispatcherContext {
  store: Store
  workdir?: string
  projectId?: string
  chatId?: string
  gatewayToken?: string
  gatewayApiUrl?: string
  onUpdateWorkingMemory?: (chatId: string, content: string, mode: 'replace' | 'append') => void
  onGetWorkingMemory?: (chatId: string) => string
  /** userData path — для fallback-поиска картинок-вложений в draft-attachments,
   *  когда AI вызывает analyze_image с именем файла-вложения (без полного пути). */
  userDataPath?: string
  /** Защищённые переменные: key → decrypted value. Используется для подстановки
   *  ${{KEY}} плейсхолдеров в аргументы тулов перед выполнением и обратной
   *  маскировки значений в результатах. */
  secretValues?: Map<string, string>
}
