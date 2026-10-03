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
//  - Готовность: MutationObserver (DOM затих 1.5с + контент-селектор найден)
//  - Адаптивный скролл: пока страница растёт/появляются строки (lazy-load,
//    виртуальные списки) — с аккумуляцией уникальных строк
//  - Извлечение: DOM-walker → структурный markdown, ПРОБИВАЕТ shadow DOM
//    (YouTube, новый Reddit, компонентные фреймворки)
//  - API-эндпоинты: JSON fetch/XHR из performance-entries — в результате
//  - Race loadURL vs таймер — вечные спиннеры не вешают стадию
//  - Fail-fast по DNS/connection errors
//  - render-process-gone handler — пересоздание окна при краше
//  - Idle timeout 2 мин — неиспользуемое окно уничтожается
//  - Очистка storage между запросами (cookies СОХРАНЯЕМ: cf_clearance
//    от Cloudflare живёт — повторные запросы не решают челлендж заново)

import { BrowserWindow, session } from 'electron'
import { log } from '../../core/logger'

export interface RenderPageResult {
  html: string
  title: string
  /**
   * Структурный markdown от DOM-walker'а (пробивает shadow DOM, сохраняет
   * заголовки/ссылки/списки/код). Предпочтителен перед html — scrape.ts
   * использует text напрямую, html остаётся для совместимости.
   */
  text?: string
  /** JSON API-эндпоинты (fetch/XHR), замеченные страницей при рендере. */
  apiEndpoints?: string[]
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

  // Очистка session storage между запросами — нет утечки памяти.
  // ВАЖНО: cookies НЕ чистим. Cloudflare после прохождения JS-челленджа
  // ставит cf_clearance — если его стирать, каждый следующий fetch_page
  // на тот же домен решает челлендж заново (медленно + палит автоматизацию).
  // Partition 'spa-renderer' неперсистентная (in-memory) — cookies живут
  // только до перезапуска приложения, на диск ничего не пишется.
  try {
    if (poolWin && !poolWin.isDestroyed()) {
      poolWin.webContents.session.clearStorageData({
        storages: ['localstorage', 'indexdb', 'shadercache', 'serviceworkers'],
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
 * Wall-clock guard для executeJavaScript: если страница долго навигируется
 * (редирект-цепочки, consent-стены), вызов может висеть в очереди МИМО
 * внутреннего бюджета скрипта (бюджет стартует когда скрипт реально
 * исполнился). Guard обрывает по общему deadline — честный фейл в бюджете
 * лучше, чем результат, который worker уже отбросил по своему таймауту.
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), ms)
    }),
  ])
}

