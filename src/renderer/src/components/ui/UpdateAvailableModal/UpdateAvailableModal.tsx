/**
 * UpdateAvailableModal — shown when the user clicks the blue update badge in
 * the titlebar. Presents the changelog and offers three actions:
 *
 *   1. "Restart now"      → quitAndInstall() (app.quit → launcher applies)
 *   2. "On next launch"   → close modal, update applied on next launcher cycle
 *   3. "Skip this version" → dismiss(version), badge disappears until next release
 *
 * Esc / click-outside close the modal without dismissing (the badge stays).
 * This is intentionally non-blocking: the user can keep working and decide later.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { RotateCcw, X } from 'lucide-react'
import AppIcon from '../AppIcon/AppIcon'
import ChangelogMarkdown from '../ChangelogMarkdown/ChangelogMarkdown'
import { useUpdateStore } from '../../../store/update.store'
import './UpdateAvailableModal.css'

interface Props {
  open: boolean
  onClose: () => void
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
  } catch {
    return ''
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function UpdateAvailableModal({ open, onClose }: Props) {
  const available = useUpdateStore((s) => s.available)
  const quitAndInstall = useUpdateStore((s) => s.quitAndInstall)
  const dismiss = useUpdateStore((s) => s.dismiss)
  const [installError, setInstallError] = useState<string | null>(null)

  // Restart-now: the app exits only when the updater actually spawned — on
  // failure we stay open and show why, instead of dying silently.
  const handleRestartNow = async () => {
    setInstallError(null)
    const res = await quitAndInstall()
    if (!res.ok) {
      setInstallError(res.error ?? 'Неизвестная ошибка')
    }
  }

  // Esc closes (without dismissing — the badge stays so the user can come back).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !available) return null

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="update-modal-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={onClose}
      >
        <motion.div
          className="update-modal"
          initial={{ opacity: 0, scale: 0.94, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.94, y: 12 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="update-modal-header">
            <h2 className="update-modal-title">
              <AppIcon name="downloadCloud" size="md" />
              <span>Доступна новая версия <strong>v{available.version}</strong></span>
            </h2>
            <button className="update-modal-close" onClick={onClose} title="Закрыть (Esc)">
              <X size={16} />
            </button>
          </div>

          <div className="update-modal-meta">
            <span className="update-modal-meta-item">{formatDate(available.released_at)}</span>
            <span className="update-modal-meta-sep">·</span>
            <span className="update-modal-meta-item">{formatSize(available.zip_size)}</span>
            <span className="update-modal-meta-sep">·</span>
            <span className="update-modal-meta-item update-modal-meta-channel">{available.channel}</span>
          </div>

          <div className="update-modal-body">
            <div className="update-modal-section-title">Список изменений</div>
            <ChangelogMarkdown content={available.changelog} />
          </div>

          <div className="update-modal-actions">
            {installError && (
              <div className="update-modal-error">Не удалось запустить обновление: {installError}</div>
            )}
            <button
              className="update-modal-btn update-modal-btn--ghost"
              onClick={() => { dismiss(); onClose() }}
            >
              Пропустить эту версию
            </button>
            <button
              className="update-modal-btn update-modal-btn--secondary"
              onClick={onClose}
            >
              При следующем запуске
            </button>
            <button
              className="update-modal-btn update-modal-btn--primary"
              onClick={handleRestartNow}
            >
              <RotateCcw size={15} />
              Перезапустить сейчас
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
