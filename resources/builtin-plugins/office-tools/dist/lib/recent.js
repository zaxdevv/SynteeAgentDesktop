// recent — журнал недавних файлов + «текущий документ» для панели превью
const state = require('../state')

const KEY = 'recent'
const LIMIT = 30

/**
 * entry: { path, kind: 'word'|'excel', op, name, size, stats?, outline?, preview? }
 * preview — компактные данные для панели (outline для word, первые строки для excel).
 */
async function add(entry) {
  const api = state.api
  const list = (await api.storage.get(KEY)) || []
  const item = { ...entry, at: new Date().toISOString() }
  const idx = list.findIndex(x => x.path === entry.path)
  if (idx >= 0) list.splice(idx, 1)
  list.unshift(item)
  await api.storage.set(KEY, list.slice(0, LIMIT))
  setCurrent(item)
  return item
}

async function list() {
  return (await state.api.storage.get(KEY)) || []
}

async function clear() {
  await state.api.storage.set(KEY, [])
}

// ── Текущий документ (последний затронутый тулом) ──
let current = null

function setCurrent(item) {
  current = item
  try {
    state.api.ui.emit('office:update', { current, reason: 'file' })
  } catch (e) {
    try { state.api.log.warn('ui.emit failed: ' + e.message) } catch { /* ignore */ }
  }
}

function getCurrent() {
  return current
}

module.exports = { add, list, clear, setCurrent, getCurrent }
