import { motion, AnimatePresence } from 'framer-motion'
import type { Attachment, AttachmentKind } from '../../../../../shared/types'
import { whileHoverTiny, whileTapTiny, springHover } from '../../../utils/motionPresets'
import './AttachmentChips.css'

interface AttachmentChipsProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
  /** Кликабельность чипа (превью/открытие файла). Опционально. */
  onPreview?: (attachment: Attachment) => void
  /** Лимит достигнут — показываем warning-чип. */
  maxReached?: boolean
  max?: number
  /** Read-only режим (для отправленных сообщений): скрывает кнопку удаления. */
  readOnly?: boolean
}

// Иконка по типу вложения
function KindIcon({ kind }: { kind: AttachmentKind }): JSX.Element {
  if (kind === 'image') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    )
  }
  if (kind === 'audio' || kind === 'video') {
    return <span aria-label={kind === 'video' ? 'Видео' : 'Аудио'}>{kind === 'video' ? '▶' : '♫'}</span>
  }
  if (kind === 'skill') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2l3 7 7 .5-5.5 4.5 1.5 7L12 17l-6 4 1.5-7L2 9.5 9 9z" />
      </svg>
    )
  }
  if (kind === 'command') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </svg>
    )
  }
  // file
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

// Превью для картинок — если есть dataUrl или path
function ImageThumb({ attachment }: { attachment: Attachment }): JSX.Element | null {
  const src = attachment.dataUrl || (attachment.path ? `file://${attachment.path}` : null)
  if (!src) return null
  return <img src={src} alt={attachment.name} className="attachment-chip-thumb" />
}

export default function AttachmentChips({ attachments, onRemove, onPreview, maxReached, max = 10, readOnly = false }: AttachmentChipsProps) {
  if (attachments.length === 0 && !maxReached) return null

  return (
    <div className="attachment-chips">
      <AnimatePresence mode="popLayout">
        {attachments.map(a => (
          <motion.div
            key={a.id}
            className={`attachment-chip attachment-chip--${a.kind}`}
            layout
            initial={{ opacity: 0, scale: 0.7, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.7, y: -4 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            onClick={() => onPreview?.(a)}
            title={a.relPath || a.path || a.name}
          >
            {a.kind === 'image' && <ImageThumb attachment={a} />}
            {a.kind !== 'image' && (
              <span className="attachment-chip-icon">
                <KindIcon kind={a.kind} />
              </span>
            )}
            <span className="attachment-chip-name">{a.name}</span>
            {!readOnly && (
              <motion.button
                className="attachment-chip-remove"
                onClick={(e) => { e.stopPropagation(); onRemove(a.id) }}
                title="Убрать вложение"
                whileHover={whileHoverTiny}
                whileTap={whileTapTiny}
                transition={springHover}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </motion.button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
      {maxReached && !readOnly && (
        <motion.div
          className="attachment-chip attachment-chip--limit"
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.7 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        >
          Лимит {max} файлов
        </motion.div>
      )}
    </div>
  )
}
