// ── Web scraping & image search — полностью бесплатно, локально, без API-ключей ──
//
// fetch_page: URL → чистый markdown/текст. Каскад БЕЗ облачных сервисов:
//   1. прямой fetch с браузерными заголовками + readability-чистка HTML
//   2. рендер JS-heavy страниц через скрытый BrowserWindow (встроенный Chromium)
//   3. PDF → локальное извлечение текста (Mozilla pdf.js через unpdf)
// search_images: запрос → список картинок. Каскад бесплатных провайдеров БЕЗ
//   API-ключей: кэш → DuckDuckGo → Bing Images → Wikimedia Commons → Openverse.

import type { ToolResult } from './_shared'
import { extractPdfFromBuffer, fetchPdfText, type PdfTextResult } from './pdfExtract'
import { writeFile as fsWriteFile, mkdir as fsMkdir } from 'fs/promises'
import { join } from 'path'

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
}

// ═══════════════════════════════════════════════════════════════════════════
// fetch_page — каскад: direct → BrowserWindow → честная ошибка (без облака)
// ═══════════════════════════════════════════════════════════════════════════

export interface FetchPageOpts {
  /** Извлечь только секцию с этим заголовком (h1-h3). */
  section?: string
  /** Макс. символов в выводе (default 30000). */
  maxChars?: number
  /**
   * SPA-рендер через скрытый BrowserWindow (Chromium) в main-процессе.
   * Возвращает структурный markdown (shadow-DOM walker) + HTML для
   * совместимости + API-эндпоинты, замеченные при рендере.
   */
  onRenderPage?: (url: string, opts: { waitSelector?: string; timeoutMs?: number }) => Promise<{ html: string; title?: string; error?: string; text?: string; apiEndpoints?: string[] }>
  /** Логгер каскада (диагностика стадий: direct → render → pdf). */
  onLog?: (msg: string) => void
}

interface PageMeta {
  title: string
  url: string
  description: string
  ogImage: string
  favicon: string
  /** JSON API-эндпоинты (fetch/XHR), замеченные при BW-рендере SPA-страницы. */
  apiEndpoints?: string[]
}

// Универсальный CSS-селектор для SPA — матчит типичные SPA-контейнеры.
const SPA_WAIT_SELECTOR =
  'main, article, #root > div, #app > div, [class*="content"], [class*="changelog"], [class*="markdown-body"], [role="main"]'

// ── LRU-кэш страниц (TTL 10 мин, 50 записей) ──
const PAGE_CACHE_TTL = 10 * 60 * 1000
const PAGE_CACHE_MAX = 50
const pageCache = new Map<string, { output: string; ts: number }>()

function cacheGet(url: string): string | null {
  const entry = pageCache.get(url)
  if (entry && Date.now() - entry.ts < PAGE_CACHE_TTL) return entry.output
  if (entry) pageCache.delete(url) // expired
  return null
}

function cacheSet(url: string, output: string): void {
  pageCache.set(url, { output, ts: Date.now() })
  // LRU eviction: если больше максимума — удаляем самые старые
  if (pageCache.size > PAGE_CACHE_MAX) {
    const oldest = [...pageCache.entries()].sort((a, b) => a[1].ts - b[1].ts)
    for (let i = 0; i < oldest.length - PAGE_CACHE_MAX; i++) {
      pageCache.delete(oldest[i][0])
    }
  }
}

// ── Мемо стратегий по доменам ──
// 'direct' — сайт отдаёт контент напрямую (70% веба)
// 'render' — нужен BrowserWindow (SPA / бот-защита)
const domainStrategy = new Map<string, 'direct' | 'render'>()

