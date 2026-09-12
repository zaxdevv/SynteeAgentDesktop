import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import './ProjectIndexModal.css'

interface IndexHistoryEntry {
  id: number
  eventType: string
  filesCount: number
  filesChanged: number
  durationMs: number
  createdAt: number
}

interface RecentFile {
  filePath: string
  lang: string | null
  rankedScore: number
  updatedAt: number
}

interface TopFile {
  filePath: string
  lang: string | null
  rankedScore: number
  relevanceBoost: number
  updatedAt: number
}

interface IndexStatus {
  fileCount: number
  lastUpdated: number | null
  lastScanAt: number | null
  watcherActive: boolean
  indexingInProgress: boolean
  queued: boolean
  history: IndexHistoryEntry[]
  recentFiles: RecentFile[]
  topFiles: TopFile[]
}

interface ProjectIndexModalProps {
  open: boolean
  projectId: string | null
  projectName?: string
  onClose: () => void
}

const EVENT_LABELS: Record<string, string> = {
  full: 'Полная',
  incremental: 'Инкремент.',
  manual: 'Ручной',
  clear: 'Очистка',
}

/** Цвета бейджей типов событий истории. */
const EVENT_TONES: Record<string, string> = {
  full: 'indigo',
  incremental: 'green',
  manual: 'amber',
  clear: 'red',
}

/** Цвета для языков (бейдж в списках файлов). */
const LANG_COLORS: Record<string, string> = {
  typescript: '#3178c6', javascript: '#f7df1e', tsx: '#3178c6', jsx: '#f7df1e',
  python: '#3572A5', rust: '#dea584', go: '#00ADD8', java: '#b07219',
  c: '#555555', cpp: '#f34b7d', csharp: '#178600', ruby: '#701516',
  php: '#4F5D95', html: '#e34c26', css: '#563d7c', json: '#292929',
  yaml: '#cb171e', markdown: '#083fa1', sql: '#e38c00', shell: '#89e051',
  lua: '#000080', kotlin: '#A97BFF', swift: '#F05138',
}

function formatTime(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return 'только что'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`
  return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function shortPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  if (parts.length <= 3) return path
  return '.../' + parts.slice(-2).join('/')
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}м ${Math.round((ms % 60_000) / 1000)}с`
}

