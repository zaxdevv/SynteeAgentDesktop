/**
 * AI Worker Thread — весь AI/Agent код здесь.
 * При worker.terminate() все соединения рвутся мгновенно OS-ом.
 * Сохранение происходит в main thread через сообщение 'done'.
 */
import { parentPort, workerData } from 'worker_threads'
import { AIClient, setGatewayToken, setGatewayTokenRefresher } from '../../core/ai/AIClient'
import { Agent } from '../../core/agent/Agent'
import { classifyTool } from '../../core/agent/commandSafety'
import { writeFile, editFile } from '../../core/tools/index'
import { buildPlanningInjection, buildAskInjection } from '../../core/prompts/buildSystemPrompt'
import { getModelContextWindow } from '../../core/context/contextManager'
import { recordSessionCost, buildSnapshotFromReal } from '../../core/tokens/usageTracker'
import { initModelCatalog } from '../../core/tokens/modelCatalog'
import { setGatewayModelsCache } from '../../core/tokens/gatewayModelsCache'
import { getToolSchemas } from '../../core/tools/index'
import { initFastContextDb, initFastContextWasmDir } from '../../core/context/fastContext'
import type { ModelMeta } from '../../shared/types'

const storeData: Record<string, unknown> = workerData.storeData
const planningMode: boolean = !!(workerData as Record<string, unknown>).planningMode
const askMode: boolean = !!(workerData as Record<string, unknown>).askMode
const workerPersona = (workerData as Record<string, unknown>).persona as import('../../shared/modes').PersonaId | undefined
const workerPersonaInjection = ((workerData as Record<string, unknown>).personaInjection as string | undefined) ?? ''
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

function send(msg: Record<string, unknown>) {
  parentPort?.postMessage(msg)
}

