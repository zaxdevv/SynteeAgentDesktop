/**
 * Fast Context Watcher — thin layer в main-процессе: управляет worker lifecycle,
 * маршрутизирует IPC, планирует pre-warm. Тяжёлый CPU-ворк (tree-sitter, graph
 * sync) и fs.watch — в worker_thread (fastContext-worker.ts).
 *
 * Main процесс НЕ выполняет CPU-тяжёлую работу и НЕ держит fs handles —
 * только IPC routing + history recording. UI не блокируется.
 *
 * fs.watch(recursive: true) в worker: Windows ReadDirectoryChangesW — kernel
 * callback, 0% CPU в простое, один handle на дерево. На file change → debounce
 * → buildOrUpdateIndex напрямую в worker (без IPC round-trip).
 *
 * Pre-warm (full scan) откладывается на prewarmDelayMs после старта, чтобы не
 * конкурировать за CPU с загрузкой UI/проектов.
 *
 * История обновлений записывается в fast_context_index_history (последние 50).
 */
import { Worker } from 'worker_threads'
import { join } from 'path'
import { getIndexSettingsFromRecord, DEFAULT_INDEXING_SETTINGS, type IndexProgress, type IndexingSettings } from './fastContext'
import {
  addIndexHistoryEvent, pruneIndexHistory, getFastContextIndexCount,
} from '../db'
import { log } from '../logger'
import type Store from 'electron-store'

// Module-level store reference — устанавливается через setWatcherStore(store)
// из fastContext.ipc.ts при регистрации IPC. Без store используются дефолты.
let _store: Store | null = null

/** Установить store для чтения настроек индексации (enabled/debounce/ignoreDirs). */
export function setWatcherStore(store: Store): void {
  _store = store
}

/** Читает текущие настройки индексации из store (с fallback на дефолты). */
function getSettings(): IndexingSettings {
  if (!_store) return DEFAULT_INDEXING_SETTINGS
  try {
    const all = (_store as unknown as { store: Record<string, unknown> }).store
    return getIndexSettingsFromRecord(all)
  } catch {
    return DEFAULT_INDEXING_SETTINGS
  }
}

// ── Worker paths (устанавливаются из registerChatIPC) ─────────────────────────
let _fastContextDbPath: string | null = null
let _fastContextWasmDir: string | null = null

/** Установить пути к БД и tree-sitter WASM — вызывается из registerChatIPC. */
export function setFastContextPaths(dbPath: string, wasmDir: string): void {
  _fastContextDbPath = dbPath
  _fastContextWasmDir = wasmDir
}

// ── Worker singleton ────────────────────────────────────────────────────────
let _worker: Worker | null = null
let _workerJobId = 0
const _workerPending = new Map<string, { resolve: () => void; reject: (e: Error) => void; projectId: string }>()

