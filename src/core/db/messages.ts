import type { Message } from '../../shared/types'
import { getDB } from './handle'
import { touchChat } from './chats'
import { deleteStreamingBuffer, deleteStreamingBuffersForChat } from './streamingBuffers'

// === MESSAGES ===

// ── Инвалидация кэша истории через callback ──
// historyCache.ts импортирует getMessages из этого файла. Чтобы не создавать
// циклический import (messages.ts → historyCache.ts → messages.ts), используем
// callback: historyCache.ts регистрирует invalidateHistoryCache через
// setMessageSavedCallback при загрузке. saveMessage/deleteMessage вызывают
// callback → кэш чата протухает → следующий getMessagesCached перечитает из БД.
let _onMessageSaved: ((chatId: string) => void) | null = null
export function setMessageSavedCallback(cb: (chatId: string) => void): void { _onMessageSaved = cb }

export function saveMessage(msg: Message): void {
  getDB().prepare(`
    INSERT OR REPLACE INTO messages (id, chat_id, role, content, created_at, is_pinned, model, tool_steps, thinking, thinking_ms, slash_command, iterations, plan_data, todo, compact_summary, compact_stats, attachments, attachment_result, duration_ms, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, tool_calls_count, thinking_blocks, finish_reason, streaming_ms, reply_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    (msg as Message & { thinkingBlocks?: unknown }).thinkingBlocks ? JSON.stringify((msg as Message & { thinkingBlocks?: unknown }).thinkingBlocks) : null,
    msg.finishReason ?? null,
    msg.streamingMs ?? null,
    msg.replyTo ? JSON.stringify(msg.replyTo) : null,
  )
  touchChat(msg.chatId)
  _onMessageSaved?.(msg.chatId)
}

type MessageRow = Message & {
  toolStepsJson?: string; slashCommandJson?: string; iterationsJson?: string
  planDataJson?: string; todoJson?: string; compactStatsJson?: string
  attachmentsJson?: string; attachmentResultJson?: string
  thinkingBlocksJson?: string; replyToJson?: string
}

function parseMessageRow(r: MessageRow): Message {
  const { toolStepsJson, slashCommandJson, iterationsJson, planDataJson, todoJson, compactStatsJson, attachmentsJson, attachmentResultJson, thinkingBlocksJson, replyToJson, ...rest } = r
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
    thinkingBlocks: thinkingBlocksJson ? JSON.parse(thinkingBlocksJson) : undefined,
    replyTo: replyToJson ? JSON.parse(replyToJson) : undefined,
  }
}

const MESSAGE_SELECT_COLS = `SELECT
  id, chat_id as chatId, role, content, created_at as createdAt, is_pinned as isPinned, model,
  tool_steps as toolStepsJson, thinking, thinking_ms as thinkingMs, slash_command as slashCommandJson,
  iterations as iterationsJson, plan_data as planDataJson, todo as todoJson, compact_summary as compactSummary,
  compact_stats as compactStatsJson, attachments as attachmentsJson, attachment_result as attachmentResultJson,
  duration_ms as durationMs, streaming_ms as streamingMs, prompt_tokens as promptTokens, completion_tokens as completionTokens,
  cache_read_tokens as cacheReadTokens, cache_write_tokens as cacheWriteTokens, tool_calls_count as toolCallsCount,
  finish_reason as finishReason,
  thinking_blocks as thinkingBlocksJson, hidden_from_context as hiddenFromContext,
  reply_to as replyToJson`

export function getMessages(chatId: string): Message[] {
  const rows = getDB().prepare(`
    ${MESSAGE_SELECT_COLS}
    FROM messages WHERE chat_id = ?
    ORDER BY created_at ASC
  `).all(chatId) as MessageRow[]
  return rows.map(parseMessageRow)
}

/** Одно сообщение по id (для плагинов: chats.getAttachments и др.). */
export function getMessageById(messageId: string): Message | undefined {
  const row = getDB().prepare(`
    ${MESSAGE_SELECT_COLS}
    FROM messages WHERE id = ?
  `).get(messageId) as MessageRow | undefined
  return row ? parseMessageRow(row) : undefined
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

/** Правка содержимого сообщения (для плагинов: chats.editMessage; для
 *  редактора чата: chat:editMessage).
 *
 *  iterTexts — правка текстовых сегментов СООБЩЕНИЯ С ТУЛАМИ: у таких
 *  сообщений текст размазан по iterations[].textBefore (UI рендерит именно
 *  их), а message.content в UI не отображается. Передаём новые значения
 *  textBefore по индексу итерации — main мержит их в ПОЛНУЮ запись из БД
 *  (renderer держит лишь slim-копию с урезанными tool-пейлоадами — писать
 *  её назад нельзя). content пересобирается из итоговых textBefore, чтобы
 *  AI-контекст (messageToContextMessages берёт content) видел правки. */
export function editMessageContent(messageId: string, content: string, iterTexts?: string[]): boolean {
  const db = getDB()
  const row = db.prepare('SELECT chat_id as chatId, iterations FROM messages WHERE id = ?')
    .get(messageId) as { chatId: string; iterations: string | null } | undefined
  if (!row) return false
  let finalContent = content
  let iterationsJson: string | null = row.iterations
  if (Array.isArray(iterTexts)) {
    let iters: Array<{ textBefore?: string }> = []
    try { iters = row.iterations ? JSON.parse(row.iterations) : [] } catch { iters = [] }
    if (iters.length > 0) {
      iters = iters.map((it, i) => (i < iterTexts.length ? { ...it, textBefore: iterTexts[i] } : it))
      iterationsJson = JSON.stringify(iters)
      // content = конкатенация непустых сегментов — то, что видит пользователь
      // (messageToContextMessages отправляет content в AI-контекст).
      finalContent = iters.map(it => it.textBefore ?? '').filter(t => t.trim().length > 0).join('\n\n')
    }
  }
  const info = db.prepare('UPDATE messages SET content = ?, iterations = ? WHERE id = ?')
    .run(finalContent, iterationsJson, messageId)
  if (info.changes > 0 && row) {
    touchChat(row.chatId)
    _onMessageSaved?.(row.chatId)
    return true
  }
  return false
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
  // Берём chatId до удаления для инвалидации кэша
  const row = getDB().prepare('SELECT chat_id as chatId FROM messages WHERE id = ?').get(messageId) as { chatId: string } | undefined
  getDB().prepare(`DELETE FROM messages WHERE id = ?`).run(messageId)
  // Чистим streaming-буфер этого сообщения, чтобы краш-рекавери (historyCache)
  // не воскресил удалённое сообщение из чекпоинта стриминга.
  deleteStreamingBuffer(messageId)
  // Чекпоинты ссылаются на user_message_id/assistant_message_id — удаляем
  // осиротевшие, иначе кнопка «Откатить» в панели «Сессия» укажет в пустоту.
  getDB().prepare(`DELETE FROM chat_checkpoints WHERE user_message_id = ? OR assistant_message_id = ?`).run(messageId, messageId)
  if (row?.chatId) _onMessageSaved?.(row.chatId)
}

/** Скрыть/показать сообщение в AI-контексте (редактор чата).
 *  Скрытое остаётся в чате (затемнено, с пометкой), но getLiveMessages
 *  исключает его из промпта, счётчика контекста и компакции. */
export function setMessageHidden(messageId: string, hidden: boolean): boolean {
  const db = getDB()
  const row = db.prepare('SELECT chat_id as chatId FROM messages WHERE id = ?').get(messageId) as { chatId: string } | undefined
  const info = db.prepare('UPDATE messages SET hidden_from_context = ? WHERE id = ?').run(hidden ? 1 : 0, messageId)
  if (info.changes > 0 && row) {
    touchChat(row.chatId)
    _onMessageSaved?.(row.chatId)
    return true
  }
  return false
}

/**
 * Удаляет все сообщения чата с created_at > порога (используется при rewind
 * для очистки откатнутых сообщений). Возвращает кол-во удалённых.
 */
export function deleteMessagesAfter(chatId: string, createdAt: number): number {
  const info = getDB().prepare(`DELETE FROM messages WHERE chat_id = ? AND created_at > ?`).run(chatId, createdAt)
  // Удаляем и streaming-буферы чата: чекпоинты откатнутых (будущих) сообщений
  // не должны быть восстановлены краш-рекавери при следующей загрузке чата.
  deleteStreamingBuffersForChat(chatId)
  _onMessageSaved?.(chatId)
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

/**
 * Последнее rewind system-сообщение чата (для redo-баннера в правой панели).
 * Возвращает { id, createdAt } последнего сообщения с slashCommand.name='rewind'
 * или null если отката не было. Используется панелью «Сессия» чтобы показать
 * кнопку «Отменить откат» без загрузки всех сообщений.
 */
export function getLastRewindMessage(chatId: string): { id: string; createdAt: number } | null {
  const row = getDB().prepare(`
    SELECT id, created_at as createdAt FROM messages
    WHERE chat_id = ? AND slash_command LIKE '%"name":"rewind"%'
    ORDER BY created_at DESC LIMIT 1
  `).get(chatId) as { id: string; createdAt: number } | undefined
  return row ?? null
}

