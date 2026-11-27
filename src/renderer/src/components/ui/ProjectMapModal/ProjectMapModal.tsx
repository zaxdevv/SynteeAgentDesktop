/**
 * ProjectMapModal — карта проекта: иерархический граф кода.
 * Уровень 1 — файлы и зависимости (imports); клик по файлу → уровень 2 —
 * символы файла и вызовы. Поиск, фильтры по типу, панель деталей, клик «открыть»
 * ведёт в редактор на строку. Конвенции модалок: портал, spring, Esc/клик мимо.
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import ProjectMapCanvas, { KIND_COLORS } from './ProjectMapCanvas'
import type { PhysicsNode, PhysicsLink } from '../../../pages/Memory/graph/graphPhysics'
import {
  codeMapPartialNote, isCodeMapPhaseTerminal,
  type CodeMapGraph, type CodeMapNeighbors, type CodeMapStatus, type CodeNodeKind, type CodeEdgePrecision,
} from '../../../../../shared/projectMap'
import { openFilePath } from '../../../utils/openFilePath'
import './ProjectMapModal.css'

interface Props {
  open: boolean
  onClose: () => void
  projectId: string
  projectName: string
  workdir: string
}

const KIND_LABELS: Record<string, string> = {
  file: 'Файлы', package: 'Пакеты', function: 'Функции', class: 'Классы',
  method: 'Методы', variable: 'Переменные', field: 'Поля', interface: 'Интерфейсы',
  enum: 'Enum', struct: 'Структуры', type: 'Типы',
}

const FILTER_KINDS: CodeNodeKind[] = ['function', 'class', 'variable', 'interface', 'enum', 'field']
const EMPTY_GRAPH: CodeMapGraph = { nodes: [], edges: [] }

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

export default function ProjectMapModal({ open, ...props }: Props) {
  return open ? <ProjectMapDialog key={props.projectId} {...props} /> : null
}

function ProjectMapDialog({ onClose, projectId, projectName, workdir }: Omit<Props, 'open'>) {
  const [status, setStatus] = useState<CodeMapStatus | null>(null)
  const [result, setResult] = useState<{ path: string | null; graph: CodeMapGraph } | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const level = selectedFile === null ? 'files' : 'file'
  const graph = result?.path === selectedFile ? result.graph : EMPTY_GRAPH
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [nodeDetails, setNodeDetails] = useState<{ id: string; data: CodeMapNeighbors } | null>(null)
  const neighbors = nodeDetails && nodeDetails.id === selectedId ? nodeDetails.data : null
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<Set<CodeNodeKind>>(new Set())
  const [loading, setLoading] = useState(true)

  // Esc закрывает
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Загрузка при открытии + автообновление по прогрессу.
  useEffect(() => {
    const api = window.syntee.projectMap
    let disposed = false
    let inFlight = false
    let refreshQueued = false
    const load = async () => {
      if (inFlight) { refreshQueued = true; return }
      inFlight = true
      try {
        const [graph, status] = await Promise.all([
          selectedFile === null
            ? api.getGraph(projectId, { kinds: ['file', 'package'], edgeTypes: ['imports'], limit: 5000 })
            : api.getFileGraph(projectId, selectedFile),
          api.getStatus(projectId),
        ])
        if (disposed) return
        setResult({ path: selectedFile, graph })
        setStatus(status)
      } catch { /* Keep the last usable graph on a transient IPC error. */ }
      finally {
        inFlight = false
        if (!disposed) {
          setLoading(false)
          if (refreshQueued) { refreshQueued = false; void load() }
        }
      }
    }
    const unsub = api.onProgress(p => {
      if (p.projectId === projectId && isCodeMapPhaseTerminal(p.phase)) void load()
    })
    setLoading(true)
    void load()
    return () => { disposed = true; unsub() }
  }, [projectId, selectedFile])

  // Детали выбранного узла
  useEffect(() => {
    if (!selectedId) { setNodeDetails(null); return }
    let cancelled = false
    window.syntee.projectMap.getNeighbors(projectId, selectedId).then(data => {
      if (!cancelled) setNodeDetails({ id: selectedId, data })
    }).catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [selectedId, projectId, graph])

  // Поиск → подсветка
  const [highlightIds, setHighlightIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!search.trim()) { setHighlightIds(new Set()); return }
    let cancelled = false
    const t = setTimeout(() => {
      window.syntee.projectMap.findNodes(projectId, search.trim(), 50).then(nodes => {
        if (!cancelled) setHighlightIds(new Set(nodes.map(n => n.id)))
      }).catch(() => { /* ignore */ })
    }, 200)
    return () => { cancelled = true; clearTimeout(t) }
  }, [search, projectId])

  // Фильтр по типу (только на уровне файла)
  const filteredGraph = useMemo(() => {
    if (level === 'files' || kindFilter.size === 0) return graph
    const nodes = graph.nodes.filter(n => n.kind === 'file' || n.kind === 'package' || kindFilter.has(n.kind))
    const ids = new Set(nodes.map(n => n.id))
    const edges = graph.edges.filter(e => ids.has(e.fromNode) && ids.has(e.toNode))
    return { nodes, edges }
  }, [graph, kindFilter, level])

  // Маппинг в физические узлы
  const { physicsNodes, physicsLinks, precision } = useMemo(() => {
    const degree = new Map<string, number>()
    for (const e of filteredGraph.edges) {
      degree.set(e.fromNode, (degree.get(e.fromNode) ?? 0) + 1)
      degree.set(e.toNode, (degree.get(e.toNode) ?? 0) + 1)
    }
    const physicsNodes: PhysicsNode[] = filteredGraph.nodes.map(n => {
      const deg = degree.get(n.id) ?? 0
      const base = n.kind === 'file' ? 9 : n.kind === 'package' ? 7 : 6
      return {
        id: n.id,
        type: n.kind,
        label: n.kind === 'file' ? basename(n.filePath) : n.name,
        weight: 1,
        pinned: false,
        sourceKind: null,
        sourceId: null,
        radius: base + Math.min(10, deg * 0.6),
        color: KIND_COLORS[n.kind] ?? KIND_COLORS.definition,
        degree: deg,
      }
    })
    const ids = new Set(physicsNodes.map(n => n.id))
    const physicsLinks: PhysicsLink[] = filteredGraph.edges
      .filter(e => ids.has(e.fromNode) && ids.has(e.toNode))
      .map(e => ({ id: e.id, source: e.fromNode, target: e.toNode, type: e.type, weight: 1 }))
    const precision = new Map<string, CodeEdgePrecision>(filteredGraph.edges.map(e => [e.id, e.precision]))
    return { physicsNodes, physicsLinks, precision }
  }, [filteredGraph])

  const nodeById = useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph])
  const selectedNode = selectedId ? nodeById.get(selectedId) ?? neighbors?.node ?? null : null

  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id)
    if (!id) return
    const node = nodeById.get(id)
    if (!node) return
    // Клик по файлу на уровне файлов → drill-down.
    if (level === 'files' && node.kind === 'file') {
      setSelectedFile(node.filePath)
      setSelectedId(null)
    }
  }, [nodeById, level])

  const handleOpen = useCallback((id: string) => {
    const node = nodeById.get(id) ?? (selectedNode?.id === id ? selectedNode : null)
    if (!node || node.kind === 'package') return
    const line = node.lineStart > 0 ? `:${node.lineStart}` : ''
    void openFilePath(`${node.filePath}${line}`, workdir)
  }, [nodeById, selectedNode, workdir])

  const backToFiles = useCallback(() => {
    setSelectedFile(null)
    setSelectedId(null)
  }, [])

  const toggleKind = (k: CodeNodeKind) => {
    setKindFilter(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })
  }

  const rebuild = () => {
    void window.syntee.projectMap.rebuild(projectId)
  }

  const stateLabel = status?.state === 'ready' ? 'готова'
    : status?.state === 'partial' ? 'неполная'
    : status?.state === 'building' ? 'строится…'
    : status?.state === 'error' ? 'ошибка' : 'не построена'

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="pmap-overlay"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
      >
        <motion.div
          className="pmap-modal"
          initial={{ opacity: 0, scale: 0.96, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 12 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          onMouseDown={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="pmap-header">
            <div className="pmap-header-title">
              <AppIcon name="gitBranch" size="md" tone="accent" />
              <div>
                <div className="pmap-title">Карта проекта</div>
                <div
                  className="pmap-subtitle"
                  title={status?.state === 'partial' ? codeMapPartialNote(status) : undefined}
                >{projectName} · {stateLabel}{status ? ` · ${status.totalNodes} узлов, ${status.totalEdges} связей` : ''}</div>
              </div>
            </div>
            <div className="pmap-header-actions">
              <button className="pmap-btn pmap-btn--ghost" onClick={rebuild} title="Пересобрать карту">
                <AppIcon name="refreshCw" size="xs" /> Пересобрать
              </button>
              <button className="pmap-close" onClick={onClose} title="Закрыть (Esc)">
                <AppIcon name="x" size="sm" />
              </button>
            </div>
          </div>

          {/* Toolbar */}
          <div className="pmap-toolbar">
            {level === 'file' && (
              <button className="pmap-btn pmap-btn--ghost" onClick={backToFiles}>
                <AppIcon name="chevronLeft" size="xs" /> Файлы
              </button>
            )}
            <div className="pmap-breadcrumb">
              {level === 'files' ? 'Все файлы' : selectedFile}
            </div>
            <div className="pmap-search">
              <AppIcon name="search" size="xs" />
              <input
                className="pmap-search-input"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Поиск символа…"
              />
            </div>
            {level === 'file' && (
              <div className="pmap-filters">
                {FILTER_KINDS.map(k => (
                  <button
                    key={k}
                    className={`pmap-chip ${kindFilter.has(k) ? 'pmap-chip--on' : ''}`}
                    style={{ '--chip-color': KIND_COLORS[k] } as React.CSSProperties}
                    onClick={() => toggleKind(k)}
                  >
                    {KIND_LABELS[k] ?? k}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Body */}
          <div className="pmap-body">
            <div className="pmap-graph-area">
              {loading && <div className="pmap-loading"><span className="pmap-spinner" /> Загрузка…</div>}
              {!loading && physicsNodes.length === 0 && (
                <div className="pmap-empty">
                  {status?.state === 'building'
                    ? 'Карта строится в фоне…'
                    : status?.state === 'partial'
                    ? codeMapPartialNote(status)
                    : 'Нет данных. Нажмите «Пересобрать».'}
                </div>
              )}
              {physicsNodes.length > 0 && (
                <ProjectMapCanvas
                  nodes={physicsNodes}
                  links={physicsLinks}
                  precision={precision}
                  selectedId={selectedId}
                  highlightIds={highlightIds}
                  onSelect={handleSelect}
                  onOpen={handleOpen}
                />
              )}
              <div className="pmap-legend">
                <span><i style={{ background: KIND_COLORS.file }} /> файл</span>
                <span><i style={{ background: KIND_COLORS.function }} /> функция</span>
                <span><i style={{ background: KIND_COLORS.class }} /> класс</span>
                <span><i style={{ background: KIND_COLORS.variable }} /> переменная</span>
                <span className="pmap-legend-edge">— точно · ~ эвристика · ? неоднозначно</span>
              </div>
            </div>

            {/* Side panel */}
            <div className="pmap-side">
              {selectedNode ? (
                <>
                  <div className="pmap-side-head">
                    <span className="pmap-kind-dot" style={{ background: KIND_COLORS[selectedNode.kind] ?? KIND_COLORS.definition }} />
                    <div className="pmap-side-name">{selectedNode.name}</div>
                    <span className="pmap-kind-label">{selectedNode.kind}</span>
                  </div>
                  {selectedNode.parentName && <div className="pmap-side-row">в {selectedNode.parentName}</div>}
                  <div className="pmap-side-row pmap-side-path">{selectedNode.filePath}{selectedNode.lineStart > 0 ? `:${selectedNode.lineStart}` : ''}</div>
                  {selectedNode.signature && <pre className="pmap-side-sig">{selectedNode.signature}</pre>}
                  {selectedNode.kind !== 'package' && (
                    <button className="pmap-btn pmap-btn--accent pmap-open-btn" onClick={() => handleOpen(selectedNode.id)}>
                      <AppIcon name="fileText" size="xs" /> Открыть в редакторе
                    </button>
                  )}
                  {neighbors && neighbors.callers.length > 0 && (
                    <div className="pmap-side-section">
                      <div className="pmap-side-label">Вызывают ({neighbors.callerCount})</div>
                      {neighbors.callers.map(n => (
                        <button key={n.id} className="pmap-side-item" onClick={() => setSelectedId(n.id)}>
                          <span className="pmap-kind-dot" style={{ background: KIND_COLORS[n.kind] ?? KIND_COLORS.definition }} />
                          {n.name} <span className="pmap-side-file">{basename(n.filePath)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {neighbors && neighbors.callees.length > 0 && (
                    <div className="pmap-side-section">
                      <div className="pmap-side-label">Вызывает ({neighbors.calleeCount})</div>
                      {neighbors.callees.map(n => (
                        <button key={n.id} className="pmap-side-item" onClick={() => setSelectedId(n.id)}>
                          <span className="pmap-kind-dot" style={{ background: KIND_COLORS[n.kind] ?? KIND_COLORS.definition }} />
                          {n.name} <span className="pmap-side-file">{basename(n.filePath)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="pmap-side-hint">
                  Клик по узлу — детали и связи.<br />
                  Двойной клик — открыть файл.<br />
                  {level === 'files' ? 'Клик по файлу — символы внутри.' : 'Колесо — зум, перетаскивание — панорама.'}
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
