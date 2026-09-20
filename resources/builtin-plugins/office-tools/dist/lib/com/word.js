// com/word — сценарии Word.Application через PowerShell COM
const { runPs, assertOk } = require('./bridge')

/** Экранирование одинарных кавычек PS-строк. */
function q(s) {
  return String(s).replace(/'/g, "''")
}

/** Открыть документ в видимом Word. */
async function openDoc(filePath) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $word = New-Object -ComObject Word.Application",
    '  $word.Visible = $true',
    "  $word.Documents.Open('" + q(filePath) + "') | Out-Null",
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 30000 })
  assertOk(r, 'Word COM open')
  return true
}

/** Экспорт .docx → .pdf (Word COM ExportAsFixedFormat, формат 17 = PDF). */
async function exportPdf(srcPath, outPath) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $word = New-Object -ComObject Word.Application",
    '  $word.Visible = $false',
    "  $doc = $word.Documents.Open('" + q(srcPath) + "')",
    "  $doc.ExportAsFixedFormat('" + q(outPath) + "', 17)",
    '  $doc.Close($false)',
    '  $word.Quit()',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  try { $word.Quit() } catch {}',
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 120000 })
  assertOk(r, 'Word PDF export')
  return outPath
}

/** Обновить все поля (TOC, PAGE, DATE, нумерация, ссылки) и сохранить. */
async function updateFields(srcPath) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $word = New-Object -ComObject Word.Application",
    '  $word.Visible = $false',
    "  $doc = $word.Documents.Open('" + q(srcPath) + "')",
    '  $doc.Fields.Update() | Out-Null',
    '  foreach ($sec in $doc.Sections) {',
    '    foreach ($hdr in $sec.Headers) { $hdr.Range.Fields.Update() | Out-Null }',
    '    foreach ($ftr in $sec.Footers) { $ftr.Range.Fields.Update() | Out-Null }',
    '  }',
    '  $doc.Save()',
    '  $doc.Close($false)',
    '  $word.Quit()',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  try { $word.Quit() } catch {}',
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 120000 })
  assertOk(r, 'Word update fields')
  return true
}

/** Сохранить документ в другом формате (SaveAs2). Format: 0=doc, 12=docx, 17=pdf, 8=html, 2=txt, 7=rtf */
async function saveAs(srcPath, outPath, format) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $word = New-Object -ComObject Word.Application",
    '  $word.Visible = $false',
    '  $word.DisplayAlerts = 0',
    "  $doc = $word.Documents.Open('" + q(srcPath) + "')",
    "  $doc.SaveAs2('" + q(outPath) + "', " + Number(format) + ")",
    '  $doc.Close($false)',
    '  $word.Quit()',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  try { $word.Quit() } catch {}',
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 120000 })
  assertOk(r, 'Word SaveAs')
  return outPath
}

/** Поиск/замена текста во всём документе (lossless: сохраняет форматирование, сноски, ревизии). */
async function findReplace(srcPath, find, replace, matchCase, wholeWord) {
  const mc = matchCase ? '$true' : '$false'
  const ww = wholeWord ? '$true' : '$false'
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $word = New-Object -ComObject Word.Application",
    '  $word.Visible = $false',
    "  $doc = $word.Documents.Open('" + q(srcPath) + "')",
    '  $range = $doc.Content',
    '  $range.Find.ClearFormatting()',
    '  $range.Find.Replacement.ClearFormatting()',
    "  $range.Find.Text = '" + q(find) + "'",
    "  $range.Find.Replacement.Text = '" + q(replace) + "'",
    '  $range.Find.MatchCase = ' + mc,
    '  $range.Find.MatchWholeWord = ' + ww,
    '  $range.Find.Forward = $true',
    '  $range.Find.Wrap = 1',
    '  $result = $range.Find.Execute(',
    '    $range.Find.Text, $mc, $ww, $false, $false, $false, $true, 1, $false,',
    "    '" + q(replace) + "', 2)",
    '  $count = 0',
    '  while ($result) { $count++; $result = $range.Find.Execute() }',
    '  $doc.Save()',
    '  $doc.Close($false)',
    '  $word.Quit()',
    "  Write-Output ('OK:' + $count)",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  try { $word.Quit() } catch {}',
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 120000 })
  assertOk(r, 'Word find/replace')
  return r.stdout.trim()
}

/** Принять все отслеживаемые изменения и сохранить. */
async function acceptChanges(srcPath) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $word = New-Object -ComObject Word.Application",
    '  $word.Visible = $false',
    "  $doc = $word.Documents.Open('" + q(srcPath) + "')",
    '  if ($doc.Revisions.Count -gt 0) { $doc.AcceptAllRevisions() }',
    '  $doc.Save()',
    '  $doc.Close($false)',
    '  $word.Quit()',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  try { $word.Quit() } catch {}',
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 120000 })
  assertOk(r, 'Word accept changes')
  return true
}

/** Отклонить все отслеживаемые изменения и сохранить. */
async function rejectChanges(srcPath) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $word = New-Object -ComObject Word.Application",
    '  $word.Visible = $false',
    "  $doc = $word.Documents.Open('" + q(srcPath) + "')",
    '  if ($doc.Revisions.Count -gt 0) { $doc.RejectAllRevisions() }',
    '  $doc.Save()',
    '  $doc.Close($false)',
    '  $word.Quit()',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR: ' + $_.Exception.Message)",
    '  try { $word.Quit() } catch {}',
    '  exit 1',
    '}',
  ].join('\n')
  const r = await runPs(ps, { timeoutMs: 120000 })
  assertOk(r, 'Word reject changes')
  return true
}

module.exports = { openDoc, exportPdf, updateFields, saveAs, findReplace, acceptChanges, rejectChanges }
