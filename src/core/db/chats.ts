import type { Chat, Message, ChatMode } from '../../shared/types'
import { v4 as uuid } from 'uuid'
import { getDB } from './handle'
import { stripPlanTags } from '../../shared/planParser'
import { getMessages, saveMessage } from './messages'
import { getWorkingMemory, getChatSummary, setWorkingMemory, setChatSummary } from './memory'
import { deleteStreamingBuffersForChat } from './streamingBuffers'

// === CHATS ===

/** Дефолтный титул чата до генерации названия (см. autoNameChat в chat.ipc). */
export const DEFAULT_CHAT_TITLE = 'Новый чат'

export function createChat(
  isIncognito = false,
  mode: ChatMode = 'code',
  projectId?: string,
  opts?: { modelId?: string; modelProvider?: string; reasoningValue?: string },
): Chat {
  const db = getDB()
  const now = Date.now()
  // workdir на chats — денормализованный кэш из projects (для обратной
  // совместимости со старым кодом, читающим chats.workdir напрямую).
  let workdir: string | undefined
  if (projectId) {
    const p = db.prepare(`SELECT workdir FROM projects WHERE id = ?`).get(projectId) as { workdir: string } | undefined
    if (p) workdir = p.workdir
  }
  const chat: Chat = {
    id: uuid(),
    title: DEFAULT_CHAT_TITLE,
    createdAt: now,
    updatedAt: now,
    isIncognito: isIncognito ? 1 : 0,
    isPinned: 0,
    isArchived: 0,
    mode,
    workdir,
    projectId,
    modelId: opts?.modelId,
    modelProvider: opts?.modelProvider,
    reasoningValue: opts?.reasoningValue,
  }
  db.prepare(`
    INSERT INTO chats (id, title, created_at, updated_at, is_incognito, is_pinned, is_archived, mode, workdir, project_context, project_id, model_id, model_provider, reasoning_value)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, ?, ?, ?, ?)
  `).run(chat.id, chat.title, chat.createdAt, chat.updatedAt, chat.isIncognito, mode, workdir ?? null, projectId ?? null, opts?.modelId ?? null, opts?.modelProvider ?? null, opts?.reasoningValue ?? null)
  // Обновляем last_used проекта
  if (projectId) {
    db.prepare(`UPDATE projects SET last_used = ? WHERE id = ?`).run(now, projectId)
  }
  return chat
}

export function getAllChats(): Chat[] {
  return getDB().prepare(`
    SELECT c.id, c.title, c.created_at as createdAt, c.updated_at as updatedAt,
           c.is_incognito as isIncognito,
           c.is_pinned as isPinned,
           c.is_archived as isArchived,
           c.mode,
           c.color,
           c.workdir,
           c.project_id as projectId,
           c.model_id as modelId,
           c.model_provider as modelProvider,
           c.reasoning_value as reasoningValue,
           (SELECT m.content FROM messages m WHERE m.chat_id = c.id AND m.role != 'system' ORDER BY m.created_at DESC LIMIT 1) as lastMessage,
           (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) as messageCount
    FROM chats c WHERE c.is_incognito = 0
    ORDER BY c.is_pinned DESC, c.updated_at DESC
  `).all() as Chat[]
}

export function getChatMode(chatId: string): ChatMode {
  const row = getDB().prepare('SELECT mode FROM chats WHERE id = ?').get(chatId) as { mode: string } | undefined
  return (row?.mode as ChatMode) ?? 'code'
}

// ── Per-chat модель ─────────────────────────────────────────────────────────
// NULL = «использовать глобальное назначение role:'main'» (обратная
// совместимость: у всех чатов, созданных до этой фичи, модель не задана).

/** Модель чата или null, если чат использует глобальное назначение main. */
export function getChatModel(chatId: string): { modelId: string; modelProvider: string } | null {
  const row = getDB().prepare('SELECT model_id as modelId, model_provider as modelProvider FROM chats WHERE id = ?')
    .get(chatId) as { modelId: string | null; modelProvider: string | null } | undefined
  if (!row?.modelId || !row?.modelProvider) return null
  return { modelId: row.modelId, modelProvider: row.modelProvider }
}

