// com/shell — открытие файлов/папок без COM (дефолтное приложение, explorer)
const { runPs, assertOk } = require('./bridge')

/** Открыть файл ассоциированным приложением (Invoke-Item — юникод-безопасно). */
async function openWithDefault(filePath) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  Invoke-Item -LiteralPath '" + String(filePath).replace(/'/g, "''") + "'",
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 20000 })
  assertOk(r, 'open file')
  return true
}

/** Показать файл в Проводнике (выделен). */
async function showInFolder(filePath) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $p = '" + String(filePath).replace(/'/g, "''") + "'",
    '  if (-not (Test-Path -LiteralPath $p)) { throw "not found: $p" }',
    '  Start-Process explorer.exe -ArgumentList ("/select,`"" + $p + "`"")',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 20000 })
  assertOk(r, 'show in folder')
  return true
}

module.exports = { openWithDefault, showInFolder }
