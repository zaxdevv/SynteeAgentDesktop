//! Semantic-поиск по `semantic_embeddings` (E5, cosine).
//!
//! Перенесено из `searchSemanticSources` (TS). Контракт тот же: те же
//! scope/project/kind-фильтры, что у lexical-канала (chatSearch.ts / search.ts),
//! top-K на источник, cosine как score.
//!
//! Ключевое отличие от TS: скан и сортировка идут в отдельном процессе, поэтому
//! проход по 3000–10000 BLOB-векторов не трогает event loop main вообще.

use std::path::Path;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde::Deserialize;

use super::embed::{self, EmbedPrefix, E5Embedder, E5_MODEL_TAG};
use super::store;
use super::types::{scan_cap, truncate_content, SemanticHit, SemanticSource};
use crate::common::error::Result;

const DEFAULT_LIMIT: usize = 5;
/// 14-дневный cutoff для agent_logs — как в searchAgentLogs (старые прунятся).
const AGENT_LOG_WINDOW_MS: i64 = 14 * 24 * 60 * 60 * 1000;

/// Параметры semantic-поиска.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub query: String,
    /// Пусто — все пять источников.
    #[serde(default)]
    pub sources: Vec<SemanticSource>,
    /// 'global' | 'project' | 'chat' | 'all' (undefined = 'all').
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    /// Automatic hints limit memory to this chat and its project.
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub cross_project: bool,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    /// Флаги `getMemorySettings()` — передаются из TS, чтобы Rust не дублировал
    /// чтение настроек из electron-store.
    #[serde(default = "default_true")]
    pub memory_enabled: bool,
    #[serde(default = "default_true")]
    pub memory_global: bool,
    #[serde(default = "default_true")]
    pub memory_project: bool,
    #[serde(default = "default_true")]
    pub memory_chat: bool,
}

fn default_limit() -> usize {
    DEFAULT_LIMIT
}

fn default_true() -> bool {
    true
}

/// WHERE-фрагмент + аргументы.
struct Filter {
    sql: String,
    args: Vec<SqlValue>,
}

impl Filter {
    fn none() -> Self {
        Self { sql: "0=1".to_owned(), args: Vec::new() }
    }
}

/// Scope для `memory_items` — точная копия логики `searchMemory` (search.ts).
///
/// Замечание: ветка `scope = 'chat'` проверяет флаг `memory_chat`, но фильтрует
/// по `mi.scope = 'project'` — так было в TS, поведение сохранено намеренно:
/// менять его значит менять выдачу поиска, а это не задача переноса.
fn memory_scope_where(options: &SearchOptions) -> Filter {
    if !options.memory_enabled {
        return Filter::none();
    }
    if let Some(chat_id) = &options.chat_id {
        let mut clauses = Vec::new();
        let mut args = Vec::new();
        if let Some(project_id) = options.project_id.as_ref().filter(|_| options.memory_project) {
            clauses.push("(mi.scope = 'project' AND mi.project_id = ?)");
            args.push(SqlValue::Text(project_id.clone()));
        }
        if options.memory_chat {
            clauses.push("(mi.scope = 'chat' AND mi.chat_id = ? AND mi.project_id IS ?)");
            args.push(SqlValue::Text(chat_id.clone()));
            args.push(options.project_id.clone().map_or(SqlValue::Null, SqlValue::Text));
        }
        if clauses.is_empty() {
            return Filter::none();
        }
        return Filter {
            sql: format!("({})", clauses.join(" OR ")),
            args,
        };
    }
    if options.cross_project {
        let mut allowed: Vec<&str> = Vec::new();
        if options.memory_global {
            allowed.push("mi.scope = 'global'");
        }
        if options.memory_project {
            allowed.push("mi.scope = 'project'");
        }
        if options.memory_chat {
            allowed.push("mi.scope = 'chat'");
        }
        return if allowed.is_empty() {
            Filter::none()
        } else {
            Filter { sql: format!("({})", allowed.join(" OR ")), args: Vec::new() }
        };
    }

    match options.scope.as_deref() {
        Some("global") => {
            if options.memory_global {
                Filter { sql: "mi.scope = 'global'".to_owned(), args: Vec::new() }
            } else {
                Filter::none()
            }
        }
        Some(scope @ ("project" | "chat")) => {
            let Some(project_id) = options.project_id.clone() else {
                return default_memory_filter(options);
            };
            let enabled = if scope == "project" {
                options.memory_project
            } else {
                options.memory_chat
            };
            if enabled {
                Filter {
                    sql: "mi.scope = 'project' AND mi.project_id = ?".to_owned(),
                    args: vec![SqlValue::Text(project_id)],
                }
            } else {
                Filter::none()
            }
        }
        _ => default_memory_filter(options),
    }
}