/** Установка/сброс per-chat модели. null = вернуться к глобальному назначению. */
export function setChatModel(chatId: string, modelId: string | null, modelProvider: string | null): void {
  getDB().prepare('UPDATE chats SET model_id = ?, model_provider = ? WHERE id = ?')
    .run(modelId, modelProvider, chatId)
}

/** Per-chat уровень мышления: null = глобальный settings.reasoningValue. */
export function getChatReasoning(chatId: string): string | null {
  const row = getDB().prepare('SELECT reasoning_value as v FROM chats WHERE id = ?')
    .get(chatId) as { v: string | null } | undefined
  return row?.v ?? null
}

/** Установка/сброс per-chat уровня мышления. null = глобальная настройка. */
export function setChatReasoning(chatId: string, value: string | null): void {
  getDB().prepare('UPDATE chats SET reasoning_value = ? WHERE id = ?').run(value, chatId)
}

/**
 * Возвращает рабочую директорию чата и зафиксированный при создании
 * контекст проекта (результат analyzeProject). Источник правды — таблица
 * projects (JOIN через project_id). Если у чата нет project_id, но есть
 * денормализованный workdir (старые чаты до миграции) — используем его
 * как fallback. project_context НЕ выносится в shared Chat-тип — это
 * потенциально большой текстовый блок, который нужен только main-процессу.
 */
export function getChatWorkdirContext(chatId: string): { workdir?: string; projectContext?: string; verificationCommand?: string } {
  const row = getDB().prepare(`
    SELECT c.workdir as chatWorkdir, c.project_context as chatProjectContext,
           p.workdir as projWorkdir, p.project_context as projProjectContext,
           p.verification_command as verificationCommand
    FROM chats c
    LEFT JOIN projects p ON c.project_id = p.id
    WHERE c.id = ?
  `).get(chatId) as {
    chatWorkdir: string | null; chatProjectContext: string | null
    projWorkdir: string | null; projProjectContext: string | null
    verificationCommand: string | null
  } | undefined
  if (!row) return {}
  // Предпочитаем project (источник правды), fallback на denormalized chats.workdir
  const workdir = row.projWorkdir ?? row.chatWorkdir ?? undefined
  const projectContext = row.projProjectContext ?? row.chatProjectContext ?? undefined
  return { workdir, projectContext, verificationCommand: row.verificationCommand ?? undefined }
}

export function renameChat(id: string, title: string): void {
  getDB().prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, Date.now(), id)
}

export function deleteChat(id: string): void {
  const db = getDB()
  const now = Date.now()

  db.transaction(() => {
    // 1. Knowledge graph: удаляем orphan-узлы, ссылающиеся на сообщения этого чата.
    //    Граф не имеет FK на messages (source_id — текстовое поле без constraint),
    //    поэтому cascade не сработает — чистим вручную ДО удаления messages.
    db.prepare(
      `DELETE FROM memory_graph_nodes
       WHERE source_kind = 'message'
         AND source_id IN (SELECT id FROM messages WHERE chat_id = ?)`
    ).run(id)

    // 2. Knowledge graph: удаляем узлы, ссылающиеся на summary этого чата.
    db.prepare(
      `DELETE FROM memory_graph_nodes
       WHERE source_kind = 'chat_summary' AND source_id = ?`
    ).run(id)

    // 3. Knowledge graph: удаляем узлы, ссылающиеся на эпизодическую память
    //    этого чата (conversation items с key='chat_summary:<chatId>').
    //    Граф-узлы с source_kind='memory_item' и source_id = ID эпизодической записи.
    db.prepare(
      `DELETE FROM memory_graph_nodes
       WHERE source_kind = 'memory_item'
         AND source_id IN (
           SELECT id FROM memory_items
           WHERE kind = 'conversation' AND key = 'chat_summary:' || ?
         )`
    ).run(id)

    // 4. Удаляем эпизодическую память этого чата (итоги диалога).
    //    Long-term факты (user_fact, project_decision, convention, agent_outcome)
    //    СОХРАНЯЕМ — они переживают чат. Очищаем только chat_id (provenance-ссылку).
    db.prepare(
      `DELETE FROM memory_items
       WHERE kind = 'conversation' AND key = 'chat_summary:' || ?`
    ).run(id)

    // 5. Сохраняем long-term память: очищаем chat_id (чтобы CASCADE не удалил их).
    //    chat_id — это provenance (где факт был создан), не lifetime-ссылка.
    db.prepare(
      `UPDATE memory_items SET chat_id = NULL, updated_at = ?
       WHERE chat_id = ?`
    ).run(now, id)

    // 6. Удаляем сам чат — ON DELETE CASCADE заботится об:
    //    messages (→ messages_fts через триггер), pinned_messages, chat_summaries,
    //    agent_logs, checkpoints, file_snapshots, context_snapshots, rewind_history.
    //    streaming_buffers не имеет FK на chats (см. миграцию) — чистим вручную,
    //    чтобы краш-рекавери не воскресил сообщения удалённого чата.
    deleteStreamingBuffersForChat(id)
    db.prepare('DELETE FROM chats WHERE id = ?').run(id)
  })()
}

