// ── Локальное извлечение текста из PDF — Mozilla pdf.js (через unpdf) ──────
//
// Полностью локально и бесплатно: без облака, без API-ключей, без лимитов
// (раньше PDF шёл в Jina Reader — облачный сервис с rate-limit и утечкой
// документа третьей стороне). unpdf — zero-deps обёртка над serverless-сборкой
// pdf.js, dual ESM/CJS → работает и в main-процессе, и в worker-чанках.
//
// Поток: fetch байтов PDF (браузерные заголовки, 30с) → sanity-check
// магических байтов %PDF- → getDocumentProxy → постраничное getTextContent
// (кап 300 страниц + ранний выход по объёму) → сырой текст наружу.
//
// Форматированием (мета-блок, обрезка, section) занимается scrape.ts —
// модуль возвращает только сырые данные.

const PDF_BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/pdf,application/octet-stream,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
}

/** Кап на число извлекаемых страниц — защита от гигантских PDF (1000+ страниц). */
const MAX_PDF_PAGES = 300

/** Ранний выход: текста в 2 раза больше лимита — хватит с запасом на обрезку. */
const EARLY_EXIT_FACTOR = 2

export interface PdfTextResult {
  ok: boolean
  /** Извлечённый текст (полный, без обрезки — обрезает вызывающий). */
  text: string
  /** Title из метаданных PDF (может быть пустым). */
  title: string
  /** Всего страниц в документе. */
  pages: number
  error?: string
}

/**
 * Извлекает текст из уже скачанных байтов PDF (pdf.js через unpdf).
 *
 * @param buf байты PDF-документа
 * @param maxChars лимит символов результата — для раннего выхода (не обрезает!)
 * @param onLog опциональный логгер каскада fetch_page
 */
export async function extractPdfFromBuffer(
  buf: Uint8Array,
  maxChars = 50000,
  onLog?: (msg: string) => void,
): Promise<PdfTextResult> {
  // Sanity-check: это действительно PDF?
  if (buf.length < 5 || String.fromCharCode(...buf.slice(0, 5)) !== '%PDF-') {
    return {
      ok: false,
      text: '',
      title: '',
      pages: 0,
      error:
        'URL did not return a PDF (missing %PDF- header). The link may point to an HTML page — try fetch_page on it as a regular page.',
    }
  }

  // Ленивая загрузка unpdf: pdf.js (~1.5MB) грузится только при первом PDF,
  // не замедляет старт приложения.
  onLog?.(`[pdf] extracting text (${Math.round(buf.length / 1024)}KB)`)
  try {
    const { getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(buf)

    // Title из метаданных (не критично, если нет)
    let title = ''
    try {
      const meta = await pdf.getMetadata()
      title = ((meta?.info as { Title?: string } | undefined)?.Title ?? '').trim()
    } catch {
      /* some PDFs have broken metadata */
    }

    const totalPages = pdf.numPages
    const pageLimit = Math.min(totalPages, MAX_PDF_PAGES)

    // Постранично: item.str + hasEOL (рекомендованный паттерн pdf.js —
    // фильтр 'str' in item отсекает TextMarkedContent-маркеры).
    let text = ''
    for (let i = 1; i <= pageLimit; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      let pageText = ''
      for (const item of content.items) {
        if ('str' in item) {
          pageText += item.str
          if (item.hasEOL) pageText += '\n'
        }
      }
      text += pageText + '\n\n'
      // Ранний выход: уже в 2 раза больше лимита — обрезка всё равно съест
      if (text.length > maxChars * EARLY_EXIT_FACTOR) break
    }

    if (text.trim().length === 0) {
      return {
        ok: false,
        text: '',
        title: '',
        pages: totalPages,
        error:
          'PDF downloaded successfully but contains no extractable text (scanned/image-only PDF). OCR is required for this document.',
      }
    }

    onLog?.(`[pdf] extracted ${text.length} chars from ${Math.min(pageLimit, totalPages)}/${totalPages} pages`)
    return { ok: true, text, title, pages: totalPages }
  } catch (e: unknown) {
    const err = e as Error
    return { ok: false, text: '', title: '', pages: 0, error: `PDF text extraction failed: ${err.message}` }
  }
}

/**
 * Скачивает PDF по URL и извлекает текст локально (pdf.js через unpdf).
 *
 * @param url прямой URL на PDF-файл
 * @param maxChars лимит символов результата — для раннего выхода (не обрезает!)
 * @param onLog опциональный логгер каскада fetch_page
 */
export async function fetchPdfText(
  url: string,
  maxChars = 50000,
  onLog?: (msg: string) => void,
): Promise<PdfTextResult> {
  // ── 1) Скачиваем байты ──
  onLog?.('[pdf] downloading: ' + url)
  let buf: Uint8Array
  try {
    const res = await fetch(url, {
      headers: PDF_BROWSER_HEADERS,
      signal: AbortSignal.timeout(30000),
      redirect: 'follow',
    })
    if (!res.ok) {
      return { ok: false, text: '', title: '', pages: 0, error: `PDF download failed: HTTP ${res.status} ${res.statusText}` }
    }
    buf = new Uint8Array(await res.arrayBuffer())
  } catch (e: unknown) {
    const err = e as Error
    if (err.name === 'AbortError') {
      return { ok: false, text: '', title: '', pages: 0, error: 'PDF download timed out (30s). Try again later.' }
    }
    return { ok: false, text: '', title: '', pages: 0, error: `PDF download failed: ${err.message}` }
  }

  // ── 2) Извлекаем текст ──
  return extractPdfFromBuffer(buf, maxChars, onLog)
}
