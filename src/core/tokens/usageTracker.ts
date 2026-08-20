/**
 * Usage Tracker — единый источник истины для подсчёта токенов и стоимости сессии.
 *
 * Заменяет TokenCounter.ts (удалён) и дублирующий encoder из contextManager.ts.
 * Использует js-tiktoken (cl100k_base) с кэшированным энкодером.
 *
 * Реальные usage-данные от провайдера имеют приоритет над tiktoken-оценкой.
 * Сессионная стоимость накапливается в памяти (живёт пока жив процесс).
 */

import { getEncoding } from 'js-tiktoken'
import { getCatalogModel } from './modelCatalog'
import { getGatewayModelsCache, GATEWAY_PROVIDER_ID } from './gatewayModelsCache'
import { BUILTIN_MODELS } from '../../shared/data/builtinModels'
import { getModelPrice as getModelPriceStatic, type ModelPrice } from './ModelPricing'

// ─── Кэшированный энкодер ──────────────────────────────────────────────────────

let _enc: ReturnType<typeof getEncoding> | null = null
function getEncoder(): ReturnType<typeof getEncoding> {
  if (!_enc) _enc = getEncoding('cl100k_base')
  return _enc
}

// ─── Точные оценки через tiktoken ──────────────────────────────────────────────

// LRU-кэш результатов estimateTokens. Текст часто повторяется (system prompt,
// tool schemas, старые сообщения) — tiktoken-encode дорогой, нет смысла
// считать дважды для того же текста.
const _tokenCache = new Map<string, number>()
const TOKEN_CACHE_CAP = 500

export function estimateTokens(text: string): number {
  if (!text) return 0
  const cached = _tokenCache.get(text)
  if (cached !== undefined) return cached
  let result: number
  try {
    result = getEncoder().encode(text).length
  } catch {
    // fallback если tiktoken упал (очень редко)
    result = Math.ceil(text.length / 3.5)
  }
  if (_tokenCache.size > TOKEN_CACHE_CAP) {
    // LRU eviction: удаляем старейшую запись
    const firstKey = _tokenCache.keys().next().value
    if (firstKey) _tokenCache.delete(firstKey)
  }
  _tokenCache.set(text, result)
  return result
}

type MessageLike = {
  role: string
  content: string | Array<{ type: string; text?: string; image_url?: unknown }>
  tool_calls?: unknown
  tool_call_id?: string
  name?: string
}

/**
 * Полная оценка токенов массива сообщений с учётом структуры tool_calls.
 *
 * Раньше считался только `m.content + 4` — токены tool_calls (function.name,
 * JSON arguments), tool_call_id и name терялись. На длинных tool-раундах
 * это занижало оценку на сотни токенов и вызывало рассинхрон между
 * эмиттерами (live-оценка занижала, реальный usage от провайдера — нет).
 *
 * Теперь единая функция используется всеми эмиттерами context_usage.
 */
export function estimateMessagesTokensFull(messages: Array<MessageLike>): number {
  return messages.reduce((sum, m) => {
    const contentStr = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => 'text' in p ? (p as { text: string }).text : '').join('') : '')
    let n = estimateTokens(contentStr || '') + 4  // +4 служебных (role/разделители)
    // tool_calls (assistant): {id, type:'function', function:{name, arguments(JSON)}}
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
        try { n += estimateTokens(JSON.stringify(tc)) } catch { /* ok */ }
      }
    }
    // role:'tool' сообщения: tool_call_id + name
    if (m.tool_call_id) n += estimateTokens(m.tool_call_id)
    if (m.name) n += estimateTokens(m.name)
    return sum + n
  }, 0)
}

/** Тонкая обёртка над estimateMessagesTokensFull (обратная совместимость). */
export function estimateMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  return estimateMessagesTokensFull(messages as MessageLike[])
}