export function archiveChat(id: string, archived: boolean): void {
  getDB().prepare('UPDATE chats SET is_archived = ? WHERE id = ?').run(archived ? 1 : 0, id)
}

export function pinChat(id: string, pinned: boolean): void {
  getDB().prepare('UPDATE chats SET is_pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
}

export function setChatColor(id: string, color: string | null): void {
  getDB().prepare('UPDATE chats SET color = ? WHERE id = ?').run(color, id)
}

export function duplicateChat(id: string): Chat | null {
  const db = getDB()
  const src = db.prepare(`SELECT * FROM chats WHERE id = ?`).get(id) as Chat & { created_at: number; updated_at: number; is_incognito: number; workdir: string | null; project_context: string | null; project_id: string | null; mode: string } | undefined
  if (!src) return null
  const newId = uuid()
  const now = Date.now()
  // Копируем project_id — дубликат чата остаётся в том же проекте
  // и сохраняет привязку к рабочей директории. Модель (model_id/model_provider)
  // и уровень мышления (reasoning_value) тоже копируются.
  db.prepare(`INSERT INTO chats (id, title, created_at, updated_at, is_incognito, is_pinned, is_archived, color, mode, workdir, project_context, project_id, model_id, model_provider, reasoning_value) VALUES (?,?,?,?,?,0,0,?,?,?,?,?,?,?,?)`)
    .run(newId, src.title + ' (копия)', now, now, src.is_incognito ?? 0, (src as unknown as Record<string,unknown>).color ?? null, src.mode ?? 'code', src.workdir ?? null, src.project_context ?? null, src.project_id ?? null, (src as unknown as Record<string,unknown>).model_id ?? null, (src as unknown as Record<string,unknown>).model_provider ?? null, (src as unknown as Record<string,unknown>).reasoning_value ?? null)
  const msgs = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(id) as (Message & { chat_id: string; created_at: number; is_pinned: number; tool_steps?: string })[]
  for (const m of msgs) {
    const mid = uuid()
    db.prepare(`INSERT INTO messages (id, chat_id, role, content, created_at, is_pinned, model, tool_steps) VALUES (?,?,?,?,?,?,?,?)`)
      .run(mid, newId, m.role, m.content, m.created_at ?? m.createdAt, 0, m.model ?? null, m.tool_steps ?? null)
  }
  return getAllChats().find(c => c.id === newId) ?? null
}

export function exportChat(id: string, format: 'txt' | 'md'): string {
  const db = getDB()
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as { title: string } | undefined
  if (!chat) return ''
  const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(id) as { role: string; content: string; created_at: number }[]
  // Стрипаем <plan>-теги при экспорте — план сохраняется в отдельный .md-файл
  // (через savePlanToFile), а в экспорте чата должен быть чистый markdown.
  const cleanContent = (c: string) => (format === 'md' ? stripPlanTags(c) : stripPlanTags(c))
  if (format === 'md') {
    return `# ${chat.title}\n\n` + msgs.map(m => {
      const time = new Date(m.created_at).toLocaleString('ru')
      const role = m.role === 'user' ? '**Вы**' : '**Ассистент**'
      return `${role} _(${time})_\n\n${cleanContent(m.content)}`
    }).join('\n\n---\n\n')
  }
  return msgs.map(m => {
    const time = new Date(m.created_at).toLocaleString('ru')
    const role = m.role === 'user' ? 'Вы' : 'Ассистент'
    return `[${time}] ${role}:\n${cleanContent(m.content)}`
  }).join('\n\n')
}

export function touchChat(id: string): void {
  getDB().prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), id)
}

