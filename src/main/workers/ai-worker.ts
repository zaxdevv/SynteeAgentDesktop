/**
 * AI Worker Thread — весь AI/Agent код здесь.
 * При worker.terminate() все соединения рвутся мгновенно OS-ом.
 * Сохранение происходит в main thread через сообщение 'done'.
 */
import { parentPort, workerData } from 'worker_threads'
import { AIClient, setGatewayToken, setGatewayTokenRefresher, setCodexToken, setCodexTokenRefresher } from '../../core/ai/AIClient'
import { Agent } from '../../core/agent/Agent'
import { classifyTool } from '../../core/agent/commandSafety'
import { writeFile, editFile } from '../../core/tools/index'
import { buildPlanningInjection, buildAskInjection } from '../../core/prompts/buildSystemPrompt'
import { getModelContextWindow } from '../../core/context/contextManager'
import {
  buildSnapshotFromReal, estimateCost, getModelPriceInfo, importCalibration, setCalibrationModel,
} from '../../core/tokens/usageTracker'
import {
  buildContextUsagePayload, type ContextUsageBreakdown, type ContextUsagePayload,
  type ContextUsageSnapshot, type ContextUsageSource,
} from '../../shared/contextUsage'
import { setAIUsageSink, setDefaultAIUsageContext } from '../../core/ai/requestUsage'
import { initModelCatalog } from '../../core/tokens/modelCatalog'
import { setGatewayModelsCache } from '../../core/tokens/gatewayModelsCache'
import { getToolSchemas } from '../../core/tools/index'
import { requestBrowserOperation } from '../../core/agent/browserWorkerBroker'
import { requestMcpTool } from '../../core/mcp/mcpWorkerBroker'
import { filterToolSchemas, getToolSettings } from '../../shared/toolSettings'
import { teardownSidecar } from '../../core/sidecar/sidecarClient'
import { log, setDefaultLogPrivacy, flushLogs } from '../../core/logger'
import { installRustTokenCounter } from '../../core/tokens/rustTokenCounter'
import type { ModelMeta, McpToolRuntime, PluginToolRuntime } from '../../shared/types'

const storeData: Record<string, unknown> = workerData.storeData
const planningMode: boolean = !!(workerData as Record<string, unknown>).planningMode
// §orchestration — снимок фазовых моделей (planning/executing/reviewing/
// replanning). main снимает его на старте хода; undefined = обычный ран.
const orchestration = (workerData as Record<string, unknown>).orchestration as
  import('../../shared/orchestration').OrchestrationRun | undefined
const askMode: boolean = !!(workerData as Record<string, unknown>).askMode
// Тумблер «Управление браузером»: browser_* тулы в тулсете с самого старта
// рана. Может быть включён ПОСРЕДИ рана (request_access → confirm) — тогда
// onBrowserAction мутирует runTools (см. ниже), следующий раунд уже с тулами.
const browserMode: boolean = !!(workerData as Record<string, unknown>).browserMode
const imageMode: boolean = !!(workerData as Record<string, unknown>).imageMode
// Runtime copies are flipped after request_access approval without rebuilding
// the worker or its initial tool snapshot.
let runBrowserMode = browserMode
let runImageMode = imageMode
const workerMode: 'code' | 'work' = ((workerData as Record<string, unknown>).mode as 'code' | 'work') ?? 'code'

// Инициализируем каталог моделей из кэш-файла (записанного main-процессом)
const catalogCachePath = (workerData as Record<string, unknown>).catalogCachePath as string | undefined
if (catalogCachePath) {
  try { initModelCatalog(catalogCachePath) } catch { /* ok — работаем без каталога */ }
}

// Снапшот кэша gateway-моделей из main: в worker-потоке свой экземпляр кэша
// (gateway:fetchModels работает только в main), поэтому main передаёт его
// через workerData. Нужен getModelContextWindow / getModelPriceInfo для
// провайдера 'syntee-gateway' — gateway первоисточник contextWindow/цен.
const gatewayModelsSnapshot = (workerData as Record<string, unknown>).gatewayModels as ModelMeta[] | undefined
if (Array.isArray(gatewayModelsSnapshot)) setGatewayModelsCache(gatewayModelsSnapshot)

// Кэш статусов суб-агентов — обновляется через agent_status_update от main
const agentStatusCache = new Map<string, { status: string; stepsCount: number; currentStep?: string }>()

// Единый реестр одноразовых reply-handlers (replyId → resolver)
const replyHandlers = new Map<string, (msg: Record<string, unknown>) => void>()

// Флаг — агент уже запущен (стартовое сообщение обработано)
let agentStarted = false
const runAbort = new AbortController()
/**
 * §steer — экземпляр агента текущего рана. Нужен, потому что сообщения
 * parentPort.on('message') обрабатываются НОВЫМ вызовом хендлера: локальная
 * переменная `agent` живёт в замыкании стартового сообщения и оттуда
 * недоступна. Ссылку выставляем сразу после создания Agent'а.
 */
let steerAgent: Agent | null = null
/**
 * §steer — реплики, пришедшие ДО создания Agent'а (worst case: пользователь
 * зажал кнопку в тот момент, когда воркер ещё инициализируется). Храним и
 * переливаем в agent.pushSteer сразу после создания — иначе молча теряем.
 * Форма совпадает с extra-аргументом pushSteer (displayText/imageParts/
 * attachments) — переливаем запись целиком.
 */
type SteerEntry = { id: string; text: string; displayText?: string; imageParts?: import('../../core/agent/types').ContentPart[]; attachments?: import('../../shared/types').SteerAttachmentMeta[] }
const earlySteers: SteerEntry[] = []
const earlyHints: Array<import('../../shared/assistants').HintCandidate> = []
let earlyAssistantsSettings: import('../../shared/assistants').AssistantsSettings | null = null

/**
 * Настройки мини-агентов для ЭТОГО воркера, известные с самого старта.
 *
 * Раньше единственным источником был postMessage 'assistants_settings' из
 * attachAssistants — а он молча выходит, когда глобальный тумблер выключен
 * (и вообще не вызывается для суб-агентов). Воркер стартовал с
 * DEFAULT_ASSISTANTS_SETTINGS (enabled: true), и первый раунд успевал
 * прогнать briefing/janitor/watcher, хотя мини-агенты выключены.
 * Теперь снапшот приходит в workerData и применяется ДО первого раунда.
 *
 * Суб-агент: детерминированный janitor (свёртка tool-результатов, без LLM)
 * остаётся, LLM-роли гасятся — у суб-агента нет UI и локальная модель ему
 * не положена (onAssistantEvent ему тоже не ставим, см. ниже).
 */
function resolveWorkerAssistantsSettings(): import('../../shared/assistants').AssistantsSettings | null {
  const data = workerData as Record<string, unknown>
  const raw = data.assistantsSettings as import('../../shared/assistants').AssistantsSettings | undefined
  if (!raw || typeof raw.enabled !== 'boolean') return null
  if (!data.isSubAgent) return raw
  return {
    ...raw,
    watcherEnabled: false,
    navigatorEnabled: false,
    archivistEnabled: false,
    briefingEnabled: false,
  }
}

// set() мутирует локальную копию storeData — иначе API key round-robin
// (AIClient.getClientForRole -> getNextApiKey -> store.set('providers', ...))
// был no-op, и агент всегда брал один и тот же ключ провайдера на каждом
// шаге, даже если пользователь настроил несколько ключей для балансировки.
// Изменение не переживает воркер (не пишется в electron-store в main), но
// хотя бы работает корректно внутри одного запуска агента.
const fakeStore = {
  get: (key: string, def?: unknown) => (storeData[key] !== undefined ? storeData[key] : def),
  set: (key: string, val: unknown) => { storeData[key] = val },
} as never

