// com/powerpoint — сценарии PowerPoint.Application через PowerShell COM.
// Форматы SaveAs (PpSaveAsFileType): ppt=1, pps=7, rtf=6, html=12, gif=16, jpg=17,
// png=18, bmp=19, pptx=24, potx=26, ppsx=28, pdf=32, xps=33, wmv=34, mp4=39.
const { runPs, assertOk } = require('./bridge')

/** Экранирование одинарных кавычек PS-строк. */
function q(s) {
  return String(s).replace(/'/g, "''")
}

/** Открыть презентацию в видимом PowerPoint. */
async function openPres(filePath) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $app = New-Object -ComObject PowerPoint.Application",
    '  $app.Visible = $true',
    "  $app.Presentations.Open('" + q(filePath) + "') | Out-Null",
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 30000 })
  assertOk(r, 'PowerPoint COM open')
  return true
}

/**
 * Сохранить презентацию в другом формате (невидимое окно).
 * @param {string} format код PpSaveAsFileType (32=PDF, 24=pptx, 1=ppt, 39=mp4…)
 */
async function saveAs(srcPath, outPath, format) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $app = New-Object -ComObject PowerPoint.Application",
    "  $pres = $app.Presentations.Open('" + q(srcPath) + "', $true, $false, $false)",
    "  $pres.SaveAs('" + q(outPath) + "', " + Number(format) + ")",
    '  $pres.Close()',
    '  if ($app.Presentations.Count -eq 0) { $app.Quit() }',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  try { if ($pres) { $pres.Close() }; if ($app.Presentations.Count -eq 0) { $app.Quit() } } catch {}',
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 300000 })
  assertOk(r, 'PowerPoint SaveAs')
  return outPath
}

/** Экспорт .pptx → .pdf (формат 32). */
async function exportPdf(srcPath, outPath) {
  return saveAs(srcPath, outPath, 32)
}

/**
 * Применить настоящий шаблон PowerPoint (.potx/.pptx/.thmx) к презентации:
 * заменяет мастера/макеты/тему. Объекты сохраняют позиции, но переразмечаются
 * под новые макеты. Лучший результат — на декаx с плейсхолдерами.
 */
async function applyTemplate(srcPath, templatePath) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $app = New-Object -ComObject PowerPoint.Application",
    "  $pres = $app.Presentations.Open('" + q(srcPath) + "', $true, $false, $false)",
    "  $pres.ApplyTemplate('" + q(templatePath) + "')",
    '  $pres.Save()',
    '  $pres.Close()',
    '  if ($app.Presentations.Count -eq 0) { $app.Quit() }',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  try { if ($pres) { $pres.Close() }; if ($app.Presentations.Count -eq 0) { $app.Quit() } } catch {}',
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 120000 })
  assertOk(r, 'PowerPoint ApplyTemplate')
  return true
}

module.exports = { openPres, saveAs, exportPdf, applyTemplate }