/** Быстрый детект SPA-шелла в HTML: #root/#app/#__next + текст < 200 символов. */
function isSpaShell(html: string, textLen: number): boolean {
  return (
    /<div\s+id=["'](?:root|app|__next|__nuxt)["']\s*>/i.test(html) &&
    textLen < 200
  )
}

/** Детект бот-защиты (Cloudflare и подобные). */
function isBotBlocked(status: number, html: string): boolean {
  return (
    status === 403 ||
    /just a moment|cf-browser-verification|enable javascript and cookies|cf-challenge/i.test(html)
  )
}

/** Favicon из URL через Google favicon service. */
function getFavicon(url: string): string {
  try {
    const u = new URL(url)
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`
  } catch {
    return ''
  }
}

/**
 * Скачать веб-страницу и вернуть её содержимое в чистом виде (markdown/текст).
 *
 * Каскад (быстро → медленно), полностью локально и бесплатно:
 *  0. LRU-кэш (TTL 10 мин) → мгновенный возврат
 *  1. Direct fetch (8с) → 70% веба (статика/SSR) за 1–2с
 *     ├─ контент хороший → return ✅
 *     ├─ content-type: application/pdf → локальное pdf-извлечение (pdf.js)
 *     ├─ SPA-шелл (#root + текст < 200) → шаг 2
 *     └─ 403/Cloudflare → шаг 2 (браузер проходит JS-челленджи)
 *  2. BrowserWindow render (25с / 35с при бот-защите) → SPA + бот-челленджи
 *     ├─ контент хороший → return ✅
 *     └─ провал → шаг 3
 *  3. Тонкий direct-контент (микро-страницы: example.com, заглушки) →
 *     вернуть с предупреждением
 *  4. Честная ошибка с подсказками (без облачных fallback-сервисов)
 *  PDF (.pdf в URL) → сразу локальное извлечение (pdf.js через unpdf),
 *  минуя direct/BW — браузер текст из PDF не извлекает.
 *
 * Мемо: domainStrategy запоминает какой путь сработал для домена —
 * следующий fetch_page на том же домене перепрыгивает провальные стадии.
 *
 * Формат output: мета-блок (---FETCH_META---...---END_META---) + контент.
 */
export async function fetchPage(url: string, opts: FetchPageOpts = {}): Promise<ToolResult> {
  if (!url) return { success: false, output: '', error: 'url is required' }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { success: false, output: '', error: `Invalid URL: ${url}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { success: false, output: '', error: `Only http/https supported, got: ${parsed.protocol}` }
  }

  const maxChars = opts.maxChars ?? 50000
  const log = (msg: string): void => opts.onLog?.(msg)
  // .pdf в пути (с учётом query/hash: file.pdf?v=2). Ссылки без .pdf в URL,
  // но отдающие application/pdf, ловятся content-type-детектом в direct-fetch.
  const isPdf = /\.pdf(\?|#|$)/i.test(url)
  const domain = parsed.hostname

  // ── 0) LRU-кэш (ключ включает section — иначе кэш полной страницы
  //    возвращался бы даже когда запрошена конкретная секция) ──
  const cacheKey = url + (opts.section ? '|section=' + opts.section : '')
  const cached = cacheGet(cacheKey)
  if (cached) return { success: true, output: cached }

  // ── PDF → локальное извлечение текста (pdf.js через unpdf) ──
  // Браузер текст из PDF не извлекает — отдельный путь. Без облака и лимитов.
  if (isPdf) {
    const pdf = await fetchPdfText(url, maxChars, log)
    const result = buildPdfResult(pdf, url, opts, maxChars)
    if (result.success) cacheSet(cacheKey, result.output)
    return result
  }

  // ── 1) Direct fetch (8с) — 70% веба ──
  let botBlocked = false
  // Тонкий, но НЕ SPA-шелл контент (example.com и подобные микро-страницы):
  // если BrowserWindow тоже не даст результата — вернём хотя бы это,
  // вместо жёсткой ошибки. SPA-шелл в fallback не годится — там мусор.
  let thinFallback: { text: string; meta: PageMeta } | null = null
  if (domainStrategy.get(domain) !== 'render') {
    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(8000),
        redirect: 'follow',
      })

      if (res.ok) {
        // Скрытый PDF: ссылка без .pdf, но сервер отдал application/pdf
        const contentType = res.headers.get('content-type') ?? ''
        if (contentType.includes('pdf')) {
          log('[fetch_page] content-type is application/pdf → local PDF extraction')
          const buf = new Uint8Array(await res.arrayBuffer())
          const pdf = await extractPdfFromBuffer(buf, maxChars, log)
          const result = buildPdfResult(pdf, url, opts, maxChars)
          if (result.success) cacheSet(cacheKey, result.output)
          return result
        }

        const html = await res.text()
        const meta = extractMeta(html, url)
        const text = readabilityClean(html)

        // Хороший контент → return.
        // «Подозрительно тонкий» детект: HTML большой, а чистки вышло мало
        // (regex-readability не справилась со вложенной разметкой, или это
        // challenge-страница) → BrowserWindow отрендерит нормально.
        const suspiciouslyThin = html.length > 20000 && text.length < Math.max(1000, html.length / 50)
        if (suspiciouslyThin) {
          log('[fetch_page] suspiciously thin extraction (text=' + text.length + ' html=' + html.length + ') → BrowserWindow')
        }
        if (text.length >= 200 && !isSpaShell(html, text.length) && !suspiciouslyThin) {
          if (!domainStrategy.has(domain)) domainStrategy.set(domain, 'direct')
          const result = buildResult(text, meta, opts, maxChars)
          if (result.success) cacheSet(cacheKey, result.output)
          return result
        }

        // SPA-шелл → идём к BrowserWindow (шаг 2)
        if (isSpaShell(html, text.length)) {
          log('[fetch_page] SPA shell detected (text=' + text.length + ') → BrowserWindow')
        } else if (text.length > 50) {
          // Тонкая, но настоящая страница — запоминаем как fallback
          thinFallback = { text, meta }
          log('[fetch_page] thin page (' + text.length + ' chars) → trying BrowserWindow, keeping as fallback')
        }
      } else if (isBotBlocked(res.status, '')) {
        // 403 без тела → бот-защита → BrowserWindow
        botBlocked = true
        log('[fetch_page] bot-blocked (status=' + res.status + ') → BrowserWindow')
      } else if (res.status >= 400) {
        // Другие HTTP ошибки → пробуем BrowserWindow (может JS-рендер даст другое)
        log('[fetch_page] HTTP ' + res.status + ' → BrowserWindow')
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        log('[fetch_page] direct fetch timed out (8s) → BrowserWindow')
      } else {
        log('[fetch_page] direct fetch error: ' + e.message + ' → BrowserWindow')
      }
      // Сетевая ошибка → BrowserWindow (может пройти через другой стек)
    }
  }

  // ── 2) BrowserWindow render — SPA + бот-челленджи ──
  // Бот-защита: бюджет 35с вместо 25с — CF-челленджу нужно время на авто-проход.
  if (opts.onRenderPage) {
    try {
      const rendered = await opts.onRenderPage(url, {
        waitSelector: SPA_WAIT_SELECTOR,
        timeoutMs: botBlocked ? 35000 : 25000,
      })

      if ((rendered.text || rendered.html) && !rendered.error) {
        // text — структурный markdown от shadow-DOM walker'а (предпочтителен);
        // html — fallback для старого пути (regex-чистка)
        const bwContent = rendered.text || (rendered.html ? htmlToText(rendered.html) : '')
        if (bwContent.length > 200) {
          domainStrategy.set(domain, 'render')
          const meta: PageMeta = {
            title: rendered.title || '',
            url,
            description: '',
            ogImage: '',
            favicon: getFavicon(url),
            apiEndpoints: rendered.apiEndpoints,
          }
          const result = buildResult(bwContent, meta, opts, maxChars)
          if (result.success) cacheSet(cacheKey, result.output)
          return result
        }
      }
    } catch {
      /* fall through to honest error */
    }
  }

  // ── 3) Fallback: тонкий, но настоящий контент от direct fetch ──
  // Микро-страницы (example.com, редирект-заглушки) — лучше вернуть что есть,
  // чем ошибку. SPA-шеллы сюда не попадают (мусор вместо контента).
  if (thinFallback && thinFallback.text.trim().length > 0) {
    log('[fetch_page] returning thin direct-fetch content (' + thinFallback.text.length + ' chars)')
    const content =
      thinFallback.text +
      `\n\n---\n⚠️ Thin page: only ${thinFallback.text.length} chars extracted. The page may be mostly empty, a redirect stub, or require JavaScript.`
    const result = buildResult(content, thinFallback.meta, opts, maxChars)
    if (result.success) cacheSet(cacheKey, result.output)
    return result
  }

  // ── 4) Всё провалилось — честная ошибка с подсказками ──
  log('[fetch_page] all local stages failed for ' + domain)
  return {
    success: false,
    output: '',
    error:
      `fetch_page failed: direct fetch and browser render both failed for ${domain}. ` +
      'The page may require authentication, use aggressive bot protection, or be a thin SPA. ' +
      'Try: 1) search_web to find the information, ' +
      '2) fetch_page on a specific API endpoint URL if you know it, ' +
      '3) ask the user to paste the page content.',
  }
}

