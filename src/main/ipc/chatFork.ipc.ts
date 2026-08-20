import { ipcMain } from 'electron'
import { v4 as uuid } from 'uuid'
import {
  getMessages, getAllChats, createChat, renameChat, saveMessage,
  getWorkingMemory, setWorkingMemory, getChatSummary, setChatSummary,
  saveNamedSnapshot, getNamedSnapshots,
} from '../../core/db'
import { searchAllSources } from '../../core/memory/MemoryStore'
import { slimMessagesForUI } from './slimMessages'
import { activeRuns } from './chatShared'
import { log } from '../../core/logger'
import type { Message } from '../../shared/types'

// === /fork — дублировать чат с этого места ==================================
//
// Создаёт новый чат, копируя ВСЁ содержимое текущего: сообщения, working
// memory, summary, project_id, workdir, mode. Пользователь получает точную
// копию чата на текущий момент и может идти в другом направлении ("what-if"
// эксперименты без потери оригинала).
//
// Возвращает { chatId, messages } нового чата (или { error }).
export function registerForkIPC(): void {
  ipcMain.handle('chat:fork', async (_, sourceChatId: string, title?: string) => {
    try {
      const sourceMessages = getMessages(sourceChatId)
      if (sourceMessages.length === 0) {
        return { error: 'Исходный чат пуст — нечего форкать.' }
      }

      // Читаем метаданные исходного чата
      const sourceChat = getAllChats().find(c => c.id === sourceChatId)
      if (!sourceChat) {
        return { error: 'Исходный чат не найден.' }
      }

      // Создаём новый чат с теми же параметрами (не инкогнито, тот же режим/проект)
      const forkedChat = createChat(false, sourceChat.mode, sourceChat.projectId)
      const forkedChatId = forkedChat.id
      const forkTitle = (title && title.trim()) || `${sourceChat.title} (fork)`
      renameChat(forkedChatId, forkTitle)

      // Копируем сообщения. saveMessage проставит новый chatId — но чтобы
      // сохранить порядок и структуру, копируем как есть с новыми id.
      // createdAt сохраняем оригинальные — порядок в БД (ORDER BY created_at)
      // остаётся тем же. toolSteps/iterations/thinking/todo/slashCommand тоже
      // копируем (serialized через JSON в saveMessage).
      for (const msg of sourceMessages) {
        const newMsg: Message = {
          ...msg,
          id: uuid(), // новый id, чтобы не было PK-конфликта
          chatId: forkedChatId,
        }
        saveMessage(newMsg)
      }

      // Копируем working memory и summary
      try {
        const wm = getWorkingMemory(sourceChatId)
        if (wm) setWorkingMemory(forkedChatId, wm)
      } catch { /* ok */ }
      try {
        const summary = getChatSummary(sourceChatId)
        if (summary) setChatSummary(forkedChatId, summary)
      } catch { /* ok */ }

      log('[chat:fork] source=%s → forked=%s, messages=%d, title=%s',
        sourceChatId, forkedChatId, sourceMessages.length, forkTitle)

      return {
        chatId: forkedChatId,
        messages: slimMessagesForUI(getMessages(forkedChatId)),
        title: forkTitle,
      }
    } catch (e) {
      log('[chat:fork] error source=%s: %s', sourceChatId, (e as Error).message)
      return { error: `Ошибка форка: ${(e as Error).message}` }
    }
  })

  // === /snapshot <name> — именованный снапшот =================================
  //
  // Создаёт именованную точку отката на основе последнего чекпоинта чата.
  // Именованные снапшоты восстанавливаются через /restore <name> или /restore
  // (с пикером). В отличие от обычных auto-checkpoint'ов на каждый turn,
  // именованные явно создаются пользователем и имеют осмысленное имя.
  //
  // Возвращает { snapshot } (с id, name, createdAt) или { error }.
  ipcMain.handle('chat:snapshot:create', (_, chatId: string, name: string) => {
    try {
      if (activeRuns.has(chatId)) {
        return { error: 'Чат активен — дождитесь завершения ответа перед снапшотом.' }
      }
      const cleanName = (name || '').trim()
      if (!cleanName) {
        return { error: 'Укажите имя снапшота: /snapshot my-feature' }
      }
      if (cleanName.length > 80) {
        return { error: 'Имя снапшота слишком длинное (макс. 80 символов).' }
      }
      const snap = saveNamedSnapshot(chatId, cleanName)
      if (!snap) {
        return { error: 'В чате ещё нет точек отката — отправьте хотя бы одно сообщение перед снапшотом.' }
      }
      log('[chat:snapshot:create] chatId=%s name=%s id=%s', chatId, cleanName, snap.id)
      return { snapshot: snap }
    } catch (e) {
      log('[chat:snapshot:create] error chatId=%s: %s', chatId, (e as Error).message)
      return { error: `Ошибка создания снапшота: ${(e as Error).message}` }
    }
  })

  // === /restore — список именованных снапшотов для пикера ====================
  //
  // Возвращает массив именованных снапшотов чата (новые первыми) для UI-пикера.
  // Само восстановление идёт через существующий chat:rewindTo (по userMessageId).
  ipcMain.handle('chat:snapshot:list', (_, chatId: string) => {
    try {
      return getNamedSnapshots(chatId)
    } catch (e) {
      log('[chat:snapshot:list] error chatId=%s: %s', chatId, (e as Error).message)
      return []
    }
  })

  // ── Multi-source history search for Spotlight ─────────────────────────
  // Объединяет messages / chat_summaries / agent_logs / pinned / memory_items
  // через searchAllSources (FTS5 + LIKE + TF-IDF). Используется Spotlight-окном
  // для поиска по истории чатов. projectId не передаётся — поиск глобальный.
  ipcMain.handle('chat:searchHistory', async (_, params: { query: string; limit?: number }) => {
    const q = (params.query ?? '').trim()
    if (!q) return []
    try {
      return await searchAllSources({ query: q, limit: params.limit ?? 12 })
    } catch (e) {
      log('[chat:searchHistory] error: %s', (e as Error).message)
      return []
    }
  })
}
