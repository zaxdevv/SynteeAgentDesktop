import type Store from 'electron-store'
import { AIClient } from '../ai/AIClient'
import { needsApproval } from './commandSafety'
import { updateStructuredMemory } from '../context/structuredMemory'
import type { DiffEntry } from '../context/structuredMemory'
import {
  runCommand,
  TOOL_SCHEMAS, type ToolResult,
} from '../tools'
import {
  truncateToolResult, getContextSettings, getModelContextWindow,
  getHardLimitTokens, getHardLimitTargetTokens,
} from '../context/contextManager'
import { computeContextSnapshot } from '../tokens/usageTracker'
import { MAX_TOOL_TIMEOUT_MS } from '../ai/shared'
import { isReadonlyPersona, getPersonaAllowedTools } from '../../shared/modes'
import { getSubagentRole } from '../../shared/subagent-roles'
import type { FileCacheEntry } from '../context/fileCacheTypes'
import { resolve } from 'path'
import { log } from '../logger'
import type {
  AgentCallbacks, AgentSummaryDetails, AgentMessage,
  NormalizedToolCall, AgentRuntimeOptions, AgentToolCallFingerprint,
} from './types'
import {
  FALLBACK_SYSTEM_PROMPT, VERIFICATION_INTERVAL,
  normalizeToolName, findMissingRequiredArgs, formatMissingArgsMessage, getToolErrorHint, isSequentialTool,
  buildToolFingerprint, dropOldestRoundsIfOverflow, extractMcpServerName,
  tryRepairJson,
  salvageEditFileArgs,
} from './utils'
import { validateAndCoerceArgs } from './validateArgs'
import { ToolDispatcher } from './toolDispatcher'
import { jsonrepair } from 'jsonrepair'

// Тулы, которые НЕ блокируются hard block при parse-failure loop guard —
// они не деструктивны (идемпотентны, не меняют файлы/систему).
// Hard block на весь run лишает модель возможности сохранить
// результат работы или спросить пользователя.
const NON_DESTRUCTIVE_TOOLS = new Set([
  'edit_file',
  'save_memory',
  'recall_memory',
  'update_working_memory',
  'update_todo',
  'manage_notes',
  'ask_user',
])

export class Agent {
  private store: Store
  private client: AIClient
  private role: 'main' | 'subagent'
  chatId?: string
  /**
   * Рабочая директория чата (режим "Код"). Когда задана, файловые тулы
   * и run_command резолвят относительные пути относительно неё вместо
   * process.cwd()/homedir(). Не задана для Work-режима и старых чатов
   * (созданных до фичи workdir) — в этом случае поведение прежнее.
   */
  workdir?: string
  /**
   * ID проекта (из таблицы projects) — используется fast context для
   * привязки tree-sitter индекса к проекту. undefined для чатов без проекта.
   */
  projectId?: string
  /**
   * Команда авто-верификации проекта (напр. "npm test"), запускаемая
   * автоматически после VERIFICATION_INTERVAL успешных file-edit тулов —
   * упрощённый аналог PostToolUse-хука Claude Code без полной hook-инфры.
   */
  verificationCommand?: string
  /**
   * Gateway JWT (worker-scoped) — когда задан, веб-поиск идёт через gateway
   * /api/user/playground/web-search с админскими ключами Tavily/Exa. Локальный
   * tavilyKey из интеграций используется только как fallback при отсутствии
   * аккаунта или истёкшем токене.
   */
  gatewayToken?: string
  gatewayApiUrl?: string
  onUpdateWorkingMemory?: (chatId: string, content: string, mode: 'replace' | 'append') => void
  onGetWorkingMemory?: (chatId: string) => string
  /** Колбэк после записи/редактирования файла агентом — для live-обновления UI */
  onFileChanged?: (path: string) => void
  pendingDiffEntries: DiffEntry[] = []
  private readFileCache = new Map<string, string>()
  private fileMap = new Map<string, { reads: number; writes: number; note: string }>()
  private recentToolFingerprints: AgentToolCallFingerprint[] = []
  private recentErrorFingerprints: string[] = []
  // Fingerprint'ы JSON parse failures — для быстрого loop-guard:
  // 2 одинаковых подряд → soft warning, 3+ → hard block (кроме non-destructive тулов).
  private recentParseFailures: string[] = []
  // Счётчик срабатываний loop-guard на конкретный тул+args. Ключ
  // `${toolName}|${argsKey}`. 1-2 — мягкое предупреждение, 3 — hard block
  // (тул не выполняется). Не сбрасывается между turn'ами в run() — ловим
  // меж-turn зацикливание тоже (session-level).
  private loopGuardHits = new Map<string, number>()
  // §1.8 — undo/rollback: стек {path, originalContent} для отмены последних изменений
  private undoStack: Array<{ path: string; originalContent: string | null }> = []

  // Персистентный кэш read_file — переживает несколько run() вызовов,
  // инвалидация по mtime+size файла на диске.
  private fileCache = new Map<string, FileCacheEntry>()

  // Трекер «читал ли AI файл в этой сессии» — для read-before-edit проверки.
  // НЕ сбрасывается между run() (как loopGuardHits) — переживает turn'ы.
  // Ключ — нормализованный абсолютный путь (resolve(workdir, path)).
  private filesReadInSession = new Set<string>()

  // Auto-advance: максимальная строка, уже возвращённая моделью для каждого
  // файла. При повторном read_file БЕЗ offset — вместо возврата того же
  // первого чанка (cache hit), автоматически сдвигаем на следующий непрочитанный
  // чанк. Ключ — нормализованный абсолютный путь. Сбрасывается в run().
  private readFileMaxLine = new Map<string, number>()

  // ToolDispatcher — делегирует выполнение тулов и владеет mutable state
  // (readFileCache, fileCache, filesReadInSession, readFileMaxLine, fileMap,
  // lastShellCwd, commandsRun, undoStack, pendingDiffEntries).
  private toolDispatcher: ToolDispatcher

  /**
   * Синхронизирует workdir/projectId/chatId/gateway-поля/колбэки в ToolDispatcher.
   * Вызывается ПОСЛЕ установки полей Agent'а (в ai-worker.ts поля
   * workdir/projectId/chatId устанавливаются после конструктора, но
   * ToolDispatcher создаётся в конструкторе и не получает их).
   */
  syncToolDispatcher(): void {
    this.toolDispatcher.workdir = this.workdir
    this.toolDispatcher.projectId = this.projectId
    this.toolDispatcher.chatId = this.chatId
    this.toolDispatcher.gatewayToken = this.gatewayToken
    this.toolDispatcher.gatewayApiUrl = this.gatewayApiUrl
    this.toolDispatcher.onUpdateWorkingMemory = this.onUpdateWorkingMemory
    this.toolDispatcher.onGetWorkingMemory = this.onGetWorkingMemory
    this.toolDispatcher.onFileChanged = this.onFileChanged
  }

  constructor(store: Store, role: 'main' | 'subagent' = 'main') {
    this.store = store
    this.role = role
    this.client = new AIClient(store)
    this.toolDispatcher = new ToolDispatcher({
      store,
      workdir: this.workdir,
      projectId: this.projectId,
      chatId: this.chatId,
      gatewayToken: this.gatewayToken,
      gatewayApiUrl: this.gatewayApiUrl,
      onUpdateWorkingMemory: this.onUpdateWorkingMemory,
      onGetWorkingMemory: this.onGetWorkingMemory,
    })
  }