const aiClient = new AIClient(fakeStore)
setAIUsageSink(event => send({ type: 'request_usage', event }))

// Refresher gateway-токена для AIClient: worker сам рефрешить не может
// (electron-store/tokenStore в worker_threads недоступны), поэтому просит
// main-процесс через postMessage round-trip. Ответ приходит в общий
// on('message') ниже → replyHandlers. Таймаут 10с — если main не ответил
// (умирает/занят), считаем сессию мёртвой (null).
setGatewayTokenRefresher(() => new Promise<string | null>((resolve) => {
  const replyId = `gw-refresh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const timer = setTimeout(() => {
    replyHandlers.delete(replyId)
    resolve(null)
  }, 10000)
  replyHandlers.set(replyId, (reply) => {
    clearTimeout(timer)
    const token = (reply.token as string | null) ?? null
    if (token) setGatewayToken(token)
    resolve(token)
  })
  send({ type: 'gateway_token_refresh', replyId })
}))

// Refresher Codex-токена (ChatGPT-подписка): та же схема round-trip в main,
// потому что codexAuth живёт в main-процессе (electron-store + safeStorage).
setCodexTokenRefresher(() => new Promise<string | null>((resolve) => {
  const replyId = `cx-refresh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const timer = setTimeout(() => {
    replyHandlers.delete(replyId)
    resolve(null)
  }, 15000)
  replyHandlers.set(replyId, (reply) => {
    clearTimeout(timer)
    const token = (reply.token as string | null) ?? null
    if (token) setCodexToken(token)
    resolve(token)
  })
  send({ type: 'codex_token_refresh', replyId })
}))

// Стартовый Codex-токен из main (в worker нет доступа к codexAuth).
const codexTokenAtStart = (workerData as Record<string, unknown>).codexToken as string | null | undefined
if (codexTokenAtStart) setCodexToken(codexTokenAtStart)

// Native analyze_image lifecycle (см. shared/types ToolStep.visualAnalysis).
// Основная модель получает пиксели напрямую; исходный tool_result помечается
// 'pending', а отдельный tool_result_update приносит 'responded'/'failed'.
type VisualAnalysis = {
  status: 'pending' | 'responded' | 'failed'
  findings?: string
}

function send(msg: Record<string, unknown>) {
  parentPort?.postMessage(msg)
}

