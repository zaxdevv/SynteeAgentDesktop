/**
 * graphStore — CRUD для knowledge graph (memory_graph_nodes + memory_graph_edges).
 *
 * 6 типов узлов:  decision | concept | file | symbol | conversation | task
 * 9 типов рёбер:  affects | mentions | implemented_in | depends_on | supersedes
 *                | references | imports | calls | implements
 *
 * upsertNode: INSERT OR IGNORE + UPDATE weight (increment на существующем).
 * upsertEdge: резолвит nodes по (projectId, type, label) → INSERT OR IGNORE.
 * getProjectGraph: фильтры по type[], minWeight, limit. Возвращает {nodes, edges}.
 * decayPruneGraph: удаляет низко-weight неиспользуемые узлы (pinned защищены).
 *                  Каскадно удаляет рёбра через ON DELETE CASCADE.
 */

import { v4 as uuid } from 'uuid'
import { getDB } from '../db/handle'

// ─── Типы ────────────────────────────────────────────────────────────────────

export type NodeType = 'decision' | 'concept' | 'file' | 'symbol' | 'conversation' | 'task'
export type EdgeType =
  | 'affects' | 'mentions' | 'implemented_in' | 'depends_on' | 'supersedes'
  | 'references' | 'imports' | 'calls' | 'implements'
export type NodeSourceKind = 'memory_item' | 'fast_context' | 'message' | 'chat_summary' | 'llm_extract' | 'manual'

export interface GraphNode {
  id: string
  projectId: string
  type: NodeType
  label: string
  sourceKind: NodeSourceKind | null
  sourceId: string | null
  metadata: Record<string, unknown> | null
  weight: number
  accessCount: number
  lastAccessedAt: number | null
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export interface GraphEdge {
  id: string
  projectId: string
  fromNode: string
  toNode: string
  type: EdgeType
  weight: number
  metadata: Record<string, unknown> | null
  createdAt: number
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface GraphStats {
  nodeCount: number
  edgeCount: number
  byNodeType: Record<string, number>
  byEdgeType: Record<string, number>
  hubs: Array<{ id: string; label: string; type: NodeType; degree: number }>
  recentDecisions: Array<{ id: string; label: string; targets: Array<{ label: string; type: NodeType; edgeType: EdgeType }> }>
  /** Top file nodes by degree with their import targets — for system prompt. */
  fileHubs: Array<{ label: string; degree: number; topImports: string[] }>
}

export interface GetGraphOptions {
  nodeTypes?: NodeType[]
  edgeTypes?: EdgeType[]
  minWeight?: number
  limit?: number
}

// ─── Хелперы ─────────────────────────────────────────────────────────────────

function rowToNode(row: Record<string, unknown>): GraphNode {
  let metadata: Record<string, unknown> | null = null
  if (row.metadata && typeof row.metadata === 'string') {
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown> } catch { /* skip */ }
  }
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    type: row.type as NodeType,
    label: row.label as string,
    sourceKind: (row.source_kind as NodeSourceKind | null) ?? null,
    sourceId: (row.source_id as string | null) ?? null,
    metadata,
    weight: (row.weight as number) ?? 1.0,
    accessCount: (row.access_count as number) ?? 0,
    lastAccessedAt: (row.last_accessed_at as number | null) ?? null,
    pinned: Boolean(row.pinned),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }
}

function rowToEdge(row: Record<string, unknown>): GraphEdge {
  let metadata: Record<string, unknown> | null = null
  if (row.metadata && typeof row.metadata === 'string') {
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown> } catch { /* skip */ }
  }
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    fromNode: row.from_node as string,
    toNode: row.to_node as string,
    type: row.type as EdgeType,
    weight: (row.weight as number) ?? 1.0,
    metadata,
    createdAt: row.created_at as number,
  }
}

// ─── UPSERT NODE ─────────────────────────────────────────────────────────────

/**
 * Создать или обновить узел. Если узел с (projectId, type, label) существует —
 * boost weight на +1.0 (или на weightBoost), обновить source/metadata если заданы.
 * Возвращает id узла.
 */
