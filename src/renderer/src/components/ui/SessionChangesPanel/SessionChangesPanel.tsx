/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import AppIcon from '../AppIcon/AppIcon'
import FileIcon from '../FileIcon/FileIcon'
import SafeDiffEditor from '../SafeDiffEditor/SafeDiffEditor'
import { getLanguage } from '../CodePreview/CodePreview'
import { parseUnifiedDiff, basename, dirname, type ParsedFileDiff } from '../../../utils/diffParser'
import type { CheckpointMeta, RewindResult, LastTurnChanges } from '../../../../../shared/types'
import { useChatStore } from '../../../store/chat.store'
import { whileHoverSm, whileTapSm, whileHoverTiny, whileTapTiny, whileHoverListItem, whileTapListItem, springHover } from '../../../utils/motionPresets'
import './SessionChangesPanel.css'

// Офлайн Monaco (повторный вызов loader.config безопасен)
loader.config({ monaco })

interface SessionChangesPanelProps {
  chatId?: string | null
}

type ViewMode = 'last' | 'files' | 'chat'

export default function SessionChangesPanel({ chatId }: SessionChangesPanelProps) {
  const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('last')
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<CheckpointMeta | null>(null)
  const [rawDiff, setRawDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [rewinding, setRewinding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Redo-баннер: отмена отката ──
  const [lastRewind, setLastRewind] = useState<{ rewindMessageId: string; createdAt: number } | null>(null)
  const [canRedo, setCanRedo] = useState(false)
  const [redoing, setRedoing] = useState(false)

  // ── Per-file undo в diff-панели ──
  const [undoingFile, setUndoingFile] = useState<string | null>(null)
  const [undoingAll, setUndoingAll] = useState(false)
  const [undoneFiles, setUndoneFiles] = useState<Set<string>>(new Set())

  // ── Per-file diff: выбранный файл в diff-панели ──
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)

  // ── Inline confirm: что подтверждаем ──
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null)

  // ── Поиск по чекпоинтам ──
  const [search, setSearch] = useState('')

  // ── Resizable timeline width ──
  const [timelineWidth, setTimelineWidth] = useState(300)
  const timelineResizeRef = useRef<HTMLDivElement>(null)

  // ── +N -M последнего turn'а из store ──
  const lastTurnChanges = useChatStore(s => chatId ? s.lastTurnChangesByChat[chatId] : undefined) as LastTurnChanges | null | undefined

  // ── Парсим raw unified diff в per-file diff'ы ──
  const parsedDiffs = useMemo<ParsedFileDiff[]>(() => {
    if (!rawDiff) return []
    return parseUnifiedDiff(rawDiff)
  }, [rawDiff])

  // ── Diff для выбранного файла ──
  const currentFileDiff = useMemo<ParsedFileDiff | null>(() => {
    if (!selectedFilePath || parsedDiffs.length === 0) return null
    return parsedDiffs.find(d => d.filePath === selectedFilePath) ?? null
  }, [selectedFilePath, parsedDiffs])

  const refresh = useCallback(async () => {
    if (!chatId) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.syntee.chat.getSessionTimeline(chatId) as CheckpointMeta[]
      setCheckpoints(result)
      const rewind = await window.syntee.chat.getLastRewind(chatId) as { rewindMessageId: string; createdAt: number } | null
      setLastRewind(rewind)
      if (rewind) {
        const redo = await window.syntee.chat.canRedo(chatId, rewind.rewindMessageId) as boolean
        setCanRedo(redo)
      } else {
        setCanRedo(false)
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setLoading(false)
    }
  }, [chatId])

  useEffect(() => {
    if (chatId) {
      requestAnimationFrame(() => { refresh() })
      setSelectedCheckpoint(null)
      setRawDiff(null)
      setSelectedFilePath(null)
      setUndoneFiles(new Set())
    } else {
      setCheckpoints([])
      setSelectedCheckpoint(null)
      setRawDiff(null)
      setLastRewind(null)
      setCanRedo(false)
      setSelectedFilePath(null)
      setUndoneFiles(new Set())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  // Авто-refresh при получении события о новом чекпоинте
  useEffect(() => {
    if (!chatId) return
    const handler = (data: { chatId: string }) => {
      if (data.chatId === chatId) refresh()
    }
    const rewindHandler = (data: { chatId: string }) => {
      if (data.chatId === chatId) {
        refresh()
        setSelectedCheckpoint(null)
        setRawDiff(null)
        setSelectedFilePath(null)
      }
    }
    const off1 = window.syntee.on('chat:checkpoint:created', (data: unknown) => handler(data as { chatId: string }))
    const off2 = window.syntee.on('chat:rewound', (data: unknown) => rewindHandler(data as { chatId: string }))
    return () => { off1(); off2() }
  }, [chatId, refresh])

  // Checkpoints с правками файлов (filePaths может содержать дубликаты —
  // backend считает каждый edit_file вызов, не уникальные файлы)
  const checkpointsWithFiles = useMemo(() => checkpoints.filter(c => c.filePaths.length > 0), [checkpoints])
  const lastCheckpointWithFiles = useMemo(() => {
    return checkpointsWithFiles.length > 0 ? checkpointsWithFiles[checkpointsWithFiles.length - 1] : null
  }, [checkpointsWithFiles])

  // Фильтрация по поиску (для режима "files" — только с правками)
  const filteredCheckpoints = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return checkpointsWithFiles
    return checkpointsWithFiles.filter(cp =>
      cp.userPromptPreview.toLowerCase().includes(q) ||
      cp.filePaths.some(p => p.toLowerCase().includes(q))
    )
  }, [checkpointsWithFiles, search])

  // Фильтрация по поиску (для режима "chat" — все чекпоинты)
  const filteredAllCheckpoints = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return checkpoints
    return checkpoints.filter(cp =>
      cp.userPromptPreview.toLowerCase().includes(q) ||
      cp.filePaths.some(p => p.toLowerCase().includes(q))
    )
  }, [checkpoints, search])

  // Visible checkpoints зависит от режима:
  // - last: только последний checkpoint с правками
  // - files: все checkpoints с правками файлов (откат только файлов)
  // - chat: ВСЕ checkpoints включая без правок (полный откат: файлы + сообщения + контекст)
  const visibleCheckpoints = useMemo(() => {
    if (viewMode === 'last') return lastCheckpointWithFiles ? [lastCheckpointWithFiles] : []
    if (viewMode === 'files') return filteredCheckpoints
    return filteredAllCheckpoints // chat — все
  }, [viewMode, filteredCheckpoints, filteredAllCheckpoints, lastCheckpointWithFiles])

  // Общая статистика для шапки
  const totalStats = useMemo(() => {
    if (viewMode === 'chat') {
      return { turns: checkpoints.length, totalFiles: checkpointsWithFiles.reduce((sum, c) => sum + new Set(c.filePaths).size, 0), uniqueFiles: new Set(checkpointsWithFiles.flatMap(c => c.filePaths)).size }
    }
    const totalFiles = checkpointsWithFiles.reduce((sum, c) => sum + new Set(c.filePaths).size, 0)
    const uniqueFiles = new Set(checkpointsWithFiles.flatMap(c => c.filePaths)).size
    return { turns: checkpointsWithFiles.length, totalFiles, uniqueFiles }
  }, [checkpoints, checkpointsWithFiles, viewMode])

  const loadCheckpointDiff = useCallback(async (cp: CheckpointMeta) => {
    if (!chatId) return
    setSelectedCheckpoint(cp)
    setRawDiff(null)
    setSelectedFilePath(null)
    setUndoneFiles(new Set())
    if (cp.filePaths.length === 0 || !cp.assistantMessageId) {
      return
    }
    setDiffLoading(true)
    try {
      const messages = await window.syntee.chat.getMessages(chatId) as Array<{
        id: string
        toolSteps?: Array<{ type: string; diff?: string; toolName?: string }>
      }>
      const assistantMsg = messages.find(m => m.id === cp.assistantMessageId)
      if (!assistantMsg?.toolSteps) {
        setRawDiff(null)
        return
      }
      const diffs: string[] = []
      for (const step of assistantMsg.toolSteps) {
        if (step.type === 'tool_result' && step.diff) {
          diffs.push(step.diff)
        }
      }
      const joined = diffs.length > 0 ? diffs.join('\n\n') : null
      setRawDiff(joined)
      // Автовыбор первого файла
      if (joined) {
        const parsed = parseUnifiedDiff(joined)
        if (parsed.length > 0) setSelectedFilePath(parsed[0].filePath)
      }
    } catch {
      setRawDiff(null)
    } finally {
      setDiffLoading(false)
    }
  }, [chatId])

  // Автовыбор последнего checkpoint'а при переключении в режим "last"
  useEffect(() => {
    if (viewMode === 'last' && lastCheckpointWithFiles && !selectedCheckpoint) {
      loadCheckpointDiff(lastCheckpointWithFiles)
    }
  }, [viewMode, lastCheckpointWithFiles, selectedCheckpoint, loadCheckpointDiff])

  // ── Keyboard navigation (↑/↓/Enter) ──
  const selectedIndex = useMemo(() => {
    if (!selectedCheckpoint) return -1
    const list = visibleCheckpoints.slice().reverse()
    return list.findIndex(cp => cp.id === selectedCheckpoint.id)
  }, [selectedCheckpoint, visibleCheckpoints])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const list = visibleCheckpoints.slice().reverse()
      if (list.length === 0) return
      const panel = document.querySelector('.session-panel__timeline')
      if (!panel?.contains(e.target as Node)) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const dir = e.key === 'ArrowDown' ? 1 : -1
        const nextIdx = Math.min(Math.max(selectedIndex + dir, 0), list.length - 1)
        const next = list[nextIdx]
        if (next) loadCheckpointDiff(next)
      } else if (e.key === 'Enter' && selectedCheckpoint) {
        loadCheckpointDiff(selectedCheckpoint)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [visibleCheckpoints, selectedIndex, selectedCheckpoint, loadCheckpointDiff])

  // ── Resizable timeline ──
  const handleTimelineResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = timelineWidth
    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX
      const w = Math.min(Math.max(startW + delta, 220), 500)
      setTimelineWidth(w)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [timelineWidth])

  // ── Rewind (откат сессии) ──
  const handleRewind = useCallback(async (cp: CheckpointMeta) => {
    if (!chatId || rewinding) return
    setRewinding(true)
    try {
      const result = await window.syntee.chat.rewindTo(chatId, cp.userMessageId) as RewindResult
      if (result.error) setError(result.error)
      await refresh()
      setSelectedCheckpoint(null)
      setRawDiff(null)
      setSelectedFilePath(null)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setRewinding(false)
    }
    setConfirmTarget(null)
  }, [chatId, rewinding, refresh])

  // ── Redo (отмена отката) ──
  const handleRedo = useCallback(async () => {
    if (!chatId || !lastRewind || redoing) return
    setRedoing(true)
    try {
      const result = await window.syntee.chat.redo(chatId, lastRewind.rewindMessageId) as { messages?: unknown[]; error?: string }
      if (result.error) setError(result.error)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setRedoing(false)
    }
    setConfirmTarget(null)
  }, [chatId, lastRewind, redoing])

  // ── Per-file undo ──
  const handleUndoFile = useCallback(async (filePath: string) => {
    if (!chatId || !selectedCheckpoint || undoingFile || undoingAll) return
    setUndoingFile(filePath)
    try {
      const result = await window.syntee.chat.undoCheckpointFile(chatId, selectedCheckpoint.userMessageId, filePath)
      if (result?.error) {
        setError(result.error)
      } else {
        setUndoneFiles(prev => new Set(prev).add(filePath))
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setUndoingFile(null)
    }
    setConfirmTarget(null)
  }, [chatId, selectedCheckpoint, undoingFile, undoingAll])

  // ── Undo all files of checkpoint ──
  const handleUndoAllFiles = useCallback(async () => {
    if (!chatId || !selectedCheckpoint || undoingFile || undoingAll) return
    setUndoingAll(true)
    try {
      const result = await window.syntee.chat.undoCheckpointFiles(chatId, selectedCheckpoint.userMessageId)
      if (result?.error) {
        setError(result.error)
      } else {
        setUndoneFiles(new Set([...new Set(selectedCheckpoint.filePaths)]))
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setUndoingAll(false)
    }
    setConfirmTarget(null)
  }, [chatId, selectedCheckpoint, undoingFile, undoingAll])

  // ── Undo files only (из timeline в режиме "files") ──
  // Откатывает только файлы к состоянию этого turn'а, сообщения остаются.
  const handleUndoFilesOnly = useCallback(async (cp: CheckpointMeta) => {
    if (!chatId || rewinding) return
    setRewinding(true)
    try {
      const result = await window.syntee.chat.undoCheckpointFiles(chatId, cp.userMessageId)
      if (result?.error) {
        setError(result.error)
      }
      await refresh()
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setRewinding(false)
    }
    setConfirmTarget(null)
  }, [chatId, rewinding, refresh])

  // ── +N -M для конкретного файла (только последнего чекпоинта) ──
  const getFileStats = useCallback((filePath: string): { added: number; deleted: number } | null => {
    if (!lastTurnChanges || !selectedCheckpoint) return null
    if (lastCheckpointWithFiles?.id !== selectedCheckpoint.id) return null
    const fc = lastTurnChanges.files.find(f => f.path === filePath)
    if (!fc) return null
    return { added: fc.added, deleted: fc.deleted }
  }, [lastTurnChanges, selectedCheckpoint, lastCheckpointWithFiles])

  // ── Mini diff-stat bar для чекпоинта ──
  const getCheckpointStats = useCallback((cp: CheckpointMeta): { added: number; deleted: number } | null => {
    if (!lastTurnChanges || lastCheckpointWithFiles?.id !== cp.id) return null
    return { added: lastTurnChanges.totalAdded, deleted: lastTurnChanges.totalDeleted }
  }, [lastTurnChanges, lastCheckpointWithFiles])

  // ── Уникальное кол-во файлов (бэкенд может считать каждый edit_file вызов отдельно) ──
  const uniqueFileCount = useCallback((cp: CheckpointMeta): number => {
    return new Set(cp.filePaths).size
  }, [])

  // ── Склонение слова "файл" ──
  const fileWord = (n: number): string => n === 1 ? 'файл' : n < 5 ? 'файла' : 'файлов'

  if (!chatId) {
    return (
      <div className="session-panel session-panel--empty">
        <AppIcon name="history" size="lg" tone="muted" />
        <p>Нет активного чата</p>
        <p className="session-panel__hint">Выберите чат, чтобы увидеть историю изменений</p>
      </div>
    )
  }

  if (error && checkpoints.length === 0) {
    return (
      <div className="session-panel session-panel--empty">
        <AppIcon name="x" size="lg" tone="danger" />
        <p>Ошибка загрузки</p>
        <p className="session-panel__hint">{error}</p>
        <motion.button className="session-panel__retry" onClick={refresh} whileHover={whileHoverSm} whileTap={whileTapSm} transition={springHover}>
          <AppIcon name="refreshCw" size="xs" /> Повторить
        </motion.button>
      </div>
    )
  }

  return (
    <div className="session-panel">
      {/* ── Левая колонка: таймлайн (resizable) ── */}
      <div className="session-panel__timeline" style={{ width: timelineWidth, minWidth: timelineWidth }}>
        <div className="session-panel__header">
          <div className="session-panel__title">
            <AppIcon name="history" size="xs" />
            <span>Сессия</span>
          </div>
          <motion.button
            className="session-panel__refresh"
            title="Обновить"
            onClick={refresh}
            disabled={loading}
            whileHover={whileHoverTiny}
            whileTap={whileTapTiny}
            transition={springHover}
          >
            <AppIcon name="refreshCw" size="xs" animation={loading ? 'spin' : 'none'} />
          </motion.button>
        </div>

        {/* ── Redo-баннер ── */}
        <AnimatePresence>
          {canRedo && lastRewind && (
            <motion.div
              className="session-panel__redo-banner"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <div className="session-panel__redo-info">
                <AppIcon name="rewind" size="xs" tone="warning" />
                <span>Откат активен</span>
              </div>
              <motion.button
                className="session-panel__redo-btn"
                onClick={handleRedo}
                disabled={redoing}
                title="Отменить откат — вернуть сообщения и файлы"
                whileHover={whileHoverSm}
                whileTap={whileTapSm}
                transition={springHover}
              >
                <AppIcon name="refreshCw" size="xs" animation={redoing ? 'spin' : 'none'} />
                <span>{redoing ? 'Отмена...' : 'Отменить откат'}</span>
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Переключатель режимов */}
        <div className="session-panel__mode-switch">
          <motion.button
            className={`session-panel__mode-btn ${viewMode === 'last' ? 'session-panel__mode-btn--active' : ''}`}
            onClick={() => setViewMode('last')}
            title="Что изменилось в последнем запросе"
            whileHover={whileHoverListItem}
            whileTap={whileTapListItem}
            transition={springHover}
          >
            <AppIcon name="zap" size="xs" />
            <span>Последний</span>
          </motion.button>
          <motion.button
            className={`session-panel__mode-btn ${viewMode === 'files' ? 'session-panel__mode-btn--active' : ''}`}
            onClick={() => setViewMode('files')}
            title="Все чекпоинты с правками файлов — откат только файлов"
            whileHover={whileHoverListItem}
            whileTap={whileTapListItem}
            transition={springHover}
          >
            <AppIcon name="folder" size="xs" />
            <span>Файлы</span>
          </motion.button>
          <motion.button
            className={`session-panel__mode-btn ${viewMode === 'chat' ? 'session-panel__mode-btn--active' : ''}`}
            onClick={() => setViewMode('chat')}
            title="Все запросы сессии — полный откат (файлы + сообщения + контекст)"
            whileHover={whileHoverListItem}
            whileTap={whileTapListItem}
            transition={springHover}
          >
            <AppIcon name="messageSquare" size="xs" />
            <span>Весь чат</span>
          </motion.button>
        </div>

        {/* Поиск (когда > 3 чекпоинтов в режимах files/chat) */}
        {(viewMode === 'files' || viewMode === 'chat') && (viewMode === 'chat' ? checkpoints.length : checkpointsWithFiles.length) > 3 && (
          <div className="session-panel__search">
            <AppIcon name="search" size="xs" tone="muted" />
            <input
              className="session-panel__search-input"
              type="text"
              placeholder="Поиск по промпту или файлу…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button className="session-panel__search-clear" onClick={() => setSearch('')} title="Очистить">
                <AppIcon name="x" size="xs" />
              </button>
            )}
          </div>
        )}

        {/* Статистика в режимах "Файлы" и "Весь чат" */}
        {(viewMode === 'files' || viewMode === 'chat') && totalStats.turns > 0 && (
          <div className="session-panel__stats">
            <div className="session-panel__stat">
              <span className="session-panel__stat-value">{totalStats.turns}</span>
              <span className="session-panel__stat-label">{viewMode === 'chat' ? 'запросов всего' : 'запросов с правками'}</span>
            </div>
            <div className="session-panel__stat">
              <span className="session-panel__stat-value">{totalStats.uniqueFiles}</span>
              <span className="session-panel__stat-label">файлов затронуто</span>
            </div>
          </div>
        )}

        <div className="session-panel__list" tabIndex={0}>
          {loading && checkpoints.length === 0 ? (
            <div className="session-panel__loading">
              <AppIcon name="loader" size="sm" animation="spin" />
              <span>Загрузка...</span>
            </div>
          ) : visibleCheckpoints.length === 0 ? (
            <div className="session-panel__empty-list">
              <AppIcon name={viewMode === 'last' ? 'zap' : viewMode === 'files' ? 'folder' : 'messageSquare'} size="md" tone="muted" />
              <p>{viewMode === 'last' ? 'Нет правок в последнем запросе' : viewMode === 'files' ? (search ? 'Ничего не найдено' : 'Нет правок за сессию') : (search ? 'Ничего не найдено' : 'Нет запросов в сессии')}</p>
              <span>{viewMode === 'last' ? 'Попросите AI изменить файл — здесь появятся изменения' : viewMode === 'files' ? (search ? 'Попробуйте другой запрос' : 'Отправьте запрос с правкой файлов') : (search ? 'Попробуйте другой запрос' : 'Отправьте сообщение в чат')}</span>
            </div>
          ) : (
            <div className="session-panel__items">
              {visibleCheckpoints.slice().reverse().map((cp, idx) => {
                const isLast = idx === 0
                const isSelected = selectedCheckpoint?.id === cp.id
                const cpStats = getCheckpointStats(cp)
                return (
                  <div
                    key={cp.id}
                    className={`session-checkpoint ${isSelected ? 'session-checkpoint--selected' : ''} ${isLast ? 'session-checkpoint--latest' : ''}`}
                  >
                    <motion.button
                      className="session-checkpoint__main"
                      onClick={() => loadCheckpointDiff(cp)}
                      title={cp.userPromptPreview}
                      whileHover={whileHoverListItem}
                      whileTap={whileTapListItem}
                      transition={springHover}
                    >
                      <div className="session-checkpoint__header-row">
                        <span className="session-checkpoint__time">
                          {new Date(cp.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {isLast && <span className="session-checkpoint__latest-tag">последний</span>}
                      </div>
                      <div className="session-checkpoint__preview">{cp.userPromptPreview}</div>
                      {/* Mini diff-stat bar */}
                      {cpStats && (cpStats.added > 0 || cpStats.deleted > 0) && (
                        <div className="session-checkpoint__stat-bar">
                          {cpStats.added > 0 && (
                            <div className="session-checkpoint__stat-added" style={{ flexGrow: cpStats.added }} title={`+${cpStats.added}`} />
                          )}
                          {cpStats.deleted > 0 && (
                            <div className="session-checkpoint__stat-deleted" style={{ flexGrow: cpStats.deleted }} title={`-${cpStats.deleted}`} />
                          )}
                        </div>
                      )}
                    </motion.button>
                    {cp.filePaths.length > 0 && (
                      <>
                        <div className="session-checkpoint__files-summary">
                          <span className="session-checkpoint__files-badge">
                            {uniqueFileCount(cp)}
                          </span>
                          <span>{fileWord(uniqueFileCount(cp))} изменено</span>
                        </div>
                        <div className="session-checkpoint__paths">
                          {[...new Set(cp.filePaths)].map((p, i) => {
                            const fileName = basename(p)
                            const dir = dirname(p)
                            const stats = lastCheckpointWithFiles?.id === cp.id && lastTurnChanges
                              ? lastTurnChanges.files.find(f => f.path === p)
                              : null
                            return (
                              <motion.button
                                key={`${p}-${i}`}
                                className={`session-checkpoint__path ${isSelected ? 'session-checkpoint__path--active' : ''}`}
                                onClick={() => loadCheckpointDiff(cp)}
                                title={p}
                                whileHover={whileHoverListItem}
                                whileTap={whileTapListItem}
                                transition={springHover}
                              >
                                <FileIcon name={fileName} size={12} />
                                <span className="session-checkpoint__path-name">{fileName}</span>
                                {stats && (
                                  <span className="session-checkpoint__path-stats">
                                    <span className="session-checkpoint__path-added">+{stats.added}</span>
                                    <span className="session-checkpoint__path-deleted">-{stats.deleted}</span>
                                  </span>
                                )}
                                {dir && <span className="session-checkpoint__path-dir">{dir}</span>}
                              </motion.button>
                            )
                          })}
                        </div>
                      </>
                    )}
                    {/* Inline confirm для rewind / undo files — зависит от режима */}
                    {confirmTarget === `rewind:${cp.id}` ? (
                      <motion.div
                        className="session-checkpoint__confirm"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                      >
                        {viewMode === 'chat' ? (
                          <span>Полный откат? Файлы, сообщения и контекст восстановятся к этой точке. Всё после — удалится.</span>
                        ) : (
                          <span>Откатить файлы к этому запросу? ({uniqueFileCount(cp)} {fileWord(uniqueFileCount(cp))})</span>
                        )}
                        <div className="session-checkpoint__confirm-actions">
                          <motion.button
                            className="session-checkpoint__confirm-yes"
                            onClick={() => viewMode === 'chat' ? handleRewind(cp) : handleUndoFilesOnly(cp)}
                            disabled={rewinding}
                            whileHover={whileHoverSm}
                            whileTap={whileTapSm}
                            transition={springHover}
                          >
                            {rewinding ? <AppIcon name="loader" size="xs" animation="spin" /> : <AppIcon name="check" size="xs" />}
                            Да
                          </motion.button>
                          <motion.button
                            className="session-checkpoint__confirm-no"
                            onClick={() => setConfirmTarget(null)}
                            whileHover={whileHoverSm}
                            whileTap={whileTapSm}
                            transition={springHover}
                          >
                            Нет
                          </motion.button>
                        </div>
                      </motion.div>
                    ) : (
                      <motion.button
                        className="session-checkpoint__rewind"
                        title={viewMode === 'chat' ? 'Откатить сессию (файлы + сообщения + контекст)' : 'Откатить файлы к этому запросу'}
                        onClick={() => setConfirmTarget(`rewind:${cp.id}`)}
                        disabled={rewinding}
                        whileHover={whileHoverSm}
                        whileTap={whileTapSm}
                        transition={springHover}
                      >
                        <AppIcon name={viewMode === 'chat' ? 'rewind' : 'undo'} size="xs" />
                        <span>{viewMode === 'chat' ? 'Откатить сюда' : 'Откатить файлы'}</span>
                      </motion.button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Resize handle ── */}
      <div
        ref={timelineResizeRef}
        className="session-panel__resize-handle"
        onMouseDown={handleTimelineResize}
      />

      {/* ── Правая колонка: diff ── */}
      <div className="session-panel__diff">
        <AnimatePresence mode="wait">
          {selectedCheckpoint && (
            <motion.div
              key={selectedCheckpoint.id}
              className="session-panel__diff-content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              {/* ── Diff header: file count + «Отменить все» ── */}
              <div className="session-panel__diff-header">
                <div className="session-panel__diff-header-left">
                  <AppIcon name="fileText" size="xs" />
                  <span className="session-panel__diff-title">
                    {uniqueFileCount(selectedCheckpoint) > 0
                      ? `${uniqueFileCount(selectedCheckpoint)} ${fileWord(uniqueFileCount(selectedCheckpoint))}`
                      : 'Нет изменений файлов'}
                  </span>
                </div>
                {uniqueFileCount(selectedCheckpoint) > 0 && (
                  <>
                    {confirmTarget === 'undo-all' ? (
                      <motion.div
                        className="session-panel__confirm-inline"
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: 'auto' }}
                        exit={{ opacity: 0, width: 0 }}
                      >
                        <span>Отменить все?</span>
                        <motion.button
                          className="session-panel__confirm-yes"
                          onClick={handleUndoAllFiles}
                          disabled={!!undoingFile || undoingAll}
                          whileHover={whileHoverSm}
                          whileTap={whileTapSm}
                          transition={springHover}
                        >
                          {undoingAll ? <AppIcon name="loader" size="xs" animation="spin" /> : <AppIcon name="check" size="xs" />}
                          Да
                        </motion.button>
                        <motion.button
                          className="session-panel__confirm-no"
                          onClick={() => setConfirmTarget(null)}
                          whileHover={whileHoverSm}
                          whileTap={whileTapSm}
                          transition={springHover}
                        >
                          Нет
                        </motion.button>
                      </motion.div>
                    ) : (
                      <motion.button
                        className="session-panel__diff-undo-all"
                        onClick={() => setConfirmTarget('undo-all')}
                        disabled={!!undoingFile || undoingAll}
                        title="Отменить все изменения этого запроса"
                        whileHover={whileHoverSm}
                        whileTap={whileTapSm}
                        transition={springHover}
                      >
                        {undoingAll ? (
                          <AppIcon name="refreshCw" size="xs" animation="spin" />
                        ) : (
                          <AppIcon name="undo" size="xs" />
                        )}
                        <span>{undoingAll ? 'Отмена...' : 'Отменить все'}</span>
                      </motion.button>
                    )}
                  </>
                )}
              </div>

              {/* ── File chips (кликабельные для выбора diff) ── */}
              {uniqueFileCount(selectedCheckpoint) > 0 && (
                <div className="session-panel__file-chips">
                  {[...new Set(selectedCheckpoint.filePaths)].map((p) => {
                    const name = basename(p)
                    const dir = dirname(p)
                    const stats = getFileStats(p)
                    const isUndoing = undoingFile === p
                    const isUndone = undoneFiles.has(p)
                    const isSelectedFile = selectedFilePath === p
                    const fileDiff = parsedDiffs.find(d => d.filePath === p)
                    return (
                      <div
                        key={p}
                        className={`session-file-chip ${isSelectedFile ? 'session-file-chip--selected' : ''} ${isUndone ? 'session-file-chip--undone' : ''}`}
                        onClick={() => !isUndone && setSelectedFilePath(p)}
                      >
                        <div className="session-file-chip__info" title={p}>
                          <FileIcon name={name} size={14} />
                          <span className="session-file-chip__name">{name}</span>
                          {dir && <span className="session-file-chip__dir">{dir}</span>}
                          {(stats || fileDiff) && (
                            <span className="session-file-chip__stats">
                              <span className="session-file-chip__added">+{stats?.added ?? fileDiff?.added ?? 0}</span>
                              <span className="session-file-chip__deleted">-{stats?.deleted ?? fileDiff?.deleted ?? 0}</span>
                            </span>
                          )}
                          {isUndone && <span className="session-file-chip__undone-tag">восстановлено</span>}
                        </div>
                        {!isUndone && confirmTarget !== `file:${p}` && (
                          <motion.button
                            className="session-file-chip__undo"
                            onClick={(e) => {
                              e.stopPropagation()
                              setConfirmTarget(`file:${p}`)
                            }}
                            disabled={!!undoingFile || undoingAll}
                            title="Отменить изменения в этом файле"
                            whileHover={whileHoverTiny}
                            whileTap={whileTapTiny}
                            transition={springHover}
                          >
                            {isUndoing ? (
                              <AppIcon name="refreshCw" size="xs" animation="spin" />
                            ) : (
                              <AppIcon name="undo" size="xs" />
                            )}
                          </motion.button>
                        )}
                        {/* Inline confirm для per-file undo */}
                        {confirmTarget === `file:${p}` && (
                          <motion.div
                            className="session-file-chip__confirm"
                            initial={{ opacity: 0, width: 0 }}
                            animate={{ opacity: 1, width: 'auto' }}
                            exit={{ opacity: 0, width: 0 }}
                          >
                            <motion.button
                              className="session-panel__confirm-yes"
                              onClick={(e) => { e.stopPropagation(); handleUndoFile(p) }}
                              disabled={!!undoingFile || undoingAll}
                              whileHover={whileHoverSm}
                              whileTap={whileTapSm}
                              transition={springHover}
                            >
                              <AppIcon name="check" size="xs" /> Да
                            </motion.button>
                            <motion.button
                              className="session-panel__confirm-no"
                              onClick={(e) => { e.stopPropagation(); setConfirmTarget(null) }}
                              whileHover={whileHoverSm}
                              whileTap={whileTapSm}
                              transition={springHover}
                            >
                              Нет
                            </motion.button>
                          </motion.div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* ── Diff body: Monaco DiffEditor ── */}
              <div className="session-panel__diff-body">
                {diffLoading ? (
                  <div className="session-panel__diff-loading">
                    <AppIcon name="loader" size="sm" animation="spin" />
                    <span>Загрузка diff...</span>
                  </div>
                ) : currentFileDiff ? (
                  <SafeDiffEditor
                    key={`${selectedCheckpoint.id}:${selectedFilePath}`}
                    original={currentFileDiff.original}
                    modified={currentFileDiff.modified}
                    language={getLanguage(currentFileDiff.filePath)}
                    theme="vs-dark"
                    loading={<div className="session-panel__diff-loading"><AppIcon name="loader" size="sm" animation="spin" /></div>}
                    options={{
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
                    }}
                  />
                ) : uniqueFileCount(selectedCheckpoint) === 0 ? (
                  <div className="session-panel__diff-empty-inner">
                    <AppIcon name="messageSquare" size="md" tone="muted" />
                    <p>В этом запросе файлы не изменялись</p>
                  </div>
                ) : rawDiff ? (
                  <div className="session-panel__diff-empty-inner">
                    <AppIcon name="fileText" size="md" tone="muted" />
                    <p>Выберите файл выше, чтобы увидеть изменения</p>
                  </div>
                ) : (
                  <div className="session-panel__diff-empty-inner">
                    <AppIcon name="fileText" size="md" tone="muted" />
                    <p>Нет diff для отображения</p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
          {!selectedCheckpoint && (
            <motion.div
              key="empty"
              className="session-panel__diff-empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <AppIcon name="history" size="lg" tone="muted" />
              <p>Выберите точку в таймлайне</p>
              <span className="session-panel__diff-empty-hint">
                Клик по карточке слева покажет изменения файлов этого запроса
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
