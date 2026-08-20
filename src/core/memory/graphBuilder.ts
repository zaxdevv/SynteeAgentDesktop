/**
 * graphBuilder — orchestration: full rebuild + incremental updates.
 *
 * buildProjectGraph: полная перестройка графа проекта.
 *   1. Очистка старых fast_context-sourced узлов (file/symbol)
 *   2. syncFromFastContext (files/symbols/imports/calls)
 *   3. Извлечение из всех memory_items kind=project_decision (heuristic)
 *   4. Prune isolated nodes
 *
 * incrementalUpdateDecision: вызывается после save_memory kind=project_decision.
 *   Heuristic extraction из нового/обновлённого решения.
 *
 * incrementalUpdateConversation: вызывается после compaction.
 *   LLM extraction из нового chat_summary.
 *
 * incrementalUpdateFastContext: вызывается после reindex.
 *   Sync files/symbols/imports/calls + cleanup устаревших.
 */

import type Store from 'electron-store'
import { getDB } from '../db/handle'
import { getFastContextEntries } from '../db/fastContextStore'
import {
  deleteProjectGraph,
  pruneIsolatedNodes,
  upsertNode,
} from './graphStore'
import {
  extractFromDecisionHeuristic,
  syncFromFastContext,
  syncSingleEntry,
  buildBasenameToPath,
  extractFromConversationLLM,
  saveExtractionToGraph,
} from './graphExtractor'
import type { MemoryItem } from './MemoryStore'

// ─── FULL REBUILD ────────────────────────────────────────────────────────────

let _buildingProjects = new Set<string>()

/**
 * Полная перестройка графа проекта.
 * Удаляет ВСЕ узлы/рёбра проекта и строит заново из всех источников.
 * Дорого: O(N) где N = files + decisions + conversations.
 *
 * @returns статистика: { nodes, edges, decisions, conversations }
 */
export function buildProjectGraph(projectId: string): {
  nodes: number
  edges: number
  decisions: number
  conversations: number
} {
  if (_buildingProjects.has(projectId)) {
    return { nodes: 0, edges: 0, decisions: 0, conversations: 0 }
  }
  _buildingProjects.add(projectId)
  try {
  // 1. Полная очистка графа проекта
  deleteProjectGraph(projectId)

  let totalNodes = 0
  let totalEdges = 0
  let decisions = 0
  let conversations = 0

  // 2. Sync from fast_context (files/symbols/imports/calls)
  const fcResult = syncFromFastContext(projectId)
  totalNodes += fcResult.nodes
  totalEdges += fcResult.edges

  // 3. Извлечение из всех memory_items kind=project_decision (heuristic)
  const db = getDB()
  const decisionsRows = db.prepare(
    `SELECT id, title, content FROM memory_items
     WHERE scope = 'project' AND project_id = ? AND kind = 'project_decision'`
  ).all(projectId) as Array<{ id: string; title: string | null; content: string }>

  for (const row of decisionsRows) {
    const label = (row.title || row.content).slice(0, 80)
    const result = extractFromDecisionHeuristic({
      projectId,
      decisionLabel: label,
      content: row.content,
      memoryItemId: row.id,
    })
    totalNodes += result.nodes
    totalEdges += result.edges
    decisions++
  }

  // 3b. Извлечение из memory_items kind='convention' (heuristic)
  const conventionRows = db.prepare(
    `SELECT id, title, content FROM memory_items
     WHERE scope = 'project' AND project_id = ? AND kind = 'convention'`
  ).all(projectId) as Array<{ id: string; title: string | null; content: string }>

  for (const row of conventionRows) {
    const label = (row.title || row.content).slice(0, 80)
    const result = extractFromDecisionHeuristic({
      projectId,
      decisionLabel: label,
      content: row.content,
      memoryItemId: row.id,
    })
    totalNodes += result.nodes
    totalEdges += result.edges
  }

  // 4. Sync conversations из chat_summaries (без LLM — просто conversation nodes)
  const summaryRows = db.prepare(
    `SELECT cs.chat_id, cs.content, c.title
     FROM chat_summaries cs
     JOIN chats c ON c.id = cs.chat_id
     WHERE c.project_id = ?`
  ).all(projectId) as Array<{ chat_id: string; content: string; title: string }>

  for (const row of summaryRows) {
    if (row.content.trim().length < 50) continue
    const label = (row.title || `Чат ${row.chat_id.slice(0, 8)}`).slice(0, 80)
    upsertNode({
      projectId,
      type: 'conversation',
      label,
      sourceKind: 'chat_summary',
      sourceId: row.chat_id,
      metadata: { title: row.title, summary: row.content.slice(0, 200) },
    })
    totalNodes++
    conversations++
  }

  // 5. Prune isolated nodes (без рёбер, кроме pinned)
  pruneIsolatedNodes(projectId)

  return {
    nodes: totalNodes,
    edges: totalEdges,
    decisions,
    conversations,
  }
  } finally {
    _buildingProjects.delete(projectId)
  }
}

