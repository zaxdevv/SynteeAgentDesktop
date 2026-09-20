import type { Message } from '../../shared/types'
import { v4 as uuid } from 'uuid'
import { getDB } from './handle'

// === CHECKPOINTS / REWIND ===
//
// Точка отката = пара (user_message_id, assistant_message_id) одного turn'а.
// На каждый turn пишем (в sendDone, после всех мутаций агента):
//   1. file_snapshots — {path, content_before} для каждого файла, изменённого
//      в этом turn'е. content_before NULL = файл был создан этим turn'ом.
//   2. context_snapshots — слепок chat_working_memory + chat_summaries ПОСЛЕ
//      этого turn'а (т.е. состояние, в котором следующий turn стартует).
//   3. chat_checkpoints — плоский список точек отката для UI-таймлайна.
//
// rewind(chatId, userMessageId) = "вернуться к состоянию ПОСЛЕ этого turn'а":
//   - восстановить файлы из file_snapshots всех turn'ов ПОСЛЕ указанного
//     (строго после — сам указанный turn оставляем, откатываются только
//     последующие)
//   - восстановить context_snapshot этого turn'а (post-turn состояние)
//   - удалить сообщения после assistant-сообщения этого turn'а
//   - удалить чекпоинты откатнутых (последующих) turn'ов

export interface FileSnapshotEntry {
  path: string
  contentBefore: string | null
}

export interface CheckpointMeta {
  id: string
  chatId: string
  userMessageId: string
  assistantMessageId: string | null
  userPromptPreview: string
  filesChanged: number
  filePaths: string[]
  createdAt: number
  /** Имя снапшота для /snapshot <name> + /restore <name>. NULL у обычных
   *  auto-checkpoint'ов на каждый turn. Именованные снапшоты — поименованные
   *  точки отката, которые пользователь явно создал. */
  name?: string | null
}

