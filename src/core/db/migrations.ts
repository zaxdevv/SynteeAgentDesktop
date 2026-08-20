// ── Re-export from migrations/ directory (barrel) ──────────────────────
export { runMigrations } from './migrations/index'
export { runInitialSchema } from './migrations/initialSchema'
export { runIncrementalMigrations } from './migrations/incremental'
export { migrateChatsToProjects, migrateLegacyMemoryToMemoryItems } from './migrations/dataMigrations'