// ─── INCREMENTAL: decision ───────────────────────────────────────────────────

/**
 * Incremental update при save_memory kind=project_decision.
 * Heuristic extraction: file paths + symbol refs.
 * Быстро, без LLM.
 */
export function incrementalUpdateDecision(item: MemoryItem): { nodes: number; edges: number } {
  if (!item.projectId) return { nodes: 0, edges: 0 }
  if (item.kind !== 'project_decision' && item.kind !== 'convention') return { nodes: 0, edges: 0 }

  return extractFromDecisionHeuristic({
    projectId: item.projectId,
    decisionLabel: (item.title || item.content).slice(0, 80),
    content: item.content,
    memoryItemId: item.id,
  })
}

// ─── INCREMENTAL: conversation (LLM) ────────────────────────────────────────

/**
 * Incremental update при compaction (новый chat_summary).
 * LLM extraction концепций и связей из резюме диалога.
 *
 * Cost-control: skip если summary короткий. Использует fast-модель.
 */
export async function incrementalUpdateConversation(
  store: Store,
  params: {
    projectId: string
    chatId: string
    summary: string
    chatTitle?: string
  },
): Promise<{ nodes: number; edges: number; error?: string }> {
  const { extraction, error } = await extractFromConversationLLM(store, {
    projectId: params.projectId,
    chatId: params.chatId,
    summary: params.summary,
  })

  if (error) {
    return { nodes: 0, edges: 0, error }
  }

  const convLabel = (params.chatTitle ?? `Чат ${params.chatId.slice(0, 8)}`).slice(0, 80)
  const result = saveExtractionToGraph(params.projectId, extraction, {
    conversationLabel: convLabel,
    chatId: params.chatId,
  })

  return result
}

// ─── INCREMENTAL: fast_context reindex ───────────────────────────────────────

/**
 * Incremental update после fast_context reindex.
 * Sync files/symbols/imports/calls + cleanup устаревших file/symbol узлов.
 *
 * Два режима:
 *   INCREMENTAL (changedPaths задан и < 200 файлов): синкаем только изменённые
 *     файлы — удаляем их старые узлы и upsert'им новые. Пропускаем полный
 *     stale-cleanup и pruneIsolatedNodes (дорого). Для 5K файлов это сотни
 *     записей вместо сотен тысяч.
 *   FULL (changedPaths пуст/не задан или >= 200): полный sync всех entries
 *     + stale-cleanup + pruneIsolatedNodes (prewarm/reindex).
 *
 * Алгоритм (FULL):
 *   1. syncFromFastContext (upsert всех текущих files/symbols)
 *   2. Удалить file/symbol узлы (source_kind='fast_context'), которых больше нет в индексе
 *   3. pruneIsolatedNodes
 *
 * @param changedPaths — опциональный список изменённых путей (incremental).
 */