// ─── Единые пороги компакции контекста ────────────────────────────────────────
// Раньше Agent.ts (аварийный клапан dropOldestRoundsIfOverflow) и
// chat.ipc.ts (applyRollingWindowAsync) считали пороги по-разному и от разных
// оценок contextWindow (Agent.ts занижал пол до 32k) — это давало пилообразные
// скачки реального prompt_tokens. Теперь оба места берут проценты отсюда.

// Аварийный клапан — последняя линия защиты от hard-fail API. Держим близко
// к 100%, он не должен быть рабочим механизмом компакции (эту роль играет
// rolling window).
export const HARD_LIMIT_PCT = 99
// После срабатывания клапана — целимся сюда (% от contextWindow, не от
// hard-лимита), с явным запасом (гистерезис), чтобы клапан не триггерился
// повторно на следующем же раунде из-за пары новых сообщений.
export const HARD_LIMIT_TARGET_PCT = 80

// Rolling window (между сообщениями пользователя, chat.ipc.ts) — срабатывает
// раньше аварийного клапана, с summary вместо жёсткого дропа.
export const ROLLING_TRIGGER_PCT = 92

export function getHardLimitTokens(contextWindow: number): number {
  return Math.floor(contextWindow * HARD_LIMIT_PCT / 100)
}

export function getHardLimitTargetTokens(contextWindow: number): number {
  return Math.floor(contextWindow * HARD_LIMIT_TARGET_PCT / 100)
}

// ─── Снапшоты использования ───────────────────────────────────────────────────

