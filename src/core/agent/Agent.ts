import type Store from 'electron-store'
import { AIClient } from '../ai/AIClient'
import { agentModelSupportsVision } from '../ai/visionSupport'
import { hydrateHistoryContents } from '../ai/toolImageHistory'
import { ImageRequestBudget } from '../../shared/imageFormat'
import { STEER_MARKER } from '../../shared/steer'
import { isFinalAnswerToolName, takeFinalAnswerToolCalls } from '../../shared/finalAnswer'
import { NativeImageAnalysis } from './nativeImageAnalysis'
import { needsApproval, resolveAutoModeSettings, mergeForbiddenPaths, isAllowlisted, isSecretPath, maskSecretValues, actionAllowlistKey } from './commandSafety'
import { scanForInjection, wrapUntrustedContent, isMutatingTool, isScannedTool, isWebSourceTool, INJECTION_ESCALATION_STEPS } from './injectionGuard'
import type { ProjectPermissionOverride, ApprovalAllowlistEntry, AllowScope, SteerAttachmentMeta } from '../../shared/types'
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
import type { ChatMessage } from '../context/contextManager'
import { computeRequestContextSnapshot, type UsageSnapshot } from '../tokens/usageTracker'
import { MAX_TOOL_TIMEOUT_MS } from '../ai/shared'
import { getSubagentRole } from '../../shared/subagent-roles'
import type { FileCacheEntry } from '../context/fileCacheTypes'
import { resolve } from 'path'
import { log } from '../logger'
import type {
  AgentCallbacks, AgentSummaryDetails, AgentMessage, ContentPart,
  NormalizedToolCall, AgentRuntimeOptions, AgentToolCallFingerprint,
} from './types'
import {
  FALLBACK_SYSTEM_PROMPT, VERIFICATION_INTERVAL,
  normalizeToolName, findMissingRequiredArgs, formatMissingArgsMessage, getToolErrorHint, isSequentialTool,
  buildToolFingerprint, dropOldestRoundsIfOverflow, extractMcpServerName,
  imagePayloadInfos,
  tryRepairJson,
  salvageEditFileArgs,
} from './utils'
import { validateAndCoerceArgs } from './validateArgs'
import { ToolDispatcher } from './toolDispatcher'
import { jsonrepair } from 'jsonrepair'
import { GoalRuntime } from './goalRuntime'
import { formatTranscript, makeGoalJudge } from './goalEvaluator'
import type { ChatGoal } from '../../shared/types/goal'
import { filterToolSchemas, getToolSettings, isToolDisabled } from '../../shared/toolSettings'
import type { OrchestrationProgress } from '../../shared/orchestration'
import {
  OrchestrationRuntime,
  advanceAfterPhaseAnswer,
  filterSchemasForPhase,
  isToolAllowedInPhase,
  phaseInstruction,
  portableizeMessages,
  sameModel,
} from './orchestration'
import type { OrchestrationModel } from '../../shared/orchestration'
import { sanitizeToolInstructions, splitSystemPromptForCache } from '../prompts/buildSystemPrompt'
import { executeCode, EphemeralArtifactStore } from '../codeMode'
import type { CodeTraceEntry } from '../codeMode'
import { Janitor } from '../context/janitor'
import { DeferredMcpTools } from './deferredMcpTools'
import { loadAssistantState, saveAssistantState, ASSISTANT_STATE_VERSION } from '../context/assistantState'
import { Constitution } from '../context/constitution'
import { consumeHintBudget, MAX_PENDING_HINTS } from '../context/hintBudget'
import { getSkillManager } from '../skills/skillManager'
import type { Capability } from './watcher'
import { JANITOR_MARKER, CONSTITUTION_MARKER, BRIEFING_MARKER, DEFAULT_ASSISTANTS_SETTINGS, type AssistantsSettings, type HintCandidate } from '../../shared/assistants'

// Ограниченное хранилище Code Mode живёт в worker-процессе, а записи изолированы chatId.
// Если worker завершён, артефакты очищаются вместе с ним.
const CODE_MODE_ARTIFACTS = new EphemeralArtifactStore()

// Тулы, которые НЕ блокируются hard block при parse-failure loop guard —
// они не деструктивны (идемпотентны, не меняют файлы/систему).
// Hard block на весь run лишает модель возможности сохранить
// результат работы или спросить пользователя.
const NON_DESTRUCTIVE_TOOLS = new Set([
  'edit_file',
  'save_memory',
  'recall_memory',
  'recall_context',
  'update_working_memory',
  'update_todo',
  'ask_user',
])

// Жёсткий потолок ЛЮБОГО tool-результата — стоп-клапан отравления контекста.
// Тулы из noTruncTool (search_code/read_file/spawn_agent/mcp__*) доверяют
// обрезке автора, но один сбойный путь может вернуть мегабайты. Реальный
// инцидент: PowerShell-fallback search_code выдал 5.59MB по минифицированному
// бандлу → шаг сохранился в БД сырым → messageToContextMessages развернул
// его в ~1.7M «токенов» оценки → автокомпакция на КАЖДОМ сообщении (divider
// ставится перед гигантским Message целиком и не может его разрезать).
// Потолок применяется и к UI/БД-копии (visibleToolContent), иначе сырой
// гигант вернулся бы в контекст из истории на следующих ходах. 200k симв
// (~50k токенов) с запасом покрывает самый большой легитимный вывод
// (fetch_page ~50k симв, plugin_docs ~40k) — легитимные тулы его не замечают.
const TOOL_RESULT_HARD_CEILING = 200_000

// §steer — реплики пользователя, внедрённые в контекст посреди рана: маркер
// живёт в shared/steer.ts (он же используется при пересборке истории в
// chatContextHelpers, чтобы следующий ход видел правку пользователя).

export class Agent {
  private store: Store
  private client: AIClient
  private role: 'main' | 'subagent'
  chatId?: string
  /** Main-worker runtime hook. Inactive goals never auto-resume. */
  goal?: ChatGoal
  onGoalProgress?: (goal: ChatGoal) => void
  /**
   * Рабочая директория чата (режим "Код"). Когда задана, файловые тулы
   * и run_command резолвят относительные пути относительно неё вместо
   * process.cwd()/homedir(). Не задана для Work-режима и старых чатов
   * (созданных до фичи workdir) — в этом случае поведение прежнее.
   */
  workdir?: string
  /**
   * §worktree — маппинг путей для суб-агентов в git-worktree изоляции.
   * Когда задан, пути мутирующих тулов (write_file/edit_file/run_command.cwd),
   * указывающие внутрь projectRoot, автоматически перенаправляются в
   * worktreePath. Решает две проблемы: (1) спам подтверждений «вне workdir» —
   * модель получает от родителя абсолютные пути проекта, а её workdir =
   * worktree; (2) реальная изоляция — правки идут в worktree и мержатся
   * обратно через git apply --3way, а не в живую папку проекта.
   */
  worktreeMap?: { projectRoot: string; worktreePath: string }
  /**
   * ID проекта (из таблицы projects) — используется для привязки памяти и
   * графа к проекту. undefined для чатов без проекта.
   */
  projectId?: string  /**
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
  /** userData path — для fallback-поиска картинок-вложений в draft-attachments. */
  userDataPath?: string
  onUpdateWorkingMemory?: (chatId: string, content: string, mode: 'replace' | 'append') => void
  onGetWorkingMemory?: (chatId: string) => string
  /** Колбэк после записи/редактирования файла агентом — для live-обновления UI */
  onFileChanged?: (path: string) => void
  /** §rollback-live — колбэк на КАЖДУЮ правку файла: {path, contentBefore}.
   *  Воркер стримит это в main, чтобы правки прогона оставались
   *  откатываемыми даже если финальный done не придёт (Stop/краш воркера).
   *  Вызывается вместе с callbacks.onFileSnapshot (если задан). */
  onFileSnapshot?: (snapshot: { path: string; contentBefore: string | null }) => void
  /** Защищённые переменные: key → decrypted value. Подстановка ${{KEY}} в
   *  аргументы тулов и обратная маскировка в результатах. */
  secretValues?: Map<string, string>
  pendingDiffEntries: DiffEntry[] = []
  /**
   * §orchestration — рантайм фазового рана (только пока идёт оркестрованный
   * run). Нужен, чтобы buildSummaryDetails отдал атрибуцию по моделям без
   * протаскивания объекта через все onDone-вызовы.
   */
  private orchestrationRuntime: OrchestrationRuntime | null = null
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

  /**
   * §steer — реплики пользователя, присланные ПОСРЕДИ активного рана
   * (long-press на кнопке Send → chat:steer → worker.postMessage).
   * Цикл run() дренажит их на границе раунда (перед следующим обращением к
   * модели) и вставляет как role:'user' с маркером STEER_MARKER — агент видит
   * «пользователь написал это во время работы» и продолжает, НЕ прерывая
   * текущий стрим и не теряя уже сделанное.
   * Никакого лимита: сколько прислали, столько и вставим, по порядку (FIFO).
   * text — AI-текст (вложения уже инлайнены main'ом в processAttachmentsAndStream),
   * displayText — как написал пользователь (с [[attach:id]]-токенами, для
   * карточки и БД), imageParts — пиксели картинок для vision-модели.
   */
  private pendingSteers: Array<{
    id: string
    text: string
    displayText?: string
    imageParts?: ContentPart[]
    attachments?: SteerAttachmentMeta[]
  }> = []

  private pendingHints: HintCandidate[] = []
  private hintCooldown = 0
  private recentHintIds = new Set<string>()
  private janitor: Janitor
  private assistantsSettings: AssistantsSettings = { ...DEFAULT_ASSISTANTS_SETTINGS }
  private janitorRoundCounter = 0
  private constitution = new Constitution()
  private forceJanitorMode: 'light' | 'deep' | null = null
  // Калибровка оценки контекста — ОДНА на проект: usageTracker
  // (recordEstimateCalibration/estimateCalibrationFactor, EWMA по паре
  // provider:model). Здесь раньше жила вторая, независимая: одиночный замер
  // promptTokens/estimate с clamp 0.5…4. Она умножала уже откалиброванную
  // оценку (двойное масштабирование) и могла разом дать ×4 → economist видел
  // «дошли до порога» и запускал глубокое сжатие на ровном месте.
  private ecoStage = 0
  private navigatorRoundCounter = 0
  /** Probe-флаги navigator'а: свежая ошибка/зацикливание — повод свериться
   *  с целью и ограничениями раньше обычного интервала (см. блок Navigator). */
  private navigatorProbe = false
  private navigatorLastStep = -100
  /** Последний раунд, в котором подсказка navigator'а реально попала в промпт:
   *  повторный совет сразу после сработавшего — шум, мост это учитывает. */
  private navigatorLastUsefulStep = -100
  /** Ревизия задачи: инкремент на каждом внедрённом steer. События navigator'а
   *  несут её вместе с номером раунда — мост отбрасывает вердикты по старой
   *  постановке, не обрывая при этом живые вызовы каждый раунд. */
  private taskRevision = 0
  /** Edge-сигнатура повторов тулов: watcher/navigator реагируют только на
   *  ПЕРЕХОД в зацикливание (и на смену набора повторов), а не на каждый
   *  раунд, пока повторы продолжаются. */
  private lastRepeatSignature = ''
  private briefingDone = false
  /** Персист мини-агентов (конституция + recall-архив per chat).
   *  Ставится ai-worker'ом: main-чат и не инкогнито. */
  persistAssistantState = false
  private assistantStateLoaded = false
  /** Актуальный todo-лист (из update_todo) — navigator сверяет «уход от плана». */
  private currentTodo: Array<{ text: string; status: string }> = []
  /** Ссылка на messages текущего рана — для J3 guard и J4 refine из worker-хендлеров. */
  private liveMessages: AgentMessage[] | null = null
  /** Канал worker→main для LLM-зависимых мини-агентов (navigator/archivist).
   *  Ставится ai-worker'ом. */
  onAssistantEvent?: (evt: Record<string, unknown>) => void

  /**
   * Вызывается из ai-worker по сообщению {type:'steer'}. Пустой текст без
   * картинок — no-op. Метод потокобезопасен по смыслу: worker_threads
   * однопоточны в рамках воркера, запись происходит в паузе между await-точками
   * агента.
   */
  pushSteer(
    id: string,
    text: string,
    extra?: { displayText?: string; imageParts?: ContentPart[]; attachments?: SteerAttachmentMeta[] },
  ): void {
    const clean = typeof text === 'string' ? text.trim() : ''
    const imageParts = extra?.imageParts?.length ? extra.imageParts : undefined
    if (!clean && !imageParts) return
    this.pendingSteers.push({
      id: id || `steer-${Date.now()}`,
      text: clean,
      displayText: extra?.displayText?.trim() || clean,
      imageParts,
      attachments: extra?.attachments?.length ? extra.attachments : undefined,
    })
  }

