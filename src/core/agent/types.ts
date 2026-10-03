import type { FileCacheEntry } from '../context/fileCacheTypes'
import type { QuestionSpec, QuestionAnswer, AllowScope } from '../../shared/types'
import type Store from 'electron-store'

export interface AgentStep {
  // tool_call_pending — модель только начала генерировать этот вызов (имя
  // уже известно, аргументы ещё стримятся) — ранний сигнал для UI, чтобы
  // блок тула появлялся сразу, а не после долгой генерации большого diff/content.
  type: 'thought' | 'tool_call_pending' | 'tool_call' | 'tool_result' | 'tool_result_update' | 'answer'
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
  // Связывает финальный tool_call с более ранним tool_call_pending той же
  // генерации (см. onToolCallStarted) — фронтенд заменяет pending-карточку
  // на настоящую вместо создания второго блока.
  pendingCallId?: string
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
  onConfirm?: (toolName: string, args: Record<string, unknown>) => Promise<boolean | { approved: boolean; always?: AllowScope }>
  approvalMode?: 'auto' | 'ask'
  onSpawnAgent?: (opts: { id: string; task: string; model?: string; approvalMode?: 'auto' | 'ask' | 'full'; isolation?: 'auto' | 'worktree' | 'none'; role?: string; callId?: string }) => Promise<{ summary: string; error?: string }>
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
  onMcpCall?: (fullToolName: string, args: Record<string, unknown>) => Promise<{ success: boolean; output: string; error?: string }>
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
   * Progress callback для долгих тулов (например get_fast_context):
   * транслирует stage-прогресс в main для live-индикации этапов в UI.
   */
  onToolProgress?: (p: { toolName: string; stage: string; detail?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }> }) => void
  /** AbortSignal для долгих тулов — позволяет отменить get_fast_context и т.п. */
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
   * manage_notes-тул: CRUD для проектных и чат-заметок.
   * Round-trip в main-процесс, где есть доступ к БД.
   */
  onManageNotes?: (params: {
    action: 'create' | 'update' | 'delete' | 'list'
    scope: 'project' | 'chat'
    title?: string
    content?: string
    noteId?: string
    projectId?: string
    chatId?: string
  }) => Promise<{ success: boolean; notes?: Array<{ id: string; title: string; content: string; updatedAt: number }>; note?: { id: string; title: string }; error?: string }>
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
    action:
      | 'request_access' | 'navigate' | 'back' | 'forward' | 'reload'
      | 'snapshot' | 'click' | 'type' | 'press_key' | 'scroll'
      | 'screenshot' | 'tabs' | 'tab_new' | 'tab_select' | 'tab_close' | 'wait'
    url?: string
    ref?: string
    text?: string
    submit?: boolean
    key?: string
    direction?: 'up' | 'down'
    amount?: number
    tabId?: string
    reason?: string
    ms?: number
  }) => Promise<{ success: boolean; output?: string; error?: string; enabled?: boolean; imageBase64?: string }>
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
  /** Persona — single-select run mode. Read-only personas get an explicit
    *  reminder in defense-in-depth (same mechanism as planningMode). */
  persona?: import('../../shared/modes').PersonaId
  /** §roles — role of this sub-agent (researcher/editor/implementer/...).
    *  When set, defense-in-depth in executeTool issues a role-specific
    *  blocked message for tools outside the role's allowlist. */
  subagentRole?: string
  /** Изображения для прямой передачи в основную модель (когда она
    *  поддерживает vision). Agent.run встраивает их в user-сообщение
    *  как multipart content вместо текстового описания от vision-модели. */
  imageParts?: ContentPart[]

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