/** Сборка ToolResult из результата локального PDF-извлечения. */
function buildPdfResult(
  pdf: PdfTextResult,
  url: string,
  opts: FetchPageOpts,
  maxChars: number,
): ToolResult {
  if (!pdf.ok) return { success: false, output: '', error: pdf.error }
  const meta: PageMeta = {
    title: pdf.title || 'PDF Document',
    url,
    description: `PDF document, ${pdf.pages} pages`,
    ogImage: '',
    favicon: getFavicon(url),
  }
  return buildResult(pdf.text, meta, opts, maxChars)
}

/**
 * Сборка финального ToolResult: извлечение секции, обрезка, мета-блок.
 */
function buildResult(
  content: string,
  meta: PageMeta,
  opts: FetchPageOpts,
  maxChars: number,
): ToolResult {
  if (opts.section) {
    const extracted = extractSection(content, opts.section)
    if (extracted) content = extracted
    else return { success: false, output: '', error: `Section "${opts.section}" not found on this page.` }
  }

  const trimmed = content.slice(0, maxChars)
  const truncated = trimmed.length < content.length
  const body = truncated
    ? `${trimmed}\n\n...[truncated ${content.length - maxChars} chars]`
    : trimmed

  return {
    success: true,
    output: formatFetchOutput(meta, body),
  }
}

/**
 * Простой strip HTML тегов — для контента от BrowserWindow, который уже
 * вернул innerHTML конкретного элемента (main/article/#root>div).
 * В отличие от readabilityClean, не пытается найти <article>/<main> —
 * они уже извлечены BrowserWindow. Просто снимает теги и декодирует сущности.
 */
