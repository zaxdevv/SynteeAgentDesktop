import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import AppIcon from '../AppIcon/AppIcon'
import FileIcon from '../FileIcon/FileIcon'
import SafeDiffEditor from '../SafeDiffEditor/SafeDiffEditor'
import CodePreview from '../CodePreview/CodePreview'
import { getLanguage } from '../CodePreview/CodePreview'
import { useFileTabsStore } from '../../../store/fileTabs.store'
import { useUIStore } from '../../../store/ui.store'
import { useToast } from '../Toast/Toast'
import './GitPanel.css'

// Офлайн Monaco (уже сконфигурирован в FileEditorPane, но повторный вызов безопасен)
loader.config({ monaco })

// ── Опции Monaco DiffEditor (модульная константа) ───────────────────────
// Инлайн-литерал в JSX пересоздавался на каждый рендер GitPanel →
// @monaco-editor/react звал updateOptions (и relayout Monaco) на КАЖДЫЙ
// рендер: каждая буква в поле коммита/поиска и 30-секундный refresh
// дёргали редактор. Стабильная identity — options применяются один раз.
// tabSize не входит в тип IDiffEditorConstructionOptions (TS2353 была и
// в старых инлайн-литералах) — сохранён через cast, runtime идентичен.
const DIFF_EDITOR_OPTIONS = {
  readOnly: true,
  fontSize: 13,
  minimap: { enabled: false },
  automaticLayout: true,
  scrollBeyondLastLine: false,
  wordWrap: 'on',
  tabSize: 2,
  renderSideBySide: true,
  padding: { top: 8, bottom: 8 },
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
  },
} as monaco.editor.IDiffEditorConstructionOptions

interface GitFileStatus {
  path: string
  indexStatus: string
  worktreeStatus: string
  raw: string
}

interface GitStatus {
  branch: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
  clean: boolean
}

interface GitLogEntry {
  hash: string
  shortHash: string
  author: string
  date: string
  message: string
}

interface CommitFile {
  path: string
  status: string
}

interface BranchInfo {
  name: string
  current: boolean
}

interface GitPanelProps {
  workdir: string | null
  /**
   * Панель РЕАЛЬНО видима: mainPage === 'chat' + панель открыта + активен таб
   * Git + файловый таб не перекрывает контент + документ виден. Git-поллинг
   * (и первичная загрузка) идёт ТОЛЬКО при true; при появлении видимости —
   * мгновенный refresh. Скрытая панель сохраняет последний контент.
   */
  visible?: boolean
}

interface FileTreeNode {
  name: string
  path: string
  isDir: boolean
  children: FileTreeNode[]
  file?: GitFileStatus
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  M: { label: 'M', cls: 'git-status-modified' },
  A: { label: 'A', cls: 'git-status-added' },
  D: { label: 'D', cls: 'git-status-deleted' },
  R: { label: 'R', cls: 'git-status-renamed' },
  C: { label: 'C', cls: 'git-status-copied' },
  U: { label: 'U', cls: 'git-status-unmerged' },
  '?': { label: '?', cls: 'git-status-untracked' },
  ' ': { label: ' ', cls: 'git-status-unchanged' },
}

function getFileBadge(file: GitFileStatus): { label: string; cls: string; title: string } {
  const idx = file.indexStatus
  const wt = file.worktreeStatus
  if (idx === '?' && wt === '?') return { label: '?', cls: 'git-status-untracked', title: 'Untracked' }
  if (idx === 'M') return { label: 'M', cls: 'git-status-staged', title: 'Modified (staged)' }
  if (wt === 'M') return { label: 'M', cls: 'git-status-modified', title: 'Modified (working tree)' }
  if (idx === 'A') return { label: 'A', cls: 'git-status-staged', title: 'Added (staged)' }
  if (idx === 'D') return { label: 'D', cls: 'git-status-staged', title: 'Deleted (staged)' }
  if (wt === 'D') return { label: 'D', cls: 'git-status-deleted', title: 'Deleted (working tree)' }
  if (idx === 'R') return { label: 'R', cls: 'git-status-staged', title: 'Renamed (staged)' }
  if (idx === 'C') return { label: 'C', cls: 'git-status-staged', title: 'Copied (staged)' }
  if (idx === 'U' || wt === 'U') return { label: 'U', cls: 'git-status-unmerged', title: 'Unmerged' }
  const meta = STATUS_META[idx] ?? STATUS_META[wt] ?? STATUS_META[' ']
  return { label: meta.label, cls: meta.cls, title: file.raw }
}

// ── Дедуп идентичных git-данных ─────────────────────────────────────────
// 30s-поллинг часто возвращает те же status/log/diffStats. Если писать их
// в state как новые объекты/массивы, ссылки меняются → memo-строки дерева
// (GitTreeRow: prev.diffStats === next.diffStats) ре-рендерятся на каждый
// тик впустую. Сравниваем по содержимому и сохраняем прежнюю identity.
function sameGitStatus(a: GitStatus | null, b: GitStatus): boolean {
  if (!a) return false
  if (a.branch !== b.branch || a.ahead !== b.ahead || a.behind !== b.behind || a.clean !== b.clean) return false
  if (a.files.length !== b.files.length) return false
  for (let i = 0; i < a.files.length; i++) {
    const x = a.files[i]
    const y = b.files[i]
    if (x.path !== y.path || x.indexStatus !== y.indexStatus || x.worktreeStatus !== y.worktreeStatus || x.raw !== y.raw) return false
  }
  return true
}

function sameGitLog(a: GitLogEntry[], b: GitLogEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.hash !== y.hash || x.shortHash !== y.shortHash || x.author !== y.author || x.date !== y.date || x.message !== y.message) return false
  }
  return true
}

function sameDiffStats(
  a: Record<string, { added: number; deleted: number }>,
  b: Record<string, { added: number; deleted: number }>,
): boolean {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  for (const k of ak) {
    const x = a[k]
    const y = b[k]
    if (!y || x.added !== y.added || x.deleted !== y.deleted) return false
  }
  return true
}

function buildFileTree(files: GitFileStatus[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', isDir: true, children: [] }
  for (const file of files) {
    const parts = file.path.split(/[\\/]/)
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      if (isLast) {
        current.children.push({ name: part, path: file.path, isDir: false, children: [], file })
      } else {
        let child = current.children.find(c => c.isDir && c.name === part)
        if (!child) {
          child = { name: part, path: parts.slice(0, i + 1).join('/'), isDir: true, children: [] }
          current.children.push(child)
        }
        current = child
      }
    }
  }
  function sortTree(nodes: FileTreeNode[]) {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach(n => sortTree(n.children))
  }
  sortTree(root.children)
  return root.children
}

// ── Flat node for virtualization ────────────────────────────────────────
// Раньше дерево рендерилось рекурсивно через renderTreeNodes — каждый узел
// создавал DOM-ноду синхронно. Для проектов с сотнями изменённых файлов
// это вешало renderer. Теперь: flatten в массив + useVirtualizer.
interface FlatGitNode {
  key: string
  name: string
  path: string
  isDir: boolean
  depth: number
  isOpen: boolean
  file?: GitFileStatus
}