export function ProjectIndexModal({ open, projectId, projectName, onClose }: ProjectIndexModalProps) {
  const [status, setStatus] = useState<IndexStatus | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const [progress, setProgress] = useState<{ stage: string; detail?: string; filesProcessed?: number; filesTotal?: number } | null>(null)
  const [confirmAction, setConfirmAction] = useState<'reindex' | 'clear' | null>(null)
  const [filter, setFilter] = useState('')
  const [copiedPath, setCopiedPath] = useState<string | null>(null)

  /** Клик по файлу → копируем полный путь в буфер, показываем галочку. */
  const copyPath = (filePath: string) => {
    navigator.clipboard?.writeText(filePath).catch(() => {})
    setCopiedPath(filePath)
    setTimeout(() => setCopiedPath(p => (p === filePath ? null : p)), 1200)
  }

  const fetchStatus = (pid: string) => {
    window.syntee.fastContext.getStatus(pid)
      .then(s => { setStatus(s as IndexStatus); setLoadError(false) })
      .catch(() => setLoadError(true))
  }

  useEffect(() => {
    if (open && projectId) {
      // Сбрасываем прогресс прошлой сессии модалки, чтобы не показывать
      // устаревший state (модалка монтируется один раз, state переживает close).
      setProgress(null)
      setReindexing(false)
      setFilter('')
      fetchStatus(projectId)
      window.syntee.fastContext.setActive(projectId).catch(() => {})
    }
  }, [open, projectId])

  useEffect(() => {
    if (!open || !projectId) return

    const offProgress = window.syntee.fastContext.onProgress((data) => {
      if (data.projectId !== projectId) return
      setProgress({ stage: data.stage, detail: data.detail, filesProcessed: data.filesProcessed, filesTotal: data.filesTotal })
      if (data.stage === 'done') {
        setReindexing(false)
        setTimeout(() => setProgress(null), 1500)
        fetchStatus(projectId)
      } else if (data.stage === 'error') {
        // Ошибка индексации — показываем и НЕ сбрасываем по таймеру,
        // чтобы пользователь увидел причину.
        setReindexing(false)
        fetchStatus(projectId)
      }
    })

    const offUpdated = (pid: string) => {
      if (pid !== projectId) return
      fetchStatus(projectId)
    }
    const off = window.syntee.fastContext.onUpdated(offUpdated)

    return () => { offProgress(); off() }
  }, [open, projectId])

  const handleReindex = async () => {
    if (!projectId) return
    setConfirmAction(null)
    setReindexing(true)
    setProgress({ stage: 'indexing', detail: 'Запуск...' })
    try {
      const res = await window.syntee.fastContext.reindex(projectId) as { ok?: boolean; error?: string }
      if (res && res.ok === false) {
        // Main вернул ошибку (workdir не найден, worker упал) — показываем.
        setProgress({ stage: 'error', detail: res.error || 'Ошибка индексации' })
        setReindexing(false)
        return
      }
      // Успех: forceReindex резолвится только по завершении job'а в воркере.
      // Финальный сброс состояния делает done-событие из onProgress.
    } catch {
      setProgress({ stage: 'error', detail: 'Не удалось запустить реиндекс (IPC-ошибка)' })
      setReindexing(false)
    }
  }

  const handleClear = async () => {
    if (!projectId) return
    setConfirmAction(null)
    await window.syntee.fastContext.clearIndex(projectId)
    fetchStatus(projectId)
  }

  // Поисковый фильтр — применяется к «Недавно изменённым» и «Топ файлов».
  const q = filter.trim().toLowerCase()
  const recentFiltered = q
    ? status?.recentFiles.filter(f => f.filePath.toLowerCase().includes(q)) ?? []
    : status?.recentFiles ?? []
  const topFiltered = q
    ? status?.topFiles.filter(f => f.filePath.toLowerCase().includes(q)) ?? []
    : status?.topFiles ?? []
  const maxScore = topFiltered.length > 0 ? Math.max(...topFiltered.map(f => f.rankedScore), 0.0001) : 1

  const progressPct = progress?.filesTotal && progress.filesProcessed !== undefined
    ? Math.round((progress.filesProcessed / progress.filesTotal) * 100)
    : 0

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="pim-overlay"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut', exit: { duration: 0.15, ease: 'easeIn' } }}
          onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
        >
          <motion.div
            className="pim-modal"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{
              duration: 0.26,
              ease: [0.16, 1, 0.3, 1],
              exit: { duration: 0.16, ease: 'easeIn' },
            }}
          >
            {/* Header */}
            <div className="pim-header">
              <div className="pim-header-title">
                <AppIcon name="database" size="md" tone="accent" />
                <div>
                  <div className="pim-title">Индекс проекта</div>
                  <div className="pim-subtitle">{projectName || '—'}</div>
                </div>
              </div>
              <button className="pim-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
                <AppIcon name="x" size="sm" />
              </button>
            </div>

            {/* Body */}
            <div className="pim-body">
              {!status ? (
                loadError ? (
                  <div className="pim-empty">
                    <span>Не удалось загрузить статус индекса</span>
                    <button className="pim-btn" onClick={() => projectId && fetchStatus(projectId)}>
                      <AppIcon name="refreshCw" size="xs" />
                      Повторить
                    </button>
                  </div>
                ) : (
                  <div className="pim-loading">
                    <AppIcon name="loader" size="md" tone="muted" animation="spin" />
                    <span>Загрузка...</span>
                  </div>
                )
              ) : (
                <>
                  {/* Stats grid */}
                  <div className="pim-stats-grid">
                    <div className="pim-stat-card">
                      <div className="pim-stat-label">Файлов в индексе</div>
                      <div className="pim-stat-value">{status.fileCount.toLocaleString('ru-RU')}</div>
                    </div>
                    <div className="pim-stat-card" title="Когда фоновая проверка (safety net / prewarm) последний раз сканировала проект. Тихий прогон без изменений не трогает индекс.">
                      <div className="pim-stat-label">Последняя проверка</div>
                      <div className="pim-stat-value pim-stat-time">
                        {status.lastScanAt ? formatTime(status.lastScanAt) : '—'}
                      </div>
                    </div>
                    <div className="pim-stat-card" title="Когда последний раз реально менялось содержимое файлов и индекс обновил записи">
                      <div className="pim-stat-label">Последнее обновление</div>
                      <div className="pim-stat-value pim-stat-time">{formatTime(status.lastUpdated)}</div>
                    </div>
                    <div className="pim-stat-card">
                      <div className="pim-stat-label">Watcher</div>
                      <div className="pim-stat-value pim-stat-status">
                        <span className={`pim-dot ${status.watcherActive ? 'pim-dot--active' : ''}`} />
                        {status.watcherActive ? 'Активен' : 'Остановлен'}
                      </div>
                    </div>
                    <div className="pim-stat-card">
                      <div className="pim-stat-label">Статус</div>
                      <div className="pim-stat-value pim-stat-status">
                        {status.indexingInProgress || reindexing ? (
                          <><AppIcon name="loader" size="xs" animation="spin" /> Индексация</>
                        ) : status.queued ? (
                          <><AppIcon name="clock" size="xs" /> В очереди</>
                        ) : (
                          <><span className="pim-dot pim-dot--active" /> Готов</>
                        )}
                      </div>
                    </div>
                  </div>

              {/* Live progress */}
              {(reindexing || status.indexingInProgress || status.queued || progress?.stage === 'indexing') && progress && (
                <div className={`pim-progress${progress.stage === 'error' ? ' pim-progress--error' : ''}`}>
                  <div className="pim-progress-header">
                    <AppIcon name={progress.stage === 'error' ? 'x' : 'loader'} size="xs" animation={progress.stage === 'error' ? undefined : 'spin'} />
                    <span className="pim-progress-detail">{progress.detail || (progress.stage === 'error' ? 'Ошибка индексации' : 'Индексация...')}</span>
                    {progress.stage !== 'error' && progress.filesTotal !== undefined && progress.filesTotal > 0 && progress.filesProcessed !== undefined && (
                      <span className="pim-progress-count">
                        {progress.filesProcessed.toLocaleString('ru-RU')} / {progress.filesTotal.toLocaleString('ru-RU')} · {progressPct}%
                      </span>
                    )}
                  </div>
                  {progress.stage !== 'error' && progress.filesTotal !== undefined && progress.filesTotal > 0 && (
                    <div className="pim-progress-bar">
                      <div className="pim-progress-fill" style={{ width: `${progressPct}%` }} />
                    </div>
                  )}
                </div>
              )}

                  {/* Actions */}
                  <div className="pim-actions">
                    {confirmAction === 'reindex' ? (
                      <div className="pim-confirm">
                        <span>Полная переиндексация? Это займёт время.</span>
                        <button className="pim-btn pim-btn--accent" onClick={handleReindex}>Да</button>
                        <button className="pim-btn" onClick={() => setConfirmAction(null)}>Отмена</button>
                      </div>
                    ) : confirmAction === 'clear' ? (
                      <div className="pim-confirm">
                        <span>Очистить весь индекс?</span>
                        <button className="pim-btn pim-btn--danger" onClick={handleClear}>Да</button>
                        <button className="pim-btn" onClick={() => setConfirmAction(null)}>Отмена</button>
                      </div>
                    ) : (
                      <>
                        <button
                          className="pim-btn pim-btn--accent"
                          onClick={() => setConfirmAction('reindex')}
                          disabled={reindexing || status.indexingInProgress}
                        >
                          <AppIcon name="refreshCw" size="xs" />
                          Реиндексировать
                        </button>
                        <button
                          className="pim-btn pim-btn--danger"
                          onClick={() => setConfirmAction('clear')}
                          disabled={reindexing || status.indexingInProgress}
                        >
                          <AppIcon name="trash" size="xs" />
                          Очистить
                        </button>
                      </>
                    )}
                  </div>

                  {/* Search filter */}
                  <div className="pim-search">
                    <AppIcon name="search" size="xs" tone="muted" />
                    <input
                      type="text"
                      value={filter}
                      onChange={e => setFilter(e.target.value)}
                      placeholder="Поиск по файлам (пути)…"
                      spellCheck={false}
                    />
                    {filter && (
                      <button className="pim-search-clear" onClick={() => setFilter('')} title="Очистить">
                        <AppIcon name="x" size="xs" />
                      </button>
                    )}
                  </div>

                  {/* Two columns: history + recent files */}
                  <div className="pim-columns">
                    {/* History */}
                    <div className="pim-section">
                      <div className="pim-section-header">
                        <AppIcon name="history" size="xs" tone="muted" />
                        <span>История обновлений</span>
                      </div>
                      <div className="pim-list">
                        {status.history.length === 0 ? (
                          <div className="pim-empty">Нет данных</div>
                        ) : (
                          status.history.slice(0, 15).map(h => (
                            <div key={h.id} className="pim-list-row">
                              <span className={`pim-badge pim-badge--${EVENT_TONES[h.eventType] || 'muted'}`}>
                                {EVENT_LABELS[h.eventType] || h.eventType}
                              </span>
                              <span className="pim-list-detail">{h.filesChanged} файлов</span>
                              <span className="pim-list-detail">{formatDuration(h.durationMs)}</span>
                              <span className="pim-list-time">{formatTime(h.createdAt)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* Recent files */}
                    <div className="pim-section">
                      <div className="pim-section-header">
                        <AppIcon name="clock" size="xs" tone="muted" />
                        <span>Недавно изменённые</span>
                      </div>
                      <div className="pim-list">
                        {recentFiltered.length === 0 ? (
                          <div className="pim-empty">{q ? 'Ничего не найдено' : 'Нет данных'}</div>
                        ) : (
                          recentFiltered.map((f, i) => (
                            <div
                              key={i}
                              className="pim-list-row pim-list-row--file pim-list-row--clickable"
                              title={`${f.filePath} — клик, чтобы скопировать путь`}
                              onClick={() => copyPath(f.filePath)}
                            >
                              <span className="pim-list-lang" style={{ color: LANG_COLORS[f.lang || ''] || '#8b5cf6' }}>
                                {f.lang || '?'}
                              </span>
                              <span className="pim-list-path">{shortPath(f.filePath)}</span>
                              {copiedPath === f.filePath ? (
                                <AppIcon name="check" size="xs" />
                              ) : (
                                <span className="pim-list-time">{formatTime(f.updatedAt)}</span>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Top files */}
                  <div className="pim-section">
                    <div className="pim-section-header">
                      <AppIcon name="star" size="xs" tone="muted" />
                      <span>Топ файлов по важности (PageRank)</span>
                    </div>
                    <div className="pim-top-list">
                      {topFiltered.length === 0 ? (
                        <div className="pim-empty">{q ? 'Ничего не найдено' : 'Нет данных'}</div>
                      ) : (
                        topFiltered.map((f, i) => (
                          <div
                            key={i}
                            className={`pim-top-row pim-list-row--clickable${i < 3 ? ` pim-top-row--${i + 1}` : ''}`}
                            title={`${f.filePath} — клик, чтобы скопировать путь`}
                            onClick={() => copyPath(f.filePath)}
                          >
                            <span className="pim-top-rank">#{i + 1}</span>
                            <span className="pim-list-lang" style={{ color: LANG_COLORS[f.lang || ''] || '#8b5cf6' }}>
                              {f.lang || '?'}
                            </span>
                            <span className="pim-list-path">{shortPath(f.filePath)}</span>
                            {f.relevanceBoost > 0 && (
                              <span className="pim-top-boost" title="Relevance boost">+{f.relevanceBoost.toFixed(1)}</span>
                            )}
                            <span className="pim-top-score">{(f.rankedScore * 100).toFixed(1)}%</span>
                            <span className="pim-top-scorebar">
                              <span className="pim-top-scorebar-fill" style={{ width: `${Math.max(4, Math.round((f.rankedScore / maxScore) * 100))}%` }} />
                            </span>
                            {copiedPath === f.filePath && <AppIcon name="check" size="xs" />}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
