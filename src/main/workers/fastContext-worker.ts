/**
 * Fast Context Worker Thread — изолирует тяжёлый CPU-ворк (tree-sitter парсинг,
 * regex-scan references, embeddings, graph ranking) от главного процесса
 * Electron. Main процесс только маршрутизирует IPC — UI не блокируется.
 *
 * Архитектура watcher'а: fs.watch(recursive: true) ЗДЕСЬ, в worker thread.
 * Windows: ReadDirectoryChangesW — kernel-level callback, 0% CPU в простое.
 * Один handle на всё дерево (chokidar: тысячи handles + stat calls).
 * На file change → debounce → buildOrUpdateIndex напрямую (без IPC round-trip).
 * Safety net: каждые 5 мин — быстрый walk + compare с БД (ловит пропущенные events).
 *
 * Сообщения main → worker:
 *   { type: 'startWatching', projectId, workdir, ignoreDirs, settings }
 *   { type: 'stopWatching', projectId }
 *   { type: 'index', jobId, projectId, workdir, changedPaths?, isFull, isPrewarm, settings }
 *   { type: 'reindex', jobId, projectId, workdir, ... }
 *
 * Сообщения worker → main:
 *   { type: 'progress', jobId, projectId, progress }
 *   { type: 'done', jobId, projectId, filesChanged, durationMs, isFull }
 *   { type: 'error', jobId, projectId, message }
 *   { type: 'log', jobId, message }
 */

import { parentPort, workerData } from 'worker_threads'
import { watch, type FSWatcher } from 'fs'
import { join } from 'path'
import {
  initFastContextDb, initFastContextWasmDir, buildOrUpdateIndex,
  walkProjectFiles, type IndexProgress, type IndexingSettings,
} from '../../core/context/fastContext'
import { localGetEntries, getLangForFile } from '../../core/context/fastContext/state'
import { quickHash } from '../../core/context/fastContext/fileHash'
import { isIndexableArtifact } from '../../core/context/fastContext/artifacts'
import { initDBFromPath, getDB } from '../../core/db/handle'
import { incrementalUpdateFastContext } from '../../core/memory/graphBuilder'

const fastContextDbPath = (workerData as Record<string, unknown>).fastContextDbPath as string
const fastContextWasmDir = (workerData as Record<string, unknown>).fastContextWasmDir as string

try {
  // fast-context connection (fast_context_index таблица) — своё connection.
  initFastContextDb(fastContextDbPath)
  initFastContextWasmDir(fastContextWasmDir)
  // Main-DB connection (memory_graph_* и др.) — открываем в воркере чтобы
  // graph-sync (incrementalUpdateFastContext / syncFromFastContext — сотни
  // тысяч DB-записей на 10к файлов) выполнялся ЗДЕСЬ, не в main-процессе.
  // Тот же файл syntee.db, WAL → concurrent с main безопасен. Миграции уже
  // выполнил main при старте — здесь не запускаем.
  initDBFromPath(fastContextDbPath)
} catch (e) {
  console.warn('[fastContext-worker] init failed:', e)
}

// Адаптивные мягкие режимы для 5K+ файлов.
// Pre-warm: BATCH=3, sleep=40ms → 5000/3 × 40ms ≈ 66 сек (вместо 12.5 мин при BATCH=1/sleep=150).
//   3 параллельных tree-sitter parse (~10ms каждый) = ~30ms CPU + 40ms rest = 43% CPU на ядре.
// Incremental: BATCH=4, sleep=30ms — быстрый отклик на изменения (watcher ticks).
// Reindex (явный запрос юзера): BATCH=8, sleep=15ms — пользователь ждёт, даём больше CPU.
// skipReferencesAboveBytes: ограничивает regex-scan на больших файлах (60-200KB).
// skipGraphRankAboveN: пропускает O(N) PageRank на огромных репо (5K-10K порог).
// Прогресс шлём не чаще 500мс чтобы не дёргать IPC.
const SOFT_MODES = {
  prewarm:    { batchSize: 3, batchDelayMs: 40, skipReferencesAboveBytes: 80_000,  skipGraphRankAboveN: 8000 },
  incremental:{ batchSize: 4, batchDelayMs: 30, skipReferencesAboveBytes: 120_000, skipGraphRankAboveN: 5000 },
  reindex:    { batchSize: 8, batchDelayMs: 15, skipReferencesAboveBytes: 200_000, skipGraphRankAboveN: 10000 },
} as const

function postMessage(msg: Record<string, unknown>): void {
  parentPort?.postMessage(msg)
}

