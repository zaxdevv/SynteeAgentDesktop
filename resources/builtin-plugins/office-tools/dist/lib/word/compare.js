// compare — сравнение двух .docx: LCS-диф по блокам (mode 'blocks')
// или по строкам сырого текста (mode 'text'). Без внешних зависимостей диффа.

const mammoth = require('mammoth')
const { readDocument } = require('./read')

/** Текстовая сигнатура блока: type + текст (text/runs/items/rows/title). */
function blockSignature(b) {
  let text = ''
  if (typeof b.text === 'string') text = b.text
  else if (Array.isArray(b.runs)) text = b.runs.map((r) => r.text || '').join('')
  else if (Array.isArray(b.items)) text = b.items.map((i) => (typeof i === 'string' ? i : i.text || '')).join(' · ')
  else if (Array.isArray(b.rows)) {
    text = b.rows.map((row) => row.map((c) => (typeof c === 'string' ? c : c.text || '')).join(' | ')).join(' ;; ')
  } else if (typeof b.title === 'string') text = b.title
  else if (typeof b.url === 'string') text = b.url
  return (b.type || '?') + ':' + String(text).replace(/\s+/g, ' ').trim()
}

/** Человекочитаемый текст по сигнатуре/строке (без типа блока). */
function signatureText(sig) {
  const i = sig.indexOf(':')
  return i > 0 ? sig.slice(i + 1) : sig
}

/**
 * LCS-диф двух массивов строк-сигнатур (O(n*m), классическая DP).
 * @returns {Array<{kind:'same'|'added'|'removed', ai?: number, bi?: number}>}
 */
function lcsDiff(a, b) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', ai: i, bi: j })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'removed', ai: i })
      i++
    } else {
      ops.push({ kind: 'added', bi: j })
      j++
    }
  }
  while (i < n) ops.push({ kind: 'removed', ai: i++ })
  while (j < m) ops.push({ kind: 'added', bi: j++ })
  return ops
}

const cut = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** Диф-операции → { added, removed, changed, details } (removed+added рядом = changed). */
function buildResult(ops, a, b, unitName) {
  const details = []
  let added = 0
  let removed = 0
  let changed = 0
  let k = 0
  while (k < ops.length) {
    const op = ops[k]
    if (op.kind === 'same') { k++; continue }
    // собираем серию подряд идущих removed/added
    const rem = []
    const add = []
    while (k < ops.length && ops[k].kind !== 'same') {
      if (ops[k].kind === 'removed') rem.push(ops[k])
      else add.push(ops[k])
      k++
    }
    // пары removed+added → changed (эвристика: замена)
    while (rem.length && add.length) {
      const r = rem.shift()
      const ad = add.shift()
      changed++
      details.push({
        kind: 'changed',
        oldText: cut(signatureText(a[r.ai]), 120),
        newText: cut(signatureText(b[ad.bi]), 120),
        index: ad.bi,
      })
    }
    for (const r of rem) {
      removed++
      details.push({ kind: 'removed', oldText: cut(signatureText(a[r.ai]), 120), index: r.ai })
    }
    for (const ad of add) {
      added++
      details.push({ kind: 'added', newText: cut(signatureText(b[ad.bi]), 120), index: ad.bi })
    }
  }
  const parts = []
  if (added) parts.push('+' + added + ' добавлено')
  if (removed) parts.push('−' + removed + ' удалено')
  if (changed) parts.push('~' + changed + ' изменено')
  const summary = parts.length
    ? 'Различия (' + unitName + '): ' + parts.join(', ') + ' (документ 1: ' + a.length + ', документ 2: ' + b.length + ')'
    : 'Документы идентичны (' + unitName + ': ' + a.length + ')'
  return { added, removed, changed, details, summary }
}

/**
 * Сравнение двух .docx.
 * @param {string} path1 первый документ
 * @param {string} path2 второй документ
 * @param {object} [opts] { mode = 'blocks' | 'text' }
 * @returns {Promise<{added:number, removed:number, changed:number, details:Array, summary:string}>}
 */
async function compareDocuments(path1, path2, opts) {
  const mode = (opts && opts.mode) || 'blocks'
  if (mode !== 'blocks' && mode !== 'text') {
    throw new Error('Неизвестный режим: ' + mode + ' (blocks | text)')
  }

  if (mode === 'text') {
    const [r1, r2] = await Promise.all([
      mammoth.extractRawText({ path: path1 }),
      mammoth.extractRawText({ path: path2 }),
    ])
    const lines = (t) => t.value.split('\n').map((s) => s.trim()).filter(Boolean)
    const a = lines(r1)
    const b = lines(r2)
    return buildResult(lcsDiff(a, b), a, b, 'строк')
  }

  const [f1, f2] = await Promise.all([
    readDocument(path1, 'full'),
    readDocument(path2, 'full'),
  ])
  const a = f1.spec.content.map(blockSignature)
  const b = f2.spec.content.map(blockSignature)
  return buildResult(lcsDiff(a, b), a, b, 'блоков')
}

module.exports = { compareDocuments, lcsDiff, blockSignature }
