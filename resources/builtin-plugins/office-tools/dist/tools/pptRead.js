// pptRead — тул ppt_read: чтение .pptx (meta | slides | full)
// Картинки извлекаются в файлы (path), base64 в контекст не попадает.
const nodePath = require('path')
const state = require('../state')
const recent = require('../lib/recent')

/** Папка для извлечённых картинок: {pluginDir}/cache/media. */
function mediaDir() {
  const api = state.api
  return api && api.pluginDir
    ? nodePath.join(api.pluginDir, 'cache', 'media')
    : undefined
}

async function readPpt({ path: p, mode }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)

  const reader = require('../lib/ppt/read') // лениво: adm-zip уже в зависимостях
  const m = mode || 'slides'
  const res = reader.readPresentation(p, m, { imageDir: mediaDir() })

  if (m === 'meta' || m === 'slides') {
    await recent.add({
      path: p,
      kind: 'ppt',
      op: 'read',
      name: p.split(/[\\/]/).pop(),
      size: st.size,
      stats: m === 'meta' ? res : { slides: res.slideCount },
    })
  }

  let out = JSON.stringify(res, null, 1)

  // Подсказка: куда извлечены картинки
  if (res.images && res.images.length) {
    const list = res.images.map((im) => '  [' + im.index + '] ' + im.path).join('\n')
    out += '\nКартинки извлечены в файлы (смотреть через analyze_image):\n' + list
  }
  return out
}

function registerPptReadTools(syntee) {
  syntee.registerTool({
    name: 'ppt_read',
    description:
      'Read a .pptx presentation. Modes: "meta" (slide count, size, title, hidden count, slide titles), "slides" (DEFAULT: per-slide texts + speaker notes + hidden flags — compact deck content), "full" (all objects with positions in inches: text shapes, tables with rows, charts with series data, images extracted to files). Use before ppt_edit to locate slides/text, or to understand an existing deck. Images are NEVER returned as base64 — extracted to files (res.images paths) viewable via analyze_image.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .pptx' },
        mode: { type: 'string', enum: ['meta', 'slides', 'full'] },
      },
      required: ['path'],
    },
    handler: readPpt,
  })
}

module.exports = { registerPptReadTools, readPpt }
