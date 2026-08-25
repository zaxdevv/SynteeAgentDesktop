// ── SPA Renderer: рендерит JS-heavy страницы через скрытый BrowserWindow ──
//
// Electron = Chromium. Не нужен внешний скрапер — используем встроенный браузер.
// Пул из 1 персистентного hidden BrowserWindow с отдельной session (partition),
// чтобы блокировка ресурсов не затрагивала основное окно приложения.
//
// Архитектура:
//  - Отдельная session partition 'spa-renderer' — изоляция от основного окна
//  - setBackgroundThrottling(false) — скрытые окна не троттлят JS
//  - Чистый Chrome UA (без "Electron") — бот-детект не палит
//  - Блокировка картинок/шрифтов/медиа/трекеров → рендер быстрее в 3-10 раз
//  - Network idle (счётчик запросов) + ранний выход при контенте ≥ 1000
//  - Race loadURL vs таймер — вечные спиннеры не вешают стадию
//  - Fail-fast по DNS/connection errors
//  - Scroll-to-bottom перед extraction → lazy-loaded контент попадает в DOM
//  - render-process-gone handler — пересоздание окна при краше
//  - Idle timeout 2 мин — неиспользуемое окно уничтожается
//  - Очистка session storage/cache между запросами — нет утечки памяти

import { BrowserWindow, session } from 'electron'
import { log } from '../../core/logger'

export interface RenderPageResult {
  html: string
  title: string
  error?: string
}

// ── Константы ─────────────────────────────────────────────────────────────

const PARTITION = 'spa-renderer'
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const IDLE_TIMEOUT_MS = 2 * 60 * 1000 // уничтожить пул через 2 мин бездействия
const MAX_CONTENT_LEN = 500000 // лимит HTML для извлечения (защита от гигантских страниц)

const TRACKER_PATTERNS = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /facebook\.net/i,
  /doubleclick\.net/i,
  /hotjar\.com/i,
  /mixpanel\.com/i,
  /segment\.io/i,
  /amplitude\.com/i,
  /sentry\.io/i,
  /clarity\.ms/i,
  /yandex\.ru\/metrica/i,
  /mc\.yandex\.ru/i,
]

function isTracker(url: string): boolean {
  return TRACKER_PATTERNS.some((p) => p.test(url))
}

const FATAL_ERROR_CODES = new Set([
  -105, // ERR_NAME_NOT_RESOLVED
  -102, // ERR_CONNECTION_REFUSED
  -103, // ERR_CONNECTION_RESET
  -104, // ERR_CONNECTION_ABORTED
  -106, // ERR_INTERNET_DISCONNECTED
  -107, // ERR_CONNECTION_FAILED
  -300, // ERR_INVALID_URL
])

// ── Пул окон ──────────────────────────────────────────────────────────────

let poolWin: BrowserWindow | null = null
let poolBusy = false
let poolIdleTimer: ReturnType<typeof setTimeout> | null = null
const renderQueue: Array<() => void> = []

/** Отдельная session для SPA-рендерера — изолирована от основного окна. */
function getSpaSession(): Electron.Session {
  return session.fromPartition(PARTITION)
}

/** Создаёт hidden BrowserWindow с правильными настройками. */
function createPoolWindow(): BrowserWindow {
  const ses = getSpaSession()
  ses.setUserAgent(CHROME_UA)

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      session: ses, // ← отдельная partition, изолированная от основного окна
    },
  })

  // КРИТИЧНО: скрытые окна троттлят JS-таймеры/rAF до ~1/сек
  win.webContents.setBackgroundThrottling(false)
  win.webContents.setAudioMuted(true)

  // Если renderer крашится — помечаем окно как мёртвое, acquireWindow пересоздаст
  win.webContents.on('render-process-gone', (_e, details) => {
    log('[spaRenderer] render-process-gone: ' + details.reason + ' — pool window will be recreated')
    poolWin = null
    poolBusy = false
    // Разбудить очередь — они получат новое окно
    const queued = renderQueue.splice(0)
    for (const q of queued) q()
  })

  return win
}

/** Запускает таймер idle-уничтожения пула. */
function startIdleTimer(): void {
  if (poolIdleTimer) clearTimeout(poolIdleTimer)
  poolIdleTimer = setTimeout(() => {
    if (poolBusy) {
      // Кто-то занял окно прямо перед таймером — перезапустим позже
      startIdleTimer()
      return
    }
    log('[spaRenderer] idle timeout — destroying pool window')
    destroySpaPool()
  }, IDLE_TIMEOUT_MS)
}

/** Получает свободное окно из пула или создаёт новое. */
async function acquireWindow(): Promise<BrowserWindow> {
  // Отменяем idle-таймер — окно снова используется
  if (poolIdleTimer) {
    clearTimeout(poolIdleTimer)
    poolIdleTimer = null
  }

  if (poolWin && !poolWin.isDestroyed()) {
    if (!poolBusy) {
      poolBusy = true
      return poolWin
    }
    // Окно занято — ждём в очереди
    await new Promise<void>((resolve) => renderQueue.push(resolve))
    // После resume — возможно окно пересоздалось (краш) — проверяем
    if (poolWin && !poolWin.isDestroyed()) {
      poolBusy = true
      return poolWin
    }
    // Окно умерло пока ждали — создаём новое
    poolWin = createPoolWindow()
    poolBusy = true
    return poolWin
  }
  poolWin = createPoolWindow()
  poolBusy = true
  return poolWin
}