/// Ветка 'all' (по умолчанию) — как в searchMemory.
fn default_memory_filter(options: &SearchOptions) -> Filter {
    let mut allowed: Vec<&str> = Vec::new();
    if options.memory_global {
        allowed.push("mi.scope = 'global'");
    }
    if options.memory_project {
        allowed.push("mi.scope = 'project'");
    }
    if options.memory_chat {
        allowed.push("mi.scope = 'chat'");
    }
    if allowed.is_empty() {
        return Filter::none();
    }
    Filter {
        sql: format!(
            "({}) AND (mi.project_id = ? OR mi.scope = 'global')",
            allowed.join(" OR ")
        ),
        args: vec![SqlValue::Text(
            options.project_id.clone().unwrap_or_else(|| "__none__".to_owned()),
        )],
    }
}

/// Scope для chat-источников (JOIN chats c) — копия `chatSearch.scopeFilter`.
fn chat_scope_where(options: &SearchOptions) -> Filter {
    if options.cross_project {
        return Filter { sql: "1=1".to_owned(), args: Vec::new() };
    }
    match options.project_id.clone() {
        Some(project_id) => Filter {
            sql: "c.project_id = ?".to_owned(),
            args: vec![SqlValue::Text(project_id)],
        },
        None => Filter { sql: "c.project_id IS NULL".to_owned(), args: Vec::new() },
    }
}

/// Кандидат после ранжирования: PK + cosine.
struct Candidate {
    source_id: String,
    score: f64,
}

/// Semantic-поиск: эмбеддинг запроса + cosine-ранжирование по источникам.
pub fn search(
    db_path: &Path,
    embedder: &E5Embedder,
    options: &SearchOptions,
) -> Result<Vec<SemanticHit>> {
    let query = options.query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let query_vector = match embedder.embed(query, EmbedPrefix::Query) {
        Ok(vector) => vector,
        // Модель недоступна/упала — lexical-канал продолжает работать.
        Err(_) => return Ok(Vec::new()),
    };

    let connection = store::open(db_path)?;
    let sources: Vec<SemanticSource> = if options.sources.is_empty() {
        SemanticSource::ALL.to_vec()
    } else {
        options.sources.clone()
    };
    let limit = options.limit.max(1);

    let mut hits: Vec<SemanticHit> = Vec::new();
    for source in sources {
        if !SemanticSource::ALL.contains(&source) {
            continue;
        }
        let candidates = match candidates(&connection, source, options, &query_vector) {
            Ok(candidates) => candidates,
            // Нет таблицы/индекса у источника — пропускаем, не валим поиск.
            Err(_) => continue,
        };
        let top: Vec<&Candidate> = candidates.iter().take(limit).collect();
        for candidate in top {
            if let Some(hit) = build_hit(&connection, source, candidate, options) {
                hits.push(hit);
            }
        }
    }

    Ok(hits)
}

