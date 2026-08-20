import type Database from 'better-sqlite3'
import { migrateChatsToProjects, migrateLegacyMemoryToMemoryItems } from './dataMigrations'

/** Инкрементальные миграции: ALTER TABLE, новые таблицы, data-миграции. */
export function runIncrementalMigrations(db: Database.Database): void {
  // Backfill messages_fts существующими сообщениями (одноразово при первом запуске).
  // Проверяем по messages_fts — если пусто, а messages нет — заполняем.
  {
    const ftsCount = (db.prepare(`SELECT COUNT(*) as c FROM messages_fts`).get() as { c: number }).c
    const msgCount = (db.prepare(`SELECT COUNT(*) as c FROM messages`).get() as { c: number }).c
    if (ftsCount === 0 && msgCount > 0) {
      const insertFts = db.prepare(
        `INSERT INTO messages_fts(content, message_id, chat_id, role, created_at)
         SELECT content, id, chat_id, role, created_at FROM messages
         WHERE role IN ('user','assistant','system')`
      )
      const t0 = Date.now()
      insertFts.run()
      console.log(`[migrations] messages_fts: backfilled ${msgCount} messages in ${Date.now() - t0}ms`)
    }
  }

  // Backfill chat_summaries_fts существующими резюме (одноразово при первом запуске).
  {
    const ftsCount = (db.prepare(`SELECT COUNT(*) as c FROM chat_summaries_fts`).get() as { c: number }).c
    const csCount = (db.prepare(`SELECT COUNT(*) as c FROM chat_summaries`).get() as { c: number }).c
    if (ftsCount === 0 && csCount > 0) {
      const t0 = Date.now()
      db.prepare(
        `INSERT INTO chat_summaries_fts(content, chat_id) SELECT content, chat_id FROM chat_summaries`
      ).run()
      console.log(`[migrations] chat_summaries_fts: backfilled ${csCount} summaries in ${Date.now() - t0}ms`)
    }
  }

  // Автомиграция: добавляем relevance_boost колонку для существующих БД.
  // PRAGMA table_info возвращает колонки; если relevance_boost нет — ALTER TABLE ADD COLUMN.
  {
    const cols = db.prepare(`PRAGMA table_info(fast_context_index)`).all() as Array<{ name: string }>
    if (!cols.find(c => c.name === 'relevance_boost')) {
      db.exec(`ALTER TABLE fast_context_index ADD COLUMN relevance_boost REAL NOT NULL DEFAULT 0`)
    }
    if (!cols.find(c => c.name === 'embedding')) {
      db.exec(`ALTER TABLE fast_context_index ADD COLUMN embedding BLOB`)
    }
    // content_hash — быстрый content hash (FNV-1a первых 4KB + size) для точного
    // детекта изменений вместо mtime+size (mtime может меняться без content change).
    if (!cols.find(c => c.name === 'content_hash')) {
      db.exec(`ALTER TABLE fast_context_index ADD COLUMN content_hash INTEGER NOT NULL DEFAULT 0`)
    }
  }

  // Автомиграция: для каждого уникального workdir из chats создаём проект
  // и привязываем чаты к нему. workdir на chats остаётся как денормализованный
  // кэш для обратной совместимости, но источник правды теперь — projects.
  migrateChatsToProjects(db)

  // Миграция памяти: переносим старую memory table (key-value факты) в
  // новую унифицированную memory_items. Идемпотентна — повторный запуск
  // не дублирует (проверка по metadata->legacy_id).
  migrateLegacyMemoryToMemoryItems(db)

  // Автомиграция: добавляем title колонку к memory_items (если ещё нет).
  // Для существующих записей без title — переносим content в title
  // (как fallback, чтобы UI показывал что-то осмысленное).
  {
    const miCols = db.prepare(`PRAGMA table_info(memory_items)`).all() as { name: string }[]
    if (!miCols.find(c => c.name === 'title')) {
      db.prepare(`ALTER TABLE memory_items ADD COLUMN title TEXT`).run()
      // Backfill: для существующих записей без title — переносим content (truncate 100)
      db.prepare(`UPDATE memory_items SET title = SUBSTR(content, 1, 100) WHERE title IS NULL`).run()
    }
  }

  // ── memory_fts: FTS5 trigram индекс по memory_items (title + content) ──────
  // Схема (таблица + триггеры) создаётся в initialSchema (CREATE IF NOT EXISTS
  // выполняется и на существующих БД при каждом старте). Здесь — одноразовый
  // backfill существующих записей: триггеры срабатывают только на новые записи.
  {
    const ftsCount = (db.prepare(`SELECT COUNT(*) as c FROM memory_fts`).get() as { c: number }).c
    const miCount = (db.prepare(`SELECT COUNT(*) as c FROM memory_items`).get() as { c: number }).c
    if (ftsCount === 0 && miCount > 0) {
      const t0 = Date.now()
      db.prepare(
        `INSERT INTO memory_fts(title, content, item_id) SELECT title, content, id FROM memory_items`
      ).run()
      console.log(`[migrations] memory_fts: backfilled ${miCount} memory items in ${Date.now() - t0}ms`)
    }
  }

  // Автомиграция: name колонка в chat_checkpoints — для именованных снапшотов
  // (/snapshot <name>). NULL у обычных чекпоинтов (auto-checkpoint на каждый turn).
  // Именованные снапшоты — поименованные точки отката, которые пользователь
  // явно создал и может восстановить через /restore <name>.
  {
    const ccCols = db.prepare(`PRAGMA table_info(chat_checkpoints)`).all() as { name: string }[]
    if (!ccCols.find(c => c.name === 'name')) {
      db.prepare(`ALTER TABLE chat_checkpoints ADD COLUMN name TEXT`).run()
    }
  }

  // Автомиграция: добавляем role колонку к subagents — для специализированных
  // суб-агентов (researcher, deep-researcher, editor, implementer, reviewer).
  // NULL у старых записей → getSubagentRole(null) → implementer (default).
  {
    const subCols = db.prepare(`PRAGMA table_info(subagents)`).all() as { name: string }[]
    if (!subCols.find(c => c.name === 'role')) {
      db.prepare(`ALTER TABLE subagents ADD COLUMN role TEXT`).run()
    }
  }

  // ── Attachments ──────────────────────────────────────────────────────────
  // Колонка attachments в messages — JSON-массив Attachment[] (метаданные для
  // рендера чипов над отправленным сообщением). Текстовое содержимое уже
  // инлайнилось в content при отправке — здесь только UI-метаданные.
  {
    const cols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]
    if (!cols.find(c => c.name === 'attachments')) {
      db.prepare(`ALTER TABLE messages ADD COLUMN attachments TEXT`).run()
    }
    // Колонка attachment_result — JSON AttachmentProcessingResult (для
    // AttachmentProcessingBlock в сохранённом сообщении). Заполняется только у
    // user-сообщений с attachments, прошедших processAttachmentsAndStream.
    if (!cols.find(c => c.name === 'attachment_result')) {
      db.prepare(`ALTER TABLE messages ADD COLUMN attachment_result TEXT`).run()
    }
    // thinking_blocks — JSON массив [{thinking, signature}] для Anthropic
    // extended thinking. Без signatures Anthropic API отвергает thinking
    // blocks при resubmission в следующем раунде. Поле хранит signatures,
    // чтобы после перезахода в чат агент мог продолжить с extended thinking.
    if (!cols.find(c => c.name === 'thinking_blocks')) {
      db.prepare(`ALTER TABLE messages ADD COLUMN thinking_blocks TEXT`).run()
    }
  }

  // chat_draft_attachments — вложения черновика (переживают рестарт, не
  // пропадают при смене чата). Картинки хранятся как файлы в
  // userData/draft-attachments/{chatId}/, в БД — только путь + метаданные.
  // Текстовые файлы из @mention хранят только путь (содержимое читается
  // при отправке). DELETE CASCADE — удаляем при удалении чата.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_draft_attachments (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      name        TEXT NOT NULL,
      path        TEXT,
      rel_path    TEXT,
      mime        TEXT,
      size        INTEGER,
      source      TEXT NOT NULL,
      data_url    TEXT,
      skill_id    TEXT,
      command_name TEXT,
      snippet     TEXT,
      attached_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cda_chat ON chat_draft_attachments(chat_id);
  `)

  // ── Notes: заметки двух типов ──────────────────────────────────────────────
  // project — видны во всех чатах проекта, AI видит их в системном промпте.
  // chat — привязаны к конкретному чату, видны только в нём.
  // FK CASCADE: удаление проекта → удаляются проектные заметки,
  //             удаление чата → удаляются чат-заметки.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id          TEXT PRIMARY KEY,
      scope       TEXT NOT NULL CHECK(scope IN ('project','chat')),
      project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
      chat_id     TEXT REFERENCES chats(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id) WHERE scope='project';
    CREATE INDEX IF NOT EXISTS idx_notes_chat ON notes(chat_id) WHERE scope='chat';
  `)
}
