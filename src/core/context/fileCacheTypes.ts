/**
 * fileCacheTypes.ts — типы для персистентного read-кэша файлов.
 * Кэш живёт на уровне main-процесса (module-level Map по chatId),
 * переживает несколько сообщений чата и несколько worker-потоков.
 */

export interface FileCacheEntry {
  /** Filesystem identity and nanosecond change times. Absent on legacy snapshots. */
  version?: string
  /** mtime файла на диске в момент кэширования (ms) */
  mtimeMs: number
  /** размер файла в байтах на момент кэширования */
  size: number
  /** результат read_file (уже обрезанный/форматированный) */
  output: string
  /** когда записано в кэш (ms) — для LRU-эвикшена */
  cachedAt: number
}