/**
 * Рендерит SPA-страницу через скрытый BrowserWindow (встроенный Chromium).
 *
 * Фазы: loadURL → MutationObserver-готовность → адаптивный скролл с
 * аккумуляцией → shadow-DOM walker (markdown + API-эндпоинты).
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

    // ── 2) Готовность страницы: MutationObserver-стабильность ──
    // Вместо хрупкого poll'а длины текста: наблюдаем мутации DOM.
    // «Готово» = контент-селектор найден И DOM затих 1.5с без мутаций.
    // «Нетерпеливый» режим (контент есть, затих 0.6с, прошло 8с) — для
    // вечно-мутирующих страниц (карусели, таймеры, live-обновления).
    // CF-челлендж («Just a moment») тоже покрыт: мутации идут, пока
    // челлендж не пройдёт, потом контент появляется и затихает.
    const remaining = Math.max(2000, deadline - Date.now() - 500)
    const readyScript = `
      new Promise((resolve) => {
        const start = Date.now();
        const budget = ${remaining};
        const CONTENT_SELECTORS = ['main', 'article', '#root > div', '#app > div', '#__next > div', '#__nuxt > div', '[class*="content"]', '[class*="changelog"]', '[class*="markdown-body"]', '[role="main"]'];
        let lastMutation = Date.now();
        let contentFound = false;

        const checkContent = () => {
          if (contentFound) return;
          for (const sel of CONTENT_SELECTORS) {
            const el = document.querySelector(sel);
            if (el && (el.innerText || '').trim().length > 200) { contentFound = true; return; }
          }
          // innerText включает shadow DOM — контент в shadow тоже считается
          if ((document.body?.innerText || '').trim().length > 300) contentFound = true;
        };

        const mo = new MutationObserver(() => { lastMutation = Date.now(); });
        mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

        const QUIET_MS = 1500;
        const timer = setInterval(() => {
          checkContent();
          const quiet = Date.now() - lastMutation;
          const elapsed = Date.now() - start;
          if (contentFound && (quiet >= QUIET_MS || (elapsed > 8000 && quiet >= 600))) {
            clearInterval(timer); mo.disconnect();
            resolve({ ready: true, quietMs: quiet, contentFound: true, elapsed, textLen: (document.body?.innerText || '').trim().length });
            return;
          }
          if (elapsed > budget) {
            clearInterval(timer); mo.disconnect();
            resolve({ ready: false, quietMs: quiet, contentFound, elapsed, textLen: (document.body?.innerText || '').trim().length });
          }
        }, 300);
      })
    `

    const readyPromise = win.webContents.executeJavaScript(readyScript) as Promise<{
      ready: boolean
      quietMs: number
      contentFound: boolean
      elapsed: number
      textLen: number
    }>

    // Wall-clock guard: executeJavaScript может висеть в очереди, пока
    // страница навигируется (редиректы/consent) — внутренний бюджет скрипта
    // тогда стартует с опозданием. Обрываем по общему deadline.
    const readyResult = await withTimeout(
      readyPromise,
      Math.max(2000, deadline - Date.now()),
      { ready: false, quietMs: 0, contentFound: false, elapsed: 0, textLen: 0 },
    )

    log(
      '[spaRenderer] ready: ' +
        (readyResult.ready ? 'yes' : 'timeout') +
        ' contentFound=' + readyResult.contentFound +
        ' quietMs=' + readyResult.quietMs +
        ' textLen=' + readyResult.textLen +
        ' elapsed=' + readyResult.elapsed + 'ms',
    )

    // ── 3) Адаптивный скролл + аккумуляция текста ──
    // Скроллим вниз пока страница растёт (lazy-load / infinite scroll) или
    // появляются новые строки (виртуальные списки — DOM держит только окно
    // элементов, контент «прошивается» аккумуляцией уникальных строк).
    // Стоп: 2 stagnant-шага (ни роста высоты, ни новых строк) или бюджет.
    const scrollBudget = Math.max(1500, deadline - Date.now() - 1500)
    const scrollScript = `
      new Promise((resolve) => {
        const start = Date.now();
        const budget = ${scrollBudget};
        const MAX_STEPS = 12;
        const STEP_MS = 350;
        const seen = new Set();
        let prevHeight = document.body ? document.body.scrollHeight : 0;
        let prevLines = 0;
        let stagnant = 0;
        let step = 0;

        const collect = () => {
          const text = document.body ? (document.body.innerText || '') : '';
          for (const line of text.split('\\n')) {
            const t = line.trim();
            if (t.length > 1) seen.add(t);
          }
        };

        const finish = () => {
          window.scrollTo(0, 0);
          resolve({ steps: step, uniqueLines: seen.size, text: Array.from(seen).join('\\n') });
        };

        const scroll = () => {
          collect();
          if (step >= MAX_STEPS || Date.now() - start > budget) { finish(); return; }
          window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
          step++;
          setTimeout(() => {
            const h = document.body ? document.body.scrollHeight : 0;
            const grew = h > prevHeight + 50;
            collect();
            const newLines = seen.size > prevLines;
            prevHeight = h;
            prevLines = seen.size;
            stagnant = (grew || newLines) ? 0 : stagnant + 1;
            if (stagnant >= 2) { finish(); return; }
            scroll();
          }, STEP_MS);
        };
        scroll();
      })
    `

    let scrollResult: { steps: number; uniqueLines: number; text: string } = { steps: 0, uniqueLines: 0, text: '' }
    try {
      scrollResult = await withTimeout(
        win.webContents.executeJavaScript(scrollScript) as Promise<{ steps: number; uniqueLines: number; text: string }>,
        Math.max(1500, deadline - Date.now()),
        { steps: 0, uniqueLines: 0, text: '' },
      )
      log('[spaRenderer] scroll: steps=' + scrollResult.steps + ' uniqueLines=' + scrollResult.uniqueLines)
    } catch {
      /* non-fatal — extraction всё равно пойдёт */
    }

    // ── 4) Извлечение: shadow-DOM walker → структурный markdown ──
    // Walker обходит DOM рекурсивно, ПРОБИВАЯ shadowRoot (querySelector не
    // видит shadow-контент — YouTube, новый Reddit, компонентные фреймворки).
    // Эмитит markdown: заголовки, ссылки, списки, code-блоки, таблицы.
    // Попутно собирает JSON API-эндпоинты из performance-entries.
    const extractScript = `
      (() => {
        // Удаляем мусорные теги
        document.querySelectorAll(
          'script, style, noscript, nav, header > nav, footer, svg, iframe, aside, [role="banner"], [role="navigation"]'
        ).forEach(e => e.remove());

        // Deep query: пробивает shadow DOM. Собираем все shadowRoot-хосты
        // одним проходом (рекурсивно), затем каждый селектор матчится
        // против document + всех shadow-корней. shadowHosts также
        // используются в fallback-выборе главного контейнера (кастомные
        // элементы вроде ytd-app — не div, querySelector('div') их не видит).
        const shadowRoots = [];
        const shadowHosts = [];
        const collectRoots = (root) => {
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
              shadowRoots.push(el.shadowRoot);
              shadowHosts.push(el);
              collectRoots(el.shadowRoot);
            }
          }
        };
        try { collectRoots(document); } catch (e) { /* deep custom elements — не критично */ }

        const deepQueryAll = (selector) => {
          const found = [...document.querySelectorAll(selector)];
          for (const sr of shadowRoots) {
            try { found.push(...sr.querySelectorAll(selector)); } catch (e) { /* detached root */ }
          }
          return found;
        };

        // Главный контейнер — двухступенчато:
        //  1) первый по приоритету селектор с достаточным матчем (≥500) —
        //     берём лучший элемент ЭТОГО селектора. Приоритет сохраняет
        //     семантику: main/article не проигрывает более жирному
        //     generic-обёртке '[class*="content"]' (VitePress-кейс);
        //  2) ни один селектор не дал ≥500 → максимум текста среди
        //     div/section + shadow-хостов (shadow-heavy страницы: ytd-app
        //     и подобные — querySelector их не видит, innerText хоста
        //     включает shadow-контент).
        const SELECTORS = [
          'main', 'article',
          '#root > div', '#app > div', '#__next > div', '#__nuxt > div',
          '[class*="content"]', '[class*="changelog"]', '[class*="markdown-body"]',
          '[role="main"]',
        ];
        let main = null;
        for (const sel of SELECTORS) {
          let selBest = null;
          let selBestLen = 0;
          for (const el of deepQueryAll(sel)) {
            const len = (el.innerText || '').trim().length;
            if (len > selBestLen) { selBestLen = len; selBest = el; }
          }
          if (selBest && selBestLen >= 500) { main = selBest; break; }
        }
        if (!main) {
          // Слабые селекторные матчи → расширяем отбор
          let bestLen = 0;
          for (const el of document.querySelectorAll('div, section')) {
            const len = (el.innerText || '').trim().length;
            if (len > bestLen) { bestLen = len; main = el; }
          }
          for (const el of shadowHosts) {
            const len = (el.innerText || '').trim().length;
            if (len > bestLen) { bestLen = len; main = el; }
          }
        }
        if (!main) main = document.body;

        // Структурный walker → markdown
        const SKIP = new Set(['script','style','noscript','svg','iframe','nav','aside','footer','template','form','button','select','canvas','video','audio']);
        const BLOCK = new Set(['p','div','section','article','ul','ol','table','thead','tbody','tr','blockquote','figure','dl','dd','dt','details','summary']);
        const out = [];
        const push = (s) => { if (s) out.push(s); };

        const walk = (node) => {
          if (node.nodeType === 3) {
            const t = (node.textContent || '').replace(/\\s+/g, ' ').trim();
            if (t) push(t + ' ');
            return;
          }
          if (node.nodeType !== 1) return;
          const tag = (node.tagName || '').toLowerCase();
          if (SKIP.has(tag)) return;

          if (/^h[1-6]$/.test(tag)) {
            push('\\n\\n' + '#'.repeat(+tag[1]) + ' ' + (node.innerText || '').replace(/\\s+/g, ' ').trim() + '\\n\\n');
            return;
          }
          if (tag === 'a' && node.getAttribute('href')) {
            const t = (node.innerText || '').replace(/\\s+/g, ' ').trim();
            if (t) { push('[' + t + '](' + node.href + ') '); return; }
          }
          if (tag === 'li') { push('\\n• '); }
          else if (tag === 'pre') { push('\\n\\n\\\`\\\`\\\`\\n' + (node.innerText || '').trim() + '\\n\\\`\\\`\\\`\\n\\n'); return; }
          else if (tag === 'br') { push('\\n'); return; }
          else if (tag === 'img') {
            const alt = node.getAttribute('alt') || '';
            const src = node.getAttribute('src') || '';
            if (src) push('![' + alt + '](' + src + ') ');
            return;
          }
          else if (tag === 'td' || tag === 'th') { push(' | '); }
          else if (BLOCK.has(tag)) { push('\\n'); }

          // Светлое дерево, затем shadow-дерево хоста
          for (const c of node.childNodes) walk(c);
          if (node.shadowRoot) for (const c of node.shadowRoot.childNodes) walk(c);
        };

        walk(main);

        // JSON API-эндпоинты: fetch/XHR ресурсы с api-подобными URL.
        // Исключаем статику (svg/шрифты/картинки часто грузятся через fetch
        // и матчатся version-эвристикой — YouTube-иконки замусоривали список)
        const seen = new Set();
        const endpoints = [];
        try {
          for (const e of performance.getEntriesByType('resource')) {
            if (e.initiatorType !== 'fetch' && e.initiatorType !== 'xmlhttprequest') continue;
            const u = e.name;
            if (seen.has(u)) continue;
            seen.add(u);
            if (/\\.(svg|png|jpe?g|gif|css|js|mjs|woff2?|ttf|ico|webp|mp4|webm)(\\?|#|$)/i.test(u)) continue;
            if (/\\/api\\/|\\.json(\\?|#|$)|graphql|\\/v\\d+\\//i.test(u)) endpoints.push(u);
          }
        } catch (e) { /* performance API недоступен — не критично */ }
        if (endpoints.length > 15) endpoints.length = 15;

        let text = out.join('')
          .replace(/\\u200b/g, '') // ZWSP из якорей заголовков (VitePress и др.)
          .replace(/[ \\t]{2,}/g, ' ')
          .replace(/\\n{3,}/g, '\\n\\n')
          .trim();
        if (text.length > ${MAX_CONTENT_LEN}) text = text.slice(0, ${MAX_CONTENT_LEN});

        return {
          text,
          textLen: text.length,
          title: document.title || '',
          html: (main && main.innerHTML) ? main.innerHTML.slice(0, ${MAX_CONTENT_LEN}) : '',
          apiEndpoints: endpoints,
        };
      })()
    `

    const result = await withTimeout(
      win.webContents.executeJavaScript(extractScript) as Promise<{
        text: string
        textLen: number
        title: string
        html: string
        apiEndpoints: string[]
      }>,
      Math.max(2000, deadline - Date.now()),
      { text: '', textLen: 0, title: '', html: '', apiEndpoints: [] },
    )

    // Виртуальные списки: аккумуляция скролла собрала заметно больше
    // уникальных строк, чем walker видит в финальном окне DOM →
    // полнота важнее структуры, отдаём аккумуляцию.
    let finalText = result.text
    if (scrollResult.text.length > result.text.length * 1.3 && scrollResult.text.length > 500) {
      log(
        '[spaRenderer] virtual list detected: scrollText=' + scrollResult.text.length +
        ' > walkerText=' + result.text.length + ' - using accumulated text',
      )
      finalText = scrollResult.text
    }

    log(
      '[spaRenderer] extract: textLen=' +
        finalText.length +
        ' htmlLen=' +
        (result.html?.length ?? 0) +
        ' apiEndpoints=' +
        result.apiEndpoints.length +
        ' title=' +
        (result.title || '').slice(0, 50),
    )

    return {
      html: result.html || '',
      text: finalText,
      title: result.title || '',
      apiEndpoints: result.apiEndpoints,
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