function ensureWorker(): Worker {
  if (_worker) return _worker
  if (!_fastContextDbPath || !_fastContextWasmDir) {
    throw new Error('fastContextWatcher: paths not set. Call setFastContextPaths() before starting watcher.')
  }
  const workerPath = join(__dirname, 'fastContext-worker.js')
  _worker = new Worker(workerPath, {
    workerData: {
      fastContextDbPath: _fastContextDbPath,
      fastContextWasmDir: _fastContextWasmDir,
    },
  })
  _worker.on('message', (msg: Record<string, unknown>) => {
    const type = msg.type as string
    const jobId = msg.jobId as string | undefined
    if (type === 'progress') {
      // Прогресс от worker → форвардим в renderer (только для активного проекта,
      // как было раньше — onProgress колбэк сам решает).
      const projectId = msg.projectId as string
      const progress = msg.progress as IndexProgress
      if (projectId === _activeProjectId) {
        _onProgress?.(projectId, progress)
      }
      return
    }
    if (type === 'done' || type === 'error') {
      const pending = jobId ? _workerPending.get(jobId) : undefined
      if (pending && jobId) {
        _workerPending.delete(jobId)
        if (type === 'done') pending.resolve()
        else pending.reject(new Error((msg.message as string) || 'fastContext worker error'))
      }
      // Post-done обработка (history) — только для done.
      if (type === 'done') {
        const projectId = msg.projectId as string
        const filesChanged = (msg.filesChanged as number) ?? 0
        const durationMs = (msg.durationMs as number) ?? 0
        const isFull = !!(msg.isFull as boolean)
        // Откладываем через setImmediate, чтобы не блокировать маршрутизацию
        // других worker-сообщений. Graph sync уже выполнен в воркере — здесь
        // только лёгкая запись history + уведомление renderer.
        setImmediate(() => {
          handleWorkerDone(projectId, filesChanged, durationMs, isFull)
        })
      }
      return
    }
    if (type === 'log') {
      // Диагностические сообщения от worker (graph sync stats и т.д.).
      log((msg.message as string) || '[fastContext-worker]')
      return
    }
  })
  _worker.on('error', (err) => {
    console.error('[fastContextWatcher] worker error:', err.message)
    for (const p of _workerPending.values()) p.reject(err)
    _workerPending.clear()
    _worker = null
  })
  _worker.on('exit', (code) => {
    if (code !== 0) console.warn('[fastContextWatcher] worker exited with code', code)
    for (const p of _workerPending.values()) p.reject(new Error('fastContext worker exited'))
    _workerPending.clear()
    _worker = null
  })
  return _worker
}

/** Завершить worker (при выходе из приложения). */
export async function terminateFastContextWorker(): Promise<void> {
  if (_worker) {
    try { await _worker.terminate() } catch { /* ignore */ }
    _worker = null
    _workerPending.clear()
  }
}

