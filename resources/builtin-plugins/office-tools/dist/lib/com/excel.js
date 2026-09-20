// com/excel — сценарии Excel.Application через PowerShell COM
const { runPs, assertOk } = require('./bridge')

/** Экранирование одинарных кавычек PS-строк. */
function q(s) {
  return String(s).replace(/'/g, "''")
}

/** Открыть книгу в видимом Excel. */
async function openBook(filePath) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $excel = New-Object -ComObject Excel.Application",
    '  $excel.Visible = $true',
    "  $excel.Workbooks.Open('" + q(filePath) + "') | Out-Null",
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 30000 })
  assertOk(r, 'Excel COM open')
  return true
}

/** Экспорт .xlsx → .pdf (Workbook.ExportAsFixedFormat, формат 0 = PDF). */
async function exportPdf(srcPath, outPath) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $excel = New-Object -ComObject Excel.Application",
    '  $excel.Visible = $false',
    '  $excel.DisplayAlerts = $false',
    "  $wb = $excel.Workbooks.Open('" + q(srcPath) + "')",
    "  $wb.ExportAsFixedFormat(0, '" + q(outPath) + "')",
    '  $wb.Close($false)',
    '  $excel.Quit()',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  try { $excel.Quit() } catch {}',
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 120000 })
  assertOk(r, 'Excel PDF export')
  return outPath
}

/**
 * Встроенная диаграмма на листе (ChartObjects.Add).
 * type: 'bar'|'column'|'line'|'pie'|'doughnut'|'area'|'scatter'|'radar'
 * dataRange: 'Лист1'!$A$1:$B$10 (sheet задан отдельным параметром — тут A1:B10)
 * anchor: левая верхняя ячейка привязки (напр. 'D2'), width/height — px.
 */
async function addChart({ path, sheet, type, dataRange, title, anchor, width, height }) {
  const chartTypes = {
    bar: 57,       // xlBarClustered (горизонтальные полосы)
    column: 51,    // xlColumnClustered
    line: 4,       // xlLine
    pie: 5,        // xlPie
    doughnut: -4120,
    area: 1,       // xlArea
    scatter: -4169, // xlXYScatter
    radar: -4151,
  }
  const xlType = chartTypes[type] ?? 51
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $excel = New-Object -ComObject Excel.Application",
    '  $excel.Visible = $false',
    '  $excel.DisplayAlerts = $false',
    "  $wb = $excel.Workbooks.Open('" + q(path) + "')",
    "  $ws = $wb.Worksheets.Item('" + q(sheet) + "')",
    "  $range = $ws.Range('" + q(dataRange) + "')",
    "  $left = $ws.Range('" + q(anchor || 'D2') + "').Left",
    "  $top = $ws.Range('" + q(anchor || 'D2') + "').Top",
    "  $co = $ws.ChartObjects().Add($left, $top, " + (width || 480) + ", " + (height || 300) + ")",
    '  $chart = $co.Chart',
    '  $chart.SetSourceData($range)',
    '  $chart.ChartType = ' + xlType,
    title ? "$chart.HasTitle = $true; $chart.ChartTitle.Text = '" + q(title) + "'" : '',
    '  $wb.Save()',
    '  $wb.Close($true)',
    '  $excel.Quit()',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  try { $excel.Quit() } catch {}',
    '  exit 1',
    '}',
  ].filter(Boolean).join('\n')
  const r = await runPs(ps, { timeoutMs: 120000 })
  assertOk(r, 'Excel chart')
  return true
}

/**
 * Сохранить книгу в другом формате (Workbook.SaveAs).
 * Format (xlFileFormat): 51=xlsx, 56=xls (Excel 97-2003), 6=csv.
 */
async function saveAs(srcPath, outPath, format) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $excel = New-Object -ComObject Excel.Application",
    '  $excel.Visible = $false',
    '  $excel.DisplayAlerts = $false',
    "  $wb = $excel.Workbooks.Open('" + q(srcPath) + "')",
    "  $wb.SaveAs('" + q(outPath) + "', " + Number(format) + ")",
    '  $wb.Close($false)',
    '  $excel.Quit()',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  try { $excel.Quit() } catch {}',
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 120000 })
  assertOk(r, 'Excel SaveAs')
  return outPath
}

module.exports = { openBook, exportPdf, addChart, saveAs }
