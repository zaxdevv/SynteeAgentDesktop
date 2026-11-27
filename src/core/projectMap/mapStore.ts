/**
 * mapStore — CRUD графа кода проекта (code_map_* таблицы).
 *
 * Граф детерминированный: id узлов/рёбер выводятся из пути/имени, поэтому
 * повторный разбор файла даёт те же id (стабильные входящие рёбра). Инкрементал
 * устроен как replaceFile: удалить узлы/исходящие рёбра файла → вставить новые.
 * Входящие рёбра из других файлов остаются; осиротевшие чистит pruneDanglingEdges.
 */
import { getDB } from '../db/handle'
import type {
  CodeMapNode, CodeMapEdge, CodeMapFile, CodeMapStatus, CodeMapGraph,
  CodeNodeKind, CodeEdgeType, CodeEdgePrecision, GetGraphOptions,
  CodeMapDocInfo, CodeMapNeighbors,
} from '../../shared/projectMap'

// ─── Детерминированные id ────────────────────────────────────────────────────

export function fileNodeId(filePath: string): string {
  return filePath
}

export function symbolNodeId(filePath: string, name: string, parentName?: string | null): string {
  const qualified = parentName ? `${parentName}.${name}` : name
  return `${filePath}#${qualified}`
}

export function packageNodeId(name: string): string {
  return `pkg:${name}`
}

export function edgeId(from: string, type: CodeEdgeType, to: string, line: number): string {
  return `${from}|${type}|${to}|${line}`
}

// ─── Мапперы строк ───────────────────────────────────────────────────────────

function rowToNode(row: Record<string, unknown>): CodeMapNode {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    filePath: row.file_path as string,
    name: row.name as string,
    kind: row.kind as CodeNodeKind,
    parentName: (row.parent_name as string | null) ?? null,
    lineStart: (row.line_start as number) ?? 0,
    lineEnd: (row.line_end as number) ?? 0,
    signature: (row.signature as string) ?? '',
    exported: Boolean(row.exported),
    doc: (row.doc as string | null | undefined) ?? null,
  }
}

function rowToEdge(row: Record<string, unknown>): CodeMapEdge {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    fromNode: row.from_node as string,
    toNode: row.to_node as string,
    type: row.type as CodeEdgeType,
    precision: row.precision as CodeEdgePrecision,
    filePath: row.file_path as string,
    line: (row.line as number) ?? 0,
  }
}

function rowToFile(row: Record<string, unknown>): CodeMapFile {
  return {
    projectId: row.project_id as string,
    path: row.path as string,
    language: (row.language as string | null) ?? null,
    hash: row.hash as string,
    mtime: (row.mtime as number) ?? 0,
    size: (row.size as number) ?? 0,
    parser: (row.parser as string | null) ?? null,
    truncated: Boolean(row.truncated),
    indexedAt: (row.indexed_at as number) ?? 0,
  }
}

// ─── Запись ──────────────────────────────────────────────────────────────────

/**
 * Атомарно заменить узлы и исходящие рёбра одного файла. Пакетные узлы (package)
 * сюда не входят — они глобальные на проект и живут через ensurePackageNode.
 */
export function replaceFile(
  projectId: string,
  file: CodeMapFile,
  nodes: CodeMapNode[],
  edges: CodeMapEdge[],
): void {
  const db = getDB()
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM code_map_nodes WHERE project_id = ? AND file_path = ?`).run(projectId, file.path)
    db.prepare(`DELETE FROM code_map_edges WHERE project_id = ? AND file_path = ?`).run(projectId, file.path)
    db.prepare(`DELETE FROM code_map_files WHERE project_id = ? AND path = ?`).run(projectId, file.path)

    db.prepare(
      `INSERT INTO code_map_files (project_id, path, language, hash, mtime, size, parser, truncated, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(projectId, file.path, file.language, file.hash, file.mtime, file.size, file.parser, file.truncated ? 1 : 0, file.indexedAt)

    const insNode = db.prepare(
      `INSERT OR REPLACE INTO code_map_nodes (id, project_id, file_path, name, kind, parent_name, line_start, line_end, signature, exported, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const n of nodes) {
      insNode.run(n.id, projectId, n.filePath, n.name, n.kind, n.parentName, n.lineStart, n.lineEnd, n.signature, n.exported ? 1 : 0, n.doc ?? null)
    }

    const insEdge = db.prepare(
      `INSERT OR REPLACE INTO code_map_edges (id, project_id, from_node, to_node, type, precision, file_path, line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const e of edges) {
      insEdge.run(e.id, projectId, e.fromNode, e.toNode, e.type, e.precision, e.filePath, e.line)
    }
  })
  tx()
}