/// Кандидаты одного источника, отсортированные по cosine (desc).
fn candidates(
    connection: &Connection,
    source: SemanticSource,
    options: &SearchOptions,
    query_vector: &[f32],
) -> Result<Vec<Candidate>> {
    let cap = scan_cap(source) as i64;
    let rows: Vec<(String, Vec<u8>)> = match source {
        SemanticSource::Memory => {
            let filter = memory_scope_where(options);
            let kind_where = if options.kind.is_some() { "AND mi.kind = ?" } else { "" };
            let sql = format!(
                "SELECT se.source_id, se.embedding
                 FROM semantic_embeddings se
                 JOIN memory_items mi ON mi.id = se.source_id
                 WHERE se.source = 'memory' AND se.model = ? AND {} {}
                 ORDER BY mi.importance DESC
                 LIMIT ?",
                filter.sql, kind_where
            );
            let mut args = vec![SqlValue::Text(E5_MODEL_TAG.to_owned())];
            args.extend(filter.args);
            if let Some(kind) = &options.kind {
                args.push(SqlValue::Text(kind.clone()));
            }
            args.push(SqlValue::Integer(cap));
            let mut statement = connection.prepare(&sql)?;
            let mapped = statement.query_map(params_from_iter(args), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })?;
            mapped.collect::<std::result::Result<Vec<_>, _>>()?
        }
        SemanticSource::Messages => {
            let filter = chat_scope_where(options);
            let sql = format!(
                "SELECT se.source_id, se.embedding
                 FROM semantic_embeddings se
                 JOIN messages m ON m.id = se.source_id
                 JOIN chats c ON c.id = m.chat_id
                 WHERE se.source = 'messages' AND se.model = ? AND {}
                 ORDER BY m.created_at DESC
                 LIMIT ?",
                filter.sql
            );
            let mut args = vec![SqlValue::Text(E5_MODEL_TAG.to_owned())];
            args.extend(filter.args);
            args.push(SqlValue::Integer(cap));
            let mut statement = connection.prepare(&sql)?;
            let mapped = statement.query_map(params_from_iter(args), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })?;
            mapped.collect::<std::result::Result<Vec<_>, _>>()?
        }
        SemanticSource::Summaries => {
            let filter = chat_scope_where(options);
            let sql = format!(
                "SELECT se.source_id, se.embedding
                 FROM semantic_embeddings se
                 JOIN chat_summaries cs ON cs.chat_id = se.source_id
                 JOIN chats c ON c.id = cs.chat_id
                 WHERE se.source = 'summaries' AND se.model = ? AND {}
                 ORDER BY cs.updated_at DESC
                 LIMIT ?",
                filter.sql
            );
            let mut args = vec![SqlValue::Text(E5_MODEL_TAG.to_owned())];
            args.extend(filter.args);
            args.push(SqlValue::Integer(cap));
            let mut statement = connection.prepare(&sql)?;
            let mapped = statement.query_map(params_from_iter(args), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })?;
            mapped.collect::<std::result::Result<Vec<_>, _>>()?
        }
        SemanticSource::AgentLogs => {
            let filter = chat_scope_where(options);
            let cutoff = super::index::now_millis() - AGENT_LOG_WINDOW_MS;
            let sql = format!(
                "SELECT se.source_id, se.embedding
                 FROM semantic_embeddings se
                 JOIN agent_logs al ON al.id = se.source_id
                 LEFT JOIN chats c ON c.id = al.chat_id
                 WHERE se.source = 'agent_logs' AND se.model = ? AND {} AND al.created_at > ?
                 ORDER BY al.created_at DESC
                 LIMIT ?",
                filter.sql
            );
            let mut args = vec![SqlValue::Text(E5_MODEL_TAG.to_owned())];
            args.extend(filter.args);
            args.push(SqlValue::Integer(cutoff));
            args.push(SqlValue::Integer(cap));
            let mut statement = connection.prepare(&sql)?;
            let mapped = statement.query_map(params_from_iter(args), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })?;
            mapped.collect::<std::result::Result<Vec<_>, _>>()?
        }
        SemanticSource::Pinned => {
            let filter = chat_scope_where(options);
            let sql = format!(
                "SELECT se.source_id, se.embedding
                 FROM semantic_embeddings se
                 JOIN pinned_messages pm ON pm.message_id = se.source_id
                 JOIN messages m ON m.id = pm.message_id
                 JOIN chats c ON c.id = m.chat_id
                 WHERE se.source = 'pinned' AND se.model = ? AND {}
                 ORDER BY m.created_at DESC
                 LIMIT ?",
                filter.sql
            );
            let mut args = vec![SqlValue::Text(E5_MODEL_TAG.to_owned())];
            args.extend(filter.args);
            args.push(SqlValue::Integer(cap));
            let mut statement = connection.prepare(&sql)?;
            let mapped = statement.query_map(params_from_iter(args), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })?;
            mapped.collect::<std::result::Result<Vec<_>, _>>()?
        }
    };

    let mut scored: Vec<Candidate> = rows
        .into_iter()
        .filter_map(|(source_id, blob)| {
            let vector = embed::blob_to_vector(&blob);
            if vector.len() != query_vector.len() {
                return None; // битый BLOB или чужая размерность
            }
            let score = embed::cosine(query_vector, &vector);
            if !score.is_finite() {
                return None;
            }
            Some(Candidate { source_id, score })
        })
        .collect();

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    Ok(scored)
}

