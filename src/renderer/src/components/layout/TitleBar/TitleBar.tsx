import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../../store/settings.store'
import { motion } from 'framer-motion'
import IconButton from '../../ui/IconButton/IconButton'
import Identicon from '../../ui/Identicon/Identicon'
import Logo from '../../ui/Logo/Logo'
import ChatTabs from './ChatTabs'
import { useTerminalStore } from '../../../store/terminal.store'
import { useAuthStore } from '../../../store/auth.store'
import { useBillingStore } from '../../../store/billing.store'
import { useMessengerStore } from '../../../store/messenger.store'
import { useDotsStore, pluralDots } from '../../../store/dots.store'
import { useUpdateStore, selectUpdateAvailable } from '../../../store/update.store'
import { springHover, whileHoverSm, whileTapSm } from '../../../utils/motionPresets'
import './TitleBar.css'

interface TitleBarProps {
  onSettingsClick?: () => void
  onAgentClick?: () => void
  onMemoryClick?: () => void
  onMessengerClick?: () => void
  onDotsClick?: () => void
  onProfileClick?: () => void
  onUpdateClick?: () => void
  currentChatId?: string | null
}

export default function TitleBar({ onSettingsClick, onAgentClick, onMemoryClick, onMessengerClick, onDotsClick, onProfileClick, onUpdateClick }: TitleBarProps) {
  const handleMinimize = () => window.syntee.window.minimize()
  const handleHide = () => window.syntee.window.hide()
  // Maximize/restore — кастомная шапка (frame: false), поэтому своя кнопка.
  // Начальное состояние — из main; дальше live-обновления событием (любой
  // путь: кнопка, даблклик по drag-зоне, Win+Up, aero-snap).
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    window.syntee.window.isMaximized().then(setMaximized).catch(() => {})
    const off = window.syntee.on('window:maximize-changed', (v: unknown) => setMaximized(!!v))
    return () => { off() }
  }, [])
  const handleMaximizeToggle = () => window.syntee.window.maximizeToggle()
  const dockOpen = useTerminalStore(s => s.dockOpen)
  const handleTerminalToggle = () => {
    useTerminalStore.getState().toggleDock()
  }
  const memoryEnabled = useSettingsStore(s => s.get<boolean>('memoryEnabled', true))
  const user = useAuthStore(s => s.user)
  const planUsage = useBillingStore(s => s.planUsage)
  const unreadTotal = useMessengerStore(s => s.conversations.reduce((n, c) => n + (c.unread_count || 0), 0))
  const updateAvailable = useUpdateStore(selectUpdateAvailable)
  const updateVersion = useUpdateStore(s => s.available?.version)
  // Dots: сколько Dot'ов выполняют wake-ран прямо сейчас — бейдж у кнопки Dots.
  // Селектор возвращает число → ре-рендер только при изменении счётчика.
  // Стор глобально инициализирован в App.tsx (страница Dots может быть закрыта).
  const runningDots = useDotsStore(s => s.dots.reduce((n, d) => n + (d.state?.status === 'running' ? 1 : 0), 0))
  // Индикатор дневного лимита — кольцевой прогресс вокруг аватара.
  const dailyLimitTotal = planUsage?.plan?.daily_token_limit ?? 0
  const dailyLimitPct = planUsage && dailyLimitTotal > 0
    ? Math.min(100, (planUsage.usage.today_tokens / dailyLimitTotal) * 100)
    : null
  const limitCritical = dailyLimitPct !== null && dailyLimitPct >= 90
  const limitWarning = dailyLimitPct !== null && dailyLimitPct >= 70 && dailyLimitPct < 90

  return (
    <div className="titlebar drag-region">
      <div className="titlebar-left drag-region">
        <div className="titlebar-logo no-drag">
          <Logo size={22} />
        </div>
        <span className="titlebar-title">Syntee</span>
      </div>

      {/* Единая полоса вкладок: чаты и файлы в одном ряду, одинаковый стиль.
          drag-region на wrap в ChatTabs.tsx — пустое место перетаскивает окно. */}
      <ChatTabs />

      <div className="titlebar-right no-drag">
        {onDotsClick && (
          <div className="titlebar-dots-wrap">
            <IconButton icon="orbit" label="Dots" onClick={onDotsClick} />
            {runningDots > 0 && (
              <span
                className="titlebar-dots-badge"
                title={`${pluralDots(runningDots)} ${runningDots === 1 ? 'работает' : 'работают'} сейчас`}
              >
                {runningDots}
              </span>
            )}
          </div>
        )}
        {onMemoryClick && (
          <span className={`titlebar-memory-btn ${memoryEnabled ? '' : 'titlebar-memory-btn--disabled'}`} title={memoryEnabled ? 'Память' : 'Память Syntee выключена'}>
            <IconButton icon="brain" label={memoryEnabled ? 'Память' : 'Память Syntee выключена'} onClick={onMemoryClick} />
            {!memoryEnabled && <span className="titlebar-memory-slash" aria-hidden="true" />}
          </span>
        )}
        {onMessengerClick && user && (
          <div className="titlebar-messenger-wrap">
            <IconButton
              icon="messageSquare"
              label="Мессенджер"
              onClick={onMessengerClick}
            />
            {unreadTotal > 0 && (
              <span className="titlebar-messenger-badge" title={`${unreadTotal} непрочитанных`}>
                {unreadTotal > 99 ? '99+' : unreadTotal}
              </span>
            )}
          </div>
        )}
        <IconButton
          icon="terminal"
          label="Терминал"
          active={dockOpen}
          onClick={handleTerminalToggle}
        />
        {updateAvailable && onUpdateClick && (
          <div className="titlebar-update-wrap" title={`Доступно обновление ${updateVersion ? `v${updateVersion}` : ''}`}>
            <IconButton
              icon="downloadCloud"
              label="Обновление"
              onClick={onUpdateClick}
              className="titlebar-update-btn"
            />
            <span className="titlebar-update-badge" />
          </div>
        )}
        {onAgentClick && <IconButton icon="panelRight" label="Панель" onClick={onAgentClick} />}
        {onSettingsClick && <IconButton icon="settings" label="Настройки" onClick={onSettingsClick} />}
        {user && onProfileClick && (
          <motion.button
            type="button"
            className={`titlebar-avatar-btn ${limitCritical ? 'titlebar-avatar-btn--critical' : limitWarning ? 'titlebar-avatar-btn--warning' : ''}`}
            onClick={onProfileClick}
            title={
              dailyLimitPct !== null
                ? `${user.display_name || user.email} · дневной лимит: ${Math.round(dailyLimitPct)}%`
                : user.display_name || user.email
            }
            aria-label="Профиль"
            whileHover={whileHoverSm}
            whileTap={whileTapSm}
            transition={springHover}
          >
            <Identicon
              seed={user.id || user.email}
              src={user.avatar_url}
              size={26}
              alt={user.display_name || user.email}
            />
            {dailyLimitPct !== null && (
              <span
                className={`titlebar-limit-ring ${limitCritical ? 'titlebar-limit-ring--critical' : limitWarning ? 'titlebar-limit-ring--warning' : ''}`}
                style={{
                  background: `conic-gradient(currentColor ${dailyLimitPct * 3.6}deg, transparent 0deg)`,
                }}
              />
            )}
          </motion.button>
        )}
        <div className="titlebar-controls-divider" />
        <IconButton icon="minus" label="Свернуть" onClick={handleMinimize} />
        <IconButton
          icon={maximized ? 'restore' : 'maximize'}
          label={maximized ? 'Восстановить' : 'Развернуть'}
          onClick={handleMaximizeToggle}
        />
        <IconButton icon="x" label="В трей" onClick={handleHide} danger className="titlebar-btn titlebar-btn--close" />
      </div>
    </div>
  )
}