function flattenGitTree(nodes: FileTreeNode[], expandedDirs: Set<string>, search: string): FlatGitNode[] {
  const q = search.toLowerCase().trim()
  const result: FlatGitNode[] = []
  const walk = (nodes: FileTreeNode[], depth: number) => {
    for (const node of nodes) {
      if (node.isDir) {
        // Директория: показываем если есть непустые дети (после фильтра)
        const isOpen = expandedDirs.has(node.path)
        // При поиске — раскрываем все директории автоматически
        const effectiveOpen = q ? true : isOpen
        // Проверяем есть ли файлы в поддереве подходящие под фильтр
        if (q) {
          const hasMatch = treeContainsMatch(node, q)
          if (!hasMatch) continue
        }
        result.push({
          key: node.path,
          name: node.name,
          path: node.path,
          isDir: true,
          depth,
          isOpen: effectiveOpen,
        })
        if (effectiveOpen && node.children.length > 0) {
          walk(node.children, depth + 1)
        }
      } else {
        // Файл: фильтр по search
        if (q && !node.path.toLowerCase().includes(q)) continue
        result.push({
          key: node.path,
          name: node.name,
          path: node.path,
          isDir: false,
          depth,
          isOpen: false,
          file: node.file,
        })
      }
    }
  }
  walk(nodes, 0)
  return result
}

/** Проверяет содержит ли поддерево файлы подходящие под поисковый запрос. */
function treeContainsMatch(node: FileTreeNode, q: string): boolean {
  if (!node.isDir) return node.path.toLowerCase().includes(q)
  for (const child of node.children) {
    if (treeContainsMatch(child, q)) return true
  }
  return false
}

// ── Memoized tree row для виртуализации ─────────────────────────────────
const rowStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
}

const GitTreeRow = memo(function GitTreeRow({
  node, vItemStart, selectedFile, diffStats,
  onToggleDir, onLoadDiff,
}: {
  node: FlatGitNode
  vItemStart: number
  selectedFile: string | null
  diffStats: Record<string, { added: number; deleted: number }>
  onToggleDir: (path: string) => void
  onLoadDiff: (file: GitFileStatus) => void
}) {
  if (node.isDir) {
    return (
      <div style={{ ...rowStyle, transform: `translateY(${vItemStart}px)` }}>
        <button
          className="git-tree-dir"
          style={{ paddingLeft: 8 + node.depth * 14 }}
          onClick={() => onToggleDir(node.path)}
          title={node.path}
        >
          <AppIcon name={node.isOpen ? 'chevronDown' : 'chevronRight'} size="xs" />
          <AppIcon name="folder" size="xs" />
          <span className="git-tree-dir__name">{node.name}</span>
        </button>
      </div>
    )
  }
  const badge = node.file ? getFileBadge(node.file) : null
  const stats = node.file ? diffStats[node.file.path] : undefined
  return (
    <div style={{ ...rowStyle, transform: `translateY(${vItemStart}px)` }}>
      <button
        className={`git-file-item ${selectedFile === node.path ? 'git-file-item--selected' : ''}`}
        style={{ paddingLeft: 8 + node.depth * 14 + 18 }}
        onClick={() => node.file && onLoadDiff(node.file)}
        title={node.path}
      >
        {badge && <span className={`git-file-item__badge ${badge.cls}`}>{badge.label}</span>}
        <FileIcon name={node.name} size={14} />
        <span className="git-file-item__name">{node.name}</span>
        {stats && (
          <span className="git-file-item__stats">
            <span className="git-file-item__stats-added">+{stats.added}</span>
            <span className="git-file-item__stats-deleted">-{stats.deleted}</span>
          </span>
        )}
      </button>
    </div>
  )
}, (prev, next) =>
  prev.node === next.node &&
  prev.vItemStart === next.vItemStart &&
  prev.selectedFile === next.selectedFile &&
  prev.diffStats === next.diffStats &&
  prev.onToggleDir === next.onToggleDir &&
  prev.onLoadDiff === next.onLoadDiff
)

// ── Memoized status-row (status-режим, без виртуализации) ───────────────
// Раньше renderStatusFile был инлайн-функцией в GitPanel: все строки
// пересоздавались на каждый рендер панели (ввод в поиск/поле коммита,
// refresh, открытие диффа). Теперь — memo со стабильными пропсами.
const StatusFileRow = memo(function StatusFileRow({
  file, selected, stats, actionLoading,
  onStage, onUnstage, onDiscard, onLoadDiff,
}: {
  file: GitFileStatus
  selected: boolean
  stats: { added: number; deleted: number } | undefined
  actionLoading: string | null
  onStage: (file: string) => void | Promise<void>
  onUnstage: (file: string) => void | Promise<void>
  onDiscard: (file: string, untracked: boolean) => void | Promise<void>
  onLoadDiff: (file: GitFileStatus) => void | Promise<void>
}) {
  const badge = getFileBadge(file)
  const isUntracked = file.indexStatus === '?' && file.worktreeStatus === '?'
  const isStaged = file.indexStatus !== ' ' && file.indexStatus !== '?'
  const isUnstaged = file.worktreeStatus !== ' ' && file.worktreeStatus !== '?'
  return (
    <div className={`git-file-item-row ${selected ? 'git-file-item-row--selected' : ''}`}>
      <button
        className={`git-file-item ${selected ? 'git-file-item--selected' : ''}`}
        style={{ paddingLeft: 26 }}
        onClick={() => void onLoadDiff(file)}
        title={file.path}
      >
        {badge && <span className={`git-file-item__badge ${badge.cls}`}>{badge.label}</span>}
        <FileIcon name={file.path.split('/').pop() || file.path} size={14} />
        <span className="git-file-item__name">{file.path}</span>
        {stats && (
          <span className="git-file-item__stats">
            <span className="git-file-item__stats-added">+{stats.added}</span>
            <span className="git-file-item__stats-deleted">-{stats.deleted}</span>
          </span>
        )}
      </button>
      <div className="git-file-item__actions">
        {isUntracked && (
          <button
            className="git-file-action"
            title="Добавить (git add)"
            onClick={(e) => { e.stopPropagation(); void onStage(file.path) }}
            disabled={actionLoading === file.path}
          >
            <AppIcon name="plus" size="xs" />
          </button>
        )}
        {isStaged && !isUntracked && (
          <button
            className="git-file-action"
            title="Убрать из staged (git reset)"
            onClick={(e) => { e.stopPropagation(); void onUnstage(file.path) }}
            disabled={actionLoading === file.path}
          >
            <AppIcon name="minus" size="xs" />
          </button>
        )}
        {!isStaged && !isUntracked && isUnstaged && (
          <button
            className="git-file-action"
            title="Добавить (git add)"
            onClick={(e) => { e.stopPropagation(); void onStage(file.path) }}
            disabled={actionLoading === file.path}
          >
            <AppIcon name="plus" size="xs" />
          </button>
        )}
        <button
          className="git-file-action git-file-action--danger"
          title={isUntracked ? 'Удалить файл' : 'Отменить изменения'}
          onClick={(e) => { e.stopPropagation(); void onDiscard(file.path, isUntracked) }}
          disabled={actionLoading === file.path}
        >
          <AppIcon name="undo" size="xs" />
        </button>
      </div>
    </div>
  )
})

