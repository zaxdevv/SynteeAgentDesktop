/**
 * MemoryGraphTab — вкладка knowledge graph в MemoryPage.
 * Obsidian-style визуализация через d3-force + custom canvas renderer.
 * Узлы: glow-эффект, изогнутые рёбра, hover-подсветка, адаптивные метки.
 * Фильтры: по типу узла, типу ребра, weight, degree, search, изолированные.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import {
  whileHoverSm, whileTapSm, whileHoverTiny, whileTapTiny,
  whileHoverListItem, whileTapListItem, springHover,
} from '../../utils/motionPresets'
import GraphCanvas, {
  type GraphCanvasHandle, type GraphNode, type GraphEdge,
  NODE_TYPE_META, EDGE_TYPE_LABELS,
} from './graph/GraphCanvas'
import './MemoryGraphTab.css'

// ─── Types ───────────────────────────────────────────────────────────────────

interface GraphStats {
  nodeCount: number
  edgeCount: number
  byNodeType: Record<string, number>
  byEdgeType: Record<string, number>
  hubs: Array<{ id: string; label: string; type: string; degree: number }>
  recentDecisions: Array<{ id: string; label: string; targets: Array<{ label: string; type: string; edgeType: string }> }>
}

const EDGE_TYPE_META: Record<string, { label: string; color: string }> = {
  affects: { label: 'влияет', color: '#ef4444' },
  mentions: { label: 'упоминает', color: '#6b7280' },
  implemented_in: { label: 'реализован в', color: '#10b981' },
  depends_on: { label: 'зависит от', color: '#f59e0b' },
  supersedes: { label: 'заменяет', color: '#8b5cf6' },
  references: { label: 'ссылается', color: '#3b82f6' },
  imports: { label: 'импортирует', color: '#06b6d4' },
  calls: { label: 'вызывает', color: '#ec4899' },
  implements: { label: 'реализует', color: '#14b8a6' },
}

// ─── Component ───────────────────────────────────────────────────────────────

interface MemoryGraphTabProps {
  selectedProjectId: string
  onSelectProject: (id: string) => void
  projects: Array<{ id: string; name: string; workdir: string }>
}

export default function MemoryGraphTab({ selectedProjectId, onSelectProject, projects }: MemoryGraphTabProps) {
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null)
  const [stats, setStats] = useState<GraphStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set())
  const [filterEdgeTypes, setFilterEdgeTypes] = useState<Set<string>>(new Set())
  const [viewMode, setViewMode] = useState<'all' | 'memory' | 'files'>('all')
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [minWeight, setMinWeight] = useState(0)
  const [minDegree, setMinDegree] = useState(0)
  const [showIsolated, setShowIsolated] = useState(true)
  const [showEdgeFilters, setShowEdgeFilters] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const canvasRef = useRef<GraphCanvasHandle>(null)

  // ─── Data loading ──────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!selectedProjectId) {
      setGraph({ nodes: [], edges: [] })
      setStats(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [graphData, statsData] = await Promise.all([
        (window.syntee as any).graph.get(selectedProjectId, { limit: 400 }) as Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>,
        (window.syntee as any).graph.stats(selectedProjectId) as Promise<GraphStats>,
      ])
      setGraph(graphData)
      setStats(statsData)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [selectedProjectId])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  // ─── Filtered data ─────────────────────────────────────────────────────────

  const filteredData = useMemo(() => {
    if (!graph) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] }

    const degreeMap: Record<string, number> = {}
    for (const e of graph.edges) {
      degreeMap[e.fromNode] = (degreeMap[e.fromNode] ?? 0) + 1
      degreeMap[e.toNode] = (degreeMap[e.toNode] ?? 0) + 1
    }

    let filteredNodes = graph.nodes
    if (filterTypes.size > 0) {
      filteredNodes = filteredNodes.filter(n => filterTypes.has(n.type))
    }
    if (minWeight > 0) {
      filteredNodes = filteredNodes.filter(n => n.weight >= minWeight)
    }
    if (minDegree > 0) {
      filteredNodes = filteredNodes.filter(n => (degreeMap[n.id] ?? 0) >= minDegree)
    }
    if (!showIsolated) {
      filteredNodes = filteredNodes.filter(n => (degreeMap[n.id] ?? 0) > 0)
    }

    const nodeIds = new Set(filteredNodes.map(n => n.id))
    let filteredEdges = graph.edges.filter(e =>
      nodeIds.has(e.fromNode) && nodeIds.has(e.toNode),
    )
    if (filterEdgeTypes.size > 0) {
      filteredEdges = filteredEdges.filter(e => filterEdgeTypes.has(e.type))
    }

    // Re-filter: remove nodes with no edges after edge type filter
    if (filterEdgeTypes.size > 0 && !showIsolated) {
      const nodesWithEdges = new Set<string>()
      for (const e of filteredEdges) {
        nodesWithEdges.add(e.fromNode)
        nodesWithEdges.add(e.toNode)
      }
      filteredNodes = filteredNodes.filter(n => nodesWithEdges.has(n.id))
    }

    return { nodes: filteredNodes, edges: filteredEdges }
  }, [graph, filterTypes, filterEdgeTypes, minWeight, minDegree, showIsolated])

  // ─── Search matches ───────────────────────────────────────────────────────

  const searchMatchIds = useMemo(() => {
    if (!searchQuery.trim() || !graph) return null
    const q = searchQuery.toLowerCase()
    const matches = new Set<string>()
    for (const n of graph.nodes) {
      if (n.label.toLowerCase().includes(q)) matches.add(n.id)
    }
    return matches.size > 0 ? matches : null
  }, [searchQuery, graph])

  // ─── Actions ───────────────────────────────────────────────────────────────

  const handleRebuild = async () => {
    if (!selectedProjectId) return
    setLoading(true)
    try {
      await (window.syntee as any).graph.rebuild(selectedProjectId)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handlePin = async (id: string, pinned: boolean) => {
    await (window.syntee as any).graph.pinNode(id, pinned)
    await load()
    setSelectedNode(prev => prev ? { ...prev, pinned } : null)
  }

  const handleDelete = async (id: string) => {
    await (window.syntee as any).graph.deleteNode(id)
    setSelectedNode(null)
    await load()
  }

  const handlePruneIsolated = async () => {
    if (!selectedProjectId) return
    await (window.syntee as any).graph.pruneIsolated(selectedProjectId)
    await load()
  }

  const handleSelectNode = useCallback((id: string | null) => {
    if (!id) {
      setSelectedNode(null)
      return
    }
    const node = graph?.nodes.find(n => n.id === id) ?? null
    setSelectedNode(node)
  }, [graph])

  // ─── Filter helpers ────────────────────────────────────────────────────────

  const toggleFilter = (type: string) => {
    setFilterTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const toggleEdgeFilter = (type: string) => {
    setFilterEdgeTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const applyViewMode = (mode: 'all' | 'memory' | 'files') => {
    setViewMode(mode)
    if (mode === 'memory') {
      setFilterTypes(new Set(['decision', 'concept', 'conversation', 'task']))
    } else if (mode === 'files') {
      setFilterTypes(new Set(['file', 'symbol']))
    } else {
      setFilterTypes(new Set())
    }
  }

  // ─── Connected nodes (from full graph, not filtered) ───────────────────────

  // id → node: без O(edges × nodes) find() на каждое ребро.
  const nodeById = useMemo(() => {
    const map = new Map<string, GraphNode>()
    if (graph) for (const n of graph.nodes) map.set(n.id, n)
    return map
  }, [graph])

  const connectedNodes = useMemo(() => {
    if (!selectedNode || !graph) return []
    const result: Array<{ id: string; label: string; type: string; edgeType: string; direction: 'out' | 'in' }> = []
    for (const e of graph.edges) {
      if (e.fromNode === selectedNode.id) {
        const target = nodeById.get(e.toNode)
        if (target) result.push({ id: target.id, label: target.label, type: target.type, edgeType: e.type, direction: 'out' })
      } else if (e.toNode === selectedNode.id) {
        const target = nodeById.get(e.fromNode)
        if (target) result.push({ id: target.id, label: target.label, type: target.type, edgeType: e.type, direction: 'in' })
      }
    }
    return result
  }, [selectedNode, graph, nodeById])

  // ─── Zoom controls ─────────────────────────────────────────────────────────

  const handleZoomIn = () => canvasRef.current?.zoomIn()
  const handleZoomOut = () => canvasRef.current?.zoomOut()
  const handleZoomFit = () => canvasRef.current?.fit()

  // ─── Render ────────────────────────────────────────────────────────────────

  if (!selectedProjectId) {
    return (
      <div className="memory-graph-empty">
        <div className="memory-graph-empty-icon-wrap">
          <AppIcon name="gitBranch" size="lg" tone="muted" />
        </div>
        <p>Выберите проект для просмотра графа знаний</p>
        <select
          className="memory-graph-project-select"
          value={selectedProjectId}
          onChange={(e) => onSelectProject(e.target.value)}
        >
          <option value="">— выберите проект —</option>
          {projects.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <span className="memory-graph-empty-hint">Граф строится автоматически из диалогов и решений проекта</span>
      </div>
    )
  }

  return (
    <div className="memory-graph-tab">
      {/* Toolbar */}
      <div className="memory-graph-toolbar">
        <select
          className="memory-graph-project-select"
          value={selectedProjectId}
          onChange={(e) => onSelectProject(e.target.value)}
        >
          {projects.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        {/* Search */}
        <div className="memory-graph-search-wrap">
          <AppIcon name="search" size="sm" tone="muted" />
          <input
            className="memory-graph-search"
            placeholder="Поиск узлов…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="memory-graph-search-clear" onClick={() => setSearchQuery('')}>×</button>
          )}
        </div>

        {/* Stats */}
        <div className="memory-graph-stats">
          {stats && (
            <>
              <div className="graph-stat-card">
                <span className="graph-stat-card-icon"><AppIcon name="layers" size="sm" tone="muted" /></span>
                <span className="graph-stat-card-value">{stats.nodeCount}</span>
                <span className="graph-stat-card-label">узлов</span>
              </div>
              <div className="graph-stat-card">
                <span className="graph-stat-card-icon"><AppIcon name="gitBranch" size="sm" tone="muted" /></span>
                <span className="graph-stat-card-value">{stats.edgeCount}</span>
                <span className="graph-stat-card-label">рёбер</span>
              </div>
              {stats.hubs.length > 0 && (
                <div className="graph-stat-hubs">
                  {stats.hubs.slice(0, 3).map(h => (
                    <span key={h.id} className="graph-hub-chip">
                      {h.label.length > 14 ? h.label.slice(0, 12) + '…' : h.label}
                      <span className="graph-hub-chip-degree">·{h.degree}</span>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Actions */}
        <div className="memory-graph-actions">
          <motion.button className="graph-action-btn" onClick={handlePruneIsolated} title="Удалить изолированные узлы" whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
            <AppIcon name="trash" size="sm" /> Чистка
          </motion.button>
          <motion.button className="graph-action-btn graph-action-btn--primary" onClick={handleRebuild} disabled={loading} title="Полная перестройка" whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
            <AppIcon name="refreshCw" size="sm" className={loading ? 'graph-action-btn-spinner' : ''} /> {loading ? '…' : 'Перестроить'}
          </motion.button>
        </div>
      </div>

      {/* View mode + Node type filters — one compact row */}
      <div className="memory-graph-filters-row">
        {/* View mode toggle */}
        <div className="memory-graph-view-toggle">
          {(['all', 'memory', 'files'] as const).map(mode => (
            <motion.button
              key={mode}
              className={`graph-view-btn ${viewMode === mode ? 'graph-view-btn--active' : ''}`}
              onClick={() => applyViewMode(mode)}
              whileHover={whileHoverListItem}
              whileTap={whileTapListItem}
              transition={springHover}
            >
              {viewMode === mode && (
                <motion.span
                  layoutId="graph-view-active"
                  className="graph-view-btn-pill"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className="graph-view-btn-label">
                {mode === 'all' ? 'Все' : mode === 'memory' ? 'Память' : 'Файлы'}
              </span>
            </motion.button>
          ))}
        </div>

        {/* Node type filters */}
        <div className="memory-graph-filters-chips">
          {Object.entries(NODE_TYPE_META).map(([type, meta]) => {
            const count = graph?.nodes.filter(n => n.type === type).length ?? 0
            if (count === 0) return null
            return (
              <motion.button
                key={type}
                className={`graph-filter-chip ${filterTypes.has(type) ? 'graph-filter-chip--active' : ''}`}
                style={filterTypes.has(type) ? { borderColor: meta.color, background: `${meta.color}22` } : {}}
                onClick={() => toggleFilter(type)}
                whileHover={whileHoverListItem}
                whileTap={whileTapListItem}
                transition={springHover}
              >
                <span className="filter-dot" style={{ background: meta.color }} />
                {meta.label}
                <span className="filter-count">{count}</span>
              </motion.button>
            )
          })}

        {/* Edge type filter toggle */}
        <motion.button
          className={`graph-filter-chip graph-edge-filter-toggle ${showEdgeFilters ? 'graph-filter-chip--active' : ''}`}
          onClick={() => setShowEdgeFilters(p => !p)}
          whileHover={whileHoverListItem}
          whileTap={whileTapListItem}
          transition={springHover}
        >
          <AppIcon name="gitBranch" size="sm" />
          Рёбра
        </motion.button>

        {(filterTypes.size > 0 || filterEdgeTypes.size > 0 || minWeight > 0 || minDegree > 0 || !showIsolated) && (
          <motion.button
            className="graph-filter-clear"
            onClick={() => {
              setFilterTypes(new Set())
              setFilterEdgeTypes(new Set())
              setMinWeight(0)
              setMinDegree(0)
              setShowIsolated(true)
            }}
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
          >
            Сбросить всё
          </motion.button>
        )}

        {/* Advanced toggle — перенесён из view-mode ряда */}
        <motion.button
          className={`graph-filter-chip graph-advanced-toggle ${showAdvanced ? 'graph-filter-chip--active' : ''}`}
          onClick={() => setShowAdvanced(p => !p)}
          whileHover={whileHoverListItem}
          whileTap={whileTapListItem}
          transition={springHover}
          title="Расширенные фильтры"
        >
          <AppIcon name="settings" size="sm" />
        </motion.button>
        </div>
      </div>

      {/* Edge type filters (collapsible) */}
      <AnimatePresence>
        {showEdgeFilters && (
          <motion.div
            className="memory-graph-filters memory-graph-filters--edges"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <span className="filter-label">Рёбра:</span>
            {Object.entries(EDGE_TYPE_META).map(([type, meta]) => {
              const count = graph?.edges.filter(e => e.type === type).length ?? 0
              if (count === 0) return null
              return (
                <motion.button
                  key={type}
                  className={`graph-filter-chip graph-filter-chip--edge ${filterEdgeTypes.has(type) ? 'graph-filter-chip--active' : ''}`}
                  style={filterEdgeTypes.has(type) ? { borderColor: meta.color, background: `${meta.color}22` } : {}}
                  onClick={() => toggleEdgeFilter(type)}
                  whileHover={whileHoverListItem}
                  whileTap={whileTapListItem}
                  transition={springHover}
                >
                  <span className="filter-dot" style={{ background: meta.color }} />
                  {meta.label}
                  <span className="filter-count">{count}</span>
                </motion.button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Advanced filters (collapsible) */}
      <AnimatePresence>
        {showAdvanced && (
          <motion.div
            className="memory-graph-advanced"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <div className="advanced-slider-group">
              <label className="advanced-slider-label">
                Min Weight: <span className="advanced-slider-value">{minWeight.toFixed(1)}</span>
              </label>
              <input
                type="range" min="0" max="10" step="0.5"
                value={minWeight}
                onChange={e => setMinWeight(Number(e.target.value))}
                className="memory-graph-range"
              />
            </div>
            <div className="advanced-slider-group">
              <label className="advanced-slider-label">
                Min Degree: <span className="advanced-slider-value">{minDegree}</span>
              </label>
              <input
                type="range" min="0" max="20" step="1"
                value={minDegree}
                onChange={e => setMinDegree(Number(e.target.value))}
                className="memory-graph-range"
              />
            </div>
            <motion.button
              className={`advanced-toggle-btn ${!showIsolated ? 'advanced-toggle-btn--active' : ''}`}
              onClick={() => setShowIsolated(p => !p)}
              whileHover={whileHoverSm}
              whileTap={whileTapSm}
              transition={springHover}
            >
              <AppIcon name={showIsolated ? 'eye' : 'eyeOff'} size="sm" />
              {showIsolated ? 'Показывать изолированные' : 'Скрывать изолированные'}
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {error && <div className="memory-graph-error">{error}</div>}

      {/* Content: canvas + side panel */}
      <div className="memory-graph-content">
        <div className="memory-graph-canvas-wrap">
          <GraphCanvas
            ref={canvasRef}
            nodes={filteredData.nodes}
            edges={filteredData.edges}
            selectedNodeId={selectedNode?.id ?? null}
            searchMatchIds={searchMatchIds}
            onSelectNode={handleSelectNode}
          />

          {/* Legend overlay */}
          {graph && graph.nodes.length > 0 && (
            <div className="memory-graph-legend">
              <div className="memory-graph-legend-title">Типы узлов</div>
              {Object.entries(NODE_TYPE_META).map(([type, meta]) => {
                const count = graph.nodes.filter(n => n.type === type).length
                if (count === 0) return null
                return (
                  <div
                    key={type}
                    className={`memory-graph-legend-item ${filterTypes.size > 0 && !filterTypes.has(type) ? 'memory-graph-legend-item--off' : ''}`}
                    onClick={() => toggleFilter(type)}
                  >
                    <span className="memory-graph-legend-dot" style={{ background: meta.color, color: meta.color }} />
                    {meta.label}
                    <span className="memory-graph-legend-count">{count}</span>
                  </div>
                )
              })}
              {filterTypes.size > 0 && (
                <div
                  className="memory-graph-legend-item memory-graph-legend-reset"
                  onClick={() => setFilterTypes(new Set())}
                >
                  <AppIcon name="rewind" size="sm" />
                  Показать все
                </div>
              )}
            </div>
          )}

          {/* Zoom controls */}
          <div className="memory-graph-zoom">
            <motion.button className="memory-graph-zoom-btn" onClick={handleZoomIn} title="Приблизить" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>
              <AppIcon name="plus" size="sm" />
            </motion.button>
            <motion.button className="memory-graph-zoom-btn" onClick={handleZoomOut} title="Отдалить" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>
              <AppIcon name="minus" size="sm" />
            </motion.button>
            <motion.button className="memory-graph-zoom-btn" onClick={handleZoomFit} title="Вписать в экран" whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>
              <AppIcon name="maximize" size="sm" />
            </motion.button>
          </div>

          {/* Loading overlay */}
          <AnimatePresence>
            {loading && (
              <motion.div
                className="memory-graph-loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <AppIcon name="refreshCw" size="md" tone="accent" />
                <span>Загрузка…</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Side panel: selected node */}
        <AnimatePresence>
          {selectedNode && (
            <motion.div
              className="memory-graph-sidepanel"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ type: 'spring', stiffness: 360, damping: 30 }}
            >
              <div className="sidepanel-header">
                <span
                  className="sidepanel-type-badge"
                  style={{ background: NODE_TYPE_META[selectedNode.type]?.color ?? '#6b7280' }}
                >
                  {NODE_TYPE_META[selectedNode.type]?.label ?? selectedNode.type}
                </span>
                <motion.button className="sidepanel-close" onClick={() => setSelectedNode(null)} whileHover={whileHoverTiny} whileTap={whileTapTiny} transition={springHover}>×</motion.button>
              </div>
              <div className="sidepanel-body">
                <div className="sidepanel-label">{selectedNode.label}</div>

                <div>
                  <div className="sidepanel-section-title">Метаданные</div>
                  <div className="sidepanel-meta">
                    <div className="sidepanel-meta-item">
                      <span className="sidepanel-meta-key">Weight</span>
                      <span className="sidepanel-meta-value">{selectedNode.weight.toFixed(1)}</span>
                    </div>
                    <div className="sidepanel-meta-item">
                      <span className="sidepanel-meta-key">Pinned</span>
                      <span className="sidepanel-meta-value">{selectedNode.pinned ? '★ да' : 'нет'}</span>
                    </div>
                    {selectedNode.sourceKind && (
                      <div className="sidepanel-meta-item">
                        <span className="sidepanel-meta-key">Источник</span>
                        <span className="sidepanel-meta-value">{selectedNode.sourceKind}</span>
                      </div>
                    )}
                    {connectedNodes.length > 0 && (
                      <div className="sidepanel-meta-item">
                        <span className="sidepanel-meta-key">Связей</span>
                        <span className="sidepanel-meta-value">{connectedNodes.length}</span>
                      </div>
                    )}
                  </div>
                  {selectedNode.sourceId && (
                    <div className="sidepanel-source-id" style={{ marginTop: 8 }}>
                      <code>{selectedNode.sourceId.slice(0, 40)}</code>
                    </div>
                  )}
                </div>

                {connectedNodes.length > 0 && (
                  <div>
                    <div className="sidepanel-section-title">Связанные узлы ({connectedNodes.length})</div>
                    <div className="sidepanel-connections">
                      {connectedNodes.slice(0, 12).map(cn => {
                        const meta = NODE_TYPE_META[cn.type] ?? { color: '#6b7280', label: cn.type }
                        return (
                          <div
                            key={cn.id + cn.edgeType + cn.direction}
                            className="sidepanel-connection-chip"
                            onClick={() => {
                              const node = nodeById.get(cn.id)
                              if (node) setSelectedNode(node)
                            }}
                          >
                            <span className="sidepanel-connection-dot" style={{ background: meta.color }} />
                            <span className="sidepanel-connection-label">{cn.label}</span>
                            <span className="sidepanel-connection-type">
                              {cn.direction === 'out' ? '→' : '←'} {EDGE_TYPE_LABELS[cn.edgeType] ?? cn.edgeType}
                            </span>
                          </div>
                        )
                      })}
                      {connectedNodes.length > 12 && (
                        <div className="sidepanel-connections-more">
                          и ещё {connectedNodes.length - 12}…
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="sidepanel-actions">
                  <motion.button className="sidepanel-btn" onClick={() => handlePin(selectedNode.id, !selectedNode.pinned)} whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
                    <AppIcon name="pin" size="sm" /> {selectedNode.pinned ? 'Открепить' : 'Закрепить'}
                  </motion.button>
                  <motion.button className="sidepanel-btn sidepanel-btn--danger" onClick={() => handleDelete(selectedNode.id)} whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
                    <AppIcon name="trash" size="sm" /> Удалить
                  </motion.button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
