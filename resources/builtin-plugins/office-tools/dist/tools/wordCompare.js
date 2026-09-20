// wordCompare — тул word_compare: сравнение двух .docx (только чтение, без approval)
const state = require('../state')

/** Одна деталь дифа → строка. */
function formatDetail(d) {
  const mark = d.kind === 'added' ? '+' : d.kind === 'removed' ? '−' : '~'
  const idx = d.index != null ? '[' + d.index + '] ' : ''
  if (d.kind === 'changed') return mark + ' ' + idx + cut120(d.oldText) + '  →  ' + cut120(d.newText)
  return mark + ' ' + idx + cut120(d.newText != null ? d.newText : d.oldText)
}

const cut120 = (s) => (String(s || '').length > 120 ? String(s).slice(0, 119) + '…' : String(s || ''))

async function compareWord({ path: p1, path2: p2, mode }) {
  if (!p1) throw new Error('path обязателен')
  if (!p2) throw new Error('path2 обязателен')
  const api = state.api
  for (const p of [p1, p2]) {
    const st = await api.fs.stat(p)
    if (!st.exists) throw new Error('Файл не найден: ' + p)
  }

  const { compareDocuments } = require('../lib/word/compare')
  const res = await compareDocuments(p1, p2, { mode })
  const lines = [res.summary]
  for (const d of res.details.slice(0, 50)) lines.push(formatDetail(d))
  if (res.details.length > 50) lines.push('… и ещё ' + (res.details.length - 50) + ' изменений')
  return lines.join('\n')
}

function registerWordCompareTools(syntee) {
  syntee.registerTool({
    name: 'word_compare',
    description:
      'Compare two .docx documents and show differences. Mode "blocks" (default): structural diff by content blocks (added/removed/changed paragraphs, headings, tables, lists). Mode "text": line-by-line diff of raw text. Read-only, returns summary + up to 50 change details.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to first .docx' },
        path2: { type: 'string', description: 'Absolute path to second .docx' },
        mode: { type: 'string', enum: ['blocks', 'text'], description: 'Diff mode (default "blocks")' },
      },
      required: ['path', 'path2'],
    },
    handler: compareWord,
    requiresApproval: false, // только чтение
  })
}

module.exports = { registerWordCompareTools, compareWord }
