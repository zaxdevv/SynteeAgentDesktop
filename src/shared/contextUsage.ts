/**
 * Единый контракт события `context:usage` (IPC_EVENTS.CONTEXT_USAGE).
 *
 * Раньше каждый эмиттер (ai-worker ×3, chatSendEngine ×2, chat.ipc ×2) собирал
 * payload сам: `Math.round(tokens / limit * 100)` и пороги `85/60` были
 * скопированы в пяти местах, а `chatId` в payload вообще отсутствовал — фильтр
 * в renderer (`useContextCounter`) не мог отбросить событие чужого чата, и
 * side-чаты / дочерние чаты / сабагенты писали свои цифры в кольцо открытого
 * чата. Теперь форма и пороги живут здесь, один раз.
 *
 * Семантика (важно не смешивать):
 *   - `estimated` — размер ОДНОГО запроса (prompt_tokens), не сумма за ход;
 *   - `source: 'real'` — точное значение от провайдера, источник истины;
 *   - `source: 'estimate'` — tiktoken-оценка, помечается в UI как «≈».
 */

/** Порог предупреждения (% от contextWindow). Единственное место в коде. */
export const CONTEXT_WARN_PCT = 60
/** Порог критического заполнения (% от contextWindow). */
export const CONTEXT_CRITICAL_PCT = 85

/** Служебные токены протокола запроса (роли/разделители обёртки) ≈100. */
export const API_OVERHEAD_TOKENS = 100

/** Эвристика для предпросмотра «Черновика» в renderer (без tiktoken). */
export const DRAFT_CHARS_PER_TOKEN = 3.5

export type ContextStatus = 'ok' | 'warn' | 'critical'
export type ContextUsageSource = 'real' | 'estimate'
export type ContextUsageScope = 'request' | 'next_request'

export interface ContextUsageBreakdown {
  history: number
  system: number
  tools: number
  current: number
  toolResults?: number
  protocol?: number
  completionTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Минимум, который должен уметь любой снапшот (UsageSnapshot и его аналоги). */
export interface ContextUsageSnapshot {
  estimated: number
  limit: number
  breakdown: ContextUsageBreakdown
  compressed?: boolean
}

/**
 * Поля, которые добавляются к снапшоту при отправке в renderer.
 * Всё, что здесь есть, renderer вправе читать.
 */
export interface ContextUsagePayload {
  /** Чат, к которому относится замер. Обязателен: без него нельзя фильтровать. */
  chatId: string
  pct: number
  estimated: number
  limit: number
  status: ContextStatus
  source: ContextUsageSource
  /** Live provider request or a projection of the next request. */
  scope?: ContextUsageScope
  compressed?: boolean
  breakdown: ContextUsageBreakdown
  historyMessages?: number
  toolCallsCount?: number
  pricing?: { inputPerM: number; outputPerM: number } | null
  estimatedCostCents?: number | null
  providerId?: string
  modelId?: string
  // Стоимость сессии подмешивает main (getChatCost), не эмиттер.
  sessionCostCents?: number | null
  sessionRequests?: number
  sessionReportedRequests?: number
  sessionUnpricedRequests?: number
  lastRequestCostCents?: number | null
  lastRequestCostReported?: boolean
  sessionIncludesAuxiliary?: boolean
  accountingStartedAt?: number | null
}

/** Процент заполнения окна. Единственная формула в коде. */
export function contextPercent(tokens: number, limit: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(limit) || limit <= 0) return 0
  return Math.max(0, (tokens / limit) * 100)
}

export function contextPct(tokens: number, limit: number): number {
  return Math.min(100, Math.round(contextPercent(tokens, limit)))
}

/** Пороги статуса. Единственное место в коде. */
export function contextStatus(pct: number): ContextStatus {
  if (pct >= CONTEXT_CRITICAL_PCT) return 'critical'
  if (pct >= CONTEXT_WARN_PCT) return 'warn'
  return 'ok'
}

export interface BuildContextUsageArgs {
  chatId: string
  snapshot: ContextUsageSnapshot
  source: ContextUsageSource
  scope?: ContextUsageScope
  compressed?: boolean
  historyMessages?: number
  toolCallsCount?: number
  pricing?: { inputPerM: number; outputPerM: number } | null
  estimatedCostCents?: number | null
  providerId?: string
  modelId?: string
}

/**
 * Собирает payload события `context:usage` из снапшота.
 * pct/status всегда пересчитываются здесь — эмиттер их не задаёт.
 */
export function buildContextUsagePayload(args: BuildContextUsageArgs): ContextUsagePayload {
  const { snapshot } = args
  const pct = contextPct(snapshot.estimated, snapshot.limit)
  return {
    chatId: args.chatId,
    pct,
    estimated: snapshot.estimated,
    limit: snapshot.limit,
    status: contextStatus(pct),
    source: args.source,
    scope: args.scope,
    compressed: args.compressed ?? snapshot.compressed,
    breakdown: snapshot.breakdown,
    historyMessages: args.historyMessages,
    toolCallsCount: args.toolCallsCount,
    pricing: args.pricing ?? null,
    estimatedCostCents: args.estimatedCostCents ?? null,
    providerId: args.providerId,
    modelId: args.modelId,
  }
}

/** Дешёвая оценка черновика для live-предпросмотра в renderer. */
export function estimateDraftTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / DRAFT_CHARS_PER_TOKEN)
}
