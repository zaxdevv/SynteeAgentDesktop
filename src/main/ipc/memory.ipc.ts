import { ipcMain } from 'electron'
import type Store from 'electron-store'
import {
  saveMemoryItem,
  listMemoryItems,
  deleteMemoryItem,
  searchMemory,
  pinMemoryItem,
  getMemoryStats,
  decayPrune,
  reindexAllEmbeddings,
  updateMemoryItemImportance,
  listMemoryCategories,
  createMemoryCategory,
  deleteMemoryCategory,
  type MemoryScope,
  type MemoryKind,
} from '../../core/memory/MemoryStore'
import { extractAndSaveOutcomes } from '../../core/memory/outcomeExtractor'
import { pruneOldAgentLogs } from '../../core/db/memory'
import {
  getProjectGraph,
  getGraphStats,
  deleteNode as deleteGraphNode,
  pinNode as pinGraphNode,
  pruneIsolatedNodes as pruneIsolatedGraphNodes,
  decayPruneGraph,
  type GetGraphOptions,
} from '../../core/memory/graphStore'
import { buildProjectGraph } from '../../core/memory/graphBuilder'
import { startSemanticIndexer, setSemanticIndexerForegroundPredicate } from '../../core/memory/semanticIndex'
import { activeRuns, activeRunMeta, compactRuns } from './chatShared'
import { setGlobalMemorySettingsStore } from '../../core/memory/globalMemorySettings'

/**
 * IPC для UI MemoryPage. Переработано на MemoryStore (Фаза 2).
 *
 * Старый MemoryEngine (memory.db) оставлен для обратной совместимости —
 * extractMemoriesFromConversation всё ещё используется в chat.ipc.ts
 * для явного «запомни X» (будет заменён в Фазе 3 на LLM-extractor).
 */
