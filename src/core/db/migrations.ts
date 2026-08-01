import type Database from 'better-sqlite3'
import { basename } from 'path'
import { v4 as uuid } from 'uuid'

/**
 * Идемпотентная схема-миграция: CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN
 * с защитой через PRAGMA table_info. Порядок важен — см. комментарий у idx_chats_project_id.
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT 'Новый чат',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      is_incognito INTEGER NOT NULL DEFAULT 0,
      is_pinned   INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      color       TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      is_pinned   INTEGER NOT NULL DEFAULT 0,
      model       TEXT,
      tool_steps  TEXT
    );

    CREATE TABLE IF NOT EXISTS memory (
      id          TEXT PRIMARY KEY,
      category    TEXT NOT NULL DEFAULT 'general',
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_logs (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT,
      type        TEXT NOT NULL,
      tool        TEXT,
      args        TEXT,
      result      TEXT,
      error       TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clipboard_history (
      id          TEXT PRIMARY KEY,
      content     TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'text',
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pinned_messages (
      message_id  TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      pinned_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_working_memory (
      chat_id     TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      content     TEXT NOT NULL DEFAULT '',
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_summaries (
      chat_id     TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      content     TEXT NOT NULL DEFAULT '',
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      workdir         TEXT NOT NULL UNIQUE,
      project_context TEXT,
      verification_command TEXT,
      created_at      INTEGER NOT NULL,
      last_used       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category);
    CREATE INDEX IF NOT EXISTS idx_clipboard_created ON clipboard_history(created_at);
  `)

  // Миграция: добавляем tool_steps если колонки нет
  const cols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]
  if (!cols.find(c => c.name === 'tool_steps')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN tool_steps TEXT`).run()
  }
  if (!cols.find(c => c.name === 'thinking')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN thinking TEXT`).run()
  }
  if (!cols.find(c => c.name === 'thinking_ms')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN thinking_ms INTEGER`).run()
  }
  if (!cols.find(c => c.name === 'slash_command')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN slash_command TEXT`).run()
  }
  if (!cols.find(c => c.name === 'iterations')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN iterations TEXT`).run()
  }
  if (!cols.find(c => c.name === 'plan_data')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN plan_data TEXT`).run()
  }
  if (!cols.find(c => c.name === 'todo')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN todo TEXT`).run()
  }
  // Миграция: compact_summary — снимок резюме на момент сжатия контекста.
  // Заполняется только у system-сообщений-разделителей компакции
  // (slashCommand.name === 'compact'). Позволяет разворачивать старые
  // разделители даже после того, как chat_summaries перетёрся новым сжатием.
  if (!cols.find(c => c.name === 'compact_summary')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN compact_summary TEXT`).run()
  }
  // Миграция: compact_stats — JSON {removedCount, tokensBefore, tokensAfter,
  // tokensSaved} для compact-разделителей. Используется ContextRing для
  // подсчёта общего кол-ва сжатий и сэкономленных токенов сессии.
  if (!cols.find(c => c.name === 'compact_stats')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN compact_stats TEXT`).run()
  }
  // ── Per-message статистика ответа (для развёртываемой панели в UI) ──
  // duration_ms — полная длительность turn'а (мс). prompt/completion/cache —
  // реальные токены от провайдера (суммарно по всем LLM-вызовам turn'а).
  // tool_calls_count — число вызванных тулов. Заполняется только у
  // assistant-сообщений; null/0 для старых сообщений и user/system.
  if (!cols.find(c => c.name === 'duration_ms')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN duration_ms INTEGER`).run()
  }
  if (!cols.find(c => c.name === 'prompt_tokens')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN prompt_tokens INTEGER`).run()
  }
  if (!cols.find(c => c.name === 'completion_tokens')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN completion_tokens INTEGER`).run()
  }
  if (!cols.find(c => c.name === 'cache_read_tokens')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER`).run()
  }
  if (!cols.find(c => c.name === 'cache_write_tokens')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN cache_write_tokens INTEGER`).run()
  }
  if (!cols.find(c => c.name === 'tool_calls_count')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN tool_calls_count INTEGER`).run()
  }

  // Миграция: добавляем поля чатов
  const chatCols = db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[]
  if (!chatCols.find(c => c.name === 'is_pinned'))   db.prepare(`ALTER TABLE chats ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0`).run()
  if (!chatCols.find(c => c.name === 'is_archived')) db.prepare(`ALTER TABLE chats ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0`).run()
  if (!chatCols.find(c => c.name === 'color'))       db.prepare(`ALTER TABLE chats ADD COLUMN color TEXT`).run()
  if (!chatCols.find(c => c.name === 'mode'))        db.prepare(`ALTER TABLE chats ADD COLUMN mode TEXT NOT NULL DEFAULT 'code'`).run()
  // workdir — рабочая директория чата в режиме "Код" (NULL для Work-режима
  // и чатов, созданных до этой фичи). project_context — результат
  // analyzeProject(workdir) на момент создания чата; write-once, неизменяем.
  if (!chatCols.find(c => c.name === 'workdir'))          db.prepare(`ALTER TABLE chats ADD COLUMN workdir TEXT`).run()
  if (!chatCols.find(c => c.name === 'project_context'))  db.prepare(`ALTER TABLE chats ADD COLUMN project_context TEXT`).run()
  // project_id — FK на projects. Чаты без проекта (старые, инкогнито,
  // или созданные до этой фичи) имеют NULL → попадают в группу «Без проекта».
  if (!chatCols.find(c => c.name === 'project_id'))       db.prepare(`ALTER TABLE chats ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`).run()

  // ── Per-chat UI state: режимы инпут-бара (планирование/изображение/ask),
  // черновик (несохранённый текст в поле ввода) и история навигации по
  // стрелкам. Хранится на чат, переживает перезапуск приложения. Для
  // инкогнито-чатов эти колонки не пишутся (см. guard в ChatPage/IPC).
  if (!chatCols.find(c => c.name === 'planning_mode')) db.prepare(`ALTER TABLE chats ADD COLUMN planning_mode INTEGER NOT NULL DEFAULT 0`).run()
  if (!chatCols.find(c => c.name === 'image_mode'))    db.prepare(`ALTER TABLE chats ADD COLUMN image_mode INTEGER NOT NULL DEFAULT 0`).run()
  if (!chatCols.find(c => c.name === 'ask_mode'))      db.prepare(`ALTER TABLE chats ADD COLUMN ask_mode INTEGER NOT NULL DEFAULT 0`).run()
  if (!chatCols.find(c => c.name === 'draft'))         db.prepare(`ALTER TABLE chats ADD COLUMN draft TEXT`).run()
  // last_usage — JSON последнего реального usage от провайдера
  // {promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens, ts}.
  // Переживает перезапуск: context:calculate читает его, чтобы показывать
  // точный контекст после перезахода в чат (tiktoken-оценка без этого
  // занижает: не знает про tool schemas overhead, reasoning и т.д.).
  if (!chatCols.find(c => c.name === 'last_usage'))   db.prepare(`ALTER TABLE chats ADD COLUMN last_usage TEXT`).run()

  // Миграция: verification_command на projects — команда авто-проверки
  // (напр. "npm test"), запускаемая после серии успешных правок файлов.
  const projectCols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
  if (!projectCols.find(c => c.name === 'verification_command')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN verification_command TEXT`).run()
  }

  // Индекс по project_id — создаём ПОСЛЕ миграции (колонка добавлена выше).
  // В db.exec() этот индекс создавать нельзя: на момент выполнения первого
  // блока колонки project_id ещё нет, и CREATE INDEX роняет всю миграцию.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_project_id ON chats(project_id);`)

  // === Checkpoint/rewind: file_snapshots + context_snapshots + chat_checkpoints ===
  // Три таблицы для отката сессии к произвольному user-сообщению:
  //  - file_snapshots: {path, content_before} для каждого файла, изменённого
  //    в turn'е. content_before NULL = файл был создан этим turn'ом.
  //  - context_snapshots: состояние chat_working_memory/chat_summaries НА
  //    МОМЕНТ ДО turn'а — чтобы rewind восстановил контекст корректно.
  //  - chat_checkpoints: плоский список точек отката для UI-таймлайна.
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_snapshots (
      id              TEXT PRIMARY KEY,
      chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      message_id      TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      path            TEXT NOT NULL,
      content_before  TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fs_chat ON file_snapshots(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_fs_user ON file_snapshots(chat_id, user_message_id);

    CREATE TABLE IF NOT EXISTS context_snapshots (
      id              TEXT PRIMARY KEY,
      chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL,
      working_memory  TEXT,
      chat_summary    TEXT,
      message_count   INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cs_user ON context_snapshots(chat_id, user_message_id);

    CREATE TABLE IF NOT EXISTS chat_checkpoints (
      id                  TEXT PRIMARY KEY,
      chat_id             TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_message_id     TEXT NOT NULL,
      assistant_message_id TEXT,
      user_prompt_preview TEXT,
      files_changed       INTEGER NOT NULL DEFAULT 0,
      file_paths          TEXT,
      created_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cc_chat ON chat_checkpoints(chat_id, created_at);
    CREATE TABLE IF NOT EXISTS rewind_history (
      id                  TEXT PRIMARY KEY,
      chat_id             TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      rewind_message_id   TEXT NOT NULL,
      deleted_messages    TEXT NOT NULL,
      file_changes        TEXT NOT NULL,
      restored_checkpoint_user_msg_id TEXT NOT NULL,
      created_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rh_chat ON rewind_history(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_rh_rewind ON rewind_history(rewind_message_id);

    -- Fast Context: tree-sitter индекс символов проекта для быстрого
    -- retrieval релевантных файлов по запросу (тулза get_fast_context).
    -- Один ряд = один файл проекта с его символами и метаданными для
    -- инвалидации по mtime+size. ranked_score — PageRank-style важность.
    CREATE TABLE IF NOT EXISTS fast_context_index (
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path       TEXT NOT NULL,
      lang            TEXT,
      symbols_json    TEXT,
      mtime           INTEGER NOT NULL DEFAULT 0,
      size            INTEGER NOT NULL DEFAULT 0,
      ranked_score    REAL NOT NULL DEFAULT 0,
      relevance_boost REAL NOT NULL DEFAULT 0,
      embedding       BLOB,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY(project_id, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_fci_project ON fast_context_index(project_id);
    CREATE INDEX IF NOT EXISTS idx_fci_score ON fast_context_index(project_id, ranked_score DESC);

    -- История обновлений индекса (для модалки статуса проекта).
    -- Храним последние ~50 событий на проект, старые пруним автоматически.
    CREATE TABLE IF NOT EXISTS fast_context_index_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      event_type    TEXT NOT NULL,        -- 'full' | 'incremental' | 'manual' | 'clear'
      files_count   INTEGER NOT NULL,     -- файлов в индексе после события
      files_changed INTEGER NOT NULL,     -- сколько файлов переиндексировано
      duration_ms   INTEGER NOT NULL,     -- сколько заняло
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fcih_project ON fast_context_index_history(project_id, created_at DESC);

    -- === Advanced memory: унифицированная таблица памяти ===
    -- 5 типов памяти (kind): user_fact | project_decision | convention | conversation | agent_outcome
    -- 3 scope: global (сквозная) | project (привязана к проекту) | chat (только чат)
    -- embedding: 384-dim Float32 BLOB (TF-IDF default, neural opt-in)
    -- importance + access_count + last_accessed_at: для recency-boost и forget-policy
    -- pinned: 1 = защищено от decay-prune (user_explicit source auto-pinned)
    CREATE TABLE IF NOT EXISTS memory_items (
      id               TEXT PRIMARY KEY,
      scope            TEXT NOT NULL,        -- 'global' | 'project' | 'chat'
      project_id       TEXT REFERENCES projects(id) ON DELETE CASCADE,
      chat_id          TEXT REFERENCES chats(id) ON DELETE CASCADE,
      kind             TEXT NOT NULL,        -- 'user_fact' | 'project_decision' | 'convention' | 'conversation' | 'agent_outcome'
      category         TEXT,                 -- 'personal'|'work'|'preferences'|'projects'|'facts' (для user_fact)
      key              TEXT,                 -- dedup-ключ ('name','preferred_stack')
      content          TEXT NOT NULL,
      source           TEXT NOT NULL,        -- 'user_explicit'|'agent_tool'|'auto_extract'|'compaction'|'agent_log'
      confidence       REAL NOT NULL DEFAULT 1.0,
      importance       REAL NOT NULL DEFAULT 0.5,
      access_count     INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER,
      pinned           INTEGER NOT NULL DEFAULT 0,
      embedding        BLOB,
      metadata         TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mi_scope ON memory_items(scope);
    CREATE INDEX IF NOT EXISTS idx_mi_kind ON memory_items(kind);
    CREATE INDEX IF NOT EXISTS idx_mi_project ON memory_items(project_id);
    CREATE INDEX IF NOT EXISTS idx_mi_dedup ON memory_items(scope, key);
    CREATE INDEX IF NOT EXISTS idx_mi_access ON memory_items(last_accessed_at);

    -- === Динамические категории памяти ===
    -- Кастомные категории (global или project-scoped) для организации памяти
    -- "по полочкам". Builtin категории (personal/work/preferences/projects/facts)
    -- не хранятся тут — они дефолтные. Сюда попадают только пользовательские.
    -- project_id NULL = глобальная категория (доступна везде).
    CREATE TABLE IF NOT EXISTS memory_categories (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,             -- машинное имя (lowercase, для category field)
      label       TEXT NOT NULL,             -- человекочитаемое
      icon        TEXT,                      -- имя иконки из AppIcon (опционально)
      color       TEXT,                      -- hex цвет (опционально)
      scope       TEXT NOT NULL DEFAULT 'global',  -- 'global' | 'project'
      project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
      kind        TEXT,                      -- фильтр по kind (опционально, null = любой)
      created_at  INTEGER NOT NULL,
      UNIQUE(scope, project_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_mc_scope ON memory_categories(scope);
    CREATE INDEX IF NOT EXISTS idx_mc_project ON memory_categories(project_id);

    -- === Knowledge Graph: per-project граф сущностей и связей ===
    -- 6 типов узлов: decision | concept | file | symbol | conversation | task
    -- 9 типов рёбер: affects | mentions | implemented_in | depends_on | supersedes
    --               | references | imports | calls | implements
    -- weight: степень важности (boost от access_count, pinned, LLM confidence)
    -- source_id: ID источника (memory_items.id, file_path, msg.id, etc.)
    -- project-scoped: каждый узел/ребро привязан к project_id
    CREATE TABLE IF NOT EXISTS memory_graph_nodes (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type             TEXT NOT NULL,  -- 'decision'|'concept'|'file'|'symbol'|'conversation'|'task'
      label            TEXT NOT NULL,  -- display name (filepath, concept name, decision summary)
      source_kind      TEXT,           -- 'memory_item'|'fast_context'|'message'|'chat_summary'|'llm_extract'|'manual'
      source_id        TEXT,           -- ID источника (memory_items.id, file_path, msg.id)
      metadata         TEXT,           -- JSON (path, line range, kind, evidence, ...)
      weight           REAL NOT NULL DEFAULT 1.0,
      access_count     INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER,
      pinned           INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      UNIQUE(project_id, type, label)
    );
    CREATE INDEX IF NOT EXISTS idx_mgn_project ON memory_graph_nodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_mgn_type ON memory_graph_nodes(project_id, type);
    CREATE INDEX IF NOT EXISTS idx_mgn_source ON memory_graph_nodes(source_kind, source_id);

    CREATE TABLE IF NOT EXISTS memory_graph_edges (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      from_node   TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      to_node     TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,  -- 'affects'|'mentions'|'implemented_in'|'depends_on'|'supersedes'|'references'|'imports'|'calls'|'implements'
      weight      REAL NOT NULL DEFAULT 1.0,
      metadata    TEXT,           -- JSON (context, evidence)
      created_at  INTEGER NOT NULL,
      UNIQUE(project_id, from_node, to_node, type)
    );
    CREATE INDEX IF NOT EXISTS idx_mge_project ON memory_graph_edges(project_id);
    CREATE INDEX IF NOT EXISTS idx_mge_from ON memory_graph_edges(from_node);
    CREATE INDEX IF NOT EXISTS idx_mge_to ON memory_graph_edges(to_node);
    CREATE INDEX IF NOT EXISTS idx_mge_type ON memory_graph_edges(project_id, type);

    -- === FTS5 полнотекстовый поиск по messages ===
    -- Используется recall_memory для поиска по истории чатов проекта.
    -- tokenize='trigram' — подстрочный поиск (находит 'авториз' в 'авторизация'),
    -- работает для любых языков. message_id/chat_id/role/created_at — UNINDEXED
    -- (хранятся для JOIN, но не участвуют в поиске).
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      message_id UNINDEXED,
      chat_id UNINDEXED,
      role UNINDEXED,
      created_at UNINDEXED,
      tokenize='trigram'
    );

    -- Триггеры: авто-синхронизация messages_fts при INSERT/UPDATE/DELETE messages.
    -- Только user/assistant/system роли индексируются (на всякий случай).
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
      WHEN new.role IN ('user','assistant','system')
      BEGIN
        INSERT INTO messages_fts(content, message_id, chat_id, role, created_at)
        VALUES (new.content, new.id, new.chat_id, new.role, new.created_at);
      END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
      BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
      END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages
      WHEN new.role IN ('user','assistant','system')
      BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
        INSERT INTO messages_fts(content, message_id, chat_id, role, created_at)
        VALUES (new.content, new.id, new.chat_id, new.role, new.created_at);
      END;
  `)

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

  // ── Attachments ──────────────────────────────────────────────────────────
  // Колонка attachments в messages — JSON-массив Attachment[] (метаданные для
  // рендера чипов над отправленным сообщением). Текстовое содержимое уже
  // инлайнилось в content при отправке — здесь только UI-метаданные.
  if (!cols.find(c => c.name === 'attachments')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN attachments TEXT`).run()
  }
  // Колонка attachment_result — JSON AttachmentProcessingResult (для
  // AttachmentProcessingBlock в сохранённом сообщении). Заполняется только у
  // user-сообщений с attachments, прошедших processAttachmentsAndStream.
  if (!cols.find(c => c.name === 'attachment_result')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN attachment_result TEXT`).run()
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
}

/**
 * Переносит существующие chats.workdir в таблицу projects: для каждого
 * уникального workdir создаёт проект (имя = basename папки), чатам
 * проставляет project_id. Идемпотентна — повторный запуск не дублирует.
 */
