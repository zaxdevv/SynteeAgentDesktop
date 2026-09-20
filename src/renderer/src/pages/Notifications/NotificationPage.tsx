import { useEffect, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useNotificationStore } from '../../store/notification.store'
import { useActivityStore } from '../../store/activity.store'
import { useSettingsStore } from '../../store/settings.store'
import { applyAccentToDOM, applyGlassToDOM } from '../../App'
import { useOverlayHitTesting } from '../../hooks/useOverlayHitTesting'
import NotificationCard from './NotificationCard'
import ActivityWidget from './ActivityWidget'
import './NotificationPage.css'

export default function NotificationPage() {
  const { notifications, add, dismissAll } = useNotificationStore()
  const activityVisible = useActivityStore(s => s.visible)
  const settings = useSettingsStore()
  const [screenImg, setScreenImg] = useState<string | null>(null)

  // ── Click-through hit-testing (renderer) ──────────────────────────────
  // Мышь: окно всегда click-through (forward:true) — mousemove проходят
  // сквозь и приходят сюда. elementFromPoint решает над чем курсор;
  // overlay:setInteractive уходит в main ТОЛЬКО на смену состояния.
  // Никакого polling-а bounds/курсора — карточки помечены data-interactive.
  useOverlayHitTesting()

  // Загружаем настройки (overlay окно — отдельный JS context)
  useEffect(() => {
    if (!settings.loaded) {
      settings.load()
    }
  }, [settings])

  // Применяем тему/accent для overlay-окна
  useEffect(() => {
    if (!settings.loaded || !settings.settings) return
    const s = settings.settings
    const accent = (s['accentColor'] as string) || '#ffffff'
    applyAccentToDOM(accent)
    const glassBlur = s['glassBlur'] as number
    if (typeof glassBlur === 'number') applyGlassToDOM(glassBlur)
  }, [settings.loaded, settings.settings])

  // Подписка на входящие уведомления
  useEffect(() => {
    const off = window.syntee.notification.onPush((payload) => {
      add(payload)
    })
    return () => { off() }
  }, [add])

  // Dismiss all когда главное окно становится активным
  useEffect(() => {
    const off = window.syntee.notification.onDismissAll(() => {
      dismissAll()
    })
    return () => { off() }
  }, [dismissAll])

  // Скрыть overlay-хаб когда контент опустел (карточки ушли с exit-анимацией).
  // Задержка 200ms — чтобы exit-анимация успела отыграть.
  useEffect(() => {
    const hasContent = notifications.length > 0 || activityVisible
    if (!hasContent) {
      const hideTimer = setTimeout(() => {
        window.syntee.notification.hide()
      }, 200)
      return () => clearTimeout(hideTimer)
    }
    return undefined
  }, [notifications.length, activityVisible])

  // Захват экрана для блюра — ТОЛЬКО для карточек уведомлений.
  // Activity-виджет использует CSS backdrop-filter (без desktopCapturer)
  // чтобы избежать DXGI warnings и лага при появлении.
  const hasNotifications = notifications.length > 0
  useEffect(() => {
    if (!hasNotifications) return undefined
    let cancelled = false
    window.syntee.notification.captureScreen().then((img) => {
      if (!cancelled && img) setScreenImg(img)
    })
    return () => { cancelled = true }
  }, [hasNotifications])

  useEffect(() => {
    if (!hasNotifications) {
      const r = requestAnimationFrame(() => setScreenImg(null))
      return () => cancelAnimationFrame(r)
    }
    return undefined
  }, [hasNotifications])

  return (
    <div className="notif-root">
      <div className="notif-stack">
        {/* Activity widget — ПЕРВЫМ в стеке, по центру сверху.
            Показывается сразу при старте запроса когда окно неактивно/свёрнуто.
            Адаптируется к стеку: если есть уведомления — они ниже.
            AnimatePresence внутри самого ActivityWidget — управляет exit-анимацией. */}
        <ActivityWidget />
        <AnimatePresence mode="popLayout">
          {notifications.map((item, index) => (
            <div key={item.id} className="notif-card-wrapper">
              <NotificationCard item={item} index={index} screenImg={screenImg} />
            </div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
