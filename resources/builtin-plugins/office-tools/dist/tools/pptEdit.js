// pptEdit — тул ppt_edit: XML-правки существующего .pptx (lossless для форматирования)
const state = require('../state')
const recent = require('../lib/recent')

async function editPpt({ path: p, ops }) {
  if (!p) throw new Error('path обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)

  const editor = require('../lib/ppt/edit')
  const res = editor.applyOps(p, ops)

  const st2 = await api.fs.stat(p)
  await recent.add({
    path: p,
    kind: 'ppt',
    op: 'edit',
    name: p.split(/[\\/]/).pop(),
    size: st2.size,
    stats: { slides: res.slideCount },
  })

  return (
    'Правки применены: ' + p + '\n' +
    res.applied.map((s) => '  • ' + s).join('\n') +
    '\nСлайдов теперь: ' + res.slideCount +
    (res.bak ? '\nБэкап: ' + res.bak : '')
  )
}

function registerPptEditTools(syntee) {
  syntee.registerTool({
    name: 'ppt_edit',
    description:
      'Edit an existing .pptx with granular XML-level operations (formatting of untouched content is preserved). Ops: find_replace {find, replace} (all slides + notes; text inside one run — use office-level replace via rebuilding if text spans styled runs), set_notes {slide, notes} (creates notes slide if missing), delete_slide {slide}, move_slide {slide, to} (1-based positions), hide_slide {slide, hidden?} (default true), set_transition {slide?, transition} (slide omitted = ALL slides: {type: "fade"|"push"|…, dir?, spd?, advanceAfterMs?}). Slide numbers are 1-based in presentation order (see ppt_read). A .bak backup is written next to the file. To ADD slides to an existing deck: read it with ppt_read, then rebuild via ppt_create with the extra slides.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .pptx' },
        ops: {
          type: 'array',
          description: 'Operations array, applied in order: [{ op: "find_replace", find: "…", replace: "…" }, { op: "set_notes", slide: 1, notes: "…" }, { op: "delete_slide", slide: 3 }, { op: "move_slide", slide: 5, to: 2 }, { op: "hide_slide", slide: 4 }, { op: "set_transition", transition: { type: "fade" } }]',
        },
      },
      required: ['path', 'ops'],
    },
    handler: editPpt,
  })
}

module.exports = { registerPptEditTools, editPpt }
