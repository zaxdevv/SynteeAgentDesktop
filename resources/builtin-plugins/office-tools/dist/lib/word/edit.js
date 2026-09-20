// edit — гранулярные правки .docx: read full-спека → применение ops →
// пересборка через buildDocument → перезапись файла.

const fs = require('fs')
const { readDocument } = require('./read')
const { buildDocument } = require('./spec')
const { collectText } = require('./blocks')
const { backupFile } = require('../backup')

/** ctx для пересборки: картинки читаются напрямую через fs; defaults — настройки вёрстки. */
function makeCtx(defaults) {
  const ctx = {
    async readImage(p) {
      const b64 = fs.readFileSync(p).toString('base64')
      const ext = (String(p).split('.').pop() || 'png').toLowerCase()
      return { base64: b64, ext }
    },
  }
  if (defaults) ctx.defaults = defaults
  return ctx
}

/** Глубокий мердж page-настроек: margins/watermark — по ключам, остальное — присваиванием. */
function mergePage(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined || value === null) continue
    if ((key === 'margins' || key === 'watermark') && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = { ...(target[key] || {}), ...value }
    } else {
      target[key] = value
    }
  }
}

/** Рекурсивная замена find→replace во всех строковых полях text/title. */
function replaceDeep(node, find, replace, once, counter) {
  if (counter.done) return
  if (Array.isArray(node)) {
    for (const item of node) replaceDeep(item, find, replace, once, counter)
    return
  }
  if (!node || typeof node !== 'object') return
  for (const key of ['text', 'title']) {
    if (typeof node[key] === 'string' && node[key].includes(find)) {
      node[key] = once ? node[key].replace(find, replace) : node[key].split(find).join(replace)
      counter.n++
      if (once) { counter.done = true; return }
    }
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') replaceDeep(v, find, replace, once, counter)
    if (counter.done) return
  }
}

function checkIndex(content, index, op) {
  if (!Number.isInteger(index) || index < 0 || index >= content.length) {
    throw new Error(op + ': индекс ' + index + ' вне диапазона 0..' + (content.length - 1))
  }
}

/** Плоский текст блока (text/runs/items/rows) — для find_text. */
function collectBlockText(block) {
  return collectText(block, []).join(' ')
}

function insertAt(content, after, blocks, opName) {
  if (after === undefined || after === null || after === -1) {
    content.push(...blocks)
    return 'добавлено в конец'
  }
  checkIndex(content, after, opName)
  content.splice(after + 1, 0, ...blocks)
  return 'вставлено после блока ' + after
}

/**
 * Применяет операции к .docx и перезаписывает файл.
 * @param {string} path абсолютный путь до .docx
 * @param {Array} ops операции (в порядке применения)
 * @param {object} [defaults] настройки вёрстки (settings.layoutDefaults) → ctx.buildDocument
 * @returns {Promise<{stats: object, outline: Array, applied: string[]}>}
 */
