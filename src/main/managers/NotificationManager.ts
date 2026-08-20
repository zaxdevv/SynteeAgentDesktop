import type Store from 'electron-store'
import type { MainWindow } from '../windows/MainWindow'
import type { NotificationWindow } from '../windows/NotificationWindow'
import { pushNotification } from '../ipc/notification.ipc'
import { resolveConfirm, resolveQuestion } from '../ipc/chatShared'
import type { NotificationPayload, NotificationType, NotificationPriority } from '../../shared/types'

interface NotificationTypeConfig {
  enabled: boolean
  showWhen: 'inactive' | 'always' | 'minimized'
}

interface NotificationsConfig {
  enabled: boolean
  types: Record<NotificationType, NotificationTypeConfig>
}

const DEFAULT_DURATION: Record<NotificationPriority, number> = {
  info: 6000,
  success: 6000,
  warning: 10000,
  urgent: 0, // без авто-закрытия (до клика)
}

let notificationCounter = 0

/**
 * NotificationManager — централизованный менеджер уведомлений.
 *
 * Решает показывать ли уведомление на основе:
 *  1. Глобального флага notifications.enabled
 *  2. Per-type конфига (enabled + showWhen)
 *  3. Состояния главного окна (активно/свёрнуто/неактивно)
 *
 * Если решение положительное — показывает overlay-окно и отправляет
 * NOTIFICATION_PUSH event в renderer.
 *
 * Дебаунс: если 5+ уведомлений за 2 сек — показывает только первое
 * + "ещё N уведомлений".
 */
export class NotificationManager {
  private recentTimestamps: number[] = []
  private listenersAttached = false

  constructor(
    private store: Store,
    private mainWindow: MainWindow,
    private notificationWindow: NotificationWindow,
  ) {}

  /**
   * Прикрепить listeners на главное окно. Вызывается ПОСЛЕ создания окна
   * (mainWindow.create()), т.к. в конструкторе окно ещё не создано.
   */
  attachWindowListeners(): void {
    if (this.listenersAttached) return
    const win = this.mainWindow.getWindow()
    if (!win) return

    win.on('focus', () => this.dismissAll())
    win.on('restore', () => this.dismissAll())
    win.on('show', () => {
      setTimeout(() => this.dismissAll(), 100)
    })
    this.listenersAttached = true
  }

  /**
   * Скрыть все уведомления (с анимацией в renderer).
   * Вызывается когда главное окно становится активным.
   */
  dismissAll(): void {
    // Не закрываем если есть pending permission/ask_user уведомления —
    // они требуют ответа и не должны исчезать при фокусе главного окна.
    // (showWhen: 'always' означает они показываются даже когда окно активно)
    this.notificationWindow.send('notification:dismissAll', {})
  }

  /**
   * Главная точка входа. Вызывается из event sources (chat.ipc, messenger, и т.д.)
   */
  push(payload: Omit<NotificationPayload, 'id'> & { id?: string }): void {
    const config = this.getConfig()
    if (!config.enabled) return

    const typeConfig = config.types[payload.type]
    if (!typeConfig?.enabled) return

    // Проверка состояния окна
    if (!this.shouldShow(typeConfig.showWhen)) return

    // Дебаунс/агрегация
    const now = Date.now()
    this.recentTimestamps = this.recentTimestamps.filter(ts => now - ts < 2000)
    this.recentTimestamps.push(now)

    if (this.recentTimestamps.length > 5) {
      // Спам — показываем агрегированное
      const count = this.recentTimestamps.length - 1
      pushNotification(this.notificationWindow, {
        id: `notif-${++notificationCounter}`,
        type: payload.type,
        title: payload.title,
        body: `Ещё ${count} уведомлений…`,
        priority: 'info',
        actions: [{ id: 'open', label: 'Открыть' }],
        duration: 6000,
      })
      return
    }

    const id = payload.id ?? `notif-${++notificationCounter}`
    const duration = payload.duration ?? DEFAULT_DURATION[payload.priority]

    pushNotification(this.notificationWindow, {
      ...payload,
      id,
      duration,
    })
  }