export function registerMemoryIPC(_store: Store): void {
  // Keep direct MemoryStore/legacy extractor calls fail-closed until chat IPC
  // registration (and make initialization order harmless).
  setGlobalMemorySettingsStore(_store)
  // Forget policy: при старте app чистим устаревшие записи. decay-prune
  // удаляет low-importance/non-accessed memory_items (pinned защищены),
  // pruneOldAgentLogs — agent_logs старше 14 дней,
  // decayPruneGraph — low-weight graph nodes (pinned защищены).
  // Не блокирует IPC-регистрацию.
  ;(async () => {
    try {
      const prunedMem = decayPrune()
      const prunedLogs = pruneOldAgentLogs()
      const prunedGraph = decayPruneGraph()
      if (prunedMem > 0 || prunedLogs > 0 || prunedGraph > 0) {
        console.log(`[memory] startup prune: ${prunedMem} memory_items, ${prunedLogs} agent_logs, ${prunedGraph} graph_nodes`)
      }
    } catch (e) {
      console.warn('[memory] startup prune failed:', (e as Error).message)
    }
  })()

  // Semantic E5-индексация (semantic_embeddings): фоново, НЕ блокирует
  // IPC-регистрацию. Первый цикл через START_DELAY_MS (модель скачивается
  // лениво при первом использовании), далее периодически каждые
  // REINDEX_INTERVAL_MS. Остановка — stopSemanticIndexer() в before-quit.
  // Если E5 недоступна — просто пропускает циклы, TF-IDF/FTS поиск не затронут.
  // activeRunMeta covers pre-worker send preparation; compactRuns covers
  // manual compaction, both of which also compete for CPU/SQLite.
  setSemanticIndexerForegroundPredicate(() => activeRuns.size > 0 || activeRunMeta.size > 0 || compactRuns.size > 0)
  startSemanticIndexer()

  // Список с фильтрами (замена memory:getAll)
  ipcMain.handle('memory:getAll', (_, filter?: {
    scope?: MemoryScope
    kind?: MemoryKind
    projectId?: string
    category?: string
    search?: string
    limit?: number
    offset?: number
  }) => {
    return listMemoryItems(filter ?? {})
  })

  // Сохранить новый факт (ручной ввод через UI)
  ipcMain.handle('memory:save', async (_, entry: {
    title: string
    content: string
    kind: MemoryKind
    scope?: MemoryScope
    key?: string
    category?: string
    projectId?: string
    importance?: number
  }) => {
    const item = await saveMemoryItem({
      ...entry,
      source: 'user_manual',
      pinned: true, // ручной ввод — защищён от decay
    })
    return item
  })

  // Удалить запись
  ipcMain.handle('memory:delete', (_, id: string) => {
    return deleteMemoryItem(id)
  })

  // Семантический поиск (для UI-поиска по памяти)
  ipcMain.handle('memory:search', async (_, params: {
    query: string
    kind?: MemoryKind
    scope?: MemoryScope | 'all'
    projectId?: string
    limit?: number
  }) => {
    const results = await searchMemory({
      query: params.query,
      kind: params.kind,
      scope: params.scope,
      projectId: params.projectId,
      limit: params.limit,
    })
    return results.map(r => ({ ...r.item, score: r.score }))
  })

  // Pin/unpin
  ipcMain.handle('memory:pin', (_, id: string, pinned: boolean) => {
    return pinMemoryItem(id, pinned)
  })

  // Обновить importance
  ipcMain.handle('memory:setImportance', (_, id: string, importance: number) => {
    return updateMemoryItemImportance(id, importance)
  })

  // Статистика
  ipcMain.handle('memory:stats', () => {
    return getMemoryStats()
  })

  // Forget policy — ручной запуск очистки (обычно auto при старте)
  ipcMain.handle('memory:prune', (_, maxAgeDays = 30, minImportance = 0.2) => {
    return decayPrune(maxAgeDays, minImportance)
  })

  // Реиндекс embeddings (после переключения TF-IDF ↔ neural)
  ipcMain.handle('memory:reindex', async () => {
    return await reindexAllEmbeddings()
  })

  // Фаза 4: ручной запуск outcome-extraction из agent_logs
  ipcMain.handle('memory:extractOutcomes', async (_, params?: { chatId?: string; projectId?: string }) => {
    return await extractAndSaveOutcomes(_store, params ?? {})
  })

  // Forget policy для agent_logs — удалить старше 14 дней
  ipcMain.handle('memory:pruneAgentLogs', (_, maxAgeDays = 14) => {
    return pruneOldAgentLogs(maxAgeDays)
  })

  // === Динамические категории ===
  ipcMain.handle('memory:getCategories', (_, projectId?: string) => {
    return listMemoryCategories(projectId)
  })

  ipcMain.handle('memory:createCategory', (_, input: {
    name: string; label: string; icon?: string; color?: string
    scope?: MemoryScope; projectId?: string; kind?: MemoryKind
  }) => {
    return createMemoryCategory(input)
  })

  ipcMain.handle('memory:deleteCategory', (_, id: string) => {
    return deleteMemoryCategory(id)
  })

  // === Knowledge Graph ===

  // Получить граф проекта (с фильтрами)
  ipcMain.handle('graph:get', (_, projectId: string, opts?: GetGraphOptions) => {
    return getProjectGraph(projectId, opts ?? {})
  })

  // Статистика графа (для системного промпта и UI)
  ipcMain.handle('graph:stats', (_, projectId: string) => {
    return getGraphStats(projectId)
  })

  // Полная перестройка графа проекта
  ipcMain.handle('graph:rebuild', (_, projectId: string) => {
    return buildProjectGraph(projectId)
  })

  // Удалить узел (рёбра удалятся каскадно)
  ipcMain.handle('graph:deleteNode', (_, id: string) => {
    return deleteGraphNode(id)
  })

  // Pin/unpin узла
  ipcMain.handle('graph:pinNode', (_, id: string, pinned: boolean) => {
    return pinGraphNode(id, pinned)
  })

  // Удалить изолированные узлы (без рёбер)
  ipcMain.handle('graph:pruneIsolated', (_, projectId?: string) => {
    return pruneIsolatedGraphNodes(projectId)
  })
}