// ЕДИНЫЙ handler — все входящие сообщения через один on('message')
parentPort?.on('message', async (msg: Record<string, unknown>) => {
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
      approvalMode: string
      toolOutputMode: string
      enableThinking: boolean
      autoMemoryInterval?: number
      readFileCache?: boolean
      maxRepeatedToolCalls?: number
      maxRepeatedErrors?: number
    }
  }

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

  // Последний breakdown для мерджа с реальным usage (buildSnapshotFromReal
  // масштабирует его пропорционально promptTokens вместо verbatim-наследования).
  let lastBreakdown: Record<string, number> | undefined

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
    flushIter()
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
  }

  try {
    // incognito больше не гейтит тузы — только персистентность (память/история).
    // Side-чат (incognito) получает read-only набор тулов из chat.ipc.ts
    // (sideToolSchemas), а Agent выполняет только то, что есть в schemas.
    // Память гейтится отдельно: onUpdateWorkingMemory не ставится для incognito.
    if (enableTools) {
      const isSubAgent = !!(workerData as Record<string, unknown>).isSubAgent
      agent = new Agent(fakeStore, isSubAgent ? 'subagent' : 'main')

      // Прокидываем chatId и колбэки рабочей памяти
      agent.chatId = chatId
      // workdir чата (новые Code-чаты после фичи workdir; undefined для
      // Work-режима и старых чатов — поведение остаётся прежним).
      agent.workdir = (workerData as Record<string, unknown>).workdir as string | undefined
      agent.projectId = (workerData as Record<string, unknown>).projectId as string | undefined
      agent.verificationCommand = (workerData as Record<string, unknown>).verificationCommand as string | undefined
      // Gateway JWT для веб-поиска через аккаунт (fallback на локальный Tavily
      // ключ если токен отсутствует/истёк — см. tools/web.ts).
      agent.gatewayToken = (workerData as Record<string, unknown>).gatewayToken as string | undefined
      agent.gatewayApiUrl = process.env.SYNTEE_API_URL

      // Fast Context: инициализация worker-local SQLite connection и пути к WASM.
      // Worker не имеет доступа к electron app / main-процессной БД — открываем
      // своё connection к тому же файлу (WAL mode → concurrent safe).
      const fcDbPath = (workerData as Record<string, unknown>).fastContextDbPath as string | undefined
      const fcWasmDir = (workerData as Record<string, unknown>).fastContextWasmDir as string | undefined
      if (fcDbPath) {
        try { initFastContextDb(fcDbPath) } catch (e) { console.warn('[ai-worker] initFastContextDb FAILED:', e) }
      }
      if (fcWasmDir) {
        try { initFastContextWasmDir(fcWasmDir) } catch (e) { console.warn('[ai-worker] initFastContextWasmDir FAILED:', e) }
      }
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

      // Синхронизируем workdir/projectId/chatId/gateway/колбэки в ToolDispatcher —
      // они устанавливаются ПОСЛЕ конструктора Agent, но ToolDispatcher создаётся
      // в конструкторе и без sync остаётся с undefined workdir/projectId.
      agent.syncToolDispatcher()

      console.log('[ai-worker] calling agent.run()... content=%d chars, history=%d msgs', content.length, history.length)
      await agent.run(
        content,
        {
          onContextCounted: (info) => {
            const pct = Math.min(100, Math.round(info.promptTokens / contextWindow * 100))
            const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'
            lastBreakdown = info.breakdown as Record<string, number>
            send({
              type: 'context_usage',
              pct, estimated: info.promptTokens, limit: contextWindow, status,
              source: 'estimate',
              breakdown: info.breakdown,
            })
          },
          onStep: (step) => {
            // Скрытые тулы (think, update_working_memory) — не шлём в UI
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
                diff: (step as { diff?: string }).diff,
                callId: step.callId,
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
          },
          onContextUpdate: (info) => {
            const pct = Math.min(100, Math.round(info.promptTokens / contextWindow * 100))
            const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'
            lastBreakdown = info.breakdown as Record<string, number>
            send({
              type: 'context_usage',
              pct, estimated: info.promptTokens, limit: contextWindow, status,
              source: 'estimate',
              breakdown: info.breakdown,
            })
          },
          onUsage: (promptTokens: number, completionTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number) => {
            // Реальные токены от провайдера — приоритет над оценкой
            accumulateUsage(promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens)
            const snapshot = buildSnapshotFromReal(
              { promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens },
              contextWindow,
              lastBreakdown as { history: number; system: number; tools: number; current: number; toolResults?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
            )
            // Накапливаем стоимость сессии (cache-токены тарифицируются отдельно)
            const sess = recordSessionCost(chatId, resolvedProviderId ?? '', resolvedModelId ?? '', promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens)
            send({
              type: 'context_usage',
              pct: snapshot.pct,
              estimated: snapshot.estimated,
              limit: snapshot.limit,
              status: snapshot.status,
              source: 'real',
              breakdown: snapshot.breakdown,
              sessionCostCents: sess?.totalCents ?? null,
              sessionRequests: sess?.requests ?? 0,
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
          approvalMode: agentSettings.approvalMode as never,
          onConfirm: (toolName, args) => {
            return new Promise(async (resolve) => {
              const reqId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(`confirm-reply-${reqId}`, (reply) => {
                resolve(reply.approved as boolean)
              })
              // Единый источник правды: классификация из commandSafety (§1.4)
              const agentPerms = (storeData.agentPermissions as {
                forbiddenPaths?: string[]
              } | undefined) ?? {}
              const classification = classifyTool(toolName, args, { forbiddenPaths: agentPerms.forbiddenPaths, workdir: agent?.workdir })
              // Diff-превью для файловых тулов (§4.1) — dryRun без записи
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
            })
          },
          onSpawnAgent: (opts) => {
            return new Promise((resolve) => {
              const replyId = `spawn-reply-${opts.id}`
              replyHandlers.set(replyId, (reply) => {
                resolve({ summary: reply.summary as string, error: reply.error as string | undefined })
              })
              const { approvalMode, ...rest } = opts
              send({ type: 'spawn_agent', chatId, msgId, replyId, ...rest, approval_mode: approvalMode, callId: opts.callId })
            })
          },
          onShellExec: (command, cwd, timeoutSec) => {
            return new Promise((resolve) => {
              const replyId = `shell-exec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(replyId, (reply) => {
                resolve({
                  output: (reply.output as string) ?? '',
                  exitCode: (reply.exitCode as number) ?? 1,
                  timedOut: reply.timedOut as boolean | undefined,
                  interrupted: reply.interrupted as boolean | undefined,
                })
              })
              send({ type: 'shell_exec', chatId, msgId, replyId, command, cwd, timeoutSec })
            })
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
          onTodoUpdate: (items) => {
            send({ type: 'todo_update', chatId, msgId, items })
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
          onMcpCall: (fullToolName, args) => {
            return new Promise((resolve) => {
              const replyId = `mcp-call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(replyId, (reply) => {
                resolve({
                  success: (reply.success as boolean) ?? false,
                  output: (reply.output as string) ?? '',
                  error: reply.error as string | undefined,
                })
              })
              send({ type: 'mcp_call', chatId, msgId, replyId, toolName: fullToolName, args })
            })
          },
          onMcpRequiresApproval: (fullToolName) => {
            // Синхронный ответ из кэша workerData.mcpApprovalMap (заполняется main
            // при spawn-е: { [toolFullName]: boolean }). По умолчанию true (безопаснее).
            const map = ((workerData as Record<string, unknown>).mcpApprovalMap as Record<string, boolean> | undefined) ?? {}
            return map[fullToolName] ?? true
          },
          onListExtensions: () => {
            return new Promise((resolve) => {
              const replyId = `list-ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(replyId, (reply) => {
                resolve((reply.report as string) ?? 'Расширения недоступны')
              })
              send({ type: 'list_extensions', chatId, msgId, replyId })
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
          onManageNotes: (params) => {
            return new Promise((resolve) => {
              const replyId = `manage-notes-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              replyHandlers.set(replyId, (reply) => {
                resolve({
                  success: (reply.success as boolean) ?? false,
                  notes: reply.notes as Array<{ id: string; title: string; content: string; updatedAt: number }> | undefined,
                  note: reply.note as { id: string; title: string } | undefined,
                  error: reply.error as string | undefined,
                })
              })
              send({ type: 'manage_notes', chatId, msgId, replyId, ...params })
            })
          },
          onToolProgress: (p) => {
            // Progress для долгих тулов (get_fast_context) — транслируем в main
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
        undefined,
        systemPrompt,
        // Инъекция режимного промпта в КОНЕЦ history (последний элемент перед
        // новым user-сообщением) — максимальный вес у LLM. Раньше инъекция
        // стояла в начале history и при длинной истории «забывалась» моделью.
        // planning имеет приоритет над ask (он строже — требует <plan>).
        // Persona — ортогональна: её injection добавляется после planning/ask
        // (если есть), чтобы роль сохранялась в длинном чате после компакции.
        // Дублируется в самом system prompt (buildSystemPrompt → buildPersonaInjection)
        // для надёжности при компакции истории.
        (() => {
          let h = history
          if (planningMode) h = [...h, { role: 'system', content: buildPlanningInjection() }]
          else if (askMode) h = [...h, { role: 'system', content: buildAskInjection() }]
          if (workerPersonaInjection) h = [...h, { role: 'system', content: workerPersonaInjection }]
          return h
        })(),
        (toolSchemas as typeof getToolSchemas extends (...args: never[]) => infer R ? R : never) ?? getToolSchemas({
          planningMode,
          askMode,
          mode: workerMode,
          mcpTools: ((workerData as Record<string, unknown>).mcpTools as Parameters<typeof getToolSchemas>[0]['mcpTools']) ?? [],
        }),        {
          autoMemoryInterval: incognito ? 0 : (agentSettings.autoMemoryInterval ?? 5),
          readFileCache: agentSettings.readFileCache !== false,
          maxRepeatedToolCalls: agentSettings.maxRepeatedToolCalls ?? 3,
          maxRepeatedErrors: agentSettings.maxRepeatedErrors ?? 2,
          fileCacheSnapshot: (workerData as Record<string, unknown>).fileCacheSnapshot as Record<string, import('../../core/context/fileCacheTypes').FileCacheEntry> | undefined,
          planningMode,
          persona: workerPersona,
          subagentRole,
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
            const pct = Math.min(100, Math.round(info.promptTokens / contextWindow * 100))
            const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'
            lastBreakdown = info.breakdown as Record<string, number>
            send({
              type: 'context_usage',
              pct, estimated: info.promptTokens, limit: contextWindow, status,
              source: 'estimate',
              breakdown: info.breakdown,
            })
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
            const cw = getModelContextWindow(storeData)
            const snapshot = buildSnapshotFromReal(usage, cw, lastBreakdown as { history: number; system: number; tools: number; current: number })
            // Накапливаем стоимость сессии
            const sess = recordSessionCost(chatId, resolvedProviderId ?? '', resolvedModelId ?? '', usage.promptTokens, usage.completionTokens)
            send({
              type: 'context_usage',
              pct: snapshot.pct,
              estimated: snapshot.estimated,
              limit: snapshot.limit,
              status: snapshot.status,
              source: 'real',
              breakdown: snapshot.breakdown,
              sessionCostCents: sess?.totalCents ?? null,
              sessionRequests: sess?.requests ?? 0,
            })
          },
          onDone: () => finalize(),
          onError: (err) => {
            send({
              type: 'error', chatId, error: err.message,
              fullText, thinkingText: thinkingText || undefined, thinkingMs,
            })
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
      updatedProviders: storeData.providers,
      fileCacheUpdates: agent?.getFileCacheUpdates(),
    })
  }
})
