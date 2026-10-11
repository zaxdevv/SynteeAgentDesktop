import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import type { Attachment } from '../../../../../shared/types'
import CodePreview from '../CodePreview/CodePreview'
import { useFileTabsStore } from '../../../store/fileTabs.store'
import { useUIStore } from '../../../store/ui.store'
import { useChatStore } from '../../../store/chat.store'
import './AttachmentPreviewModal.css'

interface AttachmentPreviewModalProps {
  attachment: Attachment | null
  onClose: () => void
}

interface FilePreviewState {
  content: string
  loading: boolean
  error?: string
  isBinary?: boolean
  truncated?: boolean
  size?: number
}

// Расширения текстовых файлов, которые имеет смысл показывать через CodePreview.
const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'toml',
  'md', 'txt', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg',
  'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php',
  'sh', 'bash', 'zsh', 'ps1', 'sql', 'graphql', 'env', 'gitignore',
  'vue', 'svelte', 'lock', 'log', 'csv', 'ini', 'cfg', 'conf',
])

function isTextFile(att: Attachment): boolean {
  if (att.mime && att.mime.startsWith('text/')) return true
  if (att.mime === 'application/json') return true
  if (att.mime === 'application/xml') return true
  if (att.path) {
    const ext = att.path.split('.').pop()?.toLowerCase() ?? ''
    if (TEXT_EXTENSIONS.has(ext)) return true
  }
  // Если есть snippet — значит файл уже был прочитан как текстовый
  if (att.snippet) return true
  return false
}

