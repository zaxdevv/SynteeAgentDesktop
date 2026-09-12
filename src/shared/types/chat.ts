// ── Chat core types: Chat, Project, Message, ToolStep, Checkpoints ──

export type ChatMode = 'code' | 'work'

export interface Chat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  isIncognito: number
  isPinned: number
  isArchived: number
  mode: ChatMode
  color?: string
  workdir?: string  // денормализованный кэш из projects (обратная совместимость)
  projectId?: string  // FK на projects.id; NULL = «Без проекта»
  lastMessage?: string
  messageCount?: number
  /** Per-chat модель: NULL/undefined = использовать глобальное назначение role:'main'.
   *  Пишется при смене модели в чате (chat:setModel), наследуется при создании
   *  нового чата из текущего. */
  modelId?: string
  modelProvider?: string
  /** Per-chat уровень мышления: NULL/undefined = глобальный settings.reasoningValue. */
  reasoningValue?: string
}

export interface Project {
  id: string
  name: string
  workdir: string
  projectContext?: string  // результат analyzeProject при создании; не гоняем по IPC в каждый chats.list
  verificationCommand?: string  // команда авто-проверки после сессии правок (напр. "npm test")
  contextFiles?: string[]  // JSON-массив относительных путей к .md файлам для контекста
  autoDiscoverInstructions?: boolean  // авто-дискавери AGENTS.md/CLAUDE.md/.syntee/instructions.md
  disabledDiscoveryFiles?: string[]  // стандартные файлы, отключённые из авто-дискавери
  createdAt: number
  lastUsed: number
}

export interface ToolStep {
  id: string
  type: 'tool_call' | 'tool_result'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
  timestamp: number
  imageUrl?: string  // путь к сгенерированному изображению
  diff?: string      // unified diff для edit_file
  callId?: string    // ID tool_call для связи call→result (реконструкция истории)
  /** Имя MCP-сервера для MCP-тулов (mcp__server__tool). undefined для встроенных. */
  serverName?: string
}

export interface Message {
  id: string
  chatId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  isPinned: number
  model?: string
  toolSteps?: ToolStep[]
  thinking?: string
  thinkingMs?: number
  /** Anthropic extended thinking blocks (with signatures). Required to echo
   *  back in subsequent rounds when the assistant message had tool_use —
   *  Anthropic API rejects the next request with 400 if thinking blocks
   *  (with their signatures) are stripped. Each block has {thinking, signature}. */
  thinkingBlocks?: Array<{ thinking: string; signature: string }>
  slashCommand?: { name: string; args: string }
  iterations?: Array<{ label?: string; textBefore: string; thinking?: string; thinkingMs?: number; steps: ToolStep[] }>
  liveSegments?: Array<{ text: string; steps: ToolStep[] }>
  imageUrl?: string
  planData?: { title: string; content: string; summary: string; filePath: string }
  todo?: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
  /** Ответы пользователя на ask_user-тул (для рендера в ToolChain). */
  questionAnswers?: import('./question').QuestionAnswer[]
  /** Прикреплённые пользователем файлы/изображения (для рендера чипов над
   *  сообщением). Текстовое содержимое уже инлайнилось в content на этапе
   *  отправки, здесь — только метаданные для UI. */
  attachments?: import('./attachment').Attachment[]
  /** Результат обработки вложений (processAttachmentsAndStream) — для
   *  отображения AttachmentProcessingBlock в сохранённом сообщении.
   *  Заполняется только у user-сообщений с attachments. Live-стриминг
   *  идёт через toolProgress['process_attachments'] в Zustand, после
   *  завершения результат сохраняется в БД для отображения после рестарта. */
  attachmentResult?: import('./attachment').AttachmentProcessingResult
  /** Снимок резюме на момент сжатия контекста (для разворачивания разделителя).
   *  Заполняется только у system-сообщений с slashCommand.name === 'compact'. */
  compactSummary?: string
  /** Статистика сжатия (заполняется только у compact-разделителей).
   *  Используется ContextRing для показа кол-ва сжатий и сэкономленных токенов. */
  compactStats?: { removedCount: number; tokensBefore: number; tokensAfter: number; tokensSaved: number }
  /** Полная длительность ответа (мс от начала запроса до завершения стрима/агента).
   *  Заполняется только у assistant-сообщений; для user/system — undefined. */
  durationMs?: number
  /** Чистое время генерации токенов (мс) — без пауз на выполнение тулов и
   *  обработки промпта до первого токена. Для честной скорости ток/с.
   *  undefined у старых сообщений → UI fallback на durationMs. */
  streamingMs?: number
  /** Реальные токены от провайдера (суммарно по всем LLM-вызовам turn'а).
   *  Заполняется только у assistant-сообщений при наличии usage от провайдера. */
  promptTokens?: number
  completionTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Кол-во вызванных тулов в этом turn'е (число tool_call шагов). */
  toolCallsCount?: number
  /** Как завершился turn: 'done' — штатно; 'stopped' — пользователь нажал Стоп;
   *  'error' — ошибка/падение воркера. undefined у старых сообщений и user/system. */
  finishReason?: 'done' | 'stopped' | 'error'
  /** Скрыто из AI-контекста (редактор чата): видно пользователю в чате
   *  (затемнено, с пометкой), но модель не получает — getLiveMessages
   *  фильтрует. 1 = скрыто, 0/undefined = обычное. */
  hiddenFromContext?: number
}

// ── Checkpoint / Rewind ──────────────────────────────────────────────────
// Точка отката сессии: пара (user_message_id, assistant_message_id) одного turn'а.
// Используется правой панелью "Сессия" для таймлайна и кнопкой "Откатить" на
// user-сообщениях.

export interface CheckpointMeta {
  id: string
  chatId: string
  userMessageId: string
  assistantMessageId: string | null
  userPromptPreview: string  // первые 120 символов user-промпта
  filesChanged: number       // кол-во файлов, изменённых в этом turn'е
  filePaths: string[]        // список путей изменённых файлов
  createdAt: number
  /** Имя снапшота для /snapshot <name> + /restore <name>. NULL у обычных
   *  auto-checkpoint'ов на каждый turn. Именованные — явно созданы пользователем. */
  name?: string | null
}

// Результат chat:rewindTo — либо обновлённый массив сообщений, либо ошибка.
export interface RewindResult {
  messages?: Message[]
  error?: string
}

// ── Изменения последнего запроса (для ChangesBadge над инпутом) ──────────
// Per-file добавлено/удалено строк, суммарные счётчики и ID сообщений turn'а.
// Бейдж появляется после запроса с правками файлов, сбрасывается при новом send.
export interface LastTurnFileChange {
  path: string
  added: number
  deleted: number
}
export interface LastTurnChanges {
  files: LastTurnFileChange[]
  totalAdded: number
  totalDeleted: number
  userMessageId: string
  assistantMessageId: string
}

// Метаданные одного запроса в очереди или активного запуска чата.
// Используется UI-панелью очереди для отображения preview/управления.
export interface QueueItemMeta {
  queueId: string       // уникальный ID элемента (uuid)
  chatId: string
  msgId: string         // assistantMsgId (будущего ответа)
  userMsgId: string     // id user-сообщения
  preview: string       // первые ~80 симв. текста запроса
  enqueuedAt: number    // ts постановки в очередь
  startedAt?: number    // ts старта воркера (для active run)
}