// === Per-chat UI state: режимы инпут-бара + черновик ===
// Хранятся в chats (см. миграции), переживают перезапуск. Для инкогнито
// эти функции не вызываются — guard на уровне рендерера (ChatPage).

export interface ChatModes {
  planningMode: boolean
  imageMode: boolean
  askMode: boolean
}

export function getChatModes(chatId: string): ChatModes {
  const row = getDB().prepare(
    'SELECT planning_mode as p, image_mode as i, ask_mode as a FROM chats WHERE id = ?'
  ).get(chatId) as { p: number; i: number; a: number } | undefined
  if (!row) return { planningMode: false, imageMode: false, askMode: false }
  return {
    planningMode: !!row.p,
    imageMode: !!row.i,
    askMode: !!row.a,
  }
}

export function setChatModes(chatId: string, modes: ChatModes): void {
  getDB().prepare(
    'UPDATE chats SET planning_mode = ?, image_mode = ?, ask_mode = ? WHERE id = ?'
  ).run(modes.planningMode ? 1 : 0, modes.imageMode ? 1 : 0, modes.askMode ? 1 : 0, chatId)
}

// Индивидуальные сеттеры — обновляют ОДНУ колонку, не затрагивая остальные.
// Устраняют кросс-контаминацию режимов при race condition (save-on-switch
// пишет stale ref'ы чужого режима в чужой чат). Режим пишется сразу при
// тумблинге — bulk-save-on-switch больше не нужен (удалён в ChatPage).
export function setChatPlanningMode(chatId: string, val: boolean): void {
  getDB().prepare('UPDATE chats SET planning_mode = ? WHERE id = ?').run(val ? 1 : 0, chatId)
}
export function setChatImageMode(chatId: string, val: boolean): void {
  getDB().prepare('UPDATE chats SET image_mode = ? WHERE id = ?').run(val ? 1 : 0, chatId)
}
export function setChatAskMode(chatId: string, val: boolean): void {
  getDB().prepare('UPDATE chats SET ask_mode = ? WHERE id = ?').run(val ? 1 : 0, chatId)
}

// === Persona — single-select run mode (classic/architect/debugger/...) ===
// Orthogonal to ChatModes (planning/image/ask toggles). Stored as TEXT in the
// persona column, 'classic' by default. Back-compat: missing column is added
// by a migration (DEFAULT 'classic'), so old rows read as 'classic'.
import { DEFAULT_PERSONA, isValidPersona, type PersonaId } from '../../shared/modes'

export function getChatPersona(chatId: string): PersonaId {
  const row = getDB().prepare('SELECT persona FROM chats WHERE id = ?').get(chatId) as { persona: string | null } | undefined
  if (!row) return DEFAULT_PERSONA
  return isValidPersona(row.persona) ? row.persona : DEFAULT_PERSONA
}

export function setChatPersona(chatId: string, persona: PersonaId): void {
  getDB().prepare('UPDATE chats SET persona = ? WHERE id = ?').run(persona, chatId)
}

export function getChatDraft(chatId: string): string {
  const row = getDB().prepare('SELECT draft FROM chats WHERE id = ?').get(chatId) as { draft: string | null } | undefined
  return row?.draft ?? ''
}

export function setChatDraft(chatId: string, draft: string): void {
  getDB().prepare('UPDATE chats SET draft = ? WHERE id = ?').run(draft, chatId)
}

// === Chat sharing (Phase 3) ================================================
// packChatForShare serializes a chat + messages + working memory + summary
// into a plain JSON object that can round-trip through the gateway and be
// re-imported by another SynteeHelper instance via importChatFromShare.
//
// Long-term memory (memory_items) is deliberately NOT included — it is
// global/project-scoped personal knowledge, not part of the conversation.

