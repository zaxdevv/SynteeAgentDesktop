import type Database from 'better-sqlite3'

/** Начальная схема БД: CREATE TABLE IF NOT EXISTS + индексы + триггеры FTS5. */
export function runInitialSchema(db: Database.Database): void {
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

    CREATE TABLE IF NOT EXISTS mcp_result_cache (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      text TEXT NOT NULL,
      original_chars INTEGER NOT NULL,
      bytes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_result_chat ON mcp_result_cache(chat_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_result_message ON mcp_result_cache(message_id);
    CREATE TRIGGER IF NOT EXISTS mcp_result_message_deleted AFTER DELETE ON messages BEGIN
      DELETE FROM mcp_result_cache WHERE message_id=OLD.id AND chat_id=OLD.chat_id;
    END;

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
    -- Composite index для cursor-based пагинации (getMessagesPage):
    -- WHERE chat_id=? AND (created_at < ? OR (created_at = ? AND id < ?))
    -- ORDER BY created_at DESC, id DESC
    -- Без этого индекса SQLite делает full scan по chat_id + filesort.
    CREATE INDEX IF NOT EXISTS idx_messages_chat_cursor ON messages(chat_id, created_at DESC, id DESC);
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
  // finish_reason — как завершился turn ('done' | 'stopped' | 'error').
  // Позволяет UI помечать оборванные сообщения (Стоп/краш) и сохранять
  // накопленную статистику токенов даже при незавершённом стриме.
  if (!cols.find(c => c.name === 'finish_reason')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN finish_reason TEXT`).run()
  }
  // streaming_ms — чистое время генерации токенов (без тулов/обработки
  // промпта). Для честной скорости ток/с в панели статистики.
  if (!cols.find(c => c.name === 'streaming_ms')) {
    db.prepare(`ALTER TABLE messages ADD COLUMN streaming_ms INTEGER`).run()
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
  // browser_mode — тумблер «Управление браузером» (browser_* тулы для AI).
  // Включается вручную (плюс-меню) или через подтверждение request_access.
  if (!chatCols.find(c => c.name === 'browser_mode'))  db.prepare(`ALTER TABLE chats ADD COLUMN browser_mode INTEGER NOT NULL DEFAULT 0`).run()
  if (!chatCols.find(c => c.name === 'draft'))         db.prepare(`ALTER TABLE chats ADD COLUMN draft TEXT`).run()
  // last_usage — JSON последнего реального usage от провайдера
  // {promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens, ts}.
  // Переживает перезапуск: context:calculate читает его, чтобы показывать
  // точный контекст после перезахода в чат (tiktoken-оценка без этого
  // занижает: не знает про tool schemas overhead, reasoning и т.д.).
  if (!chatCols.find(c => c.name === 'last_usage'))   db.prepare(`ALTER TABLE chats ADD COLUMN last_usage TEXT`).run()
  // model_id / model_provider — per-chat модель (NULL = использовать глобальное
  // назначение role:'main' из electron-store). Новый чат наследует модель чата,
  // из которого он создан; смена модели в чате пишется сюда, а не в глобальный
  // store (см. chat:setModel в chat.ipc.ts).
  if (!chatCols.find(c => c.name === 'model_id'))      db.prepare(`ALTER TABLE chats ADD COLUMN model_id TEXT`).run()
  if (!chatCols.find(c => c.name === 'model_provider')) db.prepare(`ALTER TABLE chats ADD COLUMN model_provider TEXT`).run()
  // reasoning_value — per-chat уровень мышления (NULL = глобальный
  // settings.reasoningValue). Как и модель: наследуется при создании чата,
  // восстанавливается при переключении. Без этого ReasoningSelector при
  // смене модели сбрасывал значение на дефолт и затирал глобальную настройку.
  if (!chatCols.find(c => c.name === 'reasoning_value')) db.prepare(`ALTER TABLE chats ADD COLUMN reasoning_value TEXT`).run()
  // Самолечение: чаты, созданные с багом наследования (model_id без
  // model_provider — key mismatch providerId/modelProvider в createNewChat).
  // getChatModel требует оба поля; без провайдера модель не резолвится.
  // Очищаем model_id у таких строк — чат честно использует глобальную.
  db.prepare(`UPDATE chats SET model_id = NULL WHERE model_id IS NOT NULL AND model_provider IS NULL`).run()

  // Миграция: verification_command на projects — команда авто-проверки
  // (напр. "npm test"), запускаемая после серии успешных правок файлов.
  const projectCols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
  if (!projectCols.find(c => c.name === 'verification_command')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN verification_command TEXT`).run()
  }

  // Миграция: context_files — JSON-массив путей к .md файлам, которые
  // автоматически подгружаются в системный промпт (AGENTS.md, кастомные).
  // auto_discover_instructions — вкл/выкл авто-дискавери стандартных файлов.
  if (!projectCols.find(c => c.name === 'context_files')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN context_files TEXT`).run()
  }
  if (!projectCols.find(c => c.name === 'auto_discover_instructions')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN auto_discover_instructions INTEGER NOT NULL DEFAULT 1`).run()
  }
  // disabled_discovery_files — JSON-массив стандартных файлов, отключённых
  // из авто-дискавери (AGENTS.md, CLAUDE.md, .syntee/instructions.md).
  // Позволяет пользователю выборочно отключать файлы из детекта.
  if (!projectCols.find(c => c.name === 'disabled_discovery_files')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN disabled_discovery_files TEXT`).run()
  }
  if (!projectCols.find(c => c.name === 'color')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN color TEXT`).run()
  }
  if (!projectCols.find(c => c.name === 'icon')) {
    db.prepare(`ALTER TABLE projects ADD COLUMN icon TEXT`).run()
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

    -- === FTS5 полнотекстовый поиск по memory_items ===
    -- Второй канал поиска памяти (первый — TF-IDF cosine). Trigram-токенайзер
    -- находит морфологические варианты ('улучшени' матчит 'улучшение/улучшения'),
    -- что критично для русского языка, и даёт кандидатов вне top-500 importance.
    -- item_id UNINDEXED — хранится для JOIN, не участвует в поиске.
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      title,
      content,
      item_id UNINDEXED,
      tokenize='trigram'
    );

    -- Триггеры: авто-синхронизация memory_fts при INSERT/UPDATE/DELETE memory_items.
    -- UPDATE-триггер только на title/content — bump access_count/importance
    -- не пересоздаёт FTS-строку.
    CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_items
      BEGIN
        INSERT INTO memory_fts(title, content, item_id)
        VALUES (new.title, new.content, new.id);
      END;

    CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_items
      BEGIN
        DELETE FROM memory_fts WHERE item_id = old.id;
      END;

    CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE OF title, content ON memory_items
      BEGIN
        DELETE FROM memory_fts WHERE item_id = old.id;
        INSERT INTO memory_fts(title, content, item_id)
        VALUES (new.title, new.content, new.id);
      END;

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
      source_kind      TEXT,           -- 'memory_item'|'message'|'chat_summary'|'llm_extract'|'manual'
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

    -- === Subagents: персистентные записи суб-агентов ===
    -- AgentManager хранит running-агентов in-memory, но после рестарта приложения
    -- воркеры мертвы. Таблица позволяет восстановить карточки саб-агентов в чате
    -- (AgentCardLive читает agent:get) и сохранить полный ToolChain в AgentPanel.
    -- FK ON DELETE CASCADE — при удалении чата подчищаются и его саб-агенты.
    -- steps — JSON AgentStep[] (полные, с content/diff/toolArgs).
    CREATE TABLE IF NOT EXISTS subagents (
      id             TEXT PRIMARY KEY,
      parent_id      TEXT,
      chat_id        TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      task           TEXT NOT NULL,
      status         TEXT NOT NULL,
      model          TEXT,
      mode           TEXT,
      steps          TEXT,
      result         TEXT,
      summary        TEXT,
      created_at     INTEGER NOT NULL,
      finished_at    INTEGER,
      error          TEXT,
      workdir        TEXT,
      isolation_mode TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subagents_chat ON subagents(chat_id);
    CREATE INDEX IF NOT EXISTS idx_subagents_parent ON subagents(parent_id);

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

    -- === FTS5 полнотекстовый поиск по chat_summaries ===
    -- Используется recall_memory для поиска по резюме прошлых диалогов.
    -- Резюме — самый контентный источник (сжатые итоги длинных чатов).
    -- tokenize='trigram' — морфология + подстрочный поиск для любых языков.
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_summaries_fts USING fts5(
      content,
      chat_id UNINDEXED,
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS chat_summaries_fts_ai AFTER INSERT ON chat_summaries
      BEGIN
        INSERT INTO chat_summaries_fts(content, chat_id)
        VALUES (new.content, new.chat_id);
      END;

    CREATE TRIGGER IF NOT EXISTS chat_summaries_fts_ad AFTER DELETE ON chat_summaries
      BEGIN
        DELETE FROM chat_summaries_fts WHERE chat_id = old.chat_id;
      END;

    CREATE TRIGGER IF NOT EXISTS chat_summaries_fts_au AFTER UPDATE OF content ON chat_summaries
      BEGIN
        DELETE FROM chat_summaries_fts WHERE chat_id = old.chat_id;
        INSERT INTO chat_summaries_fts(content, chat_id)
        VALUES (new.content, new.chat_id);
      END;

    -- === Semantic embeddings (E5) для recall_memory ===
    -- Фоновая индексация всех 5 источников (memory/messages/summaries/
    -- agent_logs/pinned) моделью Xenova/multilingual-e5-small (384-dim Float32).
    -- Заполняется semanticIndex.ts (lazy, идемпотентно, с паузами).
    --   content_hash — sha256 индексируемого текста: неизменённые строки
    --                 НЕ переэмбеддятся (O(changed), не O(N) на каждом цикле).
    --   model        — инвалидация векторов при смене модели (hash совпал,
    --                 модель другая → пересчёт).
    --   PK(source, source_id) — идемпотентный upsert (INSERT OR REPLACE).
    -- Индексируются ВСЕ строки без scope-фильтра — фильтрация по проекту
    -- происходит на этапе поиска (как в chatSearch/search.ts).
    -- CREATE TABLE IF NOT EXISTS — безопасно для существующих БД (миграция
    -- идемпотентна, запускается на каждом старте через runMigrations).
    CREATE TABLE IF NOT EXISTS semantic_embeddings (
      source       TEXT NOT NULL,   -- 'memory'|'messages'|'summaries'|'agent_logs'|'pinned'
      source_id    TEXT NOT NULL,   -- PK строки источника (memory_items.id, messages.id, chat_id, ...)
      content_hash TEXT NOT NULL,   -- sha256 индексируемого текста
      embedding    BLOB NOT NULL,   -- 384-dim Float32, L2-normalized (E5 passage)
      model        TEXT NOT NULL,   -- 'Xenova/multilingual-e5-small'
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY(source, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_se_model ON semantic_embeddings(model);
    CREATE INDEX IF NOT EXISTS idx_se_updated ON semantic_embeddings(updated_at);
  `)
}
