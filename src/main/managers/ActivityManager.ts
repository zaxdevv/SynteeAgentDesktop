import type Store from 'electron-store'
import type { MainWindow } from '../windows/MainWindow'
import type { OverlayManager } from '../overlay/OverlayManager'

/**
 * ActivityManager — компактный информер активности ИИ в overlay-хабе.
 *
 * Показывает виджет когда:
 *  1. Настройка activityMonitor.enabled = true (по умолчанию ВЫКЛЮЧЕНО)
 *  2. Главное окно неактивно ИЛИ свёрнуто ИЛИ скрыто
 *  3. Агент работает (run:status = 'running')
 *
 * ВАЖНО: activeChats и статус агента трекаются/форвардятся в renderer
 * ВСЕГДА — независимо от enabled. Иначе включение настройки посреди
 * прогона не работает (activeChats пуст, renderer не знает про running).
 * enabled гейтит только ПОКАЗ виджета.
 *
 * Скрывает виджет через 1.5 сек после done/error/cancelled.
 * НЕ скрывает overlay-хаб если есть активные карточки уведомлений.
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
    private overlay: OverlayManager,
  ) {}

  private getConfig(): { enabled: boolean } {
    if (this.enabledCache !== null) return { enabled: this.enabledCache }
    const raw = this.store.get('activityMonitor') as { enabled: boolean } | undefined
    this.enabledCache = raw?.enabled ?? false
    return { enabled: this.enabledCache }
  }

  /** Сбросить кэш (вызывается при изменении settings). Реактивный:
   *  выключили — немедленно скрыть виджет; включили посреди прогона при
   *  свёрнутом/неактивном окне — показать сразу, не ждать следующий шаг. */
  refreshConfig(): void {
    this.enabledCache = null
    if (!this.getConfig().enabled) {
      this.hideImmediately()
    } else if (this.activeChats.size > 0 && this.shouldShow()) {
      this.overlay.showHub()
      this.overlay.sendHub('activity:show', {})
    }
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
        this.overlay.showHub()
        // Не шлём running (сбросит stepsLog) — шлём show (visible=true без сброса)
        this.overlay.sendHub('activity:show', {})
      }
    })

    // Потеря фокуса → показать виджет если агент работает
    win.on('blur', () => {
      if (this.activeChats.size > 0 && this.getConfig().enabled) {
        this.overlay.showHub()
        this.overlay.sendHub('activity:show', {})
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
    this.overlay.sendHub('activity:hide', {})
  }

  /**
   * Гарантировать что overlay-хаб виден если функция включена и
   * главное окно неактивно/свёрнуто. Вызывается из onStep/onToolProgress
   * чтобы окно появилось даже если пользователь свернул ПОСЛЕ старта запроса.
   *
   * Оптимизация: если окно уже видимо — не вызываем showHub() (каждый show()
   * дёргает setIgnoreMouseEvents → DWM toggle). showInactive() идемпотентен,
   * но setIgnoreMouseEvents на каждом шаге — лишняя нагрузка.
   */
  private ensureVisible(): void {
    if (!this.shouldShow()) return
    const win = this.overlay.getHubWindow()
    if (!win?.isVisible()) {
      this.overlay.showHub()
    }
    // Показываем и виджет (не только окно): иначе окно видно, но контент
    // пуст → NotificationPage скроет окно через 200ms. showWidget() в
    // renderer идемпотентен (visible = status === 'running') — повторные
    // activity:show безвредны.
    this.overlay.sendHub('activity:show', {})
  }

  /**
   * Вызывается из chat.ipc.ts при emitRunStatus.
   */
  onRunStatus(data: {
    chatId: string
    status: 'running' | 'done' | 'error' | 'cancelled' | 'queued' | 'compacting'
    msgId?: string
    error?: string
  }): void {
    // Track activeChats ВСЕГДА — ДО enabled-gate. Иначе включение настройки
    // посреди прогона оставляет activeChats пустым → minimize/blur listeners
    // молчат (activeChats.size === 0) и виджет никогда не появляется.
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

    // Статус — в renderer ВСЕГДА (дёшево: обновляет store, visible не трогает).
    // Если настройку включили посреди прогона — renderer уже знает что агент
    // работает, и activity:show сразу покажет виджет.
    this.overlay.sendHub('activity:run:status', data)

    if (!this.getConfig().enabled) return

    // Показать окно + виджет ТОЛЬКО когда окно неактивно/свёрнуто
    if (this.shouldShow() && data.status === 'running') {
      this.overlay.showHub()
      // activity:show ставит visible=true (setRunning не ставит)
      this.overlay.sendHub('activity:show', {})
    }

    // Auto-hide: если нет больше активных чатов — скрыть через 1.5 сек
    if (this.activeChats.size === 0 && (data.status === 'done' || data.status === 'error' || data.status === 'cancelled')) {
      if (this.hideTimer) clearTimeout(this.hideTimer)
      this.hideTimer = setTimeout(() => {
        this.overlay.sendHub('activity:hide', {})
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
    this.overlay.sendHub('activity:step', data)
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
    this.overlay.sendHub('activity:tool_progress', data)
  }
}

// ── Global singleton ──────────────────────────────────────────────────
let globalInstance: ActivityManager | null = null

export function initActivityManager(
  store: Store,
  mainWindow: MainWindow,
  overlay: OverlayManager,
): ActivityManager {
  globalInstance = new ActivityManager(store, mainWindow, overlay)
  return globalInstance
}

export function getActivityManager(): ActivityManager | null {
  return globalInstance
}