export default function AttachmentPreviewModal({ attachment, onClose }: AttachmentPreviewModalProps) {
  const [filePreview, setFilePreview] = useState<FilePreviewState | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const panStart = useRef({ x: 0, y: 0 })

  // Загрузка содержимого файла (сброс zoom/pan делается через key в MessageBubble)
  useEffect(() => {
    if (!attachment || attachment.kind !== 'file' || !isTextFile(attachment) || !attachment.path) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- легитимный loading-state при загрузке файла
    setFilePreview({ content: '', loading: true })
    ;(async () => {
      try {
        const result = await window.syntee.attachments.readFile({ path: attachment.path! }) as
          { content: string; mime?: string; size?: number; error?: string }
        if (cancelled) return
        if (result.error) {
          setFilePreview({ content: '', loading: false, error: result.error })
        } else {
          setFilePreview({
            content: result.content ?? '',
            loading: false,
            size: result.size,
            truncated: (result.size ?? 0) > 512 * 1024,
          })
        }
      } catch (e) {
        if (cancelled) return
        setFilePreview({ content: '', loading: false, error: String((e as Error)?.message ?? e) })
      }
    })()
    return () => { cancelled = true }
  }, [attachment])

  // Esc для закрытия
  useEffect(() => {
    if (!attachment) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [attachment, onClose])

  // Сброс зума колесом мыши
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    setZoom(z => Math.min(5, Math.max(0.2, z + delta)))
  }, [])

  // Drag для панорамирования зумнутого изображения
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1) return
    setIsPanning(true)
    panStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
  }, [zoom, pan])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return
    setPan({ x: e.clientX - panStart.current.x, y: e.clientY - panStart.current.y })
  }, [isPanning])

  const onMouseUp = useCallback(() => {
    setIsPanning(false)
  }, [])

  const resetZoom = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  if (!attachment) return null

  const imageSrc = attachment.dataUrl || (attachment.path ? `file://${attachment.path}` : null)

  // ВАЖНО: без AnimatePresence! PresenceContext framer-motion проходит через
  // createPortal: exit-анимация внутри портала ломала onExitComplete
  // родительских AnimatePresence (SettingsPage / App) — страница настроек
  // никогда не удалялась из DOM, и невидимый оверлей блокировал весь UI.
  // Модалка теперь монтируется/размонтируется синхронно — зомби невозможны.
  return createPortal(
    <motion.div
      className="att-preview-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
        {/* Кнопка закрытия */}
        <button
          className="att-preview-close"
          onClick={onClose}
          title="Закрыть (Esc)"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* Имя файла */}
        <div className="att-preview-header">
          <span className="att-preview-name">{attachment.name}</span>
          {attachment.relPath && (
            <span className="att-preview-path">{attachment.relPath}</span>
          )}
          {/* Кнопка «Открыть в просмотре» — открывает файл в Monaco-редакторе */}
          {attachment.path && isTextFile(attachment) && attachment.relPath && (
            <button
              className="att-preview-open-viewer"
              onClick={async (e) => {
                e.stopPropagation()
                const chatId = useChatStore.getState().currentChatId
                if (!chatId) return
                const wd = await window.syntee.fs.getWorkdir(chatId)
                if (!wd) return
                useUIStore.getState().setAgentPanelOpen(true)
                window.syntee.settings.set('agentPanelOpen', true)
                void useFileTabsStore.getState().openFile(attachment.relPath!, wd)
                onClose()
              }}
              title="Открыть в просмотре"
            >
              Открыть в просмотре
            </button>
          )}
        </div>

        {/* Контент */}
        <div
          className="att-preview-content"
          onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
        >
          {attachment.kind === 'image' && imageSrc && (
            <div className="att-preview-image-wrap">
              <motion.img
                src={imageSrc}
                alt={attachment.name}
                className="att-preview-img"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  cursor: zoom > 1 ? (isPanning ? 'grabbing' : 'grab') : 'default',
                }}
                initial={{ scale: 0.85, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 28 }}
                draggable={false}
                onWheel={onWheel}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                onDoubleClick={resetZoom}
              />
              {zoom !== 1 && (
                <button className="att-preview-zoom-reset" onClick={resetZoom} title="Сбросить зум">
                  {Math.round(zoom * 100)}%
                </button>
              )}
            </div>
          )}

          {attachment.kind === 'image' && !imageSrc && (
            <div className="att-preview-error">Нет данных изображения</div>
          )}

          {(attachment.kind === 'video' || attachment.kind === 'audio') && (
            <div className="att-preview-media" onClick={e => e.stopPropagation()}>
              {imageSrc ? (
                attachment.kind === 'video'
                  ? <video src={imageSrc} controls preload="metadata" style={{ maxWidth: '85vw', maxHeight: '75vh' }} />
                  : <audio src={imageSrc} controls preload="metadata" />
              ) : <p>Нет данных медиафайла</p>}
              <p>Анализ через {attachment.kind === 'video' ? 'analyze_video' : 'analyze_audio'} — модель выбирается в настройках ИИ.</p>
              {attachment.path && (
                <button className="att-preview-open-external" onClick={() => { void window.syntee.shell.openPath(attachment.path!) }}>
                  Открыть в системе
                </button>
              )}
            </div>
          )}

          {attachment.kind === 'file' && isTextFile(attachment) && (
            <motion.div
              className="att-preview-code"
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 28 }}
              onClick={(e) => e.stopPropagation()}
            >
              {filePreview?.loading && (
                <div className="att-preview-loading">
                  <div className="att-preview-spinner" />
                  <span>Загрузка…</span>
                </div>
              )}
              {filePreview?.error && (
                <div className="att-preview-error">Ошибка: {filePreview.error}</div>
              )}
              {filePreview && !filePreview.loading && !filePreview.error && (
                <CodePreview
                  content={filePreview.content}
                  path={attachment.path || attachment.name}
                  showLineNumbers
                  maxHeight="80vh"
                  truncated={filePreview.truncated}
                  totalSize={filePreview.size}
                />
              )}
            </motion.div>
          )}

          {attachment.kind === 'file' && !isTextFile(attachment) && (
            <motion.div
              className="att-preview-binary"
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            >
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <p>Бинарный файл — превью недоступно</p>
              {attachment.path && (
                <button
                  className="att-preview-open-external"
                  onClick={(e) => { e.stopPropagation(); window.syntee.shell.openPath(attachment.path!) }}
                >
                  Открыть в системе
                </button>
              )}
            </motion.div>
          )}

          {(attachment.kind === 'skill' || attachment.kind === 'command') && (
            <motion.div
              className="att-preview-skill"
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 28 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="att-preview-skill-header">
                <span className="att-preview-skill-kind">
                  {attachment.kind === 'skill' ? 'Скилл' : 'Команда'}
                </span>
                <span className="att-preview-skill-name">{attachment.name}</span>
              </div>
              {attachment.snippet && (
                <pre className="att-preview-skill-snippet">{attachment.snippet}</pre>
              )}
              {!attachment.snippet && (
                <p className="att-preview-error">Нет описания</p>
              )}
            </motion.div>
          )}
        </div>
    </motion.div>,
    document.body
  )
}
