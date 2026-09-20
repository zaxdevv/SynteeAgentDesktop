// templateLib — библиотека шаблонов PowerPoint:
//   extractTheme — палитра+шрифты из .pptx/.potx/.thmx (theme1.xml)
//   scanLocalTemplates — файлы в известных папках (скачанные, пользовательские, Office)
//   downloadTemplate — скачивание .pptx/.potx по прямому URL (через api.net.fetch)
//   isOfficeZip — валидация буфера
//
// Скачанные шаблоны: {pluginDir}/cache/templates (переживает resync).

const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const { luminance, normHex } = require('./themes')

const DOWNLOADED_DIR_NAME = path.join('cache', 'templates')

/** Папка скачанных шаблонов. */
function downloadedDir(pluginDir) {
  return pluginDir ? path.join(pluginDir, DOWNLOADED_DIR_NAME) : null
}

/** Валиден ли буфер как Office Open XML (zip с ppt/ или theme/). */
function isOfficeZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 100) return false
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return false // PK
  try {
    const zip = new AdmZip(buf)
    const names = zip.getEntries().map((e) => e.entryName)
    return names.some((n) => n === 'ppt/presentation.xml' || n === 'ppt/theme/theme1.xml' || n === 'theme/theme1.xml' || n === '[Content_Types].xml')
  } catch {
    return false
  }
}

/** Цвет из узла clrScheme: <a:srgbClr val="FF0000"/> | <a:sysClr lastClr="000000"/>. */
function colorFromNode(xml) {
  const srgb = /<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/.exec(xml)
  if (srgb) return normHex(srgb[1])
  const sys = /<a:sysClr\b[^>]*lastClr="([0-9A-Fa-f]{6})"/.exec(xml)
  if (sys) return normHex(sys[1])
  return null
}

/**
 * Извлечь тему (палитра + шрифты) из файла шаблона.
 * @param {string} filePath .pptx / .potx / .thmx
 * @returns {{ colors: object, fonts: object, style: 'dark'|'light', sourceFile: string }}
 */
function extractTheme(filePath) {
  const zip = new AdmZip(filePath)
  let themeXml = zip.readAsText('ppt/theme/theme1.xml')
  if (!themeXml) themeXml = zip.readAsText('theme/theme1.xml') // .thmx
  if (!themeXml) {
    // fallback: первый theme*.xml
    const entry = zip.getEntries().find((e) => /theme\d*\.xml$/.test(e.entryName) && e.entryName.includes('theme'))
    if (entry) themeXml = zip.readAsText(entry.entryName)
  }
  if (!themeXml) throw new Error('Не удалось найти theme1.xml — файл не похож на шаблон Office')

  // Палитра
  const scheme = /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(themeXml)
  if (!scheme) throw new Error('В theme1.xml нет clrScheme')
  const node = (name) => {
    const m = new RegExp('<a:' + name + '\\b[^>]*>([\\s\\S]*?)</a:' + name + '>').exec(scheme[1])
    return m ? colorFromNode(m[1]) : null
  }
  const dk1 = node('dk1') || '000000'
  const lt1 = node('lt1') || 'FFFFFF'
  const accent1 = node('accent1') || '4472C4'
  const accent2 = node('accent2') || 'ED7D31'
  const accent3 = node('accent3') || 'A5A5A5'
  const accent4 = node('accent4') || 'FFC000'

  // Шрифты
  const major = /<a:majorFont>[\s\S]*?<a:latin\s+typeface="([^"]*)"/.exec(themeXml)
  const minor = /<a:minorFont>[\s\S]*?<a:latin\s+typeface="([^"]*)"/.exec(themeXml)

  // Стиль: светлая тема — тёмный текст на светлом фоне (dk1 тёмный и lt1 светлый)
  const style = luminance(lt1) > 0.5 && luminance(dk1) < 0.5 ? 'light' : 'dark'
  const text = style === 'light' ? dk1 : lt1
  const bg = style === 'light' ? lt1 : dk1

  return {
    colors: {
      bg,
      bgAlt: style === 'light' ? 'F2F2F2' : '262626',
      accent: accent1,
      accent2,
      text,
      textMuted: style === 'light' ? '595959' : 'A6A6A6',
      onAccent: 'FFFFFF',
    },
    fonts: {
      head: major && major[1] ? major[1] : 'Calibri',
      body: minor && minor[1] ? minor[1] : 'Calibri',
    },
    style,
    sourceFile: filePath,
  }
}

/** Известные папки локальных шаблонов. */
function templateDirs(pluginDir) {
  const dirs = []
  const dl = downloadedDir(pluginDir)
  if (dl) dirs.push({ dir: dl, source: 'downloaded', title: 'Скачанные (ppt_template_search/download)' })
  const appData = process.env.APPDATA
  if (appData) {
    dirs.push({ dir: path.join(appData, 'Microsoft', 'Templates'), source: 'user', title: 'Мои шаблоны PowerPoint' })
  }
  for (const prog of ['C:\\Program Files\\Microsoft Office\\root\\Office16\\PUBREP', 'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\PUBREP']) {
    if (fs.existsSync(prog)) dirs.push({ dir: prog, source: 'office', title: 'Встроенные шаблоны Office' })
  }
  return dirs
}

