// ── Web scraping & image search — полностью бесплатно, без API-ключей ────
//
// fetch_page: URL → чистый markdown/текст (Jina Reader рендерит JS, fallback —
//   прямой fetch с браузерными заголовками + readability-чистка HTML).
// search_images: запрос → список картинок (DuckDuckGo Images, fallback Openverse).

import type { ToolResult } from './_shared'
import { writeFile as fsWriteFile, mkdir as fsMkdir } from 'fs/promises'
import { join } from 'path'

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
}

// ═══════════════════════════════════════════════════════════════════════════
// fetch_page — каскад: direct → BrowserWindow → Jina ×1
// ═══════════════════════════════════════════════════════════════════════════

export interface FetchPageOpts {
  /** Извлечь только секцию с этим заголовком (h1-h3). */
  section?: string
  /** Макс. символов в выводе (default 30000). */
  maxChars?: number
  /**
   * SPA-рендер через скрытый BrowserWindow (Chromium) в main-процессе.
   * Возвращает HTML после JS-выполнения.
   */
  onRenderPage?: (url: string, opts: { waitSelector?: string; timeoutMs?: number }) => Promise<{ html: string; title?: string; error?: string }>
}

interface PageMeta {
  title: string
  url: string
  description: string
  ogImage: string
  favicon: string
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
// 'render' — нужен BrowserWindow (SPA)
// 'jina'   — Jina Reader (бот-защита или сложный случай)
const domainStrategy = new Map<string, 'direct' | 'render' | 'jina'>()

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
 * Каскад (быстро → медленно):
 *  0. LRU-кэш (TTL 10 мин) → мгновенный возврат
 *  1. Direct fetch (8с) → 70% веба (статика/SSR) за 1–2с
 *     ├─ контент хороший → return ✅
 *     ├─ SPA-шелл (#root + текст < 200) → шаг 2, Jina НЕ вызываем
 *     └─ 403/Cloudflare → шаг 2 (браузер проходит JS-челленджи)
 *  2. BrowserWindow render (бюджет 25с) → SPA + бот-челленджи, типично 3–6с
 *     ├─ контент хороший → return ✅
 *     └─ провал → шаг 3
 *  3. Jina Reader, ОДИН запрос (X-Timeout 25, abort 30с) — последний рубеж
 *     └─ провал → честная ошибка
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
  const isPdf = url.toLowerCase().endsWith('.pdf')
  const domain = parsed.hostname

  // ── 0) LRU-кэш (ключ включает section — иначе кэш полной страницы
  //    возвращался бы даже когда запрошена конкретная секция) ──
  const cacheKey = url + (opts.section ? '|section=' + opts.section : '')
  const cached = cacheGet(cacheKey)
  if (cached) return { success: true, output: cached }

  // PDF → сразу Jina (браузер не извлечёт текст из PDF)
  if (isPdf) {
    const result = await jinaFetch(url, opts, maxChars, isPdf, domain)
    if (result.success) cacheSet(cacheKey, result.output)
    return result
  }

  // Если домен уже помечен как 'jina' → пропускаем direct+BW
  if (domainStrategy.get(domain) === 'jina') {
    const result = await jinaFetch(url, opts, maxChars, isPdf, domain)
    if (result.success) cacheSet(cacheKey, result.output)
    return result
  }

  // ── 1) Direct fetch (8с) — 70% веба ──
  if (domainStrategy.get(domain) !== 'render') {
    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(8000),
        redirect: 'follow',
      })