export interface ChatSnapshot {
  version: 1
  chat: {
    title: string
    mode: ChatMode
    createdAt: number
  }
  messages: Array<Message>
  workingMemory: string | null
  summary: string | null
}

export function packChatForShare(chatId: string): ChatSnapshot | null {
  const db = getDB()
  const row = db.prepare(
    'SELECT title, mode, created_at as createdAt FROM chats WHERE id = ?'
  ).get(chatId) as { title: string; mode: ChatMode; createdAt: number } | undefined
  if (!row) return null

  const messages = getMessages(chatId)
  const workingMemory = (() => { try { return getWorkingMemory(chatId) || null } catch { return null } })()
  const summary = (() => { try { return getChatSummary(chatId) || null } catch { return null } })()

  return {
    version: 1,
    chat: { title: row.title, mode: row.mode ?? 'code', createdAt: row.createdAt },
    messages,
    workingMemory,
    summary,
  }
}

export function importChatFromShare(snapshot: ChatSnapshot, titlePrefix?: string): { chatId: string; messages: Message[]; title: string } | { error: string } {
  try {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.messages)) {
      return { error: 'Неверный формат снапшота чата' }
    }
    const db = getDB()
    const newChat = createChat(false, snapshot.chat.mode ?? 'code', undefined)
    const title = (titlePrefix && titlePrefix.trim())
      ? titlePrefix.trim()
      : `${snapshot.chat.title || 'Импортированный чат'} (импорт)`
    renameChat(newChat.id, title)

    // Set created_at to the original to keep chronological intent.
    db.prepare('UPDATE chats SET created_at = ? WHERE id = ?').run(snapshot.chat.createdAt ?? Date.now(), newChat.id)

    for (const msg of snapshot.messages) {
      saveMessage({
        ...msg,
        id: uuid(),
        chatId: newChat.id,
      })
    }

    if (snapshot.workingMemory) {
      try { setWorkingMemory(newChat.id, snapshot.workingMemory) } catch { /* ok */ }
    }
    if (snapshot.summary) {
      try { setChatSummary(newChat.id, snapshot.summary) } catch { /* ok */ }
    }

    return {
      chatId: newChat.id,
      messages: getMessages(newChat.id),
      title,
    }
  } catch (e) {
    return { error: `Ошибка импорта: ${(e as Error).message}` }
  }
}

// ── Last real usage persistence ─────────────────────────────────────────────
// Сохраняем последний реальный usage от провайдера, чтобы context:calculate
// мог показать точный контекст после перезапуска приложения (tiktoken-оценка
// без этого занижает — не знает про tool schemas overhead, reasoning токены
// и т.д. — расхождение до 12k на простом диалоге).

export interface LastUsage {
  promptTokens: number
  completionTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  ts: number
}

export function setChatLastUsage(chatId: string, usage: LastUsage): void {
  try {
    getDB().prepare(`UPDATE chats SET last_usage = ? WHERE id = ?`)
      .run(JSON.stringify(usage), chatId)
  } catch { /* ok — колонки может не быть до миграции */ }
}

export function getChatLastUsage(chatId: string): LastUsage | null {
  try {
    const row = getDB().prepare(`SELECT last_usage as lastUsage FROM chats WHERE id = ?`).get(chatId) as { lastUsage?: string } | undefined
    if (!row?.lastUsage) return null
    return JSON.parse(row.lastUsage) as LastUsage
  } catch { /* ok */ }
  return null
}

/**
 * Сброс last_usage для чата — вызывается при compaction (auto/manual).
 * Без этого context:calculate пересобирает real-снапшот из устаревшего
 * promptTokens (до-сжатия), и индикатор контекста показывает старое
 * большое значение, хотя реальные сообщения уже сжаты.
 */
export function clearChatLastUsage(chatId: string): void {
  try {
    getDB().prepare(`UPDATE chats SET last_usage = NULL WHERE id = ?`).run(chatId)
  } catch { /* ok — колонки может не быть до миграции */ }
}

