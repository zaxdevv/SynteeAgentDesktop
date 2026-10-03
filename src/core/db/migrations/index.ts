import type Database from 'better-sqlite3'
import { runInitialSchema } from './initialSchema'
import { runIncrementalMigrations } from './incremental'
import { runDelegatedChatSchema } from './delegatedChats'

export { runInitialSchema } from './initialSchema'
export { runIncrementalMigrations } from './incremental'
export { migrateChatsToProjects, migrateLegacyMemoryToMemoryItems } from './dataMigrations'

/**
 * Идемпотентная схема-миграция: CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN
 * с защитой через PRAGMA table_info. Порядок важен — см. комментарий у idx_chats_project_id.
 */
export function runMigrations(db: Database.Database): void {
  runInitialSchema(db)
  runIncrementalMigrations(db)
  runDelegatedChatSchema(db)
}