export function upsertNode(params: {
  projectId: string
  type: NodeType
  label: string
  sourceKind?: NodeSourceKind
  sourceId?: string
  metadata?: Record<string, unknown>
  weightBoost?: number
}): string {
  const db = getDB()
  const now = Date.now()
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null
  const boost = params.weightBoost ?? 1.0

  // Пытаемся найти существующий
  const existing = db.prepare(
    `SELECT id, weight, metadata FROM memory_graph_nodes WHERE project_id = ? AND type = ? AND label = ?`
  ).get(params.projectId, params.type, params.label) as { id: string; weight: number; metadata: string | null } | undefined

  if (existing) {
    // Merge metadata: shallow merge new into existing
    let mergedMeta: Record<string, unknown> | null = null
    if (params.metadata || existing.metadata) {
      let existingMeta: Record<string, unknown> = {}
      if (existing.metadata) {
        try { existingMeta = JSON.parse(existing.metadata) as Record<string, unknown> } catch { /* skip */ }
      }
      mergedMeta = { ...existingMeta, ...(params.metadata ?? {}) }
    }
    db.prepare(
      `UPDATE memory_graph_nodes
       SET weight = ?, source_kind = COALESCE(?, source_kind),
           source_id = COALESCE(?, source_id),
           metadata = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      existing.weight + boost,
      params.sourceKind ?? null,
      params.sourceId ?? null,
      mergedMeta ? JSON.stringify(mergedMeta) : null,
      now,
      existing.id,
    )
    return existing.id
  }

  // Insert нового узла
  const id = uuid()
  db.prepare(
    `INSERT INTO memory_graph_nodes
     (id, project_id, type, label, source_kind, source_id, metadata, weight, access_count, last_accessed_at, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?)`
  ).run(
    id, params.projectId, params.type, params.label,
    params.sourceKind ?? null, params.sourceId ?? null, metadataJson,
    boost, now, now,
  )
  return id
}

// ─── UPSERT EDGE ─────────────────────────────────────────────────────────────

/**
 * Создать или обновить ребро. Резолвит узлы по (projectId, type, label).
 * Если ребро уже существует — boost weight. Возвращает id ребра или null если
 * узлы не найдены/созданы.
 */
export function upsertEdge(params: {
  projectId: string
  fromType: NodeType
  fromLabel: string
  toType: NodeType
  toLabel: string
  type: EdgeType
  metadata?: Record<string, unknown>
  weightBoost?: number
  // Опционально: source для узлов (если надо создать с sourceKind/sourceId)
  fromSourceKind?: NodeSourceKind
  fromSourceId?: string
  toSourceKind?: NodeSourceKind
  toSourceId?: string
}): string | null {
  const db = getDB()
  const fromId = upsertNode({
    projectId: params.projectId, type: params.fromType, label: params.fromLabel,
    sourceKind: params.fromSourceKind, sourceId: params.fromSourceId,
  })
  const toId = upsertNode({
    projectId: params.projectId, type: params.toType, label: params.toLabel,
    sourceKind: params.toSourceKind, sourceId: params.toSourceId,
  })
  if (!fromId || !toId) return null

  const now = Date.now()
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null
  const boost = params.weightBoost ?? 1.0

  const existing = db.prepare(
    `SELECT id, weight FROM memory_graph_edges WHERE project_id = ? AND from_node = ? AND to_node = ? AND type = ?`
  ).get(params.projectId, fromId, toId, params.type) as { id: string; weight: number } | undefined

  if (existing) {
    db.prepare(
      `UPDATE memory_graph_edges SET weight = ?, metadata = COALESCE(?, metadata) WHERE id = ?`
    ).run(existing.weight + boost, metadataJson, existing.id)
    return existing.id
  }

  const id = uuid()
  db.prepare(
    `INSERT INTO memory_graph_edges (id, project_id, from_node, to_node, type, weight, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, params.projectId, fromId, toId, params.type, boost, metadataJson, now)
  return id
}

// ─── GET PROJECT GRAPH ───────────────────────────────────────────────────────

/**
 * Получить граф проекта с опциональными фильтрами.
 * Возвращает {nodes, edges}. По умолчанию limit=500 узлов (для UI производительности).
 */
export function getProjectGraph(projectId: string, opts: GetGraphOptions = {}): GraphData {
  const db = getDB()
  const limit = opts.limit ?? 500
  const minWeight = opts.minWeight ?? 0

  // ── Nodes ──
  const nodeWhere: string[] = ['project_id = ?']
  const nodeArgs: unknown[] = [projectId]
  if (opts.nodeTypes && opts.nodeTypes.length > 0) {
    const placeholders = opts.nodeTypes.map(() => '?').join(',')
    nodeWhere.push(`type IN (${placeholders})`)
    nodeArgs.push(...opts.nodeTypes)
  }
  if (minWeight > 0) {
    nodeWhere.push('weight >= ?')
    nodeArgs.push(minWeight)
  }
  const nodes = db.prepare(
    `SELECT * FROM memory_graph_nodes WHERE ${nodeWhere.join(' AND ')}
     ORDER BY pinned DESC, weight DESC, updated_at DESC LIMIT ?`
  ).all(...nodeArgs, limit) as Record<string, unknown>[]
  const nodeRows = nodes.map(rowToNode)

  if (nodeRows.length === 0) return { nodes: [], edges: [] }

  // ── Edges: только между выбранными узлами ──
  const nodeIds = new Set(nodeRows.map(n => n.id))
  const edgeWhere: string[] = ['project_id = ?', 'from_node IN (SELECT id FROM memory_graph_nodes WHERE project_id = ?)']
  const edgeArgs: unknown[] = [projectId, projectId]
  if (opts.edgeTypes && opts.edgeTypes.length > 0) {
    const placeholders = opts.edgeTypes.map(() => '?').join(',')
    edgeWhere.push(`type IN (${placeholders})`)
    edgeArgs.push(...opts.edgeTypes)
  }
  const edgeRows = db.prepare(
    `SELECT * FROM memory_graph_edges WHERE ${edgeWhere.join(' AND ')}
     ORDER BY weight DESC LIMIT ?`
  ).all(...edgeArgs, limit * 4) as Record<string, unknown>[]

  // Filter edges to only those between selected nodes
  const edges = edgeRows
    .map(rowToEdge)
    .filter(e => nodeIds.has(e.fromNode) && nodeIds.has(e.toNode))

  return { nodes: nodeRows, edges }
}

// ─── GET GRAPH STATS ─────────────────────────────────────────────────────────

/**
 * Статистика графа для системного промпта и UI.
 * Возвращает счётчики узлов/рёбер по типам, top-5 хаб-узлов (по degree),
 * свежие решения (decision с их связями).
 */
export function getGraphStats(projectId: string): GraphStats {
  const db = getDB()

  const nodeCount = (db.prepare(
    `SELECT COUNT(*) as c FROM memory_graph_nodes WHERE project_id = ?`
  ).get(projectId) as { c: number }).c
  const edgeCount = (db.prepare(
    `SELECT COUNT(*) as c FROM memory_graph_edges WHERE project_id = ?`
  ).get(projectId) as { c: number }).c

  const byNodeTypeRows = db.prepare(
    `SELECT type, COUNT(*) as c FROM memory_graph_nodes WHERE project_id = ? GROUP BY type`
  ).all(projectId) as Array<{ type: string; c: number }>
  const byEdgeTypeRows = db.prepare(
    `SELECT type, COUNT(*) as c FROM memory_graph_edges WHERE project_id = ? GROUP BY type`
  ).all(projectId) as Array<{ type: string; c: number }>

  // Хабы: узлы с наибольшим degree (sum of in + out edges)
  const hubsRows = db.prepare(
    `SELECT n.id, n.label, n.type,
       (SELECT COUNT(*) FROM memory_graph_edges e WHERE e.from_node = n.id OR e.to_node = n.id) as degree
     FROM memory_graph_nodes n
     WHERE n.project_id = ?
     ORDER BY degree DESC LIMIT 5`
  ).all(projectId) as Array<{ id: string; label: string; type: NodeType; degree: number }>

  // Свежие решения: top-3 decision nodes с их соседями
  const recentDecisionRows = db.prepare(
    `SELECT id, label FROM memory_graph_nodes
     WHERE project_id = ? AND type = 'decision'
     ORDER BY updated_at DESC LIMIT 3`
  ).all(projectId) as Array<{ id: string; label: string }>

  const recentDecisions: GraphStats['recentDecisions'] = []
  for (const d of recentDecisionRows) {
    const neighbors = db.prepare(
      `SELECT
         CASE WHEN e.from_node = ? THEN e.to_node ELSE e.from_node END as neighbor_id,
         n.label, n.type, e.type as edge_type
       FROM memory_graph_edges e
       JOIN memory_graph_nodes n ON n.id = CASE WHEN e.from_node = ? THEN e.to_node ELSE e.from_node END
       WHERE e.project_id = ? AND (e.from_node = ? OR e.to_node = ?)
       LIMIT 5`
    ).all(d.id, d.id, projectId, d.id, d.id) as Array<{ label: string; type: NodeType; edge_type: EdgeType }>
    recentDecisions.push({
      id: d.id,
      label: d.label,
      targets: neighbors.map(n => ({ label: n.label, type: n.type, edgeType: n.edge_type })),
    })
  }

  // File hubs: top 5 file nodes by degree, each with their top 3 import targets
  const fileHubRows = db.prepare(
    `SELECT n.id, n.label,
       (SELECT COUNT(*) FROM memory_graph_edges e WHERE e.from_node = n.id OR e.to_node = n.id) as degree
     FROM memory_graph_nodes n
     WHERE n.project_id = ? AND n.type = 'file'
     ORDER BY degree DESC LIMIT 5`
  ).all(projectId) as Array<{ id: string; label: string; degree: number }>

  const fileHubs: GraphStats['fileHubs'] = []
  for (const fh of fileHubRows) {
    if (fh.degree === 0) continue
    const imports = db.prepare(
      `SELECT n2.label FROM memory_graph_edges e
       JOIN memory_graph_nodes n2 ON n2.id = e.to_node
       WHERE e.from_node = ? AND e.type = 'imports'
       ORDER BY e.weight DESC LIMIT 3`
    ).all(fh.id) as Array<{ label: string }>
    fileHubs.push({
      label: fh.label,
      degree: fh.degree,
      topImports: imports.map(i => i.label),
    })
  }

  return {
    nodeCount,
    edgeCount,
    byNodeType: Object.fromEntries(byNodeTypeRows.map(r => [r.type, r.c])),
    byEdgeType: Object.fromEntries(byEdgeTypeRows.map(r => [r.type, r.c])),
    hubs: hubsRows.map(h => ({ id: h.id, label: h.label, type: h.type, degree: h.degree })),
    recentDecisions,
    fileHubs,
  }
}

// ─── DELETE / PIN ────────────────────────────────────────────────────────────

export function deleteNode(id: string): boolean {
  // Рёбра удалятся каскадно через ON DELETE CASCADE
  const result = getDB().prepare(`DELETE FROM memory_graph_nodes WHERE id = ?`).run(id)
  return result.changes > 0
}

export function deleteProjectGraph(projectId: string): number {
  // Удаляем узлы — рёбра удалятся каскадно
  const result = getDB().prepare(`DELETE FROM memory_graph_nodes WHERE project_id = ?`).run(projectId)
  return result.changes
}

export function pinNode(id: string, pinned: boolean): boolean {
  const result = getDB().prepare(`UPDATE memory_graph_nodes SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, id)
  return result.changes > 0
}

export function touchNodeAccess(id: string): void {
  getDB().prepare(
    `UPDATE memory_graph_nodes SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`
  ).run(Date.now(), id)
}

// ─── PRUNE ───────────────────────────────────────────────────────────────────

/**
 * Удалить изолированные узлы (без рёбер). Полезно после bulk-обновлений.
 */
export function pruneIsolatedNodes(projectId?: string): number {
  const db = getDB()
  const where = projectId ? `AND project_id = ?` : ''
  const args = projectId ? [projectId] : []
  const result = db.prepare(
    `DELETE FROM memory_graph_nodes
     WHERE pinned = 0
       AND id NOT IN (SELECT from_node FROM memory_graph_edges ${projectId ? 'WHERE project_id = ?' : ''})
       AND id NOT IN (SELECT to_node FROM memory_graph_edges ${projectId ? 'WHERE project_id = ?' : ''})
       ${where}`
  ).run(...args, ...args, ...args)
  return result.changes
}

/**
 * Decay prune — удаляет низко-weight неиспользуемые узлы (pinned защищены).
 * Каскадно удаляет рёбра через ON DELETE CASCADE.
 *
 * Критерии:
 *   - pinned = 0
 *   - weight < minWeight
 *   - access_count = 0
 *   - last_accessed_at IS NULL OR < cutoff
 *   - created_at < cutoff
 */
export function decayPruneGraph(maxAgeDays = 30, minWeight = 0.5): number {
  const db = getDB()
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const result = db.prepare(
    `DELETE FROM memory_graph_nodes
     WHERE pinned = 0
       AND weight < ?
       AND access_count = 0
       AND (last_accessed_at IS NULL OR last_accessed_at < ?)
       AND created_at < ?`
  ).run(minWeight, cutoff, cutoff)
  return result.changes
}

// ─── FORMAT GRAPH FOR AI ─────────────────────────────────────────────────────

/**
 * Форматирует GraphData в текст или mermaid (используется для stats block).
 *
 * text: узлы сгруппированы по типу, рёбра как "A →type→ B".
 *   Files показываются с их import/call связями prominently.
 *   Truncate до ~4000 символов.
 * mermaid: flowchart `graph TD; A-->|type|B`.
 */
export function formatGraphForAI(graph: GraphData, format: string = 'text'): string {
  if (graph.nodes.length === 0) {
    return 'Graph is empty. The project may not be indexed yet, or no decisions have been saved.'
  }

  if (format === 'mermaid') {
    return formatGraphMermaid(graph)
  }
  return formatGraphText(graph)
}

function formatGraphText(graph: GraphData): string {
  const lines: string[] = []
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))

  // Group nodes by type
  const byType: Record<string, GraphNode[]> = {}
  for (const n of graph.nodes) {
    if (!byType[n.type]) byType[n.type] = []
    byType[n.type].push(n)
  }

  const typeLabels: Record<string, string> = {
    decision: 'Decisions',
    concept: 'Concepts',
    file: 'Files',
    symbol: 'Symbols',
    conversation: 'Conversations',
    task: 'Tasks',
  }

  // Nodes section
  for (const [type, label] of Object.entries(typeLabels)) {
    const nodes = byType[type]
    if (!nodes?.length) continue
    lines.push(`${label} (${nodes.length}):`)
    for (const n of nodes.slice(0, 30)) {
      const degree = graph.edges.filter(e => e.fromNode === n.id || e.toNode === n.id).length
      lines.push(`  - ${n.label}${degree > 0 ? ` (${degree} links)` : ''}`)
    }
    if (nodes.length > 30) lines.push(`  ... and ${nodes.length - 30} more`)
    lines.push('')
  }

  // Edges section — group by type for readability
  const edgeLabels: Record<string, string> = {
    affects: 'Affects (decision → file)',
    mentions: 'Mentions (→ symbol)',
    implemented_in: 'Implemented in (symbol → file)',
    depends_on: 'Depends on (→)',
    supersedes: 'Supersedes (→)',
    references: 'References (→)',
    imports: 'Imports (file → file)',
    calls: 'Calls (file → symbol)',
    implements: 'Implements (→)',
  }

  const edgesByType: Record<string, GraphEdge[]> = {}
  for (const e of graph.edges) {
    if (!edgesByType[e.type]) edgesByType[e.type] = []
    edgesByType[e.type].push(e)
  }

  for (const [type, label] of Object.entries(edgeLabels)) {
    const edges = edgesByType[type]
    if (!edges?.length) continue
    lines.push(`${label} (${edges.length}):`)
    for (const e of edges.slice(0, 20)) {
      const from = nodeMap.get(e.fromNode)
      const to = nodeMap.get(e.toNode)
      if (!from || !to) continue
      lines.push(`  ${from.label} → ${to.label}`)
    }
    if (edges.length > 20) lines.push(`  ... and ${edges.length - 20} more`)
    lines.push('')
  }

  let result = lines.join('\n').trim()
  if (result.length > 4000) {
    result = result.slice(0, 3990) + '\n... (truncated)'
  }
  return result
}

function formatGraphMermaid(graph: GraphData): string {
  const lines: string[] = ['```mermaid', 'graph TD']
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))

  // Sanitize labels for mermaid (no special chars in node IDs)
  const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20)

  // Nodes
  for (const n of graph.nodes.slice(0, 100)) {
    const sid = sanitizeId(n.id)
    const shortLabel = n.label.length > 20 ? n.label.slice(0, 17) + '…' : n.label
    const typeIcons: Record<string, string> = {
      decision: '📋',
      concept: '💡',
      file: '📄',
      symbol: '🔧',
      conversation: '💬',
      task: '✅',
    }
    lines.push(`  ${sid}["${typeIcons[n.type] ?? ''} ${shortLabel}"]`)
  }

  // Edges
  const edgeLabels: Record<string, string> = {
    affects: 'affects',
    mentions: 'mentions',
    implemented_in: 'impl',
    depends_on: 'depends',
    supersedes: 'replaces',
    references: 'refs',
    imports: 'imports',
    calls: 'calls',
    implements: 'impl',
  }

  for (const e of graph.edges.slice(0, 150)) {
    const from = nodeMap.get(e.fromNode)
    const to = nodeMap.get(e.toNode)
    if (!from || !to) continue
    const fromSid = sanitizeId(e.fromNode)
    const toSid = sanitizeId(e.toNode)
    const label = edgeLabels[e.type] ?? e.type
    lines.push(`  ${fromSid} -->|${label}| ${toSid}`)
  }

  lines.push('```')

  let result = lines.join('\n')
  if (result.length > 4000) {
    result = result.slice(0, 3990) + '\n... (truncated)\n```'
  }
  return result
}
