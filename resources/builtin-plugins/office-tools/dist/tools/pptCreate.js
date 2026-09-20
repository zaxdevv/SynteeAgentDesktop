// pptCreate — тул ppt_create: .pptx из JSON-спеки + ppt_spec_docs
const state = require('../state')
const paths = require('../lib/paths')
const settings = require('../lib/settings')
const recent = require('../lib/recent')
const widgets = require('../ui/widgets')

/** ctx для spec-сборщика: картинки/медиа читаются через fs хоста (base64). */
async function makeCtx() {
  const api = state.api
  return {
    async readImage(p) {
      const b64 = await api.fs.readFile(p, { encoding: 'base64' })
      const ext = (p.split('.').pop() || 'png').toLowerCase()
      return { base64: b64, ext }
    },
  }
}

/** Создание файла. Возвращает маркер виджета-карточки (+ текст при open). */
async function createPptFile({ path: p, name, spec, template, open }) {
  const api = state.api
  if (!spec || !Array.isArray(spec.slides)) {
    throw new Error('spec.slides (массив слайдов) обязателен. Формат спеки: тул ppt_spec_docs')
  }
  // Тема/шаблон: параметр тула выигрывает над spec.template
  if (template) spec.template = template
  // Ленивый require: пакет pptxgenjs ставится при первом запуске плагина
  const builder = require('../lib/ppt/spec')
  const target = await paths.resolveTarget({ path: p, name, ext: '.pptx' })

  const built = await builder.buildPresentation(spec, await makeCtx())
  await api.fs.writeFile(target, Buffer.from(built.buffer).toString('base64'), { encoding: 'base64' })

  const st = await api.fs.stat(target)
  const entry = await recent.add({
    path: target,
    kind: 'ppt',
    op: 'create',
    name: target.split(/[\\/]/).pop(),
    size: st.size,
    stats: built.stats,
  })

  let extra = ''
  if (open) {
    try {
      const com = require('../lib/com/powerpoint')
      await com.openPres(target)
    } catch (e) {
      extra = '\n(PowerPoint не открылся: ' + e.message + ')'
    }
  }

  const s = await settings.get()
  if (!s.showPreview) {
    return 'Создан файл: ' + target + '\n' + JSON.stringify(built.stats) + extra
  }
  return widgets.fileCard({ entry }) + extra
}

function registerPptTools(syntee) {
  syntee.registerTool({
    name: 'ppt_create',
    description:
      'Create a PowerPoint .pptx presentation from a JSON spec. DESIGN TEMPLATES: pass template (theme id like "midnight"/"corporate-blue"/"sunset" — see ppt_templates for all 10, or a path to a .pptx/.potx template file) to auto-apply masters, backgrounds, default text/chart colors and fonts. Also supports: slide layouts (16x9/4x3/wide/custom), themes (fonts), custom slide MASTERS, per-slide backgrounds (color/image), hidden slides, speaker NOTES, slide numbers, text with full styling (bold/italic/color/font/size, bullets, line spacing, shadows, outlines, vertical text), tables (fills, borders, merged cells, zebra, auto-paging), images (contain/cover/crop, rotation, circle crop), 180+ SHAPES with text inside, NATIVE EDITABLE CHARTS (bar/line/pie/doughnut/area/scatter/bubble/radar/3d/combo), media (video/audio/YouTube embed), slide TRANSITIONS (fade/push/wipe/zoom…, auto-advance). Call ppt_spec_docs first for the exact spec format and design patterns.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute output .pptx path. Omit to auto-save into the configured save dir' },
        name: { type: 'string', description: 'File name without extension (used when path omitted)' },
        template: { type: 'string', description: 'Design template: built-in theme id ("midnight", "corporate-blue", "sunset", "minimal", "forest", "elegant", "startup", "mono", "ocean", "warm-earth" — full list: ppt_templates) or path to .pptx/.potx template file (palette+fonts extracted). Overrides spec.template' },
        spec: {
          type: 'object',
          description: 'Presentation spec: { layout?, title?, author?, theme?, masters?, template?, slides: [{ background?, hidden?, notes?, transition?, objects: [...] }] }. See ppt_spec_docs',
        },
        open: { type: 'boolean', description: 'Open the file in MS PowerPoint after creation (default false)' },
      },
      required: ['spec'],
    },
    handler: createPptFile,
  })

  syntee.registerTool({
    name: 'ppt_spec_docs',
    description:
      'Returns the full reference for the ppt_create JSON spec format: all object types (text/table/image/shape/chart/media), styling options, masters, transitions, chart options, and design patterns for beautiful presentations. Read it before building presentations.',
    parameters: { type: 'object', properties: {} },
    handler: async () => require('../lib/ppt/specDoc').specDoc(),
  })
}

module.exports = { registerPptTools, createPptFile }