// ЕДИНЫЙ handler — все входящие сообщения через один on('message')
parentPort?.on('message', async (msg: Record<string, unknown>) => {
  if (msg.type === 'abort_run') {
    runAbort.abort()
    return
  }
  // --- §steer: реплика пользователя внутрь активного рана ---
  // НЕ прерываем текущий стрим/тул: Agent придержит её до границы раунда и
  // вставит в messages как user-сообщение с маркером. Обрабатываем ДО
  // `if (agentStarted) return` — иначе после старта сообщение отбрасывалось.
  if (msg.type === 'steer') {
    const text = typeof msg.text === 'string' ? msg.text : ''
    const steerId = typeof msg.steerId === 'string' && msg.steerId ? msg.steerId : `steer-${Date.now()}`
    // §steer — вложения: text уже инлайнен main'ом (processAttachmentsAndStream),
    // imageParts — пиксели для vision, displayText — как написал пользователь
    // (с [[attach:id]]-токенами), attachments — мета для карточки/БД.
    const imageParts = Array.isArray(msg.imageParts)
      ? msg.imageParts as import('../../core/agent/types').ContentPart[]
      : undefined
    const attachments = Array.isArray(msg.attachments)
      ? msg.attachments as import('../../shared/types').SteerAttachmentMeta[]
      : undefined
    if (!text.trim() && !imageParts?.length) return
    const entry: SteerEntry = { id: steerId, text }
    if (typeof msg.displayText === 'string' && msg.displayText.trim()) entry.displayText = msg.displayText
    if (imageParts?.length) entry.imageParts = imageParts
    if (attachments?.length) entry.attachments = attachments
    if (steerAgent) steerAgent.pushSteer(steerId, text, entry)
    else earlySteers.push(entry)
    return
  }
  // --- §steer: пользователь передумал, реплику снимаем до внедрения ---
  if (msg.type === 'steer_cancel') {
    const steerId = typeof msg.steerId === 'string' ? msg.steerId : ''
    if (!steerId) return
    if (steerAgent) steerAgent.cancelSteer(steerId)
    const idx = earlySteers.findIndex(s => s.id === steerId)
    if (idx >= 0) earlySteers.splice(idx, 1)
    return
  }
  if (msg.type === 'hint') {
    const hint = msg.hint as import('../../shared/assistants').HintCandidate | undefined
    if (!hint?.id || !hint?.content) return
    if (steerAgent) steerAgent.pushHint(hint)
    else earlyHints.push(hint)
    return
  }
  if (msg.type === 'assistants_settings') {
    const settings = msg.settings as import('../../shared/assistants').AssistantsSettings | undefined
    if (settings && steerAgent) steerAgent.setAssistantsSettings(settings)
    else if (settings) earlyAssistantsSettings = settings
    return
  }
  // --- Reply от main (spawn_agent_reply, get_agent_status_reply) ---
  if (msg.replyId) {
    const handler = replyHandlers.get(msg.replyId as string)
    if (handler) {
      replyHandlers.delete(msg.replyId as string)
      handler(msg)
    }
    return
  }

  // --- Обновление статуса суб-агента ---
  if (msg.type === 'agent_status_update' && msg.agentId) {
    agentStatusCache.set(msg.agentId as string, msg.statusData as never)
    return
  }

  // --- Стартовое сообщение — запуск агента (только один раз) ---
  if (agentStarted) return
  agentStarted = true
  console.log('[ai-worker] START chatId=%s msgId=%s content=%d chars history=%d msgs enableTools=%s',
    (msg as { chatId?: string }).chatId, (msg as { msgId?: string }).msgId,
    ((msg as { content?: string }).content || '').length,
    ((msg as { history?: unknown[] }).history || []).length,
    (msg as { enableTools?: boolean }).enableTools)

  const {
    chatId, msgId, content, history,
    systemPrompt, enableTools, incognito,
    agentSettings,
    toolSchemas,
    subagentRole,
    modelId: resolvedModelId,
    providerId: resolvedProviderId,
    imageParts,
  } = msg as {
    chatId: string
    msgId: string
    content: string
    history: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string; thinking_blocks?: Array<{ thinking: string; signature: string }>; reasoning_content?: string }>
    systemPrompt: string
    enableTools: boolean
    incognito: boolean
    toolSchemas?: unknown[]
    subagentRole?: string
    modelId?: string
    providerId?: string
    imageParts?: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }>
    agentSettings: {
      enableTools: boolean
      maxSteps: number
      approvalMode: import('../../shared/types').ApprovalMode
      toolOutputMode: string
      enableThinking: boolean
      autoMemoryInterval?: number
      readFileCache?: boolean
      maxRepeatedToolCalls?: number
      maxRepeatedErrors?: number
    }
  }

  setDefaultAIUsageContext({ chatId, source: subagentRole ? 'subagent' : 'main' })
  setDefaultLogPrivacy(!!incognito)
  // Калибровка оценки — по фактической модели запроса (после резолва).
  setCalibrationModel(resolvedProviderId ?? '', resolvedModelId ?? '')
  let fullText = ''
  let thinkingText = ''
  let thinkingStartMs = 0
  let thinkingMs: number | undefined
  const collectedSteps: unknown[] = []

  // Накопленные реальные токены от провайдера по всем LLM-вызовам turn'а.
  // onUsage может срабатывать несколько раз в агент-режиме (по разу на каждый
  // LLM-вызов) — суммируем. Передаётся в main через done/error-сообщения и
  // сохраняется в Message для развёртываемой панели статистики в UI.
  let accPromptTokens = 0
  let accCompletionTokens = 0
  let accCacheReadTokens = 0
  let accCacheWriteTokens = 0
  const accumulateUsage = (p?: number, c?: number, cr?: number, cw?: number) => {
    if (typeof p === 'number' && p > 0) accPromptTokens += p
    if (typeof c === 'number' && c > 0) accCompletionTokens += c
    if (typeof cr === 'number' && cr > 0) accCacheReadTokens += cr
    if (typeof cw === 'number' && cw > 0) accCacheWriteTokens += cw
  }
  const usagePayload = () => ({
    promptTokens: accPromptTokens || undefined,
    completionTokens: accCompletionTokens || undefined,
    cacheReadTokens: accCacheReadTokens || undefined,
    cacheWriteTokens: accCacheWriteTokens || undefined,
  })

  // Итерации для сохранения в БД — {label?, textBefore, thinking?, thinkingMs?, steps[]}
  const collectedIters: Array<{ label?: string; textBefore: string; thinking?: string; thinkingMs?: number; steps: unknown[] }> = []
  let currentIterTextBefore = ''
  let currentIterSteps: unknown[] = []
  let pendingTextAfter = ''  // текст после последнего тулчейна

  // Thinking для текущей итерации — прикрепляется к итерации при flush
  let currentIterThinking = ''
  let currentIterThinkingMs: number | undefined

  // Pending thinking — накопленное reasoning текущего раунда, ждёт прикрепления к итерации
  let pendingThinking = ''
  let pendingThinkingMs: number | undefined

  // Live token counter — оценка контекста agora comes from onContextCounted
  // (начало раунда) и onContextUpdate (конец раунда) через единую функцию
  // computeContextSnapshot. Больше НЕТ отдельной sendLiveContextUsage с
  // stale historyBaseTokens — она была главным источником «скачков» кольца,
  // т.к. считалась один раз на старте воркера и расходилась с реальным
  // массивом messages в следующих раундах.
  const isSubAgentWorker = !!(workerData as Record<string, unknown>).isSubAgent
  const contextWindow = getModelContextWindow(storeData, isSubAgentWorker ? 'subagent' : 'main')

  // Калибровка оценки контекста: коэффициенты приходят из main (worker не
  // видит electron-store). Ключ модели выставляется ниже — по modelId из
  // стартового сообщения, когда он уже резолвлен.
  importCalibration((workerData as Record<string, unknown>).contextCalibration as Record<string, number> | undefined)

  // Последний breakdown для мерджа с реальным usage (buildSnapshotFromReal
  // масштабирует его пропорционально promptTokens вместо verbatim-наследования).
  let lastBreakdown: ContextUsageBreakdown | undefined

  /**
   * Единственный путь эмита context_usage из воркера.
   *
   * Раньше pct/status/формат payload собирались в пяти местах вручную
   * (`Math.round(x / limit * 100)`, пороги 85/60) и без chatId — main не мог
   * отбросить событие чужого чата, а renderer-фильтр не срабатывал никогда.
   * Теперь арифметика живёт в shared/contextUsage, chatId уходит всегда.
   * `extra` — поля поверх контракта (например raw* токены turn'а для main).
   */
  const emitContextUsage = (
    snapshot: ContextUsageSnapshot,
    source: ContextUsageSource,
    extra: Partial<ContextUsagePayload> & Record<string, unknown> = {},
  ): void => {
    send({
      type: 'context_usage',
      ...buildContextUsagePayload({
        chatId,
        snapshot,
        source,
        scope: extra.scope,
        compressed: extra.compressed,
        historyMessages: extra.historyMessages,
        toolCallsCount: extra.toolCallsCount,
        pricing: extra.pricing,
        estimatedCostCents: extra.estimatedCostCents,
        providerId: extra.providerId,
        modelId: extra.modelId,
      }),
      ...extra,
    })
  }

  const flushIter = () => {
    if (currentIterSteps.length > 0) {
      collectedIters.push({
        textBefore: currentIterTextBefore,
        thinking: currentIterThinking || undefined,
        thinkingMs: currentIterThinkingMs,
        steps: currentIterSteps,
      })
      currentIterTextBefore = ''
      currentIterSteps = []
      currentIterThinking = ''
      currentIterThinkingMs = undefined
    }
  }

  let agent: Agent | null = null

  const finalize = (details?: unknown) => {
    flushLogs()
    flushIter()
    // §steer — ран закрыт: новые реплики этому агенту уже не нужны.
    steerAgent = null
    console.log('[ai-worker] finalize: fullText=%d chars, steps=%d, iters=%d', fullText.length, collectedSteps.length, collectedIters.length)
    // Если после последней итерации остался thinking или текст — создаём финальную итерацию
    if (collectedIters.length > 0 && (pendingThinking || pendingTextAfter.trim())) {
      collectedIters.push({
        textBefore: pendingTextAfter,
        thinking: pendingThinking || undefined,
        thinkingMs: pendingThinkingMs,
        steps: [],
      })
      pendingThinking = ''
      pendingTextAfter = ''
    }
    const fileCacheUpdates = agent ? agent.getFileCacheUpdates() : undefined
    send({
      type: 'done',
      chatId, msgId,
      fullText,
      thinkingText: thinkingText || undefined,
      thinkingMs,
      collectedSteps,
      collectedIters: collectedIters.length > 0 ? collectedIters : undefined,
      ...usagePayload(),
      // Round-robin индекс мутировался в этой копии storeData (см. fakeStore.set)
      // — прокидываем обновлённых providers обратно в main, чтобы ротация
      // ключей продолжалась со следующего сообщения, а не сбрасывалась.
      updatedProviders: storeData.providers,
      // Персистентный кэш файлов — обновлённые записи для main-процесса
      fileCacheUpdates,
      // Структурированный результат агента (файлы, diff-и, команды) — для суб-агентов
      agentSummary: details,
      incognito,
      content,
    })
    // This thread is done with Fast Context: stop its Rust sidecar child so it
    // does not outlive the worker thread as an orphan process.
    void teardownSidecar()
  }

  try {
    // incognito больше не гейтит тузы — только персистентность (память/история).
    // Side-чат (incognito) получает read-only набор тулов из chat.ipc.ts
    // (sideToolSchemas), а Agent выполняет только то, что есть в schemas.
    // Память гейтится отдельно: onUpdateWorkingMemory не ставится для incognito.
    if (enableTools) {
      const isSubAgent = !!(workerData as Record<string, unknown>).isSubAgent
      agent = new Agent(fakeStore, isSubAgent ? 'subagent' : 'main')
      // §steer — exposing the instance to the shared on('message') handler +
      // сливаем реплики, пришедшие пока воркер ещё не был готов.
      steerAgent = agent
      for (const s of earlySteers.splice(0)) agent.pushSteer(s.id, s.text, s)
      for (const h of earlyHints.splice(0)) agent.pushHint(h)
      if (earlyAssistantsSettings) { agent.setAssistantsSettings(earlyAssistantsSettings); earlyAssistantsSettings = null }
      else {
        // Снапшот из workerData — чтобы глобальный Off действовал с первого
        // раунда (сообщение 'assistants_settings' от attachAssistants может
        // не прийти вообще, если мини-агенты выключены).
        const snapshotSettings = resolveWorkerAssistantsSettings()
        if (snapshotSettings) agent.setAssistantsSettings(snapshotSettings)
      }
      // Briefing continuity (git log/status) — снапшот из main: воркер git не
      // запускает, снапшот считается один раз на проект с кешем/коалесингом
      // (src/main/assistants/gitBriefingCache.ts) и идёт прямо в стартовый
      // briefing-блок, без отдельной подсказки посреди рана.
      agent.continuitySnapshot = ((workerData as Record<string, unknown>).briefingContinuity as string | undefined) ?? ''

      // Мутабельный тулсет рана: request_access может включить browser-тулы
      // ПОСРЕДИ рана (подтверждение юзера) — Agent держит ссылку на массив
      // (toolSchemas ?? TOOL_SCHEMAS в каждом раунде), мутируем на месте,
      // следующий раунд уже с browser_* тулами. Без пересборки рана.
      const toolSettings = getToolSettings(fakeStore)
      const initialToolSchemas = (toolSchemas as typeof getToolSchemas extends (...args: never[]) => infer R ? R : never) ?? getToolSchemas({
          customToolsEnabled: toolSettings.customToolsEnabled,
          disabledTools: toolSettings.disabledTools,
          planningMode,
          askMode,
          imageMode,
          browserMode,
          mode: workerMode,
          mcpTools: ((workerData as Record<string, unknown>).mcpTools as McpToolRuntime[] | undefined) ?? [],
          pluginTools: ((workerData as Record<string, unknown>).pluginTools as PluginToolRuntime[] | undefined) ?? [],
        })
      const runTools = filterToolSchemas(initialToolSchemas, toolSettings)
      // Delegated chats are main-process ordinary chats, not sub-agent jobs.
      // AgentManager does not expose this backend to sub-agents.
      if (isSubAgent) {
        const index = runTools.findIndex(t => t.function.name === 'manage_chats')
        if (index >= 0) runTools.splice(index, 1)
      }
      // request_access может включить browser_control или image_generation
      // посреди рана. Добавляем только запрошенную capability и оставляем
      // request_access, если вторая capability всё ещё выключена.
      const enableCapabilityMidRun = (capability: 'browser_control' | 'image_generation'): number => {
        const names = new Set(runTools.map(t => t.function.name))
        const permitted = filterToolSchemas(getToolSchemas({
          planningMode, askMode, imageMode: capability === 'image_generation' || runImageMode,
          browserMode: capability === 'browser_control' || runBrowserMode, mode: workerMode, ...toolSettings,
        }), toolSettings)
        const capabilitySchemas = capability === 'browser_control'
          ? permitted.filter(t => t.function.name.startsWith('browser_'))
          : permitted.filter(t => t.function.name === 'generate_image')
        const additions = capabilitySchemas.filter(t => !names.has(t.function.name))
        for (const schema of additions) runTools.push(schema)
        if (capability === 'browser_control') runBrowserMode = true
        else runImageMode = true
        const stillNeedsAccess = !runBrowserMode || !runImageMode
        if (!stillNeedsAccess) {
          const idx = runTools.findIndex(t => t.function.name === 'request_access')
          if (idx >= 0) runTools.splice(idx, 1)
        }
        console.log('[ai-worker] %s access granted mid-run: added %d tools (total=%d)', capability, additions.length, runTools.length)
        return additions.length
      }

      // Прокидываем chatId и колбэки рабочей памяти
      agent.messageId = msgId
      agent.chatId = chatId
      // Персист мини-агентов (конституция + recall-архив): main-чат, не
      // инкогнито — инкогнито не должен оставлять след на диске.
      agent.persistAssistantState = !incognito && !isSubAgent
      const runGoal = msg.goal as import('../../shared/types/goal').ChatGoal | undefined
      // §goal — активная (running) и приостановленная (paused) цель участвуют
      // в следующем ходе: отправка сообщения возобновляет цикл (как в [CC]).
      if (!incognito && !isSubAgent && runGoal?.chatId === chatId
        && (runGoal.status === 'running' || runGoal.status === 'paused')) {
        agent.goal = runGoal
        agent.onGoalProgress = goal => send({ type: 'goal_progress', goal })
      }
      // workdir чата (новые Code-чаты после фичи workdir; undefined для
      // Work-режима и старых чатов — поведение остаётся прежним).
      agent.workdir = (workerData as Record<string, unknown>).workdir as string | undefined
      // §worktree — маппинг projectRoot → worktreePath для перенаправления
      // путей мутирующих тулов суб-агента в его worktree.
      agent.worktreeMap = (workerData as Record<string, unknown>).worktreeMap as
        { projectRoot: string; worktreePath: string } | undefined
      agent.userDataPath = (workerData as Record<string, unknown>).userDataPath as string | undefined
      agent.projectId = (workerData as Record<string, unknown>).projectId as string | undefined
      agent.verificationCommand = (workerData as Record<string, unknown>).verificationCommand as string | undefined
      // Gateway JWT для веб-поиска через аккаунт (fallback на локальный Tavily
      // ключ если токен отсутствует/истёк — см. tools/web.ts).
      agent.gatewayToken = (workerData as Record<string, unknown>).gatewayToken as string | undefined
      agent.gatewayApiUrl = process.env.SYNTEE_API_URL

      // Защищённые переменные: key → decrypted value. Строим Map из plain
      // объекта, переданного через workerData (structured clone не поддерживает Map).
      const secretValuesRaw = (workerData as Record<string, unknown>).secretValues as Record<string, string> | undefined
      if (secretValuesRaw && Object.keys(secretValuesRaw).length > 0) {
        agent.secretValues = new Map(Object.entries(secretValuesRaw))
      }

      // This thread owns its own sidecar child; point token counting at it so
      // BPE work stays off the worker's event loop as well.
      try { installRustTokenCounter() } catch (e) { console.warn('[ai-worker] installRustTokenCounter FAILED:', e) }
      // Incognito-чаты (side chat) не пишут рабочую память — не ставим
      // callback, Agent сам короткозит через проверку !this.onUpdateWorkingMemory.
      if (!incognito) {
        agent.onUpdateWorkingMemory = (cid, content, mode) => {
          console.log('[ai-worker] update_working_memory:', cid, mode, content.length, 'chars')
          send({ type: 'update_working_memory', chatId: cid, content, mode })
        }
        agent.onGetWorkingMemory = (cid) => {
          // Синхронно читаем из БД — getWorkingMemory импортирован в main thread
          // В воркере нет прямого доступа к БД — используем кэш из workerData
          const wm = (workerData as Record<string, unknown>).workingMemory as string | undefined
          console.log('[ai-worker] getWorkingMemory:', cid, '->', wm?.length ?? 0, 'chars')
          return wm ?? ''
        }
      }
      // Live-обновление файлов: при записи/редактировании файла агентом —
      // шлём сообщение в main-процесс, который форвардит в renderer как
      // 'file:changed' IPC event для обновления открытых файловых табов.
      agent.onFileChanged = (filePath) => {
        send({ type: 'file_changed', path: filePath })
      }
      // §rollback-live — {path, contentBefore} на КАЖДУЮ правку файла, сразу
      // после её применения. main копит их в ActiveRun.liveSnapshots и
      // использует, если финальный done с fileSnapshots не пришёл (Stop через
      // worker.terminate, краш/выход воркера) — иначе такие правки нельзя
      // было откатить вообще (чекпоинт с filesChanged=0).
      agent.onFileSnapshot = (snapshot) => {
        send({ type: 'file_snapshot', chatId, msgId, snapshot })
      }
      // Канал для LLM-зависимых мини-агентов (navigator/archivist) — main
      // решает, запускать ли локальную модель. Суб-агенту он не ставится
      // вовсе: у него нет своего UI-чата в main, а детерминированные роли
      // (janitor-свёртка) работают и без LLM-событий.
      if (!isSubAgent) {
        agent.onAssistantEvent = (evt) => {
          send({ type: 'assistant_event', chatId, ...evt })
        }
      }

      // Синхронизируем workdir/projectId/chatId/gateway/колбэки в ToolDispatcher —
      // они устанавливаются ПОСЛЕ конструктора Agent, но ToolDispatcher создаётся
      // в конструкторе и без sync остаётся с undefined workdir/projectId.
      agent.syncToolDispatcher()

      console.log('[ai-worker] calling agent.run()... content=%d chars, history=%d msgs', content.length, history.length)
      await agent.run(
        content,
        {
          signal: runAbort.signal,
          onContextCounted: (info) => {
            lastBreakdown = info.breakdown
            emitContextUsage(
              { estimated: info.promptTokens, limit: contextWindow, breakdown: info.breakdown },
              'estimate',
              { scope: 'request' },
            )
          },
          // Живой трейс вложенных тулов execute_code — ephemeral, не пишется
          // в collectedSteps/БД: карточка показывает «что выполняется сейчас».
          onCodeTrace: (entry) => {
            send({ type: 'code_trace', chatId, msgId, entry })
          },
          onStep: (step) => {
            // §rollback-live — снапшоты файлов стримим отдельным сообщением
            // (см. onFileSnapshot ниже), здесь только шаги.
            // Скрытые тулы (update_todo, update_working_memory) — не шлём в UI
            if (step.hidden) {
              return
            }
            if (step.type === 'tool_call_pending') {
              // Ранний сигнал "модель начала вызывать тул X" — ЕЩЁ до того как
              // JSON аргументов полностью собран. Не пишем в collectedSteps —
              // это временное отображение, которое renderer заменит на
              // настоящий tool_call (см. pendingCallId матчинг в ChatPage.tsx).
              // Не персистится в БД само по себе.
              send({ type: 'step', chatId, msgId, step })
              return
            }
            if (step.type === 'tool_call') {
              const ts = {
                id: `${Date.now()}-${Math.random()}`,
                type: step.type,
                toolName: step.toolName,
                toolArgs: step.toolArgs,
                content: step.content,
                success: step.success,
                timestamp: Date.now(),
                imageUrl: step.imageUrl,
                callId: step.callId,
                pendingCallId: step.pendingCallId,
                codeMode: (step as { codeMode?: unknown }).codeMode,
              }
              collectedSteps.push(ts)
              if (pendingTextAfter.trim() || pendingThinking) {
                flushIter()
                currentIterTextBefore = pendingTextAfter
                currentIterThinking = pendingThinking
                currentIterThinkingMs = pendingThinkingMs
                pendingTextAfter = ''
                pendingThinking = ''
                pendingThinkingMs = undefined
              } else if (currentIterSteps.length === 0) {
                currentIterTextBefore = pendingTextAfter
                pendingTextAfter = ''
              }
              currentIterSteps.push(ts)
              send({ type: 'step', chatId, msgId, step })
            } else if (step.type === 'tool_result') {
              const ts = {
                id: `${Date.now()}-${Math.random()}`,
                type: step.type,
                toolName: step.toolName,
                toolArgs: step.toolArgs,
                content: step.content,
                success: step.success,
                timestamp: Date.now(),
                imageUrl: step.imageUrl,
                imagePaths: step.imagePaths,
                diff: (step as { diff?: string }).diff,
                callId: step.callId,
                // Native analyze_image: исходный result помечен 'pending' —
                // пиксели уже отданы основной модели, визуальный ответ ждём
                // отдельным tool_result_update (persist вместе с шагом).
                visualAnalysis: (step as { visualAnalysis?: VisualAnalysis }).visualAnalysis,
                codeMode: (step as { codeMode?: unknown }).codeMode,
              }
              collectedSteps.push(ts)
              currentIterSteps.push(ts)
              send({ type: 'step', chatId, msgId, step })

              // Live-обновление token counter после tool_result больше НЕ
              // эмитим отдельной sendLiveContextUsage — она считалась по
              // stale historyBaseTokens и вызывала прыжки кольца. Точное
              // значение придёт на onContextCounted следующего раунда и
              // onContextUpdate (конец текущего) — обе через единую
              // computeContextSnapshot на актуальном массиве messages.

            } else if ((step as { type: string }).type === 'tool_result_update') {
              // Native analyze_image: приходит ПОСЛЕ исходного tool_result (в
              // одном из следующих раундов). НЕ добавляем новый шаг и НЕ
              // создаём итерацию — обновляем существующий result in-place.
              // Объект result разделяется по ссылке между collectedSteps,
              // currentIterSteps и steps уже зафлашенных collectedIters,
              // поэтому мутация видна во всех местах (дублей не появляется).
              const upd = step as unknown as {
                type: string
                toolName?: string
                callId?: string
                content?: string
                success?: boolean
                visualAnalysis?: VisualAnalysis
              }
              const matches = (s: unknown): boolean => {
                const t = s as { type?: string; callId?: string; toolName?: string }
                if (!t || t.type !== 'tool_result') return false
                if (upd.callId) return t.callId === upd.callId
                return t.toolName === upd.toolName
              }
              const apply = (s: unknown): boolean => {
                if (!matches(s)) return false
                const t = s as { content?: string; success?: boolean; visualAnalysis?: VisualAnalysis }
                if (upd.visualAnalysis) t.visualAnalysis = upd.visualAnalysis
                if (upd.success !== undefined) t.success = upd.success
                if (upd.content) t.content = upd.content
                return true
              }
              for (const s of collectedSteps) apply(s)
              for (const s of currentIterSteps) apply(s)
              for (const it of collectedIters) for (const s of it.steps) apply(s)
              // Форвардим в renderer — там immutable-замена по callId.
              send({ type: 'step', chatId, msgId, step })

            } else if (step.type === 'steer') {
              // §steer — реплику пользователя вставили в messages на границе
              // раунда. Шагом кладём в текущую итерацию (персистится вместе с
              // assistant-сообщением → карточка живёт на своём месте после
              // перезагрузки чата) и шлём в renderer: там по steerId
              // оптимистичная pending-карточка перещёлкивается в «внедрено».
              const ts = {
                id: `${Date.now()}-${Math.random()}`,
                type: step.type,
                content: step.content,
                timestamp: Date.now(),
                steerId: step.steerId,
                steerApplied: step.steerApplied !== false,
                attachments: (step as { attachments?: import('../../shared/types').SteerAttachmentMeta[] }).attachments,
              }
              collectedSteps.push(ts)
              currentIterSteps.push(ts)
              send({ type: 'step', chatId, msgId, step })
            } else if (step.type === 'hint' || step.type === 'janitor') {
              // Мини-агенты (watcher/constitution/briefing/navigator/
              // economist/janitor): карточка в ленте + персист в toolSteps.
              const ts = {
                id: `${Date.now()}-${Math.random()}`,
                type: step.type,
                content: step.content,
                timestamp: Date.now(),
                hintSource: step.hintSource,
                hintId: step.hintId,
                janitorKind: step.janitorKind,
                janitorTokensSaved: step.janitorTokensSaved,
                janitorArchiveId: step.janitorArchiveId,
                janitorActions: step.janitorActions,
              }
              collectedSteps.push(ts)
              currentIterSteps.push(ts)
              send({ type: 'step', chatId, msgId, step })
            } else if (step.type === 'thought') {
              // Fallback — reasoning не стримился, пришёл одним блоком
              if (!thinkingStartMs) thinkingStartMs = Date.now()
              const thoughtStr = typeof step.content === 'string' ? step.content : String(step.content ?? '')
              thinkingText += thoughtStr
              pendingThinking += thoughtStr
              thinkingMs = Date.now() - thinkingStartMs
              pendingThinkingMs = thinkingMs
              send({ type: 'thinking_token', chatId, msgId, token: thoughtStr })
              send({ type: 'thinking_done', chatId, msgId, thinkingMs })
            } else if (step.type === 'answer') {
              fullText += step.content
              pendingTextAfter += step.content
              send({ type: 'token', chatId, msgId, token: step.content })
            }
          },
          onDone: (_answer: string, details?: unknown) => {
            // Если агент накопил текст через стриминг — fullText уже заполнен.
            // Но если ответ пришёл без стриминга (hadStreamedTokens=false →
            // onStep({type:'answer'}) по словам, или maxSteps/empty-retry
            // пути вызывают onDone с текстом, но onStep не вызывался) —
            // fullText пуст, и _answer терялся. Берём максимум.
            if (!fullText.trim() && _answer.trim()) {
              fullText = _answer
            }
            console.log('[ai-worker] onDone: _answer=%d chars, fullText=%d chars, steps=%d, iters=%d',
              _answer.length, fullText.length, collectedSteps.length, collectedIters.length)
            finalize(details)
          },
          onError: (err) => {
            console.log('[ai-worker] onError: %s | fullText=%d steps=%d iters=%d', err.message, fullText.length, collectedSteps.length, collectedIters.length)
            flushIter()
            send({
              type: 'error', chatId, error: err.message,
              fullText, thinkingText: thinkingText || undefined, thinkingMs,
              collectedSteps, collectedIters: collectedIters.length > 0 ? collectedIters : undefined,
              ...usagePayload(),
              updatedProviders: storeData.providers,
              fileCacheUpdates: agent?.getFileCacheUpdates(),
              fileSnapshots: agent?.getFileSnapshots(),
            })
            void teardownSidecar()
          },
          onContextUpdate: (info) => {
            lastBreakdown = info.breakdown
            emitContextUsage(
              { estimated: info.promptTokens, limit: contextWindow, breakdown: info.breakdown },
              'estimate',
              { scope: 'request' },
            )
          },
          onUsage: (promptTokens: number, completionTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number) => {
            // Реальные токены от провайдера — приоритет над оценкой
            accumulateUsage(promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens)
            const snapshot = buildSnapshotFromReal(
              { promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens },
              contextWindow,
              lastBreakdown,
            )
            // Накапливаем стоимость сессии (cache-токены тарифицируются отдельно)
            emitContextUsage(snapshot, 'real', {
              pricing: getModelPriceInfo(resolvedProviderId ?? '', resolvedModelId ?? ''),
              estimatedCostCents: estimateCost(promptTokens, completionTokens, resolvedProviderId ?? '', resolvedModelId ?? ''),
              providerId: resolvedProviderId,
              modelId: resolvedModelId,
              // Сырые накопленные токены turn'а — main аккумулирует их в
              // run.bufferedUsage, чтобы статистика сохранилась при Стопе/
              // краше воркера (done/error при terminate() уже не приходят).
              rawPromptTokens: accPromptTokens || undefined,
              rawCompletionTokens: accCompletionTokens || undefined,
              rawCacheReadTokens: accCacheReadTokens || undefined,
              rawCacheWriteTokens: accCacheWriteTokens || undefined,
            })
          },
          onQuestion: (questions) => {
            return new Promise((resolve) => {
              const reqId = `question-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(`question-reply-${reqId}`, (reply) => {
                const answers = (reply.answers as import('../../shared/types').QuestionAnswer[]) ?? []
                resolve(answers)
              })
              send({ type: 'question', chatId, msgId, reqId, questions })
            })
          },
          onStatus: (text) => {
            send({ type: 'agent_status', chatId, msgId, text })
          },
          onRateLimit: (waitSec) => {
            // Шлём оба события — rate_limit для бара и agent_status для bubble
            send({ type: 'rate_limit', chatId, waitSec })
            send({ type: 'agent_status', chatId, msgId, text: `Rate limit — жду ${waitSec}с...` })
          },
          onRetry: (attempt, reason, waitSec, maxAttempts) => {
            const text = reason === 'rate_limit'
              ? `Лимит запросов, повтор через ${waitSec}с...`
              : `Ошибка сети, повтор ${attempt}${maxAttempts ? `/${maxAttempts}` : ''}...`
            send({ type: 'agent_status', chatId, msgId, text })
            // Структурированное событие для UI-счётчика «повтор 3/5» —
            // не затирается следующим onStatus (в отличие от agent_status).
            send({ type: 'agent_retry', chatId, msgId, attempt, maxAttempts, reason, waitSec })
            if (reason === 'rate_limit' && waitSec) {
              send({ type: 'rate_limit', chatId, waitSec })
            }
          },
          approvalMode: agentSettings.approvalMode,
          onConfirm: (toolName, args) => {
            return new Promise((resolve) => {
              const reqId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(`confirm-reply-${reqId}`, (reply) => {
                // §allowlist — решение может содержать always (scope «Всегда разрешать»)
                resolve({
                  approved: (reply as { approved?: boolean }).approved === true,
                  always: (reply as { always?: 'session' | 'project' | 'global' }).always,
                  match: (reply as { match?: 'action' | 'tool' }).match,
                })
              })
              // Единый источник правды: классификация из commandSafety (§1.4)
              const agentPerms = (storeData.agentPermissions as {
                forbiddenPaths?: string[]
              } | undefined) ?? {}
              // Проектный override: доп. запрещённые пути мержатся с глобальными
              const projectPerms = (storeData.projectPermissions as Record<string, {
                forbiddenPaths?: string[]
              }> | undefined) ?? {}
              const projForbidden = agent?.projectId ? projectPerms[agent.projectId]?.forbiddenPaths : undefined
              const forbiddenPaths = [
                ...(agentPerms.forbiddenPaths ?? []),
                ...(projForbidden ?? []),
              ]
              const classification = classifyTool(toolName, args, { forbiddenPaths, workdir: agent?.workdir })
              // Diff-превью для файловых тулов (§4.1) — dryRun без записи.
              // IIFE сохраняет async preview, но не делает executor Promise async.
              void (async () => {
                let previewDiff = ''
                try {
                  if (toolName === 'write_file') {
                    const r = await writeFile(args.path as string, args.content as string, { dryRun: true })
                    previewDiff = r.diff ?? ''
                  } else if (toolName === 'edit_file') {
                    const r = await editFile({ ...(args as Parameters<typeof editFile>[0]), dryRun: true })
                    previewDiff = r.diff ?? ''
                  }
                } catch { /* превью опционально */ }
                send({
                  type: 'confirm', chatId, msgId, reqId, toolName, args,
                  dangerLevel: classification.level,
                  dangerReason: classification.reason,
                  previewDiff,
                })
              })()
            })
          },
          onSpawnAgent: (opts) => {
            return new Promise((resolve) => {
              const replyId = `spawn-reply-${opts.id}`
              replyHandlers.set(replyId, (reply) => {
                resolve({ summary: reply.summary as string, error: reply.error as string | undefined })
              })
              send({ type: 'spawn_agent', chatId, msgId, replyId, ...opts })
            })
          },
          onRenderPage: (url, renderOpts) => {
            return new Promise((resolve) => {
              const replyId = `render-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              const timer = setTimeout(() => {
                replyHandlers.delete(replyId)
                resolve({ html: '', error: 'render_page timed out' })
              }, (renderOpts.timeoutMs ?? 25000) + 5000)
              replyHandlers.set(replyId, (reply) => {
                clearTimeout(timer)
                resolve({
                  html: (reply.html as string) ?? '',
                  title: (reply.title as string) ?? '',
                  error: reply.error as string | undefined,
                  text: (reply.text as string) || undefined,
                  apiEndpoints: (reply.apiEndpoints as string[]) || undefined,
                })
              })
              send({
                type: 'render_page',
                chatId, msgId, replyId,
                url,
                waitSelector: renderOpts.waitSelector,
                timeoutMs: renderOpts.timeoutMs,
              })
            })
          },
          // Логгер каскадов fetch_page/search_images. worker_threads делят
          // stdout родителя — console.log виден в терминале dev-режима.
          onLog: (msg) => {
            console.log(`[ai-worker:${chatId.slice(0, 8)}] ${msg}`)
          },
          onGetAgentStatus: (agentId) => {
            return new Promise((resolve) => {
              const replyId = `get-status-${agentId}-${Date.now()}`
              replyHandlers.set(replyId, (reply) => {
                resolve(reply.status as { status: string; currentStep?: string; stepsCount: number } | null)
              })
              send({ type: 'get_agent_status', chatId, msgId, replyId, agent_id: agentId })
            })
          },
          onManageChats: (payload) => {
            return new Promise((resolve) => {
              const replyId = `chats-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
              const timer = setTimeout(() => {
                replyHandlers.delete(replyId)
                resolve({ success: false, output: '', error: 'manage_chats timed out; the request may have been accepted. Use list/status before retrying create/send.' })
              }, 30000)
              replyHandlers.set(replyId, (reply) => {
                clearTimeout(timer)
                resolve((reply.result as import('../../shared/delegatedChats').ManageChatsResult)
                  ?? { success: false, output: '', error: 'manage_chats: no response from main' })
              })
              send({ type: 'manage_chats', chatId, msgId, replyId, payload,
                allowedTools: runTools.map(t => t.function.name) })
            })
          },
          onManageDots: (payload) => {
            // Round-trip в main-процесс, где живёт DotManager (worker не может
            // импортировать менеджер — это создало бы второй экземпляр с
            // собственными таймерами и подключением к БД).
            return new Promise((resolve) => {
              const replyId = `dots-reply-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(replyId, (reply) => {
                resolve((reply.result as { success: boolean; error?: string; text?: string })
                  ?? { success: false, error: 'manage_dots: нет ответа от main-процесса' })
              })
              send({ type: 'manage_dots', chatId, msgId, replyId, payload })
            })
          },
          onBrowserAction: async (payload) => {
            const result = await requestBrowserOperation(payload, replyHandlers, send, runAbort.signal)
            if (!runAbort.signal.aborted && result.success && result.enabled && payload.action === 'request_access') {
              const capability = result.capability ?? payload.capability ?? 'browser_control'
              const added = enableCapabilityMidRun(capability)
              if (added === 0) {
                return {
                  success: false,
                  enabled: false,
                  capability,
                  error: `${capability} access was confirmed, but its tool could not be added to this run. Start a normal chat (not a restricted side chat/one-shot run) and try again.`,
                }
              }
              return {
                ...result,
                capability,
                output: capability === 'browser_control'
                  ? `Browser control ENABLED. Added ${added} browser tools to the current run. Continue using them immediately.`
                  : `Image generation ENABLED. Added generate_image to the current run. Continue using it immediately.`,
              }
            }
            return result
          },
          onTodoUpdate: (items) => {
            send({ type: 'todo_update', chatId, msgId, items })
          },
          // §orchestration — прогресс фаз. Одно событие на переход (running при
          // входе в фазу, done/blocked при выходе); UI накапливает по startedAt.
          onOrchestrationProgress: (progress) => {
            send({ type: 'orchestration_progress', chatId, msgId, progress })
          },
          onThinkingToken: (token) => {
            if (!thinkingStartMs) thinkingStartMs = Date.now()
            const tok = typeof token === 'string' ? token : ''
            thinkingText += tok
            pendingThinking += tok
            send({ type: 'thinking_token', chatId, msgId, token: tok })
          },
          onThinkingDone: (ms) => {
            thinkingMs = ms
            pendingThinkingMs = ms
            send({ type: 'thinking_done', chatId, msgId, thinkingMs: ms })
          },
          onGetMainChatMessages: (params) => {
            return new Promise((resolve) => {
              const replyId = `get-main-chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(replyId, (reply) => {
                resolve((reply.result as string) ?? '')
              })
              send({ type: 'get_main_chat_messages', chatId, msgId, replyId, limit: params.limit, search: params.search })
            })
          },
          onMcpCall: (fullToolName, args, signal) =>
            requestMcpTool(fullToolName, args, replyHandlers, send, signal ?? runAbort.signal),
          onMcpRequiresApproval: (fullToolName) => {
            // Синхронный ответ из кэша workerData.mcpApprovalMap (заполняется main
            // при spawn-е: { [toolFullName]: boolean }). По умолчанию true (безопаснее).
            const map = ((workerData as Record<string, unknown>).mcpApprovalMap as Record<string, boolean> | undefined) ?? {}
            return map[fullToolName] ?? true
          },
          onPluginRequiresApproval: (fullToolName) => {
            // Аналогично MCP: { [toolFullName]: boolean } из main. По умолчанию
            // false — тулы плагинов исторически выполняются без подтверждения
            // (backward compat), спрашивают только явно помеченные.
            const map = ((workerData as Record<string, unknown>).pluginApprovalMap as Record<string, boolean> | undefined) ?? {}
            return map[fullToolName] ?? false
          },
          onPluginCall: (fullToolName, args) => {
            return new Promise((resolve) => {
              const replyId = `plugin-call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(replyId, (reply) => {
                resolve({
                  success: (reply.success as boolean) ?? false,
                  output: (reply.output as string) ?? '',
                  error: reply.error as string | undefined,
                })
              })
              send({ type: 'plugin_call', chatId, msgId, replyId, toolName: fullToolName, args })
            })
          },
          onToolCall: (name, args) => {
            // Fire-and-forget: событие tool:call для плагинов (main рассылает).
            send({ type: 'tool_call_event', chatId, msgId, toolName: name, args })
          },
          onListExtensions: (options) => {
            return new Promise((resolve) => {
              const replyId = `list-ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(replyId, (reply) => {
                resolve((reply.report as string) ?? 'Расширения недоступны')
              })
              send({ type: 'list_extensions', chatId, msgId, replyId, options })
            })
          },
          onGetSkill: (name) => {
            return new Promise((resolve) => {
              const replyId = `get-skill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(replyId, (reply) => {
                resolve((reply.instructions as string) ?? 'Скилл не найден')
              })
              send({ type: 'get_skill', chatId, msgId, replyId, skillName: name })
            })
          },
          onSaveMemory: (params) => {
            return new Promise((resolve) => {
              const replyId = `save-mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(replyId, (reply) => {
                resolve({
                  success: (reply.success as boolean) ?? false,
                  id: reply.id as string | undefined,
                  error: reply.error as string | undefined,
                })
              })
              send({ type: 'save_memory', chatId, msgId, replyId, ...params })
            })
          },
          onRecallMemory: (params) => {
            return new Promise((resolve) => {
              const replyId = `recall-mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(replyId, (reply) => {
                resolve({
                  success: (reply.success as boolean) ?? false,
                  results: (reply.results as Array<{
                    source: string
                    title: string | null
                    content: string
                    score: number
                    kind?: string
                    scope?: string
                    key?: string | null
                    chatId?: string
                    chatTitle?: string
                    messageId?: string
                    role?: string
                    date?: number
                  }>) ?? [],
                  error: reply.error as string | undefined,
                })
              })
              send({ type: 'recall_memory', chatId, msgId, replyId, ...params })
            })
          },
          onProjectMap: (args) => {
            // В worker-потоке БД нет (getDB бросает) — граф кода читает main.
            // Таймаут 20с: потерянный reply не должен вешать тул до конца рана.
            return new Promise((resolve) => {
              const replyId = `pmap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              const started = Date.now()
              let settled = false
              const finish = (result: { success: boolean; output: string; error?: string }) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                replyHandlers.delete(replyId)
                log('[ai-worker] project_map rpc %s in %dms', result.error && !result.output ? 'TIMEOUT/FAIL' : 'reply', Date.now() - started)
                resolve(result)
              }
              const timer = setTimeout(() => finish({
                success: false,
                output: '',
                error: 'project_map timed out after 20s (no reply from main) — try again, it usually means the map/index is still warming up',
              }), 20_000)
              replyHandlers.set(replyId, (reply) => {
                finish({
                  success: (reply.success as boolean) ?? false,
                  output: (reply.output as string) ?? '',
                  error: reply.error as string | undefined,
                })
              })
              log('[ai-worker] project_map rpc send: action=%s project=%s', args.action, (args.projectId ?? '').slice(0, 8))
              send({ type: 'project_map', chatId, msgId, replyId, ...args })
            })
          },
          onToolProgress: (p) => {
            // Progress для долгих тулов — транслируем в main
            // для live-индикации этапов в UI ToolChain
            send({
              type: 'tool_progress', chatId, msgId,
              toolName: p.toolName, stage: p.stage, detail: p.detail,
              filesProcessed: p.filesProcessed, filesTotal: p.filesTotal,
              filesFound: p.filesFound,
            })
          },
        },
        agentSettings.maxSteps,
        runAbort.signal,
        systemPrompt,
        // Инъекция режимного промпта в КОНЕЦ history (последний элемент перед
        // новым user-сообщением) — максимальный вес у LLM. Раньше инъекция
        // стояла в начале history и при длинной истории «забывалась» моделью.
        // planning имеет приоритет над ask (он строже — требует <plan>).
        (() => {
          let h = history
          if (planningMode) h = [...h, { role: 'system', content: buildPlanningInjection() }]
          else if (askMode) h = [...h, { role: 'system', content: buildAskInjection() }]
          return h
        })(),
        runTools,        {
          autoMemoryInterval: incognito ? 0 : (agentSettings.autoMemoryInterval ?? 5),
          readFileCache: agentSettings.readFileCache !== false,
          maxRepeatedToolCalls: agentSettings.maxRepeatedToolCalls ?? 3,
          maxRepeatedErrors: agentSettings.maxRepeatedErrors ?? 2,
          fileCacheSnapshot: (workerData as Record<string, unknown>).fileCacheSnapshot as Record<string, import('../../core/context/fileCacheTypes').FileCacheEntry> | undefined,
          planningMode,
          subagentRole,
          orchestration,
          imageParts: imageParts as Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }> | undefined,
        }
      )
    } else {
      // Обычный стриминг без tools
      const contextMessages = history.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }))
      contextMessages.push({ role: 'user', content })

      await aiClient.streamChat(
        contextMessages,
        {
          onContextCounted: (info) => {
            lastBreakdown = info.breakdown
            emitContextUsage(
              { estimated: info.promptTokens, limit: contextWindow, breakdown: info.breakdown },
              'estimate',
              { scope: 'request' },
            )
          },
          onToken: (token) => {
            fullText += token
            send({ type: 'token', chatId, msgId, token })
          },
          onThinkingToken: (token) => {
            if (!thinkingStartMs) thinkingStartMs = Date.now()
            const tok = typeof token === 'string' ? token : ''
            thinkingText += tok
            send({ type: 'thinking_token', chatId, msgId, token: tok })
          },
          onThinkingDone: (ms) => {
            thinkingMs = ms
            send({ type: 'thinking_done', chatId, msgId, thinkingMs: ms })
          },
          onUsage: (usage) => {
            // Реальные токены от провайдера — обновляем counter точными данными
            // (non-tool стриминг не всегда несёт cache-токены — каст к wider-типу)
            const u = usage as { promptTokens: number; completionTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
            accumulateUsage(u.promptTokens, u.completionTokens, u.cacheReadTokens, u.cacheWriteTokens)
            // contextWindow уже посчитан на входе в run() — не пересчитываем
            // лимит модели в каждом колбэке (был дубль getModelContextWindow).
            const snapshot = buildSnapshotFromReal(usage, contextWindow, lastBreakdown)
            emitContextUsage(snapshot, 'real', {
              pricing: getModelPriceInfo(resolvedProviderId ?? '', resolvedModelId ?? ''),
              estimatedCostCents: estimateCost(u.promptTokens, u.completionTokens, resolvedProviderId ?? '', resolvedModelId ?? ''),
              providerId: resolvedProviderId,
              modelId: resolvedModelId,
              // Сырые накопленные токены turn'а (см. агентный onUsage выше)
              rawPromptTokens: accPromptTokens || undefined,
              rawCompletionTokens: accCompletionTokens || undefined,
              rawCacheReadTokens: accCacheReadTokens || undefined,
              rawCacheWriteTokens: accCacheWriteTokens || undefined,
            })
          },
          onDone: () => finalize(),
          onError: (err) => {
            send({
              type: 'error', chatId, error: err.message,
              fullText, thinkingText: thinkingText || undefined, thinkingMs,
            })
            void teardownSidecar()
          },
          onRateLimit: (waitSec) => {
            send({ type: 'rate_limit', chatId, waitSec })
          },
          onWaiting: () => {
            send({ type: 'agent_status', chatId, msgId, text: 'Ожидаю ответа...' })
          },
          onRetry: (attempt, reason, waitSec, maxAttempts) => {
            const text = reason === 'rate_limit'
              ? `Лимит запросов, повтор через ${waitSec}с...`
              : `Ошибка сети, повтор ${attempt}${maxAttempts ? `/${maxAttempts}` : ''}...`
            send({ type: 'agent_status', chatId, msgId, text })
            // Структурированное событие для UI-счётчика «повтор 3/5» —
            // не затирается следующим onStatus (в отличие от agent_status).
            send({ type: 'agent_retry', chatId, msgId, attempt, maxAttempts, reason, waitSec })
            // Дублируем rate_limit для бара с таймером
            if (reason === 'rate_limit' && waitSec) {
              send({ type: 'rate_limit', chatId, waitSec })
            }
          },
        },
        'main',
        systemPrompt
      )
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    flushIter()
    send({
      type: 'error', chatId, error: errMsg,
      fullText, thinkingText: thinkingText || undefined, thinkingMs,
      collectedSteps, collectedIters: collectedIters.length > 0 ? collectedIters : undefined,
      ...usagePayload(),
      updatedProviders: storeData.providers,
      fileCacheUpdates: agent?.getFileCacheUpdates(),
    })
  }
})