export interface RealUsage {
  promptTokens: number
  completionTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface UsageSnapshot {
  estimated: number
  limit: number
  pct: number
  status: 'ok' | 'warn' | 'critical'
  source: 'real' | 'estimate'
  breakdown: {
    history: number
    system: number
    tools: number
    current: number
    toolResults?: number
    completionTokens?: number
    // Prompt caching: токены, прочитанные из кэша (со скидкой) и записанные в кэш
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  compressed?: boolean
  sessionCostCents?: number | null
  sessionRequests?: number
}

// Overhead константы — единственный источник истины. contextManager.ts и
// Agent.ts импортируют TOOL_SCHEMAS_OVERHEAD отсюда (раньше значение было
// продублировано в нескольких местах с риском рассинхрона).
export const TOOL_SCHEMAS_OVERHEAD = 3800
const API_OVERHEAD = 100

export function buildSnapshotFromReal(
  real: RealUsage,
  limit: number,
  prevBreakdown?: UsageSnapshot['breakdown'],
): UsageSnapshot {
  const pct = Math.min(100, Math.round(real.promptTokens / limit * 100))
  const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'

  // Раньше breakdown наследовался verbatim из последнего estimate-эмиттера —
  // это показывало ЧУЖОЙ breakdown под видом 'real' (т.к. источники считали
  // по разным формулам). Теперь масштабируем последний estimate-breakdown
  // пропорционально реальному promptTokens, чтобы sum(breakdown)=promptTokens
  // и пропорции System/History/Tools сохранялись. current=0 — реальный usage
  // относится к уже отправленному запросу; live-typing для следующего сообщения
  // добавится в renderer поверх (см. useContextCounter).
  let breakdown: UsageSnapshot['breakdown']
  if (prevBreakdown) {
    const baseSum = (prevBreakdown.history || 0) + (prevBreakdown.system || 0) + (prevBreakdown.tools || 0) + (prevBreakdown.current || 0)
    const scale = baseSum > 0 ? real.promptTokens / baseSum : 0
    const history = Math.max(0, Math.round((prevBreakdown.history || 0) * scale))
    const system = Math.max(0, Math.round((prevBreakdown.system || 0) * scale))
    const tools = Math.max(0, Math.round((prevBreakdown.tools || 0) * scale))
    // добиваем разницу округления в history
    const fixed = history + system + tools
    const drift = real.promptTokens - fixed
    breakdown = {
      history: drift !== 0 ? Math.max(0, history + drift) : history,
      system,
      tools,
      current: 0,
      toolResults: prevBreakdown.toolResults != null ? Math.max(0, Math.round(prevBreakdown.toolResults * scale)) : undefined,
      completionTokens: real.completionTokens,
      cacheReadTokens: real.cacheReadTokens,
      cacheWriteTokens: real.cacheWriteTokens,
    }
  } else {
    breakdown = {
      history: real.promptTokens,
      system: 0,
      tools: 0,
      current: 0,
      completionTokens: real.completionTokens,
      cacheReadTokens: real.cacheReadTokens,
      cacheWriteTokens: real.cacheWriteTokens,
    }
  }

  return {
    estimated: real.promptTokens,
    limit,
    pct,
    status,
    source: 'real',
    breakdown,
  }
}

/**
 * Единая функция оценки контекста для всех эмиттеров context_usage (chat:send,
 * context:calculate, Agent.onContextUpdate, AIClient.onContextCounted).
 * Заменяет разрозненные inline-формулы и гарантирует консистентный breakdown.
 *
 * `messages` — массив сообщений как есть (может включать system[0], историю
 * с tool_calls/tool results, текущее user-сообщение или нет — зависит от
 * вызывающего кода). Функция НЕ добавляет и НЕ убирает system/current сама;
 * опции `systemPrompt` / `currentMsgTokens` задаются отдельно, чтобы
 * вызывающий код контролировал семантику.
 *
 *   history = estimateMessagesTokensFull(messages)   // всё что передано
 *   system = opts.systemPrompt ? estimateTokens+4 : 0
 *   tools  = opts.includeToolSchemas ? TOOL_SCHEMAS_OVERHEAD : 0
 *   current= opts.currentMsgTokens ?? 0
 *   estimated = history + system + tools + current + API_OVERHEAD
 */
export function computeContextSnapshot(
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: unknown }>; tool_calls?: unknown; tool_call_id?: string; name?: string }>,
  limit: number,
  opts: {
    systemPrompt?: string
    currentMsgTokens?: number
    includeToolSchemas?: boolean
    toolResultTokens?: number
  } = {},
): UsageSnapshot {
  const historyTokens = estimateMessagesTokensFull(messages)
  const systemPromptTokens = opts.systemPrompt ? estimateTokens(opts.systemPrompt) + 4 : 0
  const toolSchemasTokens = opts.includeToolSchemas === true ? TOOL_SCHEMAS_OVERHEAD : 0
  const currentMsgTokens = opts.currentMsgTokens ?? 0
  const toolResultTokens = opts.toolResultTokens ?? 0

  const estimated = historyTokens + systemPromptTokens + toolSchemasTokens + currentMsgTokens + toolResultTokens + API_OVERHEAD
  const pct = Math.min(100, Math.round(estimated / limit * 100))
  const status = pct >= 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok'

  return {
    estimated,
    limit,
    pct,
    status,
    source: 'estimate',
    breakdown: {
      history: historyTokens,
      system: systemPromptTokens,
      tools: toolSchemasTokens,
      current: currentMsgTokens,
      toolResults: toolResultTokens > 0 ? toolResultTokens : undefined,
    },
  }
}

export function buildSnapshotFromEstimate(
  messages: Array<{ role: string; content: string }>,
  limit: number,
  opts: {
    systemPrompt?: string
    currentMsgTokens?: number
    toolResultTokens?: number
    includeToolSchemas?: boolean
  } = {},
): UsageSnapshot {
  // Тонкая обёртка: history=messages (без system), system/tools/current — опциями.
  return computeContextSnapshot(messages, limit, {
    systemPrompt: opts.systemPrompt,
    currentMsgTokens: opts.currentMsgTokens,
    includeToolSchemas: opts.includeToolSchemas,
    toolResultTokens: opts.toolResultTokens,
  })
}

// ─── Сессионная стоимость ─────────────────────────────────────────────────────
// Map<chatId, { totalCents, requests }> — живёт пока жив процесс
const sessionCosts = new Map<string, { totalCents: number; requests: number }>()