function htmlToText(html: string): string {
  return html
    // Удаляем script/style/noscript полностью
    .replace(/<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, '')
    // <br> → перенос
    .replace(/<br\s*\/?>/gi, '\n')
    // Закрывающие блочные теги → перенос
    .replace(/<\/(p|div|li|h[1-6]|tr|article|section|blockquote|ul|ol|table|thead|tbody)>/gi, '\n')
    // <li> → bullet
    .replace(/<li[^>]*>/gi, '• ')
    // <h1>-<h6> → markdown-заголовки
    .replace(/<h([1-6])[^>]*>/gi, (_, level) => `\n${'#'.repeat(Number(level))} `)
    // <a href="...">text</a> → [text](url)
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const cleanText = text.replace(/<[^>]+>/g, '').trim()
      return cleanText ? `[${cleanText}](${href})` : ''
    })
    // <img alt="..." src="..."> → ![alt](src)
    .replace(/<img\s+[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*\/?>/gi, (_, alt, src) => `![${alt}](${src})`)
    .replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, (_, src, alt) => `![${alt}](${src})`)
    // Снимаем остальные теги
    .replace(/<[^>]+>/g, ' ')
    // Декодируем HTML-сущности
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    // Чистим пробелы
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Извлекает мета-данные из HTML (<title>, <meta description>, <meta og:image>, favicon). */
function extractMeta(html: string, url: string): PageMeta {
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? ''
  const description =
    html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']+)["']/i)?.[1]?.trim() ??
    ''
  const ogImage =
    html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1]?.trim() ?? ''

  let favicon = ''
  try {
    const u = new URL(url)
    // Пытаемся найти favicon в HTML
    const faviconMatch = html.match(/<link[^>]+rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["']/i)
    if (faviconMatch) {
      favicon = faviconMatch[1].startsWith('http')
        ? faviconMatch[1]
        : `${u.protocol}//${u.host}${faviconMatch[1]}`
    } else {
      favicon = `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`
    }
  } catch { /* ignore */ }

  return { title, url, description, ogImage, favicon }
}

/**
 * Readability-чистка HTML: находит крупнейший <article>/<main>/<div> по объёму
 * текста, затем снимает теги. Лучше чем "весь HTML минус теги" — убирает
 * навигацию, сайдбары, футеры.
 */
function readabilityClean(html: string): string {
  // 1) Удаляем script/style/noscript/nav/header/footer/svg/iframe полностью
  let cleaned = html
    .replace(/<(script|style|noscript|nav|header|footer|svg|iframe|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // 2) Ищем <article>, <main>, или крупнейший <div> по текстовому объёму
  const container = findMainContent(cleaned)
  if (container) cleaned = container

  // 3) Снимаем теги, декодируем сущности
  return cleaned
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|article|section|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<h([1-6])[^>]*>/gi, (_, level) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Находит главный контент страницы: <article>, <main>, или крупнейший <div>. */
function findMainContent(html: string): string | null {
  // Приоритет 1: <article> или <main>
  const articleMatch = html.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i)
  if (articleMatch && articleMatch[1].length > 500) return articleMatch[1]

  // Приоритет 2: крупнейший <div> по объёму текста (без вложенных div)
  const divMatches = [...html.matchAll(/<div[^>]*>([\s\S]*?)<\/div>/gi)]
  let bestDiv: string | null = null
  let bestScore = 0
  for (const m of divMatches) {
    if (m[1].length < 500) continue
    // Считаем "текстовую плотность" — длина без тегов
    const textLen = m[1].replace(/<[^>]+>/g, ' ').trim().length
    if (textLen > bestScore) {
      bestScore = textLen
      bestDiv = m[1]
    }
  }
  return bestDiv
}

/**
 * Извлекает секцию по заголовку. Пробует 3 стратегии:
 *  1. Markdown заголовки: # sectionName / ## sectionName / ### sectionName
 *  2. HTML заголовки (если контент ещё HTML): <h1>sectionName</h1> ... </h1>
 *  3. Plain-text заголовки: строка, начинающаяся с sectionName (case-insensitive)
 *     — для страниц где заголовки не имеют # префикса (changelogs, docs)
 *
 * Возвращает контент между заголовком и следующим заголовком того же или
 * более высокого уровня. null если секция не найдена.
 */
function extractSection(md: string, sectionName: string): string | null {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // ── Стратегия 1: Markdown # заголовки ──
  // \n+ после заголовка: walker выдаёт заголовки с двойным переносом
  // (\n\n) — с одиночным \n lookahead (?=\n#{1,3}) срабатывал на втором
  // переносе с ПУСТОЙ секцией → «Section not found» на валидных секциях
  const mdRegex = new RegExp(
    `(^|\\n)(#{1,3})\\s+${escaped}[^\\n]*\\n+([\\s\\S]*?)(?=\\n#{1,3}\\s|$)`,
    'i',
  )
  const mdMatch = mdRegex.exec(md)
  if (mdMatch && mdMatch[3].trim().length > 0) return mdMatch[3].trim()

  // ── Стратегия 2: HTML <h1>-<h3> заголовки (контент может быть HTML) ──
  const htmlRegex = new RegExp(
    `<h[1-3][^>]*>\\s*${escaped}[^<]*</h[1-3]>([\\s\\S]*?)(?=<h[1-3]\\s|$)`,
    'i',
  )
  const htmlMatch = htmlRegex.exec(md)
  if (htmlMatch) {
    // Если контент HTML — чистим через htmlToText
    const content = htmlMatch[1]
    if (/<[a-z][^>]*>/i.test(content)) {
      return htmlToText(content).trim()
    }
    return content.trim()
  }

  // ── Стратегия 3: Plain-text заголовки ──
  // Строка, которая начинается с (или содержит) sectionName.
  // Работает для changelogs где версии написаны как "v1.0.7" или "Version 1.0.7"
  // без markdown # префикса.
  // Условие: строка начинается с sectionName (case-insensitive) И строка короткая (< 100 символов)
  // И следующая строка пустая или начинается с текста (не заголовок).
  const lines = md.split('\n')
  const lowerSection = sectionName.toLowerCase()
  let found = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.length === 0 || line.length > 100) continue
    // Точное или prefix-совпадение
    const lowerLine = line.toLowerCase()
    if (lowerLine === lowerSection || lowerLine.startsWith(lowerSection)) {
      found = i
      break
    }
  }

  if (found >= 0) {
    // Собираем контент от следующей строки до следующего заголовка
    // (строки похожие на заголовки: markdown #, или короткие строки < 80 символов
    // после пустой строки, или строки начинающиеся с "v" + цифры)
    const sectionLines: string[] = []
    for (let i = found + 1; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      // Останавливаемся на следующем заголовке
      if (/^#{1,3}\s/.test(trimmed)) break
      // Останавливаемся на строке похожей на заголовок версии (v1.0.x, Version x.x)
      // только если она короткая и после пустой строки
      if (
        trimmed.length > 0 &&
        trimmed.length < 80 &&
        sectionLines.length > 0 &&
        sectionLines[sectionLines.length - 1].trim() === '' &&
        /^v?\d/i.test(trimmed)
      ) {
        break
      }
      sectionLines.push(line)
    }
    const result = sectionLines.join('\n').trim()
    if (result.length > 0) return result
  }

  return null
}

/** Собирает output с мета-блоком для рендерера. */
function formatFetchOutput(meta: PageMeta, body: string): string {
  const metaLines: string[] = ['---FETCH_META---']
  if (meta.title) metaLines.push(`title: ${meta.title}`)
  if (meta.url) metaLines.push(`url: ${meta.url}`)
  if (meta.description) metaLines.push(`description: ${meta.description}`)
  if (meta.ogImage) metaLines.push(`og_image: ${meta.ogImage}`)
  if (meta.favicon) metaLines.push(`favicon: ${meta.favicon}`)
  // API-эндпоинты SPA: AI может дёрнуть их напрямую fetch_page — JSON
  // структурнее любого DOM-парсинга
  if (meta.apiEndpoints?.length) {
    metaLines.push(`api_endpoints: ${meta.apiEndpoints.join(' | ')}`)
  }
  metaLines.push('---END_META---')
  return `${metaLines.join('\n')}\n\n${body}`
}

// ═══════════════════════════════════════════════════════════════════════════
// search_images
// ═══════════════════════════════════════════════════════════════════════════

export interface SearchImagesOpts {
  size?: 'small' | 'medium' | 'large' | 'wallpaper'
  type?: 'photo' | 'illustration' | 'clipart' | 'transparent'
  color?: string
  maxResults?: number
  download?: boolean
  downloadIndex?: number
  /** Путь к userData для сохранения скачанных картинок. */
  userDataPath?: string
  /** Логгер каскада провайдеров (диагностика: DDG → Bing → Wikimedia → Openverse). */
  onLog?: (msg: string) => void
}

interface ImageResult {
  title: string
  image: string
  thumbnail: string
  url: string
  width: number
  height: number
  source: string
  localPath?: string
}

// ── Кэш vqd-токенов DDG — экономит один запрос при повторном поиске ──
const vqdCache = new Map<string, { vqd: string; ts: number }>()
const VQD_TTL = 5 * 60 * 1000

// ── Pacing + cooldown для DDG: 202 Ratelimit / 403 / 429 — софт-блок по IP.
//    Лечится паузами; в cooldown DDG пропускаем целиком — каскад сразу идёт в Bing. ──
const DDG_MIN_INTERVAL = 3000 // мин. пауза между DDG-поисками (+ jitter 0–1с)
const DDG_COOLDOWN_MS = 60 * 1000 // после блокировки — минуту не трогаем DDG
let ddgLastSearch = 0
let ddgCooldownUntil = 0

/** Pacing-gate: true = можно звать DDG (пауза выждана), false = активен cooldown. */
async function ddgPace(): Promise<boolean> {
  if (Date.now() < ddgCooldownUntil) return false
  const wait = ddgLastSearch + DDG_MIN_INTERVAL - Date.now()
  if (wait > 0) await new Promise(r => setTimeout(r, wait + Math.random() * 1000))
  ddgLastSearch = Date.now()
  return true
}

// ── LRU-кэш результатов (TTL 10 мин, 50 записей) — повторные/похожие запросы
//    не ходят в сеть вообще, лимиты провайдеров не расходуются ──
const IMAGE_CACHE_TTL = 10 * 60 * 1000
const IMAGE_CACHE_MAX = 50
const imageCache = new Map<string, { results: ImageResult[]; ts: number }>()

function imageCacheKey(query: string, opts: SearchImagesOpts, maxResults: number): string {
  return [query.trim().toLowerCase(), opts.size ?? '', opts.type ?? '', opts.color ?? '', maxResults].join('|')
}

function imageCacheGet(key: string): ImageResult[] | null {
  const entry = imageCache.get(key)
  if (entry && Date.now() - entry.ts < IMAGE_CACHE_TTL) {
    // копия — чтобы download (localPath) не мутировал закэшированный массив
    return entry.results.map(r => ({ ...r }))
  }
  if (entry) imageCache.delete(key) // expired
  return null
}

function imageCacheSet(key: string, results: ImageResult[]): void {
  imageCache.set(key, { results, ts: Date.now() })
  if (imageCache.size > IMAGE_CACHE_MAX) {
    const oldest = [...imageCache.entries()].sort((a, b) => a[1].ts - b[1].ts)
    for (let i = 0; i < oldest.length - IMAGE_CACHE_MAX; i++) {
      imageCache.delete(oldest[i][0])
    }
  }
}

/**
 * Поиск картинок — каскад бесплатных провайдеров без API-ключей:
 *  0. LRU-кэш (TTL 10 мин) → мгновенный возврат
 *  1. DuckDuckGo Images (vqd-токен; pacing 3с + cooldown 60с при 202/403/429)
 *  2. Bing Images async-эндпоинт (скрейп, без ключа, щедрые лимиты)
 *  3. Wikimedia Commons API (открытый каталог, без ключа)
 *  4. Openverse API (CC-картинки, без ключа)
 * Каскад идёт дальше только если провайдер вернул 0 результатов или упал.
 * Возвращает JSON-массив для рендерера.
 */
export async function searchImages(query: string, opts: SearchImagesOpts = {}): Promise<ToolResult> {
  if (!query) return { success: false, output: '', error: 'query is required' }

  const log = (msg: string): void => opts.onLog?.(msg)
  const maxResults = Math.min(opts.maxResults ?? 10, 50)
  const filters = buildDdgFilters(opts.size, opts.type, opts.color)

  // ── 0) Кэш ──
  const cKey = imageCacheKey(query, opts, maxResults)
  const cached = imageCacheGet(cKey)
  if (cached) return finalizeImageResults(cached, opts)

  // ── 1) DuckDuckGo (pacing-gate; в cooldown — сразу Bing) ──
  let results: ImageResult[] = []
  const attempts: string[] = [] // чем закончилась каждая ступень — для итоговой ошибки
  if (await ddgPace()) {
    results = await ddgImageSearch(query, filters, maxResults, log)
    if (results.length) log('[search_images] DDG: ' + results.length + ' results')
    else attempts.push('DuckDuckGo: no results (possibly rate-limited)')
  } else {
    attempts.push('DuckDuckGo: rate-limited (cooldown)')
  }

  // ── 2) Bing Images ──
  if (!results.length) {
    try {
      results = await bingImageSearch(query, maxResults, opts, log)
      if (results.length) log('[search_images] Bing: ' + results.length + ' results')
      else attempts.push('Bing: no results')
    } catch (e: any) {
      attempts.push(`Bing: ${e.message}`)
      log('[search_images] Bing failed: ' + e.message)
    }
  }

  // ── 3) Wikimedia Commons ──
  if (!results.length) {
    try {
      results = await commonsSearch(query, maxResults)
      if (results.length) log('[search_images] Commons: ' + results.length + ' results')
      else attempts.push('Wikimedia Commons: no results')
    } catch (e: any) {
      attempts.push(`Wikimedia Commons: ${e.message}`)
      log('[search_images] Commons failed: ' + e.message)
    }
  }

  // ── 4) Openverse — последний рубеж ──
  if (!results.length) {
    try {
      results = await openverseSearch(query, maxResults, opts)
      if (results.length) log('[search_images] Openverse: ' + results.length + ' results')
      else attempts.push('Openverse: no results')
    } catch (e: any) {
      attempts.push(`Openverse: ${e.message}`)
      log('[search_images] Openverse failed: ' + e.message)
    }
  }

  if (!results.length) {
    // Все провайдеры пусты. Если хоть один упал с ошибкой — честная ошибка
    // со сводкой (AI видит причину и может упростить запрос/повторить).
    // Если все вернули «просто нет результатов» — это не ошибка, а пустой ответ.
    const hardFail = attempts.some(a => !a.includes('no results'))
    if (hardFail) {
      return {
        success: false,
        output: '',
        error: `Image search found nothing. Providers: ${attempts.join('; ')}. Try a simpler query or retry in a minute.`,
      }
    }
    return { success: true, output: JSON.stringify([]), error: undefined }
  }

  imageCacheSet(cKey, results)
  return finalizeImageResults(results, opts)
}

/** Дожимает результат: опциональный download + JSON-выход. */
async function finalizeImageResults(
  results: ImageResult[],
  opts: SearchImagesOpts,
): Promise<ToolResult> {
  // ── Download (best-effort) ──
  if (opts.download && opts.userDataPath && results.length > 0) {
    const idx = Math.min(opts.downloadIndex ?? 0, results.length - 1)
    try {
      const localPath = await downloadImage(results[idx], opts.userDataPath)
      results[idx].localPath = localPath
    } catch {
      /* non-fatal — download is best-effort */
    }
  }

  return {
    success: true,
    output: JSON.stringify(results),
  }
}

/**
 * DuckDuckGo Images через vqd-токен (2 запроса: страница за токеном + i.js).
 * 202 Ratelimit / 403 / 429 → софт-блок: ставим cooldown на минуту и сразу
 * возвращаем пусто (каскад уйдёт в Bing, юзер не ждёт ретраев).
 */
async function ddgImageSearch(
  query: string,
  filters: string,
  maxResults: number,
  onLog?: (msg: string) => void,
): Promise<ImageResult[]> {
  // шаг 1 — vqd-токен (с кэшем; vqd зависит только от запроса, не от фильтров)
  let vqd: string | undefined
  const cached = vqdCache.get(query)
  if (cached && Date.now() - cached.ts < VQD_TTL) {
    vqd = cached.vqd
  }

  if (!vqd) {
    try {
      const r1 = await fetch(
        `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
        { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(10000) },
      )
      // 202 — это 2xx, res.ok для него true! Проверяем статус явно.
      if (isDdgBlocked(r1.status)) {
        ddgCooldownUntil = Date.now() + DDG_COOLDOWN_MS
        onLog?.('[search_images] DDG blocked (vqd, ' + r1.status + ') → cooldown 60s')
        return []
      }
      const html = await r1.text()
      vqd =
        html.match(/vqd=([\d-]+)[&"']/)?.[1] ??
        html.match(/vqd="?([\d-]+)"?/)?.[1]
      if (vqd) vqdCache.set(query, { vqd, ts: Date.now() })
    } catch {
      return []
    }
  }

  if (!vqd) return []

  // шаг 2 — JSON с картинками
  try {
    const r2 = await fetch(
      `https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}${filters}&p=1`,
      {
        headers: {
          ...BROWSER_HEADERS,
          Referer: 'https://duckduckgo.com/',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      },
    )
    if (isDdgBlocked(r2.status)) {
      ddgCooldownUntil = Date.now() + DDG_COOLDOWN_MS
      onLog?.('[search_images] DDG blocked (i.js, ' + r2.status + ') → cooldown 60s')
      return []
    }
    if (r2.ok) {
      const data = (await r2.json()) as { results?: DDGImageResult[] }
      return (data.results ?? []).slice(0, maxResults).map(ddgToImageResult)
    }
  } catch {
    /* fallthrough to next provider */
  }
  return []
}

/** DDG софт-блок: 202 Ratelimit, 403, 429. */
function isDdgBlocked(status: number): boolean {
  return status === 202 || status === 403 || status === 429
}

/**
 * Маппинг наших type → валидные значения фильтров DDG/Bing.
 * У обоих нет "illustration" — ближайшее clipart. Bing-значение "lineart"
 * валидно по форме, но нестабильно: на длинных запросах Bing отвечает
 * пустым телом (проверено живыми запросами) — не используем.
 */
const PROVIDER_TYPE_MAP: Record<string, string> = {
  photo: 'photo',
  clipart: 'clipart',
  illustration: 'clipart',
  transparent: 'transparent',
}

/**
 * Bing Images — async-эндпоинт (bing.com/images/async) отдаёт HTML-фрагмент
 * без JS; каждый результат — <a class="iusc" m="{json}">, где в атрибуте m
 * лежат murl (оригинал), turl (превью), purl (страница-источник), t (title).
 * Без ключа, фильтры маппятся в query-суффиксы +filterui:...
 * Если фильтры дали 0 результатов (слишком строгие/невалидные) — один ретрай
 * без фильтров: лучше нефильтрованные картинки, чем ошибка.
 */
async function bingImageSearch(
  query: string,
  maxResults: number,
  opts: SearchImagesOpts,
  onLog?: (msg: string) => void,
): Promise<ImageResult[]> {
  let q = query
  // size: small|medium|large|wallpaper — совпадает с Bing 1:1
  if (opts.size) q += ` +filterui:imagesize-${opts.size}`
  if (opts.type) q += ` +filterui:photo-${PROVIDER_TYPE_MAP[opts.type] ?? 'photo'}`
  if (opts.color) q += ` +filterui:color2-${opts.color}`

  const results = await bingFetchImages(q, maxResults)
  if (results.length || (!opts.size && !opts.type && !opts.color)) return results

  // Фильтры могли быть слишком строгими или невалидными → ретрай без них
  onLog?.('[search_images] Bing: 0 results with filters → retry without filters')
  return bingFetchImages(query, maxResults)
}

/** Сам fetch + парсинг Bing Images async-эндпоинта. */
async function bingFetchImages(q: string, maxResults: number): Promise<ImageResult[]> {
  const count = Math.min(Math.max(maxResults, 35), 100)
  const res = await fetch(
    `https://www.bing.com/images/async?q=${encodeURIComponent(q)}&first=1&count=${count}&mmasync=1`,
    {
      headers: { ...BROWSER_HEADERS, Referer: 'https://www.bing.com/images' },
      signal: AbortSignal.timeout(10000),
    },
  )
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`)
  const html = await res.text()

  const out: ImageResult[] = []
  // <a class="iusc" ... m="{json}"> — m может стоять до/после class, ищем в пределах тега
  for (const tag of html.matchAll(/<a\b[^>]*\bclass="iusc"[^>]*>/g)) {
    const mAttr = tag[0].match(/\sm="([^"]*)"/)
    if (!mAttr) continue
    try {
      const meta = JSON.parse(decodeHtmlEntities(mAttr[1])) as {
        murl?: string
        turl?: string
        purl?: string
        t?: string
      }
      if (!meta.murl) continue
      out.push({
        title: meta.t || '',
        image: meta.murl,
        thumbnail: meta.turl || meta.murl,
        url: meta.purl || meta.murl,
        width: 0,
        height: 0,
        source: 'bing',
      })
      if (out.length >= maxResults) break
    } catch {
      /* битый JSON в m — пропускаем */
    }
  }
  return out
}

/** Декод HTML-entity в атрибуте m (Bing экранирует кавычки как &quot;). */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Wikimedia Commons API — открытый медиа-каталог без ключа.
 * MediaWiki API: generator=search по namespace File: + imageinfo (url|size|mime).
 * iiurlwidth=400 даёт готовый thumburl для превью. Не-картинки (PDF/OGG/…)
 * отфильтровываем по mime на клиенте.
 */
async function commonsSearch(query: string, maxResults: number): Promise<ImageResult[]> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2', // pages как массив, а не объект
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6', // File:
    gsrlimit: String(Math.min(maxResults, 50)),
    prop: 'imageinfo',
    iiprop: 'url|size|mime',
    iiurlwidth: '400',
  })
  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: {
      // Wikimedia просит описательный User-Agent вместо голого браузерного
      'User-Agent': 'SynteeHelper/0.1.0 (desktop AI assistant; image search tool)',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`Commons HTTP ${res.status}`)
  const data = (await res.json()) as {
    query?: {
      pages?: Array<{
        title?: string
        imageinfo?: Array<{
          url: string
          thumburl?: string
          descriptionurl?: string
          width?: number
          height?: number
          mime?: string
        }>
      }>
    }
  }
  return (data.query?.pages ?? []).flatMap(p => {
    const ii = p.imageinfo?.[0]
    if (!ii || !(ii.mime ?? '').startsWith('image/')) return []
    return [{
      title: (p.title ?? '').replace(/^File:/, ''),
      image: ii.url,
      thumbnail: ii.thumburl || ii.url,
      url: ii.descriptionurl || ii.url,
      width: ii.width || 0,
      height: ii.height || 0,
      source: 'wikimedia',
    }]
  })
}

/** Собирает строку фильтров для DDG i.js. */
function buildDdgFilters(
  size?: string,
  type?: string,
  color?: string,
): string {
  // DDG формат: &f=,,,size:large,type:photo
  // Позиции: [animated][size][type][color]
  // Валидные type у DDG: photo/clipart/gif/transparent — маппим наши значения
  const parts: string[] = ['', '', '', '']
  if (size) parts[1] = `size:${size}`
  if (type) parts[2] = `type:${PROVIDER_TYPE_MAP[type] ?? type}`
  if (color) parts[3] = `color:${color}`
  const filterStr = parts.join(',')
  // Если все пустые — не добавляем &f
  if (!filterStr.replace(/,/g, '').trim()) return ''
  return `&f=${filterStr}`
}

interface DDGImageResult {
  title: string
  image: string
  thumbnail: string
  url: string
  width: number
  height: number
  source: string
}

function ddgToImageResult(r: DDGImageResult): ImageResult {
  return {
    title: r.title || '',
    image: r.image,
    thumbnail: r.thumbnail || r.image,
    url: r.url,
    width: r.width || 0,
    height: r.height || 0,
    source: r.source || 'duckduckgo',
  }
}

/** Openverse API — CC-картинки без ключа (fallback). */
async function openverseSearch(
  query: string,
  maxResults: number,
  opts: SearchImagesOpts,
): Promise<ImageResult[]> {
  const params = new URLSearchParams({
    q: query,
    page_size: String(maxResults),
    mature: 'false',
  })
  // Openverse поддерживает размер через license_type, но не напрямую size/type/color
  // Используем aspect_ratio как approximation для size
  if (opts.size === 'wallpaper') params.set('aspect_ratio', 'wide')
  if (opts.size === 'small') params.set('aspect_ratio', 'square')

  const res = await fetch(`https://api.openverse.org/v1/images/?${params}`, {
    headers: { Accept: 'application/json', ...BROWSER_HEADERS },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`Openverse HTTP ${res.status}`)
  // Openverse иногда (рейт-лимит/защита) отвечает HTTP 200 с HTML-заглушкой.
  // Без этой проверки res.json() падал с «Unexpected token '<'» и выглядел
  // как баг парсера, хотя это блокировка провайдера.
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('json')) {
    throw new Error(`Openverse returned ${ct || 'non-JSON'} instead of JSON (temporarily unavailable)`)
  }

  const data = (await res.json()) as {
    results?: Array<{
      id: string
      title: string
      url: string
      thumbnail?: string
      width?: number
      height?: number
      source?: string
      creator?: string
      license?: string
    }>
  }

  return (data.results ?? []).map(r => ({
    title: r.title || '',
    image: r.url,
    thumbnail: r.thumbnail || r.url,
    url: r.url,
    width: r.width || 0,
    height: r.height || 0,
    source: r.source || (r.creator ? `openverse/${r.creator}` : 'openverse'),
  }))
}

/** Скачивает картинку локально в userData/downloads/. */
async function downloadImage(img: ImageResult, userDataPath: string): Promise<string> {
  const dir = join(userDataPath, 'downloads')
  await fsMkdir(dir, { recursive: true })

  // Генерируем имя файла из URL
  const urlPath = new URL(img.image).pathname
  const ext = urlPath.match(/\.(\w+)$/)?.[1] || 'jpg'
  const filename = `img_${Date.now()}.${ext}`
  const outputPath = join(dir, filename)

  const res = await fetch(img.image, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)

  const buf = Buffer.from(await res.arrayBuffer())
  await fsWriteFile(outputPath, buf)
  return outputPath
}
