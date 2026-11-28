import { useState, useEffect, useRef } from 'react'
import { IPC_EVENTS } from '@shared/constants'
import {
  contextPct, contextPercent, contextStatus, estimateDraftTokens,
  type ContextUsageBreakdown, type ContextUsagePayload, type ContextUsageScope, type ContextUsageSource,
} from '@shared/contextUsage'

/**
 * Контекст-информация для ContextRing.
 *
 * Источник — push-события `context:usage` из main. Арифметика (pct/status)
 * и форма payload живут в `@shared/contextUsage`: раньше каждый эмиттер считал
 * процент и пороги сам, а renderer дублировал их ещё раз другими числами
 * (warning > 80 / critical > 95 против 60/85 в main) — кольцо и панель
 * показывали разное состояние для одного и того же значения.
 */
export interface ContextInfo {
  /** Токенов в ОДНОМ запросе (не сумма за ход) + текущий черновик. */
  estimated: number
  limit: number
  percent: number
  source: ContextUsageSource
  scope?: ContextUsageScope
  breakdown: ContextUsageBreakdown
  sessionCostCents: number | null
  sessionRequests: number
  sessionReportedRequests: number
  sessionUnpricedRequests: number
  lastRequestCostCents: number | null
  lastRequestCostReported: boolean
  sessionIncludesAuxiliary: boolean
  accountingStartedAt?: number | null
  // Поля для ContextRing (легаси-имена, читаются панелью)
  total: number
  modelId: string
  warning: boolean
  critical: boolean
  systemPrompt: number
  history: number
  historyMessages: number
  toolCallsTokens: number
  toolCallsCount: number
  currentInput: number
  reserved: number
  pricing: { inputPerM: number; outputPerM: number } | null
  estimatedCostCents: number | null
  compressed?: boolean
}

interface UseContextCounterOptions {
  chatId: string
  currentInput: string
  modelId: string
  providerId?: string
  incognito?: boolean
  enabled?: boolean
  messageCount?: number
  /** Draft tokens are only included in the idle next-request projection. */
  isRunning?: boolean
}

/** Стоимость приходит отдельным потоком (`context:cost`) — не путать с контекстом. */
type CostFields = Pick<ContextUsagePayload,
  'sessionCostCents' | 'sessionRequests' | 'sessionUnpricedRequests'
  | 'sessionReportedRequests' | 'lastRequestCostCents' | 'lastRequestCostReported'
  | 'sessionIncludesAuxiliary' | 'accountingStartedAt'>