export function recordSessionCost(
  chatId: string,
  providerId: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number,
  cacheWriteTokens?: number,
): { totalCents: number; requests: number } | null {
  const pricing = getModelPriceInfo(providerId, modelId)
  if (!pricing) return null

  // Anthropic prompt caching тарификация:
  //   - input_tokens (non-cached) — полная цена (inputPerM)
  //   - cache_read_input_tokens   — цена со скидкой ~90% (cacheReadPerM)
  //   - cache_creation_input_tokens — премия ~25% (cacheWritePerM)
  //
  // Семантика promptTokens в колбэке onUsage:
  //   - OpenAI:   prompt_tokens = TOTAL (включая cached_tokens)
  //   - Anthropic: promptTokens = total (input + cacheRead + cacheWrite), т.к.
  //     AIClient нормализует: totalPrompt = input + cache_read + cache_creation
  //
  // Поэтому nonCachedInput = promptTokens - cacheRead - cacheWrite
  const nonCachedInput = Math.max(0, inputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0))
  let cents = (nonCachedInput / 1_000_000) * pricing.inputPerM
  cents += (outputTokens / 1_000_000) * pricing.outputPerM
  if (cacheReadTokens && pricing.cacheReadPerM) {
    cents += (cacheReadTokens / 1_000_000) * pricing.cacheReadPerM
  }
  if (cacheWriteTokens && pricing.cacheWritePerM) {
    cents += (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerM
  }

  const entry = sessionCosts.get(chatId) ?? { totalCents: 0, requests: 0 }
  entry.totalCents += cents
  entry.requests += 1
  sessionCosts.set(chatId, entry)
  return { totalCents: entry.totalCents, requests: entry.requests }
}

export function getSessionCost(chatId: string): { totalCents: number; requests: number } | null {
  return sessionCosts.get(chatId) ?? null
}

export function resetSessionCost(chatId: string): void {
  sessionCosts.delete(chatId)
}

// ─── Цены моделей (catalog → builtin → static pricing table) ──────────────────

export function getModelPriceInfo(providerId: string, modelId: string): ModelPrice | null {
  if (!modelId) return null

  // 1. Модели Syntee-Gateway — цены отдаёт сам gateway (pricing per_1k →
  // ModelMeta $/1M → центы ×100). Каталог models.dev провайдера не знает и
  // substring-матчингом подменяет модель похожей (glm-5.3 → zai:glm-5).
  if (providerId === GATEWAY_PROVIDER_ID) {
    const gw = getGatewayModelsCache().find(m => m.id === modelId)
    if (gw && (gw.inputPrice != null || gw.outputPrice != null)) {
      return {
        inputPerM: Math.round((gw.inputPrice ?? 0) * 100),
        outputPerM: Math.round((gw.outputPrice ?? 0) * 100),
      }
    }
  }

  // 2. Каталог models.dev
  const fromCatalog = getCatalogModel(providerId, modelId)
  if (fromCatalog && (fromCatalog.inputPricePerM > 0 || fromCatalog.outputPricePerM > 0)) {
    return {
      inputPerM: fromCatalog.inputPricePerM,
      outputPerM: fromCatalog.outputPricePerM,
      cacheReadPerM: fromCatalog.cacheReadPerM,
      cacheWritePerM: fromCatalog.cacheWritePerM,
    }
  }

  // 3. Builtin модели (цены в $ за 1M → переводим в центы ×100)
  const builtin = BUILTIN_MODELS.find(m => m.id === modelId && (providerId ? m.providerId === providerId : true))
  if (builtin?.inputPrice != null && builtin?.outputPrice != null) {
    return { inputPerM: Math.round(builtin.inputPrice * 100), outputPerM: Math.round(builtin.outputPrice * 100) }
  }

  // 4. Статичная таблица ModelPricing (substring fallback)
  return getModelPriceStatic(modelId)
}

export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  providerId: string,
  modelId: string,
): number | null {
  const price = getModelPriceInfo(providerId, modelId)
  if (!price) return null
  return (inputTokens / 1_000_000) * price.inputPerM + (outputTokens / 1_000_000) * price.outputPerM
}