// ── fs.watch state (worker thread, 0 CPU в простое) ──────────────────────────
interface WatchState {
  projectId: string
  workdir: string
  watcher: FSWatcher | null
  debounceTimer: NodeJS.Timeout | null
  pendingPaths: Set<string>
  safetyNetTimer: NodeJS.Timeout | null
  ignoreDirs: Set<string>
  settings: IndexingSettings
  /** Тихих safety-net прогонов подряд (0 изменений). После 3 — реже. */
  quietRuns: number
}
const _watchStates = new Map<string, WatchState>()
let _watchJobCounter = 0
// Safety net — адаптивный: первый прогон через 60с (ловит изменения, накопленные
// пока приложение было закрыто), дальше базовый интервал, после 3 тихих прогонов
// подряд — редкий (15 мин). Тихий прогон = только readdir+stat+hash ≈ 100-300мс
// на 5к файлов раз в несколько минут — фактически нулевая нагрузка.
const SAFETY_NET_INITIAL_MS = 60_000
const SAFETY_NET_BASE_MS = 5 * 60_000
const SAFETY_NET_IDLE_MS = 15 * 60_000
const SAFETY_NET_QUIET_THRESHOLD = 3

/** Запустить fs.watch + safety net для проекта. */
function startFsWatch(projectId: string, workdir: string, ignoreDirs: string[], settings: IndexingSettings): void {
  stopFsWatch(projectId)

  const state: WatchState = {
    projectId, workdir,
    watcher: null,
    debounceTimer: null,
    pendingPaths: new Set(),
    safetyNetTimer: null,
    ignoreDirs: new Set(ignoreDirs),
    settings,
    quietRuns: 0,
  }
  _watchStates.set(projectId, state)

  // fs.watch(recursive: true) — Windows: ReadDirectoryChangesW, kernel callback.
  // Один handle на всё дерево, 0% CPU в простое. Не poll, не stat-spam.
  try {
    state.watcher = watch(workdir, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const fullPath = join(workdir, filename)
      const relPath = filename.replace(/\\/g, '/')

      // Фильтр ignore-dirs
      for (const d of state.ignoreDirs) {
        if (relPath === d || relPath.startsWith(d + '/')) return
      }
      // Watch both source code and the small set of searchable project artifacts.
      if (!getLangForFile(filename) && !isIndexableArtifact(fullPath)) return

      // Debounce — собираем события 1000ms (батчит git checkout и др.)
      state.pendingPaths.add(fullPath)
      // Была FS-активность → сбрасываем backoff safety net'а.
      state.quietRuns = 0
      if (state.debounceTimer) clearTimeout(state.debounceTimer)
      state.debounceTimer = setTimeout(() => {
        const paths = Array.from(state.pendingPaths)
        state.pendingPaths.clear()
        state.debounceTimer = null
        if (paths.length > 0) {
          void doWatcherIndex(projectId, workdir, paths, settings)
        }
      }, settings.watcherDebounceMs ?? 1000)
    })
  } catch (e) {
    console.warn(`[fastContext-worker] fs.watch failed for ${workdir}:`, e)
  }

  // Safety net — адаптивный (см. константы выше): первый прогон через 60с,
  // дальше 5 мин, после 3 тихих прогонов подряд — 15 мин. Любая FS-активность
  // сбрасывает счётчик (см. quietRuns в watch-callback).
  const scheduleSafetyNet = (delayMs: number) => {
    state.safetyNetTimer = setTimeout(async () => {
      // Guard: watcher мог быть остановлен во время предыдущего скана —
      // тогда не сканируем и не перепланируем.
      if (_watchStates.get(projectId) !== state) return
      await doSafetyNetScan(projectId, workdir, state.ignoreDirs, settings)
      if (_watchStates.get(projectId) !== state) return
      // Пересчитываем интервал по результату: тихо → backoff, изменения → база.
      const nextDelay = state.quietRuns >= SAFETY_NET_QUIET_THRESHOLD
        ? SAFETY_NET_IDLE_MS
        : SAFETY_NET_BASE_MS
      scheduleSafetyNet(nextDelay)
    }, delayMs)
  }
  scheduleSafetyNet(SAFETY_NET_INITIAL_MS)
}

/** Остановить fs.watch + safety net для проекта. */
function stopFsWatch(projectId: string): void {
  const state = _watchStates.get(projectId)
  if (!state) return
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  if (state.safetyNetTimer) clearInterval(state.safetyNetTimer)
  if (state.watcher) {
    try { state.watcher.close() } catch { /* ignore */ }
  }
  _watchStates.delete(projectId)
}

