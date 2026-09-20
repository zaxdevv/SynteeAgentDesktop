// pptTemplates — тула работы с шаблонами презентаций:
//   ppt_templates          — список встроенных тем + локальных/скачанных шаблонов
//   ppt_template_search    — поиск бесплатных шаблонов в интернете + скачивание
//   ppt_template_download  — скачать шаблон по прямому URL
//   ppt_apply_template     — применить настоящий .potx/.pptx к готовой деке (COM)
const state = require('../state')
const path = require('path')
const templateLib = require('../lib/ppt/templateLib')
const { THEMES, themeSummary } = require('../lib/ppt/themes')

/** Папка скачанных шаблонов. */
function dlDir() {
  const api = state.api
  return templateLib.downloadedDir(api && api.pluginDir) || path.join(process.env.TEMP || '.', 'office-tools-templates')
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
}

// ── ppt_templates: листинг ──

async function listTemplates() {
  const themes = THEMES.map(themeSummary)
  let local = []
  try {
    local = templateLib.scanLocalTemplates(state.api && state.api.pluginDir)
  } catch { /* папки недоступны — вернём только темы */ }

  const lines = ['ВСТРОЕННЫЕ ТЕМЫ (ppt_create: template: "<id>"):', '']
  for (const t of themes) {
    lines.push('• ' + t.id + ' — ' + t.name + ' [' + t.style + ']')
    lines.push('  ' + t.description)
    lines.push('  Палитра: ' + t.palette.join(' ') + ' · Шрифты: ' + t.fonts.head + ' / ' + t.fonts.body)
  }
  if (local.length) {
    lines.push('')
    lines.push('ФАЙЛЫ ШАБЛОНОВ (ppt_create: template: "<путь>" — палитра и шрифты из файла):', '')
    for (const f of local.slice(0, 30)) {
      const kb = Math.round(f.size / 1024)
      const theme = f.theme ? ' · акцент ' + f.theme.colors.accent + ' · ' + f.theme.fonts.head : ''
      lines.push('• ' + f.path + ' (' + kb + ' КБ' + theme + ')')
    }
    if (local.length > 30) lines.push('… и ещё ' + (local.length - 30))
  } else {
    lines.push('')
    lines.push('Локальных файлов-шаблонов нет. Найти и скачать: тул ppt_template_search.')
  }
  lines.push('')
  lines.push('Подсказки:')
  lines.push('- ppt_create с template: тема задаёт мастера, фоны, цвета текста по умолчанию, шрифты и chartColors.')
  lines.push('- ppt_template_search { query } — поиск бесплатных шаблонов в сети (скачивает в ' + dlDir() + ').')
  lines.push('- ppt_template_download { url } — скачать по прямой ссылке .pptx/.potx.')
  lines.push('- ppt_apply_template — применить настоящий .potx к УЖЕ созданной деке (полная замена макетов).')
  return lines.join('\n')
}

// ── ppt_template_search: поиск в интернете ──

/** Парс ссылок на страницы шаблонов из HTML поиска fppt (статьи: <article><a class="post__thumb">). */
function parseFpptPages(html) {
  const out = []
  const re = /<article\b[^>]*>\s*<a\s+href="([^"]+)"[^>]*class="post__thumb"/gi
  let m
  while ((m = re.exec(html))) {
    const u = m[1]
    if (/\/(category|tag|page|about|contact|privacy|policy|dmca|terms|disclaimer|sitemap|feed)/i.test(u)) continue
    out.push(u)
  }
  return [...new Set(out)]
}

/** Парс download-эндпоинтов (…/download/N/) из HTML страницы шаблона fppt. */
function parseDownloadEndpoints(html) {
  const out = []
  const re = /href="(https?:\/\/[^"]*\/download\/\d+\/?)"/gi
  let m
  while ((m = re.exec(html))) out.push(m[1])
  return [...new Set(out)]
}

