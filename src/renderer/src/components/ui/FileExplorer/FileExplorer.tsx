import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useShallow } from 'zustand/react/shallow'
import AppIcon from '../AppIcon/AppIcon'
import FileIcon from '../FileIcon/FileIcon'
import { useFileTabsStore } from '../../../store/fileTabs.store'
import FileTreeContextMenu from './FileTreeContextMenu'
import type { MenuPos } from '../../../utils/contextMenuPosition'
import './FileExplorer.css'

interface FsEntry {
  name: string
  path: string
  relPath: string
  isDir: boolean
  isSymlink: boolean
  size: number
  mtime: number
}

interface FileExplorerProps {
  workdir: string | null
}

// ── Flat node for virtualization ────────────────────────────────────────
interface FlatNode {
  relPath: string
  name: string
  isDir: boolean
  depth: number
  isOpen: boolean
  isLoading: boolean
  isSelected: boolean
}

function buildFlatTree(
  tree: Record<string, FsEntry[]>,
  expanded: Set<string>,
  loadingDir: Set<string>,
  selectedFile: string | null,
  rootName: string,
): FlatNode[] {
  const result: FlatNode[] = []
  const walk = (relPath: string, name: string, isDir: boolean, depth: number) => {
    result.push({
      relPath,
      name,
      isDir,
      depth,
      isOpen: expanded.has(relPath),
      isLoading: loadingDir.has(relPath),
      isSelected: !isDir && selectedFile === relPath,
    })
    if (isDir && expanded.has(relPath)) {
      const entries = tree[relPath]
      if (entries) {
        for (const child of entries) {
          walk(child.relPath, child.name, child.isDir, depth + 1)
        }
      }
    }
  }
  walk('', rootName, true, 0)
  return result
}

export default function FileExplorer({ workdir }: FileExplorerProps) {
  const [tree, setTree] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [loadingDir, setLoadingDir] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<FsEntry[] | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Подписка на открытые файловые табы — для badge в дереве.
  const openFileTabs = useFileTabsStore(useShallow(s => s.openFileTabs))
  const openFileRelPaths = useMemo(() => new Set(openFileTabs.map(t => t.relPath)), [openFileTabs])
  const activeFileTabId = useFileTabsStore(s => s.activeFileTabId)
  // Контекстное меню по ПКМ на файле в дереве
  const [ctxMenu, setCtxMenu] = useState<{ relPath: string; pos: MenuPos } | null>(null)

  // treeRef — чтобы toggleDir не зависел от tree в deps (стабильный callback).
  const treeRef = useRef(tree)
  treeRef.current = tree

  const loadDir = useCallback(async (relPath: string) => {
    if (!workdir) return
    setLoadingDir(prev => new Set(prev).add(relPath))
    try {
      const result = await window.syntee.fs.listDirectory({ root: workdir, relPath }) as
        { success: boolean; entries: FsEntry[]; error?: string }
      if (!result.success) {
        setError(result.error ?? 'Failed to load directory')
        setTree(prev => ({ ...prev, [relPath]: [] }))
      } else {
        setTree(prev => ({ ...prev, [relPath]: result.entries }))
        setError(null)
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
      setTree(prev => ({ ...prev, [relPath]: [] }))
    } finally {
      setLoadingDir(prev => {
        const next = new Set(prev)
        next.delete(relPath)
        return next
      })
    }
  }, [workdir])

  // Загрузка корня при монтировании
  useEffect(() => {
    if (workdir && !treeRef.current['']) {
      loadDir('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workdir])

  // Стабильный toggleDir — не пересоздаётся при каждом обновлении tree.
  const toggleDir = useCallback((relPath: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })
    if (!treeRef.current[relPath]) {
      loadDir(relPath)
    }
  }, [loadDir])

  // Клик по файлу → открываем таб в правой панели (Codex-style).
  // Панель уже открыта (мы внутри неё), просто создаём/активируем таб.
  const openFile = useCallback(async (entry: FsEntry) => {
    if (!workdir) return
    setSelectedFile(entry.relPath)
    await useFileTabsStore.getState().openFile(entry.relPath, workdir)
  }, [workdir])

  const rootName = workdir ? (workdir.split(/[\\/]/).pop() || workdir) : ''

  // ── Backend search с debounce ──────────────────────────────────────
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchScopeRef = useRef('')
  useEffect(() => {
    let cancelled = false
    if (!searchScopeRef.current) searchScopeRef.current = crypto.randomUUID()
    const scopeId = searchScopeRef.current
    const q = search.trim()
    if (!q) {
      setSearchResults(null)
      setSearchLoading(false)
      return
    }
    if (!workdir) return
    setSearchLoading(true)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const result = await window.syntee.fs.searchFiles({ root: workdir, query: q, maxResults: 200, scopeId }) as
          { success: boolean; entries: FsEntry[]; error?: string }
        if (cancelled) return
        if (result.success) {
          setSearchResults(result.entries)
        } else {
          setSearchResults([])
        }
      } catch {
        if (!cancelled) setSearchResults([])
      } finally {
        if (!cancelled) setSearchLoading(false)
      }
    }, 200)
    return () => {
      cancelled = true
      window.syntee.fs.cancelSearch(scopeId)
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [search, workdir])

  // Flat tree для виртуализации.
  const flatNodes = useMemo(
    () => {
      if (!workdir) return []
      if (search.trim() && searchResults) {
        return searchResults.map(e => ({
          relPath: e.relPath,
          name: e.name,
          isDir: false,
          depth: 0,
          isOpen: false,
          isLoading: false,
          isSelected: selectedFile === e.relPath,
        }))
      }
      return buildFlatTree(tree, expanded, loadingDir, selectedFile, rootName)
    },
    [tree, expanded, loadingDir, selectedFile, rootName, workdir, search, searchResults],
  )

  const virtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 6,
  })

  if (!workdir) {
    return (
      <div className="file-explorer file-explorer--empty">
        <AppIcon name="folder" size="lg" tone="muted" />
        <p>Нет рабочей директории</p>
        <p className="file-explorer__hint">Выберите проект с рабочей папкой, чтобы просматривать файлы</p>
      </div>
    )
  }

  if (error && Object.keys(tree).length === 0) {
    return (
      <div className="file-explorer file-explorer--empty">
        <AppIcon name="x" size="lg" tone="danger" />
        <p>Не удалось загрузить файлы</p>
        <p className="file-explorer__hint">{error}</p>
        <button className="file-explorer__retry" onClick={() => loadDir('')}>
          <AppIcon name="refreshCw" size="xs" /> Повторить
        </button>
      </div>
    )
  }

  return (
    <div className="file-explorer">
      <div className="file-explorer__tree">
        <div className="file-explorer__tree-header">
          <AppIcon name="folder" size="xs" />
          <span className="file-explorer__root-name" title={workdir}>{rootName}</span>
          <button
            className="file-explorer__refresh"
            title="Обновить"
            onClick={() => {
              setTree({})
              loadDir('')
            }}
          >
            <AppIcon name="refreshCw" size="xs" />
          </button>
        </div>
        <div className="file-explorer__search">
          <AppIcon name="search" size="xs" tone="muted" />
          <input
            className="file-explorer__search-input"
            type="text"
            placeholder="Фильтр файлов…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="file-explorer__search-clear" onClick={() => setSearch('')} title="Очистить">
              <AppIcon name="x" size="xs" />
            </button>
          )}
        </div>
        <div className="file-explorer__tree-body" ref={scrollRef}>
          {searchLoading && (
            <div className="git-panel__diff-loading" style={{ padding: '12px 8px' }}>
              <AppIcon name="loader" size="xs" animation="spin" />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Поиск…</span>
            </div>
          )}
          {!searchLoading && search.trim() && flatNodes.length === 0 && (
            <div style={{ padding: '12px 8px', fontSize: 12, color: 'var(--text-muted)' }}>
              Ничего не найдено
            </div>
          )}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map(vi => {
              const node = flatNodes[vi.index]
              return (
                <div
                  key={node.relPath || '__root__'}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    transform: `translateY(${vi.start}px)`,
                    width: '100%',
                    height: vi.size,
                  }}
                >
                  <FileTreeRow
                    node={node}
                    onToggleDir={toggleDir}
                    onOpenFile={openFile}
                    showPath={!!search.trim()}
                    isOpen={openFileRelPaths.has(node.relPath)}
                    isActive={activeFileTabId === node.relPath}
                    onContextMenu={(e, relPath) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setCtxMenu({ relPath, pos: { x: e.clientX, y: e.clientY } })
                    }}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <FileTreeContextMenu
        relPath={ctxMenu?.relPath ?? null}
        workdir={workdir}
        pos={ctxMenu?.pos ?? null}
        onClose={() => setCtxMenu(null)}
      />
    </div>
  )
}

