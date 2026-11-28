import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { getModelPriceInfo } from '../tokens/usageTracker'
import type { ModelPrice } from '../tokens/ModelPricing'

export interface AIUsageContext { chatId?: string; source?: string }
export interface AIRequestUsage extends AIUsageContext {
  requestId: string
  providerId: string
  modelId: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reportedCostCents?: number
  /** False for interrupted streams or responses without provider usage. */
  complete: boolean
  finished: boolean
  pricing: ModelPrice | null
  timestamp: number
}

const contexts = new AsyncLocalStorage<AIUsageContext>()
let defaultContext: AIUsageContext = {}
let sink: ((event: AIRequestUsage) => void) | null = null

export function setAIUsageSink(listener: ((event: AIRequestUsage) => void) | null): void { sink = listener }
/** Worker-only default; main uses explicit/async context to isolate concurrent chats. */
export function setDefaultAIUsageContext(context: AIUsageContext): void { defaultContext = context }
export function withAIUsageContext<T>(context: AIUsageContext, run: () => T): T { return contexts.run(context, run) }

type Usage = Record<string, unknown>
function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

/**
 * Кеш-чтения из usage. Поле у каждого провайдера своё, и раньше читалось
 * только одно (prompt_tokens_details.cached_tokens) — из-за этого экономия
 * DeepSeek и gateway-прокси не доезжала до учёта вовсе.
 *   OpenAI / OpenRouter / большинство прокси: prompt_tokens_details.cached_tokens
 *   Responses API:                              input_tokens_details.cached_tokens
 *   DeepSeek:                                   prompt_cache_hit_tokens
 *   прочие OpenAI-совместимые:                  cached_tokens / cache_hit_tokens
 * Anthropic сюда не ходит — у него отдельная ветвь (cache_read_input_tokens).
 */
export function cacheReadTokensOf(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Usage
  return tokens((u.prompt_tokens_details as Usage | undefined)?.cached_tokens)
    ?? tokens((u.input_tokens_details as Usage | undefined)?.cached_tokens)
    ?? tokens(u.prompt_cache_hit_tokens)
    ?? tokens(u.cached_tokens)
    ?? tokens(u.cache_hit_tokens)
    ?? tokens(u.cache_read_input_tokens)
}

export function cacheWriteTokensOf(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Usage
  return tokens((u.prompt_tokens_details as Usage | undefined)?.cache_write_tokens)
    ?? tokens((u.input_tokens_details as Usage | undefined)?.cache_write_tokens)
    ?? tokens(u.cache_creation_input_tokens)
}

/** Observe the SDK boundary, so fallbacks and non-stream/auxiliary calls count too.
 * Each invocation has one ID; Anthropic's cumulative updates replace one ledger row.
 * No prompts, response bodies, credentials or tool arguments enter the ledger.
 */
export async function observeAIRequest<T>(
  invoke: () => PromiseLike<T>,
  identity: { providerId: string; modelId: string; source?: string; pricing?: ModelPrice | null; reportsUsdCost?: boolean },
  context: AIUsageContext = {},
  api: 'openai' | 'responses' | 'anthropic' | 'embedding' = 'openai',
): Promise<T> {
  const base = { ...defaultContext, ...contexts.getStore(), ...context }
  const requestId = randomUUID()
  const timestamp = Date.now()
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let cacheReadTokens: number | undefined
  let cacheWriteTokens: number | undefined
  let reportedCostCents: number | undefined
  let complete = false
  let finished = false
  const publish = (): void => {
    try {
      const totalInput = inputTokens == null ? undefined : api === 'anthropic'
        ? inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) : inputTokens
      sink?.({ ...base, providerId: identity.providerId, modelId: identity.modelId, source: base.source ?? identity.source,
        requestId, timestamp, inputTokens: totalInput, outputTokens, cacheReadTokens, cacheWriteTokens,
        reportedCostCents, complete, finished,
        pricing: identity.pricing === undefined ? getModelPriceInfo(identity.providerId, identity.modelId) : identity.pricing })
    } catch { /* Accounting must never fail an otherwise successful model call. */ }
  }
  const capture = (usage: Usage | undefined): void => {
    if (!usage) return
    if (identity.reportsUsdCost && typeof usage.cost === 'number' && usage.cost >= 0 && Number.isFinite(usage.cost * 100)) {
      reportedCostCents = usage.cost * 100
    }
    if (api === 'anthropic') {
      inputTokens = tokens(usage.input_tokens) ?? inputTokens
      outputTokens = tokens(usage.output_tokens) ?? outputTokens
      cacheReadTokens = tokens(usage.cache_read_input_tokens) ?? cacheReadTokens
      cacheWriteTokens = tokens(usage.cache_creation_input_tokens) ?? cacheWriteTokens
    } else {
      inputTokens = tokens(usage.prompt_tokens) ?? tokens(usage.input_tokens) ?? inputTokens
      outputTokens = api === 'embedding' ? 0 : tokens(usage.completion_tokens) ?? tokens(usage.output_tokens) ?? outputTokens
      cacheReadTokens = cacheReadTokensOf(usage) ?? cacheReadTokens
      cacheWriteTokens = cacheWriteTokensOf(usage) ?? cacheWriteTokens
    }
  }
  // A rejected HTTP request has no confirmed usage. Accepted streams are tracked
  // even if cancelled before the final usage packet arrives.
  const result = await invoke()
  if (result && typeof (result as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    // Main persists this before a worker can be forcibly stopped. A killed
    // worker cannot run generator.finally, so an incomplete request stays visible.
    publish()
    const iterable = result as unknown as AsyncIterable<Usage>
    const observed = (async function* () {
      try {
        for await (const event of iterable) {
          if (api === 'anthropic') {
            capture(event.usage as Usage | undefined)
            capture((event.message as Usage | undefined)?.usage as Usage | undefined)
            if (event.type === 'message_stop') complete = inputTokens != null && outputTokens != null
            // Persist input usage before a user can stop a long thinking stream.
            if (event.usage || (event.message as Usage | undefined)?.usage) publish()
          } else if (api === 'responses') {
            const usage = (event.response as Usage | undefined)?.usage as Usage | undefined
            capture(usage)
            if (event.type === 'response.completed' || event.type === 'response.incomplete') complete = inputTokens != null && outputTokens != null
            if (usage) publish()
          } else if (event.usage) {
            capture(event.usage as Usage)
            publish()
          }
          yield event
        }
        if (api === 'openai' || api === 'embedding') complete = inputTokens != null && outputTokens != null
      } finally { finished = true; publish() }
    })()
    return observed as T
  }
  capture((result as Usage | undefined)?.usage as Usage | undefined)
  complete = inputTokens != null && outputTokens != null
  finished = true
  publish()
  return result
}