      if (res.ok) {
        const html = await res.text()
        const meta = extractMeta(html, url)
        const text = readabilityClean(html)

        // Хороший контент → return
        if (text.length >= 200 && !isSpaShell(html, text.length)) {
          if (!domainStrategy.has(domain)) domainStrategy.set(domain, 'direct')
          const result = buildResult(text, meta, opts, maxChars)
          if (result.success) cacheSet(cacheKey, result.output)
          return result
        }

        // SPA-шелл → идём к BrowserWindow (шаг 2)
        if (isSpaShell(html, text.length)) {
          log('[fetch_page] SPA shell detected (text=' + text.length + ') → BrowserWindow')
        }
      } else if (isBotBlocked(res.status, '')) {
        // 403 без тела → бот-защита → BrowserWindow
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

  // ── 2) BrowserWindow render (25с) — SPA + бот-челленджи ──
  if (opts.onRenderPage) {
    try {
      const rendered = await opts.onRenderPage(url, {
        waitSelector: SPA_WAIT_SELECTOR,
        timeoutMs: 25000,
      })

      if (rendered.html && !rendered.error) {
        const bwContent = htmlToText(rendered.html)
        if (bwContent.length > 200) {
          domainStrategy.set(domain, 'render')
          const meta: PageMeta = {
            title: rendered.title || '',
            url,
            description: '',
            ogImage: '',
            favicon: getFavicon(url),
          }
          const result = buildResult(bwContent, meta, opts, maxChars)
          if (result.success) cacheSet(cacheKey, result.output)
          return result
        }
      }
    } catch {
      /* fall through to Jina */
    }
  }

  // ── 3) Jina Reader, ОДИН запрос (последний рубеж) ──
  domainStrategy.set(domain, 'jina')
  const result = await jinaFetch(url, opts, maxChars, isPdf, domain)
  if (result.success) cacheSet(cacheKey, result.output)
  return result
}

/**
 * Jina Reader — один запрос, markdown, X-Timeout 25, abort 30с.
 * Используется как fallback (последний рубеж) или для PDF.
 */
async function jinaFetch(
  url: string,
  opts: FetchPageOpts,
  maxChars: number,
  isPdf: boolean,
  _domain: string,
): Promise<ToolResult> {
  const jinaHeaders = {
    'X-Return-Format': 'markdown',
    'X-Timeout': '25',
    'X-Wait-For-Selector': SPA_WAIT_SELECTOR,
    ...BROWSER_HEADERS,
  }

  try {
    // 429 → одна попытка ретрая через 2с
    let res = await fetch(`https://r.jina.ai/${url}`, {
      headers: jinaHeaders,
      signal: AbortSignal.timeout(30000),
    })

    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000))
      res = await fetch(`https://r.jina.ai/${url}`, {
        headers: jinaHeaders,
        signal: AbortSignal.timeout(30000),
      })
    }

    if (res.ok) {
      const md = await res.text()
      if (md.length > 200) {
        const meta = parseJinaMeta(md, url, isPdf)
        let content = stripJinaMetaLines(md)

        // SPA detection: тонкий контент → пробуем HTML-формат через Jina (ещё один запрос)
        if (content.length < 500 && !isPdf) {
          try {
            const htmlRes = await fetch(`https://r.jina.ai/${url}`, {
              headers: {
                'X-Return-Format': 'html',
                'X-Timeout': '25',
                'X-Wait-For-Selector': SPA_WAIT_SELECTOR,
                'X-No-Cache': 'true',
                ...BROWSER_HEADERS,
              },
              signal: AbortSignal.timeout(30000),
            })
            if (htmlRes.ok) {
              const html = await htmlRes.text()
              if (html.length > 1000) {
                const htmlContent = readabilityClean(html)
                if (htmlContent.length > content.length) {
                  content = htmlContent
                }
              }
            }
          } catch {
            /* use what we have */
          }
        }

        // Если контент всё ещё тонкий — предупреждение
        if (content.length < 500 && !isPdf) {
          content =
            `${content}\n\n---\n⚠️ SPA Notice: This page appears to be a Single Page Application. Content could not be fully captured after direct fetch, BrowserWindow render, and Jina Reader. The page may require authentication or a specific API endpoint.\n\nTry:\n1. Use search_web to find the information\n2. If you know the API endpoint URL, try fetch_page on it directly\n3. Ask the user to copy the text from the page`
        }

        const result = buildResult(content, meta, opts, maxChars)
        return result
      }
    }

    if (!res.ok) {
      return { success: false, output: '', error: `Jina Reader HTTP ${res.status} ${res.statusText}` }
    }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { success: false, output: '', error: 'fetch_page timed out (all stages failed: direct 8s + BrowserWindow 25s + Jina 30s). Try again later.' }
    }
    return { success: false, output: '', error: `fetch_page failed: ${e.message}` }
  }

  return { success: false, output: '', error: 'fetch_page: all stages returned empty content.' }
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

