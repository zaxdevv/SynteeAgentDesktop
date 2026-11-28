import type Database from 'better-sqlite3'

export function runAIUsageSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage_totals (
      chat_id TEXT PRIMARY KEY,
      total_cents REAL NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0,
      unpriced_requests INTEGER NOT NULL DEFAULT 0,
      priced_requests INTEGER NOT NULL DEFAULT 0,
      reported_requests INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      last_request_id TEXT,
      last_request_at INTEGER NOT NULL DEFAULT 0,
      last_cost_cents REAL,
      last_cost_reported INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ai_usage_requests (
      request_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      source TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      cost_cents REAL,
      cost_reported INTEGER NOT NULL DEFAULT 0,
      complete INTEGER NOT NULL,
      finished INTEGER NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_chat_time ON ai_usage_requests(chat_id, timestamp DESC);
  `)
  const totalsColumns = db.prepare('PRAGMA table_info(ai_usage_totals)').all() as Array<{ name: string }>
  if (!totalsColumns.some(column => column.name === 'reported_requests')) {
    db.exec('ALTER TABLE ai_usage_totals ADD COLUMN reported_requests INTEGER NOT NULL DEFAULT 0')
  }
  if (!totalsColumns.some(column => column.name === 'last_cost_reported')) {
    db.exec('ALTER TABLE ai_usage_totals ADD COLUMN last_cost_reported INTEGER NOT NULL DEFAULT 0')
  }
  const requestColumns = db.prepare('PRAGMA table_info(ai_usage_requests)').all() as Array<{ name: string }>
  if (!requestColumns.some(column => column.name === 'cost_reported')) {
    db.exec('ALTER TABLE ai_usage_requests ADD COLUMN cost_reported INTEGER NOT NULL DEFAULT 0')
  }
}