function migrateChatsToProjects(db: Database.Database): void {
  const rows = db.prepare(`SELECT DISTINCT workdir FROM chats WHERE workdir IS NOT NULL AND project_id IS NULL`).all() as { workdir: string }[]
  if (rows.length === 0) return
  const now = Date.now()
  for (const { workdir } of rows) {
    // Проверяем, есть ли уже проект с таким workdir (UNIQUE constraint)
    const existing = db.prepare(`SELECT id FROM projects WHERE workdir = ?`).get(workdir) as { id: string } | undefined
    const projectId = existing?.id ?? uuid()
    if (!existing) {
      const name = basename(workdir) || workdir
      const projectContext = db.prepare(`SELECT project_context FROM chats WHERE workdir = ? AND project_context IS NOT NULL LIMIT 1`).get(workdir) as { project_context: string } | undefined
      db.prepare(`INSERT INTO projects (id, name, workdir, project_context, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(projectId, name, workdir, projectContext?.project_context ?? null, now, now)
    }
    db.prepare(`UPDATE chats SET project_id = ? WHERE workdir = ? AND project_id IS NULL`).run(projectId, workdir)
  }
}

/**
 * Переносит старую memory table (key-value: category/key/value) в новую
 * унифицированную memory_items. Идемпотентна — повторный запуск не дублирует
 * (проверяем по metadata->legacy_id, чтобы не мигрировать дважды).
 *
 * Старая memory table оставлена в схеме до Фазы 2 (не дропаем сразу, чтобы
 * можно было откатиться). В Фазе 2, когда MemoryEngine.ts будет удалён и
 * все потребители перейдут на MemoryStore, можно будет DROP TABLE memory.
 *
 * Embedding НЕ считается при миграции (TF-IDF требует IDF-кэш, который ещё
 * не построен). MemoryStore.save() пересчитает embedding при первом update,
 * либо отдельная команда реиндекса в UI. Поиск работает и без embeddings
 * (fallback на LIKE по content), просто менее точно.
 */
function migrateLegacyMemoryToMemoryItems(db: Database.Database): void {
  // Проверяем, есть ли что мигрировать
  const legacyExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='memory'`
  ).get() as { name: string } | undefined
  if (!legacyExists) return

  const legacyRows = db.prepare(
    `SELECT id, category, key, value, created_at, updated_at FROM memory`
  ).all() as Array<{ id: string; category: string; key: string; value: string; created_at: number; updated_at: number }>

  if (legacyRows.length === 0) return

  // Проверяем, не мигрировали ли уже (по metadata->legacy_id)
  // Простой подход: если в memory_items есть хоть одна запись с source='legacy_migration',
  // считаем что миграция уже была.
  const alreadyMigrated = db.prepare(
    `SELECT 1 FROM memory_items WHERE source = 'legacy_migration' LIMIT 1`
  ).get() as { 1: number } | undefined
  if (alreadyMigrated) return

  const insert = db.prepare(
    `INSERT INTO memory_items (id, title, scope, project_id, chat_id, kind, category, key, content, source, confidence, importance, access_count, last_accessed_at, pinned, embedding, metadata, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, 'user_fact', ?, ?, ?, 'legacy_migration', 1.0, 0.6, 0, NULL, 1, NULL, ?, ?, ?)`
  )

  const migrateAll = db.transaction((rows: typeof legacyRows) => {
    for (const row of rows) {
      // legacy_id в metadata для идемпотентности
      const metadata = JSON.stringify({ legacy_id: row.id })
      // title = row.value (truncate 100), content = row.value
      const title = row.value.slice(0, 100)
      // Новый UUID, scope='global' (старая память не была привязана к проектам)
      insert.run(uuid(), title, 'global', row.category || 'facts', row.key, row.value, metadata, row.created_at, row.updated_at)
    }
  })
  migrateAll(legacyRows)

  console.log(`[migrations] memory_items: migrated ${legacyRows.length} rows from legacy memory table`)
}
