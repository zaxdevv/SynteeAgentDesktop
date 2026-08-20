import { BrowserWindow, screen, desktopCapturer } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/**
 * NotificationWindow — fullscreen transparent click-through overlay-окно
 * для показа уведомлений поверх всех окон.
 *
 * Click-through: hit-testing в MAIN процессе через polling
 * screen.getCursorScreenPoint() каждые 100ms. Renderer отправляет bounds
 * карточек через IPC, main процесс проверяет позицию курсора и toggling
 * setIgnoreMouseEvents.
 *
 * forward:true используется ТОЛЬКО когда окно видимо (есть уведомления) —
 * это нужно чтобы mouseenter/mouseleave на карточках работали. Когда окно
 * скрыто — forward:true НЕ используется, т.к. на скрытом окне он заставляет
 * DWM делать hit-testing на каждое движение мыши → лаг курсора по всей системе.
 * Окно создаётся лениво (не при старте), поэтому в простое forward:true нет.
 */
export class NotificationWindow {
  private win: BrowserWindow | null = null
  private ready = false
  private trackingTimer: NodeJS.Timeout | null = null
  /** Bounds карточек в экранных координатах (для hit-testing) */
  private cardBounds: Array<{ x: number; y: number; w: number; h: number }> = []
  private currentIgnore = true

  create(): BrowserWindow {
    if (this.win) return this.win
    const { x, y, width, height } = this.getTotalBounds()

    this.win = new BrowserWindow({
      x, y, width, height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: true, // focusable:true — иначе Windows НЕ отдаёт mouse events окну
      // showInactive() используется вместо show() чтобы не красть фокус
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // БЕЗ forward:true — forward:true заставляет DWM делать hit-testing на
    // КАЖДОЕ движение курсора, даже когда окно скрыто. Это лагает курсор по всей
    // системе. Polling (100ms) — единственный механизм hit-testing теперь.
    this.win.setIgnoreMouseEvents(true)

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/notifications')
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/notifications' })
    }

    this.win.webContents.once('did-finish-load', () => {
      this.ready = true
    })

    return this.win
  }

  warmup(): void {
    if (!this.win) this.create()
  }

  private getTotalBounds() {
    const displays = screen.getAllDisplays()
    const minX = Math.min(...displays.map(d => d.bounds.x))
    const minY = Math.min(...displays.map(d => d.bounds.y))
    const maxX = Math.max(...displays.map(d => d.bounds.x + d.bounds.width))
    const maxY = Math.max(...displays.map(d => d.bounds.y + d.bounds.height))
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }

  show(): void {
    if (!this.win) this.create()
    if (!this.win) return
    this.win.showInactive()
    // forward:true на прозрачном окне НЕ лагает DWM — он проверяет альфа-канал,
    // видит #00000000 и пропускает за O(1). forward нужен чтобы mousemove
    // проходили сквозь окно → mouseenter/mouseleave на карточках работали.
    this.win.setIgnoreMouseEvents(true, { forward: true })
  }

  hide(): void {
    if (!this.win) return
    this.win.hide()
    this.stopTracking()
  }

  isReady(): boolean {
    return this.ready
  }

  setIgnoreMouseEvents(ignore: boolean): void {
    if (!this.win) return
    // forward:true когда ignore=true — нужен чтобы mouseenter/mouseleave на
    // карточках работали (renderer получает mouse-move events сквозь окно).
    // На прозрачном окне forward НЕ лагает DWM (альфа=0 → hit-test O(1)).
    if (ignore) {
      this.win.setIgnoreMouseEvents(true, { forward: true })
    } else {
      this.win.setIgnoreMouseEvents(false)
    }
  }

  send(channel: string, data: unknown): void {
    if (!this.win) return
    this.win.webContents.send(channel, data)
  }

  getWindow(): BrowserWindow | null {
    return this.win
  }

  // ── Click-through hit-testing в main процессе ──────────────────────
  // Renderer отправляет bounds карточек, main процесс polling-ом
  // проверяет позицию курсора и toggling setIgnoreMouseEvents напрямую
  // (без IPC round-trip latency).

  updateCardBounds(bounds: Array<{ x: number; y: number; w: number; h: number }>): void {
    this.cardBounds = bounds
  }

  startTracking(): void {
    if (this.trackingTimer) return
    // 100ms вместо 16ms — в 6× меньше нагрузки на DWM (setIgnoreMouseEvents
    // toggling). 10 проверок/сек достаточно для hit-testing на hover —
    // визуально незаметно. Раньше 60 toggles/сек лагали курсор по всей системе.
    this.trackingTimer = setInterval(() => this.checkCursor(), 100)
  }

  stopTracking(): void {
    if (this.trackingTimer) {
      clearInterval(this.trackingTimer)
      this.trackingTimer = null
    }
    this.cardBounds = []
    // Сброс в click-through БЕЗ forward:true — окно скоро скроется,
    // forward на скрытом окне лагает DWM (курсор по всей системе).
    // Вызываем this.win.setIgnoreMouseEvents напрямую, минуя this.setIgnoreMouseEvents
    // (который ставит forward:true).
    this.currentIgnore = true
    if (this.win) this.win.setIgnoreMouseEvents(true)
  }

  private checkCursor(): void {
    if (!this.win || this.cardBounds.length === 0) {
      if (!this.currentIgnore) {
        this.currentIgnore = true
        this.setIgnoreMouseEvents(true)
      }
      return
    }

    // getCursorScreenPoint() — АБСОЛЮТНЫЕ экранные координаты (DIP).
    // cardBounds — координаты ОТНОСИТЕЛЬНО окна (getBoundingClientRect в renderer).
    // Нужно добавить позицию окна чтобы сравнить с курсором.
    const winBounds = this.win.getBounds()
    const cursor = screen.getCursorScreenPoint()

    const overCard = this.cardBounds.some(b =>
      cursor.x >= b.x + winBounds.x &&
      cursor.x <= b.x + winBounds.x + b.w &&
      cursor.y >= b.y + winBounds.y &&
      cursor.y <= b.y + winBounds.y + b.h
    )

    const shouldIgnore = !overCard
    if (shouldIgnore !== this.currentIgnore) {
      this.currentIgnore = shouldIgnore
      this.setIgnoreMouseEvents(shouldIgnore)
    }
  }

  /**
   * Захватить экран и вернуть base64 для блюра фона карточки.
   * Captures the primary display and returns base64 thumbnail.
   */
  async captureScreen(): Promise<string | null> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 640, height: 360 },
      })
      if (sources.length === 0) return null
      return sources[0].thumbnail.toDataURL()
    } catch {
      return null
    }
  }
}
