import { getDB } from './handle'
import { perfMark, perfEvent } from '../performanceDiagnostics'

// === STREAMING BUFFERS ===
// Промежуточные чекпоинты активного стриминга assistant-ответа (каждые 3с).
// Отдельная таблица БЕЗ FTS5-триггеров: INSERT OR REPLACE в messages каждый
// чекпоинт пересобирал messages_fts (триггеры на DELETE+INSERT) — синхронная
// переиндексация всего content на main → фризы на слабых машинах. Здесь —
// сырой JSON (payload = полный Message), триггеры не задействованы.
// Финальную полную версию в messages пишет sendDone (один раз, с триггерами)
// и тут же удаляет буфер. После краша процесса буфер переносится в messages
// при загрузке чата (краш-рекавери в src/main/ipc/historyCache.ts).

export interface StreamingBufferRow {
  messageId: string
  chatId: string
  payload: string
  updatedAt: number
}

export function saveStreamingBuffer(messageId: string, chatId: string, payloadJson: string): void {
  const started = perfMark()
  getDB().prepare(`
    INSERT OR REPLACE INTO streaming_buffers (message_id, chat_id, payload, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(messageId, chatId, payloadJson, Date.now())
  perfEvent('db.streaming_buffer.save', perfMark() - started)
}

export function getStreamingBuffer(messageId: string): StreamingBufferRow | null {
  const row = getDB().prepare(`
    SELECT message_id as messageId, chat_id as chatId, payload, updated_at as updatedAt
    FROM streaming_buffers WHERE message_id = ?
  `).get(messageId) as StreamingBufferRow | undefined
  return row ?? null
}

export function deleteStreamingBuffer(messageId: string): void {
  getDB().prepare('DELETE FROM streaming_buffers WHERE message_id = ?').run(messageId)
}

export function deleteStreamingBuffersForChat(chatId: string): void {
  getDB().prepare('DELETE FROM streaming_buffers WHERE chat_id = ?').run(chatId)
}

/** Все буферы чата — для краш-рекавери при загрузке истории (см. historyCache). */
export function getStreamingBuffersForChat(chatId: string): StreamingBufferRow[] {
  return getDB().prepare(`
    SELECT message_id as messageId, chat_id as chatId, payload, updated_at as updatedAt
    FROM streaming_buffers WHERE chat_id = ?
    ORDER BY updated_at ASC
  `).all(chatId) as StreamingBufferRow[]
}
