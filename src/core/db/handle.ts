import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { runMigrations } from './migrations'

let db: Database.Database

export function getDB(): Database.Database {
  if (!db) throw new Error('DB not initialized')
  return db
}

/**
 * Инициализирует подключение к базе данных SQLite.
 *
 * Путь к файлу БД: `<userData>/syntee.db`, где `userData` — каталог данных
 * пользователя Electron (app.getPath('userData')). Каталог создаётся при
 * необходимости через mkdirSync с флагом recursive.
 *
 * Включает две SQLite-прагмы:
 *  - `journal_mode = WAL` — режим Write-Ahead Logging для повышения
 *    производительности конкурентного доступа и устойчивости к сбоям.
 *  - `foreign_keys = ON` — включает проверку внешних ключей.
 *
 * После открытия соединения запускает миграции (runMigrations).
 */
export function initDB(): void {
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  const dbPath = join(userData, 'syntee.db')

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // ── Performance PRAGMA ──────────────────────────────────────────────
  // cache_size = -64000 → 64MB page-cache (default 2MB). Ускоряет все
  // запросы на больших чатах (тысячи сообщений, FTS-поиск, getMessagesPage).
  // mmap_size = 256MB → memory-mapped I/O для чтения без copy в heap.
  // synchronous = NORMAL → WAL + NORMAL безопасен (нет потери данных при
  //   crash в WAL-режиме), но быстрее FULL (не fsync на каждой записи).
  // temp_store = MEMORY → временные таблицы/индексы в RAM, не на диске.
  db.pragma('cache_size = -64000')
  db.pragma('mmap_size = 268435456')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')

  runMigrations(db)
}

/**
 * Worker-friendly init: открывает connection к тому же syntee.db БЕЗ electron
 * (app.getPath недоступен в worker_threads). Используется fastContext-worker'ом
 * чтобы graph-функции (graphStore/graphExtractor, которые дергают getDB())
 * работали в воркере и не блокировали main-процесс тяжёлым graph-sync'ом.
 *
 * Тот же файл → те же таблицы (memory_graph_*, fast_context_index, …).
 * WAL → concurrent доступ с main-процессом безопасен. Миграции по умолчанию
 * НЕ запускаются (main уже их выполнил при старте приложения).
 */
export function initDBFromPath(dbPath: string, opts: { runMigrations?: boolean } = {}): void {
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('cache_size = -64000')
  db.pragma('mmap_size = 268435456')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')
  if (opts.runMigrations) runMigrations(db)
}
