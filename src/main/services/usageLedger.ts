import type Database from 'better-sqlite3'
import { getDB } from '../../core/db/handle'
import { calculateUsageCost } from '../../core/tokens/usageTracker'
import { setAIUsageSink, type AIRequestUsage } from '../../core/ai/requestUsage'
import { log } from '../../core/logger'

export interface ChatCostSnapshot {
  chatId: string
  sessionCostCents: number | null
  sessionRequests: number
  sessionReportedRequests: number
  sessionUnpricedRequests: number
  lastRequestCostCents: number | null
  lastRequestCostReported: boolean
  sessionIncludesAuxiliary: true
  accountingStartedAt: number | null
}

interface Totals {
  total_cents: number
  requests: number
  unpriced_requests: number
  priced_requests: number
  reported_requests: number
  started_at: number
  last_cost_cents: number | null
  last_cost_reported: number
}

export function getChatCost(chatId: string, db: Database.Database = getDB()): ChatCostSnapshot {
  const row = db.prepare('SELECT * FROM ai_usage_totals WHERE chat_id = ?').get(chatId) as Totals | undefined
  return { chatId, sessionCostCents: row?.priced_requests ? row.total_cents : null,
    sessionRequests: row?.requests ?? 0, sessionUnpricedRequests: row?.unpriced_requests ?? 0,
    sessionReportedRequests: row?.reported_requests ?? 0, lastRequestCostCents: row?.last_cost_cents ?? null,
    lastRequestCostReported: row?.last_cost_reported === 1, sessionIncludesAuxiliary: true,
    accountingStartedAt: row?.started_at ?? null }
}

/** Main-process only: cumulative usage packets UPSERT, never add the same request twice. */
export function recordAIUsage(event: AIRequestUsage, db: Database.Database = getDB()): ChatCostSnapshot | null {
  if (!event.chatId || !event.requestId) return null
  const reported = typeof event.reportedCostCents === 'number' && Number.isFinite(event.reportedCostCents)
    && event.reportedCostCents >= 0
  const cost = reported ? event.reportedCostCents! : event.inputTokens != null || event.outputTokens != null
    ? calculateUsageCost(event.pricing, event.inputTokens ?? 0, event.outputTokens ?? 0, event.cacheReadTokens, event.cacheWriteTokens) : null
  const unpriced = (cost == null || !event.complete) && !reported ? 1 : 0
  db.transaction(() => {
    // A terminated worker cannot send a final packet. Detail expires after a
    // day; its incomplete marker and any known cost remain in lifetime totals.
    db.prepare('UPDATE ai_usage_requests SET finished = 1 WHERE chat_id = ? AND finished = 0 AND timestamp < ?')
      .run(event.chatId, Date.now() - 86_400_000)
    const old = db.prepare('SELECT chat_id, cost_cents, cost_reported, complete, finished FROM ai_usage_requests WHERE request_id = ?')
      .get(event.requestId) as { chat_id: string; cost_cents: number | null; cost_reported: number; complete: number; finished: number } | undefined
    // Settled usage cannot be overwritten by a duplicate or a late partial packet.
    if (old && (old.chat_id !== event.chatId || old.complete && (!event.complete || old.finished)
      || old.cost_reported && !reported)) return
    db.prepare(`INSERT INTO ai_usage_requests
      (request_id, chat_id, provider_id, model_id, source, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, cost_reported, complete, finished, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
        cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
        cost_cents=excluded.cost_cents, cost_reported=excluded.cost_reported, complete=excluded.complete, finished=excluded.finished`)
      .run(event.requestId, event.chatId, event.providerId, event.modelId, event.source ?? 'unknown',
        event.inputTokens ?? null, event.outputTokens ?? null, event.cacheReadTokens ?? null,
        event.cacheWriteTokens ?? null, cost, Number(reported), event.complete ? 1 : 0, event.finished ? 1 : 0, event.timestamp)
    const deltaUnpriced = unpriced - (old && !old.cost_reported && (old.cost_cents == null || !old.complete) ? 1 : 0)
    const deltaPriced = (cost != null ? 1 : 0) - (old?.cost_cents != null ? 1 : 0)
    const deltaReported = Number(reported) - (old?.cost_reported ?? 0)
    db.prepare(`INSERT INTO ai_usage_totals
      (chat_id, total_cents, requests, unpriced_requests, priced_requests, reported_requests, started_at, last_request_id, last_request_at, last_cost_cents, last_cost_reported)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET total_cents=total_cents+excluded.total_cents,
        requests=requests+excluded.requests, unpriced_requests=unpriced_requests+excluded.unpriced_requests,
        priced_requests=priced_requests+excluded.priced_requests,
        reported_requests=reported_requests+excluded.reported_requests,
        started_at=MIN(started_at, excluded.started_at),
        last_request_id=CASE WHEN excluded.last_request_at >= last_request_at THEN excluded.last_request_id ELSE last_request_id END,
        last_cost_cents=CASE WHEN excluded.last_request_at >= last_request_at THEN excluded.last_cost_cents ELSE last_cost_cents END,
        last_cost_reported=CASE WHEN excluded.last_request_at >= last_request_at THEN excluded.last_cost_reported ELSE last_cost_reported END,
        last_request_at=MAX(last_request_at, excluded.last_request_at)`)
      .run(event.chatId, (cost ?? 0) - (old?.cost_cents ?? 0), old ? 0 : 1, deltaUnpriced, deltaPriced, deltaReported,
        event.timestamp, event.requestId, event.timestamp, cost, Number(reported))
    // Keep recent request detail bounded; lifetime totals stay in the compact row.
    // Active streams are never pruned, so partial/final updates retain their identity.
    if (!old) db.prepare(`DELETE FROM ai_usage_requests WHERE chat_id = ? AND finished = 1 AND request_id IN
      (SELECT request_id FROM ai_usage_requests WHERE chat_id = ? AND finished = 1 ORDER BY timestamp DESC LIMIT -1 OFFSET 2000)`)
      .run(event.chatId, event.chatId)
  })()
  return getChatCost(event.chatId, db)
}

export function deleteChatCosts(chatId: string): void {
  const db = getDB()
  db.transaction(() => {
    db.prepare('DELETE FROM ai_usage_requests WHERE chat_id = ?').run(chatId)
    db.prepare('DELETE FROM ai_usage_totals WHERE chat_id = ?').run(chatId)
  })()
}

let broadcast: ((snapshot: ChatCostSnapshot) => void) | null = null
export function installUsageAccounting(listener: (snapshot: ChatCostSnapshot) => void): void {
  broadcast = listener
  setAIUsageSink(acceptAIUsage)
  // At application startup no workers from the preceding process are alive.
  const db = getDB()
  db.prepare('UPDATE ai_usage_requests SET finished = 1 WHERE finished = 0').run()
  db.prepare(`DELETE FROM ai_usage_requests WHERE request_id IN (
    SELECT request_id FROM (SELECT request_id,
      ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY timestamp DESC) AS rn
      FROM ai_usage_requests WHERE finished = 1) WHERE rn > 2000
  )`).run()
}

export function acceptAIUsage(event: AIRequestUsage): void {
  try {
    if (!event.chatId || !getDB().prepare('SELECT 1 FROM chats WHERE id = ?').get(event.chatId)) return
    const snapshot = recordAIUsage(event)
    if (snapshot) broadcast?.(snapshot)
  } catch (error) { log('[usage-ledger] persistence failed: %s', (error as Error).message) }
}