  /** Есть ли не применённые реплики (нужно воркеру/main для статистики ранa). */
  get hasPendingSteers(): boolean {
    return this.pendingSteers.length > 0
  }

  /**
   * §steer — пользователь передумал: убираем реплику из очереди на внедрение.
   * Работает только пока она НЕ вставлена в messages (карточка в состоянии
   * «ждёт границы раунда»). Возвращает true, если что-то реально сняли.
   */
  cancelSteer(id: string): boolean {
    const before = this.pendingSteers.length
    this.pendingSteers = this.pendingSteers.filter(s => s.id !== id)
    return this.pendingSteers.length !== before
  }

  pushHint(hint: HintCandidate): void {
    if (!this.assistantsSettings.enabled || !this.hintSourceEnabled(hint.source)) return
    if (this.recentHintIds.has(hint.id) || this.pendingHints.some(pending => pending.id === hint.id)) return
    if (this.pendingHints.length >= MAX_PENDING_HINTS) return
    this.pendingHints.push(hint)
  }

  private hintSourceEnabled(source: HintCandidate['source']): boolean {
    const s = this.assistantsSettings
    switch (source) {
      case 'memory': return s.watcherEnabled && s.sources.memory
      case 'skill': case 'capability': return s.watcherEnabled && s.sources.skills
      case 'briefing': return s.briefingEnabled
      case 'navigator': return s.navigatorEnabled
      case 'archivist': return s.archivistEnabled
      case 'constitution': return true
      default: return true
    }
  }

  /** Слив состояния мини-агентов на диск (конституция + recall-архив).
   *  Воркер живёт один запрос — без этого ограничения юзера и архив
   *  умирают между сообщениями чата. */
  private persistStateNow(): void {
    if (!this.persistAssistantState || !this.chatId || !this.userDataPath) return
    saveAssistantState(this.userDataPath, this.chatId, {
      constitution: this.constitution.list(),
      janitorArchive: this.janitor.getArchiveEntries(),
    })
  }

  /** J1: держим конституцию в контексте всегда — после любой компакции/дропа. */
  private reinjectConstitution(messages: AgentMessage[]): void {
    const block = this.constitution.serialize()
    for (let i = messages.length - 1; i >= 0; i--) {
      const c = messages[i].content
      if (typeof c === 'string' && c.includes(CONSTITUTION_MARKER)) messages.splice(i, 1)
    }
    if (block) messages.push({ role: 'user', content: block })
  }

  /** Archivist: финальный транскрипт уходит в main на дистилляцию.
   *  Один путь для обычного финала и для успешно закрытой цели — раньше
   *  goal-ветка завершалась молча и факты рана терялись. */
  private emitArchivist(messages: AgentMessage[], modifiedFiles: Set<string>, finalAnswer?: string): void {
    if (!this.assistantsSettings.enabled || !this.assistantsSettings.archivistEnabled) return
    if (!this.onAssistantEvent || this.role !== 'main') return
    const recent = messages.slice(-16)
    if (finalAnswer?.trim()) recent.push({ role: 'assistant', content: finalAnswer })
    this.onAssistantEvent({
      kind: 'archivist',
      transcript: formatTranscript(recent as ChatMessage[], { advisory: true, maxChars: 2400, perMessageChars: 420 }),
      modifiedFiles: Array.from(modifiedFiles),
      projectId: this.projectId,
      chatId: this.chatId,
    })
  }

  /**
   * Continuity для Briefing (git log/status). Считается в main-процессе
   * (src/main/assistants/gitBriefingCache.ts: кеш на проект + коалесинг) и
   * приходит снапшотом в workerData — воркер больше НЕ запускает git сам,
   * иначе каждый чат/суб-агент спавнил по два процесса.
   *
   * Снапшот попадает прямо в стартовый briefing-блок (см. run), без
   * отдельной асинхронной подсказки: continuity — статика начала сессии,
   * а hint-пайплайн инжектил её уже посреди рана, дублируя briefing.
   */
  continuitySnapshot = ''

  /**
   * J2 + §prompt-cache: якорь кеша на ПОСЛЕДНЕМ сообщении текущего запроса.
   * Вызывается перед каждым раундом (и после janitor/overflow-сжатия): новый
   * кадр данных дописывается в конец, префикс предыдущего раунда остаётся
   * неизменным и читается из кеша Anthropic. Все остальные якоря снимаются —
   * Anthropic разрешает 4 breakpoint'а на запрос, а лишние пустые записи
   * стоят премии 1.25×.
   */
  private markCacheAnchor(messages: AgentMessage[]): void {
    for (const m of messages) {
      if ((m as { cacheAnchor?: boolean }).cacheAnchor) (m as { cacheAnchor?: boolean }).cacheAnchor = false
    }
    if (messages.length > 0) (messages[messages.length - 1] as { cacheAnchor?: boolean }).cacheAnchor = true
  }

  /** Применяет отчёт janitor + пост-обработка (конституция, якорь).
   *  `before` — снапшот контекста, посчитанный ДО скана в этом же раунде:
   *  второй расчёт того же массива был чистой работой впустую. */
  private applyJanitorReport(messages: AgentMessage[], report: import('../../shared/assistants').JanitorReport, callbacks: AgentCallbacks, toolSchemas: unknown[], contextWindow: number, before: UsageSnapshot): void {
    const optimized = this.janitor.apply(messages as ChatMessage[], report)
    messages.length = 0
    messages.push(...(optimized as AgentMessage[]))
    this.reinjectConstitution(messages)
    this.markCacheAnchor(messages)
    const after = computeRequestContextSnapshot(messages, contextWindow, toolSchemas)
    const saved = Math.max(0, before.estimated - after.estimated)
    callbacks.onStep({
      type: 'janitor',
      content: `Контекст запроса ≈${before.estimated} → ≈${after.estimated} токенов (${after.pct}% окна). Сэкономлено ≈${saved}; свёрнуто ${report.actions.length} результатов инструментов.`,
      janitorTokensSaved: saved,
      janitorActions: report.actions.map(a => ({ kind: a.kind, description: a.description, tokensSaved: a.tokensSaved, archiveId: a.archiveId })),
    })
    callbacks.onContextUpdate?.({ promptTokens: after.estimated, breakdown: after.breakdown })
    // Архив вырос — сливаем на диск, чтобы [recall:id] пережил смену воркера.
    if (report.actions.some(a => a.kind === 'summarize_stale')) this.persistStateNow()
    log('[Agent] janitor: %d actions, %d tokens saved (%dms)', report.actions.length, report.totalTokensSaved, report.durationMs)
  }

  /** J3: контент файла ещё в контексте? Считаем ТОЛЬКО результаты
   *  read_file/read_files: любое другое упоминание пути (резюме джанитора,
   *  diff'ы правок, fileMap) контентом не является. Свёрнутые джанитором
   *  сообщения (janitorCollapsed / маркер из персист-компрессии) не считаем —
   *  иначе rereadGuard запрещал перечитывать то, что джанитор сжал. */
  private hasReadInContext(absPath: string): boolean {
    if (!this.liveMessages) return false
    const readCallIds = new Set<string>()
    for (const m of this.liveMessages) {
      if (m.role !== 'assistant' || !m.tool_calls?.length) continue
      for (const tc of m.tool_calls as Array<{ id?: string; function?: { name?: string } }>) {
        const n = tc.function?.name ?? ''
        if (n === 'read_file' || n === 'read_files') { if (tc.id) readCallIds.add(tc.id) }
      }
    }
    if (readCallIds.size === 0) return false
    const base = absPath.replace(/\\/g, '/').split('/').pop() ?? ''
    for (const m of this.liveMessages) {
      if (m.role !== 'tool' || typeof m.content !== 'string' || !m.tool_call_id) continue
      if (!readCallIds.has(m.tool_call_id)) continue
      if ((m as { janitorCollapsed?: boolean }).janitorCollapsed) continue
      // Сообщения из БД флага не несут — но маркер ужатых текстов остаётся.
      if (m.content.includes(JANITOR_MARKER)) continue
      if (m.content.includes(absPath) || (base && m.content.includes(base))) return true
    }
    return false
  }

  /** Watcher v2: каталог возможностей, доступных в этом ране (тулы/MCP/plugin/скиллы). */
  /** W2: каталог судьи watcher'а — только скиллы. Их инструкций нет в контексе,
   *  пока скилл не вызван, поэтому подсказка несёт новую информацию. Builtin-тулы,
   *  MCP и плагины агент и так видит в схемах каждого запроса — «подсказка»
   *  write_file это эхо с нулевой ценностью, только мусор в контексте. */
  private buildCapabilities(): Capability[] {
    try {
      return getSkillManager()
        .getActiveSkillsForChat({ projectWorkdir: this.workdir, projectId: this.projectId })
        .map(sk => ({ id: sk.name, kind: 'skill' as const, name: sk.name, desc: (sk.description ?? '').slice(0, 120) }))
    } catch { /* skills недоступны — не критично */ }
    return []
  }

  get hasPendingHints(): boolean {
    return this.pendingHints.length > 0
  }

  setAssistantsSettings(settings: AssistantsSettings): void {
    this.assistantsSettings = settings
    this.janitor.updateSettings(settings)
  }

  recallJanitorArchive(archiveId: string): ChatMessage[] | null {
    return this.janitor.recall(archiveId)
  }

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

  // §allowlist — сессионная память одобрений: нормализованные ключи
  // `tool|command-or-path`, не спрашиваем повторно в рамках этого чата.
  private sessionAllowed = new Set<string>()
  private sessionAllowedTools = new Set<string>()

  // §injection — сколько вызовов тулов осталось в окне эскалации после
  // подозрительного контента (prompt injection guard). >0 → мутирующие
  // тулы требуют подтверждения всегда, даже в full-auto и в allowlist.
  private injectionEscalation = 0

