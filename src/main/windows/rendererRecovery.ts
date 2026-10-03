import { app, dialog, type BrowserWindow } from 'electron'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { log } from '../../core/logger'

/** Recover only the main UI, never restart workers or reload on a network crash alone. */
export function attachRendererRecovery(win: BrowserWindow, load: () => Promise<void>): {
  failed: (error: unknown) => void
} {
  const wc = win.webContents
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let bootTimer: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  let lastFailure = 0
  let prompting = false
  let stopped = false
  let bootGeneration = 0
  let watchingBoot = false
  const alive = () => !stopped && !win.isDestroyed() && !wc.isDestroyed()
  const record = (message: string) => {
    console.error('[renderer-recovery]', message)
    log('[renderer-recovery]', message)
    try {
      const dir = join(app.getPath('userData'), 'logs')
      mkdirSync(dir, { recursive: true })
      const date = new Date().toISOString()
      appendFileSync(join(dir, `chromium-${date.slice(0, 10)}.log`), `[${date}] [renderer-recovery] ${message}\n`)
    } catch { /* best-effort диагностика */ }
  }
  const clearBootTimer = () => {
    if (bootTimer) clearTimeout(bootTimer)
    bootTimer = undefined
  }

  const failed = (error: unknown): void => {
    if (!alive()) return
    const message = error instanceof Error ? error.message : String(error)
    record(message)
    clearBootTimer()
    watchingBoot = false
    bootGeneration++
    // did-fail-load и rejected loadPromise могут описывать один и тот же сбой.
    if (retryTimer || prompting) return
    if (Date.now() - lastFailure > 60_000) attempts = 0
    lastFailure = Date.now()
    if (attempts < 2) {
      attempts++
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        if (alive()) void load().catch(failed)
      }, 1000)
      record(`Retry ${attempts}/2 scheduled`)
      return
    }
    // После двух попыток не зацикливаем перезагрузку и не оставляем пустой фон.
    prompting = true
    win.show()
    void dialog.showMessageBox(win, {
      type: 'error',
      title: 'Syntee — сбой интерфейса',
      message: 'Не удалось загрузить интерфейс Syntee.',
      detail: 'Автоматическое восстановление не помогло. Можно повторить загрузку. Подробности сохранены в журнале.',
      buttons: ['Повторить загрузку', 'Скрыть окно'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (!alive()) return
      if (response === 0) {
        attempts = 0
        prompting = false
        void load().catch(failed)
      } else {
        win.hide()
      }
    }).catch(error => record(`Recovery dialog failed: ${String(error)}`))
  }

  wc.on('render-process-gone', (_event, details) => {
    failed(`Renderer gone: reason=${details.reason}, exitCode=${details.exitCode}`)
  })
  wc.on('preload-error', (_event, preloadPath, error) => {
    failed(`Preload failed (${preloadPath}): ${error.message}`)
  })
  wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    // ERR_ABORTED — нормальная отмена предыдущей навигации при reload.
    if (isMainFrame && code !== -3) failed(`Main frame load failed: ${description} (${code})`)
  })
  win.on('unresponsive', () => {
    // Не перезагружаем занятой UI: диагностика без потери введённого текста.
    record('Main window unresponsive')
  })
  const armBootCheck = (message: string) => {
    clearBootTimer()
    const generation = bootGeneration
    bootTimer = setTimeout(() => {
      bootTimer = undefined
      if (!alive() || !watchingBoot || generation !== bootGeneration) return
      // Загрузка вложенного контента может продолжаться после запуска React.
      // Сам loading-флаг не является доказательством неисправности UI.
      void wc.executeJavaScript(`(() => {
        const root = document.getElementById('root');
        return !root || root.children.length === 0 || !!document.getElementById('boot-splash');
      })()`).then(blank => {
        if (!alive() || !watchingBoot || generation !== bootGeneration) return
        watchingBoot = false
        if (blank) failed(message)
      }).catch(error => {
        if (!alive() || generation !== bootGeneration) return
        // Не перезагружаем UI только из-за ошибки диагностического запроса.
        record(`Boot readiness check failed: ${String(error)}`)
      })
    }, 30_000)
  }
  wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    // did-start-loading относится ко всему webContents, включая subframes.
    // SPA/hash-навигация и guest браузера не запускают watchdog главного UI.
    if (!isMainFrame || isInPlace) return
    bootGeneration++
    watchingBoot = true
    armBootCheck('Main frame loading timed out after 30s')
  })
  wc.on('did-frame-finish-load', (_event, isMainFrame) => {
    if (!isMainFrame || !watchingBoot) return
    // Не ждём did-finish-load: вложенный frame может грузиться бесконечно.
    armBootCheck('Renderer loaded but React did not mount after 30s')
  })
  win.once('closed', () => {
    stopped = true
    clearBootTimer()
    if (retryTimer) clearTimeout(retryTimer)
  })
  return { failed }
}
