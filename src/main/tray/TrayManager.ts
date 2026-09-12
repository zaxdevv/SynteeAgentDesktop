import { Tray, nativeImage, app, type Rectangle, type NativeImage } from 'electron'
import { join } from 'path'
import type { TrayMenuWindow } from '../windows/TrayMenuWindow'

interface TrayCallbacks {
  showMain: () => void
  showSpotlight: () => void
  showVoice: () => void
  quit: () => void
}

/**
 * Трей-иконка + кастомное HTML-меню.
 *
 * Раньше здесь было нативное Win32 контекст-меню (Menu.buildFromTemplate)
 * с эмодзи в лейблах — его нельзя стилизовать под клиент (тема, glass,
 * lucide-иконки). Теперь по правому клику открывается frameless
 * glass-окно TrayMenuWindow, рендерящее карточку меню на React.
 *
 * Поведение кликов:
 *  - двойной клик → показать главное окно (привычное Windows-поведение);
 *  - правый клик   → показать кастомное меню у иконки.
 */
export class TrayManager {
  private tray: Tray | null = null
  private animationInterval: NodeJS.Timeout | null = null
  // Кадры анимации, прекэшированные в RAM. Раньше каждые 400мс шло
  // nativeImage.createFromPath с диска (disk I/O + PNG decode + resize
  // в main-процессе) — постоянная фоновая нагрузка во время прослушки.
  private animationFrames: NativeImage[] = []

  constructor(
    private callbacks: TrayCallbacks,
    private menuWindow: TrayMenuWindow,
  ) {}

  init(): void {
    const iconPath = join(app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'), 'tray-idle.png')
    let icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    if (icon.isEmpty()) {
      icon = nativeImage.createFromPath(join(app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'), 'icon.png')).resize({ width: 16, height: 16 })
    }
    this.tray = new Tray(icon)
    this.tray.setToolTip('Syntee Helper')
    this.tray.on('double-click', () => this.callbacks.showMain())
    // Правый клик — показать кастомное HTML-меню у иконки.
    this.tray.on('right-click', (_e, bounds) => this.menuWindow.show(bounds as Rectangle | undefined))
    // На некоторых системах left-click тоже стоит обрабатывать как вызов
    // меню — но по решению пользователя левый/двойной клик открывают главное
    // окно, поэтому здесь только right-click.
  }

  // Анимация иконки при прослушивании wake word
  startListeningAnimation(): void {
    if (!this.tray) return
    // Кадры грузим с диска ОДИН раз при первом запуске анимации, дальше
    // тикаем по RAM-кэшу — 0 disk I/O в тике.
    if (this.animationFrames.length === 0) {
      const frames = ['tray-listen-1.png', 'tray-listen-2.png', 'tray-listen-3.png']
      const basePath = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
      for (const f of frames) {
        const icon = nativeImage.createFromPath(join(basePath, f)).resize({ width: 16, height: 16 })
        if (!icon.isEmpty()) this.animationFrames.push(icon)
      }
    }
    if (this.animationFrames.length === 0) return
    let i = 0
    this.animationInterval = setInterval(() => {
      const icon = this.animationFrames[i % this.animationFrames.length]
      if (icon && !icon.isEmpty()) this.tray?.setImage(icon)
      i++
    }, 400)
  }

  stopListeningAnimation(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval)
      this.animationInterval = null
    }
    const iconPath = join(app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'), 'tray-idle.png')
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    if (!icon.isEmpty()) {
      this.tray?.setImage(icon)
    }
  }

  destroy(): void {
    this.stopListeningAnimation()
    this.tray?.destroy()
  }
}