/** Incremental index из watcher events — прямой вызов, без IPC round-trip. */
async function doWatcherIndex(
  projectId: string, workdir: string, changedPaths: string[], settings: IndexingSettings,
): Promise<void> {
  const jobId = `watch-${++_watchJobCounter}`
  const startedAt = Date.now()
  // Сообщаем main/renderer что индексация идёт — иначе в модалке в этот
  // момент показывалось «Готов», хотя воркер работал.
  postMessage({
    type: 'progress', jobId, projectId,
    progress: { stage: 'indexing', detail: `Обновление ${changedPaths.length} файлов (watcher)...` },
  })
  try {
    const filesChanged = await buildOrUpdateIndex(
      projectId, workdir, changedPaths, undefined,
      { skipEmbeddings: true, settings, ...SOFT_MODES.incremental },
    )
    // Graph sync
    if (filesChanged >= 0) {
      try {
        const db = getDB()
        const tx = db.transaction(() => incrementalUpdateFastContext(projectId, changedPaths))
        tx()
      } catch { /* skip */ }
    }
    postMessage({ type: 'done', jobId, projectId, filesChanged, durationMs: Date.now() - startedAt, isFull: false })
  } catch (e) {
    postMessage({ type: 'error', jobId, projectId, message: e instanceof Error ? e.message : String(e) })
  }
}

/** Safety net scan — быстрый walk + compare с БД, ловит пропущенные events. */
async function doSafetyNetScan(
  projectId: string, workdir: string, ignoreDirs: Set<string>, settings: IndexingSettings,
): Promise<void> {
  const jobId = `safety-${++_watchJobCounter}`
  const startedAt = Date.now()
  let changedCount = 0
  try {
    // Быстрый walk: только readdir + stat, без tree-sitter parse
    const { files, hitCap } = await walkProjectFiles(workdir, { ignoreDirs, maxFiles: settings.maxFilesPerProject })
    const existing = new Map(localGetEntries(projectId).map(e => [e.filePath, e]))

    // Guard: walk вернул 0 файлов при непустом индексе — workdir недоступен
    // (диск/права/антивирус). Не трогаем ничего: иначе все записи выглядели
    // бы «удалёнными» → requestReindex → full scan с пустым walk → стирание.
    if (files.length === 0 && existing.size > 0) {
      postMessage({ type: 'log', jobId, message: `[safety-net] walk returned 0 files, index has ${existing.size} — skipping (workdir unavailable?)` })
      return
    }

    const changed: string[] = []
    const seen = new Set<string>()
    for (const f of files) {
      seen.add(f.path)
      const entry = existing.get(f.path)
      if (!entry) {
        changed.push(f.path) // новый файл
      } else if (entry.size !== f.size || entry.contentHash !== quickHash(f.path, f.size)) {
        changed.push(f.path) // изменившийся файл
      }
    }
    // Удалённые файлы. hitCap: записи за пределами cap могли просто не
    // попасть в выборку — не считаем их удалёнными.
    if (!hitCap) {
      for (const [path] of existing) {
        if (!seen.has(path)) changed.push(path)
      }
    }
    changedCount = changed.length

    // Обновляем backoff-счётчик: тихий прогон → +1, изменения → сброс.
    const st = _watchStates.get(projectId)
    if (changed.length === 0) {
      if (st) st.quietRuns++
      return
    }
    if (st) st.quietRuns = 0

    if (changed.length >= 500) {
      // Слишком много изменений — инкремент бессмыслен. Раньше молча ждали
      // full reindex, который сам никогда не приходил → индекс большого репо,
      // прерванный на 30%, оставался частичным навсегда. Теперь просим main
      // поставить full reindex в очередь.
      postMessage({ type: 'requestReindex', projectId, workdir })
      return
    }

    const filesChanged = await buildOrUpdateIndex(
      projectId, workdir, changed, undefined,
      { skipEmbeddings: true, settings, ...SOFT_MODES.incremental },
    )
    if (filesChanged >= 0) {
      try {
        const db = getDB()
        const tx = db.transaction(() => incrementalUpdateFastContext(projectId, changed))
        tx()
      } catch { /* skip */ }
    }
    if (filesChanged > 0) {
      postMessage({ type: 'done', jobId, projectId, filesChanged, durationMs: Date.now() - startedAt, isFull: false })
    }
  } catch (e) {
    postMessage({ type: 'log', jobId, message: `[safety-net] failed: ${e instanceof Error ? e.message : String(e)}` })
  } finally {
    // Сообщаем main о факте прогона ВСЕГДА (даже тихий, 0 изменений) —
    // watcher пишет lastScanAt → модалка показывает «Последняя проверка».
    // Иначе тихие прогоны не оставляли следов и казалось, что фон не работает.
    postMessage({ type: 'scanCompleted', projectId, changed: changedCount })
  }
}