  /**
   * Синхронизирует workdir/projectId/chatId/gateway-поля/колбэки в ToolDispatcher.
   * Вызывается ПОСЛЕ установки полей Agent'а (в ai-worker.ts поля
   * workdir/projectId/chatId устанавливаются после конструктора, но
   * ToolDispatcher создаётся в конструкторе и не получает их).
   */
  /**
   * §worktree — перенаправляет путь внутрь projectRoot на соответствующий
   * путь в worktreePath (case-insensitive, / и \ эквивалентны). Пути вне
   * projectRoot возвращаются без изменений.
   */
  private mapPathToWorktree(p: string): string {
    const m = this.worktreeMap
    if (!m || !p) return p
    const norm = (s: string) => s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    const root = norm(m.projectRoot)
    const np = norm(p)
    if (np !== root && !np.startsWith(root + '\\')) return p
    // Суффикс берём от оригинала (с приведением слешей) по длине root —
    // norm() мог изменить длину (двойные слеши, trailing).
    const suffix = p.replace(/\//g, '\\').slice(root.length).replace(/\\+$/, '')
    return suffix ? m.worktreePath + '\\' + suffix : m.worktreePath
  }

  // ─── §allowlist — «Всегда разрешать» ───────────────────────────────────────

  /** Ключ сессионной памяти для тула и args (команда или нормализованный путь). */
  private allowlistKey(toolName: string, args: Record<string, unknown>): string {
    return actionAllowlistKey(toolName, args)
  }

  /** Разрешено ли действие allowlist'ом (сессия + store: глобально + проект). */
  private isActionAllowlisted(toolName: string, args: Record<string, unknown>): boolean {
    const agentPerms = (this.store.get('agentPermissions') as { approvalAllowlist?: ApprovalAllowlistEntry[] } | undefined) ?? {}
    const projectPerms = (this.store.get('projectPermissions') as Record<string, ProjectPermissionOverride> | undefined) ?? {}
    const chatPerms = (this.store.get('chatApprovalAllowlist') as Record<string, ApprovalAllowlistEntry[]> | undefined) ?? {}
    const projEntries = this.role === 'main' && this.projectId ? projectPerms[this.projectId]?.approvalAllowlist : undefined
    const entries = [...(agentPerms.approvalAllowlist ?? []), ...(projEntries ?? []), ...(this.chatId ? chatPerms[this.chatId] ?? [] : [])]
    return this.sessionAllowedTools.has(toolName) || isAllowlisted(toolName, args, { entries, sessionKeys: this.sessionAllowed })
  }

  /** Main process owns durable grants; worker only tracks this-run session grants. */
  private recordAllowlist(toolName: string, args: Record<string, unknown>, scope: AllowScope, match: 'action' | 'tool' = 'action'): void {
    if (match === 'tool') this.sessionAllowedTools.add(toolName)
    else this.sessionAllowed.add(this.allowlistKey(toolName, args))
    void scope
  }

  syncToolDispatcher(): void {
    this.toolDispatcher.modelRole = this.role
    this.toolDispatcher.workdir = this.workdir
    this.toolDispatcher.userDataPath = this.userDataPath
    this.toolDispatcher.projectId = this.projectId
    this.toolDispatcher.chatId = this.chatId
    this.toolDispatcher.gatewayToken = this.gatewayToken
    this.toolDispatcher.gatewayApiUrl = this.gatewayApiUrl
    this.toolDispatcher.onUpdateWorkingMemory = this.onUpdateWorkingMemory
    this.toolDispatcher.onGetWorkingMemory = this.onGetWorkingMemory
    this.toolDispatcher.onFileChanged = this.onFileChanged
    this.toolDispatcher.secretValues = this.secretValues
  }

  constructor(store: Store, role: 'main' | 'subagent' = 'main') {
    this.store = store
    this.role = role
    this.client = new AIClient(store)
    this.janitor = new Janitor(this.assistantsSettings)
    this.toolDispatcher = new ToolDispatcher({
      store,
      workdir: this.workdir,
      userDataPath: this.userDataPath,
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
    history?: Array<{ role: string; content: string; imagePaths?: string[]; janitorProtected?: boolean; tool_calls?: unknown[]; tool_call_id?: string; name?: string; thinking_blocks?: Array<{ thinking: string; signature: string }>; reasoning_content?: string }>,
    toolSchemas?: typeof TOOL_SCHEMAS,
    options?: AgentRuntimeOptions
  ): Promise<void> {
    // Preserve the main agent's existing ceiling; only delegated jobs use
    // the caller's bounded budget. Never let NaN/Infinity disable the limit.
    const EFFECTIVE_MAX_STEPS = this.role === 'subagent'
      ? (Number.isFinite(maxSteps) ? Math.max(1, Math.min(1024, Math.floor(maxSteps))) : 256)
      : 1024
    // §goal — цель участвует в прогоне, пока она set (running) или ждёт
    // следующего сообщения пользователя (paused). Как в [CC]: обычный ход
    // в чате с активной целью тоже продолжает работу к цели.
    const goalRuntime = this.role === 'main' && this.goal && (this.goal.status === 'running' || this.goal.status === 'paused')
      ? new GoalRuntime(this.goal, goal => { this.goal = goal; this.onGoalProgress?.(goal) },
        makeGoalJudge((goalMessages, modelType, systemPrompt, opts) =>
          this.client.complete(goalMessages, modelType, systemPrompt, opts)))
      : undefined
    // Возобновление после паузы: следующий ход продолжает цикл.
    if (goalRuntime && goalRuntime.goal.status === 'paused') {
      goalRuntime.goal.status = 'running'
      goalRuntime.save()
    }
    const goalWait = async <T>(promise: Promise<T>): Promise<T> => {
      if (!goalRuntime || !signal) return promise
      const abortSignal = signal
      let listener: (() => void) | undefined
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
          listener = () => { const error = new Error('Goal run aborted'); error.name = 'AbortError'; reject(error) }
          if (abortSignal.aborted) listener()
          else abortSignal.addEventListener('abort', listener, { once: true })
        })])
      } finally { if (listener) abortSignal.removeEventListener('abort', listener) }
    }
    try {
    this.toolDispatcher.mediaSignal = signal
    const supportsVision = agentModelSupportsVision(this.store, this.role)
    const toolSettings = getToolSettings(this.store)
    const sanitizedSystemPrompt = sanitizeToolInstructions(systemPrompt || FALLBACK_SYSTEM_PROMPT, toolSettings)
    // §prompt-cache: в system едет ТОЛЬКО кешируемый статичный префикс, а
    // динамический хвост (дата-время, память, project map, working memory)
    // уходит отдельным session_context-сообщением перед текущей репликой.
    // Иначе меняющаяся первая строка хвоста ломает префикс и история диалога
    // не попадает в prompt cache провайдера ни на одном эндпоинте.
    const { staticPart: staticSystemPrompt, dynamicPart: sessionContext } = splitSystemPromptForCache(sanitizedSystemPrompt)
    // Пиксели из истории переподставляются в КАЖДЫЙ запрос, поэтому чат из
    // десяти скриншотов отправлял десятки мегабайт на каждом ходу — и чем
    // длиннее диалог, тем «случайнее» падал запрос (413 / request too large).
    // Бюджет гидрации расходуется с конца: свежие результаты в приоритете,
    // старые остаются текстом с путём (модель может перечитать их тулом).
    const historyList = history ?? []
    // ОДИН бюджет на весь запрос: история и текущий раунд тулов делят лимиты
    // провайдера (число картинок, 2000px при нескольких изображениях, байты).
    const imageBudget = new ImageRequestBudget()
    // Вложения текущего сообщения уже занимают часть бюджета запроса —
    // учитываем их, чтобы история не добила payload до 413.
    if (options?.imageParts?.length) {
      for (const info of imagePayloadInfos(options.imageParts as Array<{ type: string; image_url?: { url: string } }>)) {
        imageBudget.accept(info)
      }
    }
    const historyContents = hydrateHistoryContents(historyList, supportsVision, imageBudget)
    // Префикс «system-статика + история» обязан быть побайтово одинаковым
    // между ходами, иначе кеш провайдера не даёт ни одного попадания.
    const sessionContextBlock = sessionContext.trim()
      ? { role: 'user' as const, content: `<session_context>\n${sessionContext.trim()}\n</session_context>` }
      : null
    const messages: AgentMessage[] = [
      { role: 'system', content: staticSystemPrompt },
      ...historyList.map((m, index) => ({
        role: m.role,
        content: historyContents[index],
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
        ...(m.janitorProtected ? { janitorProtected: true } : {}),
        ...(m.thinking_blocks ? { thinking_blocks: m.thinking_blocks } : {}),
        ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
      })),
      ...(sessionContextBlock ? [sessionContextBlock] : []),
      {
        role: 'user',
        // Если есть imageParts (основная модель поддерживает vision) —
        // передаём картинки напрямую как multipart content (image_url блоки +
        // текст). Иначе — обычный строковый content (возможно с текстовым
        // описанием картинок от vision-модели).
        content: options?.imageParts && options.imageParts.length > 0
          ? [...options.imageParts, { type: 'text' as const, text: userMessage.trim() || 'Проанализируй прикреплённые изображения.' }]
          : userMessage,
      },
    ]

    if (goalRuntime) messages.push({ role: 'system', content: goalRuntime.instruction() })

    // Персист мини-агентов: восстанавливаем конституцию и recall-архив
    // предыдущих сообщений этого чата (воркер — один запрос, всё иначе умрёт).
    if (this.persistAssistantState && this.chatId && this.userDataPath && !this.assistantStateLoaded) {
      this.assistantStateLoaded = true
      const st = loadAssistantState(this.userDataPath, this.chatId)
      if (st) {
        this.constitution.hydrate(st.constitution ?? [])
        this.janitor.hydrateArchive(st.janitorArchive ?? [])
        // Миграция схемы: старые авто-пункты вычищены — фиксируем на диск,
        // чтобы они не вернулись и не разбирались заново.
        if (st.migrated) {
          this.persistStateNow()
          log('[Agent] assistants-state migrated to v%d (auto constitution cleared)', ASSISTANT_STATE_VERSION)
        }
      }
    }
    this.janitor.restoreSummaries(messages as ChatMessage[])
    // Конституция: только ЯВНЫЕ правила (/rule … или «запомни правило: …»).
    // Авто-извлечение (regex по любому тексту + LLM-экстрактор в main) удалено:
    // правила попадали в контекст дважды и не отзывались. Старые авто-пункты
    // из персиста не применяются (см. clearLegacyAutoConstitution).
    if (this.assistantsSettings.enabled && typeof userMessage === 'string') {
      const added = this.constitution.addExplicit(userMessage)
      if (added.length > 0) {
        callbacks.onStep({ type: 'hint', hintSource: 'constitution', content: `Запомнил правило: ${added.join('; ')}` })
        this.persistStateNow()
      }
      this.reinjectConstitution(messages)
    }
    // Briefing: компактное состояние проекта на старте сессии (детерминированно).
    // Git-снапшот (main считает один раз на проект) идёт прямо в стартовый
    // блок — отдельной асинхронной подсказки посреди рана больше нет.
    if (this.assistantsSettings.enabled && this.assistantsSettings.briefingEnabled && !this.briefingDone && this.role === 'main') {
      this.briefingDone = true
      const wm = this.onGetWorkingMemory?.(this.chatId ?? '') ?? ''
      const parts: string[] = []
      if (wm) parts.push(wm.slice(0, 600))
      const constit = this.constitution.serialize()
      if (constit) parts.push(constit)
      if (this.continuitySnapshot) parts.push(this.continuitySnapshot.slice(0, 1200))
      if (parts.length > 0) {
        const brief = `${BRIEFING_MARKER}\n${parts.join('\n')}`
        messages.push({ role: 'user', content: brief })
        callbacks.onStep({ type: 'hint', hintSource: 'briefing', content: brief.slice(0, 300) })
        this.onAssistantEvent?.({ kind: 'briefing' })
      }
    }
    this.liveMessages = messages
    this.toolDispatcher.rereadGuard = (p) => this.hasReadInContext(p)
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
    // §steer — новый ран не наследует реплики, присланные предыдущему
    // (они либо уже вставлены в его messages, либо ран был остановлен).
    this.pendingSteers = []
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
    const activeSchemas = (toolSchemas ?? [...TOOL_SCHEMAS]) as unknown as Array<{
      type: 'function'; function: { name: string; description?: string; parameters?: { type?: string; required?: string[]; properties?: Record<string, unknown> } }
    }>
    // Keep the worker's array identity: request_access appends permitted browser
    // schemas mid-run. Never mutate the global registry when no override is supplied.
    if (this.assistantsSettings.enabled && this.assistantsSettings.watcherEnabled && this.onAssistantEvent) {
      // Каталог скиллов читается с диска синхронно — строим после старта
      // первого запроса (setImmediate сработает на первом await), чтобы
      // не задерживать начало ответа модели.
      setImmediate(() => {
        try {
          this.onAssistantEvent?.({ kind: 'capabilities', capabilities: this.buildCapabilities() })
        } catch { /* каталог не критичен */ }
      })
    }
    const filteredSchemas = filterToolSchemas(activeSchemas, toolSettings)
    activeSchemas.splice(0, activeSchemas.length, ...filteredSchemas)
    if (!activeSchemas.some(schema => schema.function.name === 'recall_context')
      && (this.janitor.getArchiveSize() > 0 || (this.assistantsSettings.enabled && this.assistantsSettings.janitorEnabled))) {
      activeSchemas.push({
        type: 'function',
        function: {
          name: 'recall_context',
          description: 'Read an original tool result replaced by a [recall:id] summary. Paginated; use the returned next offset for more.',
          parameters: {
            type: 'object', required: ['archive_id'],
            properties: { archive_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 8000 } },
          },
        },
      })
    }
    const mcpDiscovery = new DeferredMcpTools(activeSchemas, options?.deferredMcpTools !== false && ctxSettings.deferredMcpTools !== false)
    mcpDiscovery.restoreSelections(messages, activeSchemas)
    const schemasForRequest = (permitted: typeof activeSchemas): typeof activeSchemas => {
      // A deliberately disabled discovery helper must not hide existing tools.
      return isToolDisabled('discover_mcp_tools', getToolSettings(this.store)) ? permitted : mcpDiscovery.forRequest(permitted)
    }
    // execute_code — обычный тул реестра (schemas/code.ts). Набор приходит из
    // getToolSchemas: normal-режим даёт его, ask/planning/read-only — нет.
    const artifacts = CODE_MODE_ARTIFACTS
    const autoMemoryInterval = Math.max(0, options?.autoMemoryInterval ?? 0)
    const maxRepeatedToolCalls = Math.max(2, options?.maxRepeatedToolCalls ?? 3)
    const maxRepeatedErrors = Math.max(2, options?.maxRepeatedErrors ?? 2)
    // planningMode — для явного напоминания в defense-in-depth (executeTool),
    // когда модель галлюцинирует вызовы тулов, отсутствующих в activeSchemas.
    const planningMode = !!options?.planningMode
    // §roles — sub-agent role for defense-in-depth (blockedMsg when model
    // hallucinates a tool outside the role's allowlist).
    const subagentRole = options?.subagentRole
    const subagentRoleDef = subagentRole ? getSubagentRole(subagentRole) : undefined

    // ── §orchestration ──────────────────────────────────────────────────────
    // Тот же самый цикл, но фазы исполняются ЯВНО выбранными моделями:
    // planning/replanning → planner, executing → executor, reviewing → reviewer.
    // Без снимка (options.orchestration === undefined) поведение не меняется
    // ни на байт: ни событий, ни инструкций, ни смены схем.
    const orchestration = options?.orchestration ? new OrchestrationRuntime(options.orchestration) : null
    this.orchestrationRuntime = orchestration
    let activePhaseModel: OrchestrationModel | null = orchestration?.currentModel() ?? null
    const emitOrchestration = (events: OrchestrationProgress[] | null | undefined): void => {
      if (!events || events.length === 0) return
      for (const event of events) {
        // Телеметрия не должна ломать ран.
        try { callbacks.onOrchestrationProgress?.(event) } catch { /* ignore */ }
      }
    }
    /**
     * Смена фазовой модели = смена провайдера в середине рана. Подписанные
     * thinking_blocks (Anthropic) и reasoning_content ([OI] thinking-mode) —
     * артефакты конкретной модели; чужой провайдер на них отвечает 400.
     * Снимаем их с истории (структура tool_calls/tool_call_id сохраняется).
     */
    const switchPhaseModel = (from: OrchestrationModel | null, to: OrchestrationModel | null): void => {
      if (!orchestration || sameModel(from, to)) return
      const cleaned = portableizeMessages(messages)
      if (cleaned > 0) log('[Agent] orchestration: portableized %d messages for cross-provider phase switch', cleaned)
    }
    const applyOrchestration = (events: OrchestrationProgress[], instruction?: string): void => {
      emitOrchestration(events)
      const nextModel = orchestration?.currentModel() ?? null
      switchPhaseModel(activePhaseModel, nextModel)
      activePhaseModel = nextModel
      if (instruction) messages.push({ role: 'user', content: instruction })
    }
    if (orchestration) {
      const resume = orchestration.run.resume
      // §resume — продолжение прерванного рана: план уже утверждён и часть
      // работы сделана, поэтому старт сразу с исполнения. Иначе планировщик
      // заново «исследует запрос» и пользователь видит Planning вместо остатка.
      emitOrchestration(orchestration.start(resume ? 'continuing the interrupted run' : 'researching the request'))
      const startModel = orchestration.currentModel()
      if (startModel) {
        messages.push({
          role: 'user',
          content: resume
            ? phaseInstruction('executing', startModel, { resume })
            : phaseInstruction('planning', startModel),
        })
      }
    }
    /** Обрыв/ошибка/бюджет: текущая фаза закрывается как blocked. */
    const blockOrchestration = (detail: string): void => {
      if (!orchestration) return
      const event = orchestration.block(detail)
      if (event) emitOrchestration([event])
    }
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
    // §final-answer — сколько раз модель «вызывала» несуществующий тул
    // final_answer без текста внутри. После 2 подсказок завершаем, чтобы
    // не крутить пустые раунды до maxSteps.
    let finalAnswerNudges = 0
    const nativeImageAnalysis = new NativeImageAnalysis()
    const runCallbacks = callbacks
    callbacks = {
      ...runCallbacks,
      onDone: (answer, details) => {
        // §goal — завершение прогона само по себе не вердикт: цель остаётся
        // set, если оценщик её не закрыл (как в [CC]).
        nativeImageAnalysis.fail('Визуальный анализ прерван: ответ модели не получен.', runCallbacks.onStep)
        runCallbacks.onDone(answer, details)
      },
      onError: (error) => {
        if (goalRuntime?.active) goalRuntime.handleError(error.message)
        nativeImageAnalysis.fail(`Визуальный анализ не завершён: ${error.message}`, runCallbacks.onStep)
        runCallbacks.onError(error)
      },
    }
    // Visual tool results are adapted by AIClient for each API. Never remove
    // pixels on a 400: that could turn a failed analysis into a false success.

    for (let step = 0; ; step++) {
      // §orchestration — схемы раунда = срез активного набора по фазе:
      // planning/reviewing/replanning получают только read-only allowlist,
      // executing — полный тулсет. Пересчитываем каждый раунд (request_access
      // может добавить тулы посреди рана).
      let permittedSchemas = orchestration ? filterSchemasForPhase(activeSchemas, orchestration.phase) : activeSchemas
      let roundSchemas = schemasForRequest(permittedSchemas)
      if (goalRuntime && !signal?.aborted) {
        if (!goalRuntime.active) {
          callbacks.onDone(`Цель закрыта: ${goalRuntime.goal.blocker ?? goalRuntime.goal.status}`, this.buildSummaryDetails(modifiedFiles))
          return
        }
        const reason = goalRuntime.beginRound()
        if (reason) {
          goalRuntime.stop('limit', reason)
          callbacks.onDone(`Цель остановлена: ${reason}`, this.buildSummaryDetails(modifiedFiles))
          return
        }
      }
      if (signal?.aborted) {
        nativeImageAnalysis.fail('Визуальный анализ остановлен до получения ответа модели.', callbacks.onStep)
        blockOrchestration('aborted by the user')
        callbacks.onDone('')
        return
      }
      // §orchestration — жёсткого бюджета токенов на модель-роль НЕТ: ран
      // идёт, пока исполнитель реально работает. Предохранители остаются
      // структурными (maxSteps, лимиты перепланирований/ревью, «Стоп»),
      // а расход по моделям виден в атрибуции карточки.

      // maxSteps раньше принимался как параметр, но никогда не проверялся —
      // цикл был фактически бесконечным (агент мог гонять тулы неограниченно
      // долго без реального прогресса, что выглядело как "зависание").
      // Теперь это реальный потолок: по достижении отдаём частичный ответ.
      if (step >= EFFECTIVE_MAX_STEPS) {
        console.log('[Agent] maxSteps=%s reached, finishing with partial answer', EFFECTIVE_MAX_STEPS)
        log('[Agent] run() достигнут maxSteps=%s, завершаю с частичным ответом', EFFECTIVE_MAX_STEPS)
        blockOrchestration('agent step limit reached')
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

      // §steer — реплики пользователя, присланные во время работы.
      // Вставляем ровно на границе раунда: все tool_result предыдущего раунда
      // уже лежат в messages (иначе user-сообщение разрезало бы пару
      // assistant.tool_calls → tool и сломало следующий запрос), а следующий
      // вызов модели гарантированно их увидит. Ничего не обрываем — текущий
      // стрим/тул доводится до конца, уже сделанная работа не теряется.
      if (this.pendingSteers.length > 0 && !signal?.aborted) {
        const incoming = this.pendingSteers.splice(0)
        for (const steer of incoming) {
          const steerText = `${STEER_MARKER}\n\n${steer.text}`
          // Картинки (vision) — multipart content, как у вложений обычной
          // отправки (Agent.ts ~line 556). Пиксели уже нормализованы и
          // бюджет-проверены в processAttachmentsAndStream на main-стороне.
          messages.push({
            role: 'user',
            content: steer.imageParts?.length
              ? [...steer.imageParts, { type: 'text' as const, text: steerText }]
              : steerText,
          })
          // Карточка в ленте рана: renderer заменит ею оптимистичную
          // pending-карточку (матчинг по steerId) и пометит «внедрено».
          // content — displayText (с [[attach:id]]-токенами): карточка рендерит
          // по ним чипы, история на следующих ходах токены вычищает.
          callbacks.onStep({
            type: 'steer',
            content: steer.displayText || steer.text,
            steerId: steer.id,
            steerApplied: true,
            ...(steer.attachments?.length ? { attachments: steer.attachments } : {}),
          })
          log('[Agent] steer applied round=%s chars=%d', step, steer.text.length)
        }
        // §navigator-protocol — постановка задачи изменилась: вердикты,
        // посчитанные по старой ревизии, не инжектятся (мост сравнивает).
        this.taskRevision++
        callbacks.onStatus?.('Учтено сообщение пользователя')
        // §orchestration — ревизия рана: вердикт ревью по старой постановке не
        // применяется, а идущее ревью возвращается к исполнению, чтобы
        // реплика пользователя была реально учтена исполнителем.
        if (orchestration) {
          orchestration.bumpRevision()
          if (orchestration.phase === 'reviewing') {
            applyOrchestration(orchestration.transition('executing', { detail: 'steer revision' }))
            permittedSchemas = filterSchemasForPhase(activeSchemas, orchestration.phase)
            roundSchemas = schemasForRequest(permittedSchemas)
          }
        }
      }

      if (this.pendingHints.length > 0 && !signal?.aborted && this.hintCooldown <= 0) {
        const incoming = this.assistantsSettings.enabled ? this.pendingHints.filter(hint => this.hintSourceEnabled(hint.source)) : []
        const { selected, remaining } = consumeHintBudget(incoming, this.assistantsSettings.hintBudgetTokens)
        this.pendingHints = remaining
        for (const { hint, text, message } of selected) {
          messages.push({ role: 'user', content: message })
          this.recentHintIds.add(hint.id)
          if (this.recentHintIds.size > 50) {
            const first = this.recentHintIds.values().next().value
            if (first) this.recentHintIds.delete(first)
          }
          callbacks.onStep({ type: 'hint', content: text, hintSource: hint.source, hintId: hint.id })
          // hint_applied — детерминированный сигнал полезности для весов
          // источников/возможностей в main (без LLM-судьи): подсказка реально
          // попала в промпт этого рана.
          this.onAssistantEvent?.({ kind: 'hint_applied', hintId: hint.id })
          if (hint.source === 'navigator') this.navigatorLastUsefulStep = step
          log('[Agent] hint injected round=%s source=%s chars=%d', step, hint.source, text.length)
        }
        this.hintCooldown = this.assistantsSettings.hintCooldownRounds
      }
      if (this.hintCooldown > 0) this.hintCooldown--

      this.janitorRoundCounter++
      // Умное расписание Janitor (Economist влит сюда): не спамим компакцией
      // на ранних ходах. Сжимаем только когда ран созрел (>25 шагов), есть
      // реальные повторы тулов, или контекст подбирается к порогу окна.
      // Оценка уже откалибрована в usageTracker (единый EWMA-коэффициент на
      // пару provider:model) — второй множитель здесь давал двойное сжатие.
      const requestContext = computeRequestContextSnapshot(messages, realContextWindow, roundSchemas)
      const calibratedTokens = requestContext.estimated
      // Порог относительно окна модели: 1M → 30%, 500k → 60%, 256k → 70%,
      // <256k → 80%. Ступень 1 (порог) — лёгкий дедуп, ступень 2 (+15%) —
      // глубокое сжатие с резюме. Отдельного «Economist» больше нет: это
      // ровно решение Janitor'а «когда и насколько глубоко сжимать».
      const ecoFrac = realContextWindow >= 1_000_000 ? 0.3 : realContextWindow >= 500_000 ? 0.6 : realContextWindow >= 256_000 ? 0.7 : 0.8
      const ecoThreshold = realContextWindow * ecoFrac
      const contextPressure = calibratedTokens > ecoThreshold
      const stage = calibratedTokens > ecoThreshold * 1.15 ? 2 : contextPressure ? 1 : 0
      if (stage > this.ecoStage) this.forceJanitorMode = stage === 2 ? 'deep' : 'light'
      this.ecoStage = stage
      const fpCounts = new Map<string, number>()
      for (const f of this.recentToolFingerprints) {
        const k = `${f.toolName}|${f.argsKey}`
        fpCounts.set(k, (fpCounts.get(k) ?? 0) + 1)
      }
      // Edge-триггер: сигнал «зациклился» нужен на ПЕРЕХОДЕ в повторы (или на
      // смене набора повторяемых вызовов), а не на каждом раунде, пока они
      // продолжаются, — иначе watcher/navigator получают одинаковый текст
      // каждые несколько шагов и просто шумят.
      const repeatSignature = [...fpCounts.entries()]
        .filter(([, count]) => count >= 3)
        .map(([key]) => key)
        .sort()
        .join(',')
      const repeatsEdge = repeatSignature !== this.lastRepeatSignature
      this.lastRepeatSignature = repeatSignature
      const heavyRepeats = repeatSignature.length > 0
      const matureRun = step >= 25
      // Navigator-ветка ниже владеет повторами эксклюзивно, когда он включён и
      // есть что сверять (цель/ограничения); иначе повторы уходят watcher'у.
      const navConstraints = this.constitution.list()
      const navigatorEligible = this.assistantsSettings.enabled
        && this.assistantsSettings.navigatorEnabled
        && (!!this.goal || navConstraints.length > 0)
        && !!this.onAssistantEvent
      if (heavyRepeats && repeatsEdge && navigatorEligible) this.navigatorProbe = true
      const scanMode = this.forceJanitorMode ?? 'deep'
      // Under pressure protect at least the configured tail when it is shorter
      // than four rounds; emergency must never increase the protected tail.
      const configuredTail = Math.max(1, this.assistantsSettings.janitorTailSteps ?? 10)
      const tailOverride = this.ecoStage >= 2
        ? Math.min(configuredTail, Math.max(2, Math.floor(configuredTail / 2)))
        : undefined
      const wantsJanitor = matureRun || heavyRepeats || contextPressure || !!this.forceJanitorMode
      const janitorDue = wantsJanitor && typeof this.janitor?.shouldScan === 'function'
        && this.janitor.shouldScan(this.janitorRoundCounter, messages as ChatMessage[], scanMode, tailOverride, !!this.forceJanitorMode)
      this.forceJanitorMode = null
      if (this.assistantsSettings.enabled && this.assistantsSettings.janitorEnabled && janitorDue) {
        const report = this.janitor.scan(messages as ChatMessage[], this.janitorRoundCounter, scanMode, tailOverride)
        log('[Agent] janitor scan round=%s mode=%s actions=%d saved=%d enabled=%s', this.janitorRoundCounter, scanMode, report.actions.length, report.totalTokensSaved, this.assistantsSettings.enabled)
        // J2: не применяем микро-компакции — они инвалидируют кэш чаще, чем экономят.
        if (report.actions.length > 0 && report.totalTokensSaved >= this.assistantsSettings.janitorMinSavingsTokens) {
          // Снапшот ДО скана уже посчитан в этом раунде — второй раз не считаем.
          this.applyJanitorReport(messages, report, callbacks, roundSchemas, realContextWindow, requestContext)
        } else {
          this.onAssistantEvent?.({ kind: 'janitor_skip' })
        }
      }
      // Navigator: mid-run drift-судья при активной цели ИЛИ активных ограничениях
      // (LLM в main). Протокол события несёт ревизию задачи и последний раунд,
      // в котором подсказка реально пригодилась: мост не судит по старой
      // постановке и не повторяет совет, который только что дали.
      if (navigatorEligible && this.onAssistantEvent) {
        this.navigatorRoundCounter++
        // Обычный ритм — раз в navigatorInterval раундов. Probe — раньше:
        // свежая ошибка или зацикливание уводят от цели, ждать 6 раундов
        // глупо; минимальная пауза 4 шага — от спама при серии ошибок.
        const dueCounter = this.navigatorRoundCounter % this.assistantsSettings.navigatorInterval === 0
        const dueProbe = this.navigatorProbe && step - this.navigatorLastStep >= 4
        if (dueCounter || dueProbe) {
          if (dueProbe) this.navigatorProbe = false
          this.navigatorLastStep = step
          const todoPart = this.currentTodo.length > 0
            ? this.currentTodo.slice(0, 8).map(t => `[${t.status}] ${t.text}`).join(' | ')
            : ''
          this.onAssistantEvent({
            kind: 'navigator',
            round: step,
            taskRevision: this.taskRevision,
            lastUsefulRound: this.navigatorLastUsefulStep,
            objective: this.goal?.objective ?? '',
            constraints: navConstraints,
            transcript: formatTranscript(messages.slice(-12) as ChatMessage[], { advisory: true, maxChars: 1100, perMessageChars: 240 }),
            todo: todoPart,
          })
        }
      }
      // Watcher v2: периодический само-подход раз в 15 раундов + stuck-сигнал
      // (только если navigator не забрал повторы себе).
      if (this.assistantsSettings.enabled && this.assistantsSettings.watcherEnabled && this.onAssistantEvent) {
        if (step > 0 && step % 15 === 0) {
          this.onAssistantEvent({ kind: 'capabilities', capabilities: this.buildCapabilities() })
          this.onAssistantEvent({ kind: 'watcher_trigger', trigger: { kind: 'periodic', text: formatTranscript(messages.slice(-8) as ChatMessage[]).slice(0, 600) } })
        }
        if (heavyRepeats && repeatsEdge && !navigatorEligible) {
          this.onAssistantEvent({ kind: 'watcher_trigger', trigger: { kind: 'stuck', text: `agent repeating tools: ${formatTranscript(messages.slice(-4) as ChatMessage[]).slice(0, 300)}` } })
        }
      }

      try {
        callbacks.onStatus?.('Waiting for response...')
        console.log('[Agent] round %s/%s: chatWithTools start (messages=%d, tools=%d)', step, EFFECTIVE_MAX_STEPS, messages.length, roundSchemas.length)
        log('[Agent] round %s/%s: chatWithTools start (messages=%d, tools=%d)', step, EFFECTIVE_MAX_STEPS, messages.length, roundSchemas.length)
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
        // §orchestration — модель ЭТОЙ фазы (может отличаться от модели
        // предыдущего раунда). undefined = обычный ран по назначениям роли.
        const phaseModel = orchestration?.currentModel() ?? null
        const phaseModelOverride = phaseModel
          ? { providerId: phaseModel.providerId, modelId: phaseModel.modelId, reasoningValue: phaseModel.reasoningValue }
          : undefined
        // §orchestration — стрим ответа в рантайме запрещён: текст плана,
        // вердикт ревьюера и ответы исполнителя на кругах revise не являются
        // ответом пользователю, а попадание их в live-пузырь давало дубли
        // (второй ответ исполнителя дописывался к первому). Финальный ответ
        // отдаётся РОВНО один раз в ветке outcome='done'.
        const streamPhaseAnswer = !orchestration
        // Match provider tokenization against the complete request, including tools.
        const trackUsage = (promptTokens: number, completionTokens: number, cacheRead?: number, cacheWrite?: number) => {
          if (goalRuntime) goalRuntime.addTokens(promptTokens + completionTokens)
          // Атрибуция расхода по модели-роли внутри рана.
          if (orchestration && phaseModel) orchestration.recordUsage(phaseModel, promptTokens, completionTokens)
          callbacks.onUsage?.(promptTokens, completionTokens, cacheRead, cacheWrite)
        }
        // §prompt-cache: конец ТЕКУЩЕГО запроса = breakpoint Anthropic.
        // Двигаем его каждый раунд (предыдущий снимается внутри метода) —
        // тогда «tools + system-статика + вся история до прошлого раунда»
        // читается из кеша, и по полной цене идёт только новый tool-результат.
        // Раньше якорь ставился лишь после janitor/overflow, поэтому обычный
        // ран платил полную цену за историю на каждом раунде.
        this.markCacheAnchor(messages)
        let response!: Awaited<ReturnType<typeof this.client.chatWithTools>>
        try {
          response = await goalWait(Promise.race([
            this.client.chatWithTools(
              messages,
              roundSchemas as typeof TOOL_SCHEMAS,
              signal,
              this.role,
              (token) => {
                resetInactivityTimer()
                if (!goalRuntime && streamPhaseAnswer) callbacks.onStep({ type: 'answer', content: token })
              },
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
              goalRuntime
                ? (promptTokens: number, completionTokens: number, cacheRead?: number, cacheWrite?: number) => {
                  // Расход цикла цели — для статуса /goal (как token spend в [CC]).
                  trackUsage(promptTokens, completionTokens, cacheRead, cacheWrite)
                }
                : trackUsage,
              (tok) => { resetInactivityTimer(); callbacks.onThinkingToken?.(tok) },
              callbacks.onThinkingDone,
              (index, rawToolName) => {
                const normalizedName = normalizeToolName(rawToolName, roundSchemas)
                // §final-answer — модель спутала тег <final_answer> с тулом.
                // Карточку-«вызов» в ленту не показываем вообще: такой вызов
                // будет вынут ниже, а его текст станет ответом.
                if (isFinalAnswerToolName(rawToolName) || isFinalAnswerToolName(normalizedName)) return
                const isHidden = normalizedName === 'update_working_memory' || normalizedName === 'update_todo'
                if (isHidden || isToolDisabled(normalizedName, getToolSettings(this.store))) return
                callbacks.onStep({
                  type: 'tool_call_pending',
                  toolName: normalizedName,
                  content: normalizedName,
                  callId: `pending-${step}-${index}`,
                })
              },
              // §orchestration — явная модель/провайдер/effort фазы.
              phaseModelOverride,
            ),
            inactivityTimeoutPromise,
          ]))
        } finally {
          if (inactivityTimer) clearTimeout(inactivityTimer)
        }

        if (signal?.aborted) {
          blockOrchestration('aborted by the user')
          callbacks.onDone('')
          return
        }

        // Раунд прошёл успешно (chatWithTools не бросил) — сбрасываем
        // счётчик последовательных ошибок.
        consecutiveErrors = 0
        console.log('[Agent] round %s: chatWithTools OK — tool_calls=%d, content=%d chars', step, response.tool_calls?.length ?? 0, (response.content || '').length)
        log('[Agent] round %s: chatWithTools OK — tool_calls=%d, content=%d chars', step, response.tool_calls?.length ?? 0, (response.content || '').length)

        // §final-answer — часть моделей принимает тег <final_answer> за имя
        // функции и «вызывает» несуществующий тул. Раньше это давало красную
        // карточку «Tool "final_answer" is unavailable…» и модель путалась.
        // Вынимаем такие вызовы ДО проверки схем: их текст становится обычным
        // текстом ответа, сами вызовы не попадают ни в ленту, ни в историю.
        if (response.tool_calls?.length) {
          const finalSplit = takeFinalAnswerToolCalls(response.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>)
          if (finalSplit.removed > 0) {
            log('[Agent] final_answer вызван как тул — вынут (%d), текста %d симв.',
              finalSplit.removed, finalSplit.text.length)
            response.tool_calls = finalSplit.calls as typeof response.tool_calls
            if (finalSplit.text) {
              // Оборачиваем в тег: если в этом же раунде есть настоящие тулы,
              // текст уйдёт в итерацию как «ход работы» — тег даёт UI понять,
              // что это ответ (см. splitFinalFromIters в MessageBubble).
              const tagged = finalSplit.text.includes('<final_answer>')
                ? finalSplit.text
                : `<final_answer>\n${finalSplit.text}\n</final_answer>`
              response.content = [response.content?.trim(), tagged].filter(Boolean).join('\n\n')
            } else {
              // Текста в аргументах не было — подсказываем и продолжаем раунд,
              // не отдавая пользователю пустой ответ.
              if (++finalAnswerNudges > 2) {
                callbacks.onDone(
                  response.content?.trim() || 'Не удалось получить итоговый ответ: модель пыталась вызвать несуществующий инструмент.',
                  this.buildSummaryDetails(modifiedFiles),
                )
                return
              }
              messages.push({
                role: 'user',
                content: '[final-answer] There is no tool named "final_answer" — do not call it. ' +
                  'Write the answer as plain text in your message, wrapped in <final_answer>…</final_answer>.',
              })
              continue
            }
          }
        }

        if (!response.tool_calls?.length) {
          const answer = response.content || ''
          nativeImageAnalysis.respond(this.toolDispatcher.maskSecretValuesInText(answer), false, callbacks.onStep)
          console.log('[Agent] no tool_calls: answer=%d chars, reasoning=%s', answer.length, response.reasoning ? `${response.reasoning.length} chars` : 'none')

          // ── Защита от пустого ответа после reasoning ──
          // Модель (например GLM) может стримить reasoning 80+ секунд,
          // исчерпать лимит и завершить стрим с пустым content.
          // В этом случае НЕ завершаем — продолжаем цикл, даём модели
          // шанс дать ответ, добавив assistant-сообщение с reasoning
          // и user-промпт "продолжи".
          // §goal — в режиме цели ход с пустым текстом всё равно нужно оценить:
          // вердикт выносится по транскрипту (вывод инструментов уже в нём),
          // поэтому «пустой ответ» не повод завершать без вердикта.
          if (!answer.trim() && !signal?.aborted && !goalRuntime) {
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

          if (!response.hadStreamedTokens && !goalRuntime && streamPhaseAnswer) {
            const words = answer.split(/(?<=\s)|(?=\s)/)
            for (const chunk of words) {
              if (signal?.aborted) {
                callbacks.onDone(answer)
                return
              }
              callbacks.onStep({ type: 'answer', content: chunk })
            }
          }

          if (goalRuntime) {
            // Ход завершился финальным ответом. Вердикт выносит ОТДЕЛЬНАЯ
            // модель по транскрипту (prompt-based Stop hook в [CC]) — не сам
            // агент. Его слова о готовности доказательством не считаются.
            if (answer.trim()) {
              messages.push({ role: 'assistant', content: answer,
                ...(response.reasoning ? { reasoning_content: response.reasoning } : {}),
                ...(response.thinking_blocks ? { thinking_blocks: response.thinking_blocks } : {}) })
            }
            if (signal?.aborted) { callbacks.onDone(answer); return }
            const decision = await goalRuntime.evaluate(formatTranscript(messages))
            if (decision === 'continue') {
              // reason оценщика уходит в следующий ход как указание (как в [CC]).
              messages.push({ role: 'user', content:
                `[goal] Not yet met: ${goalRuntime.goal.lastReason || 'the condition does not hold yet'}. ` +
                `Continue toward: ${goalRuntime.goal.objective}. ` +
                'Make the check visible in the conversation — run it and let the real output appear.' })
              continue
            }
            // В режиме цели токены не стримились (промежуточные ходы не должны
            // засорять сообщение), поэтому финальный текст отдаём одним блоком
            // — это ОБЫЧНЫЙ ответ модели, без синтетических приписок.
            const finalText = answer || (goalRuntime.goal.status === 'completed'
              ? goalRuntime.goal.lastReason || 'Готово.'
              : goalRuntime.goal.status === 'blocked'
                ? goalRuntime.goal.blocker || 'Цель невыполнима.'
                : 'Готово.')
            callbacks.onStep({ type: 'answer', content: finalText })
            // Успешная цель — такой же полноценный ран, как обычный финал:
            // Archivist получает тот же финальный транскрипт (раньше здесь
            // факты просто не дистиллировались).
            if (goalRuntime.goal.status === 'completed') this.emitArchivist(messages, modifiedFiles)
            callbacks.onDone(finalText, this.buildSummaryDetails(modifiedFiles))
            return
          }
          // §steer — финальный ответ пришёл, но пользователь успел прислать
          // реплику по ходу работы. Не завершаем ран: дописываем ответ в
          // messages как assistant, а следующая итерация цикла вставит реплику
          // и модель продолжит работу в ТОМ ЖЕ ране (тот же блок «хода работы»
          // в ленте, без нового пузыря и без потери уже сделанного).
          if (this.pendingSteers.length > 0 && !signal?.aborted) {
            // Раунд завершён — таймер бездействия этого раунда больше не нужен,
            // иначе он «выстрелит» посреди следующего.
            if (inactivityTimer) clearTimeout(inactivityTimer)
            if (answer.trim()) {
              messages.push({
                role: 'assistant',
                content: answer,
                ...(response.reasoning ? { reasoning_content: response.reasoning } : {}),
                ...(response.thinking_blocks ? { thinking_blocks: response.thinking_blocks } : {}),
              })
            }
            log('[Agent] steer pending on final answer — продолжаю ран вместо завершения')
            continue
          }
          // §orchestration — фаза закончилась финальным ответом. Решение
          // принимает фазовый автомат: план принят → executing; исполнитель
          // закончил → reviewing; approve/revise/replan → финал или новый круг.
          // Репланы и круги ревью ограничены (MAX_ORCHESTRATION_*).
          if (orchestration) {
            const advance = advanceAfterPhaseAnswer(orchestration, answer)
            const currentPhase = orchestration.phase
            if (answer.trim()) {
              messages.push({
                role: 'assistant',
                content: answer,
                ...(response.reasoning ? { reasoning_content: response.reasoning } : {}),
                ...(response.thinking_blocks ? { thinking_blocks: response.thinking_blocks } : {}),
              })
            }
            applyOrchestration(advance.events, advance.instruction)
            if (advance.outcome === 'done') {
              const finalAnswer = advance.answer ?? answer
              log('[Agent] orchestration DONE: replans=%d reviewRounds=%d answer=%d chars',
                orchestration.replanCount, orchestration.reviewRoundCount, finalAnswer.length)
              // Единственный answer рана. Промежуточные ответы фаз (план,
              // вердикт, круги revise) в пузырь не попадают — иначе после
              // revise/replan в сообщении оказывались два-три ответа подряд.
              if (finalAnswer.trim()) callbacks.onStep({ type: 'answer', content: finalAnswer })
              flushWorkingMemory(finalAnswer)
              this.emitArchivist(messages, modifiedFiles, finalAnswer === answer ? undefined : finalAnswer)
              callbacks.onDone(finalAnswer, this.buildSummaryDetails(modifiedFiles))
              return
            }
            if (advance.outcome === 'blocked') {
              callbacks.onError(new Error(advance.reason ?? 'Orchestration stopped'))
              return
            }
            log('[Agent] orchestration: phase %s ended, continuing in %s', currentPhase, orchestration.phase)
            continue
          }
          // §goal больше не подменяет финальный ответ синтетикой — цель
          // закрывается в блоке выше и отдаёт реальный ответ модели.
          this.emitArchivist(messages, modifiedFiles, answer)
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

        nativeImageAnalysis.respond(this.toolDispatcher.maskSecretValuesInText(response.content || ''), true, callbacks.onStep)
        if (goalRuntime && response.content?.trim()) callbacks.onStep({ type: 'answer', content: response.content })
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

        const resultMap = new Map<string, { contentForAI: string; callId: string; name: string; imageParts?: ContentPart[]; success?: boolean; diff?: string; janitorProtected?: boolean }>()
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
          const normalizedName = normalizeToolName(rawName, roundSchemas)
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
            // в повреждённом ответе провайдера. Логируем только метаданные:
            // parser messages могут включать текст аргументов.
            log('[Agent] JSON.parse tool arguments failed tool=%s chars=%d', normalizedName, (fn.arguments ?? '').length)
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
                log('[Agent] tryRepairJson tool=%s fixes=%d', normalizedName, repair.fixes.length)
              }
              // Слой 2: jsonrepair — структурный ремонт (усечение, скобки).
              // Работает на результате tryRepairJson.
              try {
                const jsonrepairResult = jsonrepair(workingJson)
                args = JSON.parse(jsonrepairResult)
                repaired = true
                log('[Agent] jsonrepair OK tool=%s preFixes=%d', normalizedName, repair.fixes.length)
              } catch {
                log('[Agent] jsonrepair failed tool=%s chars=%d', normalizedName, workingJson.length)
              }
              // Слой 3: salvage для edit_file — извлекаем path, old_str, new_str регексом.
              if (!repaired && normalizedName === 'edit_file') {
                const salvaged = salvageEditFileArgs(fn.arguments)
                if (salvaged) {
                  args = salvaged
                  repaired = true
                  log('[Agent] edit_file SALVAGE tool=%s oldChars=%d', normalizedName, String(salvaged.old_str).length)
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
            isHiddenTool: normalizedName === 'update_working_memory' || normalizedName === 'update_todo',
            pendingCallId,
          }
        })

        const executionCallbacks = callbacks
        const executeCall = async (item: NormalizedToolCall, nestedSignal?: AbortSignal): Promise<void> => {
          const callSignal = nestedSignal ?? signal
          if (callSignal?.aborted) return
          const callbacks = nestedSignal ? { ...executionCallbacks, onStep: () => {} } : executionCallbacks
          const { callId, fn, isHiddenTool, pendingCallId, parseError } = item
          if (goalRuntime && !goalRuntime.reserveTool()) {
            if (goalRuntime.active) goalRuntime.stop('limit', 'Goal tool-call or time budget exhausted')
            const content = 'Goal budget exhausted; tool was not executed.'
            resultMap.set(callId, { contentForAI: content, callId, name: fn.name })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content, success: false, callId, hidden: isHiddenTool })
            return
          }
          let args = item.args
          // Defense in depth: settings can change after schemas were built, and
          // provider/history/parallel calls can still name unavailable builtins.
          // Reject before approval, status, or execution callbacks are reached.
          if (isToolDisabled(fn.name, getToolSettings(this.store))) {
            const blockedMsg = `Tool "${fn.name}" is disabled in your settings and was not executed.`
            resultMap.set(callId, { contentForAI: blockedMsg, callId, name: fn.name })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: blockedMsg, success: false, callId, hidden: isHiddenTool })
            return
          }
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
                if (!nestedSignal) messages.push({
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
          // Актуальный todo — navigator'у: сверка «уход от плана», а не только
          // текстовой цели (judgeDrift иначе план вообще не видит).
          if (fn.name === 'update_todo') {
            const todoItems = (args as { items?: Array<{ text?: unknown; status?: unknown }> } | null)?.items
            if (Array.isArray(todoItems)) {
              this.currentTodo = todoItems.slice(0, 20).map(x => ({
                text: String(x?.text ?? '').slice(0, 200),
                status: String(x?.status ?? 'pending'),
              }))
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
                if (!nestedSignal) messages.push({ role: 'user', content: hardStopMsg })
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
                if (!nestedSignal) messages.push({ role: 'user', content: softMsg })
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
          // Code Mode retains its existing access to all permitted tools, with
          // the original schemas and approvals. Native calls must be advertised.
          const dispatchSchemas = nestedSignal ? schemasForRequest(permittedSchemas).concat(permittedSchemas) : roundSchemas
          const validation = validateAndCoerceArgs(fn.name, args, dispatchSchemas)
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
          const missingArgs = findMissingRequiredArgs(fn.name, args, dispatchSchemas)
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
          // §orchestration — второй, независимый от схем барьер: даже если
          // roundSchemas разошлись с фазой (request_access добавил тул посреди
          // рана, история подсказала имя), read-only фаза не выпустит
          // мутирующий тул и не пустит execute_code.
          if (orchestration && !isToolAllowedInPhase(orchestration.phase, fn.name)) {
            const phaseMsg = `Tool "${fn.name}" is not available in the ${orchestration.phase.toUpperCase()} phase `
              + '(read-only allowlist: research only, no edits/commands/code execution). '
              + 'The phase switches automatically when this turn ends — do not call it again.'
            resultMap.set(callId, { contentForAI: phaseMsg, callId, name: fn.name })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: phaseMsg, success: false, callId, hidden: isHiddenTool })
            return
          }
          const schemaNameSet = new Set(dispatchSchemas.map(s => s.function.name))
          if (!schemaNameSet.has(fn.name)) {
            const allowed = [...schemaNameSet].join(', ')
            // В planning-режиме даём явное напоминание вместо generic-блока —
            // модель могла скопировать edit/run тулы из старой истории чата.
            const blockedMsg = planningMode
              ? `You are in PLANNING MODE (read-only). "${fn.name}" is forbidden — edit/write/run tools are unavailable. Return to the protocol: Step 2 — read-only research (read_file, search_code, spawn_agent) + ask_user about hard parts. Step 3 — plan inside <plan title="..." summary="...">…</plan> with per-phase Ownership/Verification/Edge cases. Step 4 — review against the original request. Allowed tools: ${allowed}. Do not call "${fn.name}" again.`
              : subagentRoleDef
                ? `You are a ${subagentRoleDef.nameEn} sub-agent. "${fn.name}" is not available for this role. Allowed tools: ${allowed}. Sub-agents CANNOT spawn nested sub-agents — if the task genuinely needs "${fn.name}", report this to the parent agent. Do not call "${fn.name}" again.`
                : `Tool "${fn.name}" is unavailable in the current mode (read-only/planning/side-chat). Allowed only: ${allowed}. Do not call it again — use the allowed tools for research.`
            resultMap.set(callId, { contentForAI: blockedMsg, callId, name: fn.name })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: blockedMsg, success: false, callId, hidden: isHiddenTool })
            return
          }
          // Metadata-only local operation. It loads existing registered native
          // schemas next round; no server invocation or permission grant occurs.
          if (mcpDiscovery.isDiscovery(fn.name)) {
            const result = mcpDiscovery.discover(args, permittedSchemas)
            const content = result.success ? result.output : `Error: ${result.error}`
            resultMap.set(callId, { contentForAI: content, callId, name: fn.name, success: result.success })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content, success: result.success, callId })
            return
          }

          // §worktree — перенаправляем пути проекта в worktree суб-агента ДО
          // approval-проверки: иначе каждый edit_file/run_command с абсолютным
          // путём проекта классифицируется как «вне workdir» (workdir = worktree)
          // и требует подтверждения, хотя правка легитимна. Заодно правки
          // реально попадают в worktree (изоляция + merge через git apply).
          if (this.worktreeMap) {
            let remapped = false
            if ((fn.name === 'write_file' || fn.name === 'edit_file') && typeof args.path === 'string') {
              const mapped = this.mapPathToWorktree(args.path)
              if (mapped !== args.path) { args.path = mapped; remapped = true }
            } else if (fn.name === 'run_command' && typeof args.cwd === 'string') {
              const mapped = this.mapPathToWorktree(args.cwd)
              if (mapped !== args.cwd) { args.cwd = mapped; remapped = true }
            }
            if (remapped) {
              // Консистентность истории: tool_call в messages должен содержать
              // те же args, что реально исполнялись.
              try { fn.arguments = JSON.stringify(args) } catch { /* noop */ }
            }
          }

          // Читаем agentPermissions из store — раньше они были объявлены в
          // DEFAULT_SETTINGS и показаны в UI, но нигде не использовались.
          const agentPerms = (this.store.get('agentPermissions') as {
            confirmDangerous?: boolean
            dryRunMode?: boolean
            forbiddenPaths?: string[]
            autoMode?: Partial<import('../../shared/types').AutoModeSettings>
          } | undefined) ?? {}
          const dryRunMode = agentPerms.dryRunMode === true

          // ── Каскад project → global (§permissions) ──
          // Применяется одинаково к основному агенту и сабагентам проекта.
          const projectPerms = (this.store.get('projectPermissions') as
            Record<string, ProjectPermissionOverride> | undefined) ?? {}
          const projOverride = this.projectId ? projectPerms[this.projectId] : undefined
          const mode = projOverride?.approvalMode ?? callbacks.approvalMode ?? 'auto'
          const autoSettings = resolveAutoModeSettings(agentPerms, projOverride)
          const forbiddenPaths = mergeForbiddenPaths(agentPerms.forbiddenPaths, projOverride)

          // Code Mode does not get a separate execution path: nested calls still
          // use this exact approval decision. Its optional policy only adds a
          // stricter boundary in Auto mode; it never weakens normal approvals.
          const codeModePolicy = autoSettings.codeModePolicy
          const codeModeInternal = !!nestedSignal
          const approval = needsApproval(fn.name, args, mode, {
            auto: autoSettings,
            forbiddenPaths,
            workdir: this.workdir,
          })
          if (codeModeInternal && mode === 'auto' && codeModePolicy === 'ask' && !isHiddenTool
            && approval.level !== 'blocked' && approval.level !== 'dangerous') {
            approval.confirm = true
            if (!approval.reason) approval.reason = 'Внутренний вызов TypeScript Code Mode — требуется подтверждение'
          }
          if (codeModeInternal && codeModePolicy === 'read-only'
            && fn.name !== 'read_file' && fn.name !== 'read_files' && fn.name !== 'find_files'
            && fn.name !== 'search_code' && fn.name !== 'list_directory'
            && fn.name !== 'get_diagnostics'
            && fn.name !== 'recall_memory' && fn.name !== 'recall_context') {
            approval.block = true
            approval.reason = 'Code Mode настроен только для чтения и анализа'
          }
          // §allowlist — «Всегда разрешать»: пропускаем подтверждение, если
          // действие в allowlist. DANGEROUS-уровень allowlist'ом не покрывается
          // (кнопка в диалоге для dangerous скрыта, но проверим и здесь).
          if (approval.confirm && !approval.block && approval.level !== 'dangerous'
            && this.isActionAllowlisted(fn.name, args)) {
            approval.confirm = false
            approval.reason = ''
            log('[Agent] allowlist: пропуск подтверждения для %s', fn.name)
          }
          // §injection — эскалация после подозрительного контента: мутирующие
          // тулы спрашивают ВСЕГДА, поверх allowlist и настроек авто-режима.
          // Именно здесь ловится атака «страница говорит выполнить команду».
          if (this.injectionEscalation > 0 && !approval.block && isMutatingTool(fn.name) && mode !== 'full') {
            approval.confirm = true
            approval.reason = `После подозрительного контента (возможна prompt injection) — подтверждение обязательно (осталось шагов: ${this.injectionEscalation})`
          }
          // Диагностика «почему не спросил / почему спросил»: решение approval
          // нигде не писалось — невозможно было понять, какая ветка сработала.
          log(
            '[Agent] approval: tool=%s mode=%s confirm=%s block=%s reason="%s"',
            fn.name, mode, approval.confirm, approval.block, approval.reason,
          )
          const effectiveApproval = isHiddenTool ? { confirm: false, block: false, reason: '', level: approval.level } as typeof approval : approval

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

          // Тулы плагинов: per-tool флаг requiresApproval (registerTool).
          // Мутабельные тулы плагина спрашивают подтверждение всегда
          // (кроме full-режима), поверх allowlist и авто-настроек.
          const isPluginTool = fn.name.startsWith('plugin__')
          if (isPluginTool && !effectiveApproval.block && callbacks.onPluginRequiresApproval) {
            const pluginNeedsConfirm = callbacks.onPluginRequiresApproval(fn.name)
            if (pluginNeedsConfirm && mode !== 'full') {
              effectiveApproval.confirm = true
              if (!effectiveApproval.reason) effectiveApproval.reason = 'Тул плагина помечен как требующий подтверждения'
            }
          }

          // Dots: manage_dots — мутабельные action'ы (create/update/delete/wake)
          // всегда требуют подтверждения (кроме full-режима): агент управляет
          // always-on фоновыми агентами только с явного согласия пользователя.
          // list/get — read-only, подтверждения не требуют.
          if (fn.name === 'manage_dots' && mode !== 'full' && !effectiveApproval.block) {
            const dotsAction = String(args.action ?? '')
            if (dotsAction !== 'list' && dotsAction !== 'get') {
              effectiveApproval.confirm = true
              if (!effectiveApproval.reason) {
                effectiveApproval.reason = `Управление Dot'ами (action: ${dotsAction})`
              }
            }
          }

          if (effectiveApproval.block) {
            goalRuntime?.stop('blocked', `Permission block: ${effectiveApproval.reason}`)
            const blockMsg = `Action blocked (mode ${mode}): ${effectiveApproval.reason}`
            resultMap.set(callId, { contentForAI: blockMsg, callId, name: fn.name })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: blockMsg, success: false })
            return
          }

          if (goalRuntime && effectiveApproval.confirm && !callbacks.onConfirm) {
            goalRuntime.stop('blocked', `Approval unavailable for ${fn.name}`)
            resultMap.set(callId, { contentForAI: 'Approval required; tool not executed.', callId, name: fn.name })
            callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: 'Approval required; tool not executed.', success: false, callId })
            return
          }
          if (effectiveApproval.confirm && callbacks.onConfirm) {
            const decision = await callbacks.onConfirm(fn.name, args)
            if (callSignal?.aborted) return
            const approved = typeof decision === 'boolean' ? decision : decision?.approved === true
            if (!approved) {
              resultMap.set(callId, { contentForAI: 'Действие отклонено пользователем.', callId, name: fn.name })
              goalRuntime?.stop('blocked', `Approval rejected for ${fn.name}; no automatic retry`)
              callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: 'Rejected by the user', success: false, callId, hidden: isHiddenTool })
              return
            }
            // §allowlist — «Всегда разрешать» из диалога: записываем в scope
            const always = typeof decision === 'object' && decision ? decision.always : undefined
            const match = typeof decision === 'object' && decision ? decision.match : undefined
            if (always && approval.level !== 'dangerous' && approval.level !== 'blocked') {
              this.recordAllowlist(fn.name, args, always, match)
            }
          }

          if (callSignal?.aborted || (goalRuntime && !goalRuntime.active)) return
          callbacks.onStatus?.(`${fn.name}...`)
          console.log('[Agent] exec tool: %s callId=%s (step=%d)', fn.name, callId, step)
          log('[Agent] exec tool: %s callId=%s', fn.name, callId)
          let result: ToolResult
          let codeTrace: CodeTraceEntry[] | undefined
          try {
            // execute_code — обычный тул реестра, тот же путь, что у остальных.
            // Гард нужен только на случай, когда его нет в наборе: персона с
            // явным allowlist или disabledTools. Тогда вызов отклоняется, а не
            // исполняется (модель может галлюцинировать имя).
            if (fn.name === 'execute_code' && !roundSchemas.some(s => s.function.name === 'execute_code')) {
              const unavailable = 'Tool "execute_code" is unavailable in the current mode.'
              resultMap.set(callId, { contentForAI: unavailable, callId, name: fn.name })
              callbacks.onStep({ type: 'tool_result', toolName: fn.name, content: unavailable, success: false, callId })
              return
            }
            if (fn.name === 'execute_code') {
              const code = typeof args.code === 'string' ? args.code : ''
              const codeResult = await executeCode({
                code, chatId: this.chatId, signal: callSignal,
                artifacts,
                sanitizeTrace: value => this.toolDispatcher.maskSecretValuesInText(JSON.stringify(value ?? null)),
                // Живой трейс: вложенный тул появляется в карточке сразу
                // (status 'running'), а не только в финальном tool_result.
                // Телеметрия не должна ломать выполнение скрипта.
                onTrace: entry => {
                  try { callbacks?.onCodeTrace?.(entry) } catch { /* ignore */ }
                },
                callTool: async (toolName, toolArgs, childSignal) => {
                  if (childSignal?.aborted || signal?.aborted) return { success: false, output: '', error: 'Execution aborted' }
                  // §orchestration — вложенный вызов из Code Mode не может
                  // обойти фазовый allowlist: и схема, и сама фаза проверяются.
                  if (toolName === 'execute_code' || !schemasForRequest(permittedSchemas).concat(permittedSchemas).some(s => s.function.name === toolName)
                    || (orchestration && !isToolAllowedInPhase(orchestration.phase, toolName))) {
                    const reason = `Tool "${toolName}" is unavailable in the current run.`
                    return { success: false, output: '', error: reason }
                  }
                  const internalId = `code-${callId}-${Math.random().toString(36).slice(2, 9)}`
                  const toolArguments = JSON.stringify(toolArgs ?? {})
                  const internalItem = {
                    callId: internalId,
                    call: { id: internalId, type: 'function', function: { name: toolName, arguments: toolArguments } },
                    fn: { name: toolName, arguments: toolArguments },
                    args: (toolArgs && typeof toolArgs === 'object' ? toolArgs : {}) as Record<string, unknown>,
                    parseError: undefined,
                    isHiddenTool: false,
                    pendingCallId: undefined,
                  } as unknown as NormalizedToolCall
                  await executeCall(internalItem, childSignal)
                  const internalResult = resultMap.get(internalId)
                  resultMap.delete(internalId)
                  if (!internalResult) return { success: false, output: '', error: childSignal?.aborted ? 'Execution aborted' : 'Tool was blocked or cancelled.' }
                  const text = internalResult.contentForAI
                  const failed = internalResult.success === false || /(?:Action blocked|Rejected by the user|Действие отклонено пользователем|Approval required; tool not executed|unavailable in the current run|Permission block|Permission denied|blocked by loop guard|Hard loop guard|Loop guard|is disabled|unavailable in the current mode|not available in the current mode)/i.test(text)
                  // Failure/отказ НЕ обрывает скрипт: возвращаем его внутрь гостя как
                  // {success:false, error}, чтобы try/catch мог продолжить.
                  return {
                    success: !failed,
                    output: text,
                    ...(failed ? { error: text } : {}),
                    ...(internalResult.diff ? { diff: internalResult.diff } : {}),
                  }
                },
              })
              codeTrace = codeResult.trace
              result = { success: codeResult.success, output: codeResult.output, error: codeResult.error }
            } else {
              const toolPromise = this.executeTool(fn.name, args, callbacks, dryRunMode, callId, callSignal)
              // MCP and sub-agents manage their own timeouts and cancellation.
              if (isMcpTool || fn.name === 'spawn_agent') {
                result = await toolPromise
              } else {
                let timer: ReturnType<typeof setTimeout> | undefined
                const timeout = new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error(`Tool ${fn.name} exceeded the execution timeout (${MAX_TOOL_TIMEOUT_MS / 1000}s).`)), MAX_TOOL_TIMEOUT_MS)
                })
                try { result = await Promise.race([toolPromise, timeout]) }
                finally { clearTimeout(timer) }
              }
            }
          } catch (toolErr) {
            // Раньше throw из executeTool протекал в outer try/catch и
            // интерпретировался как API/network error (emit '_error' +
            // "Сеть недоступна"). Теперь — честный tool_result с реальным
            // сообщением, агент может обработать и продолжить.
            const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr)
            result = { success: false, output: '', error: `Internal tool error in ${fn.name}: ${errMsg}` }
          }
          if (isMcpTool && callSignal?.aborted) return

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
              // §rollback — в undoStack кладём АБСОЛЮТНЫЙ путь. file_snapshots
              // из undoStack попадают в БД и используются chat:rewindTo /
              // chat:undoLastTurnFiles для восстановления файлов; относительный
              // путь там резолвился бы против process.cwd() main-процесса
              // (папка установки приложения), а не workdir чата — файлы
              // «откатывались» в никуда.
              let snapPath = p
              try { snapPath = resolve(this.workdir ?? process.cwd(), p) } catch { /* raw path */ }
              pendingMutations.push(() => {
                modifiedFiles.add(p)
                successfulEditCount++
                // §1.8 — сохраняем оригинал для undo (null = файл был создан заново)
                this.undoStack.push({ path: snapPath, originalContent: origContent ?? null })
                if (this.undoStack.length > 50) this.undoStack.shift()  // ограничиваем стек
                // §rollback-live — отдаём снапшот в main СРАЗУ: при Stop/краше
                // воркера финальный onDone не придёт, и без стрима правки этого
                // прогона остались бы неоткатываемыми (filesChanged=0).
                const snap = { path: snapPath, contentBefore: origContent ?? null }
                try { callbacks.onFileSnapshot?.(snap) } catch { /* колбэк не должен ломать выполнение тула */ }
                try { this.onFileSnapshot?.(snap) } catch { /* то же */ }
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
          // См. TOOL_RESULT_HARD_CEILING — раньше const; потолок режет до
          // injection-скана и маскировки, чтобы не сканировать/маскировать мегабайты.
          let cappedRawContent = rawContent
          if (!imageUrl && cappedRawContent.length > TOOL_RESULT_HARD_CEILING) {
            cappedRawContent = truncateToolResult(cappedRawContent, TOOL_RESULT_HARD_CEILING)
            log('[Agent] tool %s вернул %d симв — обрезан до %d (TOOL_RESULT_HARD_CEILING)',
              fn.name, rawContent.length, cappedRawContent.length)
          }
          const errorHint = !result.success ? getToolErrorHint(fn.name, result.error ?? '') : ''

          // §injection — скан результатов внешнего/файлового контента.
          // Подозрительный результат: оборачиваем в untrusted-маркеры и
          // открываем окно эскалации (мутирующие тулы → подтверждение всегда).
          // §secrets — маскирование значений при чтении секретных файлов:
          // модель видит структуру .env, но не сами секреты.
          let finalContent = (cappedRawContent || '') + errorHint
          if (!imageUrl && finalContent) {
            if (isScannedTool(fn.name)) {
              // §v2 — эскалация ТОЛЬКО для внешнего контента (web-туры) при
              // strong-паттерне/пороге weak. Локальные read_file не эскалируют:
              // исходники клиента содержат «system prompt» на каждом шагу,
              // и эскалация от каждого read_file превращала авто-режим в
              // «спрашивать всегда». Обёртка <untrusted_data> остаётся для всех.
              const scan = scanForInjection(finalContent, isWebSourceTool(fn.name))
              if (scan.suspicious) {
                finalContent = wrapUntrustedContent(finalContent, scan)
                log('[Agent] injectionGuard: подозрительный контент от %s — паттерны: %s (strong=%d weak=%d escalate=%s)',
                  fn.name, scan.patterns.join(', '), scan.strongCount, scan.weakCount, scan.escalate)
                if (scan.escalate && this.injectionEscalation === 0) {
                  // Не перезаряжаем активное окно — иначе серия suspicious-ридов
                  // держала эскалацию бесконечно. Тикает до нуля и гаснет.
                  this.injectionEscalation = INJECTION_ESCALATION_STEPS
                  callbacks.onStep({
                    type: 'tool_result',
                    toolName: '_injection_guard',
                    content: `⚠ Подозрительный контент в результате ${fn.name}: ${scan.patterns.slice(0, 3).join(', ')}. Следующие изменяющие действия потребуют подтверждения.`,
                    success: true,
                    hidden: true,
                  })
                }
              }
            }
            if (fn.name === 'read_file' && isSecretPath(String(args.path ?? ''))) {
              finalContent = maskSecretValues(finalContent)
            }
            // §secrets — маскировка значений защищённых переменных в результатах
            // ЛЮБОГО тула: если AI случайно получила реальное значение (через
            // вывод команды, содержимое файла и т.д.) — заменяем обратно на
            // ${{KEY}}, чтобы модель никогда не видела секрет.
            if (this.toolDispatcher.secretValues && this.toolDispatcher.secretValues.size > 0) {
              finalContent = this.toolDispatcher.maskSecretValuesInText(finalContent)
            }
          }
          // Окно эскалации тикает на каждый выполненный тул
          if (this.injectionEscalation > 0) this.injectionEscalation--

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
            || fn.name === 'spawn_agent'
            || fn.name === 'manage_chats' // Own bounded output + offset pagination; preserve valid JSON.
            || fn.name === 'recall_context' // Already paged to <=8000 chars; keep the advertised next offset valid.
            || mcpDiscovery.isDiscovery(fn.name) // Bounded JSON pages retain exact names and next_offset.
            || fn.name === 'fetch_page'  // своя обрезка по maxChars (default 50000) с сообщением
            // Плагинные и MCP-тулы — НЕ обрезаем вообще: автор тула сам
            // отвечает за размер вывода (plugin_docs отдаёт секции доков
            // целиком ~10k симв., read_plugin сам лимитирует до 40k).
            // truncateToolResult резал середину без подсказки — модель
            // не могла дочитать потерянный кусок (у plugin_docs нет
            // offset/частей) и теряла API-документацию. Предохранитель
            // от переполнения контекста — rolling-компакция.
            || fn.name.startsWith('plugin__')
            || fn.name.startsWith('mcp__')
          const perToolMax = (fn.name === 'search_code' || fn.name === 'get_file_outline')
            ? Math.max(ctxSettings.toolMaxChars, 20000)
            : ctxSettings.toolMaxChars
          const contentForAI = (!imageUrl && ctxSettings.toolTruncEnabled && !noTruncTool)
            ? truncateToolResult(finalContent, perToolMax)
            : finalContent

          if (!result.success && !isHiddenTool) {
            // Fingerprint ошибки включает args (через buildToolFingerprint —
            // как и tool-call guard выше), иначе параллельные вызовы одного
            // тула с разными args (напр. 3 spawn_agent с разными task),
            // упавшие с одинаковой generic-ошибкой, ложно триггерят guard.
            const errFp = buildToolFingerprint(fn.name, args)
            const errorFingerprint = `${fn.name}:${errFp.argsKey}:${(result.error ?? '').slice(0, 120)}`
            this.recentErrorFingerprints.push(errorFingerprint)
            // Свежая ошибка — navigator'у повод свериться с целью/ограничениями.
            this.navigatorProbe = true
            if (this.recentErrorFingerprints.length > maxRepeatedErrors) {
              this.recentErrorFingerprints.shift()
            }
            const repeatedErrors = this.recentErrorFingerprints.length >= maxRepeatedErrors &&
              this.recentErrorFingerprints.every(entry => entry === errorFingerprint)
            if (repeatedErrors) {
              if (!nestedSignal) messages.push({
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

          // analyze_image прямой пас: тул может вернуть imageParts (картинка
          // для vision-способной основной модели). Перед вложением проверяем
          // бюджет раунда — иначе несколько больших картинок в одном запросе
          // дают 413 «request too large» и ломают чат.
          const returnedImageParts = (result as { imageParts?: ContentPart[] }).imageParts
          let acceptedImageParts: ContentPart[] | undefined = returnedImageParts
          let imageBudgetNote = ''
          if (returnedImageParts?.length) {
            // Бюджет общий с историей (imageBudget): провайдер считает лимиты
            // на весь запрос, поэтому несколько больших картинок подряд в одном
            // раунде раньше складывались в один запрос без ограничения —
            // 6 файлов по 3.5 МБ давали ~28 МБ payload и гарантированный 413.
            const infos = imagePayloadInfos(returnedImageParts)
            const reason = infos.map(info => imageBudget.reject(info)).find(r => r !== null) ?? null
            if (reason) {
              acceptedImageParts = undefined
              imageBudgetNote = `\n[Image pixels were NOT attached: ${reason}. Continue without these pixels (do not retry this tool now) or ask the user to send the image in a new message.]`
            } else {
              for (const info of infos) imageBudget.accept(info)
            }
          }
          const nativeVisualHandoff = fn.name === 'analyze_image' && result.success && !!acceptedImageParts?.length
          // UI/БД-копия: потолок обязателен — messageToContextMessages на
          // следующих ходах разворачивает toolSteps из БД целиком, сырой
          // гигант здесь вернулся бы в контекст (см. TOOL_RESULT_HARD_CEILING).
          const maskedVisible = this.toolDispatcher.maskSecretValuesInText(result.output || result.error || '')
          const visibleToolContent = imageUrl
            ? 'Изображение сгенерировано'
            : (maskedVisible.length > TOOL_RESULT_HARD_CEILING
              ? truncateToolResult(maskedVisible, TOOL_RESULT_HARD_CEILING)
              : maskedVisible)
          if (nativeVisualHandoff) nativeImageAnalysis.add(callId, visibleToolContent, result.imagePaths)
          callbacks.onStep({
            type: 'tool_result',
            toolName: fn.name,
            // §secrets — контент шага уходит в UI и БД, а из БД разворачивается
            // обратно в контекст модели на следующих ходах
            // (chatContextHelpers.messageToContextMessages). Маскируем ЗДЕСЬ,
            // иначе история возвращает модели сырые значения секретов.
            content: visibleToolContent,
            success: result.success,
            ...(nativeVisualHandoff ? { visualAnalysis: { status: 'pending' as const } } : {}),
            imageUrl,
            imagePaths: result.imagePaths,
            diff: (result as { diff?: string }).diff,
            callId,
            hidden: isHiddenTool || !!(result as { hidden?: boolean }).hidden,
            serverName: extractMcpServerName(fn.name),
            ...(fn.name === 'execute_code' ? { codeMode: { code: String(args.code ?? ''), trace: codeTrace ?? [] } } : {}),
          })

          // analyze_image прямой пас: тул может вернуть imageParts (картинка
          // для vision-способной основной модели) — прокидываем их в
          // tool-сообщение ниже.
          const toolDiff = (result as { diff?: string }).diff
          resultMap.set(callId, {
            contentForAI: imageBudgetNote ? `${contentForAI}${imageBudgetNote}` : contentForAI,
            callId,
            name: fn.name,
            success: result.success,
            ...(toolDiff ? { diff: toolDiff } : {}),
            janitorProtected: !result.success || !!(toolDiff || imageUrl || result.imagePaths?.length || nativeVisualHandoff),
            ...(acceptedImageParts?.length ? { imageParts: acceptedImageParts } : {}),
          })
        }

        const parallelCalls = normalizedCalls.filter((item) => item.fn.name !== 'execute_code' && !isSequentialTool(item.fn.name))
        const sequentialCalls = normalizedCalls.filter((item) => item.fn.name === 'execute_code' || isSequentialTool(item.fn.name))

        if (goalRuntime) {
          // Serial evidence ordering: a concurrent read cannot verify a mutation.
          for (const item of normalizedCalls) await goalWait(executeCall(item))
        } else {
          if (parallelCalls.length > 0) await Promise.all(parallelCalls.map(item => executeCall(item)))
          for (const item of sequentialCalls) await executeCall(item)
        }

        for (const mutation of pendingMutations) mutation()

        for (const item of normalizedCalls) {
          const r = resultMap.get(item.callId)
          messages.push({
            role: 'tool',
            tool_call_id: item.callId,
            name: item.fn.name,
            ...((r?.success !== true || r?.janitorProtected) ? { janitorProtected: true } : {}),
            // analyze_image прямой пас: если тул вернул imageParts (основная
            // модель vision-capable) — отдаём картинку прямо в tool-сообщении
            // как multipart content. AIClient сохраняет эти блоки для
            // Anthropic, а для OpenAI/Responses переносит пиксели в user
            // ПОСЛЕ всех парных tool-результатов раунда.
            content: r?.imageParts?.length
              ? [...r.imageParts, { type: 'text' as const, text: r.contentForAI }]
              : r?.contentForAI ?? '',
          })
        }

        if (
          !goalRuntime && // Goal checks must use the normal approved tool path.
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

        if (nativeImageAnalysis.size) {
          // Only after ALL paired tool results: never interrupt call/result groups.
          messages.push({ role: 'user', content: nativeImageAnalysis.instruction() })
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
          this.reinjectConstitution(messages)
          this.markCacheAnchor(messages)
        }

        if (callbacks.onContextUpdate) {
          // Единая оценка на актуальном массиве messages (system[0]+history
          // с tool_calls+tool results+current user). breakdown консистентен
          // с computeContextSnapshot / AIClient.onContextCounted — больше
          // никаких отдельных формул, дающих другие числа.
          const snap = computeRequestContextSnapshot(messages, realContextWindow, schemasForRequest(permittedSchemas))
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
          nativeImageAnalysis.fail('Визуальный анализ остановлен до получения ответа модели.', callbacks.onStep)
          blockOrchestration('aborted by the user')
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
            this.reinjectConstitution(messages)
            this.markCacheAnchor(messages)
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
        // Do not strip images on 400. AIClient already uses the API's supported
        // visual-input format; preserve the provider error instead of losing pixels.
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
    } finally {
      // §goal — завершение прогона не снимает цель: она остаётся set, пока её
      // не закроет оценщик или пользователь (как в [CC]).
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
    callId?: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (name === 'recall_context') {
      const output = this.janitor.recallPage(String(args.archive_id ?? ''), Number(args.offset ?? 0), Number(args.limit ?? 4000))
      return output === null
        ? { success: false, output: '', error: 'Context archive entry not found. Repeat the original read/search if available.' }
        : { success: true, output }
    }
    return this.toolDispatcher.executeTool(name, args, callbacks, dryRun, callId, signal)
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
    const details = this.toolDispatcher.buildSummaryDetails(modifiedFiles)
    // §orchestration — атрибуция расхода по моделям-ролям и история фаз
    // уезжают вместе с итогом рана (main может персистить/показать).
    if (this.orchestrationRuntime) details.orchestration = this.orchestrationRuntime.summary()
    return details
  }
}