// ── GitDiffView — memoized diff-секция ──────────────────────────────────
// Раньше жила инлайн в конце GitPanel: любой ре-рендер панели (ввод в поле
// коммита/поиске, 30-секундный refresh, stage/unstage) ре-рендерил и её —
// вместе с Monaco-обёрткой. Теперь memo: ре-рендер только при смене
// выбранного файла/коммита/диффа.
// Keys в AnimatePresence стабильные ('file'/'commit'/'empty'): переключение
// файл→файл БЕЗ ремоунта — @monaco-editor/react при смене original/modified
// свапает модели сам (в разы дешевле создания нового DiffEditor). Раньше
// key={selectedFile} пересоздавал виджет целиком, и во время 0.12s
// exit/enter-перехода жили ДВА редактора одновременно.
const GitDiffView = memo(function GitDiffView({
  selectedFile, selectedCommit, viewMode, diffLoading, diffError, diff, diffVersions,
  fileLoading, fileContent, commitFiles, selectedCommitFile,
  onViewMode, onLoadFileContent, onOpenInViewer, onOpenInEditor, onLoadCommitFileDiff,
}: {
  selectedFile: string | null
  selectedCommit: { hash: string; message: string; author: string; date: string } | null
  viewMode: 'diff' | 'file'
  diffLoading: boolean
  diffError: string | null
  diff: string | null
  diffVersions: { original: string; modified: string } | null
  fileLoading: boolean
  fileContent: { path: string; content: string; isBinary: boolean } | null
  commitFiles: CommitFile[]
  selectedCommitFile: string | null
  onViewMode: (mode: 'diff' | 'file') => void
  onLoadFileContent: (path: string) => void | Promise<void>
  onOpenInViewer: (path: string) => void
  onOpenInEditor: (path: string) => void
  onLoadCommitFileDiff: (hash: string, file: string) => void | Promise<void>
}) {
  return (
    <div className="git-panel__diff">
      <AnimatePresence>
        {selectedFile && (
          <motion.div
            key="file"
            className="git-panel__diff-content"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            <div className="git-panel__diff-header">
              <AppIcon name="fileText" size="xs" />
              <span className="git-panel__diff-path" title={selectedFile}>{selectedFile}</span>
              <div className="git-panel__diff-actions">
                <div className="git-panel__view-toggle">
                  <button
                    className={`git-panel__view-btn ${viewMode === 'diff' ? 'git-panel__view-btn--active' : ''}`}
                    onClick={() => onViewMode('diff')}
                    title="Показать diff"
                  >
                    <AppIcon name="git" size="xs" />
                  </button>
                  <button
                    className={`git-panel__view-btn ${viewMode === 'file' ? 'git-panel__view-btn--active' : ''}`}
                    onClick={() => { onViewMode('file'); void onLoadFileContent(selectedFile) }}
                    title="Показать весь файл"
                  >
                    <AppIcon name="fileText" size="xs" />
                  </button>
                </div>
                <button
                  className="git-panel__action-btn"
                  onClick={() => onOpenInViewer(selectedFile)}
                  title="Открыть в просмотре"
                >
                  <AppIcon name="eye" size="xs" />
                </button>
                <button
                  className="git-panel__action-btn"
                  onClick={() => onOpenInEditor(selectedFile)}
                  title="Открыть в редакторе"
                >
                  <AppIcon name="filePen" size="xs" />
                </button>
              </div>
            </div>
            <div className="git-panel__diff-body">
              {viewMode === 'diff' ? (
                <>
                  {diffLoading ? (
                    <div className="git-panel__diff-loading">
                      <AppIcon name="loader" size="sm" animation="spin" />
                      <span>Загрузка diff...</span>
                    </div>
                  ) : diffError ? (
                    <div className="git-panel__diff-error">
                      <AppIcon name="x" size="lg" tone="danger" />
                      <p>{diffError}</p>
                    </div>
                  ) : diffVersions ? (
                    <SafeDiffEditor
                      original={diffVersions.original}
                      modified={diffVersions.modified}
                      language={getLanguage(selectedFile)}
                      theme="vs-dark"
                      options={DIFF_EDITOR_OPTIONS}
                    />
                  ) : diff ? (
                    <div className="git-panel__diff-text">{diff}</div>
                  ) : null}
                </>
              ) : (
                <>
                  {fileLoading ? (
                    <div className="git-panel__diff-loading">
                      <AppIcon name="loader" size="sm" animation="spin" />
                      <span>Загрузка файла...</span>
                    </div>
                  ) : fileContent?.isBinary ? (
                    <div className="git-panel__diff-error">
                      <AppIcon name="fileText" size="lg" tone="muted" />
                      <p>Бинарный файл</p>
                    </div>
                  ) : fileContent ? (
                    <CodePreview content={fileContent.content} path={selectedFile} />
                  ) : null}
                </>
              )}
            </div>
          </motion.div>
        )}
        {selectedCommit && (
          <motion.div
            key="commit"
            className="git-panel__diff-content"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            <div className="git-panel__diff-header">
              <AppIcon name="git" size="xs" />
              <span className="git-panel__diff-path" title={selectedCommit.message}>
                {selectedCommit.hash.slice(0, 7)} · {selectedCommit.message.split('\n')[0]}
              </span>
              {selectedCommit.author && (
                <span className="git-panel__commit-author">{selectedCommit.author}</span>
              )}
              {selectedCommit.date && (
                <span className="git-panel__commit-date">{selectedCommit.date}</span>
              )}
            </div>
            {selectedCommit.message.includes('\n') && (
              <div className="git-panel__commit-body">
                {selectedCommit.message.split('\n').slice(1).join('\n').trim()}
              </div>
            )}
            {/* Список файлов в коммите — кликабельные, как в VS Code */}
            {commitFiles.length > 0 && (
              <div className="git-panel__commit-files">
                {commitFiles.map(cf => (
                  <button
                    key={cf.path}
                    className={`git-panel__commit-file ${selectedCommitFile === cf.path ? 'git-panel__commit-file--selected' : ''}`}
                    title={cf.path}
                    onClick={() => void onLoadCommitFileDiff(selectedCommit.hash, cf.path)}
                  >
                    <span className={`git-panel__commit-file-badge git-status-${cf.status === 'M' ? 'modified' : cf.status === 'A' ? 'added' : cf.status === 'D' ? 'deleted' : cf.status === 'R' ? 'renamed' : 'untracked'}`}>
                      {cf.status}
                    </span>
                    <FileIcon name={cf.path.split('/').pop() || cf.path} size={14} />
                    <span className="git-panel__commit-file-path">{cf.path}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="git-panel__diff-body">
              {diffLoading ? (
                <div className="git-panel__diff-loading">
                  <AppIcon name="loader" size="sm" animation="spin" />
                  <span>Загрузка коммита...</span>
                </div>
              ) : diffError ? (
                <div className="git-panel__diff-error">
                  <AppIcon name="x" size="lg" tone="danger" />
                  <p>{diffError}</p>
                </div>
              ) : selectedCommitFile && diffVersions ? (
                <SafeDiffEditor
                  original={diffVersions.original}
                  modified={diffVersions.modified}
                  language={getLanguage(selectedCommitFile)}
                  theme="vs-dark"
                  options={DIFF_EDITOR_OPTIONS}
                />
              ) : diff ? (
                <div className="git-panel__diff-text">{diff}</div>
              ) : commitFiles.length > 0 ? (
                <div className="git-panel__diff-empty">
                  <AppIcon name="fileText" size="md" tone="muted" />
                  <p>Выберите файл из списка выше</p>
                </div>
              ) : null}
            </div>
          </motion.div>
        )}
        {!selectedFile && !selectedCommit && (
          <motion.div
            key="empty"
            className="git-panel__diff-empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <AppIcon name="git" size="lg" tone="muted" />
            <p>Выберите файл или коммит, чтобы увидеть изменения</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

interface StatusGroups {
  staged: GitFileStatus[]
  unstaged: GitFileStatus[]
  untracked: GitFileStatus[]
}

/** Группирует файлы по git-статусу: Staged (index), Unstaged (worktree), Untracked.
 *  Файл может быть одновременно в staged и unstaged (staged change + new modification). */
function groupByStatus(files: GitFileStatus[]): StatusGroups {
  const staged: GitFileStatus[] = []
  const unstaged: GitFileStatus[] = []
  const untracked: GitFileStatus[] = []
  for (const file of files) {
    if (file.indexStatus === '?' && file.worktreeStatus === '?') {
      untracked.push(file)
    } else {
      if (file.indexStatus !== ' ' && file.indexStatus !== '?') staged.push(file)
      if (file.worktreeStatus !== ' ' && file.worktreeStatus !== '?') unstaged.push(file)
    }
  }
  return { staged, unstaged, untracked }
}

export default function GitPanel({ workdir, visible = false }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notARepo, setNotARepo] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [selectedCommit, setSelectedCommit] = useState<{ hash: string; message: string; author: string; date: string } | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'diff' | 'file'>('diff')
  const [fileContent, setFileContent] = useState<{ path: string; content: string; isBinary: boolean } | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [listMode, setListMode] = useState<'tree' | 'status'>('tree')
  const [diffStats, setDiffStats] = useState<Record<string, { added: number; deleted: number }>>({})
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [commitLoading, setCommitLoading] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [diffVersions, setDiffVersions] = useState<{ original: string; modified: string } | null>(null)
  const [commitFiles, setCommitFiles] = useState<CommitFile[]>([])
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(null)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [showNewBranchInput, setShowNewBranchInput] = useState(false)
  const [syncLoading, setSyncLoading] = useState(false)
  const [branchSwitchLoading, setBranchSwitchLoading] = useState<string | null>(null)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [activeSection, setActiveSection] = useState<'changes' | 'history' | 'stashes'>('changes')
  const [stashes, setStashes] = useState<Array<{ ref: string; message: string; date: string }>>([])
  const [stashLoading, setStashLoading] = useState(false)
  const branchDropdownRef = useRef<HTMLDivElement>(null)
  const actionMenuRef = useRef<HTMLDivElement>(null)
  const treeScrollRef = useRef<HTMLDivElement>(null)
  // Защита от наслаивания: пока refresh в полёте, поллинг не запускает новый.
  const refreshInFlightRef = useRef(false)
  const refreshRequestedRef = useRef(false)

  const refresh = useCallback(async () => {
    if (!workdir) return
    if (refreshInFlightRef.current) { refreshRequestedRef.current = true; return }
    refreshInFlightRef.current = true
    setLoading(true)
    setError(null)
    setNotARepo(false)
    try {
      const [statusResult, logResult] = await Promise.all([
        window.syntee.git.status(workdir),
        window.syntee.git.log({ workdir, limit: 15 }),
      ]) as [GitStatus & { success: boolean; error?: string; notARepo?: boolean }, { success: boolean; entries: GitLogEntry[]; error?: string; notARepo?: boolean }]

      if (statusResult.notARepo) {
        setNotARepo(true)
        setStatus(null)
        setLog([])
        return
      }
      if (!statusResult.success) {
        setError(statusResult.error ?? 'Failed to load git status')
        return
      }
      setStatus(prev => {
        const next: GitStatus = {
          branch: statusResult.branch,
          ahead: statusResult.ahead,
          behind: statusResult.behind,
          files: statusResult.files,
          clean: statusResult.clean,
        }
        return sameGitStatus(prev, next) ? prev : next
      })
      if (logResult.success) {
        setLog(prev => sameGitLog(prev, logResult.entries) ? prev : logResult.entries)
      }

      // Загружаем diff stats (+X -Y) для каждого изменённого файла
      if (statusResult.success && statusResult.files.length > 0) {
        try {
          const statResult = await window.syntee.git.diffStat({ workdir }) as
            { success: boolean; stats: Array<{ path: string; added: number; deleted: number }> }
          if (statResult.success && statResult.stats) {
            const map: Record<string, { added: number; deleted: number }> = {}
            for (const s of statResult.stats) {
              map[s.path] = { added: s.added, deleted: s.deleted }
            }
            setDiffStats(prev => sameDiffStats(prev, map) ? prev : map)
          }
        } catch { /* ok — stats optional */ }
      } else {
        setDiffStats(prev => (Object.keys(prev).length === 0 ? prev : {}))
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      refreshInFlightRef.current = false
      setLoading(false)
      if (refreshRequestedRef.current) {
        refreshRequestedRef.current = false
        queueMicrotask(() => { void refresh() })
      }
    }
  }, [workdir])

  // Git-поллинг и первичная загрузка — ТОЛЬКО когда панель реально видима
  // (visible от RightPanel: mainPage chat + панель открыта + активен таб Git
  // + файловый таб не перекрывает контент + документ виден). Стали видимыми →
  // мгновенный refresh, затем каждые 30s. Скрытая панель сохраняет последний
  // контент и не дёргает git. refreshInFlightRef не даёт поллингу наслаиваться
  // поверх уже идущего refresh (медленный git не копит вызовы).
  useEffect(() => {
    if (!workdir || !visible) return
    const poll = () => { void refresh() }
    poll()
    const interval = setInterval(poll, 30_000)
    return () => clearInterval(interval)
  }, [workdir, visible, refresh])

  // Закрытие branch dropdown по клику вне
  useEffect(() => {
    if (!branchDropdownOpen && !actionMenuOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (branchDropdownOpen && branchDropdownRef.current && !branchDropdownRef.current.contains(target)) {
        setBranchDropdownOpen(false)
        setShowNewBranchInput(false)
      }
      if (actionMenuOpen && actionMenuRef.current && !actionMenuRef.current.contains(target)) {
        setActionMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [branchDropdownOpen, actionMenuOpen])

  const loadStashes = useCallback(async () => {
    if (!workdir) return
    try {
      const result = await window.syntee.git.stashList(workdir) as { success: boolean; stashes: Array<{ ref: string; message: string; date: string }> }
      if (result.success) setStashes(result.stashes)
    } catch { /* optional */ }
  }, [workdir])

  useEffect(() => {
    if (activeSection === 'stashes') void loadStashes()
  }, [activeSection, loadStashes])

  const handleStash = useCallback(async () => {
    if (!workdir) return
    setStashLoading(true)
    try {
      const result = await window.syntee.git.stash({ workdir, message: 'Syntee snapshot' }) as { success: boolean; error?: string }
      if (!result.success) throw new Error(result.error ?? 'Stash failed')
      useToast.getState().add('Изменения сохранены в stash', 'success')
      await refresh()
      await loadStashes()
    } catch (e) {
      useToast.getState().add(String((e as Error)?.message ?? e), 'error')
    } finally { setStashLoading(false) }
  }, [workdir, refresh, loadStashes])

  const handleStashPop = useCallback(async () => {
    if (!workdir) return
    setStashLoading(true)
    try {
      const result = await window.syntee.git.stashPop({ workdir }) as { success: boolean; error?: string }
      if (!result.success) throw new Error(result.error ?? 'Stash pop failed')
      useToast.getState().add('Stash применён', 'success')
      await refresh()
      await loadStashes()
    } catch (e) {
      useToast.getState().add(String((e as Error)?.message ?? e), 'error')
    } finally { setStashLoading(false) }
  }, [workdir, refresh, loadStashes])

  // ── Branch operations ──────────────────────────────────────────────
  const loadBranches = useCallback(async () => {
    if (!workdir) return
    try {
      const result = await window.syntee.git.branchList(workdir) as
        { success: boolean; branches: string[]; current: string | null }
      if (result.success) {
        setBranches(result.branches.map(name => ({ name, current: name === result.current })))
      }
    } catch { /* ok */ }
  }, [workdir])

  // Загрузка веток при открытии dropdown
  useEffect(() => {
    if (branchDropdownOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadBranches()
    }
  }, [branchDropdownOpen, loadBranches])

  const loadDiff = useCallback(async (file: GitFileStatus) => {
    if (!workdir) return
    setSelectedFile(file.path)
    setSelectedCommit(null)
    setSelectedCommitFile(null)
    setDiff(null)
    setDiffError(null)
    setDiffLoading(true)
    setViewMode('diff')
    setDiffVersions(null)
    try {
      // Загружаем версии для Monaco DiffEditor (original из HEAD + modified с диска)
      const versionsResult = await window.syntee.git.fileVersions({ workdir, file: file.path }) as
        { success: boolean; original: string; modified: string; error?: string }
      if (versionsResult.success) {
        setDiffVersions({ original: versionsResult.original, modified: versionsResult.modified })
      }
      // Также загружаем unified diff текст (для fallback / текстового diff)
      const isUntracked = file.indexStatus === '?' && file.worktreeStatus === '?'
      const result = isUntracked
        ? await window.syntee.fs.readFile({ root: workdir, relPath: file.path }) as { success: boolean; content: string; error?: string; isBinary?: boolean }
        : await window.syntee.git.diff({ workdir, file: file.path }) as { success: boolean; diff: string; error?: string }
      if (!result.success) {
        setDiffError(result.error ?? 'Failed to load diff')
        return
      }
      if (isUntracked) {
        const content = (result as { content: string }).content
        const lines = content.split('\n').map(l => `+${l}`)
        setDiff(lines.join('\n'))
      } else {
        setDiff((result as { diff: string }).diff || 'Нет изменений в diff')
      }
    } catch (e) {
      setDiffError(String((e as Error)?.message ?? e))
    } finally {
      setDiffLoading(false)
    }
  }, [workdir])

  const loadFileContent = useCallback(async (filePath: string) => {
    if (!workdir) return
    if (fileContent?.path === filePath) return
    setFileLoading(true)
    setFileContent(null)
    try {
      const result = await window.syntee.fs.readFile({ root: workdir, relPath: filePath }) as { success: boolean; content: string; error?: string; isBinary?: boolean }
      if (result.success) {
        setFileContent({ path: filePath, content: result.content, isBinary: result.isBinary ?? false })
      } else {
        setDiffError(result.error ?? 'Failed to read file')
      }
    } catch (e) {
      setDiffError(String((e as Error)?.message ?? e))
    } finally {
      setFileLoading(false)
    }
  }, [workdir, fileContent])

  const loadCommit = useCallback(async (entry: GitLogEntry) => {
    if (!workdir) return
    setSelectedCommit({ hash: entry.hash, message: entry.message, author: entry.author, date: entry.date })
    setSelectedFile(null)
    setSelectedCommitFile(null)
    setDiff(null)
    setDiffError(null)
    setDiffLoading(true)
    setCommitFiles([])
    setDiffVersions(null)
    try {
      const [showResult, filesResult] = await Promise.all([
        window.syntee.git.show({ workdir, hash: entry.hash }) as Promise<{ success: boolean; diff: string; error?: string }>,
        window.syntee.git.showFiles({ workdir, hash: entry.hash }) as Promise<{ success: boolean; files: CommitFile[] }>,
      ])
      if (showResult.success) {
        setDiff(showResult.diff || 'Нет изменений в этом коммите')
      } else {
        setDiffError(showResult.error ?? 'Failed to load commit')
      }
      if (filesResult.success) {
        setCommitFiles(filesResult.files)
      }
    } catch (e) {
      setDiffError(String((e as Error)?.message ?? e))
    } finally {
      setDiffLoading(false)
    }
  }, [workdir])

  // Загрузка diff конкретного файла из коммита
  const loadCommitFileDiff = useCallback(async (hash: string, file: string) => {
    if (!workdir) return
    setSelectedCommitFile(file)
    setDiffLoading(true)
    setDiffError(null)
    setDiffVersions(null)
    try {
      const [versionsResult, diffResult] = await Promise.all([
        window.syntee.git.fileVersions({ workdir, file, ref: hash }) as
          Promise<{ success: boolean; original: string; modified: string }>,
        window.syntee.git.show({ workdir, hash, file }) as
          Promise<{ success: boolean; diff: string; error?: string }>,
      ])
      if (versionsResult.success) {
        setDiffVersions({ original: versionsResult.original, modified: versionsResult.modified })
      }
      if (diffResult.success) {
        setDiff(diffResult.diff || 'Нет изменений')
      }
    } catch (e) {
      setDiffError(String((e as Error)?.message ?? e))
    } finally {
      setDiffLoading(false)
    }
  }, [workdir])

  // useCallback — иначе новая identity на каждый рендер валила memo
  // GitTreeRow: все видимые строки дерева перерисовывались на любое
  // действие (ввод в поиск/коммит, refresh, открытие диффа).
  const toggleDir = useCallback((path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleOpenInEditor = useCallback((path: string) => {
    if (!workdir) return
    const fullpath = workdir.replace(/[\\/]+$/, '') + '\\' + path.replace(/\//g, '\\')
    window.syntee.shell.openPath(fullpath)
  }, [workdir])

  // Открыть файл в просмотре (Monaco-редактор в основной области) в diff-режиме
  const handleOpenInViewer = useCallback((path: string) => {
    if (!workdir) return
    useUIStore.getState().setAgentPanelOpen(true)
    window.syntee.settings.set('agentPanelOpen', true)
    void useFileTabsStore.getState().openFileDiff(path, workdir)
  }, [workdir])

  // ── Git actions: stage / unstage / discard ──────────────────────
  const handleStage = useCallback(async (file: string) => {
    if (!workdir) return
    setActionLoading(file)
    try {
      await window.syntee.git.add({ workdir, files: [file] })
      await refresh()
    } catch { /* ok */ } finally { setActionLoading(null) }
  }, [workdir, refresh])

  const handleUnstage = useCallback(async (file: string) => {
    if (!workdir) return
    setActionLoading(file)
    try {
      await window.syntee.git.reset({ workdir, files: [file] })
      await refresh()
    } catch { /* ok */ } finally { setActionLoading(null) }
  }, [workdir, refresh])

  const handleDiscard = useCallback(async (file: string, untracked: boolean) => {
    if (!workdir) return
    const confirmMsg = untracked
      ? `Удалить файл "${file}"? (untracked файл будет удалён)`
      : `Отменить изменения в "${file}"? (изменения будут потеряны)`
    if (!window.confirm(confirmMsg)) return
    setActionLoading(file)
    try {
      await window.syntee.git.discard({ workdir, files: [file], untracked })
      await refresh()
    } catch { /* ok */ } finally { setActionLoading(null) }
  }, [workdir, refresh])

  // ── Stage All / Unstage All / Discard All ───────────────────────────
  const handleStageAll = useCallback(async () => {
    if (!workdir || !status?.files.length) return
    setActionLoading('__all__')
    try {
      const files = status.files.map(f => f.path)
      await window.syntee.git.add({ workdir, files })
      await refresh()
    } catch { /* ok */ } finally { setActionLoading(null) }
  }, [workdir, status, refresh])

  const handleUnstageAll = useCallback(async () => {
    if (!workdir || !status?.files.length) return
    setActionLoading('__all__')
    try {
      const files = status.files
        .filter(f => f.indexStatus !== ' ' && f.indexStatus !== '?')
        .map(f => f.path)
      if (files.length === 0) return
      await window.syntee.git.reset({ workdir, files })
      await refresh()
    } catch { /* ok */ } finally { setActionLoading(null) }
  }, [workdir, status, refresh])

  const handleDiscardAll = useCallback(async () => {
    if (!workdir || !status?.files.length) return
    if (!window.confirm('Отменить ВСЕ изменения? Это действие необратимо.')) return
    setActionLoading('__all__')
    try {
      const tracked = status.files.filter(f => !(f.indexStatus === '?' && f.worktreeStatus === '?'))
      const untracked = status.files.filter(f => f.indexStatus === '?' && f.worktreeStatus === '?')
      if (tracked.length > 0) {
        await window.syntee.git.discard({ workdir, files: tracked.map(f => f.path), untracked: false })
      }
      if (untracked.length > 0) {
        await window.syntee.git.discard({ workdir, files: untracked.map(f => f.path), untracked: true })
      }
      await refresh()
    } catch { /* ok */ } finally { setActionLoading(null) }
  }, [workdir, status, refresh])

  // ── Commit ─────────────────────────────────────────────────────────
  const handleCommit = useCallback(async () => {
    if (!workdir || !commitMessage.trim()) return
    setCommitLoading(true)
    setCommitError(null)
    try {
      // Если нет staged файлов — предлагаем stage all (как VS Code)
      const hasStaged = status?.files.some(f => f.indexStatus !== ' ' && f.indexStatus !== '?')
      if (!hasStaged && status?.files.length) {
        await window.syntee.git.add({ workdir, files: status.files.map(f => f.path) })
      }
      const result = await window.syntee.git.commit({ workdir, message: commitMessage }) as
        { success: boolean; error?: string }
      if (result.success) {
        setCommitMessage('')
        await refresh()
      } else {
        setCommitError(result.error ?? 'Commit failed')
      }
    } catch (e) {
      setCommitError(String((e as Error)?.message ?? e))
    } finally {
      setCommitLoading(false)
    }
  }, [workdir, commitMessage, status, refresh])

  // ── Pull / Push / Sync ──────────────────────────────────────────────
  const handlePull = useCallback(async () => {
    if (!workdir) return
    setSyncLoading(true)
    try {
      const result = await window.syntee.git.pull({ workdir }) as { success: boolean; error?: string }
      if (!result.success) {
        setCommitError(result.error ?? 'Pull failed')
      }
      await refresh()
    } catch (e) {
      setCommitError(String((e as Error)?.message ?? e))
    } finally { setSyncLoading(false) }
  }, [workdir, refresh])

  const handlePush = useCallback(async () => {
    if (!workdir) return
    setSyncLoading(true)
    try {
      const result = await window.syntee.git.push({ workdir, branch: status?.branch ?? undefined }) as
        { success: boolean; error?: string }
      if (!result.success) {
        setCommitError(result.error ?? 'Push failed')
      }
      await refresh()
    } catch (e) {
      setCommitError(String((e as Error)?.message ?? e))
    } finally { setSyncLoading(false) }
  }, [workdir, status, refresh])

  const handleSync = useCallback(async () => {
    if (!workdir) return
    setSyncLoading(true)
    try {
      await window.syntee.git.pull({ workdir })
      await window.syntee.git.push({ workdir, branch: status?.branch ?? undefined })
      await refresh()
    } catch (e) {
      setCommitError(String((e as Error)?.message ?? e))
    } finally { setSyncLoading(false) }
  }, [workdir, status, refresh])

  const handleCheckout = useCallback(async (branch: string) => {
    if (!workdir) return
    setBranchSwitchLoading(branch)
    try {
      const result = await window.syntee.git.checkout({ workdir, branch }) as
        { success: boolean; error?: string }
      if (result.success) {
        setBranchDropdownOpen(false)
        await refresh()
        await loadBranches()
      }
    } catch { /* ok */ } finally { setBranchSwitchLoading(null) }
  }, [workdir, refresh, loadBranches])

  const handleCreateBranch = useCallback(async () => {
    if (!workdir || !newBranchName.trim()) return
    setBranchSwitchLoading('__new__')
    try {
      const result = await window.syntee.git.branchCreate({ workdir, branch: newBranchName.trim(), checkout: true }) as
        { success: boolean; error?: string }
      if (result.success) {
        setNewBranchName('')
        setShowNewBranchInput(false)
        await refresh()
        await loadBranches()
      }
    } catch { /* ok */ } finally { setBranchSwitchLoading(null) }
  }, [workdir, newBranchName, refresh, loadBranches])

  const fileTree = useMemo(() => status?.files ? buildFileTree(status.files) : [], [status])

  // Auto-expand только top-level директорий при загрузке/обновлении статуса.
  // Раньше раскрывались ВСЕ вложенные директории — для проектов с сотнями
  // изменённых файлов это рендерило сотни DOM-узлов синхронно → freeze.
  // Теперь раскрываем только директории первого уровня.
  useEffect(() => {
    if (fileTree.length > 0) {
      const topLevelDirs = fileTree.filter(n => n.isDir).map(n => n.path)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExpandedDirs(new Set(topLevelDirs))
    }
  }, [fileTree])

  const statusGroups = useMemo(() => status?.files ? groupByStatus(status.files) : null, [status])

  // Flat tree для виртуализации (tree mode). При поиске — раскрываем все
  // директории автоматически и фильтруем файлы по имени.
  const flatTreeNodes = useMemo(
    () => listMode === 'tree' ? flattenGitTree(fileTree, expandedDirs, search) : [],
    [fileTree, expandedDirs, search, listMode],
  )

  const treeVirtualizer = useVirtualizer({
    count: flatTreeNodes.length,
    getScrollElement: () => treeScrollRef.current,
    estimateSize: () => 28,
    overscan: 8,
  })

  const renderStatusGroup = (label: string, files: GitFileStatus[], groupCls: string) => {
    if (files.length === 0) return null
    return (
      <div className="git-status-group" key={label}>
        <div className="git-status-group__header">
          <span className={`git-status-group__dot ${groupCls}`} />
          <span className="git-status-group__label">{label}</span>
          <span className="git-status-group__count">{files.length}</span>
        </div>
        <div className="git-status-group__files">
          {files.map(file => (
            <StatusFileRow
              key={file.path}
              file={file}
              selected={selectedFile === file.path}
              stats={diffStats[file.path]}
              actionLoading={actionLoading}
              onStage={handleStage}
              onUnstage={handleUnstage}
              onDiscard={handleDiscard}
              onLoadDiff={loadDiff}
            />
          ))}
        </div>
      </div>
    )
  }

  if (!workdir) {
    return (
      <div className="git-panel git-panel--empty">
        <AppIcon name="git" size="lg" tone="muted" />
        <p>Нет рабочей директории</p>
        <p className="git-panel__hint">Выберите проект, чтобы увидеть git-статус</p>
      </div>
    )
  }

  if (notARepo) {
    return (
      <div className="git-panel git-panel--empty">
        <AppIcon name="git" size="lg" tone="muted" />
        <p>Не git-репозиторий</p>
        <p className="git-panel__hint">В этой папке нет git-репозитория</p>
      </div>
    )
  }

  if (error && !status) {
    return (
      <div className="git-panel git-panel--empty">
        <AppIcon name="x" size="lg" tone="danger" />
        <p>Ошибка загрузки</p>
        <p className="git-panel__hint">{error}</p>
        <button className="git-panel__retry" onClick={refresh}>
          <AppIcon name="refreshCw" size="xs" /> Повторить
        </button>
      </div>
    )
  }

  return (
    <div className="git-panel">
      <div className="git-panel__files">
        <div className="git-panel__header">
          <div className="git-panel__branch" ref={branchDropdownRef}>
            <AppIcon name="git-branch" size="xs" />
            <button
              className="git-panel__branch-btn"
              title={status?.branch ?? ''}
              onClick={() => setBranchDropdownOpen(prev => !prev)}
            >
              <span className="git-panel__branch-name">{status?.branch ?? '…'}</span>
              <AppIcon name="chevronDown" size="xs" />
            </button>
            {branchDropdownOpen && (
              <div className="git-panel__branch-dropdown">
                <div className="git-panel__branch-dropdown-header">
                  <span>Ветки</span>
                  <button
                    className="git-panel__branch-new-btn"
                    title="Новая ветка"
                    onClick={() => setShowNewBranchInput(prev => !prev)}
                  >
                    <AppIcon name="plus" size="xs" />
                  </button>
                </div>
                {showNewBranchInput && (
                  <div className="git-panel__branch-new">
                    <input
                      type="text"
                      placeholder="Имя ветки…"
                      value={newBranchName}
                      onChange={e => setNewBranchName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void handleCreateBranch() }}
                      autoFocus
                    />
                    <button
                      title="Создать и переключиться"
                      onClick={() => void handleCreateBranch()}
                      disabled={branchSwitchLoading === '__new__'}
                    >
                      <AppIcon name="check" size="xs" />
                    </button>
                  </div>
                )}
                <div className="git-panel__branch-list">
                  {branches.map(b => (
                    <button
                      key={b.name}
                      className={`git-panel__branch-item ${b.current ? 'git-panel__branch-item--current' : ''}`}
                      onClick={() => void handleCheckout(b.name)}
                      disabled={b.current || branchSwitchLoading === b.name}
                    >
                      {b.current && <AppIcon name="check" size="xs" />}
                      <span>{b.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(status?.ahead ?? 0) > 0 && (
              <span className="git-panel__ahead-behind git-panel__ahead-behind--ahead" title="Ahead">
                ↑{status?.ahead}
              </span>
            )}
            {(status?.behind ?? 0) > 0 && (
              <span className="git-panel__ahead-behind git-panel__ahead-behind--behind" title="Behind">
                ↓{status?.behind}
              </span>
            )}
            {((status?.ahead ?? 0) > 0 || (status?.behind ?? 0) > 0) && (
              <button
                className="git-panel__sync-btn"
                title="Синхронизировать (pull + push)"
                onClick={() => void handleSync()}
                disabled={syncLoading}
              >
                <AppIcon name="refreshCw" size="xs" animation={syncLoading ? 'spin' : 'none'} />
              </button>
            )}
          </div>
          <div className="git-panel__header-actions">
            <button className="git-panel__refresh" title="Обновить" onClick={refresh} disabled={loading}>
              <AppIcon name="refreshCw" size="xs" animation={loading ? 'spin' : 'none'} />
            </button>
            <div className="git-panel__action-menu-wrap" ref={actionMenuRef}>
              <button className="git-panel__header-btn" title="Действия Git" onClick={() => setActionMenuOpen(prev => !prev)}>
                <AppIcon name="moreHorizontal" size="xs" />
              </button>
              {actionMenuOpen && (
                <div className="git-panel__action-menu">
                  <button onClick={() => { setActionMenuOpen(false); void handleStageAll() }} disabled={actionLoading === '__all__' || !status?.files.length}>
                    <AppIcon name="plus" size="xs" /> Stage all
                  </button>
                  <button onClick={() => { setActionMenuOpen(false); void handleUnstageAll() }} disabled={actionLoading === '__all__' || !status?.files.length}>
                    <AppIcon name="minus" size="xs" /> Unstage all
                  </button>
                  <button onClick={() => { setActionMenuOpen(false); void handlePull() }} disabled={syncLoading}>
                    <AppIcon name="arrowDown" size="xs" /> Pull
                  </button>
                  <button onClick={() => { setActionMenuOpen(false); void handlePush() }} disabled={syncLoading}>
                    <AppIcon name="arrowUp" size="xs" /> Push
                  </button>
                  <button onClick={() => { setActionMenuOpen(false); void handleStash() }} disabled={stashLoading || !status?.files.length}>
                    <AppIcon name="archive" size="xs" /> Stash changes
                  </button>
                  <button onClick={() => { setActionMenuOpen(false); void handleStashPop() }} disabled={stashLoading || !stashes.length}>
                    <AppIcon name="download" size="xs" /> Apply latest stash
                  </button>
                  <div className="git-panel__action-menu-divider" />
                  <button className="git-panel__action-menu-danger" onClick={() => { setActionMenuOpen(false); void handleDiscardAll() }} disabled={actionLoading === '__all__' || !status?.files.length}>
                    <AppIcon name="undo" size="xs" /> Discard all
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="git-panel__statusbar">
          <span className="git-panel__statusbar-dot" />
          <span>{status?.files.length ? `${status.files.length} changes` : 'Working tree clean'}</span>
          {statusGroups && <span className="git-panel__statusbar-meta">{statusGroups.staged.length} staged · {statusGroups.unstaged.length} unstaged · {statusGroups.untracked.length} untracked</span>}
        </div>
        <div className="git-panel__sections">
          {(['changes', 'history', 'stashes'] as const).map(section => (
            <button key={section} className={activeSection === section ? 'git-panel__section--active' : ''} onClick={() => setActiveSection(section)}>
              {section === 'changes' ? 'Changes' : section === 'history' ? 'History' : 'Stashes'}
              {section === 'changes' && status?.files.length ? <span>{status.files.length}</span> : null}
              {section === 'stashes' && stashes.length ? <span>{stashes.length}</span> : null}
            </button>
          ))}
        </div>

        {/* Commit message input — VS Code style */}
        {activeSection === 'changes' && <div className="git-panel__commit">
          <textarea
            className="git-panel__commit-input"
            placeholder="Сообщение коммита… (Ctrl+Enter — коммит)"
            value={commitMessage}
            onChange={e => { setCommitMessage(e.target.value); setCommitError(null) }}
            onKeyDown={e => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                void handleCommit()
              }
            }}
            rows={2}
          />
          {commitError && (
            <div className="git-panel__commit-error">{commitError}</div>
          )}
          <button
            className="git-panel__commit-btn"
            onClick={() => void handleCommit()}
            disabled={!commitMessage.trim() || commitLoading}
          >
            {commitLoading ? (
              <AppIcon name="loader" size="xs" animation="spin" />
            ) : (
              <AppIcon name="check" size="xs" />
            )}
            <span>Commit</span>
          </button>
        </div>}

        {activeSection === 'changes' && <div className="git-panel__files-body">
          {loading && !status ? (
            <div className="git-panel__loading">
              <AppIcon name="loader" size="sm" animation="spin" />
              <span>Загрузка...</span>
            </div>
          ) : status?.clean ? (
            <div className="git-panel__clean">
              <AppIcon name="check" size="md" tone="success" />
              <p>Нет изменений</p>
              <span>Рабочая директория чиста</span>
            </div>
          ) : (
            <>
              <div className="git-panel__mode-switch">
                <button
                  className={`git-panel__mode-btn ${listMode === 'tree' ? 'git-panel__mode-btn--active' : ''}`}
                  onClick={() => setListMode('tree')}
                  title="Дерево файлов"
                >
                  <AppIcon name="folder" size="xs" />
                  <span>Дерево</span>
                </button>
                <button
                  className={`git-panel__mode-btn ${listMode === 'status' ? 'git-panel__mode-btn--active' : ''}`}
                  onClick={() => setListMode('status')}
                  title="По статусам (Staged / Unstaged / Untracked)"
                >
                  <AppIcon name="listChecks" size="xs" />
                  <span>Статусы</span>
                </button>
              </div>
              <div className="git-panel__search">
                <AppIcon name="search" size="xs" tone="muted" />
                <input
                  className="git-panel__search-input"
                  type="text"
                  placeholder="Фильтр файлов…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                {search && (
                  <button className="git-panel__search-clear" onClick={() => setSearch('')} title="Очистить">
                    <AppIcon name="x" size="xs" />
                  </button>
                )}
              </div>
              <div className="git-panel__file-list" ref={treeScrollRef}>
                {listMode === 'tree'
                  ? (
                    flatTreeNodes.length > 0 ? (
                      <div style={{ height: treeVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
                        {treeVirtualizer.getVirtualItems().map(vItem => (
                          <GitTreeRow
                            key={flatTreeNodes[vItem.index].key}
                            node={flatTreeNodes[vItem.index]}
                            vItemStart={vItem.start}
                            selectedFile={selectedFile}
                            diffStats={diffStats}
                            onToggleDir={toggleDir}
                            onLoadDiff={loadDiff}
                          />
                        ))}
                      </div>
                    ) : (
                      search && <div className="git-panel__search-empty">Ничего не найдено</div>
                    )
                  )
                  : statusGroups && (() => {
                      const q = search.toLowerCase().trim()
                      const filterFn = (f: GitFileStatus) => !q || f.path.toLowerCase().includes(q)
                      const staged = statusGroups.staged.filter(filterFn)
                      const unstaged = statusGroups.unstaged.filter(filterFn)
                      const untracked = statusGroups.untracked.filter(filterFn)
                      if (!staged.length && !unstaged.length && !untracked.length && q) {
                        return <div className="git-panel__search-empty">Ничего не найдено</div>
                      }
                      return (
                        <div className="git-panel__status-groups">
                          {renderStatusGroup('Staged', staged, 'git-status-group__dot--staged')}
                          {renderStatusGroup('Unstaged', unstaged, 'git-status-group__dot--unstaged')}
                          {renderStatusGroup('Untracked', untracked, 'git-status-group__dot--untracked')}
                        </div>
                      )
                    })()
                }
              </div>
            </>
          )}
        </div>}

        {activeSection === 'history' && (
          <div className="git-panel__section-content git-panel__history-list">
            {log.length === 0 ? <div className="git-panel__section-empty">История коммитов пуста</div> : log.map(entry => (
              <button key={entry.hash} className={`git-log-item ${selectedCommit?.hash === entry.hash ? 'git-log-item--selected' : ''}`} title={entry.message} onClick={() => loadCommit(entry)}>
                <span className="git-log-item__hash">{entry.shortHash}</span>
                <span className="git-log-item__msg">{entry.message.split('\n')[0]}</span>
                <span className="git-log-item__author">{entry.author}</span>
                <span className="git-log-item__date">{entry.date}</span>
              </button>
            ))}
          </div>
        )}
        {activeSection === 'stashes' && (
          <div className="git-panel__section-content git-panel__stash-list">
            <div className="git-panel__stash-toolbar">
              <span>{stashes.length ? `${stashes.length} сохранений` : 'Сохранённых изменений нет'}</span>
              {stashes.length > 0 && <button onClick={() => void handleStashPop()} disabled={stashLoading}><AppIcon name="download" size="xs" /> Применить последнее</button>}
            </div>
            {stashes.map(stash => <div className="git-panel__stash-item" key={stash.ref}>
              <AppIcon name="archive" size="xs" />
              <span className="git-panel__stash-ref">{stash.ref}</span>
              <span className="git-panel__stash-message" title={stash.message}>{stash.message}</span>
              <span className="git-panel__stash-date">{stash.date}</span>
            </div>)}
          </div>
        )}

        {activeSection === 'changes' && log.length > 0 && (
          <div className="git-panel__log">
            <div className="git-panel__log-header">
              <AppIcon name="clock" size="xs" />
              <span>Последние коммиты</span>
            </div>
            <div className="git-panel__log-list">
              {log.map(entry => (
                <button
                  key={entry.hash}
                  className={`git-log-item ${selectedCommit?.hash === entry.hash ? 'git-log-item--selected' : ''}`}
                  title={entry.message}
                  onClick={() => loadCommit(entry)}
                >
                  <span className="git-log-item__hash">{entry.shortHash}</span>
                  <span className="git-log-item__msg">{entry.message.split('\n')[0]}</span>
                  <span className="git-log-item__author">{entry.author}</span>
                  <span className="git-log-item__date">{entry.date}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <GitDiffView
        selectedFile={selectedFile}
        selectedCommit={selectedCommit}
        viewMode={viewMode}
        diffLoading={diffLoading}
        diffError={diffError}
        diff={diff}
        diffVersions={diffVersions}
        fileLoading={fileLoading}
        fileContent={fileContent}
        commitFiles={commitFiles}
        selectedCommitFile={selectedCommitFile}
        onViewMode={setViewMode}
        onLoadFileContent={loadFileContent}
        onOpenInViewer={handleOpenInViewer}
        onOpenInEditor={handleOpenInEditor}
        onLoadCommitFileDiff={loadCommitFileDiff}
      />
    </div>
  )
}
