import { BrowserWindow, screen, type Rectangle } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { WINDOW_SIZES } from '../../shared/constants'
import { getPluginManager } from '../../core/plugins/pluginManager'

/**
 * Кастомное трей-меню — frameless transparent alwaysOnTop окно,
 * всплывающее у иконки трея по правому клику. Заменяет нативное
 * Win32 контекстное меню (которое нельзя стилизовать под клиент).
 *
 * Внутри рендерится легковесный TrayMenuApp (не полный App), чтобы
 * не плодить дубликаты WS-messenger / gateway-polling.
 *
 * URL грузится в create() (как Spotlight/Voice/Overlay). Это безопасно:
 * IPC-хендлеры регистрируются ДО .create() в index.ts.
 *
 * Позиционирование: карточка появляется у иконки трея с клампом в workArea.
 */
export class TrayMenuWindow {
  private win: BrowserWindow | null = null
  private isVisible = false

  create(): BrowserWindow {
    if (this.win) return this.win // idempotent — lazy creation
    const { width: ww, height: wh } = WINDOW_SIZES.trayMenu
    this.win = new BrowserWindow({
      width: ww,
      height: wh,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      focusable: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    this.win.setAlwaysOnTop(true, 'pop-up-menu')

    // Закрыть при потере фокуса (привычное меню-поведение).
    this.win.on('blur', () => this.hide())

    // Окно уничтожено (app.exit при выходе из трея и т.п.) — обнуляем
    // ссылку, иначе все методы будут кидать "Object has been destroyed",
    // а lazy-create в show() не сработает (this.win !== null, но мёртв).
    this.win.on('closed', () => {
      this.win = null
      this.isVisible = false
    })

    // Загрузка контента (как в Spotlight/Voice/Overlay).
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/tray-menu')
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/tray-menu' })
    }

    return this.win
  }

  /** No-op stub (контент грузится в create). Оставлен для совместимости. */
  warmup(): void {}

  /**
   * Показать меню у иконки трея.
   * @param trayBounds — rect иконки (Tray.getBounds()) в экранных координатах.
   */
  show(trayBounds?: Rectangle): void {
    // Мёртвая ссылка (окно уничтожено) — пересоздаём лениво.
    if (!this.win || this.win.isDestroyed()) {
      this.win = null
      this.create()
    }
    if (!this.win || this.win.isDestroyed()) return
    const { width: ww, height: wh } = WINDOW_SIZES.trayMenu
    const pos = this.computePosition(trayBounds, ww, wh)
    this.win.setPosition(pos.x, pos.y, false)
    this.win.setSize(ww, wh, false)
    this.win.show()
    this.win.focus()
    this.isVisible = true
    // Plugins: свежие пункты меню плагинов при каждом показе
    // (окно живёт между показами — контент мог протухнуть).
    this.pushPluginItems()
  }

  /** Пуш актуальных плагинских пунктов в окно меню (если оно живо). */
  pushPluginItems(): void {
    if (!this.win || this.win.isDestroyed()) return
    try {
      const items = getPluginManager().getTrayItems()
      this.win.webContents.send('tray-menu:plugins-changed', items)
    } catch { /* PluginManager не инициализирован — пунктов нет */ }
  }

  hide(): void {
    // Guard: окно может быть уже уничтожено (выход через app.exit и т.п.) —
    // без проверки IPC-хендлер 'tray-menu:hide' кидал TypeError.
    if (!this.win || this.win.isDestroyed()) {
      this.isVisible = false
      return
    }
    this.win.hide()
    this.isVisible = false
  }

  toggle(trayBounds?: Rectangle): void {
    if (this.isVisible) this.hide()
    else this.show(trayBounds)
  }

  /**
   * Расчёт позиции окна меню относительно иконки трея с клампом в workArea.
   *  - по вертикали: меню над иконкой; если не влезает вверх — под иконкой;
   *  - по горизонтали: правый край меню = правый край иконки; кламп в workArea.
   */
  private computePosition(trayBounds: Rectangle | undefined, ww: number, wh: number): { x: number; y: number } {
    const display = trayBounds
      ? screen.getDisplayMatching(trayBounds)
      : screen.getPrimaryDisplay()
    const work = display.workArea

    if (trayBounds && (trayBounds.width > 0 || trayBounds.height > 0)) {
      const tb = trayBounds
      let x = tb.x + tb.width - ww
      let y = tb.y - wh

      if (y < work.y) y = tb.y + tb.height
      if (y + wh > work.y + work.height) y = work.y + work.height - wh
      if (y < work.y) y = work.y

      if (x < work.x) x = tb.x
      if (x + ww > work.x + work.width) x = work.x + work.width - ww
      if (x < work.x) x = work.x

      return { x: Math.round(x), y: Math.round(y) }
    }

    return {
      x: Math.round(work.x + work.width - ww),
      y: Math.round(work.y + work.height - wh),
    }
  }

  getWindow(): BrowserWindow | null {
    return this.win
  }
}
