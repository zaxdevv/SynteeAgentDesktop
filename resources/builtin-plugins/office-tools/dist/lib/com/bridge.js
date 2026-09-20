// com/bridge — запуск PowerShell-скриптов (COM-автоматизация Office)
//
// Скрипт пишется в {pluginDir}/cache/*.ps1 и запускается файлом:
// юникод в аргументах командной строки ненадёжен, а файл — надёжен.
// BOM обязателен: PowerShell 5.1 без BOM читает .ps1 как cp1251.
const path = require('path')
const state = require('../../state')

/**
 * Запускает PS-скрипт. Возвращает { stdout, stderr, code }.
 * Скрипт обязан печатать 'OK' при успехе и 'ERR: …' + exit 1 при ошибке.
 */
async function runPs(script, { timeoutMs = 60000 } = {}) {
  const api = state.api
  const dir = path.join(api.pluginDir, 'cache')
  await api.fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'com-' + Date.now() + '.ps1')
  await api.fs.writeFile(file, '\uFEFF' + script)

  const cmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + file + '"'
  let r
  try {
    r = await api.process.exec(cmd, { timeoutMs })
  } finally {
    try { await api.fs.delete(file) } catch { /* ignore */ }
  }
  return r
}

/** Проверяет стандартный результат PS-скрипта, бросает Error при провале. */
function assertOk(r, label) {
  const out = String(r.stdout || '')
  if (r.code !== 0) throw new Error(label + ': ' + (out || r.stderr || 'код ' + r.code))
  if (!out.includes('OK')) throw new Error(label + ': ' + (out.trim() || r.stderr || 'неизвестная ошибка'))
}

module.exports = { runPs, assertOk }
