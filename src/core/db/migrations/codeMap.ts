import type Database from 'better-sqlite3'

/**
 * Схема графа кода проекта (project map). Отдельна от memory_graph_*: граф кода
 * детерминированный, пересобирается из файлов, ключуется по (project_id, path).
 * Идемпотентна — CREATE TABLE IF NOT EXISTS.
 */
export function runCodeMapSchema(db: Database.Database): void {
  db.transaction(() => migrateCodeMap(db))()
}

function migrateCodeMap(db: Database.Database): void {
  const nodes = db.prepare('PRAGMA table_info(code_map_nodes)').all() as Array<{ name: string; pk: number }>
  const legacyNodes = nodes.some(c => c.name === 'id' && c.pk === 1)
  const legacyEdges = (db.prepare('PRAGMA table_info(code_map_edges)').all() as typeof nodes)
    .some(c => c.name === 'id' && c.pk === 1)
  // Renaming preserves the old data until the new tables have been populated.
  // Drop the old tables before recreating their named indexes below.
  if (legacyNodes) db.exec('ALTER TABLE code_map_nodes RENAME TO code_map_nodes_legacy')
  if (legacyEdges) db.exec('ALTER TABLE code_map_edges RENAME TO code_map_edges_legacy')
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_map_files (
      project_id  TEXT NOT NULL,
      path        TEXT NOT NULL,
      language    TEXT,
      hash        TEXT NOT NULL,
      mtime       INTEGER NOT NULL DEFAULT 0,
      size        INTEGER NOT NULL DEFAULT 0,
      parser      TEXT,
      truncated   INTEGER NOT NULL DEFAULT 0,
      indexed_at  INTEGER NOT NULL,
      PRIMARY KEY (project_id, path)
    );

    CREATE TABLE IF NOT EXISTS code_map_nodes (
      id          TEXT NOT NULL,
      project_id  TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      parent_name TEXT,
      line_start  INTEGER NOT NULL DEFAULT 0,
      line_end    INTEGER NOT NULL DEFAULT 0,
      signature   TEXT NOT NULL DEFAULT '',
      exported    INTEGER NOT NULL DEFAULT 0,
      doc         TEXT,
      PRIMARY KEY (project_id, id)
    );

    CREATE TABLE IF NOT EXISTS code_map_edges (
      id          TEXT NOT NULL,
      project_id  TEXT NOT NULL,
      from_node   TEXT NOT NULL,
      to_node     TEXT NOT NULL,
      type        TEXT NOT NULL,
      precision   TEXT NOT NULL DEFAULT 'heuristic',
      file_path   TEXT NOT NULL,
      line        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, id)
    );

    CREATE TABLE IF NOT EXISTS code_map_status (
      project_id    TEXT PRIMARY KEY,
      state         TEXT NOT NULL DEFAULT 'idle',
      total_files   INTEGER NOT NULL DEFAULT 0,
      indexed_files INTEGER NOT NULL DEFAULT 0,
      total_nodes   INTEGER NOT NULL DEFAULT 0,
      total_edges   INTEGER NOT NULL DEFAULT 0,
      started_at    INTEGER,
      updated_at    INTEGER NOT NULL DEFAULT 0,
      error         TEXT
    );

    -- Семантический слой карты: документы выводятся из узлов (текст = имя +
    -- сигнатура + путь), вектор — единственное «состояние». Hash-гейт: если
    -- text_hash == embed_hash, текст не менялся и вектор не пересчитывается —
    -- инкрементальные правки почти ничего не стоят.
    CREATE TABLE IF NOT EXISTS code_map_docs (
      project_id  TEXT NOT NULL,
      node_id     TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      tier        INTEGER NOT NULL DEFAULT 2,
      text        TEXT NOT NULL,
      text_hash   TEXT NOT NULL,
      embedding   BLOB,
      embed_hash  TEXT,
      model       TEXT,
      embedded_at INTEGER,
      PRIMARY KEY (project_id, node_id)
    );

    -- Неразрешённые ссылки (импорт/вызов), которые при последнем резолвинге
    -- файла не нашли цели. Ребра у них нет, поэтому по code_map_edges такой
    -- импортёр не находится: таблица — durable-обратный индекс для точечного
    -- восстановления, когда цель наконец появляется. key — lookup-ключ
    -- (имя файла-цели без расширения для импорта, имя символа для вызова),
    -- ref — исходный спецификатор/имя для повторного резолвинга.
    CREATE TABLE IF NOT EXISTS code_map_unresolved (
      project_id  TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      key         TEXT NOT NULL,
      ref         TEXT NOT NULL,
      line        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, file_path, kind, key, line)
    );

  `)
  if (legacyNodes) {
    const fields = 'id, project_id, file_path, name, kind, parent_name, line_start, line_end, signature, exported'
    db.exec(`
      INSERT INTO code_map_nodes (${fields}, doc)
      SELECT ${fields}, ${nodes.some(c => c.name === 'doc') ? 'doc' : 'NULL'}
      FROM code_map_nodes_legacy WHERE id IS NOT NULL;
      DROP TABLE code_map_nodes_legacy;
    `)
  }
  if (legacyEdges) {
    const fields = 'id, project_id, from_node, to_node, type, precision, file_path, line'
    db.exec(`
      INSERT INTO code_map_edges (${fields}) SELECT ${fields} FROM code_map_edges_legacy WHERE id IS NOT NULL;
      DROP TABLE code_map_edges_legacy;
    `)
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cmn_project_file ON code_map_nodes(project_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_cmn_project_name ON code_map_nodes(project_id, name);
    CREATE INDEX IF NOT EXISTS idx_cmn_project_kind ON code_map_nodes(project_id, kind);
    CREATE INDEX IF NOT EXISTS idx_cme_project_from ON code_map_edges(project_id, from_node);
    CREATE INDEX IF NOT EXISTS idx_cme_project_to ON code_map_edges(project_id, to_node);
    CREATE INDEX IF NOT EXISTS idx_cme_project_file ON code_map_edges(project_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_cme_project_type ON code_map_edges(project_id, type);
    CREATE INDEX IF NOT EXISTS idx_cmd_project_file ON code_map_docs(project_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_cmd_project_tier ON code_map_docs(project_id, tier);
    -- Обратный поиск кандидатов на восстановление: (kind, key) → импортёры.
    CREATE INDEX IF NOT EXISTS idx_cmu_project_key ON code_map_unresolved(project_id, kind, key);
    CREATE INDEX IF NOT EXISTS idx_cmu_project_file ON code_map_unresolved(project_id, file_path);

    -- Служебные метки проекта (версия схемы парсинга/документов). Смена версии
    -- → одноразовая полная пересборка: иначе в БД остаются узлы/документы,
    -- посчитанные старыми правилами (например, exported=0 у всех символов).
    CREATE TABLE IF NOT EXISTS code_map_meta (
      project_id TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      PRIMARY KEY (project_id, key)
    );
  `)

  if (legacyNodes || legacyEdges) {
    // A legacy row may have overwritten another project's graph without
    // changing its file hash. Reconcile from disk once, keeping existing docs.
    db.exec(`
      DELETE FROM code_map_meta WHERE key = 'schemaVersion';
      UPDATE code_map_status SET state = 'partial' WHERE state = 'ready';
    `)
  }
}
