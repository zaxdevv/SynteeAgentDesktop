// wordEdit — тулы word_edit / word_append: гранулярные правки существующих .docx
const state = require('../state')
const recent = require('../lib/recent')
const settings = require('../lib/settings')

/** Настройки вёрстки пользователя (layoutDefaults), если они поддерживаются сборкой. */
async function layoutDefaultsOrNull() {
  if (typeof settings.layoutDefaults !== 'function') return undefined
  try { return await settings.layoutDefaults() } catch { return undefined }
}

async function editWord({ path: p, ops }) {
  if (!p) throw new Error('path обязателен')
  if (!Array.isArray(ops) || !ops.length) throw new Error('ops (массив операций) обязателен')
  const api = state.api
  const st = await api.fs.stat(p)
  if (!st.exists) throw new Error('Файл не найден: ' + p)

  const editor = require('../lib/word/edit')
  const res = await editor.applyOps(p, ops, await layoutDefaultsOrNull())

  const st2 = await api.fs.stat(p)
  await recent.add({
    path: p,
    kind: 'word',
    op: 'edit',
    name: p.split(/[\\/]/).pop(),
    size: st2.size,
    stats: res.stats,
    outline: res.outline,
  })
  return JSON.stringify(res, null, 1)
}

async function appendWord({ path: p, blocks }) {
  return editWord({ path: p, ops: [{ op: 'append_blocks', blocks }] })
}

function registerWordEditTools(syntee) {
  syntee.registerTool({
    name: 'word_edit',
    description:
      'Apply granular edit operations to an existing .docx. Page setup (size, orientation, margins, columns) is preserved on rebuild. Content ops: append_blocks, insert_after, insert_at (insert BEFORE index), replace_block, move_block, delete_block, replace_text, find_text (returns matching block indexes, read-only), set_style (paragraph-level), set_run_style (inline style of a text fragment via find+style, or all runs), insert_table, add_table_row (cells array, optional at), delete_table_row (row index), merge_cells (range like "A1:B2"), insert_list (items + ordered), insert_math (LaTeX formula: \\frac, \\sqrt, \\sum, greek, matrices — native Word equation), add_image, add_header/add_footer, remove_header/remove_footer, patch_document. Page/typography ops: set_page (merge page setup: size/orientation/margins/columns), add_watermark (text, color, opacity, diagonal), remove_watermark, set_typography (firstLineIndent, compactLists, smartBreaks). Call word_read mode "structure"/"full" first to get block indexes, or use find_text to locate them. Existing formulas are preserved on rebuild (read as LaTeX math blocks).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx' },
        ops: { type: 'array', description: 'Array of edit operations, applied in order', items: { type: 'object' } },
      },
      required: ['path', 'ops'],
    },
    handler: editWord,
    requiresApproval: true, // мутирует файл пользователя
  })

  syntee.registerTool({
    name: 'word_append',
    description:
      'Append content blocks (same format as word_create spec.content) to the end of an existing .docx. Shortcut for word_edit with op append_blocks.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx' },
        blocks: { type: 'array', description: 'Blocks to append (word_create spec format)' },
      },
      required: ['path', 'blocks'],
    },
    handler: appendWord,
    requiresApproval: true,
  })
}

module.exports = { registerWordEditTools, editWord, appendWord }
