import { BrowserWindow, screen } from 'electron'
import type { NotificationWindow } from '../windows/NotificationWindow'

/** Идентификаторы overlay-поверхностей (реестр + координация). */
export type OverlaySurfaceId =
  | 'notifications'
  | 'activity'
  | 'plugin'
  | 'capture'
  | 'spotlight'
  | 'tray-menu'

/** Параметры plugin overlay (валидация entry/pluginDir остаётся в pluginManager). */
export interface PluginOverlayParams {
  pluginId: string
  entry: string
  data?: unknown
  width?: number
  height?: number
  timeoutMs?: number
}

/** Внешнее overlay-окно (не принадлежит менеджеру, но участвует в hideAll). */
export interface ExternalOverlay {
  hide: () => void
}

/**
 * OverlayManager — единая точка управления всеми overlay-поверхностями.
 *
 * Владеет:
 *  1. Hub-окном (NotificationWindow) — fullscreen transparent click-through
 *     окно, в котором живут уведомления + activity-виджет. Любой показ/скрытие
 *     хаба идёт через менеджера (showHub/hideHub/sendHub).
 *  2. Plugin overlay окном (HTML плагина через syntee-plugin://) — раньше
 *     создавалось напрямую в pluginManager сырым BrowserWindow.
 *  3. Реестром внешних overlay-окон (spotlight, trayMenu, capture) для
 *     координированного скрытия (hideAll).
 *
 * Мышь — единая политика:
 *   setIgnoreMouseEvents(true, {forward:true}) пропускает клики сквозь окно,
 *   но mousemove продолжают приходить в renderer. Renderer на каждый mousemove
 *   (троттлинг rAF) проверяет document.elementFromPoint и шлёт
 *   overlay:setInteractive ТОЛЬКО на смену состояния. Менеджер дедуплицирует
 *   и переключает режим. Никакого polling-а курсора в main процессе:
 *   задержка клика = 1 IPC round-trip (~1-5ms), ноль таймеров.
 */
export class OverlayManager {
  private hub: NotificationWindow
  private pluginWin: BrowserWindow | null = null
  private pluginTimer: NodeJS.Timeout | null = null
  private externals = new Map<OverlaySurfaceId, ExternalOverlay>()
  private interactive = false

  constructor(hub: NotificationWindow) {
    this.hub = hub
  }

  // ── Hub (уведомления + activity-виджет) ─────────────────────────────

  showHub(): void {
    this.hub.show()
  }

  hideHub(): void {
    this.hub.hide()
  }

  warmupHub(): void {
    this.hub.warmup()
  }

  sendHub(channel: string, data: unknown): void {
    this.hub.send(channel, data)
  }

  getHubWindow(): BrowserWindow | null {
    return this.hub.getWindow()
  }

  captureHubScreen(): Promise<string | null> {
    return this.hub.captureScreen()
  }

  // ── Мышь: единая политика click-through ─────────────────────────────

  /**
   * Переключить режим мыши hub-окна.
   *  true  — окно ловит события (курсор над data-interactive элементом)
   *  false — click-through + forward (mousemove идут в renderer для hit-test'а)
   * Дедупликация: повторный вызов с тем же значением — no-op.
   */
  setInteractive(v: boolean): void {
    if (v === this.interactive) return
    this.interactive = v
    this.hub.setIgnoreMouseEvents(!v)
  }

  // ── Plugin overlay ──────────────────────────────────────────────────

  /** Показать overlay-окно с HTML плагина (syntee-plugin://).
   *  Предыдущее окно уничтожается (одно plugin overlay на приложение). */
  showPluginOverlay(params: PluginOverlayParams): void {
    this.hidePluginOverlay()
    const width = Math.min(Math.max(160, Number(params.width) || 360), 1200)
    const height = Math.min(Math.max(120, Number(params.height) || 240), 900)
    const work = screen.getPrimaryDisplay().workArea
    const win = new BrowserWindow({
      x: work.x + work.width - width - 16,
      y: work.y + work.height - height - 16,
      width,
      height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    // data → query-параметр (страница плагина читает location.search).
    let url = `syntee-plugin://${params.pluginId}/${params.entry.replace(/^\/+/, '')}`
    if (params.data !== undefined) {
      url += `?data=${encodeURIComponent(JSON.stringify(params.data))}`
    }
    win.loadURL(url).catch(e => {
      console.warn(`[overlay] plugin overlay loadURL failed: ${(e as Error).message}`)
    })
    win.once('ready-to-show', () => win.show())
    // Клик мимо окна / потеря фокуса — скрыть (как уведомление).
    win.on('blur', () => this.hidePluginOverlay())
    this.pluginWin = win

    const timeoutMs = Number(params.timeoutMs) || 0
    if (timeoutMs > 0) {
      this.pluginTimer = setTimeout(() => this.hidePluginOverlay(), Math.min(timeoutMs, 600_000))
    }
  }

  /** Скрыть/уничтожить overlay-окно плагина. */
  hidePluginOverlay(): void {
    if (this.pluginTimer) {
      clearTimeout(this.pluginTimer)
      this.pluginTimer = null
    }
    if (this.pluginWin) {
      const w = this.pluginWin
      this.pluginWin = null
      try { w.destroy() } catch { /* ignore */ }
    }
  }

  // ── Внешние окна + координация ──────────────────────────────────────

  /** Зарегистрировать внешнее overlay-окно (участвует в hideAll). */
  registerExternal(id: OverlaySurfaceId, w: ExternalOverlay): void {
    this.externals.set(id, w)
  }

  unregisterExternal(id: OverlaySurfaceId): void {
    this.externals.delete(id)
  }

  /**
   * Скрыть ВСЕ overlay-поверхности разом: dismiss уведомлений (с exit-анимацией),
   * скрыть activity-виджет, уничтожить plugin overlay, скрыть внешние окна.
   * Само hub-окно скрывается renderer'ом когда контент опустеет —
   * так сохраняются exit-анимации карточек.
   */
  hideAll(): void {
    this.setInteractive(false)
    this.hub.send('notification:dismissAll', {})
    this.hub.send('activity:hide', {})
    this.hidePluginOverlay()
    for (const w of this.externals.values()) {
      try { w.hide() } catch { /* ignore */ }
    }
  }
}

// ── Global singleton ──────────────────────────────────────────────────
// Паттерн как NotificationManager/ActivityManager: глобальный инстанс,
// инициализируется в main/index.ts. Доступ из других main-модулей через
// getOverlayManager().

let globalInstance: OverlayManager | null = null

export function initOverlayManager(hub: NotificationWindow): OverlayManager {
  globalInstance = new OverlayManager(hub)
  return globalInstance
}

export function getOverlayManager(): OverlayManager | null {
  return globalInstance
}