/** Рекурсивный поиск шаблонов (глубина ≤ 2, максимум max файлов на папку). */
function findTemplateFiles(dir, depth, max, out) {
  if (depth > 2 || out.length >= max) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= max) return
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === 'cache') continue
      findTemplateFiles(p, depth + 1, max, out)
    } else if (/\.(pptx|potx|thmx|ppt)$/i.test(e.name)) {
      out.push(p)
    }
  }
}

/**
 * Скан локальных шаблонов: скачанные + пользовательские + Office.
 * @returns {Array<{ path, name, source, size, theme }>} theme может быть null при ошибке чтения
 */
function scanLocalTemplates(pluginDir) {
  const res = []
  for (const { dir, source } of templateDirs(pluginDir)) {
    if (!fs.existsSync(dir)) continue
    const files = []
    findTemplateFiles(dir, 0, 40, files)
    for (const f of files) {
      let theme = null
      let size = 0
      try {
        size = fs.statSync(f).size
        if (/\.(pptx|potx|thmx)$/i.test(f)) theme = extractTheme(f)
      } catch { /* битый/нечитаемый — пропускаем тему */ }
      res.push({
        path: f,
        name: path.basename(f),
        source,
        size,
        ...(theme ? { theme: { colors: theme.colors, fonts: theme.fonts, style: theme.style } } : {}),
      })
    }
  }
  return res
}

/** Санитизация имени файла. */
function safeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/** Найти .pptx/.potx/.ppt внутри zip-архива (старые fppt-шаблоны упакованы в zip).
 *  Приоритет: .pptx > .potx > .ppt. Возвращает { buf, name } | null. */
function extractPptxFromZip(buf) {
  try {
    const zip = new AdmZip(buf)
    const entries = zip.getEntries().map((e) => e.entryName).filter((n) => !n.startsWith('__MACOSX'))
    const pick = (ext) => entries.find((n) => n.toLowerCase().endsWith(ext) && !n.split('/').pop().startsWith('.'))
    const found = pick('.pptx') || pick('.potx') || pick('.ppt')
    if (!found) return null
    return { buf: zip.readFile(found), name: found.split('/').pop() }
  } catch {
    return null
  }
}

/**
 * Скачать шаблон по прямому URL в cache/templates.
 * @param {Function} fetchImpl api.net.fetch
 * @param {string} url прямой URL .pptx/.potx/.thmx/.ppt (или go-эндпоинт с редиректом)
 * @param {object} [opts] { name, dir, headers } — имя, папка, доп. headers (Referer и т.п.)
 * @returns {Promise<{ path, name, size, url }>}
 */
async function downloadTemplate(fetchImpl, url, opts) {
  if (!fetchImpl) throw new Error('net недоступен (нет права net у плагина)')
  if (!/^https?:\/\//.test(url)) throw new Error('URL должен начинаться с http:// или https://')

  const r = await fetchImpl(url, {
    binary: true,
    ...(opts && opts.headers ? { headers: opts.headers } : {}),
  })
  if (r.status >= 400) throw new Error('HTTP ' + r.status + ' при скачивании ' + url)
  if (!r.bodyBase64) throw new Error('Пустой ответ от ' + url)

  // Обрезка 1 МБ (лимит net.fetch): проверяем content-length
  const contentLength = Number(r.headers['content-length'] || 0)
  let buf = Buffer.from(r.bodyBase64, 'base64')
  if (contentLength && contentLength > 1048576) {
    throw new Error('Файл больше 1 МБ (' + Math.round(contentLength / 1024) + ' КБ) — лимит скачивания плагина. Скачай вручную и укажи путь, или используй меньший шаблон')
  }
  if (buf.length >= 1048576 - 1024) {
    throw new Error('Файл достиг лимита скачивания 1 МБ — вероятно, обрезан и повреждён')
  }
  if (!isOfficeZip(buf)) {
    // Может быть zip-архив с шаблоном внутри (старые fppt-шаблоны) — распаковываем
    const inner = extractPptxFromZip(buf)
    if (!inner) {
      throw new Error('По URL не Office-файл (не zip с ppt/): ' + url.slice(0, 120))
    }
    buf = inner.buf
    if (!opts || !opts.name) opts = { ...(opts || {}), name: inner.name }
  }

  // Имя: подсказка → из URL → fallback
  let name = safeName(opts && opts.name)
  if (!name) {
    const fromUrl = safeName(decodeURIComponent(url.split('?')[0].split('/').pop() || ''))
    if (/\.(pptx|potx|thmx|ppt)$/i.test(fromUrl)) name = fromUrl
    else name = 'template-' + Date.now() + '.pptx'
  }
  if (!/\.(pptx|potx|thmx|ppt)$/i.test(name)) {
    const ext = /\.thmx$/i.test(url) ? '.thmx' : /\.potx$/i.test(url) ? '.potx' : '.pptx'
    name += ext
  }

  const dir = opts && opts.dir
  fs.mkdirSync(dir, { recursive: true })
  // Уникализация
  let target = path.join(dir, name)
  let i = 2
  while (fs.existsSync(target)) {
    const ext2 = path.extname(name)
    target = path.join(dir, path.basename(name, ext2) + ' (' + i + ')' + ext2)
    i++
  }
  fs.writeFileSync(target, buf)
  return { path: target, name: path.basename(target), size: buf.length, url }
}

module.exports = {
  extractTheme,
  scanLocalTemplates,
  downloadTemplate,
  isOfficeZip,
  extractPptxFromZip,
  templateDirs,
  downloadedDir,
  safeName,
}