export function saveFileSnapshots(
  chatId: string,
  messageId: string,
  userMessageId: string,
  entries: FileSnapshotEntry[],
): void {
  if (entries.length === 0) return
  const db = getDB()
  const now = Date.now()
  const stmt = db.prepare(`
    INSERT INTO file_snapshots (id, chat_id, message_id, user_message_id, path, content_before, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const tx = db.transaction((items: FileSnapshotEntry[]) => {
    for (const e of items) {
      stmt.run(uuid(), chatId, messageId, userMessageId, e.path, e.contentBefore, now)
    }
  })
  tx(entries)
}

export function saveContextSnapshot(
  chatId: string,
  userMessageId: string,
  workingMemory: string,
  chatSummary: string,
  messageCount: number,
): void {
  // POST-turn состояние: working_memory и summary уже обновлены агентом
  // (update_working_memory tool) и компакцией (applyRollingWindowAsync).
  // Это состояние, в котором следующий turn стартует — именно его нужно
  // восстановить при rewind к этому turn'у.
  getDB().prepare(`
    INSERT INTO context_snapshots (id, chat_id, user_message_id, working_memory, chat_summary, message_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuid(), chatId, userMessageId, workingMemory, chatSummary, messageCount, Date.now())
}

export function saveCheckpointMeta(
  chatId: string,
  userMessageId: string,
  assistantMessageId: string | null,
  userPrompt: string,
  filePaths: string[],
): void {
  const preview = userPrompt.length > 120 ? userPrompt.slice(0, 120) + '…' : userPrompt
  getDB().prepare(`
    INSERT INTO chat_checkpoints (id, chat_id, user_message_id, assistant_message_id, user_prompt_preview, files_changed, file_paths, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(), chatId, userMessageId, assistantMessageId, preview,
    filePaths.length, JSON.stringify(filePaths), Date.now(),
  )
}

/**
 * Создаёт именованный снапшот текущего состояния чата — без привязки к
 * конкретному user_message_id (используется последний checkpoint).
 *
 * Именованный снапшот — это "сохранённая точка" с именем, которую пользователь
 * может восстановить через /restore <name>. В отличие от обычных auto-
 * checkpoint'ов на каждый turn, именованные явно создаются пользователем.
 *
 * Реализация: находим последний существующий checkpoint чата, копируем его
 * метаданные в новую запись с указанным name. file_snapshots и context_snapshots
 * уже привязаны к user_message_id — дублировать их не нужно, при restore
 * через chat:rewindTo они подтянутся автоматически.
 *
 * Возвращает созданную CheckpointMeta или null если чекпоинтов в чате нет.
 */
export function saveNamedSnapshot(chatId: string, name: string): CheckpointMeta | null {
  const last = getLastCheckpoint(chatId)
  if (!last) return null
  const id = uuid()
  const now = Date.now()
  getDB().prepare(`
    INSERT INTO chat_checkpoints (id, chat_id, user_message_id, assistant_message_id, user_prompt_preview, files_changed, file_paths, created_at, name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, chatId, last.userMessageId, last.assistantMessageId,
    last.userPromptPreview, last.filesChanged, JSON.stringify(last.filePaths),
    now, name,
  )
  return {
    id, chatId,
    userMessageId: last.userMessageId,
    assistantMessageId: last.assistantMessageId,
    userPromptPreview: last.userPromptPreview,
    filesChanged: last.filesChanged,
    filePaths: last.filePaths,
    createdAt: now,
    name,
  }
}

export function getCheckpoints(chatId: string): CheckpointMeta[] {
  const rows = getDB().prepare(`
    SELECT id, chat_id as chatId, user_message_id as userMessageId,
           assistant_message_id as assistantMessageId,
           user_prompt_preview as userPromptPreview,
           files_changed as filesChanged, file_paths as filePathsJson,
           created_at as createdAt, name
    FROM chat_checkpoints WHERE chat_id = ?
    ORDER BY created_at ASC
  `).all(chatId) as (Omit<CheckpointMeta, 'filePaths'> & { filePathsJson: string; name?: string | null })[]
  return rows.map(r => ({
    id: r.id, chatId: r.chatId, userMessageId: r.userMessageId,
    assistantMessageId: r.assistantMessageId, userPromptPreview: r.userPromptPreview,
    filesChanged: r.filesChanged, filePaths: JSON.parse(r.filePathsJson) as string[],
    createdAt: r.createdAt,
    name: r.name ?? null,
  }))
}

/**
 * Возвращает только именованные снапшоты чата (для пикера /restore).
 * Сортировка: новые первыми (UI покажет свежие сверху).
 */
export function getNamedSnapshots(chatId: string): CheckpointMeta[] {
  const rows = getDB().prepare(`
    SELECT id, chat_id as chatId, user_message_id as userMessageId,
           assistant_message_id as assistantMessageId,
           user_prompt_preview as userPromptPreview,
           files_changed as filesChanged, file_paths as filePathsJson,
           created_at as createdAt, name
    FROM chat_checkpoints
    WHERE chat_id = ? AND name IS NOT NULL
    ORDER BY created_at DESC
  `).all(chatId) as (Omit<CheckpointMeta, 'filePaths'> & { filePathsJson: string; name?: string | null })[]
  return rows.map(r => ({
    id: r.id, chatId: r.chatId, userMessageId: r.userMessageId,
    assistantMessageId: r.assistantMessageId, userPromptPreview: r.userPromptPreview,
    filesChanged: r.filesChanged, filePaths: JSON.parse(r.filePathsJson) as string[],
    createdAt: r.createdAt,
    name: r.name ?? null,
  }))
}

export function getLastCheckpoint(chatId: string): CheckpointMeta | null {
  const rows = getCheckpoints(chatId)
  return rows.length > 0 ? rows[rows.length - 1] : null
}

/**
 * Все file_snapshots для turn'ов ПОСЛЕ указанного user_message_id (строго
 * после, не включая сам указанный turn). Используется при rewind: восстанав-
 * ливаем content_before в обратном порядке (последняя правка первой).
 *
 * "Rewind to turn N" = сохранить изменения turn'а N, откатить только
 * последующие turn'ы.
 */
/**
 * Возвращает file_snapshots конкретного checkpoint'а (turn'а) — для undo
 * правок последнего запроса БЕЗ удаления сообщений диалога.
 * Берём последний checkpoint с этим userMessageId (на случай дубликатов).
 */
export function getSnapshotsForCheckpoint(chatId: string, userMessageId: string): FileSnapshotEntry[] {
  const db = getDB()
  const cp = db.prepare(`
    SELECT created_at as createdAt FROM chat_checkpoints
    WHERE chat_id = ? AND user_message_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(chatId, userMessageId) as { createdAt: number } | undefined
  if (!cp) return []

  const rows = db.prepare(`
    SELECT path, content_before as contentBefore
    FROM file_snapshots
    WHERE chat_id = ? AND user_message_id = ?
    ORDER BY id DESC
  `).all(chatId, userMessageId) as FileSnapshotEntry[]
  return rows
}

export function getSnapshotsAfter(chatId: string, userMessageId: string): FileSnapshotEntry[] {
  const db = getDB()
  // ORDER BY created_at ASC LIMIT 1 — при дубликатах chat_checkpoints с одним
  // user_message_id (их создаёт saveNamedSnapshot, копируя метаданные) берём
  // САМЫЙ РАННИЙ: порог «строго после» должен отсекать все последующие turn'ы,
  // а не только те, что были после позднего дубликата.
  const cp = db.prepare(`
    SELECT created_at as createdAt FROM chat_checkpoints
    WHERE chat_id = ? AND user_message_id = ?
    ORDER BY created_at ASC LIMIT 1
  `).get(chatId, userMessageId) as { createdAt: number } | undefined
  if (!cp) return []

  // created_at > порог — строго после, исключает сам указанный turn.
  // Сортировка DESC — последние правки первыми (LIFO восстановление).
  const rows = db.prepare(`
    SELECT path, content_before as contentBefore
    FROM file_snapshots
    WHERE chat_id = ? AND created_at > ?
    ORDER BY created_at DESC, id DESC
  `).all(chatId, cp.createdAt) as FileSnapshotEntry[]
  return rows
}

/** Снапшот файла + принадлежность к turn'у (для кумулятивного диффа). */
export interface FileSnapshotRow extends FileSnapshotEntry {
  userMessageId: string
  createdAt: number
}

/**
 * Снапшоты конкретного turn'а В ПОРЯДКЕ ВЫПОЛНЕНИЯ ПРАВОК (rowid ASC).
 *
 * undoStack агента пишет одну запись на КАЖДУЮ правку (файл, правленный 3 раза
 * за turn, даёт 3 строки). ПЕРВАЯ строка по каждому пути = состояние до
 * ПЕРВОЙ правки файла в этом turn'е — это «до» для кумулятивного диффа
 * «весь запрос целиком» (как в Claude Code/Cursor).
 *
 * rowid — порядок INSERT (все строки turn'а имеют один created_at, различить
 * порядок правок по created_at нельзя; id — uuid v4, хронологии не несёт).
 */
export function getTurnSnapshotsOrdered(chatId: string, userMessageId: string): FileSnapshotRow[] {
  return getDB().prepare(`
    SELECT path, content_before as contentBefore,
           user_message_id as userMessageId, created_at as createdAt
    FROM file_snapshots
    WHERE chat_id = ? AND user_message_id = ?
    ORDER BY rowid ASC
  `).all(chatId, userMessageId) as FileSnapshotRow[]
}

/**
 * Снапшоты ВСЕХ последующих turn'ов (строго после указанного), ASC.
 *
 * Первая строка по каждому пути = состояние файла на момент начала следующего
 * turn'а, тронувшего этот файл — то есть «после» для кумулятивного диффа
 * нашего turn'а (правки следующих turn'ов в наш дифф не попадают).
 *
 * user_message_id != указанный — исключает строки этого же turn'а при ретраях
 * (ретрай переиспользует userMsg.id и пишет снапшоты с более поздним created_at).
 */
export function getLaterTurnSnapshots(chatId: string, userMessageId: string): FileSnapshotRow[] {
  const db = getDB()
  const cp = db.prepare(`
    SELECT created_at as createdAt FROM chat_checkpoints
    WHERE chat_id = ? AND user_message_id = ?
    ORDER BY created_at ASC LIMIT 1
  `).get(chatId, userMessageId) as { createdAt: number } | undefined
  if (!cp) return []
  return db.prepare(`
    SELECT path, content_before as contentBefore,
           user_message_id as userMessageId, created_at as createdAt
    FROM file_snapshots
    WHERE chat_id = ? AND created_at > ? AND user_message_id != ?
    ORDER BY created_at ASC, rowid ASC
  `).all(chatId, cp.createdAt, userMessageId) as FileSnapshotRow[]
}

export function getContextSnapshot(chatId: string, userMessageId: string): {
  workingMemory: string | null
  chatSummary: string | null
  messageCount: number | null
} | null {
  const row = getDB().prepare(`
    SELECT working_memory as workingMemory, chat_summary as chatSummary, message_count as messageCount
    FROM context_snapshots
    WHERE chat_id = ? AND user_message_id = ?
  `).get(chatId, userMessageId) as { workingMemory: string | null; chatSummary: string | null; messageCount: number | null } | undefined
  return row ?? null
}

/**
 * Удаляет все чекпоинты и снапшоты для turn'ов ПОСЛЕ указанного user_message_id
 * (не включая сам указанный). Используется при rewind: откатнутые turn'ы
 * больше не валидны, их метаданные чистим.
 */
export function deleteCheckpointsAfter(chatId: string, userMessageId: string): void {
  const db = getDB()
  // ORDER BY created_at ASC LIMIT 1 — как в getSnapshotsAfter: при дубликатах
  // (именованные снапшоты) берём самый ранний чекпоинт, чтобы удалить все
  // последующие turn'ы, а не только те, что после позднего дубликата.
  const cp = db.prepare(`
    SELECT created_at as createdAt FROM chat_checkpoints
    WHERE chat_id = ? AND user_message_id = ?
    ORDER BY created_at ASC LIMIT 1
  `).get(chatId, userMessageId) as { createdAt: number } | undefined
  if (!cp) return

  // Удаляем чекпоинты и снапшоты created_at > порога (строго больше — сам
  // указанный turn оставляем в истории, откатываются только последующие).
  db.prepare(`DELETE FROM chat_checkpoints WHERE chat_id = ? AND created_at > ?`).run(chatId, cp.createdAt)
  db.prepare(`DELETE FROM file_snapshots WHERE chat_id = ? AND created_at > ?`).run(chatId, cp.createdAt)
  db.prepare(`DELETE FROM context_snapshots WHERE chat_id = ? AND created_at > ?`).run(chatId, cp.createdAt)
}

/**
 * Ограничивает количество чекпоинтов в чате последними N turn'ами (по умолч.
 * 100, как Claude Code). Старые чекпоинты и их снапшоты удаляются.
 */
export function pruneOldCheckpoints(chatId: string, limit = 100): void {
  const db = getDB()
  const rows = db.prepare(`
    SELECT id, created_at as createdAt FROM chat_checkpoints
    WHERE chat_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(chatId, limit) as { id: string; createdAt: number }[]
  if (rows.length < limit) return

  // rows отсортированы DESC — последний элемент это самый старый из оставшихся.
  const oldestKeptCreatedAt = rows[rows.length - 1].createdAt
  db.prepare(`DELETE FROM chat_checkpoints WHERE chat_id = ? AND created_at < ?`).run(chatId, oldestKeptCreatedAt)
  db.prepare(`DELETE FROM file_snapshots WHERE chat_id = ? AND created_at < ?`).run(chatId, oldestKeptCreatedAt)
  db.prepare(`DELETE FROM context_snapshots WHERE chat_id = ? AND created_at < ?`).run(chatId, oldestKeptCreatedAt)
}

// === REWIND HISTORY (redo) ===
//
// При каждом rewind сохраняем "redo-точку": удалённые сообщения (serialized) +
// состояние файлов ДО отката (contentAfter — то что было на диске перед
// восстановлением contentBefore). Позволяет отменить откат — вернуть всё назад.

export interface RewindHistoryEntry {
  id: string
  chatId: string
  rewindMessageId: string
  deletedMessages: Message[]
  fileChanges: Array<{ path: string; contentAfter: string | null }>
  restoredCheckpointUserMsgId: string
  createdAt: number
}

export function saveRewindHistory(
  chatId: string,
  rewindMessageId: string,
  deletedMessages: Message[],
  fileChanges: Array<{ path: string; contentAfter: string | null }>,
  restoredCheckpointUserMsgId: string,
): void {
  getDB().prepare(`
    INSERT INTO rewind_history (id, chat_id, rewind_message_id, deleted_messages, file_changes, restored_checkpoint_user_msg_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(), chatId, rewindMessageId,
    JSON.stringify(deletedMessages),
    JSON.stringify(fileChanges),
    restoredCheckpointUserMsgId,
    Date.now(),
  )
}

export function getRewindHistory(chatId: string, rewindMessageId: string): RewindHistoryEntry | null {
  const row = getDB().prepare(`
    SELECT id, chat_id as chatId, rewind_message_id as rewindMessageId,
           deleted_messages as deletedMessagesJson, file_changes as fileChangesJson,
           restored_checkpoint_user_msg_id as restoredCheckpointUserMsgId,
           created_at as createdAt
    FROM rewind_history
    WHERE chat_id = ? AND rewind_message_id = ?
  `).get(chatId, rewindMessageId) as (Omit<RewindHistoryEntry, 'deletedMessages' | 'fileChanges'> & { deletedMessagesJson: string; fileChangesJson: string }) | undefined
  if (!row) return null
  return {
    id: row.id,
    chatId: row.chatId,
    rewindMessageId: row.rewindMessageId,
    deletedMessages: JSON.parse(row.deletedMessagesJson) as Message[],
    fileChanges: JSON.parse(row.fileChangesJson) as Array<{ path: string; contentAfter: string | null }>,
    restoredCheckpointUserMsgId: row.restoredCheckpointUserMsgId,
    createdAt: row.createdAt,
  }
}

export function deleteRewindHistory(chatId: string, rewindMessageId: string): void {
  getDB().prepare(`DELETE FROM rewind_history WHERE chat_id = ? AND rewind_message_id = ?`).run(chatId, rewindMessageId)
}
