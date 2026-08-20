/**
 * Настройки индексации — чистые типы и константы без node-зависимостей.
 * Безопасно импортируется из renderer (browser). fastContext.ts реэкспортит отсюда.
 */

/** Дефолтный список ignore-директорий как массив (для UI настроек). */
export const DEFAULT_IGNORE_DIRS_LIST: string[] = [
  'node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build',
  '.next', 'coverage', '.cache', '.turbo', '.parcel-cache', 'target',
  '.gradle', '.idea', '.vscode', '.hermes', '.mimocode', '.playwright-mcp',
  '.planning', 'logs', 'tmp', 'tmp_out', '.opencode',
]

export interface IndexingSettings {
  /** Мастер-переключатель. Если false — watcher не стартует, get_fast_context не индексирует. */
  enabled: boolean
  /** Фоновый watcher (fs.watch в worker thread). Всегда ON — 0% CPU в простое
   *  (Windows: ReadDirectoryChangesW kernel callback, не poll). Раньше был OFF
   *  из-за chokidar libuv saturation в main-процессе — теперь watcher в worker. */
  backgroundWatch: boolean
  /** Neural embeddings (ONNX/MiniLM ~22MB). OFF по умолчанию — ONNX грузит CPU в простое. */
  neuralEmbeddings: boolean
  /** Лимит файлов на проект (safety limit). */
  maxFilesPerProject: number
  /** Файлы крупнее не индексируются (в KB). */
  maxFileSizeKb: number
  /** Debounce watcher: как быстро реагировать на изменения файлов (ms). */
  watcherDebounceMs: number
  /** Pre-warm индекс при открытии проекта (если пуст). */
  prewarmOnStart: boolean
  /** Задержка pre-warm после старта watcher'а (ms) — даёт UI/проектам
   *  загрузиться без конкуренции за CPU. 0 = сразу. */
  prewarmDelayMs: number
  /** Игнорируемые директории (basename match). */
  ignoreDirs: string[]
}

export const DEFAULT_INDEXING_SETTINGS: IndexingSettings = {
  enabled: true,
  backgroundWatch: true, // Всегда ON — fs.watch в worker, 0% CPU (kernel callback)
  neuralEmbeddings: false,
  maxFilesPerProject: 5000,
  maxFileSizeKb: 1500,
  watcherDebounceMs: 1000,
  prewarmOnStart: true,
  prewarmDelayMs: 30_000,
  ignoreDirs: DEFAULT_IGNORE_DIRS_LIST,
}

/** Читает IndexingSettings из Record (renderer-safe, без Store зависимости). */
export function getIndexSettingsFromRecord(rec: Record<string, unknown> | undefined): IndexingSettings {
  if (!rec) return DEFAULT_INDEXING_SETTINGS
  const saved = (rec['indexingSettings'] ?? {}) as Partial<IndexingSettings>
  return { ...DEFAULT_INDEXING_SETTINGS, ...saved }
}