export function incrementalUpdateFastContext(
  projectId: string,
  changedPaths?: string[],
): { nodes: number; edges: number; removed: number } {
  // Incremental mode: мало изменённых файлов → синкаем только их
  if (changedPaths && changedPaths.length > 0 && changedPaths.length < 200) {
    return incrementalSyncChanged(projectId, changedPaths)
  }

  // Full mode: синкаем всё (prewarm/reindex)
  const syncResult = syncFromFastContext(projectId)

  // Удаляем устаревшие file/symbol узлы
  const db = getDB()
  const entries = getFastContextEntries(projectId)
  const currentPaths = new Set(entries.map(e => e.filePath))
  const currentBasenames = new Set(entries.map(e => e.filePath.split(/[/\\]/).pop() ?? e.filePath))

  // Находим устаревшие file узлы
  const staleFileNodes = db.prepare(
    `SELECT id, label, source_id FROM memory_graph_nodes
     WHERE project_id = ? AND type = 'file' AND source_kind = 'fast_context'`
  ).all(projectId) as Array<{ id: string; label: string; source_id: string | null }>

  let removed = 0
  for (const node of staleFileNodes) {
    const path = node.source_id ?? node.label
    if (!currentPaths.has(path) && !currentBasenames.has(node.label)) {
      db.prepare(`DELETE FROM memory_graph_nodes WHERE id = ?`).run(node.id)
      removed++
    }
  }

  // Symbol узлы: удаляем те, чей source_id (file:line) указывает на удалённый файл
  const staleSymbolNodes = db.prepare(
    `SELECT id, source_id FROM memory_graph_nodes
     WHERE project_id = ? AND type = 'symbol' AND source_kind = 'fast_context'`
  ).all(projectId) as Array<{ id: string; source_id: string | null }>

  for (const node of staleSymbolNodes) {
    if (!node.source_id) continue
    const file = node.source_id.split(':')[0]
    if (!currentPaths.has(file)) {
      db.prepare(`DELETE FROM memory_graph_nodes WHERE id = ?`).run(node.id)
      removed++
    }
  }

  // Prune isolated (могут остаться после удаления файлов)
  pruneIsolatedNodes(projectId)

  return { nodes: syncResult.nodes, edges: syncResult.edges, removed }
}

/**
 * Инкрементальная синхронизация только изменённых файлов.
 * Для каждого changed path: удаляем старые file/symbol узлы и upsert'им новые.
 * Пропускаем полный stale-cleanup и pruneIsolatedNodes (дорого для incremental).
 */
function incrementalSyncChanged(
  projectId: string,
  changedPaths: string[],
): { nodes: number; edges: number; removed: number } {
  const db = getDB()
  let nodes = 0
  let edges = 0
  let removed = 0

  // Получаем все записи — нужны для резолвинга imports/references в полном контексте
  const allEntries = getFastContextEntries(projectId)
  const allPaths = new Set(allEntries.map(e => e.filePath))
  // Строим basename→path ОДИН раз (раньше O(N²) — для каждого changed файла)
  const basenameToPath = buildBasenameToPath(allEntries)

  // Для каждого изменённого пути: удаляем старые узлы, upsert'им новые
  for (const p of changedPaths) {
    // Удаляем file node
    const fileDel = db.prepare(
      `DELETE FROM memory_graph_nodes WHERE project_id = ? AND type = 'file' AND source_kind = 'fast_context' AND source_id = ?`
    ).run(projectId, p)
    removed += fileDel.changes

    // Удаляем symbol nodes этого файла (source_id = "path:line")
    const symDel = db.prepare(
      `DELETE FROM memory_graph_nodes WHERE project_id = ? AND type = 'symbol' AND source_kind = 'fast_context' AND source_id LIKE ?`
    ).run(projectId, p + ':%')
    removed += symDel.changes

    // Если файл всё ещё существует — upsert'им новые узлы
    if (allPaths.has(p)) {
      const entry = allEntries.find(e => e.filePath === p)
      if (entry) {
        const result = syncSingleEntry(projectId, entry, allEntries, basenameToPath)
        nodes += result.nodes
        edges += result.edges
      }
    }
  }

  return { nodes, edges, removed }
}
