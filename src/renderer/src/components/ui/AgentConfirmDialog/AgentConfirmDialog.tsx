import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import { getToolMeta } from '../../../../../shared/toolMeta'
import { playConfirmSound } from '../../../utils/sounds'
import './AgentConfirmDialog.css'

interface ConfirmRequest {
  reqId: string
  toolName: string
  args: Record<string, unknown>
  dangerLevel?: string  // safe | warn | dangerous | blocked — из commandSafety (§1.4)
  dangerReason?: string
  previewDiff?: string  // diff-превью для файловых тулов (§4.1)
}

export default function AgentConfirmDialog() {
  const [queue, setQueue] = useState<ConfirmRequest[]>([])
  // §allowlist — «Всегда разрешать»: чекбокс + scope. Скрывается для
  // dangerous-действий (их allowlist не покрывает) и сбрасывается на новом запросе.
  const [always, setAlways] = useState(false)
  const [allowScope, setAllowScope] = useState<'session' | 'project' | 'global'>('session')

  useEffect(() => {
    const handler = (data: ConfirmRequest) => {
      setQueue(q => [...q, data])
      setAlways(false)
      setAllowScope('session')
      playConfirmSound()
    }
    const wrapper = window.syntee.agent.onConfirm(handler)
    // Notification overlay уже обработал ответ — закрыть диалог
    const offDismiss = window.syntee.agent.onConfirmDismiss((reqId) => {
      setQueue(q => q.filter(r => r.reqId !== reqId))
    })
    return () => {
      if (wrapper) window.syntee.agent.offConfirm?.(wrapper as never)
      offDismiss()
    }
  }, [])

  const respond = (reqId: string, approved: boolean, alwaysScope?: 'session' | 'project' | 'global') => {
    window.syntee.agent.confirmResponse(reqId, approved, approved ? alwaysScope : undefined)
    setQueue(q => q.filter(r => r.reqId !== reqId))
  }

  const current = queue[0]
  const meta = current ? getToolMeta(current.toolName) : null
  // Опасность из единого источника (commandSafety), не локальная эвристика
  const level = current?.dangerLevel ?? 'safe'
  const isDanger = level === 'dangerous' || level === 'blocked'
  const isWarn = level === 'warn'
  // Dangerous нельзя разрешить «навсегда» — только разово
  const canAlways = level !== 'dangerous' && level !== 'blocked'

  // §visual — горячие клавиши: Enter — разрешить, Esc — отклонить.
  // Не срабатывает, когда фокус в поле ввода/селекте (иначе Enter в select
  // «Всегда разрешать» открывал бы диалог заново).
  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === 'Enter') {
        e.preventDefault()
        respond(current.reqId, true, always ? allowScope : undefined)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        respond(current.reqId, false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, always, allowScope])

  return createPortal(
    <AnimatePresence>
      {current && meta && (
        <motion.div
          className={`agent-confirm-overlay agent-confirm-overlay--${level}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <motion.div
            className={`agent-confirm-dialog agent-confirm-dialog--${level}`}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{
              duration: 0.26,
              ease: [0.16, 1, 0.3, 1],
              exit: { duration: 0.16, ease: 'easeIn' },
            }}
          >
            {/* Тематическая полоса-градиент сверху — цвет уровня опасности */}
            <div className="agent-confirm-dialog-glow" />

            <div className={`agent-confirm-icon ${isDanger ? 'agent-confirm-icon--danger' : isWarn ? 'agent-confirm-icon--warn' : 'agent-confirm-icon--safe'}`}>
              <AppIcon name={meta.icon as 'zap'} size="md" />
              {isDanger && <div className="agent-confirm-icon-pulse" />}
            </div>

            <div className="agent-confirm-body">
              <div className="agent-confirm-title">
                {isDanger ? '⚠ Опасное действие' : isWarn ? 'Требует подтверждения' : 'Агент хочет выполнить действие'}
              </div>
              <div className="agent-confirm-tool">{meta.label}</div>
              {current.dangerReason && (
                <div className="agent-confirm-reason">{current.dangerReason}</div>
              )}

              {/* Аргументы */}
              <div className="agent-confirm-args">
                {Object.entries(current.args).map(([k, v]) => (
                  <div key={k} className="agent-confirm-arg">
                    <span className="agent-confirm-arg-key">{k}</span>
                    <span className="agent-confirm-arg-val">
                      {typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : String(v)}
                    </span>
                  </div>
                ))}
              </div>

              {/* Diff-превью для файловых тулов (§4.1) */}
              {current.previewDiff && (
                <pre className="agent-confirm-diff">{current.previewDiff.slice(0, 2000)}</pre>
              )}

              {queue.length > 1 && (
                <div className="agent-confirm-queue">
                  <span className="agent-confirm-queue-dot" />
                  Ещё {queue.length - 1} {queue.length - 1 === 1 ? 'действие' : 'действий'} в очереди
                </div>
              )}
            </div>

            {/* §allowlist — «Всегда разрешать» (кроме dangerous) */}
            {canAlways && (
              <div className="agent-confirm-always">
                <label className="agent-confirm-always-label">
                  <input
                    type="checkbox"
                    checked={always}
                    onChange={e => setAlways(e.target.checked)}
                  />
                  Всегда разрешать
                </label>
                {always && (
                  <select
                    className="agent-confirm-always-scope"
                    value={allowScope}
                    onChange={e => setAllowScope(e.target.value as 'session' | 'project' | 'global')}
                  >
                    <option value="session">до конца чата</option>
                    <option value="project">для этого проекта</option>
                    <option value="global">всегда</option>
                  </select>
                )}
              </div>
            )}

            <div className="agent-confirm-actions">
              <motion.button
                className="agent-confirm-btn agent-confirm-btn--deny"
                onClick={() => respond(current.reqId, false)}
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.96 }}
                title="Esc"
              >
                <AppIcon name="x" size="sm" />
                Отклонить
                <span className="agent-confirm-key">Esc</span>
              </motion.button>
              <motion.button
                className="agent-confirm-btn agent-confirm-btn--allow"
                onClick={() => respond(current.reqId, true, always ? allowScope : undefined)}
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.96 }}
                title="Enter"
              >
                <AppIcon name="check" size="sm" />
                Разрешить
                <span className="agent-confirm-key">↵</span>
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
