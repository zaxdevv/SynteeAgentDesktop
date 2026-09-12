import { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import type { Project } from '../../../../../shared/types'
import './ProjectSettingsModal.css'

interface FsEntry {
  name: string
  path: string
  relPath: string
  isDir: boolean
}

interface ProjectSettingsModalProps {
  open: boolean
  project: Project | null
  onClose: () => void
  onSaved?: (updated: Partial<Project> & { id: string }) => void
  /** Триггерит /init в чате — генерация AGENTS.md. Модалка закрывается сама. */
  onInit?: () => void
}

const STANDARD_FILES = [
  '.syntee/instructions.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  '.cursor/rules.md',
  '.windsurfrules',
  '.clinerules',
  '.github/copilot-instructions.md',
  'copilot-instructions.md',
]

/** Проверка: файл похож на markdown-инструкцию (не только .md) */
const isMdLike = (name: string) =>
  name.endsWith('.md') ||
  name === '.cursorrules' ||
  name === '.windsurfrules' ||
  name === '.clinerules'

export function ProjectSettingsModal({ open, project, onClose, onSaved, onInit }: ProjectSettingsModalProps) {
  // displayProject — persists during exit animation. When `project` becomes
  // null (modal closing), displayProject still holds the last project →
  // AnimatePresence can play the exit animation with valid data.
  const [displayProject, setDisplayProject] = useState<Project | null>(project)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (project) setDisplayProject(project)
  }, [project])

  const [name, setName] = useState(project?.name ?? '')
  const [verificationCommand, setVerificationCommand] = useState(project?.verificationCommand ?? '')
  const [contextFiles, setContextFiles] = useState<string[]>(project?.contextFiles ?? [])
  const [autoDiscover, setAutoDiscover] = useState(project?.autoDiscoverInstructions ?? true)
  const [disabledDiscoveryFiles, setDisabledDiscoveryFiles] = useState<string[]>(project?.disabledDiscoveryFiles ?? [])
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  // ── Файловый пикер: сканирование .md файлов из workdir ──
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [mdFiles, setMdFiles] = useState<FsEntry[]>([])
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [fileSearch, setFileSearch] = useState('')

  // ── Авто-дискавери: какие стандартные файлы найдены в workdir ──
  const [discoveredFiles, setDiscoveredFiles] = useState<string[]>([])
  const [discoveryExpanded, setDiscoveryExpanded] = useState(false)
  const [discoveryLoading, setDiscoveryLoading] = useState(false)

  // Сброс state при смене проекта (когда открывают настройки другого проекта)
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (project) {
      setName(project.name)
      setVerificationCommand(project.verificationCommand ?? '')
      setContextFiles(project.contextFiles ?? [])
      setAutoDiscover(project.autoDiscoverInstructions ?? true)
      setDisabledDiscoveryFiles(project.disabledDiscoveryFiles ?? [])
      setSavedFlash(false)
      setFilePickerOpen(false)
      setDiscoveredFiles([])
      setDiscoveryExpanded(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Сканируем workdir на стандартные файлы при открытии модалки
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open && project?.workdir) {
      setDiscoveryLoading(true)
      window.syntee.fs.checkFilesExist({ root: project.workdir, relPaths: STANDARD_FILES })
        .then((r: { success: boolean; existing: string[] }) => {
          if (r.success) setDiscoveredFiles(r.existing)
        })
        .catch(() => {})
        .finally(() => setDiscoveryLoading(false))
    }
  }, [open, project?.workdir])
  /* eslint-enable react-hooks/set-state-in-effect */

  const workdir = displayProject?.workdir
  const handleOpenFilePicker = useCallback(async () => {
    if (!workdir) return
    setFilePickerOpen(true)
    setLoadingFiles(true)
    setFileSearch('')
    try {
      const result = await window.syntee.fs.searchFiles({ root: workdir, query: '.md', maxResults: 200 }) as { success: boolean; entries: FsEntry[] }
      if (result.success) {
        // Фильтруем: только md-like файлы, не директории, исключаем стандартные (они через авто-дискавери)
        const filtered = result.entries.filter(e => !e.isDir && isMdLike(e.name))
        setMdFiles(filtered)
      }
    } catch (e) {
      console.error('[ProjectSettingsModal] searchFiles failed', e)
    } finally {
      setLoadingFiles(false)
    }
  }, [workdir])

  const handleToggleFile = useCallback((relPath: string) => {
    setContextFiles(prev => {
      if (prev.includes(relPath)) return prev.filter(f => f !== relPath)
      return [...prev, relPath]
    })
  }, [])

  const handleRemoveFile = useCallback((file: string) => {
    setContextFiles(prev => prev.filter(f => f !== file))
  }, [])

  const handleSave = useCallback(async () => {
    if (!displayProject) return
    setSaving(true)
    try {
      // Сохраняем имя
      if (name.trim() && name.trim() !== displayProject.name) {
        await window.syntee.projects.rename(displayProject.id, name.trim())
      }
      // Сохраняем команду проверки
      const cmd = verificationCommand.trim() || null
      if (cmd !== (displayProject.verificationCommand ?? null)) {
        await window.syntee.projects.setVerificationCommand(displayProject.id, cmd)
      }
      // Сохраняем контекстные файлы
      await window.syntee.projects.setContextFiles(displayProject.id, contextFiles, autoDiscover, disabledDiscoveryFiles)

      onSaved?.({
        id: displayProject.id,
        name: name.trim(),
        verificationCommand: cmd ?? undefined,
        contextFiles,
        autoDiscoverInstructions: autoDiscover,
        disabledDiscoveryFiles,
      })
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    } catch (e) {
      console.error('[ProjectSettingsModal] save failed', e)
    } finally {
      setSaving(false)
    }
  }, [displayProject, name, verificationCommand, contextFiles, autoDiscover, disabledDiscoveryFiles, onSaved])

  if (!displayProject) return null

  // Фильтрация списка .md файлов по поиску
  const filteredMdFiles = fileSearch.trim()
    ? mdFiles.filter(f => f.relPath.toLowerCase().includes(fileSearch.toLowerCase()))
    : mdFiles

  return (
    <>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              className="psm-overlay"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
            >
              <motion.div
                className="psm-modal"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
              >
                {/* Header */}
                <div className="psm-header">
                  <div className="psm-header-title">
                    <AppIcon name="settings" size="md" tone="accent" />
                    <div>
                      <div className="psm-title">Настройки проекта</div>
                      <div className="psm-subtitle">{displayProject.name}</div>
                    </div>
                  </div>
                  <button className="psm-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
                    <AppIcon name="x" size="sm" />
                  </button>
                </div>

                {/* Body */}
                <div className="psm-body">
                  {/* Секция: Основное */}
                  <div className="psm-section">
                    <div className="psm-section-label">Основное</div>
                    <div className="psm-field">
                      <label className="psm-field-label">Имя проекта</label>
                      <input
                        className="psm-input"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder="Имя проекта"
                      />
                    </div>
                    <div className="psm-field">
                      <label className="psm-field-label">Рабочая папка</label>
                      <div className="psm-workdir-row">
                        <span className="psm-workdir-path" title={displayProject.workdir}>{displayProject.workdir}</span>
                        <button
                          className="psm-btn psm-btn--ghost"
                          onClick={() => window.syntee.shell.openPath(displayProject.workdir)}
                        >
                          <AppIcon name="folder" size="xs" />
                          Открыть
                        </button>
                      </div>
                    </div>
                    <div className="psm-field">
                      <label className="psm-field-label">Команда проверки</label>
                      <input
                        className="psm-input"
                        value={verificationCommand}
                        onChange={e => setVerificationCommand(e.target.value)}
                        placeholder="напр. npm test"
                      />
                      <span className="psm-field-hint">Запускается после серии правок для проверки</span>
                    </div>
                  </div>

              {/* Секция: Файлы контекста */}
              <div className="psm-section">
                <div className="psm-section-label">Файлы контекста (.md)</div>
                <span className="psm-section-hint">
                  Файлы, содержимое которых автоматически попадает в системный промпт агента
                </span>

                {/* Авто-дискавери — компактная свёрнутая секция */}
                <div className="psm-discovery">
                  <button
                    className="psm-discovery-header"
                    onClick={() => setDiscoveryExpanded(v => !v)}
                  >
                    <div className="psm-discovery-info">
                      <span className="psm-discovery-label">Авто-дискавери</span>
                      <span className="psm-discovery-status">
                        {discoveryLoading ? 'сканирование...' : autoDiscover
                          ? `${discoveredFiles.length} найдено`
                          : 'выключено'}
                      </span>
                    </div>
                    <div className="psm-discovery-controls">
                      <button
                        className="psm-btn psm-btn--ghost psm-btn--init"
                        onClick={(e) => { e.stopPropagation(); onInit?.(); onClose() }}
                        title="Сгенерировать файл инструкций проекта (AGENTS.md)"
                      >
                        <AppIcon name="sparkles" size="xs" />
                        /init
                      </button>
                      <button
                        className={`psm-toggle psm-toggle--sm ${autoDiscover ? 'psm-toggle--on' : ''}`}
                        onClick={(e) => { e.stopPropagation(); setAutoDiscover(v => !v) }}
                      >
                        <span className="psm-toggle-knob" />
                      </button>
                      <AppIcon name={discoveryExpanded ? 'chevronDown' : 'chevronRight'} size="xs" />
                    </div>
                  </button>

                  {/* Развёрнутый список найденных файлов с тумблерами */}
                  <AnimatePresence>
                    {discoveryExpanded && autoDiscover && (
                      <motion.div
                        className="psm-discovery-list"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                      >
                        {discoveredFiles.length === 0 && !discoveryLoading && (
                          <div className="psm-discovery-empty">
                            Стандартные файлы не найдены в корне проекта
                          </div>
                        )}
                        {discoveredFiles.map(file => {
                          const enabled = !disabledDiscoveryFiles.includes(file)
                          return (
                            <div key={file} className="psm-discovery-file">
                              <AppIcon name="fileText" size="xs" tone={enabled ? 'accent' : 'muted'} />
                              <span className={`psm-discovery-file-path ${enabled ? '' : 'psm-discovery-file-path--disabled'}`}>{file}</span>
                              <button
                                className={`psm-toggle psm-toggle--sm ${enabled ? 'psm-toggle--on' : ''}`}
                                onClick={() => {
                                  setDisabledDiscoveryFiles(prev =>
                                    prev.includes(file) ? prev.filter(f => f !== file) : [...prev, file]
                                  )
                                }}
                                title={enabled ? 'Отключить файл' : 'Включить файл'}
                              >
                                <span className="psm-toggle-knob" />
                              </button>
                            </div>
                          )
                        })}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                    {/* Выбранные файлы */}
                    <div className="psm-files-list">
                      {contextFiles.map(file => (
                        <div key={file} className="psm-file-item">
                          <AppIcon name="fileText" size="xs" />
                          <span className="psm-file-path" title={file}>{file}</span>
                          <button
                            className="psm-file-remove"
                            onClick={() => handleRemoveFile(file)}
                            title="Убрать"
                          >
                            <AppIcon name="x" size="xs" />
                          </button>
                        </div>
                      ))}
                      {contextFiles.length === 0 && (
                        <div className="psm-files-empty">Нет добавленных файлов</div>
                      )}
                    </div>

                    {/* Кнопка открытия файлового пикера */}
                    <button
                      className="psm-btn psm-btn--ghost psm-picker-btn"
                      onClick={handleOpenFilePicker}
                    >
                      <AppIcon name="fileText" size="xs" />
                      Выбрать .md файлы из проекта
                    </button>
                  </div>
                </div>

                {/* Footer */}
                <div className="psm-footer">
                  {savedFlash && (
                    <span className="psm-saved-flash">
                      <AppIcon name="check" size="xs" tone="accent" />
                      Сохранено
                    </span>
                  )}
                  <button className="psm-btn" onClick={onClose}>Отмена</button>
                  <button
                    className="psm-btn psm-btn--accent"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    {saving ? <AppIcon name="loader" size="xs" animation="spin" /> : <AppIcon name="check" size="xs" />}
                    Сохранить
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* ── Right Panel: файловый пикер .md файлов из workdir ──
          Выезжает справа как правая панель. Список найденных .md файлов с
          чекбоксами. Поиск по имени. Выбранные подсвечиваются.
          Всегда смонтирован (createPortal без условия) — AnimatePresence
          управляет exit-анимацией через filePickerOpen. */}
      {createPortal(
        <AnimatePresence>
          {filePickerOpen && (
            <motion.div
              className="psm-picker-overlay"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setFilePickerOpen(false)}
            >
              <motion.div
                className="psm-picker-panel"
                initial={{ x: 400 }} animate={{ x: 0 }} exit={{ x: 400 }}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                onClick={e => e.stopPropagation()}
              >
              {/* Header */}
              <div className="psm-picker-header">
                <div className="psm-picker-title">
                  <AppIcon name="fileText" size="sm" tone="accent" />
                  <span>.md файлы проекта</span>
                </div>
                <button className="psm-picker-close" onClick={() => setFilePickerOpen(false)}>
                  <AppIcon name="x" size="sm" />
                </button>
              </div>

              {/* Search */}
              <div className="psm-picker-search">
                <AppIcon name="search" size="xs" />
                <input
                  className="psm-picker-search-input"
                  placeholder="Поиск..."
                  value={fileSearch}
                  onChange={e => setFileSearch(e.target.value)}
                  autoFocus
                />
              </div>

              {/* List */}
              <div className="psm-picker-list">
                {loadingFiles && (
                  <div className="psm-picker-loading">
                    <AppIcon name="loader" size="sm" animation="spin" />
                    <span>Сканирование...</span>
                  </div>
                )}
                {!loadingFiles && filteredMdFiles.length === 0 && (
                  <div className="psm-picker-empty">
                    {mdFiles.length === 0 ? 'Не найдено .md файлов в проекте' : 'Ничего не найдено'}
                  </div>
                )}
                {!loadingFiles && filteredMdFiles.map(file => {
                  const selected = contextFiles.includes(file.relPath)
                  const isStandard = STANDARD_FILES.includes(file.relPath)
                  return (
                    <button
                      key={file.path}
                      className={`psm-picker-file ${selected ? 'psm-picker-file--selected' : ''}`}
                      onClick={() => !isStandard && handleToggleFile(file.relPath)}
                      disabled={isStandard}
                    >
                      <span className={`psm-picker-checkbox ${selected ? 'psm-picker-checkbox--checked' : ''}`}>
                        {selected && <AppIcon name="check" size="xs" />}
                      </span>
                      <AppIcon name="fileText" size="xs" tone={selected ? 'accent' : 'muted'} />
                      <span className="psm-picker-file-path" title={file.relPath}>{file.relPath}</span>
                      {isStandard && <span className="psm-picker-badge">авто</span>}
                    </button>
                  )
                })}
              </div>

              {/* Footer */}
              <div className="psm-picker-footer">
                <span className="psm-picker-count">
                  Выбрано: {contextFiles.length}
                </span>
                <button className="psm-btn psm-btn--accent" onClick={() => setFilePickerOpen(false)}>
                  <AppIcon name="check" size="xs" />
                  Готово
                </button>
              </div>
            </motion.div>
          </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}
