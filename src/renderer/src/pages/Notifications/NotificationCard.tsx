import { useCallback } from 'react'
import { motion } from 'framer-motion'
import type { NotificationItem } from '../../store/notification.store'
import { useNotificationStore } from '../../store/notification.store'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import './NotificationPage.css'

const TYPE_ICON: Record<string, string> = {
  ai_response: 'sparkles',
  agent_done: 'checkCircle',
  permission: 'shieldAlert',
  ask_user: 'helpCircle',
  messenger: 'messageCircle',
  updates: 'download',
  system: 'info',
}

const TYPE_TONE: Record<string, 'accent' | 'success' | 'warning' | 'danger'> = {
  ai_response: 'accent',
  agent_done: 'success',
  permission: 'warning',
  ask_user: 'accent',
  messenger: 'accent',
  updates: 'accent',
  system: 'accent',
}

const PRIORITY_BORDER: Record<string, string> = {
  info: 'notif-card--info',
  success: 'notif-card--success',
  warning: 'notif-card--warning',
  urgent: 'notif-card--urgent',
}

interface Props {
  item: NotificationItem
  index: number
  screenImg?: string | null
}

const DROP_SPRING = { type: 'spring' as const, stiffness: 170, damping: 13, mass: 1.1 }

export default function NotificationCard({ item, index, screenImg }: Props) {
  const { remove, pauseTimer, resumeTimer } = useNotificationStore()

  const handleAction = useCallback(
    (actionId: string) => {
      // Все действия идут через notification:action IPC → main процесс →
      // NotificationManager.handleAction → resolveConfirm/resolveQuestion
      // (прямой callback в том же main процессе, без IPC round-trip).
      window.syntee.notification.action({
        id: item.id,
        actionId,
        type: item.type,
        chatId: item.chatId,
        reqId: item.reqId,
      })
      remove(item.id)
    },
    [item.id, item.type, item.chatId, item.reqId, remove],
  )

  // ── Hover: пауза таймера авто-закрытия ──
  // Click-through переключается ЦЕНТРАЛИЗОВАННО в useOverlayHitTesting
  // (mousemove → elementFromPoint → data-interactive). Здесь только
  // pause-on-hover: mouseenter/mouseleave синтезируются Chromium из
  // форварднутых mousemove — работают и в click-through режиме.
  const handleMouseEnter = useCallback(() => {
    pauseTimer(item.id)
  }, [item.id, pauseTimer])

  const handleMouseLeave = useCallback(() => {
    resumeTimer(item.id)
  }, [item.id, resumeTimer])

  const iconName = item.icon ?? TYPE_ICON[item.type] ?? 'bell'
  const tone = TYPE_TONE[item.type] ?? 'accent'

  return (
    <motion.div
      className={`notif-card ${PRIORITY_BORDER[item.priority] ?? 'notif-card--info'}`}
      data-interactive="true"
      layout
      layoutId={`notif-${item.id}`}
      initial={{
        opacity: 0,
        scale: 0.25,
        borderRadius: '50%',
        y: -80,
        width: 48,
        height: 48,
      }}
      animate={{
        opacity: 1,
        scale: 1,
        borderRadius: '14px',
        y: 0,
        width: 340,
        height: 'auto',
        transition: {
          ...DROP_SPRING,
          y: { ...DROP_SPRING, delay: 0 },
          scale: { ...DROP_SPRING, delay: 0.05 },
          borderRadius: { duration: 0.5, ease: 'easeOut', delay: 0.1 },
          width: { ...DROP_SPRING, delay: 0.05 },
          height: { duration: 0.4, ease: 'easeOut', delay: 0.1 },
          opacity: { duration: 0.25, ease: 'easeOut' },
        },
      }}
      exit={{
        opacity: 0,
        scale: 0.2,
        borderRadius: '50%',
        y: -40,
        width: 40,
        height: 40,
        transition: {
          duration: 0.4,
          ease: [0.4, 0, 0.2, 1],
          opacity: { duration: 0.25, ease: 'easeIn' },
          y: { duration: 0.4, ease: [0.4, 0, 0.2, 1] },
        },
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ zIndex: 100 - index, originX: 0.5, originY: 0 }}
    >
      {screenImg && (
        <div className="notif-blur-bg" style={{ backgroundImage: `url(${screenImg})` }} />
      )}

      {index > 0 && (
        <motion.div
          className="notif-droplet-link"
          initial={{ scaleY: 0, opacity: 0, height: 0 }}
          animate={{ scaleY: 1, opacity: 1, height: 8 }}
          exit={{ scaleY: 0, opacity: 0, height: 0 }}
          transition={{ delay: 0.2, duration: 0.3, ease: 'easeOut' }}
        />
      )}

      <motion.div
        className="notif-card-inner"
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.25, duration: 0.3, ease: 'easeOut' }}
      >
        <div className="notif-icon-wrap">
          <AppIcon name={iconName as any} size="sm" tone={tone} strokeWidth={2} />
        </div>

        <div className="notif-content">
          <div className="notif-title">{item.title}</div>
          {item.body && <div className="notif-body">{item.body}</div>}
          {item.actions.length > 0 && (
            <div className="notif-actions">
              {item.actions.map((action) => (
                <button
                  key={action.id}
                  className="notif-action-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleAction(action.id)
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          className="notif-close"
          onClick={(e) => {
            e.stopPropagation()
            remove(item.id)
          }}
          title="Закрыть"
        >
          <AppIcon name="x" size="xs" tone="muted" strokeWidth={2.2} />
        </button>
      </motion.div>
    </motion.div>
  )
}