async function applyOps(path, ops, defaults) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('ops (массив операций) обязателен')
  const full = await readDocument(path, 'full')
  const spec = full.spec
  const applied = []

  for (const op of ops) {
    const name = op && op.op
    switch (name) {
      case 'append_blocks': {
        if (!Array.isArray(op.blocks) || !op.blocks.length) throw new Error('append_blocks: blocks обязателен')
        spec.content.push(...op.blocks)
        applied.push('append_blocks: +' + op.blocks.length)
        break
      }
      case 'insert_after': {
        const blocks = op.blocks || (op.block ? [op.block] : null)
        if (!blocks || !blocks.length) throw new Error('insert_after: block или blocks обязателен')
        applied.push('insert_after: ' + insertAt(spec.content, op.index, blocks, 'insert_after'))
        break
      }
      case 'replace_text': {
        if (!op.find) throw new Error('replace_text: find обязателен')
        const counter = { n: 0, done: false }
        replaceDeep(spec.content, String(op.find), String(op.replace ?? ''), op.all === false, counter)
        applied.push('replace_text "' + op.find + '": ' + counter.n + ' замен')
        break
      }
      case 'set_style': {
        checkIndex(spec.content, op.index, 'set_style')
        const b = spec.content[op.index]
        if (b.type !== 'paragraph' && b.type !== 'heading') {
          throw new Error('set_style: блок ' + op.index + ' имеет тип ' + b.type + ' (нужен paragraph)')
        }
        b.style = { ...(b.style || {}), ...(op.style || {}) }
        applied.push('set_style: блок ' + op.index)
        break
      }
      case 'insert_table': {
        if (!op.table || !Array.isArray(op.table.rows)) throw new Error('insert_table: table.rows обязателен')
        applied.push('insert_table: ' + insertAt(spec.content, op.after, [{ type: 'table', ...op.table }], 'insert_table'))
        break
      }
      case 'add_image': {
        if (!op.image) throw new Error('add_image: image обязателен')
        applied.push('add_image: ' + insertAt(spec.content, op.after, [{ type: 'image', ...op.image }], 'add_image'))
        break
      }
      case 'add_header': {
        if (!Array.isArray(op.blocks)) throw new Error('add_header: blocks обязателен')
        spec.header = { blocks: op.blocks }
        applied.push('add_header: ' + op.blocks.length + ' блоков')
        break
      }
      case 'add_footer': {
        if (!Array.isArray(op.blocks)) throw new Error('add_footer: blocks обязателен')
        spec.footer = { blocks: op.blocks, ...(op.pageNumber ? { pageNumber: op.pageNumber } : {}) }
        applied.push('add_footer: ' + op.blocks.length + ' блоков' + (op.pageNumber ? ' + номер страницы' : ''))
        break
      }
      case 'delete_block': {
        checkIndex(spec.content, op.index, 'delete_block')
        const removed = spec.content.splice(op.index, 1)
        applied.push('delete_block: ' + op.index + ' (' + removed[0].type + ')')
        break
      }
      case 'patch_document': {
        if (!Array.isArray(op.content)) throw new Error('patch_document: content обязателен')
        spec.content = op.content
        applied.push('patch_document: ' + op.content.length + ' блоков')
        break
      }
      case 'set_page': {
        if (!op.page || typeof op.page !== 'object') throw new Error('set_page: page (объект) обязателен')
        spec.page = spec.page || {}
        mergePage(spec.page, op.page)
        applied.push('set_page: ' + Object.keys(op.page).join(', '))
        break
      }
      case 'add_watermark': {
        if (!op.text) throw new Error('add_watermark: text обязателен')
        spec.page = spec.page || {}
        spec.page.watermark = {
          text: op.text,
          ...(op.color ? { color: op.color } : {}),
          ...(op.opacity != null ? { opacity: op.opacity } : {}),
          ...(op.diagonal != null ? { diagonal: op.diagonal } : {}),
        }
        applied.push('add_watermark: "' + op.text + '"')
        break
      }
      case 'remove_watermark': {
        if (spec.page) delete spec.page.watermark
        applied.push('remove_watermark')
        break
      }
      case 'set_typography': {
        const keys = ['firstLineIndent', 'compactLists', 'smartBreaks'].filter((k) => op[k] !== undefined)
        if (!keys.length) throw new Error('set_typography: нужен firstLineIndent | compactLists | smartBreaks')
        spec.page = spec.page || {}
        for (const k of keys) spec.page[k] = op[k]
        applied.push('set_typography: ' + keys.join(', '))
        break
      }
      case 'insert_at': {
        if (!Array.isArray(op.blocks) || !op.blocks.length) throw new Error('insert_at: blocks обязателен')
        const idx = op.index
        if (!Number.isInteger(idx) || idx < 0 || idx > spec.content.length) {
          throw new Error('insert_at: индекс ' + idx + ' вне диапазона 0..' + spec.content.length)
        }
        if (idx === spec.content.length) spec.content.push(...op.blocks)
        else spec.content.splice(idx, 0, ...op.blocks)
        applied.push('insert_at: ' + op.blocks.length + ' блок(ов) перед ' + idx)
        break
      }
      case 'replace_block': {
        if (!op.block || !op.block.type) throw new Error('replace_block: block (с type) обязателен')
        checkIndex(spec.content, op.index, 'replace_block')
        spec.content[op.index] = op.block
        applied.push('replace_block: ' + op.index + ' → ' + op.block.type)
        break
      }
      case 'move_block': {
        checkIndex(spec.content, op.from, 'move_block (from)')
        const to = op.to
        if (!Number.isInteger(to) || to < 0 || to > spec.content.length - 1) {
          throw new Error('move_block: to ' + to + ' вне диапазона 0..' + (spec.content.length - 1))
        }
        const [item] = spec.content.splice(op.from, 1)
        spec.content.splice(to, 0, item)
        applied.push('move_block: ' + op.from + ' → ' + to)
        break
      }
      case 'remove_header': {
        delete spec.header
        applied.push('remove_header')
        break
      }
      case 'remove_footer': {
        delete spec.footer
        applied.push('remove_footer')
        break
      }
      case 'find_text': {
        if (!op.find) throw new Error('find_text: find обязателен')
        const needle = String(op.find)
        const results = []
        spec.content.forEach((block, idx) => {
          const text = collectBlockText(block)
          if (text && text.includes(needle)) {
            results.push({ index: idx, type: block.type, preview: text.replace(/\s+/g, ' ').trim().substring(0, 80) })
          }
        })
        applied.push(
          'find_text "' + needle + '": ' + results.length + ' совпадений ' + JSON.stringify(results),
        )
        break
      }
      case 'set_run_style': {
        checkIndex(spec.content, op.index, 'set_run_style')
        const b = spec.content[op.index]
        if (b.type !== 'paragraph' && b.type !== 'heading') {
          throw new Error('set_run_style: блок ' + op.index + ' имеет тип ' + b.type + ' (нужен paragraph/heading)')
        }
        // Плоский текст → runs, чтобы можно было стилизовать фрагмент
        if (!Array.isArray(b.runs) && b.text != null) {
          b.runs = [{ text: String(b.text) }]
          delete b.text
        }
        if (!Array.isArray(b.runs)) b.runs = []
        if (op.find) {
          const needle = String(op.find)
          let found = false
          const newRuns = []
          for (const run of b.runs) {
            if (!found && run && typeof run.text === 'string' && run.text.includes(needle)) {
              const parts = run.text.split(needle)
              const base = { ...run }
              delete base.style
              if (parts[0]) newRuns.push({ ...base, text: parts[0] })
              newRuns.push({ ...base, text: needle, style: { ...(run.style || {}), ...(op.style || {}) } })
              if (parts[1]) newRuns.push({ ...base, text: parts.slice(1).join(needle) })
              found = true
            } else {
              newRuns.push(run)
            }
          }
          if (found) b.runs = newRuns
          applied.push('set_run_style: ' + (found ? 'применён к "' + needle + '" в блоке ' + op.index : 'текст "' + needle + '" не найден в блоке ' + op.index))
        } else {
          for (const run of b.runs) {
            if (run && typeof run === 'object') run.style = { ...(run.style || {}), ...(op.style || {}) }
          }
          applied.push('set_run_style: все runs блока ' + op.index)
        }
        break
      }
      case 'add_table_row': {
        checkIndex(spec.content, op.index, 'add_table_row')
        const b = spec.content[op.index]
        if (b.type !== 'table') throw new Error('add_table_row: блок ' + op.index + ' имеет тип ' + b.type + ' (нужен table)')
        if (!Array.isArray(b.rows)) b.rows = []
        const newRow = Array.isArray(op.cells)
          ? op.cells.map((c) => (c && typeof c === 'object' ? c : { text: String(c ?? '') }))
          : []
        if (op.at != null) {
          if (!Number.isInteger(op.at) || op.at < 0 || op.at > b.rows.length) {
            throw new Error('add_table_row: at ' + op.at + ' вне диапазона 0..' + b.rows.length)
          }
          b.rows.splice(op.at, 0, newRow)
          applied.push('add_table_row: строка вставлена в таблицу ' + op.index + ' на позицию ' + op.at)
        } else {
          b.rows.push(newRow)
          applied.push('add_table_row: строка добавлена в таблицу ' + op.index)
        }
        break
      }
      case 'delete_table_row': {
        checkIndex(spec.content, op.index, 'delete_table_row')
        const b = spec.content[op.index]
        if (b.type !== 'table') throw new Error('delete_table_row: блок ' + op.index + ' имеет тип ' + b.type + ' (нужен table)')
        if (op.row == null) throw new Error('delete_table_row: row обязателен')
        if (!Array.isArray(b.rows) || op.row < 0 || op.row >= b.rows.length) {
          throw new Error('delete_table_row: row ' + op.row + ' вне диапазона 0..' + ((b.rows || []).length - 1))
        }
        b.rows.splice(op.row, 1)
        applied.push('delete_table_row: строка ' + op.row + ' удалена из таблицы ' + op.index)
        break
      }
      case 'merge_cells': {
        checkIndex(spec.content, op.index, 'merge_cells')
        const b = spec.content[op.index]
        if (b.type !== 'table') throw new Error('merge_cells: блок ' + op.index + ' имеет тип ' + b.type + ' (нужен table)')
        if (!op.range) throw new Error('merge_cells: range обязателен (например "A1:B2")')
        if (!Array.isArray(b.merged)) b.merged = []
        if (!b.merged.includes(op.range)) b.merged.push(op.range)
        applied.push('merge_cells: ' + op.range + ' в таблице ' + op.index)
        break
      }
      case 'insert_list': {
        if (!Array.isArray(op.items) || !op.items.length) throw new Error('insert_list: items обязателен')
        const listBlock = {
          type: 'list',
          ordered: !!op.ordered,
          items: op.items.map((item) => (item && typeof item === 'object' ? item : { text: String(item ?? '') })),
        }
        applied.push('insert_list: ' + insertAt(spec.content, op.after, [listBlock], 'insert_list'))
        break
      }
      case 'insert_math': {
        if (!op.latex) throw new Error('insert_math: latex обязателен')
        const mathBlock = { type: 'math', latex: String(op.latex), display: op.display !== false }
        applied.push('insert_math: ' + insertAt(spec.content, op.after, [mathBlock], 'insert_math'))
        break
      }
      default:
        throw new Error(
          'Неизвестная операция: ' + JSON.stringify(name) +
          '. Доступно: append_blocks, insert_after, insert_at, replace_text, find_text, set_style, set_run_style, insert_table, add_table_row, delete_table_row, merge_cells, insert_list, insert_math, add_image, add_header, add_footer, delete_block, replace_block, move_block, patch_document, set_page, add_watermark, remove_watermark, set_typography, remove_header, remove_footer',
        )
    }
  }

  const built = await buildDocument(spec, makeCtx(defaults))
  backupFile(path) // .bak перед перезаписью (best-effort)
  fs.writeFileSync(path, built.buffer)
  return { stats: built.stats, outline: built.outline, applied }
}

module.exports = { applyOps }