/** Возвращает окно в пул и запускает idle-таймер. */
function releaseWindow(): void {
  poolBusy = false

  // Очистка session storage между запросами — нет утечки cookies/cache
  try {
    if (poolWin && !poolWin.isDestroyed()) {
      poolWin.webContents.session.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'shadercache', 'serviceworkers'],
      })
    }
  } catch {
    /* window already destroyed */
  }

  // Следующий в очереди?
  const next = renderQueue.shift()
  if (next) {
    next()
  } else {
    // Очередь пуста — запускаем idle-таймер
    startIdleTimer()
  }
}

/** Уничтожает пул (при выходе или idle timeout). */
export function destroySpaPool(): void {
  if (poolIdleTimer) {
    clearTimeout(poolIdleTimer)
    poolIdleTimer = null
  }
  try {
    poolWin?.destroy()
  } catch {
    /* already destroyed */
  }
  poolWin = null
  poolBusy = false
  renderQueue.length = 0
}

// ── Network idle tracker ──────────────────────────────────────────────────

interface IdleTracker {
  isIdle: () => boolean
  cleanup: () => void
}

/** Устанавливает webRequest-хуки на session для подсчёта запросов + блокировки мусора. */
function setupIdleTracker(win: BrowserWindow): IdleTracker {
  const ses = win.webContents.session
  let inflight = 0
  let lastActivity = Date.now()

  const filter = { urls: ['http://*/*', 'https://*/*'] }

  ses.webRequest.onBeforeRequest(filter, (details, cb) => {
    const rt = details.resourceType
    // Блокируем картинки, шрифты, медиа, трекеры → рендер быстрее
    if (rt === 'image' || rt === 'media' || rt === 'font' || isTracker(details.url)) {
      cb({ cancel: true })
      return
    }
    inflight++
    lastActivity = Date.now()
    cb({})
  })

  const onCompleted = (): void => {
    inflight--
    if (inflight < 0) inflight = 0
    lastActivity = Date.now()
  }
  const onError = (): void => {
    inflight--
    if (inflight < 0) inflight = 0
    lastActivity = Date.now()
  }

  ses.webRequest.onCompleted(filter, onCompleted)
  ses.webRequest.onErrorOccurred(filter, onError)

  return {
    isIdle: () => inflight <= 0 && Date.now() - lastActivity > 1500,
    cleanup: () => {
      try {
        // Снимаем хуки — передаём null (Electron API)
        ses.webRequest.onBeforeRequest(filter, null as never)
        ses.webRequest.onCompleted(filter, null as never)
        ses.webRequest.onErrorOccurred(filter, null as never)
      } catch {
        /* session already destroyed */
      }
    },
  }
}

// ── Основная функция ──────────────────────────────────────────────────────

/**
 * Рендерит SPA-страницу через скрытый BrowserWindow (встроенный Chromium).
 *
 * @param url URL страницы
 * @param opts.waitSelector CSS-селектор (опционально, не используется напрямую)
 * @param opts.timeoutMs Общий таймаут (default: 25с)
 */