/** Логгер-заглушка (core/tools не имеет доступа к логгеру main-процесса). */
function log(_msg: string): void {
  // no-op — логирование в spaRenderer (main-процесс)
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

/** Удаляет мета-строки Jina (Title:, URL Source:, Description:, Markdown Content:) из markdown. */
function stripJinaMetaLines(md: string): string {
  return md
    .replace(/^Title:\s*.+$/m, '')
    .replace(/^URL Source:\s*.+$/m, '')
    .replace(/^Description:\s*.+$/m, '')
    .replace(/^Markdown Content:\s*$/m, '')
    .replace(/^\s*\n/, '')
    .trim()
}

/** Парсит мета-данные из ответа Jina Reader (Title: / URL: в первых строках). */
function parseJinaMeta(md: string, url: string, isPdf: boolean): PageMeta {
  const titleMatch = md.match(/^Title:\s*(.+)$/m)
  const urlMatch = md.match(/^URL Source:\s*(.+)$/m)
  const descMatch = md.match(/^Description:\s*(.+)$/m)

  const title = titleMatch?.[1]?.trim() || ''
  const description = descMatch?.[1]?.trim() || ''
  const pageUrl = urlMatch?.[1]?.trim() || url

  // Favicon из URL
  let favicon = ''
  try {
    const u = new URL(url)
    favicon = `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`
  } catch { /* ignore */ }

  return {
    title: title || (isPdf ? 'PDF Document' : pageUrl),
    url: pageUrl,
    description,
    ogImage: '',
    favicon,
  }
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
  const mdRegex = new RegExp(
    `(^|\\n)(#{1,3})\\s+${escaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|$)`,
    'i',
  )
  const mdMatch = mdRegex.exec(md)
  if (mdMatch) return mdMatch[3].trim()

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

// Кэш vqd-токенов — экономит один запрос при повторном поиске
const vqdCache = new Map<string, { vqd: string; ts: number }>()
const VQD_TTL = 5 * 60 * 1000

/**
 * Поиск картинок через DuckDuckGo Images (без API-ключа).
 * Fallback: Openverse API (CC-картинки, без ключа).
 * Возвращает JSON-массив для рендерера.
 */
export async function searchImages(query: string, opts: SearchImagesOpts = {}): Promise<ToolResult> {
  if (!query) return { success: false, output: '', error: 'query is required' }

  const maxResults = Math.min(opts.maxResults ?? 10, 50)
  const filters = buildDdgFilters(opts.size, opts.type, opts.color)

  // ── DDG: шаг 1 — vqd-токен (с кэшем) ──
  let vqd: string | undefined

  // Проверяем кэш (без учёта фильтров — vqd зависит только от запроса)
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
      const html = await r1.text()
      vqd =
        html.match(/vqd=([\d-]+)[&"']/)?.[1] ??
        html.match(/vqd="?([\d-]+)"?/)?.[1]
      if (vqd) vqdCache.set(query, { vqd, ts: Date.now() })
    } catch {
      /* fallthrough to Openverse */
    }
  }

  // ── DDG: шаг 2 — JSON с картинками ──
  let results: ImageResult[] = []
  if (vqd) {
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
      if (r2.ok) {
        const data = (await r2.json()) as { results?: DDGImageResult[] }
        results = (data.results ?? []).slice(0, maxResults).map(ddgToImageResult)
      }
    } catch {
      /* fallthrough to Openverse */
    }
  }

  // ── Fallback: Openverse API ──
  if (!results.length) {
    try {
      results = await openverseSearch(query, maxResults, opts)
    } catch (e: any) {
      return {
        success: false,
        output: '',
        error: `Image search failed on both DuckDuckGo and Openverse: ${e.message}`,
      }
    }
  }

  if (!results.length) {
    return { success: true, output: JSON.stringify([]), error: undefined }
  }

  // ── Download ──
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

/** Собирает строку фильтров для DDG i.js. */
function buildDdgFilters(
  size?: string,
  type?: string,
  color?: string,
): string {
  // DDG формат: &f=,,,size:large,type:photo
  // Позиции: [animated][size][type][color]
  const parts: string[] = ['', '', '', '']
  if (size) parts[1] = `size:${size}`
  if (type) parts[2] = `type:${type}`
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