/** Отправить job в worker, вернуть Promise, который resolved на done. */
function sendToWorker(job: {
  type: 'index' | 'reindex'
  projectId: string
  workdir: string
  changedPaths: string[] | undefined
  isFull: boolean
  isPrewarm: boolean
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const jobId = String(++_workerJobId)
    _workerPending.set(jobId, { resolve, reject, projectId: job.projectId })
    try {
      ensureWorker().postMessage({
        type: job.type,
        jobId,
        projectId: job.projectId,
        workdir: job.workdir,
        changedPaths: job.changedPaths,
        isFull: job.isFull,
        isPrewarm: job.isPrewarm,
        settings: getSettings(),
      })
    } catch (e) {
      _workerPending.delete(jobId)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/** Отправить startWatching/stopWatching в worker (fire-and-forget, без Promise). */
function sendWatcherCommand(cmd: {
  type: 'startWatching' | 'stopWatching'
  projectId: string
  workdir?: string
  ignoreDirs?: string[]
}): void {
  try {
    const settings = getSettings()
    ensureWorker().postMessage({
      type: cmd.type,
      jobId: `cmd-${++_workerJobId}`,
      projectId: cmd.projectId,
      workdir: cmd.workdir ?? '',
      isFull: false,
      isPrewarm: false,
      settings,
      ignoreDirs: cmd.ignoreDirs ?? settings.ignoreDirs,
    })
  } catch (e) {
    log('[watcher] sendWatcherCommand failed: %s', e instanceof Error ? e.message : String(e))
  }
}

// ── Watcher state ────────────────────────────────────────────────────────────
interface WatcherEntry {
  projectId: string
  workdir: string
  prewarmTimer: NodeJS.Timeout | null
}

const _watchers = new Map<string, WatcherEntry>()
const _projectWorkdirs = new Map<string, string>()
let _activeProjectId: string | null = null
let _onProgress: ((projectId: string, progress: IndexProgress) => void) | null = null
let _onUpdated: ((projectId: string) => void) | null = null
const _indexingProjects = new Set<string>()

// ── Глобальная очередь индексации ────────────────────────────────────────────
// Один job за раз в worker (worker однопоточный). Активный проект — приоритет.
interface QueuedJob {
  type: 'index' | 'reindex'
  projectId: string
  workdir: string
  changedPaths: string[] | undefined
  isFull: boolean
  isPrewarm: boolean
  resolve: () => void
}
const _indexQueue: QueuedJob[] = []
let _queueRunning = false

async function processQueue(): Promise<void> {
  if (_queueRunning) return
  _queueRunning = true
  try {
    while (_indexQueue.length > 0) {
      // Приоритет: активный проект первым
      const activeIdx = _activeProjectId
        ? _indexQueue.findIndex(j => j.projectId === _activeProjectId)
        : -1
      const job = activeIdx >= 0
        ? _indexQueue.splice(activeIdx, 1)[0]
        : _indexQueue.shift()!
      _indexingProjects.add(job.projectId)
      try {
        await sendToWorker(job)
      } catch (e) {
        // Ошибка уже залогирована в worker-обработчике; не валить очередь.
        log('[watcher] job failed: %s', e instanceof Error ? e.message : String(e))
      } finally {
        _indexingProjects.delete(job.projectId)
      }
      job.resolve()
      // Пауза между проектами — даём CPU остыть
      await new Promise<void>(r => setTimeout(r, 200))
    }
  } finally {
    _queueRunning = false
  }
}

function enqueueIndex(job: Omit<QueuedJob, 'resolve'>): Promise<void> {
  return new Promise<void>((resolve) => {
    _indexQueue.push({ ...job, resolve })
    void processQueue()
  })
}

/** Установить колбэк для прогресса индексации (→ renderer через IPC). */
export function setProgressCallback(cb: (projectId: string, progress: IndexProgress) => void): void {
  _onProgress = cb
}

/** Установить колбэк для уведомления об обновлении индекса (→ renderer). */
export function setUpdatedCallback(cb: (projectId: string) => void): void {
  _onUpdated = cb
}

/** Установить активный проект (приоритетная индексация). */
export function setActiveProject(projectId: string | null): void {
  _activeProjectId = projectId
  // Только активный проект имеет watcher — остальные останавливаем.
  // Это радикально снижает CPU usage в простое (N watchers → 1 watcher).
  for (const pid of Array.from(_watchers.keys())) {
    if (pid !== projectId) {
      void stopWatching(pid)
    }
  }
  // Запускаем watcher для активного проекта, если он не запущен
  if (projectId) {
    const workdir = _projectWorkdirs.get(projectId)
    if (workdir && !_watchers.has(projectId)) {
      startWatching(projectId, workdir)
    }
  }
}

/** Запомнить workdir проекта без старта chokidar-watcher'а. Нужно чтобы
 *  setActiveProject мог запустить watcher при активации проекта. Лёгкая
 *  операция (только Map-запись), не создаёт FS-handles. */
export function registerProjectWorkdir(projectId: string, workdir: string): void {
  _projectWorkdirs.set(projectId, workdir)
}

/** Идёт ли индексация для проекта прямо сейчас. */
export function isIndexing(projectId: string): boolean {
  return _indexingProjects.has(projectId)
}

/** Записать событие в историю + prune старых. */
function recordHistory(projectId: string, eventType: string, filesChanged: number, durationMs: number): void {
  try {
    const filesCount = getFastContextIndexCount(projectId)
    addIndexHistoryEvent(projectId, eventType, filesCount, filesChanged, durationMs)
    pruneIndexHistory(projectId, 50)
  } catch { /* history опциональна */ }
}

/** Post-done обработка в main: history + уведомление renderer.
 *  Graph sync (syncFromFastContext — сотни тысяч DB-записей на 10к файлов)
 *  перенесён в fastContext-worker (выполняется там на full). Main больше НЕ
 *  делает тяжёлых DB-записей → UI не виснет. Вызывается из worker 'done'
 *  обработчика через setImmediate. */
function handleWorkerDone(projectId: string, filesChanged: number, durationMs: number, isFull: boolean): void {
  const eventType = isFull ? 'full' : 'incremental'
  recordHistory(projectId, eventType, filesChanged, durationMs)

  _onUpdated?.(projectId)
  if (projectId === _activeProjectId) {
    _onProgress?.(projectId, { stage: 'done', detail: `${filesChanged} файлов, ${durationMs}ms` })
  }
}

/** Запускает watcher для проекта. Idempotent — повторный вызов для того же projectId не создаёт второй watcher.
 *  Если в настройках indexingSettings.enabled=false — не регистрирует проект.
 *  fs.watch(recursive: true) стартует В WORKER THREAD — kernel callback, 0% CPU
 *  в простое. Main процесс не держит FS handles. Pre-warm шедулится здесь. */
export function startWatching(projectId: string, workdir: string): void {
  _projectWorkdirs.set(projectId, workdir)
  if (_watchers.has(projectId)) return

  const settings = getSettings()
  // Мастер-переключатель: если индексация отключена — вообще не регистрируем.
  if (!settings.enabled) {
    console.log(`[fastContextWatcher] indexing disabled in settings — skipping ${workdir}`)
    return
  }

  const entry: WatcherEntry = {
    projectId,
    workdir,
    prewarmTimer: null,
  }
  _watchers.set(projectId, entry)

  // ── Запускаем fs.watch в worker thread ──
  // Windows: ReadDirectoryChangesW — kernel-level, 0% CPU в простое.
  // На file change → debounce → buildOrUpdateIndex напрямую в worker.
  // Safety net (5 мин) ловит пропущенные events.
  sendWatcherCommand({
    type: 'startWatching',
    projectId, workdir,
    ignoreDirs: settings.ignoreDirs,
  })

  // Pre-warm: только если индекс пустой (первый запуск проекта) И настройка
  // включена. Откладываем на settings.prewarmDelayMs (default 30с) чтобы не
  // конкурировать со стартом приложения. Работает в worker_thread — main свободен.
  if (settings.prewarmOnStart) {
    const existingCount = getFastContextIndexCount(projectId)
    if (existingCount === 0) {
      const delay = settings.prewarmDelayMs ?? 30_000
      entry.prewarmTimer = setTimeout(() => {
        entry.prewarmTimer = null
        // Перепроверяем — возможно индекс уже наполнился (get_fast_context).
        if (getFastContextIndexCount(projectId) > 0) return
        void enqueueIndex({
          type: 'index',
          projectId, workdir,
          changedPaths: undefined,
          isFull: true,
          isPrewarm: true,
        })
      }, delay)
    }
  }
}

/** Останавливает watcher для проекта. */
export async function stopWatching(projectId: string): Promise<void> {
  const entry = _watchers.get(projectId)
  if (!entry) return
  if (entry.prewarmTimer) clearTimeout(entry.prewarmTimer)
  // Останавливаем fs.watch в worker
  sendWatcherCommand({ type: 'stopWatching', projectId })
  _watchers.delete(projectId)
}

/** Останавливает все watchers (при выходе из приложения). */
export async function stopAllWatchers(): Promise<void> {
  const ids = Array.from(_watchers.keys())
  await Promise.all(ids.map(stopWatching))
  await terminateFastContextWorker()
}

/** Проверка — запущен ли watcher для проекта. */
export function isWatching(projectId: string): boolean {
  return _watchers.has(projectId)
}

/**
 * Принудительный реиндекс проекта (вызывается из IPC fastcontext:reindex).
 * Всегда full + с progress events. Ждёт очереди и завершения worker'а.
 */
export async function forceReindex(projectId: string): Promise<void> {
  const entry = _watchers.get(projectId)
  const workdir = entry?.workdir ?? _projectWorkdirs.get(projectId)
  if (!workdir) return
  await enqueueIndex({
    type: 'reindex',
    projectId, workdir,
    changedPaths: undefined,
    isFull: true,
    isPrewarm: false,
  })
}
