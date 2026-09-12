/**
 * Fast Context IPC — статус индекса, реиндекс, очистка, live progress.
 *
 * Каналы:
 *   fastcontext:getStatus  — { fileCount, lastUpdated, watcherActive, indexingInProgress, history, recentFiles, topFiles }
 *   fastcontext:reindex    — запускает full reindex, прогресс через fastcontext:progress event
 *   fastcontext:clearIndex — очищает индекс проекта
 *   fastcontext:progress   — push event: { stage, detail, filesProcessed, filesTotal }
 *   fastcontext:updated    — push event: индекс обновлён (watcher сработал)
 */
import { ipcMain, type BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { IPC_EVENTS } from '../../shared/constants'
import {
  getFastContextIndexCount, getFastContextLastUpdated,
  getIndexHistory, getRecentFastContextFiles, getTopFastContextFiles,
  clearFastContextIndex, addIndexHistoryEvent, pruneIndexHistory,
} from '../../core/db'
import {
  setProgressCallback, setUpdatedCallback, setActiveProject,
  isWatching, isIndexing, isQueued, forceReindex, setWatcherStore,
  autoStartLastProject, getLastScanAt,
} from '../../core/context/fastContextWatcher'
import { setActiveExtensionsProject, initExtensionsDetector } from '../../core/extensionsDetector'
import { getProjectById } from '../../core/db'
import { log } from '../../core/logger'

let _initialized = false

export function registerFastContextIPC(store: Store, getWindow: () => BrowserWindow | null): void {
  // Idempotent — регистрируем только один раз
  if (_initialized) return
  _initialized = true

  // Передаём store в watcher — он читает indexingSettings (enabled/debounce/ignoreDirs/prewarm).
  setWatcherStore(store)

  // Инициализируем extensions-детектор (для авто-подключения MCP и авто-включения
  // skills при появлении/изменении .mcp.json / .syntee/skills/ активного проекта).
  initExtensionsDetector(getWindow)

  // Автостарт watcher'а последнего активного проекта — индексация начинается
  // сама, в фоне (worker thread), не дожидаясь пока пользователь откроет чат.
  // registerChatIPC (регистрирует workdir'ы) уже отработал к этому моменту.
  autoStartLastProject()

  // Push callbacks из watcher'а → renderer
  setProgressCallback((projectId, progress) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_EVENTS.FASTCONTEXT_PROGRESS, { projectId, ...progress })
    }
  })

  setUpdatedCallback((projectId) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_EVENTS.FASTCONTEXT_UPDATED, { projectId })
    }
  })

  // Отслеживаем активный проект для priority indexing + extensions watcher.
  // Renderer шлёт 'fastcontext:setActive' когда пользователь переключает проект.
  ipcMain.handle('fastcontext:setActive', (_e, projectId: string | null) => {
    setActiveProject(projectId)
    // Параллельно переключаем extensions-watcher на тот же проект.
    let workdir: string | undefined
    if (projectId) {
      const proj = getProjectById(projectId)
      workdir = proj?.workdir
    }
    setActiveExtensionsProject(projectId ?? null, workdir)
  })

  // Полный статус индекса для модалки
  ipcMain.handle('fastcontext:getStatus', (_e, projectId: string) => {
    const fileCount = getFastContextIndexCount(projectId)
    const lastUpdated = getFastContextLastUpdated(projectId)
    const watcherActive = isWatching(projectId)
    const indexing = isIndexing(projectId)
    const queued = isQueued(projectId)
    const lastScanAt = getLastScanAt(projectId)
    const history = getIndexHistory(projectId, 50)
    const recentFiles = getRecentFastContextFiles(projectId, 10)
    const topFiles = getTopFastContextFiles(projectId, 10)
    return { fileCount, lastUpdated, watcherActive, indexingInProgress: indexing, queued, lastScanAt, history, recentFiles, topFiles }
  })

  // Принудительный реиндекс.
  // Ошибки НЕ глотаем: forceReindex кидает (workdir не найден, worker упал) —
  // renderer показывает их в модалке вместо тихого «ничего не произошло».
  ipcMain.handle('fastcontext:reindex', async (_e, projectId: string) => {
    try {
      await forceReindex(projectId)
      return { ok: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log(`[fastContext:reindex] failed for ${projectId}: ${message}`)
      return { ok: false, error: message }
    }
  })

  // Очистка индекса
  ipcMain.handle('fastcontext:clearIndex', (_e, projectId: string) => {
    clearFastContextIndex(projectId)
    addIndexHistoryEvent(projectId, 'clear', 0, 0, 0)
    pruneIndexHistory(projectId, 50)
    return { ok: true }
  })
}