// ── FileTreeRow — одна строка дерева, memo-изирована ────────────────────
interface FileTreeRowProps {
  node: FlatNode
  onToggleDir: (relPath: string) => void
  onOpenFile: (entry: FsEntry) => void
  showPath?: boolean
  isOpen?: boolean
  isActive?: boolean
  onContextMenu?: (e: React.MouseEvent, relPath: string) => void
}

const FileTreeRow = memo(function FileTreeRow({ node, onToggleDir, onOpenFile, showPath, isOpen, isActive, onContextMenu }: FileTreeRowProps) {
  const { relPath, name, isDir, depth, isOpen: nodeIsOpen, isLoading, isSelected } = node

  return (
    <button
      className={`file-tree-item ${isSelected ? 'file-tree-item--selected' : ''} ${isActive ? 'file-tree-item--active' : ''}`}
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
      onClick={() => {
        if (isDir) onToggleDir(relPath)
        else onOpenFile({ name, path: '', relPath, isDir: false, isSymlink: false, size: 0, mtime: 0 })
      }}
      onContextMenu={isDir ? undefined : (e) => onContextMenu?.(e, relPath)}
    >
      {isDir ? (
        <>
          <AppIcon
            name={nodeIsOpen ? 'chevronDown' : 'chevronRight'}
            size="xs"
            tone="muted"
          />
          <AppIcon
            name={nodeIsOpen ? 'folder' : 'folder'}
            size="xs"
            tone="accent"
          />
        </>
      ) : (
        <>
          <FileIcon name={name} size={14} />
        </>
      )}
      <span className="file-tree-item__name" title={showPath ? relPath : name}>
        {showPath && !isDir ? relPath : name}
      </span>
      {/* Badge: файл открыт в редакторе */}
      {isOpen && !isDir && <span className="file-tree-item__open-badge" />}
      {isLoading && <AppIcon name="loader" size="xs" animation="spin" />}
    </button>
  )
})
