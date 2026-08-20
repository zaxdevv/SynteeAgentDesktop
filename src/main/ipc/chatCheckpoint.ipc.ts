import { ipcMain, BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import { IPC_EVENTS } from '../../shared/constants'
import {
  getCheckpoints, getLastCheckpoint, getMessages, getSnapshotsForCheckpoint, getSnapshotsAfter,
  getContextSnapshot, setWorkingMemory, setChatSummary, deleteMessagesAfter, getMessageCount,
  deleteCheckpointsAfter, saveMessage, saveRewindHistory, getRewindHistory, deleteRewindHistory,
  deleteMessageById, getLastRewindMessage,
} from '../../core/db'
import { slimMessagesForUI } from './slimMessages'
import { activeRuns } from './chatShared'
import { log } from '../../core/logger'
import type { Message } from '../../shared/types'

export interface CheckpointIPCWindow {
  getWindow: () => BrowserWindow | null
}

// === CHECKPOINT / REWIND ===
export function registerCheckpointIPC(mainWindow: CheckpointIPCWindow): void {
  // Возвращает таймлайн всех чекпоинтов чата (для правой панели "Сессия").
  ipcMain.handle('chat:getSessionTimeline', (_, chatId: string) => {
    try { return getCheckpoints(chatId) } catch { return [] }
  })

  // Кол-во изменённых файлов в последнем turn'е — для badge-счётчика на иконке
  // правой панели в TitleBar.
  ipcMain.handle('chat:getLastTurnFilesChanged', (_, chatId: string) => {
    try { return getLastCheckpoint(chatId)?.filesChanged ?? 0 } catch { return 0 }
  })

  // ── Изменения последнего запроса (ChangesBadge над инпутом) ──────────────
  // Возвращает per-file added/deleted для последнего turn'а с правками.
  // Парсит toolSteps assistant-сообщения (diff-строки), агрегирует по path.
  ipcMain.handle('chat:getLastTurnChanges', (_, chatId: string) => {
    try {
      const cp = getLastCheckpoint(chatId)
      if (!cp || cp.filesChanged === 0 || !cp.assistantMessageId) return null
      const messages = getMessages(chatId) as Array<{
        id: string; toolSteps?: Array<{ type: string; diff?: string; toolName?: string; toolArgs?: Record<string, unknown> }>
      }>
      const assistantMsg = messages.find(m => m.id === cp.assistantMessageId)
      if (!assistantMsg?.toolSteps) return null

      const fileMap = new Map<string, { added: number; deleted: number }>()
      for (const step of assistantMsg.toolSteps) {
        if (step.type !== 'tool_result' || !step.diff) continue
        // Извлекаем path из +++ строки, fallback — toolArgs.path
        const pathMatch = step.diff.match(/^\+\+\+\s+(.+)$/m)
        let filePath = pathMatch?.[1]?.trim() ?? (step.toolArgs?.path as string | undefined)
        if (!filePath) continue
        // Считаем + и - строки (пропуская +++/--- заголовки)
        let added = 0, deleted = 0
        for (const line of step.diff.split('\n')) {
          if (line.startsWith('+++') || line.startsWith('---')) continue
          if (line.startsWith('+')) added++
          else if (line.startsWith('-')) deleted++
        }
        const existing = fileMap.get(filePath)
        if (existing) { existing.added += added; existing.deleted += deleted }
        else fileMap.set(filePath, { added, deleted })
      }
      if (fileMap.size === 0) return null
      const files = Array.from(fileMap.entries()).map(([path, v]) => ({ path, added: v.added, deleted: v.deleted }))
      const totalAdded = files.reduce((s, f) => s + f.added, 0)
      const totalDeleted = files.reduce((s, f) => s + f.deleted, 0)
      return {
        files, totalAdded, totalDeleted,
        userMessageId: cp.userMessageId,
        assistantMessageId: cp.assistantMessageId,
      }
    } catch { return null }
  })

  // ── Undo правок файлов последнего turn'а (БЕЗ удаления сообщений) ────────
  // Восстанавливает файлы из file_snapshots последнего checkpoint'а.
  // contentBefore = null → файл был создан → удаляем. Иначе → перезаписываем.
  ipcMain.handle('chat:undoLastTurnFiles', (_, chatId: string) => {
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа.' }
    }
    try {
      const cp = getLastCheckpoint(chatId)
      if (!cp || !cp.assistantMessageId) {
        return { error: 'Нет изменений для отмены.' }
      }
      const snapshots = getSnapshotsForCheckpoint(chatId, cp.userMessageId)
      if (snapshots.length === 0) {
        return { error: 'Снапшоты файлов не найдены.' }
      }
      const { writeFileSync, unlinkSync, existsSync, mkdirSync } = require('fs')
      const { dirname } = require('path')
      const restored: string[] = []
      const failed: string[] = []
      for (const snap of snapshots) {
        try {
          if (snap.contentBefore === null) {
            if (existsSync(snap.path)) {
              unlinkSync(snap.path)
              restored.push(snap.path)
            }
          } else {
            try { mkdirSync(dirname(snap.path), { recursive: true }) } catch { /* ok */ }
            writeFileSync(snap.path, snap.contentBefore, 'utf-8')
            restored.push(snap.path)
          }
        } catch (e) {
          failed.push(`${snap.path}: ${(e as Error).message}`)
        }
      }
      const win = BrowserWindow.getAllWindows()[0] ?? null
      win?.webContents.send(IPC_EVENTS.CHAT_FILES_RESTORED, { chatId })
      log('[chat:undoLastTurnFiles] chatId=%s restored=%d failed=%d', chatId, restored.length, failed.length)
      return { restored: restored.length, failed }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // ── Undo одного файла из последнего turn'а ──────────────────────────────
  // Восстанавливает один файл из file_snapshots последнего checkpoint'а.
  ipcMain.handle('chat:undoFile', (_, chatId: string, filePath: string) => {
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа.' }
    }
    try {
      const cp = getLastCheckpoint(chatId)
      if (!cp || !cp.assistantMessageId) {
        return { error: 'Нет изменений для отмены.' }
      }
      const snapshots = getSnapshotsForCheckpoint(chatId, cp.userMessageId)
      const snap = snapshots.find(s => s.path === filePath)
      if (!snap) {
        return { error: 'Файл не найден в снапшотах этого turn\'а.' }
      }
      const { writeFileSync, unlinkSync, existsSync, mkdirSync } = require('fs')
      const { dirname } = require('path')
      if (snap.contentBefore === null) {
        if (existsSync(snap.path)) unlinkSync(snap.path)
      } else {
        try { mkdirSync(dirname(snap.path), { recursive: true }) } catch { /* ok */ }
        writeFileSync(snap.path, snap.contentBefore, 'utf-8')
      }
      const win = BrowserWindow.getAllWindows()[0] ?? null
      win?.webContents.send(IPC_EVENTS.CHAT_FILES_RESTORED, { chatId })
      log('[chat:undoFile] chatId=%s path=%s', chatId, filePath)
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  /**
   * Откат сессии к указанному user-сообщению.
   *
   * Семантика: "вернуться к состоянию ПОСЛЕ этого turn'а" — user+assistant
   * пара этого turn'а остаётся последними сообщениями, удаляется только всё
   * что было позже. Файлы откатываются к концу этого turn'а (отменяются
   * только правки последующих turn'ов). Контекст (working_memory, summary)
   * восстанавливается из snapshot'а этого turn'а.
   *
   * Возвращает обновлённый массив сообщений чата (для обновления store в
   * renderer) или { error } если откат невозможен.
   */
  ipcMain.handle('chat:rewindTo', async (_, chatId: string, userMessageId: string) => {
    // Блокировка: нельзя откатывать пока чат активен (воркер работает).
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа перед откатом.' }
    }

    try {
      // 1. Находим checkpoint для указанного user-сообщения.
      const checkpoints = getCheckpoints(chatId)
      const cp = checkpoints.find(c => c.userMessageId === userMessageId)
      log('[chat:rewindTo] chatId=%s userMsgId=%s — checkpoints total=%d, found=%s, assistantMsgId=%s, createdAt=%d',
        chatId, userMessageId, checkpoints.length, !!cp, cp?.assistantMessageId ?? 'null', cp?.createdAt ?? 0)
      if (!cp) {
        return { error: 'Чекпоинт для этого сообщения не найден (возможно, оно было до включения фичи отката).' }
      }

      // 2. Получаем file_snapshots всех turn'ов ПОСЛЕ указанного.
      const snapshots = getSnapshotsAfter(chatId, userMessageId)
      log('[chat:rewindTo] snapshots after checkpoint: %d', snapshots.length)

      // REDO: сохраняем текущее состояние файлов (contentAfter) до отката —
      // чтобы при отмене отката вернуть файлы обратно.
      const { readFileSync, existsSync: pathExistsBefore } = require('fs') // require: нативный import() не работает в V8-байткоде
      const fileChangesForRedo: Array<{ path: string; contentAfter: string | null }> = []
      const seenPaths = new Set<string>()
      for (const snap of snapshots) {
        if (seenPaths.has(snap.path)) continue
        seenPaths.add(snap.path)
        try {
          if (pathExistsBefore(snap.path)) {
            fileChangesForRedo.push({ path: snap.path, contentAfter: readFileSync(snap.path, 'utf-8') })
          } else {
            fileChangesForRedo.push({ path: snap.path, contentAfter: null })
          }
        } catch {
          fileChangesForRedo.push({ path: snap.path, contentAfter: null })
        }
      }

      // 3. Восстанавливаем файлы в обратном порядке (последняя правка первой).
      //    contentBefore = null → файл был создан later-turn'ом → удаляем.
      //    Иначе → перезаписываем contentBefore.
      const { writeFileSync, unlinkSync, existsSync: pathExists } = require('fs') // require: нативный import() не работает в V8-байткоде
      const restoredFiles: string[] = []
      const failedFiles: string[] = []
      for (const snap of snapshots) {
        try {
          if (snap.contentBefore === null) {
            // Файл был создан последующим turn'ом — удаляем.
            if (pathExists(snap.path)) {
              unlinkSync(snap.path)
              restoredFiles.push(`удалён: ${snap.path}`)
            }
          } else {
            // Перезаписываем содержимое до правки последующего turn'а.
            const { dirname } = require('path') // require: нативный import() не работает в V8-байткоде
            const { mkdirSync } = require('fs')
            try { mkdirSync(dirname(snap.path), { recursive: true }) } catch { /* ok */ }
            writeFileSync(snap.path, snap.contentBefore, 'utf-8')
            restoredFiles.push(`восстановлен: ${snap.path}`)
          }
        } catch (e) {
          failedFiles.push(`${snap.path}: ${(e as Error).message}`)
        }
      }

      // 4. Восстанавливаем контекст (working_memory + chat_summary) из
      //    snapshot'а этого turn'а (post-turn состояние).
      const ctxSnap = getContextSnapshot(chatId, userMessageId)
      if (ctxSnap) {
        if (ctxSnap.workingMemory !== null) setWorkingMemory(chatId, ctxSnap.workingMemory)
        if (ctxSnap.chatSummary !== null) setChatSummary(chatId, ctxSnap.chatSummary)
      }

      // 5. Удаляем сообщения после этого turn'а.
      //    Порог — createdAt assistant-сообщения этого turn'а (если найдено),
      //    иначе createdAt самого checkpoint'а (чуть позже, но до следующего turn'а).
      let deleteThreshold = cp.createdAt
      let allMsgsBeforeDelete: Message[] = []
      if (cp.assistantMessageId) {
        allMsgsBeforeDelete = getMessages(chatId)
        const assistantMsg = allMsgsBeforeDelete.find(m => m.id === cp.assistantMessageId)
        if (assistantMsg) {
          deleteThreshold = assistantMsg.createdAt
          log('[chat:rewindTo] found assistant msg: id=%s createdAt=%d', assistantMsg.id, assistantMsg.createdAt)
        } else {
          log('[chat:rewindTo] assistant msg NOT FOUND in getMessages — using checkpoint createdAt=%d as threshold', cp.createdAt)
        }
      } else {
        allMsgsBeforeDelete = getMessages(chatId)
        log('[chat:rewindTo] assistantMessageId is null — using checkpoint createdAt=%d as threshold', cp.createdAt)
      }

      // REDO: сохраняем сообщения которые будут удалены (до удаления).
      const msgsToDeleteForRedo = allMsgsBeforeDelete.filter(m => m.createdAt > deleteThreshold)

      const msgsBeforeDelete = getMessageCount(chatId)
      const deletedMessages = deleteMessagesAfter(chatId, deleteThreshold)
      log('[chat:rewindTo] messages before=%d, deleted=%d (threshold=%d)', msgsBeforeDelete, deletedMessages, deleteThreshold)

      // 6. Удаляем чекпоинты и снапшоты последующих turn'ов (они больше не валидны).
      deleteCheckpointsAfter(chatId, userMessageId)

      // 7. Вставляем синтетическое system-сообщение об откате.
      const rewindMsg: Message = {
        id: uuid(),
        chatId,
        role: 'system',
        content: `[ОТКАТ к сообщению от ${new Date(cp.createdAt).toLocaleString('ru')}]\n` +
          `Восстановлено файлов: ${restoredFiles.length}` +
          (failedFiles.length > 0 ? `, не удалось: ${failedFiles.length}` : '') + '\n' +
          `Удалено сообщений: ${deletedMessages}\n` +
          (restoredFiles.length > 0 ? `Файлы:\n${restoredFiles.join('\n')}` : 'Файлы не изменялись.') +
          (failedFiles.length > 0 ? `\nОшибки восстановления:\n${failedFiles.join('\n')}` : ''),
        createdAt: Date.now(),
        isPinned: 0,
        slashCommand: { name: 'rewind', args: userMessageId },
      }
      saveMessage(rewindMsg)

      // REDO: сохраняем redo-точку — можно отменить откат.
      try {
        saveRewindHistory(chatId, rewindMsg.id, msgsToDeleteForRedo, fileChangesForRedo, userMessageId)
        log('[chat:rewindTo] redo history saved: rewindMsgId=%s, msgsToRestore=%d, filesToRestore=%d',
          rewindMsg.id, msgsToDeleteForRedo.length, fileChangesForRedo.length)
      } catch (e) {
        log('[chat:rewindTo] redo history save FAILED: %s', (e as Error).message)
      }

      // 8. Уведомляем UI об откате.
      const rewindWin = mainWindow.getWindow()
      rewindWin?.webContents.send(IPC_EVENTS.CHAT_REWOUND, { chatId, userMessageId, rewindMessageId: rewindMsg.id })

      log('[chat:rewindTo] chatId=%s userMsgId=%s: restored %d files, deleted %d messages',
        chatId, userMessageId, restoredFiles.length, deletedMessages)

      // 9. Возвращаем обновлённые сообщения для renderer (slim-копии).
      return { messages: slimMessagesForUI(getMessages(chatId)) }
    } catch (e) {
      log('[chat:rewindTo] error chatId=%s: %s', chatId, (e as Error).message)
      return { error: `Ошибка отката: ${(e as Error).message}` }
    }
  })

  // ── Undo правок файлов любого checkpoint'а (правая панель «Сессия») ──────
  // Восстанавливает файлы из file_snapshots указанного turn'а (по userMessageId).
  ipcMain.handle('chat:undoCheckpointFiles', (_, chatId: string, userMessageId: string) => {
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа.' }
    }
    try {
      const snapshots = getSnapshotsForCheckpoint(chatId, userMessageId)
      if (snapshots.length === 0) {
        return { error: 'Снапшоты файлов не найдены.' }
      }
      const { writeFileSync, unlinkSync, existsSync, mkdirSync } = require('fs')
      const { dirname } = require('path')
      const restored: string[] = []
      const failed: string[] = []
      for (const snap of snapshots) {
        try {
          if (snap.contentBefore === null) {
            if (existsSync(snap.path)) {
              unlinkSync(snap.path)
              restored.push(snap.path)
            }
          } else {
            try { mkdirSync(dirname(snap.path), { recursive: true }) } catch { /* ok */ }
            writeFileSync(snap.path, snap.contentBefore, 'utf-8')
            restored.push(snap.path)
          }
        } catch (e) {
          failed.push(`${snap.path}: ${(e as Error).message}`)
        }
      }
      const win = BrowserWindow.getAllWindows()[0] ?? null
      win?.webContents.send(IPC_EVENTS.CHAT_FILES_RESTORED, { chatId })
      log('[chat:undoCheckpointFiles] chatId=%s userMsgId=%s restored=%d failed=%d',
        chatId, userMessageId, restored.length, failed.length)
      return { restored: restored.length, failed }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // ── Undo одного файла указанного checkpoint'а ───────────────────────────
  ipcMain.handle('chat:undoCheckpointFile', (_, chatId: string, userMessageId: string, filePath: string) => {
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа.' }
    }
    try {
      const snapshots = getSnapshotsForCheckpoint(chatId, userMessageId)
      const snap = snapshots.find(s => s.path === filePath)
      if (!snap) {
        return { error: 'Файл не найден в снапшотах этого turn\'а.' }
      }
      const { writeFileSync, unlinkSync, existsSync, mkdirSync } = require('fs')
      const { dirname } = require('path')
      if (snap.contentBefore === null) {
        if (existsSync(snap.path)) unlinkSync(snap.path)
      } else {
        try { mkdirSync(dirname(snap.path), { recursive: true }) } catch { /* ok */ }
        writeFileSync(snap.path, snap.contentBefore, 'utf-8')
      }
      const win = BrowserWindow.getAllWindows()[0] ?? null
      win?.webContents.send(IPC_EVENTS.CHAT_FILES_RESTORED, { chatId })
      log('[chat:undoCheckpointFile] chatId=%s userMsgId=%s path=%s', chatId, userMessageId, filePath)
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  // ── Последнее rewind-сообщение (для redo-баннера в панели «Сессия») ────
  ipcMain.handle('chat:getLastRewind', (_, chatId: string) => {
    try {
      const row = getLastRewindMessage(chatId)
      if (!row) return null
      return { rewindMessageId: row.id, createdAt: row.createdAt }
    } catch {
      return null
    }
  })

  /**
   * Проверяет, доступна ли отмена отката для данного system-сообщения.
   * Возвращает true если в rewind_history есть запись с этим rewindMessageId.
   */
  ipcMain.handle('chat:canRedo', (_, chatId: string, rewindMessageId: string) => {
    try {
      return getRewindHistory(chatId, rewindMessageId) !== null
    } catch {
      return false
    }
  })

  /**
   * Отмена отката (redo) — возвращает сообщения и файлы, удалённые при rewind.
   * Принимает id system-сообщения отката (rewindMessageId) — по нему находим
   * redo-точку в rewind_history.
   */
  ipcMain.handle('chat:redo', async (_, chatId: string, rewindMessageId: string) => {
    if (activeRuns.has(chatId)) {
      return { error: 'Чат активен — дождитесь завершения ответа.' }
    }

    try {
      const entry = getRewindHistory(chatId, rewindMessageId)
      if (!entry) {
        return { error: 'Точка отката не найдена — возможно, она уже отменена или устарела.' }
      }

      log('[chat:redo] chatId=%s rewindMsgId=%s — msgsToRestore=%d, filesToRestore=%d',
        chatId, rewindMessageId, entry.deletedMessages.length, entry.fileChanges.length)

      // 1. Восстанавливаем файлы — пишем contentAfter (состояние до отката).
      const { writeFileSync, unlinkSync, existsSync: pathExists, mkdirSync } = require('fs') // require: нативный import() не работает в V8-байткоде
      const { dirname } = require('path')
      const restoredFiles: string[] = []
      const failedFiles: string[] = []
      for (const fc of entry.fileChanges) {
        try {
          if (fc.contentAfter === null) {
            // Файла не было до отката (был создан, потом удалён при rewind) → удаляем.
            if (pathExists(fc.path)) {
              unlinkSync(fc.path)
              restoredFiles.push(`удалён: ${fc.path}`)
            }
          } else {
            // Возвращаем содержимое которое было до отката.
            try { mkdirSync(dirname(fc.path), { recursive: true }) } catch { /* ok */ }
            writeFileSync(fc.path, fc.contentAfter, 'utf-8')
            restoredFiles.push(`восстановлен: ${fc.path}`)
          }
        } catch (e) {
          failedFiles.push(`${fc.path}: ${(e as Error).message}`)
        }
      }

      // 2. Удаляем system-сообщение об откате (оно больше не актуально).
      deleteMessageById(rewindMessageId)

      // 3. Восстанавливаем удалённые сообщения.
      for (const msg of entry.deletedMessages) {
        try { saveMessage(msg) } catch { /* может существовать — ok */ }
      }

      // 4. Удаляем redo-точку (одноразовая).
      deleteRewindHistory(chatId, rewindMessageId)

      // 5. Уведомляем UI.
      const redoWin = mainWindow.getWindow()
      redoWin?.webContents.send(IPC_EVENTS.CHAT_REWOUND, { chatId, userMessageId: entry.restoredCheckpointUserMsgId, isRedo: true })

      log('[chat:redo] done: restored %d files, %d messages', restoredFiles.length, entry.deletedMessages.length)

      return { messages: slimMessagesForUI(getMessages(chatId)) }
    } catch (e) {
      log('[chat:redo] error chatId=%s: %s', chatId, (e as Error).message)
      return { error: `Ошибка отмены отката: ${(e as Error).message}` }
    }
  })
}
