import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import AppIcon from '../../ui/AppIcon/AppIcon'
import Identicon from '../../ui/Identicon/Identicon'
import { useAuthStore } from '../../../store/auth.store'
import { useNavStore } from '../../../store/nav.store'
import { useBillingStore } from '../../../store/billing.store'
import { whileHoverWide, whileTapWide, whileHoverListItem, whileTapListItem, springHover } from '../../../utils/motionPresets'
import './UserCard.css'

export default function UserCard() {
  const user = useAuthStore(s => s.user)
  const logout = useAuthStore(s => s.logout)
  const openSettings = useNavStore(s => s.openSettings)
  const [panelOpen, setPanelOpen] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelPos, setPanelPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)

  // Баланс: приоритет — отдельный endpoint billing:balance (он же питает
  // «Настройки → Профиль»); фолбэк — planUsage.balance (на случай, если
  // gateway начнёт класть баланс в /plan). Раньше читали ТОЛЬКО
  // planUsage.balance — gateway его не возвращает, блок не рендерился.
  const balance = useBillingStore(s => s.balance)
  const planUsage = useBillingStore(s => s.planUsage)
  const balanceVal = balance?.balance ?? planUsage?.balance?.balance
  const heldVal = balance?.held ?? planUsage?.balance?.held ?? 0

  // Панель — только идентичность + баланс + действия. Тариф (название плана) и
  // лимиты тарифа убраны: они не влезали в узкую панель сайдбара (обрезались).
  // Полные данные тарифа/лимитов — в Настройках → Профиль («Баланс и тариф»)
  // и в Настройках → Статистика.

  // После рендера панели — измеряем её высоту и позиционируем над карточкой.
  useLayoutEffect(() => {
    if (!panelOpen || !panelRef.current || !cardRef.current) return
    const panelH = panelRef.current.offsetHeight
    const cardRect = cardRef.current.getBoundingClientRect()
    const top = Math.max(8, cardRect.top - panelH - 4)
    setPanelPos(prev => prev ? { ...prev, top, maxHeight: cardRect.top - 12 } : prev)
  }, [panelOpen])

  useEffect(() => {
    if (!panelOpen) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (cardRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setPanelOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [panelOpen])

  useEffect(() => {
    if (!panelOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanelOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panelOpen])

  const openPanel = () => {
    if (!cardRef.current) return
    const rect = cardRef.current.getBoundingClientRect()
    // Начальная позиция — чуть выше карточки, уточнится в useLayoutEffect
    setPanelPos({
      left: rect.left,
      width: rect.width,
      top: Math.max(8, rect.top - 300),
      maxHeight: rect.top - 12,
    })
    setPanelOpen(v => !v)
  }

  const handleProfile = () => {
    setPanelOpen(false)
    openSettings('profile')
  }

  const handleSettings = () => {
    setPanelOpen(false)
    openSettings('general')
  }

  const handleLogout = async () => {
    setPanelOpen(false)
    await logout()
  }

  if (!user) {
    return (
      <div className="usercard usercard--guest" ref={cardRef}>
        <motion.button
          type="button"
          className="usercard-signin"
          onClick={() => openSettings('profile')}
          title="Нажмите, чтобы войти в Syntee-Gateway"
          whileHover={whileHoverWide}
          whileTap={whileTapWide}
          transition={springHover}
        >
          <div className="usercard-avatar-placeholder">
            <AppIcon name="user" size="sm" />
          </div>
          <div className="usercard-info">
            <div className="usercard-name">Гость</div>
            <div className="usercard-email">Нажмите, чтобы войти</div>
          </div>
        </motion.button>
      </div>
    )
  }

  const handle = user.username ? `@${user.username}` : user.email.split('@')[0]
  const displayName = user.display_name || handle

  return (
    <>
      <div className="usercard" ref={cardRef}>
        <motion.button
          type="button"
          className="usercard-btn"
          onClick={() => openPanel()}
          whileHover={whileHoverWide}
          whileTap={whileTapWide}
          transition={springHover}
        >
          <Identicon
            seed={user.id || user.email}
            src={user.avatar_url}
            size={30}
            alt={displayName}
          />
          <div className="usercard-info">
            <div className="usercard-name">{displayName}</div>
            <div className="usercard-email">{handle}</div>
          </div>
          <AppIcon name={panelOpen ? 'chevronDown' : 'chevronRight'} size="xs" tone="muted" />
        </motion.button>
      </div>

      {createPortal(
        <AnimatePresence>
          {panelOpen && panelPos && (
            <motion.div
              ref={panelRef}
              className="usercard-panel"
              style={{
                position: 'fixed',
                left: panelPos.left,
                width: panelPos.width,
                top: panelPos.top,
                zIndex: 10001,
                maxHeight: panelPos.maxHeight,
              }}
              initial={{ opacity: 0, y: 24, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.92 }}
              transition={{ type: 'spring', stiffness: 380, damping: 26, mass: 0.8 }}
            >
              <div className="usercard-panel-header">
                <Identicon
                  seed={user.id || user.email}
                  src={user.avatar_url}
                  size={40}
                  alt={displayName}
                />
                <div className="usercard-panel-user">
                  <div className="usercard-panel-name">{displayName}</div>
                  <div className="usercard-panel-email">{handle}</div>
                  {balanceVal !== undefined && (
                    <div className="usercard-panel-balance">
                      <span className="usercard-panel-balance-value">${balanceVal.toFixed(4)}</span>
                      {heldVal > 0 && (
                        <span className="usercard-panel-balance-held">· холд ${heldVal.toFixed(4)}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="usercard-panel-actions">
                <motion.button className="usercard-panel-action" onClick={handleProfile} whileHover={whileHoverListItem} whileTap={whileTapListItem} transition={springHover}>
                  <AppIcon name="user" size="sm" />
                  <span>Профиль</span>
                </motion.button>
                <motion.button className="usercard-panel-action" onClick={handleSettings} whileHover={whileHoverListItem} whileTap={whileTapListItem} transition={springHover}>
                  <AppIcon name="settings" size="sm" />
                  <span>Настройки</span>
                </motion.button>
                <div className="usercard-panel-divider" />
                <motion.button
                  className="usercard-panel-action usercard-panel-action--danger"
                  onClick={handleLogout}
                  whileHover={whileHoverListItem}
                  whileTap={whileTapListItem}
                  transition={springHover}
                >
                  <AppIcon name="power" size="sm" />
                  <span>Выйти</span>
                </motion.button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}

// Экспортируем для RailUserAvatar (Sidebar) — та же панель юзер-инфо в rail.
export function fmtCost(n: number): string {
  if (n < 0.01) return `${n.toFixed(4)}`
  return `${n.toFixed(2)}`
}

export function fmtReset(iso: string): string {
  return new Date(iso).toLocaleString('ru', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
