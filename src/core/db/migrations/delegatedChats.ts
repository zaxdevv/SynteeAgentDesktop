import type Database from 'better-sqlite3'

export function runDelegatedChatSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delegated_chats (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      parent_chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegated_parent ON delegated_chats(parent_chat_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS delegated_chat_requests (
      request_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      source_chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('starting','queued','running','done','error','cancelled','interrupted')),
      error TEXT,
      task TEXT NOT NULL DEFAULT '',
      source_message_id TEXT NOT NULL DEFAULT '',
      read_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegated_requests_chat ON delegated_chat_requests(chat_id, created_at DESC);
  `)
  const chatColumns = new Set((db.prepare('PRAGMA table_info(delegated_chats)').all() as Array<{ name: string }>).map(c => c.name))
  if (!chatColumns.has('source_message_id')) db.exec("ALTER TABLE delegated_chats ADD COLUMN source_message_id TEXT NOT NULL DEFAULT ''")
  const columns = new Set((db.prepare('PRAGMA table_info(delegated_chat_requests)').all() as Array<{ name: string }>).map(c => c.name))
  for (const [name, definition] of [['task', "TEXT NOT NULL DEFAULT ''"], ['source_message_id', "TEXT NOT NULL DEFAULT ''"], ['read_at', 'INTEGER']] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE delegated_chat_requests ADD COLUMN ${name} ${definition}`)
  }
}