/**
 * Атомарно заменить ТОЛЬКО рёбра файла (узлы/запись файла не трогаются).
 * Нужно инкрементальному перерезолвингу: узлы файла уже записаны, а связи
 * приходится пересчитать после появления соседей в индексе.
 *
 * Одна транзакция: DELETE+INSERT не оставляют файл с частичным набором рёбер,
 * а падение на вставке откатывает прежние рёбра целиком.
 */
export function replaceFileEdges(
  projectId: string,
  filePath: string,
  edges: CodeMapEdge[],
): void {
  const db = getDB()
  const del = db.prepare(`DELETE FROM code_map_edges WHERE project_id = ? AND file_path = ?`)
  const ins = db.prepare(
    `INSERT OR REPLACE INTO code_map_edges (id, project_id, from_node, to_node, type, precision, file_path, line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const tx = db.transaction(() => {
    del.run(projectId, filePath)
    for (const e of edges) {
      ins.run(e.id, projectId, e.fromNode, e.toNode, e.type, e.precision, e.filePath, e.line)
    }
  })
  tx()
}

/**
 * Заменить durable-след неразрешённых ссылок файла (code_map_unresolved).
 * Пишется вместе с рёбрами файла: у неразрешённой ссылки ребра нет, и без
 * этой записи её нечем найти, когда цель появится.
 */
export function replaceUnresolved(
  projectId: string,
  filePath: string,
  refs: { kind: string; key: string; ref: string; line: number }[],
): void {
  const db = getDB()
  const del = db.prepare(`DELETE FROM code_map_unresolved WHERE project_id = ? AND file_path = ?`)
  const ins = db.prepare(
    `INSERT OR REPLACE INTO code_map_unresolved (project_id, file_path, kind, key, ref, line)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const tx = db.transaction(() => {
    del.run(projectId, filePath)
    for (const r of refs) ins.run(projectId, filePath, r.kind, r.key, r.ref, r.line)
  })
  tx()
}

/**
 * Обратный поиск импортёров с неразрешённой ссылкой по ключам (kind+key).
 * Bounded: только индекс idx_cmu_project_key и жёсткий LIMIT, без сканов.
 */
export function findUnresolvedByKeys(
  projectId: string,
  kind: string,
  keys: string[],
  limit = 200,
): { filePath: string; ref: string; line: number }[] {
  if (keys.length === 0) return []
  const uniq = [...new Set(keys)].slice(0, 64)
  const ph = uniq.map(() => '?').join(',')
  const rows = getDB().prepare(
    `SELECT file_path, ref, line FROM code_map_unresolved
     WHERE project_id = ? AND kind = ? AND key IN (${ph}) LIMIT ?`
  ).all(projectId, kind, ...uniq, limit) as { file_path: string; ref: string; line: number }[]
  return rows.map(r => ({ filePath: r.file_path, ref: r.ref, line: r.line }))
}

/** Сколько неразрешённых ссылок записано (диагностика/тесты). */
export function countUnresolved(projectId: string): number {
  return (getDB().prepare(
    `SELECT COUNT(*) c FROM code_map_unresolved WHERE project_id = ?`
  ).get(projectId) as { c: number }).c
}

/** Внешний пакет — глобальный узел проекта, не привязан к файлу. */
export function ensurePackageNode(projectId: string, name: string): string {
  const id = packageNodeId(name)
  getDB().prepare(
    `INSERT OR IGNORE INTO code_map_nodes (id, project_id, file_path, name, kind, parent_name, line_start, line_end, signature, exported)
     VALUES (?, ?, '', ?, 'package', NULL, 0, 0, '', 0)`
  ).run(id, projectId, name)
  return id
}

export function removeFile(projectId: string, path: string): void {
  const db = getDB()
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM code_map_nodes WHERE project_id = ? AND file_path = ?`).run(projectId, path)
    db.prepare(`DELETE FROM code_map_edges WHERE project_id = ? AND file_path = ?`).run(projectId, path)
    db.prepare(`DELETE FROM code_map_files WHERE project_id = ? AND path = ?`).run(projectId, path)
    // Неразрешённые ссылки удалённого файла не должны воскрешать его в
    // обратном поиске (иначе восстановление дёргало бы несуществующий файл).
    db.prepare(`DELETE FROM code_map_unresolved WHERE project_id = ? AND file_path = ?`).run(projectId, path)
  })
  tx()
}

/** Удалить рёбра, чьи узлы больше не существуют (после инкрементальных правок). */
export function pruneDanglingEdges(projectId: string): number {
  const db = getDB()
  const res = db.prepare(
    `DELETE FROM code_map_edges
     WHERE project_id = ?
       AND (from_node NOT IN (SELECT id FROM code_map_nodes WHERE project_id = ?)
        OR to_node NOT IN (SELECT id FROM code_map_nodes WHERE project_id = ?))`
  ).run(projectId, projectId, projectId)
  // Следы неразрешённых ссылок удалённых файлов (строки code_map_files нет —
  // файл убран) снимаем здесь же: они ведут в никуда.
  db.prepare(
    `DELETE FROM code_map_unresolved
     WHERE project_id = ?
       AND file_path NOT IN (SELECT path FROM code_map_files WHERE project_id = ?)`
  ).run(projectId, projectId)
  return res.changes
}

export function clearProject(projectId: string): void {
  const db = getDB()
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM code_map_nodes WHERE project_id = ?`).run(projectId)
    db.prepare(`DELETE FROM code_map_edges WHERE project_id = ?`).run(projectId)
    db.prepare(`DELETE FROM code_map_files WHERE project_id = ?`).run(projectId)
    db.prepare(`DELETE FROM code_map_unresolved WHERE project_id = ?`).run(projectId)
  })
  tx()
}

