/**
 * ForceUpdateModal — non-dismissable modal shown when a force update (or a
 * version below min_version) is detected.
 *
 * Behaviour:
 *   - No Esc handler, no close button, no click-outside-to-close.
 *   - A 30-second countdown starts on mount; when it hits zero the app quits
 *     automatically and the launcher applies the update.
 *   - The user can click "Обновить сейчас" to quit immediately.
 *   - The changelog is rendered so the user has something to read while the
 *     countdown runs.
 *
 * The modal is mounted by a watcher in App.tsx that reads selectForceUpdate
 * from the update store. Because the store state comes from the main process
 * (not the renderer), the user can't bypass it by manipulating React state.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Zap } from 'lucide-react'
import ChangelogMarkdown from '../ChangelogMarkdown/ChangelogMarkdown'
import { useUpdateStore } from '../../../store/update.store'
import './ForceUpdateModal.css'

const COUNTDOWN_SECONDS = 30

interface Props {
  open: boolean
}

export default function ForceUpdateModal({ open }: Props) {
  const available = useUpdateStore((s) => s.available)
  const quitAndInstall = useUpdateStore((s) => s.quitAndInstall)
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS)
  const [installError, setInstallError] = useState<string | null>(null)

  // The app exits only when the updater actually spawned. On failure we stop
  // the countdown (otherwise it would retry-exit in a loop) and show why.
  const attemptInstall = async () => {
    const res = await quitAndInstall()
    if (!res.ok) {
      setInstallError(res.error ?? 'Неизвестная ошибка')
    }
  }

  // 30s countdown → auto-quit when it hits zero. Re-armed if `open` toggles
  // (e.g. a new force release comes in while the modal is showing). Stopped
  // while installError is set — the user retries manually via the button.
  useEffect(() => {
    if (!open || installError) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRemaining(COUNTDOWN_SECONDS)
    const id = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(id)
          void attemptInstall()
          return 0
        }
        return r - 1
      })
    }, 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, installError])

  if (!open || !available) return null

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="force-modal-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
      >
        <motion.div
          className="force-modal"
          initial={{ opacity: 0, scale: 0.94, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.94, y: 16 }}
          transition={{ type: 'spring', stiffness: 360, damping: 28 }}
        >
          <div className="force-modal-header">
            <div className="force-modal-icon">
              <AlertTriangle size={22} />
            </div>
            <div className="force-modal-title-block">
              <h2 className="force-modal-title">Требуется обновление</h2>
              <p className="force-modal-subtitle">
                Версия <strong>v{available.version}</strong> обязательна для продолжения работы.
              </p>
            </div>
          </div>

          <div className="force-modal-body">
            <ChangelogMarkdown content={available.changelog} />
          </div>

          <div className="force-modal-footer">
            {installError ? (
              <div className="force-modal-error">
                Не удалось запустить обновление: {installError}
              </div>
            ) : (
              <div className="force-modal-countdown">
                Приложение перезапустится через <strong>{remaining}</strong> сек
              </div>
            )}
            <button
              className="force-modal-btn"
              onClick={() => void attemptInstall()}
            >
              <Zap size={15} />
              Обновить сейчас
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
