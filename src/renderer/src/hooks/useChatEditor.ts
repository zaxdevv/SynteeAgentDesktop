import { useCallback, useMemo, useState } from 'react'
import { useChatStore } from '../store/chat.store'
import type { Message } from '@shared/types/chat'

/**
 * ── Редактор чата: общий хук для ChatPage и SplitChatPane ──────────────────
 *
 * Режим inline-правки сообщений привязан к chatId (editorChatId в chat.store).
 * Черновики (content/hidden/deleted по messageId) живут только в сторе —
 * в БД ничего не пишется до apply(). «Закрыл редактор — всё применилось»:
 * apply прогоняет черновики через IPC (editMessage / setMessageHidden /
 * deleteMessage), затем перезагружает окно сообщений чата из БД.
 */
export function useChatEditor(chatId: string | null | undefined) {
  const editorMode = useChatStore(s => !!s.editorChatId && s.editorChatId === chatId)
  const drafts = useChatStore(s => (s.editorChatId === chatId ? s.editorDrafts : undefined))
  const discardEditorDrafts = useChatStore(s => s.discardEditorDrafts)
  const [applying, setApplying] = useState(false)

  // Разбивка черновиков по типам — для плашки режима (чипсы ✎/👁/🗑).
  const { draftsCount, editsCount, hiddenCount, deletedCount } = useMemo(() => {
    if (!drafts) return { draftsCount: 0, editsCount: 0, hiddenCount: 0, deletedCount: 0 }
    let edits = 0, hidden = 0, deleted = 0
    for (const d of Object.values(drafts)) {
      if (d.deleted) { deleted++; continue }
      if (d.content !== undefined || d.iterTexts !== undefined) edits++
      if (d.hidden) hidden++
    }
    return { draftsCount: edits + hidden + deleted, editsCount: edits, hiddenCount: hidden, deletedCount: deleted }
  }, [drafts])

  const apply = useCallback(async () => {
    const cid = useChatStore.getState().editorChatId
    if (!cid) { discardEditorDrafts(); return }
    setApplying(true)
    try {
      const drafts = useChatStore.getState().editorDrafts
      // Текущее окно сообщений чата — из LRU-кеша (актуален и для основного
      // чата, и для сплита: setMessagesWindow обновляет оба).
      const currentMsgs = useChatStore.getState().messagesByChat[cid]?.messages ?? []
      for (const [messageId, d] of Object.entries(drafts)) {
        // Удалённые — только delete; правки/скрытие для них не имеют смысла.
        if (d.deleted) {
          await window.syntee.chat.deleteMessage(messageId)
          continue
        }
        if (d.iterTexts !== undefined) {
          // Сообщение с тулами: сегментная правка textBefore по итерациям.
          // Мерж в ПОЛНУЮ запись — в main (renderer держит slim-копию,
          // урезанные tool-пейлоады нельзя писать назад). No-op (ничего не
          // меняли) пропускаем.
          const origIters = currentMsgs.find(m => m.id === messageId)?.iterations ?? []
          const changed = d.iterTexts.some((t, i) => i < origIters.length && t !== (origIters[i].textBefore ?? ''))
          if (changed) await window.syntee.chat.editMessage(messageId, d.content ?? '', d.iterTexts)
        } else if (d.content !== undefined) {
          // Простое сообщение: правка content. Пропускаем no-op (открыл
          // textarea, ничего не менял).
          const orig = currentMsgs.find(m => m.id === messageId)?.content
          if (d.content !== orig) await window.syntee.chat.editMessage(messageId, d.content)
        }
        if (d.hidden !== undefined) await window.syntee.chat.setMessageHidden(messageId, d.hidden)
      }
      // Перезагрузка окна сообщений — подтянуть content/hiddenFromContext из БД.
      try {
        const res = await window.syntee.chat.getMessagesPage(cid, 50) as { messages: Message[]; hasMore: boolean }
        useChatStore.getState().setMessagesWindow(cid, res.messages, res.hasMore)
      } catch { /* окно осталось старым — не критично */ }
    } finally {
      setApplying(false)
      discardEditorDrafts()
    }
  }, [discardEditorDrafts])

  return { editorMode, draftsCount, editsCount, hiddenCount, deletedCount, applying, apply, discard: discardEditorDrafts }
}