interface IndexJobMsg {
  type: 'index' | 'reindex' | 'startWatching' | 'stopWatching'
  jobId: string
  projectId: string
  workdir: string
  changedPaths?: string[]
  isFull: boolean
  isPrewarm: boolean
  settings: IndexingSettings
  ignoreDirs?: string[]
}

parentPort?.on('message', async (msg: IndexJobMsg) => {
  // ── Watcher control: start/stop fs.watch в worker thread ──
  if (msg.type === 'startWatching') {
    startFsWatch(msg.projectId, msg.workdir, msg.ignoreDirs ?? [], msg.settings)
    return
  }
  if (msg.type === 'stopWatching') {
    stopFsWatch(msg.projectId)
    return
  }
  if (msg.type !== 'index' && msg.type !== 'reindex') return
  const { jobId, projectId, workdir, changedPaths, isFull, isPrewarm, settings } = msg
  const startedAt = Date.now()

  const mode = isPrewarm ? SOFT_MODES.prewarm
    : msg.type === 'reindex' ? SOFT_MODES.reindex
    : SOFT_MODES.incremental

  // Throttle progress: шлём не чаще 500мс (и финальное done всегда).
  let lastProgressSent = 0
  let pendingProgress: IndexProgress | null = null
  let progressTimer: NodeJS.Timeout | null = null
  const flushProgress = () => {
    if (pendingProgress) {
      postMessage({ type: 'progress', jobId, projectId, progress: pendingProgress })
      lastProgressSent = Date.now()
      pendingProgress = null
    }
    progressTimer = null
  }
  const onProgress = (p: IndexProgress) => {
    if (p.stage === 'done') {
      // done шлём без throttling — сразу
      postMessage({ type: 'progress', jobId, projectId, progress: p })
      lastProgressSent = Date.now()
      pendingProgress = null
      if (progressTimer) { clearTimeout(progressTimer); progressTimer = null }
      return
    }
    pendingProgress = p
    const now = Date.now()
    if (now - lastProgressSent >= 500) {
      flushProgress()
    } else if (!progressTimer) {
      progressTimer = setTimeout(flushProgress, 500 - (now - lastProgressSent))
    }
  }

  try {
    const isPrewarmJob = isFull && !changedPaths
    const filesChanged = await buildOrUpdateIndex(
      projectId, workdir, changedPaths, onProgress,
      {
        skipEmbeddings: isPrewarmJob,
        settings,
        batchSize: mode.batchSize,
        batchDelayMs: mode.batchDelayMs,
        skipReferencesAboveBytes: mode.skipReferencesAboveBytes,
        skipGraphRankAboveN: mode.skipGraphRankAboveN,
      },
    )
    // Отменяем pending throttle-таймер, шлём финальный progress done.
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null }
    pendingProgress = null

    // ── Graph sync (memory_graph) ─────────────────────────────────────
    // Раньше выполнялся в main-процессе и для 10к файлов = сотни тысяч
    // синхронных DB-записей → UI висел минутами. Теперь в воркере.
    // incrementalUpdateFastContext сама решает режим:
    //   - changedPaths задан и < 200 → incremental (только changed файлы)
    //   - changedPaths пуст/не задан  → full sync (prewarm/reindex)
    // Всё в одной транзакции — быстрее на порядки.
    if (filesChanged >= 0) {
      try {
        const db = getDB()
        const tx = db.transaction(() => incrementalUpdateFastContext(projectId, changedPaths))
        const r = tx()
        postMessage({ type: 'log', jobId, message: `[worker] graph sync: nodes=${r.nodes} edges=${r.edges} removed=${r.removed}` })
      } catch (e) {
        postMessage({ type: 'log', jobId, message: `[worker] graph sync failed: ${e instanceof Error ? e.message : String(e)}` })
      }
    }

    const durationMs = Date.now() - startedAt
    postMessage({ type: 'done', jobId, projectId, filesChanged, durationMs, isFull })
  } catch (e) {
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null }
    postMessage({ type: 'error', jobId, projectId, message: e instanceof Error ? e.message : String(e) })
  }
})