/** Парс результатов DuckDuckGo HTML (ссылки через uddg=). */
function parseDdg(html) {
  const out = []
  const re = /uddg=([^&"]+)/g
  let m
  while ((m = re.exec(html))) {
    try {
      const u = decodeURIComponent(m[1])
      if (/^https?:\/\//.test(u)) out.push(u)
    } catch { /* ignore */ }
  }
  return [...new Set(out)]
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const FPPT_ORIGIN = 'https://www.free-power-point-templates.com/'

/**
 * Поиск бесплатных шаблонов: fppt.com (WordPress-поиск) → страницы шаблонов →
 * download-эндпоинты (?go=1 + Referer → редирект на прямой .pptx) → скачивание.
 * Fallback: DuckDuckGo (filetype:pptx) — часто блокируется, best-effort.
 */
async function searchTemplates({ query, limit = 4, download = true }) {
  if (!query || !String(query).trim()) throw new Error('query обязателен (тема шаблонов, например "business", "education")')
  const api = state.api
  const fetchImpl = api && api.net && api.net.fetch
  if (!fetchImpl) throw new Error('net недоступен: у плагина нет права "net" (переустанови/включи плагин)')
  const q = String(query).trim()
  const results = []

  // ── Источник 1: fppt.com (WordPress, прямой поиск) ──
  try {
    const r = await fetchImpl('https://fppt.com/?s=' + encodeURIComponent(q), { headers: { 'User-Agent': UA } })
    if (r.status === 200 && r.body) {
      const pages = parseFpptPages(r.body).slice(0, limit + 3)
      for (const pageUrl of pages) {
        if (results.length >= limit) break
        try {
          const pr = await fetchImpl(pageUrl, { headers: { 'User-Agent': UA } })
          if (pr.status !== 200 || !pr.body) continue
          const endpoints = parseDownloadEndpoints(pr.body)
          if (!endpoints.length) continue
          const tm = /<title>([^<]*)<\/title>/i.exec(pr.body)
          results.push({
            title: tm ? decodeHtml(tm[1]).replace(/\s*[|–-]\s*(FPPT|Free Power[^<]*)$/i, '').trim() : pageUrl,
            pageUrl,
            fileUrl: endpoints[0].replace(/\/?$/, '/') + '?go=1', // go-редирект → прямой файл
            source: 'fppt.com',
          })
        } catch { /* страница недоступна — следующая */ }
      }
    }
  } catch { /* сайт недоступен — fallback */ }

  // ── Источник 2 (fallback): DuckDuckGo → прямые .pptx ──
  if (!results.length) {
    try {
      const r = await fetchImpl('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q + ' powerpoint template filetype:pptx'))
      if (r.status === 200 && r.body) {
        for (const u of parseDdg(r.body)) {
          if (results.length >= limit) break
          if (!/\.(pptx|potx)(\?|$)/i.test(u)) continue
          results.push({ title: decodeURIComponent(u.split('/').pop().split('?')[0]), pageUrl: u, fileUrl: u, source: 'duckduckgo' })
        }
      }
    } catch { /* DDG недоступен */ }
  }

  // ── Скачивание найденных ──
  const dir = dlDir()
  for (const item of results) {
    if (!download) continue
    try {
      // fppt go-эндпоинты требуют Referer (иначе отдают HTML вместо файла)
      const headers = item.source === 'fppt.com'
        ? { 'User-Agent': UA, Referer: FPPT_ORIGIN }
        : { 'User-Agent': UA }
      const dl = await templateLib.downloadTemplate(fetchImpl, item.fileUrl, { dir, name: item.title, headers })
      item.downloaded = dl.path
      item.size = dl.size
      try {
        const t = templateLib.extractTheme(dl.path)
        item.theme = { accent: t.colors.accent, accent2: t.colors.accent2, fonts: t.fonts.head + ' / ' + t.fonts.body, style: t.style }
      } catch { /* тема не извлеклась — не критично */ }
    } catch (e) {
      item.error = String(e.message || e)
    }
  }

  if (!results.length) {
    return (
      'По запросу "' + q + '" ничего не нашлось (сайты-источники недоступны или изменились).\n' +
      'План Б: найди прямую ссылку на .pptx/.potx своим поиском (search_web) и скачай тулом ppt_template_download { url }.\n' +
      'Или используй встроенные темы: тул ppt_templates (template: "midnight", "sunset", "corporate-blue", …).'
    )
  }

  const lines = ['Найдено шаблонов: ' + results.length + ' (запрос: "' + q + '")', '']
  for (const item of results) {
    lines.push('• ' + item.title + '  [' + item.source + ']')
    lines.push('  Страница: ' + item.pageUrl)
    if (item.downloaded) {
      lines.push('  СКАЧАН: ' + item.downloaded + (item.size ? ' (' + Math.round(item.size / 1024) + ' КБ)' : ''))
      if (item.theme) lines.push('  Тема файла: акцент ' + item.theme.accent + ', шрифты ' + item.theme.fonts)
      lines.push('  Использование: ppt_create { spec: { template: "' + item.downloaded.replace(/\\/g, '/') + '", slides: [...] } }')
    } else if (item.error) {
      lines.push('  НЕ скачан: ' + item.error)
      lines.push('  Прямая ссылка: ' + item.fileUrl)
    }
  }
  return lines.join('\n')
}

// ── ppt_template_download: скачать по прямому URL ──

async function downloadTemplateTool({ url, name }) {
  if (!url) throw new Error('url обязателен (прямая ссылка на .pptx/.potx/.thmx)')
  const api = state.api
  const fetchImpl = api && api.net && api.net.fetch
  if (!fetchImpl) throw new Error('net недоступен: у плагина нет права "net"')
  const dl = await templateLib.downloadTemplate(fetchImpl, url, { name, dir: dlDir() })

  let themeInfo = ''
  try {
    const t = templateLib.extractTheme(dl.path)
    themeInfo = '\nТема файла: стиль ' + t.style + ', акцент ' + t.colors.accent + ', шрифты ' + t.fonts.head + ' / ' + t.fonts.body
  } catch { /* не критично */ }

  return (
    'Шаблон скачан: ' + dl.path + ' (' + Math.round(dl.size / 1024) + ' КБ)' + themeInfo +
    '\nИспользование: ppt_create { spec: { template: "' + dl.path.replace(/\\/g, '/') + '", slides: [...] } }'
  )
}

// ── ppt_apply_template: COM-применение к готовой деке ──

async function applyTemplateTool({ path: p, templatePath }) {
  if (!p) throw new Error('path обязателен (.pptx деки)')
  if (!templatePath) throw new Error('templatePath обязателен (.potx/.pptx/.thmx шаблон)')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)
  const st2 = await api.fs.stat(templatePath)
  if (!st2.exists) throw new Error('Шаблон не найден: ' + templatePath)

  const com = require('../lib/com/powerpoint')
  await com.applyTemplate(p, templatePath)
  return 'Шаблон применён: ' + p + ' ← ' + templatePath + '\n(Мастера/макеты заменены; объекты сохранили позиции. Проверь результат: office_open.)'
}

function registerPptTemplateTools(syntee) {
  syntee.registerTool({
    name: 'ppt_templates',
    description:
      'List available PowerPoint design resources: 10 built-in design THEMES (corporate-blue, midnight, minimal, sunset, forest, elegant, startup, mono, ocean, warm-earth — each with palette, fonts, master decorations) + local template FILES (.pptx/.potx/.thmx: downloaded, user PowerPoint templates, Office built-ins) with their extracted palettes. Use the returned theme id or file path as ppt_create spec.template to get an instantly well-designed deck (masters, backgrounds, default text colors, chart colors).',
    parameters: { type: 'object', properties: {} },
    handler: listTemplates,
  })

  syntee.registerTool({
    name: 'ppt_template_search',
    description:
      'Search the web for FREE PowerPoint templates and download them automatically. Searches fppt.com (free template gallery) by query, extracts direct .pptx download links, downloads files (up to 1 MB) into the plugin template cache, and extracts each template\'s color palette + fonts. Fallback: DuckDuckGo search for direct .pptx links. Returns downloaded file paths ready to use as ppt_create spec.template. If nothing found, use your own web search for a direct .pptx/.potx link and download via ppt_template_download.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search topic, e.g. "business", "education", "medical", "abstract"' },
        limit: { type: 'number', description: 'Max templates to find/download (default 4)' },
        download: { type: 'boolean', description: 'Download found templates (default true; false = just list links)' },
      },
      required: ['query'],
    },
    handler: searchTemplates,
    requiresApproval: true, // сетевой доступ
  })

  syntee.registerTool({
    name: 'ppt_template_download',
    description:
      'Download a PowerPoint template from a DIRECT URL (.pptx/.potx/.thmx, up to 1 MB) into the plugin template cache. Validates the file is a real Office zip, extracts its color palette + fonts. Use when you found a template link via your own web search. The downloaded path can be used as ppt_create spec.template (palette/fonts applied) or ppt_apply_template templatePath (full layout replacement).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Direct http(s) link to the .pptx/.potx/.thmx file' },
        name: { type: 'string', description: 'Optional file name hint for saving' },
      },
      required: ['url'],
    },
    handler: downloadTemplateTool,
    requiresApproval: true, // сетевой доступ
  })

  syntee.registerTool({
    name: 'ppt_apply_template',
    description:
      'Apply a REAL PowerPoint template (.potx/.pptx/.thmx) to an existing .pptx deck via MS PowerPoint COM (ApplyTemplate): replaces slide masters/layouts/theme completely — best fidelity for placeholder-based decks. Objects keep positions but get restyled. For generated decks, prefer ppt_create spec.template (palette integration) first. Requires PowerPoint installed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the .pptx deck' },
        templatePath: { type: 'string', description: 'Absolute path to the template .potx/.pptx/.thmx' },
      },
      required: ['path', 'templatePath'],
    },
    handler: applyTemplateTool,
    requiresApproval: true, // запускает реальный PowerPoint и мутирует файл
  })
}

module.exports = { registerPptTemplateTools, listTemplates, searchTemplates, downloadTemplateTool, applyTemplateTool }