  /**
   * Обработка action клика по уведомлению (из notification.ipc.ts).
   */
  handleAction(payload: { id: string; actionId: string; type: string; chatId?: string; reqId?: string }): void {
    switch (payload.type) {
      case 'ai_response':
      case 'agent_done':
        this.mainWindow.show()
        if (payload.chatId) {
          const win = this.mainWindow.getWindow()
          win?.webContents.send('nav:openChat', payload.chatId)
        }
        break
      case 'permission': {
        const approved = payload.actionId === 'approve'
        if (payload.reqId) {
          resolveConfirm(payload.reqId, approved)
          // Закрыть диалог в главном окне — рендерер не знает что разрешение
          // уже обработано через notification overlay.
          this.mainWindow.getWindow()?.webContents.send('agent:confirm:dismiss', payload.reqId)
        }
        this.notificationWindow.send('notification:dismissAll', {})
        break
      }
      case 'ask_user': {
        // Только "Открыть" — разворачиваем приложение, ответ в самом UI
        this.mainWindow.show()
        this.notificationWindow.send('notification:dismissAll', {})
        break
      }
      case 'messenger':
        this.mainWindow.show()
        this.mainWindow.getWindow()?.webContents.send('nav:openMessenger', {})
        break
      case 'updates':
        this.mainWindow.show()
        this.mainWindow.getWindow()?.webContents.send('nav:openSettings', 'updates')
        break
      case 'system':
        this.mainWindow.show()
        break
    }
  }

  private shouldShow(showWhen: NotificationTypeConfig['showWhen']): boolean {
    const win = this.mainWindow.getWindow()
    if (!win) return true // нет окна — показываем

    const isVisible = win.isVisible()
    const isFocused = win.isFocused()
    const isMinimized = win.isMinimized()

    switch (showWhen) {
      case 'always':
        return true
      case 'minimized':
        return isMinimized || !isVisible
      case 'inactive':
        return !isFocused || isMinimized || !isVisible
      default:
        return true
    }
  }

  private getConfig(): NotificationsConfig {
    const raw = this.store.get('notifications') as NotificationsConfig | undefined
    // Дефолты для каждого типа — если в сохранённых настройках нет какого-то
    // типа (добавлен позже), он получает дефолтное значение.
    const DEFAULT_TYPES: Record<NotificationType, NotificationTypeConfig> = {
      ai_response: { enabled: true, showWhen: 'inactive' },
      agent_done: { enabled: true, showWhen: 'inactive' },
      permission: { enabled: true, showWhen: 'always' },
      ask_user: { enabled: true, showWhen: 'always' },
      messenger: { enabled: true, showWhen: 'always' },
      updates: { enabled: true, showWhen: 'always' },
      system: { enabled: true, showWhen: 'inactive' },
    }
    if (!raw || typeof raw !== 'object') {
      return { enabled: true, types: DEFAULT_TYPES }
    }
    // Мержим: для каждого типа берём сохранённое значение или дефолт
    const merged: Record<NotificationType, NotificationTypeConfig> = { ...DEFAULT_TYPES }
    for (const key of Object.keys(DEFAULT_TYPES) as NotificationType[]) {
      if (raw.types?.[key]) {
        merged[key] = raw.types[key] as NotificationTypeConfig
      }
    }
    return { enabled: raw.enabled ?? true, types: merged }
  }
}

// ── Global singleton ──────────────────────────────────────────────────
// Паттерн как agentManager: глобальный инстанс, инициализируется в
// main/index.ts через init(). Доступ из других модулей (chat.ipc, и т.д.)
// через getNotificationManager().

let globalInstance: NotificationManager | null = null

export function initNotificationManager(
  store: Store,
  mainWindow: MainWindow,
  notificationWindow: NotificationWindow,
): NotificationManager {
  globalInstance = new NotificationManager(store, mainWindow, notificationWindow)
  return globalInstance
}

export function getNotificationManager(): NotificationManager | null {
  return globalInstance
}
