// wordRead — тул word_read: чтение .docx (structure | text | full | stats)
// Встроенные картинки извлекаются в файлы (path), base64 в контекст не попадает.
const nodePath = require('path')
const state = require('../state')
const recent = require('../lib/recent')

/** Папка для извлечённых картинок: {pluginDir}/cache/media (переживает resync). */
function mediaDir() {
  const api = state.api
  return api && api.pluginDir
    ? nodePath.join(api.pluginDir, 'cache', 'media')
    : undefined // дефолт read.js: os.tmpdir()/office-tools-media
}

async function readWord({ path: p, mode }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)

  const reader = require('../lib/word/read') // лениво: mammoth ставится при старте
  const m = mode || 'structure'
  const res = await reader.readDocument(p, m, { imageDir: mediaDir() })

  // Журнал + превью панели
  if (res.stats) {
    await recent.add({
      path: p,
      kind: 'word',
      op: 'read',
      name: p.split(/[\\/]/).pop(),
      size: st.size,
      stats: res.stats,
      outline: res.outline || null,
    })
  }

  let out = typeof res === 'string' ? res : JSON.stringify(res, null, 1)

  // Подсказка: куда извлечены картинки (analyze_image по этим путям)
  if (res.images && res.images.length) {
    const list = res.images.map((im) => '  [' + im.index + '] ' + im.path).join('\n')
    out += '\nКартинки извлечены в файлы (смотреть через analyze_image):\n' + list
  }
  return out
}

function registerWordReadTools(syntee) {
  syntee.registerTool({
    name: 'word_read',
    description:
      'Read a .docx file. Modes: "structure" (document outline: headings tree + block indexes + previews — default), "text" (plain text), "full" (full JSON spec of content, suitable for rebuilding via word_create / word_edit), "stats" (pages/words/paragraphs/tables/images). Embedded images are NEVER returned as base64 — they are extracted to files and returned as paths (res.images list) which you can view via analyze_image. Use before word_edit to locate blocks.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx' },
        mode: { type: 'string', enum: ['structure', 'text', 'full', 'stats'] },
      },
      required: ['path'],
    },
    handler: readWord,
  })
}

module.exports = { registerWordReadTools, readWord, mediaDir }
