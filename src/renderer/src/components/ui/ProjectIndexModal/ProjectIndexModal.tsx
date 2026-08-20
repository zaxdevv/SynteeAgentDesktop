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
  watcherActive: boolean
  indexingInProgress: boolean
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

export function ProjectIndexModal({ open, projectId, projectName, onClose }: ProjectIndexModalProps) {
  const [status, setStatus] = useState<IndexStatus | null>(null)
  const [reindexing, setReindexing] = useState(false)
  const [progress, setProgress] = useState<{ stage: string; detail?: string; filesProcessed?: number; filesTotal?: number } | null>(null)
  const [confirmAction, setConfirmAction] = useState<'reindex' | 'clear' | null>(null)

  const fetchStatus = (pid: string) => {
    window.syntee.fastContext.getStatus(pid).then(setStatus).catch(() => {})
  }

  useEffect(() => {
    if (open && projectId) {
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
      await window.syntee.fastContext.reindex(projectId)
    } catch {
      /* ошибка залогирована в main */
    } finally {
      setReindexing(false)
      setProgress(null)
    }
  }

  const handleClear = async () => {
    if (!projectId) return
    setConfirmAction(null)
    await window.syntee.fastContext.clearIndex(projectId)
    fetchStatus(projectId)
  }

  const progressPct = progress?.filesTotal && progress.filesProcessed !== undefined
    ? Math.round((progress.filesProcessed / progress.filesTotal) * 100)
    : 0

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="pim-overlay"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
        >
          <motion.div
            className="pim-modal"
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
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
                <div className="pim-loading">
                  <AppIcon name="loader" size="md" tone="muted" animation="spin" />
                  <span>Загрузка...</span>
                </div>
              ) : status ? (
                <>
                  {/* Stats grid */}
                  <div className="pim-stats-grid">
                    <div className="pim-stat-card">
                      <div className="pim-stat-label">Файлов в индексе</div>
                      <div className="pim-stat-value">{status.fileCount.toLocaleString('ru-RU')}</div>
                    </div>
                    <div className="pim-stat-card">
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
                        ) : (
                          <><span className="pim-dot pim-dot--active" /> Готов</>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Live progress */}
                  {(reindexing || status.indexingInProgress) && progress && (
                    <div className="pim-progress">
                      <div className="pim-progress-header">
                        <AppIcon name="loader" size="xs" animation="spin" />
                        <span>{progress.detail || 'Индексация...'}</span>
                      </div>
                      {progress.filesTotal !== undefined && progress.filesTotal > 0 && (
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
                              <span className="pim-list-type">{EVENT_LABELS[h.eventType] || h.eventType}</span>
                              <span className="pim-list-detail">{h.filesChanged} файлов</span>
                              <span className="pim-list-detail">{h.durationMs}ms</span>
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
                        {status.recentFiles.length === 0 ? (
                          <div className="pim-empty">Нет данных</div>
                        ) : (
                          status.recentFiles.map((f, i) => (
                            <div key={i} className="pim-list-row pim-list-row--file">
                              <span className="pim-list-lang">{f.lang || '?'}</span>
                              <span className="pim-list-path" title={f.filePath}>{shortPath(f.filePath)}</span>
                              <span className="pim-list-time">{formatTime(f.updatedAt)}</span>
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
                      {status.topFiles.length === 0 ? (
                        <div className="pim-empty">Нет данных</div>
                      ) : (
                        status.topFiles.map((f, i) => (
                          <div key={i} className="pim-top-row">
                            <span className="pim-top-rank">#{i + 1}</span>
                            <span className="pim-list-lang">{f.lang || '?'}</span>
                            <span className="pim-list-path" title={f.filePath}>{shortPath(f.filePath)}</span>
                            <span className="pim-top-score">{(f.rankedScore * 100).toFixed(1)}%</span>
                            {f.relevanceBoost > 0 && (
                              <span className="pim-top-boost" title="Relevance boost">+{f.relevanceBoost.toFixed(1)}</span>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="pim-empty">Не удалось загрузить статус</div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