export async function renderSpaPage(
  url: string,
  opts: { waitSelector?: string; timeoutMs?: number } = {},
): Promise<RenderPageResult> {
  const timeoutMs = opts.timeoutMs ?? 25000
  const deadline = Date.now() + timeoutMs

  log('[spaRenderer] start url=' + url + ' timeout=' + timeoutMs + 'ms')

  const win = await acquireWindow()
  const tracker = setupIdleTracker(win)

  // Fail-fast: DNS/connection error
  let fatalError = false
  let fatalMsg = ''

  const onDidFail = (_e: unknown, errorCode: number, errorDescription: string): void => {
    if (errorCode === -3) return // ERR_ABORTED (редиректы) — игнорируем
    if (FATAL_ERROR_CODES.has(errorCode)) {
      fatalError = true
      fatalMsg = `${errorDescription} (code ${errorCode})`
      log('[spaRenderer] fatal: ' + fatalMsg)
    } else {
      log('[spaRenderer] did-fail-load: code=' + errorCode + ' desc=' + errorDescription)
    }
  }
  win.webContents.on('did-fail-load', onDidFail)

  try {
    // ── 1) loadURL с race против таймера ──
    const loadTimeoutMs = Math.min(15000, timeoutMs - 2000)
    let loadSettled = false

    await Promise.race([
      win.webContents.loadURL(url).catch((e: unknown) => {
        if (!loadSettled) {
          loadSettled = true
          log('[spaRenderer] loadURL error: ' + (e instanceof Error ? e.message : String(e)))
        }
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          loadSettled = true
          resolve()
        }, loadTimeoutMs)
      }),
    ])

    log('[spaRenderer] loadURL phase done')

    if (fatalError) {
      return { html: '', title: '', error: 'Page load failed: ' + fatalMsg }
    }

    // ── 2) Ждём рендер: poll контента + network idle ──
    // Poll каждые 400мс. Условие раннего выхода: контент ≥ 1000 и стабилен 2 poll'а.
    // Network idle: 0 запросов 1.5с (через tracker).
    // Бюджет: оставшееся время до deadline.
    const remaining = Math.max(2000, deadline - Date.now() - 500)
    const pollScript = `
      new Promise((resolve) => {
        const start = Date.now();
        const budget = ${remaining};
        const interval = 400;
        let lastLen = 0;
        let stableCount = 0;

        const check = () => {
          const len = document.body?.innerText?.trim().length ?? 0;
          const elapsed = Date.now() - start;

          if (len >= 1000 && len === lastLen) {
            stableCount++;
            if (stableCount >= 2) {
              resolve({ length: len, early: true, elapsed });
              return;
            }
          } else {
            stableCount = 0;
          }
          lastLen = len;

          if (elapsed > budget) {
            resolve({ length: len, early: false, elapsed });
            return;
          }
          setTimeout(check, interval);
        };
        check();
      })
    `

    // Запускаем poll (контент) и idle-чекер параллельно.
    // Завершаем когда ОБА готовы (poll даст длину, idle подтвердит стабильность).
    // Но если deadline близко — poll сам resolve'нется по budget.
    const pollPromise = win.webContents.executeJavaScript(pollScript) as Promise<{
      length: number
      early: boolean
      elapsed: number
    }>

    const idlePromise = new Promise<boolean>((resolve) => {
      const checkIdle = (): void => {
        if (deadline - Date.now() <= 0) {
          resolve(false)
          return
        }
        if (tracker.isIdle()) {
          resolve(true)
          return
        }
        setTimeout(checkIdle, 200)
      }
      checkIdle()
    })

    // Ждём poll (он даст длину контента), idle — параллельно
    const [pollResult, idleResult] = await Promise.all([pollPromise, idlePromise])

    log(
      '[spaRenderer] poll: len=' +
        pollResult.length +
        ' early=' +
        pollResult.early +
        ' idle=' +
        idleResult +
        ' elapsed=' +
        pollResult.elapsed +
        'ms',
    )

    // ── 3) Scroll-to-bottom для lazy-loaded контента ──
    // Прокручиваем страницу до конца трижды (с задержкой) — триггерит
    // infinite scroll, lazy-load images, виртуальные списки.
    try {
      await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const steps = 3;
          let step = 0;
          const scroll = () => {
            window.scrollTo(0, document.body.scrollHeight);
            step++;
            if (step < steps) {
              setTimeout(scroll, 500);
            } else {
              // Скролл обратно наверх (необязательно, но чисто)
              window.scrollTo(0, 0);
              resolve();
            }
          };
          scroll();
        })
      `)
    } catch {
      /* non-fatal */
    }

    // ── 4) Извлекаем отрендеренный HTML ──
    const extractScript = `
      (() => {
        // Удаляем мусорные теги
        document.querySelectorAll(
          'script, style, noscript, nav, header > nav, footer, svg, iframe, aside, [role="banner"], [role="navigation"]'
        ).forEach(e => e.remove());

        // Ищем главный контент по приоритету
        const selectors = [
          'main', 'article',
          '#root > div', '#app > div',
          '#__next > div', '#__nuxt > div',
          '[class*="content"]', '[class*="changelog"]', '[class*="markdown-body"]',
          '[role="main"]',
        ];

        let main = null;
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.innerHTML.length > 200) {
            main = el;
            break;
          }
        }

        // Fallback: крупнейший <div> по текстовому объёму
        if (!main) {
          let bestEl = null;
          let bestLen = 0;
          document.querySelectorAll('div').forEach(div => {
            const textLen = div.innerText?.trim().length ?? 0;
            if (textLen > bestLen) { bestLen = textLen; bestEl = div; }
          });
          main = bestEl || document.body;
        }

        const html = main ? main.innerHTML : document.body.innerHTML;
        return {
          html: html.length > ${MAX_CONTENT_LEN} ? html.slice(0, ${MAX_CONTENT_LEN}) : html,
          title: document.title || '',
          textLen: main ? (main.innerText?.trim().length ?? 0) : 0,
        };
      })()
    `

    const result = (await win.webContents.executeJavaScript(extractScript)) as {
      html: string
      title: string
      textLen: number
    }

    log(
      '[spaRenderer] extract: htmlLen=' +
        (result.html?.length ?? 0) +
        ' textLen=' +
        result.textLen +
        ' title=' +
        (result.title || '').slice(0, 50),
    )

    return {
      html: result.html || '',
      title: result.title || '',
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    log('[spaRenderer] error: ' + msg)
    return { html: '', title: '', error: msg }
  } finally {
    // Снимаем listener
    try {
      win.webContents.removeListener('did-fail-load', onDidFail as never)
    } catch {
      /* already removed */
    }
    tracker.cleanup()
    releaseWindow()
  }
}