export function useContextCounter({
  chatId,
  currentInput,
  modelId,
  providerId,
  enabled = true,
  isRunning = false,
}: UseContextCounterOptions) {
  const [info, setInfo] = useState<ContextInfo | null>(null)
  const lastPushRef = useRef<ContextUsagePayload | null>(null)
  const inputTokensRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pricingRef = useRef<ContextUsagePayload['pricing']>(null)
  // Costs have a separate stream: auxiliary requests must never replace
  // the main model's context usage, and later estimates must retain totals.
  const lastCostRef = useRef<Partial<CostFields> | null>(null)
  const isRunningRef = useRef(isRunning)
  useEffect(() => {
    isRunningRef.current = isRunning
    const base = lastPushRef.current
    if (base) setInfo(buildContextInfo(base, inputTokensRef.current, modelId, isRunning, pricingRef.current))
  }, [isRunning, modelId])

  // Подписка на push-события context:usage из main (заменяет polling context:calculate)
  useEffect(() => {
    if (!enabled) return
    const handler = (data: ContextUsagePayload) => {
      // Строгая привязка к чату. Раньше chatId в payload отсутствовал вовсе,
      // из-за чего фильтр не срабатывал никогда: сайд-чаты, дочерние чаты и
      // сабагенты писали свои цифры в кольцо открытого чата («странно между
      // сообщениями»). Теперь все эмиттеры обязаны его передавать.
      if (!data.chatId || data.chatId !== chatId) return
      const merged: ContextUsagePayload = { ...data, ...lastCostRef.current }
      lastPushRef.current = merged
      if (data.pricing !== undefined) pricingRef.current = data.pricing
      // Последнее измерение побеждает — и real, и estimate. Каждый раунд
      // реально меняет prompt (tool-результаты, новый ответ), поэтому «real
      // навсегда до компакции» показывал цифру прошлого запроса. Честность
      // оценки обеспечивают калибровка (usageTracker) и единая формула.
      setInfo(buildContextInfo(merged, inputTokensRef.current, modelId, isRunningRef.current, pricingRef.current))
    }
    const off = window.syntee.on(IPC_EVENTS.CONTEXT_USAGE, handler as (...args: unknown[]) => void)
    return () => { off() }
  }, [enabled, modelId, chatId])

  useEffect(() => {
    if (!enabled || !chatId) return
    const handler = (value: unknown) => {
      const event = value as Partial<ContextUsagePayload>
      if (event.chatId !== chatId) return
      const cost: Partial<CostFields> = {
        sessionCostCents: event.sessionCostCents,
        sessionRequests: event.sessionRequests,
        sessionReportedRequests: event.sessionReportedRequests,
        sessionUnpricedRequests: event.sessionUnpricedRequests,
        lastRequestCostCents: event.lastRequestCostCents,
        lastRequestCostReported: event.lastRequestCostReported,
        sessionIncludesAuxiliary: event.sessionIncludesAuxiliary,
        accountingStartedAt: event.accountingStartedAt,
      }
      lastCostRef.current = cost
      const base = lastPushRef.current
      if (!base) return
      lastPushRef.current = { ...base, ...cost }
      setInfo(buildContextInfo(lastPushRef.current, inputTokensRef.current, modelId, isRunningRef.current, pricingRef.current))
    }
    const off = window.syntee.on('context:cost', handler)
    return () => { off() }
  }, [chatId, enabled, modelId])

  // Сброс при смене чата + запросить свежий расчёт контекста из main.
  // Без этого info висит пустым (или показывает данные предыдущего чата),
  // пока пользователь не отправит первое сообщение — main эмитит CONTEXT_USAGE
  // только в chat:send.
  useEffect(() => {
    if (!enabled || !chatId) return
    setInfo(null)
    lastPushRef.current = null
    pricingRef.current = null
    lastCostRef.current = null
    inputTokensRef.current = 0
  }, [chatId, enabled])

  useEffect(() => {
    if (!enabled || !chatId) return
    window.syntee.context.calculate(chatId).catch(() => { /* тихо — не критично */ })
  }, [chatId, enabled, modelId, providerId])

  // Live-обновление при печати — эвристика в renderer (без IPC и tiktoken).
  useEffect(() => {
    if (!enabled) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      inputTokensRef.current = estimateDraftTokens(currentInput)
      const base = lastPushRef.current
      if (base) {
        setInfo(buildContextInfo(base, inputTokensRef.current, modelId, isRunningRef.current, pricingRef.current))
      }
    }, 500)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [chatId, currentInput, enabled, modelId])

  return info
}

function buildContextInfo(
  push: ContextUsagePayload,
  inputTokens: number,
  modelId: string,
  isRunning = false,
  fallbackPricing: ContextUsagePayload['pricing'] = null,
): ContextInfo {
  const breakdown = push.breakdown ?? { history: 0, system: 0, tools: 0, current: 0 }
  const addLive = push.source === 'estimate' && push.scope !== 'request' && !isRunning
  const currentInputTokens = addLive ? inputTokens : 0
  const total = push.estimated + currentInputTokens
  const percent = contextPercent(total, push.limit)
  // Пороги — те же, что в main (shared/contextUsage), а не «>80/>95».
  const status = contextStatus(contextPct(total, push.limit))

  return {
    estimated: total,
    limit: push.limit,
    percent,
    source: push.source,
    scope: push.scope,
    breakdown,
    sessionCostCents: push.sessionCostCents ?? null,
    sessionRequests: push.sessionRequests ?? 0,
    sessionReportedRequests: push.sessionReportedRequests ?? 0,
    sessionUnpricedRequests: push.sessionUnpricedRequests ?? 0,
    lastRequestCostCents: push.lastRequestCostCents ?? null,
    lastRequestCostReported: push.lastRequestCostReported ?? false,
    sessionIncludesAuxiliary: push.sessionIncludesAuxiliary ?? false,
    accountingStartedAt: push.accountingStartedAt,
    // Legacy поля для ContextRing
    total,
    modelId: push.modelId ?? modelId,
    warning: status !== 'ok',
    critical: status === 'critical',
    systemPrompt: breakdown.system,
    history: breakdown.history,
    historyMessages: push.historyMessages ?? 0,
    toolCallsTokens: breakdown.tools,
    toolCallsCount: push.toolCallsCount ?? 0,
    currentInput: currentInputTokens,
    reserved: 0,
    pricing: push.pricing ?? fallbackPricing ?? null,
    estimatedCostCents: push.estimatedCostCents ?? null,
    compressed: push.compressed,
  }
}
