import type Store from 'electron-store'
import type { MainWindow } from '../windows/MainWindow'
import type { NotificationWindow } from '../windows/NotificationWindow'

/**
 * ActivityManager — компактный информер активности ИИ в overlay-окне уведомлений.
 *
 * Показывает виджет когда:
 *  1. Настройка activityMonitor.enabled = true (по умолчанию ВЫКЛЮЧЕНО)
 *  2. Главное окно неактивно ИЛИ свёрнуто ИЛИ скрыто
 *  3. Агент работает (run:status = 'running')
 *
 * Скрывает виджет через 3 сек после done/error/cancelled.
 * НЕ скрывает overlay-окно если есть активные карточки уведомлений.
 *
 * События форвардятся из chat.ipc.ts:
 *  - activity:run:status — старт/конец работы агента
 *  - activity:step — шаг тулов (tool_call/tool_result/thinking)
 *  - activity:tool_progress — прогресс долгих тулов
 */
export class ActivityManager {
  private hideTimer: NodeJS.Timeout | null = null
  private activeChats = new Set<string>()
  private listenersAttached = false
  /** Кэш enabled-флага. Обновляется при изменении settings. */
  private enabledCache: boolean | null = null

  constructor(
    private store: Store,
    private mainWindow: MainWindow,
    private notifWin: NotificationWindow,
  ) {}

  private getConfig(): { enabled: boolean } {
    if (this.enabledCache !== null) return { enabled: this.enabledCache }
    const raw = this.store.get('activityMonitor') as { enabled: boolean } | undefined
    this.enabledCache = raw?.enabled ?? false
    return { enabled: this.enabledCache }
  }

  /** Сбросить кэш (вызывается при изменении settings). */
  refreshConfig(): void {
    this.enabledCache = null
  }

  /**
   * Проверка: показывать ли activity-виджет.
   * Функция enabled + окно неактивно/свёрнуто/скрыто.
   */
  shouldShow(): boolean {
    if (!this.getConfig().enabled) return false
    const win = this.mainWindow.getWindow()
    if (!win) return false
    return !win.isFocused() || win.isMinimized() || !win.isVisible()
  }

  /**
   * Прикрепить listeners на главное окно. Вызывается ПОСЛЕ создания окна
   * (mainWindow.create()), т.к. в конструкторе окно ещё не создано.
   *
   * minimize/blur → показать виджет немедленно если есть активные чаты.
   * restore/focus → скрыть виджет немедленно (как dismissAll у уведомлений).
   */
  attachWindowListeners(): void {
    if (this.listenersAttached) return
    const win = this.mainWindow.getWindow()
    if (!win) return

    // Сворачивание → показать виджет сразу (не ждать следующий onStep)
    win.on('minimize', () => {
      if (this.activeChats.size > 0 && this.getConfig().enabled) {
        this.notifWin.show()
        // Не шлём running (сбросит stepsLog) — шлём show (visible=true без сброса)
        this.notifWin.send('activity:show', {})
      }
    })

    // Потеря фокуса → показать виджет если агент работает
    win.on('blur', () => {
      if (this.activeChats.size > 0 && this.getConfig().enabled) {
        this.notifWin.show()
        this.notifWin.send('activity:show', {})
      }
    })

    // Восстановление/фокус → скрыть виджет немедленно
    win.on('restore', () => this.hideImmediately())
    win.on('focus', () => this.hideImmediately())
    win.on('show', () => setTimeout(() => this.hideImmediately(), 100))

    this.listenersAttached = true
  }

  /**
   * Немедленно скрыть виджет (без auto-hide задержки).
   */
  private hideImmediately(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    this.notifWin.send('activity:hide', {})
  }

  /**
   * Гарантировать что overlay-окно видно если функция включена и
   * главное окно неактивно/свёрнуто. Вызывается из onStep/onToolProgress
   * чтобы окно появилось даже если пользователь свернул ПОСЛЕ старта запроса.
   *
   * Оптимизация: если окно уже видимо — не вызываем show() (каждый show()
   * дёргает setIgnoreMouseEvents → DWM toggle). showInactive() идемпотентен,
   * но setIgnoreMouseEvents на каждом шаге — лишняя нагрузка.
   */
  private ensureVisible(): void {
    if (!this.shouldShow()) return
    const win = this.notifWin.getWindow()
    if (win?.isVisible()) return  // уже видимо — не дёргаем DWM
    this.notifWin.show()
  }

  /**
   * Вызывается из chat.ipc.ts при emitRunStatus.
   */
  onRunStatus(data: {
    chatId: string
    status: 'running' | 'done' | 'error' | 'cancelled' | 'queued'
    msgId?: string
    error?: string
  }): void {
    if (!this.getConfig().enabled) return

    // Track activeChats ВСЕГДА (для minimize listener)
    if (data.status === 'running') {
      this.activeChats.add(data.chatId)
      if (this.hideTimer) {
        clearTimeout(this.hideTimer)
        this.hideTimer = null
      }
    }
    if (data.status === 'done' || data.status === 'error' || data.status === 'cancelled') {
      this.activeChats.delete(data.chatId)
    }

    // Шлём статус в renderer ВСЕГДА (обновляет status в store, но НЕ visible)
    this.notifWin.send('activity:run:status', data)

    // Показать окно + виджет ТОЛЬКО когда окно неактивно/свёрнуто
    if (this.shouldShow()) {
      if (data.status === 'running') {
        this.notifWin.show()
        // activity:show ставит visible=true (setRunning не ставит)
        this.notifWin.send('activity:show', {})
      }
    }

    // Auto-hide: если нет больше активных чатов — скрыть через 1.5 сек
    if (this.activeChats.size === 0 && (data.status === 'done' || data.status === 'error' || data.status === 'cancelled')) {
      if (this.hideTimer) clearTimeout(this.hideTimer)
      this.hideTimer = setTimeout(() => {
        this.notifWin.send('activity:hide', {})
        this.hideTimer = null
      }, 1500)
    }
  }

  /**
   * Шаг агента (tool_call/tool_result/thinking/text).
   * Если окно стало неактивным ПОСЛЕ старта запроса — покажет виджет.
   */
  onStep(data: {
    type: string
    toolName?: string
    toolArgs?: Record<string, unknown>
    content?: string
    success?: boolean
    msgId?: string
    callId?: string
    pendingCallId?: string
    chatId?: string
  }): void {
    if (!this.getConfig().enabled) return
    // Гарантировать что окно видно (покажет если пользователь свернул после старта)
    this.ensureVisible()
    if (!this.shouldShow()) return
    this.notifWin.send('activity:step', data)
  }

  /**
   * Прогресс долгих тулов (get_fast_context, run_command, process_attachments).
   */
  onToolProgress(data: {
    msgId: string
    chatId: string
    toolName: string
    stage: string
    detail?: string
    filesProcessed?: number
    filesTotal?: number
  }): void {
    if (!this.getConfig().enabled) return
    this.ensureVisible()
    if (!this.shouldShow()) return
    this.notifWin.send('activity:tool_progress', data)
  }
}

// ── Global singleton ──────────────────────────────────────────────────
let globalInstance: ActivityManager | null = null

export function initActivityManager(
  store: Store,
  mainWindow: MainWindow,
  notifWin: NotificationWindow,
): ActivityManager {
  globalInstance = new ActivityManager(store, mainWindow, notifWin)
  return globalInstance
}

export function getActivityManager(): ActivityManager | null {
  return globalInstance
}