/// Достраивает hit: контент и метаданные строки источника.
///
/// `None` — строка источника исчезла между запросами (rewind/prune): такой
/// кандидат просто выпадает из выдачи.
fn build_hit(
    connection: &Connection,
    source: SemanticSource,
    candidate: &Candidate,
    _options: &SearchOptions,
) -> Option<SemanticHit> {
    let score = candidate.score.clamp(0.0, 1.0);
    let base = SemanticHit {
        source,
        source_id: candidate.source_id.clone(),
        score,
        content: String::new(),
        chat_id: None,
        chat_title: None,
        role: None,
        date: None,
        memory_row: None,
    };

    match source {
        SemanticSource::Memory => {
            let mut statement = connection
                .prepare_cached("SELECT * FROM memory_items WHERE id = ?")
                .ok()?;
            let mut rows = statement.query([&candidate.source_id]).ok()?;
            let row = rows.next().ok()??;
            let json = store::row_to_json(row).ok()?;
            // memory content не усекаем — searchMemory тоже возвращает полный content
            let content = json
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_owned();
            Some(SemanticHit { content, memory_row: Some(json), ..base })
        }
        SemanticSource::Messages => {
            let mut statement = connection
                .prepare_cached(
                    "SELECT m.content, m.role, m.chat_id, c.title, m.created_at
                     FROM messages m LEFT JOIN chats c ON c.id = m.chat_id
                     WHERE m.id = ?",
                )
                .ok()?;
            let row = statement
                .query_row([&candidate.source_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .ok()?;
            Some(SemanticHit {
                content: truncate_content(&row.0),
                role: row.1,
                chat_id: Some(row.2),
                chat_title: row.3,
                date: Some(row.4),
                ..base
            })
        }
        SemanticSource::Summaries => {
            let mut statement = connection
                .prepare_cached(
                    "SELECT cs.content, c.title, cs.updated_at
                     FROM chat_summaries cs LEFT JOIN chats c ON c.id = cs.chat_id
                     WHERE cs.chat_id = ?",
                )
                .ok()?;
            let row = statement
                .query_row([&candidate.source_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .ok()?;
            Some(SemanticHit {
                content: truncate_content(&row.0),
                chat_id: Some(candidate.source_id.clone()),
                chat_title: row.1,
                date: Some(row.2),
                ..base
            })
        }
        SemanticSource::AgentLogs => {
            let mut statement = connection
                .prepare_cached(
                    "SELECT al.tool, al.result, al.error, al.created_at, al.chat_id, c.title
                     FROM agent_logs al LEFT JOIN chats c ON c.id = al.chat_id
                     WHERE al.id = ?",
                )
                .ok()?;
            let row = statement
                .query_row([&candidate.source_id], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                })
                .ok()?;
            // Content — тот же формат, что searchAgentLogs: "[tool] ERROR: …" / "[tool] result"
            let mut parts: Vec<String> = Vec::new();
            if let Some(tool) = &row.0 {
                parts.push(format!("[{tool}]"));
            }
            match &row.2 {
                Some(error) => parts.push(format!("ERROR: {error}")),
                None => {
                    if let Some(result) = &row.1 {
                        parts.push(result.clone());
                    }
                }
            }
            Some(SemanticHit {
                content: truncate_content(&parts.join(" ")),
                chat_id: row.4,
                chat_title: row.5,
                date: Some(row.3),
                ..base
            })
        }
        SemanticSource::Pinned => {
            let mut statement = connection
                .prepare_cached(
                    "SELECT m.content, m.role, m.chat_id, c.title, m.created_at
                     FROM pinned_messages pm
                     JOIN messages m ON m.id = pm.message_id
                     LEFT JOIN chats c ON c.id = m.chat_id
                     WHERE pm.message_id = ?",
                )
                .ok()?;
            let row = statement
                .query_row([&candidate.source_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .ok()?;
            Some(SemanticHit {
                content: truncate_content(&row.0),
                role: row.1,
                chat_id: Some(row.2),
                chat_title: row.3,
                date: Some(row.4),
                ..base
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> SearchOptions {
        SearchOptions {
            query: "q".to_owned(),
            sources: Vec::new(),
            scope: None,
            project_id: None,
            chat_id: None,
            cross_project: false,
            kind: None,
            limit: DEFAULT_LIMIT,
            memory_enabled: true,
            memory_global: true,
            memory_project: true,
            memory_chat: true,
        }
    }

    #[test]
    fn disabled_memory_matches_nothing() {
        let mut opts = options();
        opts.memory_enabled = false;
        assert_eq!(memory_scope_where(&opts).sql, "0=1");
    }

    #[test]
    fn default_scope_filters_by_project() {
        let mut opts = options();
        opts.project_id = Some("p1".to_owned());
        let filter = memory_scope_where(&opts);
        assert!(filter.sql.contains("mi.project_id = ?"));
        assert_eq!(filter.args.len(), 1);
    }

    #[test]
    fn missing_project_id_falls_back_to_none_sentinel() {
        let filter = memory_scope_where(&options());
        match &filter.args[0] {
            SqlValue::Text(value) => assert_eq!(value, "__none__"),
            other => panic!("unexpected arg: {other:?}"),
        }
    }

    #[test]
    fn chat_scope_without_project_uses_null_project() {
        let filter = chat_scope_where(&options());
        assert_eq!(filter.sql, "c.project_id IS NULL");
    }

    #[test]
    fn automatic_hints_select_current_chat_and_project_before_ranking() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE memory_items (id INTEGER, scope TEXT, project_id TEXT, chat_id TEXT);
             INSERT INTO memory_items VALUES
                 (1,'global',NULL,NULL),(2,'project','p1',NULL),(3,'project','p2',NULL),
                 (4,'chat','p1','c1'),(5,'chat','p1','c2'),(6,'chat','p2','c1'),(7,'chat',NULL,'c1');",
        ).unwrap();
        let read = |opts: &SearchOptions| -> Vec<i64> {
            let filter = memory_scope_where(opts);
            db.prepare(&format!("SELECT id FROM memory_items mi WHERE {} ORDER BY id", filter.sql))
                .unwrap()
                .query_map(params_from_iter(filter.args), |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };

        let mut opts = options();
        opts.chat_id = Some("c1".to_owned());
        opts.project_id = Some("p1".to_owned());
        assert_eq!(read(&opts), [2, 4]);
        opts.memory_chat = false;
        assert_eq!(read(&opts), [2]);
        opts.memory_chat = true;
        opts.project_id = None;
        assert_eq!(read(&opts), [7]);
    }
}
