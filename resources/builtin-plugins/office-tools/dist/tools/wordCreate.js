// wordCreate — тул word_create: .docx из JSON-спеки + word_spec_docs
const state = require('../state')
const paths = require('../lib/paths')
const settings = require('../lib/settings')
const recent = require('../lib/recent')
const widgets = require('../ui/widgets')

/** ctx для spec-сборщика: чтение картинок (base64) через fs хоста +
 *  layout-дефолты из настроек плагина (поля/красная строка/списки/разрывы). */
async function makeCtx() {
  const api = state.api
  const defaults = await settings.layoutDefaults()
  return {
    defaults,
    async readImage(p) {
      const b64 = await api.fs.readFile(p, { encoding: 'base64' })
      const ext = (p.split('.').pop() || 'png').toLowerCase()
      return { base64: b64, ext }
    },
  }
}

/** Создание файла. Возвращает маркер виджета-карточки (+ текст при open). */
async function createWordFile({ path: p, name, spec, open }) {
  const api = state.api
  if (!spec || !Array.isArray(spec.content)) {
    throw new Error('spec.content (массив блоков) обязателен. Формат спеки: тул word_spec_docs')
  }
  // Ленивый require: пакет docx ставится при первом запуске плагина
  const builder = require('../lib/word/spec')
  const target = await paths.resolveTarget({ path: p, name, ext: '.docx' })

  const built = await builder.buildDocument(spec, await makeCtx())
  await api.fs.writeFile(target, Buffer.from(built.buffer).toString('base64'), { encoding: 'base64' })

  const st = await api.fs.stat(target)
  const entry = await recent.add({
    path: target,
    kind: 'word',
    op: 'create',
    name: target.split(/[\\/]/).pop(),
    size: st.size,
    stats: built.stats,
    outline: built.outline,
  })

  let extra = ''
  if (open) {
    try {
      const com = require('../lib/com/word')
      await com.openDoc(target)
    } catch (e) {
      extra = '\n(Word не открылся: ' + e.message + ')'
    }
  }

  const s = await settings.get()
  if (!s.showPreview) {
    return 'Создан файл: ' + target + '\n' + JSON.stringify(built.stats) + extra
  }
  return widgets.fileCard({ entry }) + extra
}

function registerWordTools(syntee) {
  syntee.registerTool({
    name: 'word_create',
    description:
      'Create a Word .docx document from a JSON spec. Supports: headings, paragraphs with full run styling (bold/italic/underline/strike, font, size, color, highlight, sub/superscript), alignment, spacing, bullet/numbered/multilevel lists, tables (borders, cell fills, merged cells, column widths, header row), images, hyperlinks, MATH FORMULAS in LaTeX (\\frac, \\sqrt, \\sum/\\int with limits, greek letters, matrices, cases — native Word equations, block or inline), page breaks, table of contents, headers/footers with page numbers, page setup (A4/Letter, margins, orientation). Call word_spec_docs first for the exact spec format. Returns a file card widget with stats and open/PDF buttons.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute output .docx path. Omit to auto-save into the configured save dir' },
        name: { type: 'string', description: 'File name without extension (used when path omitted)' },
        spec: {
          type: 'object',
          description: 'Document spec: { page?, styles?, numbering?, header?, footer?, content: [blocks] }. See word_spec_docs',
        },
        open: { type: 'boolean', description: 'Open the file in MS Word after creation (default false)' },
      },
      required: ['spec'],
    },
    handler: createWordFile,
  })

  syntee.registerTool({
    name: 'word_spec_docs',
    description:
      'Returns the full reference for the word_create JSON spec format: all block types, run/paragraph styling options, table options, page setup, numbering, headers/footers. Read it before building complex documents.',
    parameters: { type: 'object', properties: {} },
    handler: async () => require('../lib/word/specDoc').specDoc(),
  })
}

module.exports = { registerWordTools, createWordFile }
