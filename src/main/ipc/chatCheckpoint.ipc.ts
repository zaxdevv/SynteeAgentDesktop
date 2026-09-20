import { ipcMain, BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import { IPC_EVENTS } from '../../shared/constants'
import {
  getCheckpoints, getLastCheckpoint, getMessages, getSnapshotsForCheckpoint, getSnapshotsAfter,
  getContextSnapshot, setWorkingMemory, setChatSummary, deleteMessagesAfter, getMessageCount,
  deleteCheckpointsAfter, saveMessage, saveRewindHistory, getRewindHistory, deleteRewindHistory,
  deleteMessageById, getLastRewindMessage, getChatWorkdirContext,
  getTurnSnapshotsOrdered, getLaterTurnSnapshots, type FileSnapshotRow,
} from '../../core/db'
import { resolveSnapshotPath } from '../../core/db/snapshotPaths'
import { makeDiff, normalizeLineEndings } from '../../core/tools/_shared'
import { slimMessagesForUI } from './slimMessages'
import { activeRuns } from './chatShared'
import { log } from '../../core/logger'
import type { Message } from '../../shared/types'

export interface CheckpointIPCWindow {
  getWindow: () => BrowserWindow | null
}

// ── Резолв пути снапшота против workdir чата ────────────────────────────────
// file_snapshots исторически (до фикса §rollback) хранили сырой путь из
// аргументов тула — часто ОТНОСИТЕЛЬНЫЙ («src/foo.ts»). Файловые операции
// (writeFileSync/unlinkSync/existsSync) в main-процессе резолвят такой путь
// против process.cwd() — папки установки приложения, а не папки проекта чата.
// Из-за этого откат «проходил» (сообщение об откате писалось), а реальные
// файлы в проекте не менялись. Чистая логика — core/db/snapshotPaths.ts.
function chatSnapshotPath(chatId: string, p: string): string {
  let workdir: string | undefined
  try { workdir = getChatWorkdirContext(chatId).workdir } catch { /* нет чата/БД — fallback на cwd */ }
  return resolveSnapshotPath(p, workdir)
}

// ── Кумулятивный дифф turn'а (как в Claude Code/Cursor) ────────────────────
// Один файл = ОДИН дифф за весь запрос: original = содержимое до ПЕРВОЙ
// правки файла в этом turn'е, modified = состояние ПОСЛЕ последней правки.
// Раньше панель «Сессия» склеивала per-edit диффы из toolSteps и при
// нескольких edit_file одного файла показывала только последнюю правку.
//
// Источники:
//   «до»    — file_snapshots этого turn'а, первая строка по пути (rowid ASC,
//             порядок правок; undoStack пишет запись на каждую правку).
//   «после» — первый снапшот СЛЕДУЮЩЕГО turn'а, тронувшего этот файл
//             (его contentBefore = состояние на конец нашего turn'а), иначе —
//             текущий файл на диске (последний turn, тронувший файл).
export interface CheckpointFileDiff {
  filePath: string
  original: string
  modified: string
  added: number
  deleted: number
}

function computeCheckpointFileDiffs(chatId: string, userMessageId: string): CheckpointFileDiff[] {
  const turnSnaps = getTurnSnapshotsOrdered(chatId, userMessageId)
  if (turnSnaps.length === 0) return []

  // «до»: первая запись по резолвнутому пути (матчинг относительных/абсолютных
  // путей старых и новых снапшотов — через резолв против workdir чата).
  const beforeByPath = new Map<string, FileSnapshotRow>()
  for (const s of turnSnaps) {
    const key = chatSnapshotPath(chatId, s.path)
    if (!beforeByPath.has(key)) beforeByPath.set(key, s)
  }

  // «после»: первый снапшот последующего turn'а по тому же резолвнутому пути.
  const afterByPath = new Map<string, FileSnapshotRow>()
  for (const s of getLaterTurnSnapshots(chatId, userMessageId)) {
    const key = chatSnapshotPath(chatId, s.path)
    if (!afterByPath.has(key)) afterByPath.set(key, s)
  }

  const { readFileSync, existsSync } = require('fs') // require: нативный import() не работает в V8-байткоде
  const result: CheckpointFileDiff[] = []
  for (const [key, snap] of beforeByPath) {
    const before = snap.contentBefore ?? ''
    let after: string
    const later = afterByPath.get(key)
    if (later) {
      // Следующий turn уже трогал файл: его contentBefore = наш «после».
      // null = файла не было к началу следующего turn'а (удалён после нашего).
      after = later.contentBefore ?? ''
    } else if (existsSync(key)) {
      try { after = readFileSync(key, 'utf-8') } catch { after = before }
    } else {
      after = '' // файл удалён после этого turn'а (вне чекпоинтов)
    }

    // Нормализуем CRLF→LF: снапшот и диск могут отличаться концами строк —
    // Monaco DiffEditor покажет phantom-дифф на каждой строке.
    const original = normalizeLineEndings(before)
    const modified = normalizeLineEndings(after)

    // added/deleted считаем из unified diff (LCS, как git) — это честный
    // кумулятивный счётчик, а не сумма per-edit счётчиков (строка, правленная
    // дважды за запрос, считалась дважды).
    const diff = makeDiff(before, after, snap.path)
    let added = 0
    let deleted = 0
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) deleted++
    }
    result.push({ filePath: snap.path, original, modified, added, deleted })
  }
  return result
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
  // КУМУЛЯТИВНО из file_snapshots (как Claude Code): diff «до первой правки →
  // после последней». Строка, правленная дважды за запрос, считается один раз.
  // Fallback для старых turn'ов без снапшотов — парсинг step-диффов (сумма).
  ipcMain.handle('chat:getLastTurnChanges', (_, chatId: string) => {
    try {
      const cp = getLastCheckpoint(chatId)
      if (!cp || cp.filesChanged === 0 || !cp.assistantMessageId) return null

      // ── Основной путь: кумулятивный дифф из снапшотов ──
      const diffs = computeCheckpointFileDiffs(chatId, cp.userMessageId)
      if (diffs.length > 0) {
        const files = diffs.map(d => ({ path: d.filePath, added: d.added, deleted: d.deleted }))
        return {
          files,
          totalAdded: files.reduce((s, f) => s + f.added, 0),
          totalDeleted: files.reduce((s, f) => s + f.deleted, 0),
          userMessageId: cp.userMessageId,
          assistantMessageId: cp.assistantMessageId,
        }
      }

      // ── Fallback: старые turn'ы без снапшотов — прежний парсинг ──
      const messages = getMessages(chatId) as Array<{
        id: string; toolSteps?: Array<{ type: string; diff?: string; toolName?: string; toolArgs?: Record<string, unknown> }>
      }>
      const assistantMsg = messages.find(m => m.id === cp.assistantMessageId)
      if (!assistantMsg?.toolSteps) return null

      const fileMap = new Map<string, { added: number; deleted: number }>()
      for (const step of assistantMsg.toolSteps) {
        if (step.type !== 'tool_result' || !step.diff) continue
        // Извлекаем path из +++ строки, fallback — toolArgs.path.
        // createPatch на Windows оборачивает пути с '\' в кавычки И экранирует
        // слеши: +++ "C:\\Projects\\..." — срезаем кавычки и расэкранируем
        // \\ → \, иначе путь не матчится с parsePatch (панель «Сессия»).
        const pathMatch = step.diff.match(/^\+\+\+\s+(.+)$/m)
        let filePath = pathMatch?.[1]?.trim() ?? (step.toolArgs?.path as string | undefined)
        if (!filePath) continue
        if (filePath.startsWith('"') && filePath.endsWith('"')) {
          filePath = filePath.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"')
        }
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

  // ── Кумулятивные per-file диффы указанного checkpoint'а (панель «Сессия») ──
  // Один файл = один дифф за весь запрос: original = до первой правки,
  // modified = после последней (снапшот следующего turn'а или файл на диске).
  // Пустой массив → у turn'а нет снапшотов (старые чаты) → панель использует
  // fallback-парсинг step-диффов.
  ipcMain.handle('chat:getCheckpointFileDiffs', (_, chatId: string, userMessageId: string) => {
    try {
      return computeCheckpointFileDiffs(chatId, userMessageId)
    } catch (e) {
      log('[chat:getCheckpointFileDiffs] chatId=%s userMsgId=%s error=%s', chatId, userMessageId, (e as Error).message)
      return []
    }
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
          // §rollback — снапшоты до фикса хранят относительные пути: резолвим
          // против workdir чата, иначе файлы пишутся/удаляются мимо проекта.
          const absPath = chatSnapshotPath(chatId, snap.path)
          if (snap.contentBefore === null) {
            if (existsSync(absPath)) {
              unlinkSync(absPath)
              restored.push(snap.path)
            }
          } else {
            try { mkdirSync(dirname(absPath), { recursive: true }) } catch { /* ok */ }
            writeFileSync(absPath, snap.contentBefore, 'utf-8')
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
      // §rollback — путь из renderer может не совпадать с записью в БД
      // (относительный vs абсолютный): сравниваем по резолвнутым путям.
      const wantedAbs = chatSnapshotPath(chatId, filePath)
      const snap = snapshots.find(s => s.path === filePath || chatSnapshotPath(chatId, s.path) === wantedAbs)
      if (!snap) {
        return { error: 'Файл не найден в снапшотах этого turn\'а.' }
      }
      const { writeFileSync, unlinkSync, existsSync, mkdirSync } = require('fs')
      const { dirname } = require('path')
      const absPath = chatSnapshotPath(chatId, snap.path)
      if (snap.contentBefore === null) {
        if (existsSync(absPath)) unlinkSync(absPath)
      } else {
        try { mkdirSync(dirname(absPath), { recursive: true }) } catch { /* ok */ }
        writeFileSync(absPath, snap.contentBefore, 'utf-8')
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
      // §rollback — пути резолвим против workdir чата (старые снапшоты в БД
      // хранят относительные пути). В redo-запись кладём резолвнутый путь,
      // чтобы восстановление redo-файлов тоже попадало в проект.
      const { readFileSync, existsSync: pathExistsBefore } = require('fs') // require: нативный import() не работает в V8-байткоде
      const fileChangesForRedo: Array<{ path: string; contentAfter: string | null }> = []
      const seenPaths = new Set<string>()
      for (const snap of snapshots) {
        const snapAbs = chatSnapshotPath(chatId, snap.path)
        if (seenPaths.has(snapAbs)) continue
        seenPaths.add(snapAbs)
        try {
          if (pathExistsBefore(snapAbs)) {
            fileChangesForRedo.push({ path: snapAbs, contentAfter: readFileSync(snapAbs, 'utf-8') })
          } else {
            fileChangesForRedo.push({ path: snapAbs, contentAfter: null })
          }
        } catch {
          fileChangesForRedo.push({ path: snapAbs, contentAfter: null })
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
          // §rollback — относительный путь снапшота резолвим против workdir
          // чата: без этого writeFileSync/unlinkSync работали бы в папке
          // установки приложения, а файлы проекта оставались нетронутыми.
          const snapAbs = chatSnapshotPath(chatId, snap.path)
          if (snap.contentBefore === null) {
            // Файл был создан последующим turn'ом — удаляем.
            if (pathExists(snapAbs)) {
              unlinkSync(snapAbs)
              restoredFiles.push(`удалён: ${snap.path}`)
            }
          } else {
            // Перезаписываем содержимое до правки последующего turn'а.
            const { dirname } = require('path') // require: нативный import() не работает в V8-байткоде
            const { mkdirSync } = require('fs')
            try { mkdirSync(dirname(snapAbs), { recursive: true }) } catch { /* ok */ }
            writeFileSync(snapAbs, snap.contentBefore, 'utf-8')
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
          // §rollback — старые redo-записи (до фикса) хранят относительные
          // пути: резолвим против workdir чата. Новые записи уже абсолютные —
          // resolveSnapshotPath их не меняет.
          const fcAbs = chatSnapshotPath(chatId, fc.path)
          if (fc.contentAfter === null) {
            // Файла не было до отката (был создан, потом удалён при rewind) → удаляем.
            if (pathExists(fcAbs)) {
              unlinkSync(fcAbs)
              restoredFiles.push(`удалён: ${fc.path}`)
            }
          } else {
            // Возвращаем содержимое которое было до отката.
            try { mkdirSync(dirname(fcAbs), { recursive: true }) } catch { /* ok */ }
            writeFileSync(fcAbs, fc.contentAfter, 'utf-8')
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
