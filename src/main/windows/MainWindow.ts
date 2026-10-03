import { BrowserWindow, shell, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type Store from 'electron-store'
import { WINDOW_SIZES } from '../../shared/constants'
import { attachRendererRecovery } from './rendererRecovery'

interface SavedBounds {
  x: number
  y: number
  width: number
  height: number
  /** Окно было свёрнуто в maximized-режим при последнем выходе. */
  maximized?: boolean
}

function resourcesDir(): string {
  return is.dev ? join(__dirname, '../../resources') : process.resourcesPath!
}

export class MainWindow {
  private win: BrowserWindow | null = null
  private boundsSaveTimer: NodeJS.Timeout | null = null

  constructor(private store: Store) {}

  /**
   * Возвращает сохранённые bounds окна, если они валидны (пересекаются
   * с рабочей областью хотя бы одного дисплея). Иначе undefined —
   * используем дефолт WINDOW_SIZES.main.
   */
  private getValidatedBounds(): SavedBounds | undefined {
    const saved = this.store.get('windowBounds') as SavedBounds | undefined
    if (!saved || typeof saved !== 'object') return undefined
    const { x, y, width, height } = saved
    if (
      typeof x !== 'number' || typeof y !== 'number' ||
      typeof width !== 'number' || typeof height !== 'number' ||
      width < 1000 || height < 700
    ) return undefined
    // maximized-флаг опционален (старые записи без него — окно не было maximized)
    if (typeof saved.maximized !== 'boolean') saved.maximized = false

    // Проверяем, что окно попадает на какой-то из подключённых дисплеев.
    // Если монитор отключили/сменили разрешение — saved bounds могут
    // оказаться за пределами видимой области, в таком случае откатываемся.
    try {
      const displays = screen.getAllDisplays()
      const intersects = displays.some(d => {
        const wa = d.workArea
        // Простая проверка пересечения прямоугольников
        return (
          x < wa.x + wa.width &&
          x + width > wa.x &&
          y < wa.y + wa.height &&
          y + height > wa.y
        )
      })
      if (!intersects) return undefined
    } catch {
      return undefined
    }
    return saved
  }

  create(): BrowserWindow {
    const saved = this.getValidatedBounds()
    this.win = new BrowserWindow({
      width: saved?.width ?? WINDOW_SIZES.main.width,
      height: saved?.height ?? WINDOW_SIZES.main.height,
      x: saved?.x,
      y: saved?.y,
      minWidth: 1000,
      minHeight: 700,
      resizable: true,
      frame: false,
      titleBarStyle: 'hidden',
      backgroundColor: '#1a1a1a',
      show: false,
      skipTaskbar: false,
      icon: join(resourcesDir(), 'icon.png'),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // Встроенный браузер (правая панель): <webview> в DOM — весь React-UI
        // рендерится поверх нативно (z-index работает), в отличие от
        // WebContentsView-подхода. Гостевые webPreferences жёстко
        // нормализуются в will-attach-webview ниже.
        webviewTag: true,
      },
    })

    // ── webview-харденинг (BrowserPanel) ─────────────────────────────────
    // will-attach-webview срабатывает ДО создания guest-процесса: гасим
    // node-интеграцию и прочие опасные флаги независимо от атрибутов тега
    // (вектор CVE-2026-102676 — guest мог включить nodeIntegrationInWorker).
    this.win.webContents.on('will-attach-webview', (_event, webPreferences) => {
      delete webPreferences.nodeIntegration
      delete webPreferences.nodeIntegrationInWorker
      delete webPreferences.webSecurity
      webPreferences.nodeIntegration = false
      webPreferences.nodeIntegrationInWorker = false
      webPreferences.webSecurity = true
      // Без preload у guest'а — контроль идёт из main через webContents API.
      delete webPreferences.preload
      // Попапы запрещены по умолчанию (allowpopups не включаем):
      // window.open перехватывается setWindowOpenHandler в BrowserManager
      // → новый таб панели.
    })

    // Открывать внешние ссылки в браузере
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    // ── Запрет зума страницы ──────────────────────────────────────────
    // Ctrl+колесо / Ctrl+«+/-» меняли zoomFactor Chromium'а: UI «мельчал»,
    // devicePixelRatio падал, буфер фона пересчитывался в меньшую сторону
    // и мылился. Chromium запоминает zoom per-origin — «сломанный» масштаб
    // переживал перезапуск и не восстанавливался. Масштаб UI у нас
    // управляется только настройкой «Размер шрифта интерфейса» (fontSizeUI).
    const wc = this.win.webContents
    wc.on('zoom-changed', () => {
      // Любая попытка зума (жест или Ctrl+колесо) → сброс к 100%.
      if (!wc.isDestroyed()) wc.setZoomLevel(0)
    })
    wc.on('did-finish-load', () => {
      // Сброс «залетевшего» zoom-уровня (Chromium может восстановить
      // запомненный per-origin zoom при загрузке).
      if (!wc.isDestroyed()) wc.setZoomLevel(0)
    })
    // Pinch-zoom (тачскрины) — тоже запрещаем.
    try { wc.setVisualZoomLevelLimits(1, 1) } catch { /* deprecated API — ок */ }

    // Гасим системные app-command для боковых кнопок мыши (X1/X2). На Windows
    // OS может слать 'back'/'forward'; без preventDefault они способны
    // триггерить навигацию или контекстные действия. Полная обработка X1/X2 —
    // в рендерере (см. App.tsx), здесь только подавление.
    this.win.on('app-command', (e, cmd) => {
      if (cmd === 'back' || cmd === 'forward') e.preventDefault()
    })

    // Форвард смены maximize-состояния в renderer — кнопка в кастомной
    // шапке (frame: false) меняет иконку «развернуть» ↔ «восстановить».
    // События срабатывают на любой путь: кнопка, даблклик по drag-зоне,
    // Win+Up, aero-snap.
    this.win.on('maximize', () => {
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('window:maximize-changed', true)
      }
    })
    this.win.on('unmaximize', () => {
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('window:maximize-changed', false)
      }
    })

    // Сохраняем bounds окна при resize/move (с debounce — drag/resize
    // генерирует множество событий, не хотим дёргать electron-store на каждый).
    this.win.on('resize', () => this.scheduleSaveBounds())
    this.win.on('move', () => this.scheduleSaveBounds())

    // При закрытии — прятаться в трей
    this.win.on('close', (e) => {
      e.preventDefault()
      this.win?.hide()
    })

    this.win.on('closed', () => {
      if (this.boundsSaveTimer) {
        clearTimeout(this.boundsSaveTimer)
        this.boundsSaveTimer = null
      }
      this.win = null
    })

    // Восстанавливаем maximized-режим, если окно было развёрнуто при
    // последнем выходе. Вызываем ПОСЛЕ создания (с saved bounds как
    // начальными нормальными размерами) — maximize() запомнит их для
    // последующего unmaximize, а растянутые габариты не перетрут
    // сохранённые windowBounds (saveBoundsNow игнорирует maximized-окно).
    if (saved?.maximized) {
      this.win.maximize()
    }

    // Подписки восстановления ДО первой навигации (иначе пропустим сбой старта).
    const loadRenderer = (): Promise<void> => {
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        return wc.loadURL(process.env['ELECTRON_RENDERER_URL'])
      }
      return wc.loadFile(join(__dirname, '../renderer/index.html'))
    }
    const recovery = attachRendererRecovery(this.win, loadRenderer)

    // Загружаем renderer; rejected loadPromise тоже обрабатываем.
    void loadRenderer().catch(recovery.failed)
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.win.webContents.openDevTools()
    } else {
      // В дебаг режиме открываем DevTools
      if (process.argv.includes('--inspect') || process.argv.some(a => a.startsWith('--inspect='))) {
        this.win.webContents.openDevTools({ mode: 'detach' })
      }
    }

    return this.win
  }

  show(): void {
    if (!this.win) return
    this.win.show()
    this.win.focus()
  }

  hide(): void {
    this.win?.hide()
  }

  toggle(): void {
    if (!this.win) return
    if (this.win.isVisible()) {
      this.win.hide()
    } else {
      this.win.show()
      this.win.focus()
    }
  }

  minimize(): void {
    this.win?.minimize()
  }

  /** Переключить maximize ↔ restore (кнопка в кастомной шапке). */
  maximizeToggle(): void {
    if (!this.win) return
    if (this.win.isMaximized()) this.win.unmaximize()
    else this.win.maximize()
  }

  isMaximized(): boolean {
    return this.win?.isMaximized() ?? false
  }

  getWindow(): BrowserWindow | null {
    return this.win
  }

  /**
   * Debounce-сохранение bounds в electron-store. Resize/move генерируют
   * десятки событий в секунду во время drag — без debounce диск бы
   * дёргался на каждое событие (electron-store пишет JSON на диск).
   */
  private scheduleSaveBounds(): void {
    if (this.boundsSaveTimer) clearTimeout(this.boundsSaveTimer)
    this.boundsSaveTimer = setTimeout(() => {
      this.boundsSaveTimer = null
      this.saveBoundsNow()
    }, 500)
  }

  /**
   * Немедленная запись bounds в store. Вызывается из scheduleSaveBounds
   * по таймеру, а также из app.on('before-quit') при реальном выходе
   * из приложения (обычный close уходит в трей, не доходя до этой точки).
   */
  flushBounds(): void {
    if (this.boundsSaveTimer) {
      clearTimeout(this.boundsSaveTimer)
      this.boundsSaveTimer = null
    }
    this.saveBoundsNow()
  }

  private saveBoundsNow(): void {
    if (!this.win || this.win.isDestroyed()) return
    try {
      if (this.win.isMaximized()) {
        // Окно развёрнуто — НЕ перезаписываем нормальные windowBounds
        // растянутыми (иначе при unmaximize/перезапуске потеряем
        // прежний размер). Сохраняем только флаг maximized.
        this.store.set('windowBounds', { ...(this.store.get('windowBounds') as SavedBounds ?? {}), maximized: true })
      } else {
        // Нормальный режим — сохраняем актуальные bounds и флаг false.
        this.store.set('windowBounds', { ...this.win.getBounds(), maximized: false })
      }
    } catch { /* окно могло быть уничтожено в момент записи */ }
  }
}