  async run(
    userMessage: string,
    callbacks: AgentCallbacks,
    maxSteps = 8,
    signal?: AbortSignal,
    systemPrompt?: string,
    history?: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string; thinking_blocks?: Array<{ thinking: string; signature: string }>; reasoning_content?: string }>,
    toolSchemas?: typeof TOOL_SCHEMAS,
    options?: AgentRuntimeOptions
  ): Promise<void> {
    const EFFECTIVE_MAX_STEPS = 1024
    void maxSteps
    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt || FALLBACK_SYSTEM_PROMPT },
      ...(history ?? []).map(m => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
        ...(m.thinking_blocks ? { thinking_blocks: m.thinking_blocks } : {}),
        ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
      })),
      {
        role: 'user',
        // Если есть imageParts (основная модель поддерживает vision) —
        // передаём картинки напрямую как multipart content (image_url блоки +
        // текст). Иначе — обычный строковый content (возможно с текстовым
        // описанием картинок от vision-модели).
        content: options?.imageParts && options.imageParts.length > 0
          ? [...options.imageParts, { type: 'text' as const, text: userMessage }]
          : userMessage,
      },
    ]

    const modifiedFiles = new Set<string>()
    let successfulEditCount = 0
    let lastVerifiedEditCount = 0
    this.readFileCache = new Map<string, string>()
    this.pendingDiffEntries = []
    this.fileMap = new Map()
    this.readFileMaxLine = new Map()
    // recentToolFingerprints / loopGuardHits НЕ сбрасываем между run() —
    // session-level loop detection ловит зацикливание через несколько
    // turn'ов пользователя (модель «по кд» повторяет одно и то же в
    // разных сообщениях). recentErrorFingerprints сбрасываем — ошибки
    // привязаны к конкретному контексту/файлу, между turn'ами они unrelated.
    this.recentErrorFingerprints = []
    this.recentParseFailures = []
    // Инициализируем персистентный кэш из снимка (передаётся из main через worker)
    this.fileCache = new Map(Object.entries(options?.fileCacheSnapshot ?? {}))
    // ── Session-level Map caps (anti-leak) ──────────────────────────────
    // recentToolFingerprints / loopGuardHits / filesReadInSession / fileCache
    // НЕ сбрасываются между run() (session-level loop detection). Но за долгую
    // сессию они растут бесконечно. Обрезаем в начале каждого run() — оставляем
    // только последние N записей, достаточно для loop-detection.
    if (this.recentToolFingerprints.length > 50) {
      this.recentToolFingerprints = this.recentToolFingerprints.slice(-30)
    }
    if (this.loopGuardHits.size > 100) {
      // Оставляем последние 60 записей (самые актуальные тулы)
      const entries = [...this.loopGuardHits.entries()].slice(-60)
      this.loopGuardHits = new Map(entries)
    }
    if (this.filesReadInSession.size > 200) {
      // Чистим старейшие — Set упорядочен по вставке
      const toRemove = this.filesReadInSession.size - 150
      let removed = 0
      for (const key of this.filesReadInSession) {
        if (removed >= toRemove) break
        this.filesReadInSession.delete(key)
        removed++
      }
    }
    if (this.fileCache.size > 40) {
      // LRU eviction: оставляем последние 25 записей (самые свежие чтения)
      const entries = [...this.fileCache.entries()].slice(-25)
      this.fileCache = new Map(entries)
    }
    if (this.undoStack.length > 100) {
      this.undoStack = this.undoStack.slice(-50)
    }
    const ctxSettings = getContextSettings(this.store.get('contextSettings') as Partial<import('../context/contextManager').ContextSettings> ?? {})
    const activeSchemas = (toolSchemas ?? TOOL_SCHEMAS) as Array<{ function: { name: string; parameters?: { required?: string[] } } }>
    const autoMemoryInterval = Math.max(0, options?.autoMemoryInterval ?? 0)
    const maxRepeatedToolCalls = Math.max(2, options?.maxRepeatedToolCalls ?? 3)
    const maxRepeatedErrors = Math.max(2, options?.maxRepeatedErrors ?? 2)
    // planningMode — для явного напоминания в defense-in-depth (executeTool),
    // когда модель галлюцинирует вызовы тулов, отсутствующих в activeSchemas.
    const planningMode = !!options?.planningMode
    const persona = options?.persona
    const personaReadonly = persona ? isReadonlyPersona(persona) : false
    const personaAllowed = persona ? getPersonaAllowedTools(persona) : undefined
    // §roles — sub-agent role for defense-in-depth (blockedMsg when model
    // hallucinates a tool outside the role's allowlist).
    const subagentRole = options?.subagentRole
    const subagentRoleDef = subagentRole ? getSubagentRole(subagentRole) : undefined
    // Реальный лимит контекста активной модели — для аварийного клапана.
    // Раньше здесь был Math.max(32_000, realContextWindow) — искусственный пол,
    // который мог занижать эффективный лимит для моделей с честным большим
    // окном (128k/200k/1M) до 32k, если резолвинг возвращал что-то маленькое,
    // и заставлял клапан срабатывать намного раньше, чем должен. Убран:
    // getModelContextWindow уже имеет собственный безопасный дефолт (128_000).
    const realContextWindow = getModelContextWindow({
      modelAssignments: this.store.get('modelAssignments'),
      customModels: this.store.get('customModels'),
    }, this.role)
    log('[Agent] run() старт: role=%s realContextWindow=%s', this.role, realContextWindow)
    // Аварийный клапан — последняя линия защиты от hard-fail API (см.
    // getHardLimitTokens/getHardLimitTargetTokens в usageTracker.ts).
    // targetTokens — куда дропаем при срабатывании (с запасом, гистерезис),
    // чтобы клапан не срабатывал повторно на следующем же раунде тулов.
    const hardLimitTokens = getHardLimitTokens(realContextWindow)
    const hardLimitTargetTokens = getHardLimitTargetTokens(realContextWindow)

    const flushWorkingMemory = (label: string) => {
      if (!this.chatId || !this.onUpdateWorkingMemory || this.role !== 'main') return
      const existing = this.onGetWorkingMemory ? this.onGetWorkingMemory(this.chatId) : ''
      const structured = updateStructuredMemory(existing, {
        lastTask: label.slice(0, 200),
        modifiedFiles: Array.from(modifiedFiles),
        diffEntries: ctxSettings.diffJournalEnabled
          ? this.pendingDiffEntries.slice(-ctxSettings.diffJournalLines * 2)
          : [],
        fileMap: ctxSettings.fileMapEnabled ? this.fileMap : undefined,
      })
      this.onUpdateWorkingMemory(this.chatId, structured, 'replace')
    }

    // Счётчик последовательных ошибочных раундов (API/сеть). Раньше outer
    // catch делал continue без лимита — при "превышено число попыток"
    // (chatWithTools ретраит 5 раз и кидает) outer ловил, push user message,
    // continue → снова 5 ретраев → снова throw → бесконечно до maxSteps=50.
    // Это 50×5=250 запросов, "ожидание ответа" крутится часами, а контекст
    // растёт от user-сообщений об ошибках. Теперь лимит 3 — после 3 ошибочных
    // раундов подряд останавливаемся с onError.
    let consecutiveErrors = 0
    const MAX_CONSECUTIVE_ERRORS = 3

    for (let step = 0; ; step++) {
      if (signal?.aborted) {
        callbacks.onDone('')
        return
      }

      // maxSteps раньше принимался как параметр, но никогда не проверялся —
      // цикл был фактически бесконечным (агент мог гонять тулы неограниченно
      // долго без реального прогресса, что выглядело как "зависание").
      // Теперь это реальный потолок: по достижении отдаём частичный ответ.
      if (step >= EFFECTIVE_MAX_STEPS) {
        console.log('[Agent] maxSteps=%s reached, finishing with partial answer', EFFECTIVE_MAX_STEPS)
        log('[Agent] run() достигнут maxSteps=%s, завершаю с частичным ответом', EFFECTIVE_MAX_STEPS)
        callbacks.onStep({
          type: 'tool_result',
          toolName: '_limit',
          content: `Reached the agent step limit (${EFFECTIVE_MAX_STEPS}). Wrap up the current work: briefly summarize what is done, what remains, and suggest next steps. The user can say "continue" — the history will persist.`,
          success: false,
        })
        callbacks.onDone(
          `Reached the limit of ${EFFECTIVE_MAX_STEPS} agent steps.\n\n**Done:** ${this._summarizeProgress(modifiedFiles)}\n\n**Remaining:** see the plan above (unfinished items).\n\nSay "continue" — I will pick up from the same spot. For large tasks it is more efficient to delegate via spawn_agent, so as not to hit the limit.`,
          this.buildSummaryDetails(modifiedFiles),
        )
        return
      }

      try {
        callbacks.onStatus?.('Waiting for response...')
        console.log('[Agent] round %s/%s: chatWithTools start (messages=%d, tools=%d)', step, EFFECTIVE_MAX_STEPS, messages.length, (toolSchemas ?? TOOL_SCHEMAS).length)
        log('[Agent] round %s/%s: chatWithTools start (messages=%d, tools=%d)', step, EFFECTIVE_MAX_STEPS, messages.length, (toolSchemas ?? TOOL_SCHEMAS).length)
        // Защитный таймаут по бездействию на раунд chatWithTools. Если
        // провайдер принял запрос, но stream завис (TCP open, нет данных) —
        // for-await(chunk) висит вечно, signal не abort'ится, "Ожидаю
        // ответа..." крутится часами без ошибки. OVERALL_TIMEOUT_MS
        // внутри chatWithTools срабатывает только между retry-попытками,
        // а сам stream-await его не проверяет.
        //
        // Раньше был АБСОЛЮТНЫЙ таймаут 90с — но он ложно срабатывал на
        // длинных reasoning-стримах (GLM стримит reasoning 80+ секунд) и
        // убивал нормальный агент-ран. Теперь таймер сбрасывается на
        // каждом входящем токене (answer/thinking) — срабатывает ТОЛЬКО
        // при реальном зависании стрима (нет данных N секунд подряд).
        // Порог 220с — покрывает медленных провайдеров и долгий reasoning,
        // но ловит реально мёртвые соединения.
        const INACTIVITY_TIMEOUT_MS = 220 * 1000
        let inactivityTimer: ReturnType<typeof setTimeout> | null = null
        let inactivityReject: ((e: Error) => void) | null = null
        const inactivityTimeoutPromise = new Promise<never>((_, reject) => {
          inactivityReject = reject
        })
        const resetInactivityTimer = () => {
          if (inactivityTimer) clearTimeout(inactivityTimer)
          inactivityTimer = setTimeout(() => {
            log('[Agent] round %s: inactivity timeout fired (%ds без токенов)', step, Math.round(INACTIVITY_TIMEOUT_MS / 1000))
            inactivityReject?.(new Error(`chatWithTools round: no data from the provider for ${Math.round(INACTIVITY_TIMEOUT_MS / 1000)}s — the stream may be stuck.`))
          }, INACTIVITY_TIMEOUT_MS)
        }
        resetInactivityTimer()
        let response!: Awaited<ReturnType<typeof this.client.chatWithTools>>
        try {
          response = await Promise.race([
            this.client.chatWithTools(
              messages,
              toolSchemas ?? TOOL_SCHEMAS,
              signal,
              this.role,
              (token) => { resetInactivityTimer(); callbacks.onStep({ type: 'answer', content: token }) },
              callbacks.onContextCounted,
              (waitSec) => {
                resetInactivityTimer()
                callbacks.onStatus?.(`Rate limit — waiting ${waitSec}s...`)
                callbacks.onRateLimit?.(waitSec)
              },
              (attempt, reason, waitSec, maxAttempts) => {
                resetInactivityTimer()
                callbacks.onStatus?.(reason === 'rate_limit'
                  ? `Rate limit — waiting ${waitSec}s...`
                  : `Network error, retry ${attempt}${maxAttempts ? `/${maxAttempts}` : ''}...`)
                callbacks.onRetry?.(attempt, reason, waitSec, maxAttempts)
              },
              callbacks.onUsage,
              (tok) => { resetInactivityTimer(); callbacks.onThinkingToken?.(tok) },
              callbacks.onThinkingDone,
              (index, rawToolName) => {
                const normalizedName = normalizeToolName(rawToolName, activeSchemas)
                const isHidden = normalizedName === 'think' || normalizedName === 'update_working_memory' || normalizedName === 'update_todo'
                if (isHidden) return
                callbacks.onStep({
                  type: 'tool_call_pending',
                  toolName: normalizedName,
                  content: normalizedName,
                  callId: `pending-${step}-${index}`,
                })
              },
            ),
            inactivityTimeoutPromise,
          ])
        } finally {
          if (inactivityTimer) clearTimeout(inactivityTimer)
        }

        if (signal?.aborted) {
          callbacks.onDone('')
          return
        }

        // Раунд прошёл успешно (chatWithTools не бросил) — сбрасываем
        // счётчик последовательных ошибок.
        consecutiveErrors = 0
        console.log('[Agent] round %s: chatWithTools OK — tool_calls=%d, content=%d chars', step, response.tool_calls?.length ?? 0, (response.content || '').length)
        log('[Agent] round %s: chatWithTools OK — tool_calls=%d, content=%d chars', step, response.tool_calls?.length ?? 0, (response.content || '').length)

        if (!response.tool_calls?.length) {
          const answer = response.content || ''
          console.log('[Agent] no tool_calls: answer=%d chars, reasoning=%s', answer.length, response.reasoning ? `${response.reasoning.length} chars` : 'none')

          // ── Защита от пустого ответа после reasoning ──
          // Модель (например GLM) может стримить reasoning 80+ секунд,
          // исчерпать лимит и завершить стрим с пустым content.
          // В этом случае НЕ завершаем — продолжаем цикл, даём модели
          // шанс дать ответ, добавив assistant-сообщение с reasoning
          // и user-промпт "продолжи".
          if (!answer.trim() && !signal?.aborted) {
            console.log('[Agent] empty answer after reasoning, emptyRetries=%d', (messages.filter(m =>
              m.role === 'user' && typeof m.content === 'string' &&
              m.content.startsWith('[empty-reasoning-retry]')
            ).length))
            // Считаем, сколько раз уже пытались продолжить — чтобы не зациклиться
            const emptyRetries = (messages.filter(m =>
              m.role === 'user' && typeof m.content === 'string' &&
              m.content.startsWith('[empty-reasoning-retry]')
            ).length)
            if (emptyRetries < 2) {
              // Добавляем assistant-сообщение (чтобы модель видела свой reasoning)
              // ВАЖНО: reasoning должен вернуться как reasoning_content, а не как
              // content. Строгие провайдеры thinking-mode (GLM/LiteLLM proxy)
              // требуют, чтобы assistant-сообщение, в котором модель выдала
              // reasoning_content, при следующем запросе возвращалось обратно
              // с этим полем — иначе 400 "reasoning_content in thinking mode
              // must be passed back to the API". Раньше reasoning пихался в
              // content, что ломало следующий раунд.
              messages.push({
                role: 'assistant',
                content: '',
                ...(response.reasoning ? { reasoning_content: response.reasoning } : {}),
              })
              messages.push({
                role: 'user',
                content: '[empty-reasoning-retry] Your previous answer contained only reasoning but no final answer. Give a brief answer to the task without re-reasoning.',
              })
              continue
            }
            // Если уже дважды пытались — завершаем с пустым ответом
          log('[Agent] DONE: answer=%d chars, steps=%d, files=%d', answer.length, step, modifiedFiles.size)
          console.log('[Agent] DONE: answer=%d chars, steps=%d, files=%d', answer.length, step, modifiedFiles.size)
          callbacks.onDone(answer, this.buildSummaryDetails(modifiedFiles))
            return
          }

          // Reasoning уже стримится через onThinkingToken/onThinkingDone.
          // Fallback: если стриминг не настроен, шлём одним блоком.
          if (response.reasoning && !callbacks.onThinkingToken) {
            callbacks.onStep({ type: 'thought', content: response.reasoning })
          }

          if (!response.hadStreamedTokens) {
            const words = answer.split(/(?<=\s)|(?=\s)/)
            for (const chunk of words) {
              if (signal?.aborted) {
                callbacks.onDone(answer)
                return
              }
              callbacks.onStep({ type: 'answer', content: chunk })
            }
          }

          callbacks.onDone(answer, this.buildSummaryDetails(modifiedFiles))

          if (this.chatId && this.onUpdateWorkingMemory && this.role === 'main') {
            const existing = this.onGetWorkingMemory ? this.onGetWorkingMemory(this.chatId) : ''
            if (modifiedFiles.size > 0) {
              const structured = updateStructuredMemory(existing, {
                lastTask: answer.slice(0, 200),
                modifiedFiles: Array.from(modifiedFiles),
                diffEntries: ctxSettings.diffJournalEnabled ? this.pendingDiffEntries : [],
                fileMap: ctxSettings.fileMapEnabled ? this.fileMap : undefined,
              })
              this.pendingDiffEntries = []
              this.onUpdateWorkingMemory(this.chatId, structured, 'replace')
            } else if (this.fileMap.size > 0 && ctxSettings.fileMapEnabled) {
              const structured = updateStructuredMemory(existing, {
                lastTask: answer.slice(0, 200),
                modifiedFiles: [],
                diffEntries: [],
                fileMap: this.fileMap,
              })
              this.onUpdateWorkingMemory(this.chatId, structured, 'replace')
            }
          }

          return
        }

        messages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.tool_calls,
          // Anthropic extended thinking: blocks MUST be echoed back in
          // subsequent rounds alongside the assistant's tool_use, with the
          // original signature — otherwise Anthropic API returns 400 on
          // the next request. We preserve them here; convertMessagesToAnthropic
          // renders them as {type:'thinking', thinking, signature} blocks.
          ...(response.thinking_blocks ? { thinking_blocks: response.thinking_blocks } : {}),
          // OpenAI-compatible reasoning_content (GLM/DeepSeek/Qwen thinking
          // mode). Same round-trip requirement as Anthropic thinking_blocks:
          // strict providers (LiteLLM proxy for glm-*) return 400 if the
          // assistant turn that produced reasoning_content is echoed back
          // without the field in the next round of the same agent loop.
          ...(response.reasoning ? { reasoning_content: response.reasoning } : {}),
        })
        console.log('[Agent] tool_calls=%d, executing...', response.tool_calls.length)

        const resultMap = new Map<string, { contentForAI: string; callId: string; name: string }>()
        const pendingMutations: Array<() => void> = []

        const normalizedCalls: NormalizedToolCall[] = response.tool_calls.map((call, callIndex) => {
          const fn = (call as { function: { name: string; arguments: string } }).function
          const callObj = call as { id: string }
          // Если стрим оборвался до того, как провайдер прислал id этого
          // tool_call, id остаётся пустой строкой — она тоже навсегда
          // попадёт в историю (assistant.tool_calls[].id и следующее
          // tool_call_id) и может быть отвергнута строгим провайдером как
          // невалидный tool_call_id. Генерируем стабильный id и мутируем
          // call.id — та же ссылка, что уже в messages.
          if (!callObj.id) {
            callObj.id = `call_${Date.now()}_${callIndex}`
          }
          const callId = callObj.id
          // response.tool_calls собран из toolCallMap (AIClient.ts) через
          // Object.values — числовые ключи объекта итерируются по возрастанию,
          // так что callIndex здесь совпадает с tc.index из onToolCallStarted.
          const pendingCallId = `pending-${step}-${callIndex}`
          const rawName = fn.name
          const normalizedName = normalizeToolName(rawName, activeSchemas)
          if (normalizedName !== rawName) {
            console.warn(`[Agent] Auto-repaired tool name: '${rawName}' -> '${normalizedName}'`)
          }
          fn.name = normalizedName

          let args: Record<string, unknown> = {}
          let parseError: { message: string; snippet: string } | undefined
          try {
            args = fn.arguments ? JSON.parse(fn.arguments) : {}
          } catch (parseErr) {
            // Раньше здесь был пустой catch {} — при битом/усечённом JSON
            // (например, после серии сетевых ретраев или обрыва стрима у
            // провайдера) args тихо становился {}, и дальше это выглядело
            // как "модель не умеет пользоваться тулом", хотя проблема была
            // в повреждённом ответе провайдера. Логируем сырые arguments,
            // чтобы отличать "модель реально не передала path" от
            // "JSON пришёл обрезанным/невалидным".
            log('[Agent] JSON.parse tool arguments упал для %s: %s | raw=%s',
              normalizedName, (parseErr as Error).message, (fn.arguments ?? '').slice(0, 500))
            // Phase 2: попытка починить битый JSON. Три слоя, ПОСЛЕДОВАТЕЛЬНО:
            //   1) tryRepairJson (регексы) — чинит enum-опечатки и незакавыченные
            //      значения (mode: str_replace" → "mode": "str_replace").
            //      Работает ПЕРВЫМ, т.к. jsonrepair путается в незакавыченных
            //      enum-значениях с остаточной кавычкой (str_replace").
            //   2) jsonrepair (программный парсер) — чинит структуру: усечённый
            //      стрим (незакрытые строки, missing }), trailing comma, и т.д.
            //      Работает на РЕЗУЛЬТАТЕ tryRepairJson, не на оригинале.
            //   3) salvageEditFileArgs — последний шанс для edit_file: извлекает
            //      path, old_str, new_str регексом, mode дефолтит к str_replace.
            // Если ремонт успешен — тул выполняется, модель не знает о проблеме.
            if (fn.arguments) {
              let repaired = false
              let workingJson = fn.arguments
              // Слой 1: tryRepairJson — enum-опечатки и незакавыченные значения.
              const repair = tryRepairJson(workingJson)
              if (repair.fixed) {
                workingJson = repair.repaired
                log('[Agent] tryRepairJson fixes для %s: [%s]',
                  normalizedName, repair.fixes.join(', '))
              }
              // Слой 2: jsonrepair — структурный ремонт (усечение, скобки).
              // Работает на результате tryRepairJson.
              try {
                const jsonrepairResult = jsonrepair(workingJson)
                args = JSON.parse(jsonrepairResult)
                repaired = true
                log('[Agent] jsonrepair OK для %s (after tryRepairJson: %s)',
                  normalizedName, repair.fixed ? repair.fixes.join(', ') : 'no pre-fixes')
              } catch (jsonrepairErr) {
                log('[Agent] jsonrepair не удался для %s: %s',
                  normalizedName, (jsonrepairErr as Error).message)
              }
              // Слой 3: salvage для edit_file — извлекаем path, old_str, new_str регексом.
              if (!repaired && normalizedName === 'edit_file') {
                const salvaged = salvageEditFileArgs(fn.arguments)
                if (salvaged) {
                  args = salvaged
                  repaired = true
                  log('[Agent] edit_file SALVAGE для %s: path=%s, old_str len=%d',
                    normalizedName, salvaged.path, String(salvaged.old_str).length)
                }
              }
              if (!repaired) {
                parseError = {
                  message: (parseErr as Error).message,
                  snippet: (fn.arguments ?? '').slice(0, 200),
                }
              }
            }
          }

          // КРИТИЧНО: fn — та же ссылка, что уже лежит внутри объекта,
          // запушенного в messages (строка выше, response.tool_calls).
          // Если оставить сырой fn.arguments (пустая строка/битый JSON от
          // обрыва стрима у провайдера), это НАВСЕГДА оседает в истории
          // диалога — sendDone() сохраняет toolSteps в БД, а следующий
          // chat:send разворачивает их обратно в такое же сообщение
          // (messageToContextMessages в chat.ipc.ts). Строгие провайдеры
          // (litellm-прокси для glm и т.п.) валидируют, что function.arguments
          // — синтаксически валидный JSON, и после этого начинают отвечать
          // 400 BadRequestError на КАЖДЫЙ следующий запрос в этом чате —
          // чат становится непригодным без возможности восстановиться.
          // Перезаписываем на гарантированно валидный JSON (то, что реально
          // распарсили и на чём агент будет исполнять тул) — так история
          // остаётся консистентной независимо от того, что вернул провайдер.
          fn.arguments = JSON.stringify(args)

          return {
            call,
            callId,
            fn,
            args,
            parseError,
            // update_todo тоже всегда возвращает hidden:true результат (см. case
            // 'update_todo' ниже) — если сам tool_call не помечен hidden, его
            // блок навсегда остаётся в UI без результата (ai-worker.ts не шлёт
            // hidden tool_result), и оставшийся "сирота" забирает чужую ошибку
            // через fallback-матчинг в ToolChain.tsx.
            isHiddenTool: normalizedName === 'think' || normalizedName === 'update_working_memory' || normalizedName === 'update_todo',
            pendingCallId,
          }
        })

        const executeCall = async (item: NormalizedToolCall) => {
          const { callId, fn, isHiddenTool, pendingCallId, parseError } = item
          let args = item.args
          // Ключ loop-guard для сброса при успешном выполнении (Fix 3).
          // Если тул успешно выполнился — счётчик guard-хитов для этого
          // fingerprint сбрасывается: модель вышла из лупа, не нужно
          // держать прошлые неудачи против неё весь session.
          let loopGuardBlockKey: string | null = null
          if (!isHiddenTool) {
            const fingerprint = buildToolFingerprint(fn.name, args)
            loopGuardBlockKey = `${fingerprint.toolName}|${fingerprint.argsKey}`

            // Auto-advance: read_file без offset на уже прочитанном файле (≥400
            // строк) вернёт ДРУГОЙ чанк (401-800, 801-1200, ...) — это НЕ
            // повтор. Не пушим fingerprint в recentToolFingerprints, иначе
            // loop guard ложно срабатывает: видит N одинаковых fingerprint'ов
            // (path одинаковый, offset/limit отсутствуют) и блокирует тул,
            // хотя каждый вызов возвращал уникальный контент.
            let isReadFileAutoAdvance = false
            if (fn.name === 'read_file' && args.offset === undefined) {
              let autoAbsPath: string
              try { autoAbsPath = resolve(this.workdir ?? process.cwd(), args.path as string) } catch { autoAbsPath = args.path as string }
              isReadFileAutoAdvance = (this.readFileMaxLine.get(autoAbsPath) ?? 0) > 0
            }

            if (!isReadFileAutoAdvance) {
              this.recentToolFingerprints.push(fingerprint)
              // Окно 8 (вместо 3) позволяет ловить чередования вида
              // A,B,A,B,A,B — 2 уникальных fingerprint'а на 8 записей.
              // При окне 3 окно [B,A,B] / [A,B,A] никогда не совпадало
              // полностью → guard не срабатывал на пинг-понге.
              if (this.recentToolFingerprints.length > 8) {
                this.recentToolFingerprints.shift()
              }
              const fpCount = this.recentToolFingerprints.length
              const repeatedCalls = fpCount >= maxRepeatedToolCalls &&
                this.recentToolFingerprints.every(entry =>
                  entry.toolName === fingerprint.toolName && entry.argsKey === fingerprint.argsKey,
                )
              // Чередование: в окне ≥6 записей всего 2 уникальных fingerprint'а,
              // и оба повторяются ≥2 раза. Ловит A,B,A,B / A,B,C,A,B,C и т.п.
              const alternation = fpCount >= 6 && (() => {
                const keys = this.recentToolFingerprints.map(f => `${f.toolName}|${f.argsKey}`)
                const unique = new Set(keys)
                if (unique.size !== 2) return false
                const counts = new Map<string, number>()
                for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
                return [...counts.values()].every(c => c >= 2)
              })()
              if (repeatedCalls || alternation) {
                // Считаем сколько раз подряд сработал guard на этом тул+args.
                // 1-2 раза — мягкое предупреждение (текст в messages).
                // 3+ раза (т.е. 3× maxRepeatedToolCalls = 9 фактических вызовов) —
                // hard block: тул НЕ выполняется, возвращаем ошибку в AI.
                const blockKey = `${fingerprint.toolName}|${fingerprint.argsKey}`
                const guardHits = (this.loopGuardHits.get(blockKey) ?? 0) + 1
                this.loopGuardHits.set(blockKey, guardHits)
                // edit_file exempt от hard block: тул имеет undo-stack,
                // возвращает diff, не деструктивен. Hard block убивал
                // edit_file на весь session из-за ложных срабатываний
                // (правки в конце SEARCH-блока давали тот же fingerprint).
                // Soft warning остаётся — модель видит "ты повторяешь".
                const hardBlock = guardHits >= 3 && fn.name !== 'edit_file'
                const loopMsg = alternation
                  ? `Loop guard: you are alternating ${fingerprint.toolName} with another tool in a loop (${fpCount} recent calls, 2 unique). Change strategy: analyze what is already done and choose a different approach.`
                  : `Loop guard: you repeated ${fn.name} with effectively the same arguments ${maxRepeatedToolCalls} times. Stop retrying it unchanged and switch strategy.`
                messages.push({
                  role: 'user',
                  content: hardBlock
                    ? `${loopMsg}\n\nATTENTION: tool "${fn.name}" is blocked for this run() after ${guardHits} loop-guard warnings (${guardHits * maxRepeatedToolCalls} actual calls). It was NOT executed. Change strategy or ask the user.`
                    : loopMsg,
                })
                callbacks.onStep({
                  type: 'tool_result',
                  toolName: '_loop_guard',
                  content: hardBlock
                    ? `${fn.name} blocked after ${guardHits * maxRepeatedToolCalls} repeats (hard loop guard).`
                    : fn.name === 'edit_file'
                      ? `${fn.name} repeated ${maxRepeatedToolCalls} times with similar arguments — warning ${guardHits}. Reread the file and use the exact content in old_str.`
                      : `${fn.name} repeated ${maxRepeatedToolCalls} times with the same arguments — warning ${guardHits}/3. Hard block after 3.`,
                  success: false,
                })
                if (hardBlock) {
                  resultMap.set(callId, {
                    contentForAI: `Hard loop guard: tool "${fn.name}" is blocked — repeated ${guardHits * maxRepeatedToolCalls} times with the same/similar arguments. The call was NOT executed. Change strategy: use a different tool, different arguments, or ask the user.`,
                    callId,
                    name: fn.name,
                  })
                  callbacks.onStep({
                    type: 'tool_result',
                    toolName: fn.name,
                    content: '[Blocked by loop guard — tool not executed]',
                    success: false,
                    callId,
                    hidden: isHiddenTool,
                  })
                  return
                }
              }
            }
          }
          callbacks.onStep({ type: 'tool_call', toolName: fn.name, toolArgs: args, content: fn.name, callId, hidden: isHiddenTool, pendingCallId, serverName: extractMcpServerName(fn.name) })

          // Phase 1 + Phase 3: JSON parse failure — точное сообщение вместо
          // вводящего в заблуждение "missing required arguments". Без этого
          // модель видит args={} в истории, думает что забыла передать path/mode,
          // и повторяет тот же битый JSON → бесконечный цикл (14+ раундов в логах).
          if (parseError) {
            const parseFp = `${fn.name}:${parseError.message.slice(0, 80)}`
            this.recentParseFailures.push(parseFp)
            if (this.recentParseFailures.length > 4) this.recentParseFailures.shift()

            // Phase 3: одинаковые parse failure подряд → эскалация.
            // 2 одинаковых → soft warning (тул не выполняется, но не блокируется).
            // 3+ одинаковых → hard block, НО только для деструктивных тулов.
            // Non-destructive тулы (save_memory, update_todo, ask_user, ...)
            // никогда не hard-block: блокировка save_memory на весь run
            // лишает модель возможности сохранить результат работы.
            const parseFailCount = this.recentParseFailures.filter(e => e === parseFp).length
            const parseRepeated = parseFailCount >= 2
            if (parseRepeated) {
              const isNonDestructive = NON_DESTRUCTIVE_TOOLS.has(fn.name)
              // Hard block: 3+ одинаковых parse failure И тул деструктивный.
              const shouldHardBlock = parseFailCount >= 3 && !isNonDestructive

              if (shouldHardBlock) {
                const hardStopMsg = `Loop guard: ${fn.name} produced invalid JSON ${parseFailCount} times. The tool is blocked for this run. Explain the issue to the user — you may need to simplify the edit, use a different edit mode, or split the work into smaller steps.`
                messages.push({ role: 'user', content: hardStopMsg })
                resultMap.set(callId, {
                  contentForAI: `${hardStopMsg}\n\nLast parse error: ${parseError.message}\nYou sent (first 200 chars): ${parseError.snippet}`,
                  callId,
                  name: fn.name,
                })
                callbacks.onStep({
                  type: 'tool_result',
                  toolName: '_loop_guard',
                  content: `${fn.name} produced invalid JSON ${parseFailCount} times — blocked. Parse error: ${parseError.message}`,
                  success: false,
                })
                callbacks.onStep({
                  type: 'tool_result',
                  toolName: fn.name,
                  content: `[Blocked: invalid JSON ${parseFailCount}× — ${parseError.message}]`,
                  success: false,
                  callId,
                  hidden: isHiddenTool,
                })
                return
              } else {
                // Soft warning — для ВСЕХ non-destructive тулов и для
                // 2-го удара любых тулов. Тул не выполняется (args={}
                // т.к. ремонт провалился), но модель НЕ блокируется —
                // может retry с другим JSON в следующем раунде.
                const softMsg = `Loop guard (soft): ${fn.name} produced invalid JSON ${parseFailCount} times. Parse error: ${parseError.message}. You sent (first 200 chars): ${parseError.snippet}. Please retry with valid JSON — make sure all string values are properly quoted (e.g. "mode": "str_replace", not "mode": str_replace).`
                messages.push({ role: 'user', content: softMsg })
                resultMap.set(callId, {
                  contentForAI: softMsg,
                  callId,
                  name: fn.name,
                })
                callbacks.onStep({
                  type: 'tool_result',
                  toolName: '_loop_guard',
                  content: `${fn.name} produced invalid JSON ${parseFailCount} times — soft warning${isNonDestructive ? ` (${fn.name} exempt from hard block)` : ` (${parseFailCount}/3 before hard block)`}. Parse error: ${parseError.message}`,
                  success: false,
                })
                callbacks.onStep({
                  type: 'tool_result',
                  toolName: fn.name,
                  content: `[Soft warning: invalid JSON ${parseFailCount}× — ${parseError.message}. Tool not executed, but not blocked — retry with valid JSON.]`,
                  success: false,
                  callId,
                  hidden: isHiddenTool,
                })
                return
              }
            }

            // Phase 1: точное сообщение об ошибке парсинга
            const parseMsg = `${fn.name}: your tool call arguments were not valid JSON. Parse error: ${parseError.message}. You sent (first 200 chars): ${parseError.snippet}. Please retry with valid JSON — make sure all string values are properly quoted (e.g. "mode": "str_replace", not "mode": str_replace").`
            resultMap.set(callId, { contentForAI: parseMsg, callId, name: fn.name })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: parseMsg, success: false, callId, hidden: isHiddenTool })
            return
          }

          // ── Schema-aware валидация: type coercion, enum fuzzy-fix, defaults ──
          // Применяется ПОСЛЕ findMissingRequiredArgs (required уже проверены),
          // но ДО выполнения тула. Чинит типы (string→number), опечатки в enum
          // (закавыченные, которые tryRepairJson не ловит), заполняет дефолты.
          // Если есть непреодолимые ошибки (невалидный enum без близкого матча) —
          // возвращаем ошибку модели с конкретным описанием.
          const validation = validateAndCoerceArgs(fn.name, args, activeSchemas)
          if (validation.fixes.length > 0) {
            // Тихо применяем исправленные args
            args = validation.args
            // Перезаписываем fn.arguments валидным JSON — консистентность истории
            fn.arguments = JSON.stringify(args)
          }
          if (validation.errors.length > 0) {
            const errMsg = `${fn.name}: argument validation failed:\n  - ${validation.errors.join('\n  - ')}\n\nRepeat the call with valid argument types.`
            resultMap.set(callId, { contentForAI: errMsg, callId, name: fn.name })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: errMsg, success: false, callId, hidden: isHiddenTool })
            return
          }
          const missingArgs = findMissingRequiredArgs(fn.name, args, activeSchemas)
          if (missingArgs.length > 0) {
            const missingMsg = formatMissingArgsMessage(fn.name, missingArgs)
            resultMap.set(callId, { contentForAI: missingMsg, callId, name: fn.name })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: missingMsg, success: false, callId, hidden: isHiddenTool })
            return
          }

          // Defense-in-depth: rejecting tool calls for tools not present in
          // activeSchemas. Some LLM providers do not strictly filter tool_calls
          // against the provided schemas (especially when the history contains
          // such calls) — the model can hallucinate write_file/run_command even
          // in plan/ask/side-chat/oneShot modes where these tools are excluded
          // from schemas. Without this guard, executeTool's switch(name) would
          // execute them anyway. MCP tools (mcp__*) are also included in
          // activeSchemas via mcpTools, so the check covers them too.
          const schemaNameSet = new Set(activeSchemas.map(s => s.function.name))
          if (!schemaNameSet.has(fn.name)) {
            const allowed = [...schemaNameSet].join(', ')
            // В planning-режиме даём явное напоминание вместо generic-блока —
            // модель могла скопировать edit/run тулы из старой истории чата.
            const blockedMsg = planningMode
              ? `You are in PLANNING MODE (read-only). "${fn.name}" is forbidden — edit/write/run tools are unavailable. Return to the protocol: Step 2 — read-only research (get_fast_context, read_file, search_code, analyze_project, spawn_agent) + ask_user about hard parts. Step 3 — plan inside <plan title="..." summary="...">…</plan> with per-phase Ownership/Verification/Edge cases. Step 4 — review against the original request. Allowed tools: ${allowed}. Do not call "${fn.name}" again.`
              : subagentRoleDef
                ? `You are a ${subagentRoleDef.nameEn} sub-agent. "${fn.name}" is not available for this role. Allowed tools: ${allowed}. Sub-agents CANNOT spawn nested sub-agents — if the task genuinely needs "${fn.name}", report this to the parent agent. Do not call "${fn.name}" again.`
                : personaAllowed
                  ? `You are in the ${persona} persona. "${fn.name}" is not in this persona's toolset. Stay in role: use only the allowed tools for this persona. Allowed: ${allowed}. If the task genuinely needs "${fn.name}", tell the user — they can switch persona (e.g. /classic or the + menu). Do not call "${fn.name}" again.`
                  : personaReadonly
                    ? `You are in a READ-ONLY persona (${persona}). "${fn.name}" is forbidden — edit/write/run tools are unavailable. Use read-tools (read_file, search_code, get_fast_context, analyze_project, ask_user) to research and answer in words. Allowed tools: ${allowed}. Do not call "${fn.name}" again.`
                    : `Tool "${fn.name}" is unavailable in the current mode (read-only/planning/side-chat). Allowed only: ${allowed}. Do not call it again — use the allowed tools for research.`
            resultMap.set(callId, { contentForAI: blockedMsg, callId, name: fn.name })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: blockedMsg, success: false, callId, hidden: isHiddenTool })
            return
          }

          const mode = (callbacks.approvalMode || 'auto') as 'auto' | 'ask' | 'full'
          // Читаем agentPermissions из store — раньше они были объявлены в
          // DEFAULT_SETTINGS и показаны в UI, но нигде не использовались.
          const agentPerms = (this.store.get('agentPermissions') as {
            confirmDangerous?: boolean
            dryRunMode?: boolean
            forbiddenPaths?: string[]
          } | undefined) ?? {}
          const dryRunMode = agentPerms.dryRunMode === true
          const approval = needsApproval(fn.name, args, mode, {
            confirmDangerous: agentPerms.confirmDangerous,
            forbiddenPaths: agentPerms.forbiddenPaths,
            workdir: this.workdir,
          })
          const effectiveApproval = isHiddenTool ? { confirm: false, block: false, reason: '' } : approval

          // MCP-тулы: per-tool флаг requireApproval из McpManager.
          // Если true — всегда спрашиваем (независимо от mode auto/ask,
          // кроме full — там onMcpRequiresApproval не вызывается).
          const isMcpTool = fn.name.startsWith('mcp__')
          if (isMcpTool && !effectiveApproval.block && callbacks.onMcpRequiresApproval) {
            const mcpNeedsConfirm = callbacks.onMcpRequiresApproval(fn.name)
            if (mcpNeedsConfirm && mode !== 'full') {
              effectiveApproval.confirm = true
              if (!effectiveApproval.reason) effectiveApproval.reason = 'MCP-тул требует подтверждения (per-tool настройка)'
            }
          }

          if (effectiveApproval.block) {
            const blockMsg = `Action blocked (mode ${mode}): ${effectiveApproval.reason}`
            resultMap.set(callId, { contentForAI: blockMsg, callId, name: fn.name })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: blockMsg, success: false })
            return
          }

          if (effectiveApproval.confirm && callbacks.onConfirm) {
            const approved = await callbacks.onConfirm(fn.name, args)
            if (!approved) {
              resultMap.set(callId, { contentForAI: 'Действие отклонено пользователем.', callId, name: fn.name })
              callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: 'Rejected by the user', success: false })
              return
            }
          }

          callbacks.onStatus?.(`${fn.name}...`)
          console.log('[Agent] exec tool: %s callId=%s (step=%d)', fn.name, callId, step)
          log('[Agent] exec tool: %s callId=%s', fn.name, callId)
          let result: ToolResult
          try {
            const toolPromise = this.executeTool(fn.name, args, callbacks, dryRunMode, callId)
            if (fn.name === 'spawn_agent') {
              // spawn_agent — блокирующий вызов до полного завершения суб-агента
              // (его собственный цикл до MAX_STEPS). Суб-агент имеет свои потолки
              // на каждый свой тул (MAX_TOOL_TIMEOUT_MS 180с, MCP_CALL_TIMEOUT_MS
              // 120с) — зависший тул внутри суб-агента ловится там. Внешний
              // MAX_TOOL_TIMEOUT_MS тут только убивал легитимно длинные суб-агенты
              // (большой рефакторинг/исследование много минут). Безопасность
              // висения: worker'а on('error'/'exit') и cancel() в AgentManager
              // резолвят промис spawn_agent → родитель не блокируется навсегда.
              result = await toolPromise
            } else {
              // Защитный потолок выполнения одного тула. Без этого зависший
              // тул (MCP stdio с повисшим пайпом, исключение до эмита результата)
              // блокирует агентский цикл навсегда — UI крутит спиннер
              // «Выполняется…» пока весь агент не завершится. Таймер гарантированно
              // закрывает итерацию tool_result'ом с понятной причиной.
              const timeoutPromise = new Promise<ToolResult>((_, reject) => {
                setTimeout(() => reject(new Error(`Tool ${fn.name} exceeded the execution timeout (${Math.round(MAX_TOOL_TIMEOUT_MS / 1000)}s). The MCP server may be hung or the transport is blocked.`)), MAX_TOOL_TIMEOUT_MS)
              })
              result = await Promise.race([toolPromise, timeoutPromise])
            }
          } catch (toolErr) {
            // Раньше throw из executeTool протекал в outer try/catch и
            // интерпретировался как API/network error (emit '_error' +
            // "Сеть недоступна"). Теперь — честный tool_result с реальным
            // сообщением, агент может обработать и продолжить.
            const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr)
            result = { success: false, output: '', error: `Internal tool error in ${fn.name}: ${errMsg}` }
          }

          // Fix 3: сброс loop-guard при успешном выполнении. Модель вышла
          // из лупа — не держим прошлые неудачи против неё весь session.
          // Особенно важно для edit_file: 2 неудачные попытки + успех →
          // счётчик обнуляется, следующий edit на другом файле начинает
          // с чистого листа.
          if (result.success && loopGuardBlockKey) {
            this.loopGuardHits.delete(loopGuardBlockKey)
          }

          if (result.success && !dryRunMode && (fn.name === 'write_file' || fn.name === 'edit_file')) {
            const p = args.path as string | undefined
            if (p) {
              const diff = (result as { diff?: string }).diff
              const origContent = (result as { originalContent?: string }).originalContent
              let diffSummary = ''
              if (ctxSettings.diffJournalEnabled) {
                if (diff) {
                  const diffLines = diff.split('\n').filter((l: string) => l.startsWith('+') || l.startsWith('-')).slice(0, ctxSettings.diffJournalLines)
                  diffSummary = diffLines.join(' | ').slice(0, 200)
                } else {
                  diffSummary = fn.name === 'write_file' ? 'created or replaced' : `changed via ${fn.name}`
                }
              }
              const fnNameCopy = fn.name
              pendingMutations.push(() => {
                modifiedFiles.add(p)
                successfulEditCount++
                // §1.8 — сохраняем оригинал для undo (null = файл был создан заново)
                this.undoStack.push({ path: p, originalContent: origContent ?? null })
                if (this.undoStack.length > 50) this.undoStack.shift()  // ограничиваем стек
                for (const key of Array.from(this.readFileCache.keys())) {
                  if (key.startsWith(p + ':')) this.readFileCache.delete(key)
                }
                // Инвалидируем персистентный кэш — mtime изменился, следующий read возьмёт свежие данные
                for (const fckey of Array.from(this.fileCache.keys())) {
                  if (fckey.startsWith(p + ':')) this.fileCache.delete(fckey)
                }
                // Инвалидируем readFileMaxLine — файл изменился, старые offset'ы невалидны
                let invAbsPath: string
                try { invAbsPath = resolve(this.workdir ?? process.cwd(), p) } catch { invAbsPath = p }
                this.readFileMaxLine.delete(invAbsPath)
                if (ctxSettings.diffJournalEnabled && diffSummary) {
                  this.pendingDiffEntries.push({ file: p, summary: diffSummary })
                }
                if (ctxSettings.fileMapEnabled) {
                  const existing = this.fileMap.get(p)
                  this.fileMap.set(p, {
                    reads: existing?.reads ?? 0,
                    writes: (existing?.writes ?? 0) + 1,
                    note: existing?.note ?? fnNameCopy,
                  })
                }
              })
            }
          }

          const imageMatch = result.output?.match(/^\[IMAGE:(.+)\]$/)
          const imageUrl = imageMatch ? imageMatch[1] : undefined
          // Если output есть — используем его даже при success=false.
          // Некоторые тулы (get_diagnostics) возвращают success=false
          // с осмысленным output (ошибки в коде / частичные результаты),
          // а error при этом не задан. Без этого AI видел «Error: undefined».
          const rawContent = imageUrl
            ? 'Image generated and shown to the user.'
            : (result.output || (result.success ? '' : `Error: ${result.error}`))
          const errorHint = !result.success ? getToolErrorHint(fn.name, result.error ?? '') : ''
          // Per-tool потолок обрезки: search_code уже сам режет до 20 000 симв.
          // по границам файлов (sliceOnFileBoundary), read_file возвращает
          // первые 400 строк — дефолтный toolMaxChars (6000)
          // безжалостно выкидывал средние файлы, из-за чего
          // модель теряла контекст и перебирала search-паттерны в лупе.
          // read_file / read_files — тоже ИСКЛЮЧАЕМ из символьной обрезки:
          // у них своя обрезка по строкам (DEFAULT_LINES=400) с правильной
          // подсказкой «используй offset=N для продолжения». truncateToolResult
          // поверх резал середину без подсказки → модель теряла нужный кусок
          // и перечитывала тот же файл → ощущение «контекст пропадает».
          const noTruncTool = fn.name === 'search_code' || fn.name === 'get_file_outline'
            || fn.name === 'read_file' || fn.name === 'read_files'
          const perToolMax = (fn.name === 'search_code' || fn.name === 'get_file_outline')
            ? Math.max(ctxSettings.toolMaxChars, 20000)
            : ctxSettings.toolMaxChars
          const contentForAI = (!imageUrl && ctxSettings.toolTruncEnabled && !noTruncTool)
            ? truncateToolResult((rawContent || '') + errorHint, perToolMax)
            : ((rawContent || '') + errorHint)

          if (!result.success && !isHiddenTool) {
            // Fingerprint ошибки включает args (через buildToolFingerprint —
            // как и tool-call guard выше), иначе параллельные вызовы одного
            // тула с разными args (напр. 3 spawn_agent с разными task),
            // упавшие с одинаковой generic-ошибкой, ложно триггерят guard.
            const errFp = buildToolFingerprint(fn.name, args)
            const errorFingerprint = `${fn.name}:${errFp.argsKey}:${(result.error ?? '').slice(0, 120)}`
            this.recentErrorFingerprints.push(errorFingerprint)
            if (this.recentErrorFingerprints.length > maxRepeatedErrors) {
              this.recentErrorFingerprints.shift()
            }
            const repeatedErrors = this.recentErrorFingerprints.length >= maxRepeatedErrors &&
              this.recentErrorFingerprints.every(entry => entry === errorFingerprint)
            if (repeatedErrors) {
              messages.push({
                role: 'user',
                content: `Loop guard: ${fn.name} produced the same error ${maxRepeatedErrors} times. Do not retry it unchanged. Use a different tool or explain the blocker.`,
              })
              // Эмитим видимый шаг для UI — раньше loop-guard уходил только
              // в модель, пользователь не видел что повторы остановлены.
              // Теперь отдельная orphan-итерация _loop_guard рендерится
              // в ToolChain (buildIterations → синтетический call) с
              // понятным текстом, почему агент перестал ретраить.
              callbacks.onStep({
                type: 'tool_result',
                toolName: '_loop_guard',
                content: `${fn.name} repeated the same error ${maxRepeatedErrors} times — retries stopped. Change strategy or explain the blocker.`,
                success: false,
              })
            }
          }

          callbacks.onStep({
            type: 'tool_result',
            toolName: fn.name,
            content: imageUrl ? 'Изображение сгенерировано' : (result.output || result.error || ''),
            success: result.success,
            imageUrl,
            diff: (result as { diff?: string }).diff,
            callId,
            hidden: isHiddenTool || !!(result as { hidden?: boolean }).hidden,
            serverName: extractMcpServerName(fn.name),
          })

          resultMap.set(callId, { contentForAI, callId, name: fn.name })
        }

        const parallelCalls = normalizedCalls.filter((item) => !isSequentialTool(item.fn.name))
        const sequentialCalls = normalizedCalls.filter((item) => isSequentialTool(item.fn.name))

        if (parallelCalls.length > 0) {
          await Promise.all(parallelCalls.map(executeCall))
        }
        for (const item of sequentialCalls) {
          await executeCall(item)
        }

        for (const mutation of pendingMutations) mutation()

        if (
          this.verificationCommand &&
          this.workdir &&
          successfulEditCount - lastVerifiedEditCount >= VERIFICATION_INTERVAL
        ) {
          lastVerifiedEditCount = successfulEditCount
          const verifyResult = await runCommand(this.verificationCommand, this.workdir)
          const verifyContent = `[Auto-verification after ${VERIFICATION_INTERVAL}+ file edits]\nCommand: ${this.verificationCommand}\n\n${verifyResult.output}`
          messages.push({ role: 'user', content: verifyContent })
          callbacks.onStep({
            type: 'tool_result',
            toolName: '_verification',
            content: verifyResult.output,
            success: verifyResult.success,
          })
        }

        for (const item of normalizedCalls) {
          const r = resultMap.get(item.callId)
          messages.push({
            role: 'tool',
            tool_call_id: item.callId,
            name: item.fn.name,
            content: r?.contentForAI ?? '',
          })
        }

        if (autoMemoryInterval > 0 && (step + 1) % autoMemoryInterval === 0) {
          flushWorkingMemory(`Intermediate progress after ${step + 1} agent steps`)
        }

        // Аварийный клапан: только если реальные токены подбираются к лимиту
        // модели. Никакой проактивной суммаризации — модель видит свои
        // tool-раунды как есть, пока не сработает клапан (с гистерезисом).
        const overflowedMessages = dropOldestRoundsIfOverflow(messages, hardLimitTokens, hardLimitTargetTokens)
        if (overflowedMessages !== messages) {
          messages.length = 0
          messages.push(...overflowedMessages)
        }

        if (callbacks.onContextUpdate) {
          // Единая оценка на актуальном массиве messages (system[0]+history
          // с tool_calls+tool results+current user). breakdown консистентен
          // с computeContextSnapshot / AIClient.onContextCounted — больше
          // никаких отдельных формул, дающих другие числа.
          const systemMsg = messages[0]?.role === 'system' ? messages[0] : undefined
          const rest = systemMsg ? messages.slice(1) : messages
          const snap = computeContextSnapshot(rest, Number.MAX_SAFE_INTEGER, {
            systemPrompt: systemMsg?.content as string | undefined,
            includeToolSchemas: true,
          })
          callbacks.onContextUpdate({
            promptTokens: snap.estimated,
            breakdown: {
              history: snap.breakdown.history,
              system: snap.breakdown.system,
              tools: snap.breakdown.tools,
              current: 0,  // current уже внутри history на этом этапе
            },
          })
        }
      } catch (err) {
        const error = err as { name?: string; status?: number; statusCode?: number; message?: string }
        const realStatus = error?.status ?? error?.statusCode ?? 0
        console.log('[Agent] round %s CATCH: name=%s status=%s statusCode=%s msg=%s consecutive=%d/%d',
          step, error?.name ?? '—', error?.status ?? '—', error?.statusCode ?? '—',
          (error?.message ?? String(err)).slice(0, 200),
          consecutiveErrors + 1, MAX_CONSECUTIVE_ERRORS)
        log('[Agent] round %s CATCH: name=%s status=%s statusCode=%s msg=%s consecutiveErrors=%d/%d',
          step, error?.name ?? '—', error?.status ?? '—', error?.statusCode ?? '—',
          (error?.message ?? String(err)).slice(0, 200),
          consecutiveErrors + 1, MAX_CONSECUTIVE_ERRORS)
        if (error?.name === 'AbortError' || signal?.aborted) {
          callbacks.onDone('')
          return
        }
        consecutiveErrors++
        const status = realStatus
        console.log('[Agent] error status=%s, consecutiveErrors=%d/%d', status, consecutiveErrors, MAX_CONSECUTIVE_ERRORS)
        // 413/422 (context_length_exceeded) — контекст слишком большой.
        // Раньше тут push user-сообщение об ошибке → контекст рос ещё
        // больше → снова 413 → бесконечно, а dropOldestRoundsIfOverflow
        // (в try) не вызывался (catch перехватывал). Теперь сначала
        // пытаемся аварийно сжать контекст; если уже минимальный — стоп.
        if (status === 413 || status === 422 || (error?.message?.toLowerCase().includes('context_length') ?? false) ||
            (error?.message?.includes('413') ?? false) || (error?.message?.toLowerCase().includes('request too large') ?? false)) {
          console.log('[Agent] 413/422 branch: status=%s, msg=%s, messages=%d', status, (error?.message ?? '').slice(0, 100), messages.length)
          log('[Agent] 413/context_length — аварийная компрессия')
          const beforeLen = messages.length
          const overflowed = dropOldestRoundsIfOverflow(messages, hardLimitTokens, hardLimitTargetTokens)
          if (overflowed !== messages && overflowed.length < beforeLen) {
            messages.length = 0
            messages.push(...overflowed)
            log('[Agent] 413/context_length — аварийная компрессия: %d→%d сообщений', beforeLen, messages.length)
            callbacks.onStep({ type: 'tool_result', toolName: '_error', content: `Context exceeded — compressed to ${messages.length} messages. Try to simplify the request.`, success: false })
            // Не push user — это только увеличит контекст. Continue даёт
            // шанс на следующем раунде с урезанным контекстом.
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              console.log('[Agent] STOP: 413 после сжатия, consecutiveErrors=%d', consecutiveErrors)
              log('[Agent] STOP: 413 после сжатия, consecutiveErrors=%d', consecutiveErrors)
              callbacks.onError(err instanceof Error ? err : new Error(`Context exceeded even after compression (${status}).`))
              return
            }
            continue
          }
          // Сжать не получилось — контекст уже минимальный (или пустой).
          // Это значит tool schemas сами по себе больше лимита модели
          // (Groq gpt-oss-120b: TPM=8000, schemas=35K). Ретраи бесполезны.
          // СРАЗУ onError — не ждём 3 ошибок, не пушим user-сообщение.
          console.log('[Agent] STOP: 413 не сжимается (messages=%d) — schemas > model TPM limit', messages.length)
          log('[Agent] STOP: 413 не сжимается — tool schemas больше лимита модели')
          callbacks.onError(err instanceof Error ? err : new Error(
            `Context exceeded (${status}). The model cannot accept tool schemas (possibly the model TPM/context limit is too small for tool work). ` +
            `Try: switch to a model with a larger context window, or disable tools in the agent settings. ` +
            `Error: ${(error?.message ?? '').slice(0, 200)}`
          ))
          return
        }
        if (status >= 400 && status < 500 && status !== 429) {
          console.log('[Agent] 4xx branch: status=%s', status)
          // 401/403/404 — конфиг/авторизация, нет смысла продолжать
          if (status === 401 || status === 403 || status === 404) {
            log('[Agent] STOP: auth error %s', status)
            callbacks.onError(err instanceof Error ? err : new Error(`API error ${status}: ${error?.message}`))
            return
          }
          // 400/422 и прочие 4xx — временная ошибка формата. Даём шанс,
          // но с лимитом consecutiveErrors — иначе бесконечно.
          // НЕ пушим user-сообщение — растит контекст при каждой ошибке.
          callbacks.onStep({ type: 'tool_result', toolName: '_error', content: `API error ${status}: ${error?.message || String(err)}`, success: false })
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            log('[Agent] STOP: API %s ×%d', status, consecutiveErrors)
            callbacks.onError(err instanceof Error ? err : new Error(`API error ${status} повторяется ${consecutiveErrors} раза подряд. Проверь провайдера/ключ.`))
            return
          }
          continue
        }
        if (error?.message?.includes('превышено число попыток') || error?.message?.includes('number of retries')) {
          console.log('[Agent] retries-exhausted branch')
          // chatWithTools уже ретраил 5 раз и не смог. Раньше тут было
          // continue без лимита → 50 шагов × 5 ретраев = 250 запросов,
          // "ожидание ответа" часами. Теперь после 3 таких раундов — стоп.
          // НЕ пушим user-сообщение — растит контекст.
          callbacks.onStep({ type: 'tool_result', toolName: '_error', content: `Could not get an answer after several attempts (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}).`, success: false })
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            log('[Agent] STOP: retries exhausted ×%d', consecutiveErrors)
            callbacks.onError(err instanceof Error ? err : new Error('Сеть недоступна: превышено число попыток запросов к API после нескольких раундов. Проверь подключение или провайдера.'))
            return
          }
          continue
        }
        console.log('[Agent] generic catch branch: status=%s msg=%s', status, (error?.message ?? '').slice(0, 100))
        callbacks.onStep({ type: 'tool_result', toolName: '_error', content: `Error: ${error?.message || String(err)}`, success: false })
        // НЕ пушим user-сообщение — оно растит контекст, а при 4xx ошибке
        // модель всё равно не сможет ответить. Rely on consecutiveErrors.
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.log('[Agent] STOP: generic error ×%d: %s', consecutiveErrors, error?.message)
          log('[Agent] STOP: generic error ×%d: %s', consecutiveErrors, error?.message)
          callbacks.onError(err instanceof Error ? err : new Error(`Network error repeating ${consecutiveErrors} times in a row: ${error?.message}`))
          return
        }
      }
    }
  }

  /**
   * Обновляет readFileMaxLine для absPath на основе output read_file.
   * Парсит два формата:
   *  - с offset:  [File: path | Lines 401-800 of 1686]
   *  - без offset: [File: path | 1686 lines]
   */
  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    callbacks?: AgentCallbacks,
    dryRun?: boolean,
    callId?: string
  ): Promise<ToolResult> {
    return this.toolDispatcher.executeTool(name, args, callbacks, dryRun, callId)
  }

  /**
   * Возвращает только изменённые/новые записи персистентного кэша —
   * для передачи обратно в main-процесс через postMessage.
   */
  getFileCacheUpdates(): Record<string, FileCacheEntry> {
    return this.toolDispatcher.getFileCacheUpdates()
  }

  /**
   * Возвращает копию undoStack — {path, contentBefore} для каждого файла,
   * изменённого в текущем turn'е. Используется для:
   *   - checkpoint/rewind (main-процесс сохраняет в file_snapshots)
   *   - error recovery (worker включает в error-message при падении)
   * contentBefore = null = файл был создан этим turn'ом.
   */
  getFileSnapshots(): Array<{ path: string; contentBefore: string | null }> {
    // Sync: Agent pushes to its own undoStack in pendingMutations (line ~987),
    // but ToolDispatcher.getFileSnapshots reads its own (empty) undoStack.
    // Without this sync, fileSnapshots is always [] → checkpoints get
    // filesChanged=0 → getLastTurnChanges returns null → badge disappears
    // after streaming ends and SessionChangesPanel shows no changes.
    this.toolDispatcher.undoStack = this.undoStack
    return this.toolDispatcher.getFileSnapshots()
  }

  /**
   * Краткая выжимка прогресса для сообщения о достижении maxSteps.
   * Использует уже собранную статистику тулов, не парсит messages.
   */
  private _summarizeProgress(modifiedFiles: Set<string>): string {
    const td = this.toolDispatcher
    const parts: string[] = []
    if (modifiedFiles.size > 0) {
      parts.push(`files modified: ${modifiedFiles.size} (${Array.from(modifiedFiles).slice(0, 5).join(', ')}${modifiedFiles.size > 5 ? '...' : ''})`)
    }
    if (td.commandsRun.length > 0) {
      parts.push(`commands run: ${td.commandsRun.length}`)
    }
    const filesRead = td.fileMap.size
    if (filesRead > 0) {
      parts.push(`files read: ${filesRead}`)
    }
    return parts.length > 0 ? parts.join('; ') : 'выполнена часть работы (см. лог тулов выше)'
  }

  /**
   * Структурированная выжимка действий агента — для передачи родительскому
   * агенту при spawn_agent, вместо обрезанного 500-символьного текста.
   */
  private buildSummaryDetails(modifiedFiles: Set<string>): AgentSummaryDetails {
    // Sync: Agent pushes to its own undoStack/pendingDiffEntries/fileMap
    // in pendingMutations (lines ~987, ~1001, ~1005), but
    // ToolDispatcher.buildSummaryDetails reads its own (empty) copies.
    // Without this sync, fileSnapshots/diffs/filesRead are always empty
    // in AgentSummaryDetails → checkpoints get filesChanged=0 → badge
    // disappears after streaming and SessionChangesPanel shows no changes.
    this.toolDispatcher.undoStack = this.undoStack
    this.toolDispatcher.pendingDiffEntries = this.pendingDiffEntries
    this.toolDispatcher.fileMap = this.fileMap
    return this.toolDispatcher.buildSummaryDetails(modifiedFiles)
  }
}
