import type { Message } from '../../shared/types'
import { getDB } from './handle'
import { touchChat } from './chats'

// === MESSAGES ===

export function saveMessage(msg: Message): void {
  getDB().prepare(`
    INSERT OR REPLACE INTO messages (id, chat_id, role, content, created_at, is_pinned, model, tool_steps, thinking, thinking_ms, slash_command, iterations, plan_data, todo, compact_summary, compact_stats, attachments, attachment_result, duration_ms, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, tool_calls_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id, msg.chatId, msg.role, msg.content, msg.createdAt, msg.isPinned, msg.model ?? null,
    msg.toolSteps ? JSON.stringify(msg.toolSteps) : null,
    msg.thinking ?? null, msg.thinkingMs ?? null,
    msg.slashCommand ? JSON.stringify(msg.slashCommand) : null,
    (msg as Message & { iterations?: unknown }).iterations ? JSON.stringify((msg as Message & { iterations?: unknown }).iterations) : null,
    msg.planData ? JSON.stringify(msg.planData) : null,
    msg.todo ? JSON.stringify(msg.todo) : null,
    msg.compactSummary ?? null,
    msg.compactStats ? JSON.stringify(msg.compactStats) : null,
    msg.attachments ? JSON.stringify(msg.attachments) : null,
    msg.attachmentResult ? JSON.stringify(msg.attachmentResult) : null,
    msg.durationMs ?? null,
    msg.promptTokens ?? null,
    msg.completionTokens ?? null,
    msg.cacheReadTokens ?? null,
    msg.cacheWriteTokens ?? null,
    msg.toolCallsCount ?? null,
  )
  touchChat(msg.chatId)
}

type MessageRow = Message & {
  toolStepsJson?: string; slashCommandJson?: string; iterationsJson?: string
  planDataJson?: string; todoJson?: string; compactStatsJson?: string
  attachmentsJson?: string; attachmentResultJson?: string
}

function parseMessageRow(r: MessageRow): Message {
  const { toolStepsJson, slashCommandJson, iterationsJson, planDataJson, todoJson, compactStatsJson, attachmentsJson, attachmentResultJson, ...rest } = r
  return {
    ...rest,
    toolSteps: toolStepsJson ? JSON.parse(toolStepsJson) : undefined,
    slashCommand: slashCommandJson ? JSON.parse(slashCommandJson) : undefined,
    iterations: iterationsJson ? JSON.parse(iterationsJson) : undefined,
    planData: planDataJson ? JSON.parse(planDataJson) : undefined,
    todo: todoJson ? JSON.parse(todoJson) : undefined,
    compactStats: compactStatsJson ? JSON.parse(compactStatsJson) : undefined,
    attachments: attachmentsJson ? JSON.parse(attachmentsJson) : undefined,
    attachmentResult: attachmentResultJson ? JSON.parse(attachmentResultJson) : undefined,
  }
}

const MESSAGE_SELECT_COLS = `SELECT
  id, chat_id as chatId, role, content, created_at as createdAt, is_pinned as isPinned, model,
  tool_steps as toolStepsJson, thinking, thinking_ms as thinkingMs, slash_command as slashCommandJson,
  iterations as iterationsJson, plan_data as planDataJson, todo as todoJson, compact_summary as compactSummary,
  compact_stats as compactStatsJson, attachments as attachmentsJson, attachment_result as attachmentResultJson,
  duration_ms as durationMs, prompt_tokens as promptTokens, completion_tokens as completionTokens,
  cache_read_tokens as cacheReadTokens, cache_write_tokens as cacheWriteTokens, tool_calls_count as toolCallsCount`

export function getMessages(chatId: string): Message[] {
  const rows = getDB().prepare(`
    ${MESSAGE_SELECT_COLS}
    FROM messages WHERE chat_id = ?
    ORDER BY created_at ASC
  `).all(chatId) as MessageRow[]
  return rows.map(parseMessageRow)
}

/**
 * Окно сообщений для пагинации (reverse-infinite scroll).
 *
 * Возвращает последние `limit` сообщений чата (если курсор не задан) либо
 * сообщения строго старее курсора `(beforeCreatedAt, beforeId)`. Результат —
 * в ASC порядке (старейшие первыми), готов для рендера.
 *
 * `hasMore` = есть ли в БД ещё более старые сообщения. Определяется +1-трюком:
 * запрашиваем limit+1 строку; если она вернулась — hasMore=true и мы её
 * отбрасываем. Отдельный COUNT-запрос не нужен.
 *
 * Курсор по паре (created_at, id) — устойчив к коллизиям created_at (Date.now()
 * может совпасть для двух сообщений, сохранённых в одну миллисекунду).
 */
export function getMessagesPage(
  chatId: string,
  limit = 20,
  beforeCreatedAt?: number,
  beforeId?: string,
): { messages: Message[]; hasMore: boolean } {
  const fetchLimit = limit + 1
  let rows: MessageRow[]
  if (beforeCreatedAt != null && beforeId != null) {
    rows = getDB().prepare(`
      ${MESSAGE_SELECT_COLS}
      FROM messages
      WHERE chat_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(chatId, beforeCreatedAt, beforeCreatedAt, beforeId, fetchLimit) as MessageRow[]
  } else {
    rows = getDB().prepare(`
      ${MESSAGE_SELECT_COLS}
      FROM messages
      WHERE chat_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(chatId, fetchLimit) as MessageRow[]
  }
  const hasMore = rows.length > limit
  if (hasMore) rows = rows.slice(0, limit)
  // rows — DESC (новейшие первыми). Разворачиваем в ASC для рендера.
  rows.reverse()
  return { messages: rows.map(parseMessageRow), hasMore }
}

export function pinMessage(id: string): void {
  const db = getDB()
  db.prepare('UPDATE messages SET is_pinned = 1 WHERE id = ?').run(id)
  db.prepare('INSERT OR IGNORE INTO pinned_messages (message_id, pinned_at) VALUES (?, ?)')
    .run(id, Date.now())
}

export function unpinMessage(id: string): void {
  const db = getDB()
  db.prepare('UPDATE messages SET is_pinned = 0 WHERE id = ?').run(id)
  db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(id)
}

export function deleteMessageById(messageId: string): void {
  getDB().prepare(`DELETE FROM messages WHERE id = ?`).run(messageId)
}

/**
 * Удаляет все сообщения чата с created_at > порога (используется при rewind
 * для очистки откатнутых сообщений). Возвращает кол-во удалённых.
 */
export function deleteMessagesAfter(chatId: string, createdAt: number): number {
  const info = getDB().prepare(`DELETE FROM messages WHERE chat_id = ? AND created_at > ?`).run(chatId, createdAt)
  return info.changes
}

/**
 * Кол-во сообщений в чате (для snapshot'а context_snapshot).
 */
export function getMessageCount(chatId: string): number {
  const row = getDB().prepare(`SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ?`).get(chatId) as { cnt: number }
  return row.cnt
}

/**
 * Содержимое всех user-сообщений чата в хронологическом порядке (ASC).
 * Используется для истории навигации по стрелкам вверх/вниз в инпут-баре.
 * Возвращается как есть (с возможными подряд-дубликатами) — дедупликация
 * consecutive-дубликатов выполняется в рендерере.
 */
export function getUserMessageContents(chatId: string): string[] {
  const rows = getDB().prepare(
    `SELECT content FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at ASC`
  ).all(chatId) as { content: string }[]
  return rows.map(r => r.content)
}