// ─── Чтение ──────────────────────────────────────────────────────────────────

export function getGraph(projectId: string, opts: GetGraphOptions = {}): CodeMapGraph {
  const db = getDB()
  const limit = Math.max(1, Math.min(opts.limit ?? 5000, 20000))

  const nodeWhere: string[] = ['project_id = ?']
  const nodeParams: unknown[] = [projectId]
  if (opts.filePath) {
    nodeWhere.push('(file_path = ? OR kind = \'package\')')
    nodeParams.push(opts.filePath)
  }
  if (opts.kinds && opts.kinds.length > 0) {
    nodeWhere.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`)
    nodeParams.push(...opts.kinds)
  }
  const nodes = db.prepare(
    `SELECT * FROM code_map_nodes WHERE ${nodeWhere.join(' AND ')} LIMIT ?`
  ).all(...nodeParams, limit) as Record<string, unknown>[]

  const edgeWhere: string[] = ['project_id = ?']
  const edgeParams: unknown[] = [projectId]
  if (opts.edgeTypes && opts.edgeTypes.length > 0) {
    edgeWhere.push(`type IN (${opts.edgeTypes.map(() => '?').join(',')})`)
    edgeParams.push(...opts.edgeTypes)
  }
  if (opts.filePath) {
    edgeWhere.push('file_path = ?')
    edgeParams.push(opts.filePath)
  }
  const edges = db.prepare(
    `SELECT * FROM code_map_edges WHERE ${edgeWhere.join(' AND ')} LIMIT ?`
  ).all(...edgeParams, limit * 4) as Record<string, unknown>[]

  return { nodes: nodes.map(rowToNode), edges: edges.map(rowToEdge) }
}

/** Все узлы проекта без рёбер — тёплая загрузка индекса (не тянет edges). */
export function listNodes(projectId: string, limit?: number, offset = 0): CodeMapNode[] {
  const db = getDB()
  const rows = (limit != null
    ? db.prepare(`SELECT * FROM code_map_nodes WHERE project_id = ? LIMIT ? OFFSET ?`).all(projectId, limit, offset)
    : db.prepare(`SELECT * FROM code_map_nodes WHERE project_id = ?`).all(projectId)
  ) as Record<string, unknown>[]
  return rows.map(rowToNode)
}

/** Узлы файла + рёбра, которые их касаются (drill-down в модалке). */
export function getFileGraph(projectId: string, path: string): CodeMapGraph {
  const db = getDB()
  const nodes = db.prepare(
    `SELECT * FROM code_map_nodes WHERE project_id = ? AND (file_path = ? OR id = ?)`
  ).all(projectId, path, fileNodeId(path)) as Record<string, unknown>[]
  const ids = nodes.map(n => n.id as string)
  if (ids.length === 0) return { nodes: [], edges: [] }
  const placeholders = ids.map(() => '?').join(',')
  const edges = db.prepare(
    `SELECT * FROM code_map_edges WHERE project_id = ? AND (from_node IN (${placeholders}) OR to_node IN (${placeholders}))`
  ).all(projectId, ...ids, ...ids) as Record<string, unknown>[]
  return { nodes: nodes.map(rowToNode), edges: edges.map(rowToEdge) }
}

export function findNodes(projectId: string, query: string, limit = 30): CodeMapNode[] {
  const db = getDB()
  const like = `%${query}%`
  const rows = db.prepare(
    `SELECT * FROM code_map_nodes WHERE project_id = ? AND name LIKE ? AND kind != 'package'
     ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END, name LIMIT ?`
  ).all(projectId, like, query, `${query}%`, limit) as Record<string, unknown>[]
  return rows.map(rowToNode)
}

export function getNode(projectId: string, nodeId: string): CodeMapNode | null {
  const row = getDB().prepare(`SELECT * FROM code_map_nodes WHERE project_id = ? AND id = ?`)
    .get(projectId, nodeId) as Record<string, unknown> | undefined
  return row ? rowToNode(row) : null
}

/** Кто вызывает узел (входящие calls/references). */
export function getCallers(projectId: string, nodeId: string, limit = -1): CodeMapEdge[] {
  return listNodeEdges(projectId, nodeId, 'in', limit)
}

/** Кого вызывает узел (исходящие calls/references). */
export function getCallees(projectId: string, nodeId: string, limit = -1): CodeMapEdge[] {
  return listNodeEdges(projectId, nodeId, 'out', limit)
}

function listNodeEdges(projectId: string, nodeId: string, direction: 'in' | 'out', limit: number): CodeMapEdge[] {
  const column = direction === 'in' ? 'to_node' : 'from_node'
  const rows = getDB().prepare(
    `SELECT * FROM code_map_edges WHERE project_id = ? AND ${column} = ? AND type IN ('calls','references') LIMIT ?`
  ).all(projectId, nodeId, limit) as Record<string, unknown>[]
  return rows.map(rowToEdge)
}

export function countNodeEdges(projectId: string, nodeId: string, direction: 'in' | 'out'): number {
  const column = direction === 'in' ? 'to_node' : 'from_node'
  return (getDB().prepare(
    `SELECT COUNT(*) AS total FROM code_map_edges WHERE project_id = ? AND ${column} = ? AND type IN ('calls','references')`
  ).get(projectId, nodeId) as { total: number }).total
}

/** One bounded inspector response. Counts represent unique, existing neighbors. */
export function getNeighbors(projectId: string, nodeId: string): CodeMapNeighbors {
  const node = getNode(projectId, nodeId)
  if (!node) return { node, callers: [], callees: [], callerCount: 0, calleeCount: 0 }
  const db = getDB()
  const read = (from: 'from_node' | 'to_node', to: 'from_node' | 'to_node') => {
    const neighbors = `SELECT DISTINCT ${to} AS id FROM code_map_edges
      WHERE project_id = ? AND ${from} = ? AND type IN ('calls','references')`
    const join = `FROM (${neighbors}) AS neighbor
      JOIN code_map_nodes n ON n.project_id = ? AND n.id = neighbor.id`
    const { total } = db.prepare(`SELECT COUNT(*) AS total ${join}`)
      .get(projectId, nodeId, projectId) as { total: number }
    const rows = total ? db.prepare(`SELECT n.* ${join} LIMIT 20`)
      .all(projectId, nodeId, projectId) as Record<string, unknown>[] : []
    return { total, nodes: rows.map(rowToNode) }
  }
  const callers = read('to_node', 'from_node')
  const callees = read('from_node', 'to_node')
  return { node, callers: callers.nodes, callees: callees.nodes, callerCount: callers.total, calleeCount: callees.total }
}

export function getImportHubs(projectId: string): Array<{ label: string; count: number }> {
  return getDB().prepare(`
    SELECT CASE WHEN n.kind = 'package' THEN n.name || ' (external package)' ELSE n.file_path END AS label,
      COUNT(*) AS count
    FROM code_map_edges e
    JOIN code_map_nodes n ON n.project_id = e.project_id AND n.id = e.to_node
    WHERE e.project_id = ? AND e.type = 'imports'
    GROUP BY e.to_node ORDER BY count DESC, e.to_node LIMIT 10
  `).all(projectId) as Array<{ label: string; count: number }>
}

/**
 * Рёбра для аналитики (god nodes / communities / path / affected): только
 * calls|references|imports, без внешних пакетов.
 */
export function listAnalysisEdges(projectId: string, limit: number, types: CodeEdgeType[]): CodeMapEdge[] {
  const ph = types.map(() => '?').join(',')
  const rows = getDB().prepare(
    `SELECT * FROM code_map_edges
     WHERE project_id = ? AND type IN (${ph}) AND precision != 'external'
     LIMIT ?`
  ).all(projectId, ...types, limit) as Record<string, unknown>[]
  return rows.map(rowToEdge)
}

export function getFileEdges(projectId: string, path: string, direction: 'out' | 'in', limit = -1): CodeMapEdge[] {
  const fid = fileNodeId(path)
  const col = direction === 'out' ? 'from_node' : 'to_node'
  const rows = getDB().prepare(
    `SELECT * FROM code_map_edges WHERE project_id = ? AND ${col} = ? AND type = 'imports' LIMIT ?`
  ).all(projectId, fid, limit) as Record<string, unknown>[]
  return rows.map(rowToEdge)
}

export function getFileSymbols(projectId: string, path: string, limit: number): { total: number; nodes: CodeMapNode[] } {
  const db = getDB()
  const where = "FROM code_map_nodes WHERE project_id = ? AND file_path = ? AND kind NOT IN ('file','package')"
  const { total } = db.prepare(`SELECT COUNT(*) AS total ${where}`).get(projectId, path) as { total: number }
  const rows = total ? db.prepare(`SELECT * ${where} LIMIT ?`).all(projectId, path, limit) as Record<string, unknown>[] : []
  return { total, nodes: rows.map(rowToNode) }
}

/**
 * Файлы, зависящие от `filePath`: входящие imports/calls/references на ЛЮБОЙ
 * узел файла (файловый узел = сам путь, плюс все символы файла).
 *
 * Возвращает distinct пути импортёров без самого файла. Индексы подобраны под
 * запрос: idx_cmn_project_file закрывает подзапрос узлов файла,
 * idx_cme_project_to — обе ветки `to_node` (равенство + IN), поэтому нет
 * join'а edges×nodes и full scan'а.
 */
export function getDependentFilePaths(projectId: string, filePath: string): string[] {
  const rows = getDB().prepare(
    `SELECT DISTINCT e.file_path AS path
     FROM code_map_edges e
     WHERE e.project_id = ?
       AND e.type IN ('imports','calls','references')
       AND e.file_path != ?
       AND e.file_path != ''
       AND (e.to_node = ? OR e.to_node IN (
         SELECT n.id FROM code_map_nodes n WHERE n.project_id = ? AND n.file_path = ?
       ))`
  ).all(projectId, filePath, fileNodeId(filePath), projectId, filePath) as { path: string }[]
  return rows.map(r => r.path)
}

/** Обновить mtime/size файла без переразбора (случай «touch»: hash тот же). */
export function updateFileStat(projectId: string, path: string, mtime: number, size: number): void {
  getDB().prepare(
    `UPDATE code_map_files SET mtime = ?, size = ? WHERE project_id = ? AND path = ?`
  ).run(mtime, size, projectId, path)
}

export function listFiles(projectId: string): CodeMapFile[] {
  const rows = getDB().prepare(`SELECT * FROM code_map_files WHERE project_id = ? ORDER BY path`)
    .all(projectId) as Record<string, unknown>[]
  return rows.map(rowToFile)
}

/** Одна строка файла по PK (project_id, path) — индексный поиск без join'ов. */
export function getFile(projectId: string, path: string): CodeMapFile | null {
  const row = getDB().prepare(`SELECT * FROM code_map_files WHERE project_id = ? AND path = ?`)
    .get(projectId, path) as Record<string, unknown> | undefined
  return row ? rowToFile(row) : null
}

// ─── Служебные метки проекта (версии схемы парсинга/документов) ──────────────

export function getMeta(projectId: string, key: string): string | null {
  const row = getDB().prepare(
    `SELECT value FROM code_map_meta WHERE project_id = ? AND key = ?`
  ).get(projectId, key) as { value: string } | undefined
  return row?.value ?? null
}

export function setMeta(projectId: string, key: string, value: string): void {
  getDB().prepare(
    `INSERT OR REPLACE INTO code_map_meta (project_id, key, value) VALUES (?, ?, ?)`
  ).run(projectId, key, value)
}

export function getIndexedProjectIds(): string[] {
  const rows = getDB().prepare(`SELECT DISTINCT project_id FROM code_map_files`).all() as { project_id: string }[]
  return rows.map(r => r.project_id)
}

// ─── Документы семантического слоя (code_map_docs) ───────────────────────────
// Документы выводятся из узлов карты и всегда пересчитываются заново; вектор —
// единственное «состояние». Hash-гейт: upsert сохраняет вектор, если текст
// не изменился; saveEmbeddings пишет вектор только под актуальный text_hash.

/**
 * Тег модели эмбеддингов — версия вектора, хранится в уже существующей колонке
 * `model`. Смена тега объявляет все векторы несовместимыми: они не попадают ни
 * в очередь поиска (listDocVectors), ни в счётчик indexed — worker переэмбеддит
 * их и проштампует новым тегом. Отдельной миграции/колонки не нужно.
 */
export const EMBED_MODEL_TAG = 'e5'

/**
 * Вектор можно ПЕРЕНЕСТИ при переразборе: текст тот же и тег актуален.
 *
 * NULL-тег (строка из БД до появления тега) НЕ переносим. Раньше такой вектор
 * сохранялся в расчёте на «очередь перештампует», но очередь (listPendingDocs)
 * смотрит только на embed_hash, а у перенесённой строки он равен text_hash —
 * вектор навсегда оставался невидимым и для поиска (model = tag), и для
 * worker'а. Дроп вектора возвращает строку в очередь и штампует её тегом.
 */
function isPreservable(model: unknown): boolean {
  return model === EMBED_MODEL_TAG
}

interface DocRow {
  nodeId: string
  filePath: string
  kind: CodeNodeKind
  tier: 0 | 1 | 2
  text: string
  textHash: string
}

/** Вставить/обновить документы файла. Вектор сохраняется при неизменном тексте. */
export function upsertDocs(projectId: string, docs: DocRow[]): void {
  if (docs.length === 0) return
  const db = getDB()
  const placeholders = docs.map(() => '?').join(',')
  const ids = docs.map(d => d.nodeId)
  const prev = db.prepare(
    `SELECT node_id, text_hash, embedding, embed_hash, model, embedded_at
     FROM code_map_docs WHERE project_id = ? AND node_id IN (${placeholders})`
  ).all(projectId, ...ids) as Record<string, unknown>[]
  const byId = new Map(prev.map(r => [r.node_id as string, r]))

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO code_map_docs
     (project_id, node_id, file_path, kind, tier, text, text_hash, embedding, embed_hash, model, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const tx = db.transaction(() => {
    for (const d of docs) {
      const old = byId.get(d.nodeId)
      // Текст не изменился → переносим вектор как есть (hash-гейт).
      const keep = old && old.text_hash === d.textHash && old.embedding != null
        && isPreservable(old.model)
      upsert.run(
        projectId, d.nodeId, d.filePath, d.kind, d.tier, d.text, d.textHash,
        keep ? old!.embedding : null,
        keep ? old!.embed_hash : null,
        keep ? old!.model : null,
        keep ? old!.embedded_at : null,
      )
    }
  })
  tx()
}

/** Документы файла: id → text_hash/tier (для sync: осиротевшие и изменения). */
export function listDocMetaByFile(
  projectId: string,
  filePath: string,
): Map<string, { textHash: string; tier: number }> {
  const rows = getDB().prepare(
    `SELECT node_id, text_hash, tier FROM code_map_docs WHERE project_id = ? AND file_path = ?`
  ).all(projectId, filePath) as { node_id: string; text_hash: string; tier: number }[]
  return new Map(rows.map(r => [r.node_id, { textHash: r.text_hash, tier: r.tier }]))
}

/** Удалить документы узлов (осиротевшие после переразбора/удаления файла). */
export function deleteDocsByIds(projectId: string, nodeIds: string[]): void {
  if (nodeIds.length === 0) return
  const db = getDB()
  const placeholders = nodeIds.map(() => '?').join(',')
  db.prepare(
    `DELETE FROM code_map_docs WHERE project_id = ? AND node_id IN (${placeholders})`
  ).run(projectId, ...nodeIds)
}

export function deleteDocsByFile(projectId: string, filePath: string): void {
  getDB().prepare(
    `DELETE FROM code_map_docs WHERE project_id = ? AND file_path = ?`
  ).run(projectId, filePath)
}

export function clearDocs(projectId: string): void {
  getDB().prepare(`DELETE FROM code_map_docs WHERE project_id = ?`).run(projectId)
}

/**
 * Удалить документы, чьих узлов больше нет в графе (безопасная «полная чистка»
 * после пересборки карты). Векторы выживших узлов остаются: текст тот же →
 * hash-гейт сохраняет embedding, переэмбеддинга нет.
 */
export function pruneOrphanDocs(projectId: string): number {
  const res = getDB().prepare(
    `DELETE FROM code_map_docs
     WHERE project_id = ?
       AND node_id NOT IN (SELECT id FROM code_map_nodes WHERE project_id = ?)`
  ).run(projectId, projectId)
  return res.changes
}

/**
 * Очередь worker'а: документы, чей вектор устарел, отсутствует или посчитан
 * другой моделью (тег в колонке `model`).
 */
export function listPendingDocs(
  projectId: string,
  limit: number,
  modelTag: string = EMBED_MODEL_TAG,
): CodeMapDocInfo[] {
  const rows = getDB().prepare(
    `SELECT node_id, file_path, kind, tier, text, text_hash
     FROM code_map_docs
     WHERE project_id = ? AND tier > 0
       AND (embed_hash IS NULL OR embed_hash != text_hash OR embedding IS NULL
            OR model IS NULL OR model != ?)
     ORDER BY tier ASC, rowid ASC LIMIT ?`
  ).all(projectId, modelTag, limit) as Record<string, unknown>[]
  return rows.map(r => ({
    nodeId: r.node_id as string,
    filePath: r.file_path as string,
    kind: r.kind as CodeNodeKind,
    tier: (r.tier as 0 | 1 | 2) ?? 2,
    text: r.text as string,
    textHash: r.text_hash as string,
  }))
}

/** Проекты с неиндексированными документами (для выбора целей worker'а). */
export function listPendingDocProjectIds(modelTag: string = EMBED_MODEL_TAG): string[] {
  // Мелкие проекты первыми: пока большой греется минутами, маленькие
  // закрываются за секунды — в настройках видно прогресс, а не вечное «прогрев».
  const rows = getDB().prepare(
    `SELECT project_id, COUNT(*) c FROM code_map_docs
     WHERE tier > 0
       AND (embed_hash IS NULL OR embed_hash != text_hash OR embedding IS NULL
            OR model IS NULL OR model != ?)
     GROUP BY project_id ORDER BY c ASC`
  ).all(modelTag) as { project_id: string }[]
  return rows.map(r => r.project_id)
}

/**
 * Записать векторы пачки. UPDATE с гардом text_hash = ? — если текст изменился,
 * пока sidecar считал пачку, вектор не запишется (документ переэмбеддится).
 * Тег модели пишется из item.model (по умолчанию — текущий EMBED_MODEL_TAG).
 */
export function saveDocEmbeddings(
  projectId: string,
  items: { nodeId: string; textHash: string; embedding: Buffer; model?: string; embeddedAt: number }[],
): number {
  if (items.length === 0) return 0
  const db = getDB()
  const upd = db.prepare(
    `UPDATE code_map_docs
     SET embedding = ?, embed_hash = text_hash, model = ?, embedded_at = ?
     WHERE project_id = ? AND node_id = ? AND text_hash = ?`
  )
  let saved = 0
  const tx = db.transaction(() => {
    for (const it of items) {
      const res = upd.run(
        it.embedding, it.model ?? EMBED_MODEL_TAG, it.embeddedAt,
        projectId, it.nodeId, it.textHash,
      )
      saved += res.changes
    }
  })
  tx()
  return saved
}

/** Счётчики для статуса/прогресса: всего документов и с актуальным вектором. */
export function countDocs(
  projectId: string,
  modelTag: string = EMBED_MODEL_TAG,
): { total: number; indexed: number; lexicalOnly: number } {
  const db = getDB()
  const total = (db.prepare(
    `SELECT COUNT(*) c FROM code_map_docs WHERE project_id = ? AND tier > 0`
  ).get(projectId) as { c: number }).c
  const indexed = (db.prepare(
    `SELECT COUNT(*) c FROM code_map_docs
     WHERE project_id = ? AND tier > 0 AND embed_hash = text_hash
       AND embedding IS NOT NULL AND model = ?`
  ).get(projectId, modelTag) as { c: number }).c
  const lexicalOnly = (db.prepare(
    `SELECT COUNT(*) c FROM code_map_docs WHERE project_id = ? AND tier = 0`
  ).get(projectId) as { c: number }).c
  return { total, indexed, lexicalOnly }
}

/**
 * Векторы проекта постранично (матрица для cosine строится лениво).
 * Только актуальные: под текущий text_hash и текущий тег модели — устаревший
 * вектор не должен участвовать в ранжировании.
 */
export function listDocVectors(
  projectId: string,
  pageSize = 2000,
  modelTag: string = EMBED_MODEL_TAG,
): { nodeId: string; embedding: Buffer }[] {
  const out: { nodeId: string; embedding: Buffer }[] = []
  const db = getDB()
  let offset = 0
  for (;;) {
    const rows = db.prepare(
      `SELECT node_id, embedding FROM code_map_docs
       WHERE project_id = ? AND embedding IS NOT NULL AND embed_hash = text_hash AND model = ?
       LIMIT ? OFFSET ?`
    ).all(projectId, modelTag, pageSize, offset) as { node_id: string; embedding: Buffer }[]
    if (rows.length === 0) break
    for (const r of rows) out.push({ nodeId: r.node_id, embedding: r.embedding })
    offset += rows.length
    if (rows.length < pageSize) break
  }
  return out
}

/** Тексты документов проекта постранично (инвертированный lexical-индекс). */
export function listDocTexts(projectId: string, pageSize = 2000): CodeMapDocInfo[] {
  const out: CodeMapDocInfo[] = []
  const db = getDB()
  let offset = 0
  for (;;) {
    const rows = db.prepare(
      `SELECT node_id, file_path, kind, tier, text, text_hash
       FROM code_map_docs WHERE project_id = ? LIMIT ? OFFSET ?`
    ).all(projectId, pageSize, offset) as Record<string, unknown>[]
    if (rows.length === 0) break
    for (const r of rows) {
      out.push({
        nodeId: r.node_id as string,
        filePath: r.file_path as string,
        kind: r.kind as CodeNodeKind,
        tier: (r.tier as 1 | 2) ?? 2,
        text: r.text as string,
        textHash: r.text_hash as string,
      })
    }
    offset += rows.length
    if (rows.length < pageSize) break
  }
  return out
}

// ─── Статус ──────────────────────────────────────────────────────────────────

export function getStatus(projectId: string): CodeMapStatus {
  const row = getDB().prepare(`SELECT * FROM code_map_status WHERE project_id = ?`).get(projectId) as Record<string, unknown> | undefined
  if (!row) {
    return {
      projectId, state: 'idle', totalFiles: 0, indexedFiles: 0, totalNodes: 0, totalEdges: 0,
      startedAt: null, updatedAt: 0, error: null,
    }
  }
  return {
    projectId,
    state: row.state as CodeMapStatus['state'],
    totalFiles: (row.total_files as number) ?? 0,
    indexedFiles: (row.indexed_files as number) ?? 0,
    totalNodes: (row.total_nodes as number) ?? 0,
    totalEdges: (row.total_edges as number) ?? 0,
    startedAt: (row.started_at as number | null) ?? null,
    updatedAt: (row.updated_at as number) ?? 0,
    error: (row.error as string | null) ?? null,
  }
}

export function setStatus(projectId: string, patch: Partial<Omit<CodeMapStatus, 'projectId'>>): void {
  const db = getDB()
  const current = getStatus(projectId)
  const next = { ...current, ...patch, updatedAt: Date.now() }
  db.prepare(
    `INSERT OR REPLACE INTO code_map_status
     (project_id, state, total_files, indexed_files, total_nodes, total_edges, started_at, updated_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(projectId, next.state, next.totalFiles, next.indexedFiles, next.totalNodes, next.totalEdges, next.startedAt, next.updatedAt, next.error)
}

/** Пересчитать счётчики узлов/рёбер из фактических таблиц. */
export function refreshCounts(projectId: string): void {
  const db = getDB()
  const nodes = (db.prepare(`SELECT COUNT(*) c FROM code_map_nodes WHERE project_id = ?`).get(projectId) as { c: number }).c
  const edges = (db.prepare(`SELECT COUNT(*) c FROM code_map_edges WHERE project_id = ?`).get(projectId) as { c: number }).c
  const files = (db.prepare(`SELECT COUNT(*) c FROM code_map_files WHERE project_id = ?`).get(projectId) as { c: number }).c
  const patch: Partial<Omit<CodeMapStatus, 'projectId'>> = { totalNodes: nodes, totalEdges: edges, indexedFiles: files }
  // В готовой карте totalFiles — не «сколько предстоит разобрать» (снимок полного
  // скана), а фактическое число файлов. Инкремент добавляет/удаляет файлы, и
  // колонка «Файлы» показывала рассинхрон (1093/1078, 789/793).
  const state = getStatus(projectId).state
  if (state !== 'building') patch.totalFiles = files
  setStatus(projectId, patch)
}
