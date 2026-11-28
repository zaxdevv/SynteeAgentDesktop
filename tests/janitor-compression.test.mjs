/**
 * Джанитор: точность сжатия контекста.
 *
 *  - Активный хвост: последние N ходов не трогаются ни в ране, ни в БД.
 *  - Перечитывания сворачиваются диапазонно: перекрытые/устаревшие — целиком,
 *    уникальные — в резюме с точной атрибуцией (что именно прочитано).
 *  - Дедуп валиден только без мутаций между вызовами.
 *  - Protected (diff/ошибка/визуал/уже сжатое) не трогается.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── Загрузчик TS-модулей с шимом require ─────────────────────────────────────
const loadCache = new Map()

function loadModule(rel) {
  const norm = path.normalize(rel).replace(/\\/g, '/')
  if (loadCache.has(norm)) return loadCache.get(norm)
  const source = fs.readFileSync(path.join(root, norm), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  const requireShim = (spec) => {
    if (spec === 'fs' || spec === 'node:fs') return fs
    if (spec === 'path' || spec === 'node:path') return path
    const resolved = path.join(path.dirname(norm), spec).replace(/\\/g, '/')
    // type-only импорты стираются; шимим только живые зависимости
    if (resolved.endsWith('tokens/usageTracker')) return {
      estimateTokens: t => Math.ceil((t ?? '').length / 4),
      // Калибровки в тестах нет — шкала совпадает с сырой оценкой.
      estimateTokensCalibrated: t => Math.ceil((t ?? '').length / 4),
    }
    if (resolved.endsWith('context/contextManager')) return {}
    return loadModule(resolved.endsWith('.ts') ? resolved : resolved + '.ts')
  }
  vm.runInNewContext(js, { module, exports: module.exports, require: requireShim })
  loadCache.set(norm, module.exports)
  return module.exports
}

const janitorMod = loadModule('src/core/context/janitor.ts')
const compressorMod = loadModule('src/core/context/historyCompressor.ts')
const { Janitor, computeTailBoundary, parseReadSections, summarizeToolResult } = janitorMod
const { projectRequestHistory } = compressorMod
const { buildContextHistory } = loadModule('src/main/ipc/chatContextHelpers.ts')

const SETTINGS = {
  enabled: true, janitorEnabled: true, janitorScanInterval: 8,
  janitorTailSteps: 10, janitorMinSavingsTokens: 0,
}

// ── Фикстуры персистентного слоя ─────────────────────────────────────────────
function readResult(path, from, to, total, lineChars = 60) {
  const body = Array.from({ length: to - from + 1 }, (_, i) => `${from + i}|${'x'.repeat(lineChars)}`).join('\n')
  return `[File: ${path} | Lines ${from}-${to} of ${total}]\n${body}`
}

function msg(id, steps) {
  return { id, chatId: 'c', role: 'assistant', content: '', createdAt: 0, isPinned: 0, toolSteps: steps }
}

function callStep(i, name, args) {
  return { id: `cs${i}`, type: 'tool_call', toolName: name, toolArgs: args, content: '', timestamp: 0, callId: `call${i}` }
}

function resultStep(i, content, extra = {}) {
  return { id: `rs${i}`, type: 'tool_result', content, timestamp: 0, callId: `call${i}`, ...extra }
}

function projectStored(rows, { minSavingsTokens = 0, tailKeep = 1 } = {}) {
  const raw = buildContextHistory(rows)
  return projectRequestHistory(raw, { ...SETTINGS, janitorMinSavingsTokens: minSavingsTokens, janitorTailSteps: tailKeep })
}

function toolResult(messages, callId) {
  return messages.find(message => message.role === 'tool' && message.tool_call_id === callId)
}

function isCollapsed(messages, callId) {
  return toolResult(messages, callId)?.janitorCollapsed === true
}

test('parseReadSections: full-mode / дефолт / read_files', () => {
  const full = parseReadSections('read_file', `[File: C:/p/a.ts | Lines 12-40 of 900 | full mode]\n12|code`)
  assert.equal(full.length, 1)
  // объекты из vm-realm: сравниваем по полям
  assert.equal(full[0].range.from, 12)
  assert.equal(full[0].range.to, 40)
  assert.equal(full[0].range.total, 900)
  assert.equal(full[0].path, 'c:\\p\\a.ts')

  const def = parseReadSections('read_file', `[File: C:/p/b.ts | 900 lines]\n1|a\n2|b\n...[shown 400 of 900 lines | use offset=401 to continue]`)
  assert.equal(def[0].range.from, 1)
  assert.equal(def[0].range.to, 400)
  assert.equal(def[0].range.total, 900)

  const multi = parseReadSections('read_files', `=== C:/p/x.ts | 300 lines ===\n1|a\n=== C:/p/y.ts | 900 lines ===\n1|b\n...[shown 250 of 900 lines | use read_file with offset to continue]`)
  assert.equal(multi.length, 2)
  assert.equal(multi[1].range.to, 250)
  assert.equal(multi[1].range.total, 900)
})

test('mixed read_files diagnostics cannot disappear when successful sections are reread', () => {
  const batch = '=== C:/test/a.ts | 30 lines ===\n' + Array.from({ length: 30 }, (_, i) => `${i + 1}|${'x'.repeat(80)}`).join('\n')
    + '\n\n=== C:/test/b.ts ===\n[Read error: UNIQUE_PERMISSION_ERROR]'
  assert.equal(parseReadSections('read_files', batch).length, 0)
  const history = [
    msg('mixed', [callStep(1, 'read_files', { paths: ['C:/test/a.ts', 'C:/test/b.ts'] }), resultStep(1, batch, { success: true })]),
    msg('reread', [callStep(2, 'read_file', { path: 'C:/test/a.ts' }), resultStep(2, readResult('C:/test/a.ts', 1, 30, 30))]),
  ]
  assert.equal(isCollapsed(projectStored(history), 'call1'), false)
})

test('summarizeToolResult: резюме чтения сохраняет путь и диапазон строк', () => {
  const content = readResult('C:/p/a.ts', 1, 400, 900) + '\n...[shown 400 of 900 lines | use offset=401]'
  const summary = summarizeToolResult('read_file', content, undefined, 'файл после чтения не менялся')
  assert.ok(summary.includes('C:/p/a.ts'), summary)
  assert.ok(summary.includes('строки 1-400 из 900'), summary)
  assert.ok(summary.includes('файл после чтения не менялся'), summary)
})

test('summarizeToolResult: резюме поиска сохраняет запрос и топ-файлы', () => {
  const content = `[search_code: 42 matches in 3 files (regex, smart-case)]\n\n● src/app.ts (20 matches, showing 5)\n  > 10: foo\n\n● src/lib/bar.ts`
  const summary = summarizeToolResult('search_code', content, 'janitorTailSteps')
  assert.ok(summary.includes('janitorTailSteps'), summary)
  assert.ok(summary.includes('42 matches in 3 files'), summary)
  assert.ok(summary.includes('src/app.ts'), summary)
})

// ── Персистентная компрессия ────────────────────────────────────────────────

test('хвост: последние N ходов не трогаются', () => {
  const messages = []
  for (let i = 1; i <= 12; i++) {
    const p = `C:/__janitor_test__/f${i}.ts`
    messages.push(msg(`m${i}`, [callStep(i, 'read_file', { path: p }), resultStep(i, readResult(p, 1, 400, 400))]))
  }
  const plans = projectStored(messages, { minSavingsTokens: 0, tailKeep: 10 })
  for (let i = 3; i <= 12; i++) assert.equal(isCollapsed(plans, `call${i}`), false, `ход m${i} в хвосте не должен сжиматься`)
})

test('перечитывание перекрыто свежим чтением → свёрнуто; хвост не тронут', () => {
  const p = 'C:/__janitor_test__/dup.ts'
  const big = readResult(p, 1, 400, 400)
  const messages = [
    msg('m1', [callStep(1, 'read_file', { path: p }), resultStep(1, big)]),
    msg('m2', [callStep(2, 'read_file', { path: p }), resultStep(2, readResult(p, 1, 400, 400))]),
  ]
  const plans = projectStored(messages, { minSavingsTokens: 0, tailKeep: 1 })
  assert.ok(isCollapsed(plans, 'call1'), 'старое чтение должно свёрнуться')
  const collapsed = toolResult(plans, 'call1')
  assert.ok(collapsed.content.includes('Те же строки сохранены'), collapsed.content)
  assert.ok(collapsed.content.includes('dup.ts'), collapsed.content)
  assert.equal(isCollapsed(plans, 'call2'), false, 'хвост не трогается')
})

test('перечитывание НЕ перекрыто (диапазоны врозь) → свежее чтение не сжимается', () => {
  const p = 'C:/__janitor_test__/gap.ts'
  const messages = [
    msg('m1', [callStep(1, 'read_file', { path: p }), resultStep(1, readResult(p, 1, 400, 900))]),
    msg('m2', [callStep(2, 'read_file', { path: p }), resultStep(2, readResult(p, 500, 900, 900))]),
  ]
  const plans = projectStored(messages, { minSavingsTokens: 0, tailKeep: 1 })
  // A: файл не правился, диапазон не перекрыт → контент актуален на 100%,
  // агент опирается на его точные строки в следующих old_str. Не трогаем.
  assert.equal(isCollapsed(plans, 'call1'), false, 'свежее уникальное чтение должно остаться дословным')
})

test('persistent history keeps a unique old file revision after an edit', () => {
  const p = 'C:/__janitor_test__/edit-unique.ts'
  const oldPage = readResult(p, 1, 400, 900)
  const messages = [
    msg('m1', [callStep(1, 'read_file', { path: p }), resultStep(1, oldPage)]),
    msg('m2', [callStep(2, 'edit_file', { path: p }), resultStep(2, 'Updated 3 lines in ' + p)]),
    msg('m3', [callStep(3, 'read_file', { path: p }), resultStep(3, readResult(p, 500, 900, 900))]),
  ]
  assert.equal(isCollapsed(projectStored(messages), 'call1'), false)
})

test('matching line numbers with changed text do not replace a persistent file snapshot', () => {
  const p = 'C:/__janitor_test__/edit.ts'
  const original = readResult(p, 1, 400, 400)
  const changed = original.replace('12|', '12|NEW VALUE ')
  const messages = [
    msg('m1', [callStep(1, 'read_file', { path: p }), resultStep(1, original)]),
    msg('m2', [callStep(2, 'read_file', { path: p }), resultStep(2, changed)]),
  ]
  assert.equal(isCollapsed(projectStored(messages), 'call1'), false)
})

test('live Janitor archives changed revisions before replacing their raw text', () => {
  const p = 'C:/__janitor_test__/archived-revision.ts'
  const original = readResult(p, 1, 400, 400)
  const messages = flatten(
    runMsg(1, 'read_file', { path: p }, original),
    runMsg(2, 'edit_file', { path: p }, 'Changed 12'),
    runMsg(3, 'read_file', { path: p }, original.replace('12|', '12|NEW VALUE ')),
  )
  const j = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  const report = j.scan(messages, 8, 'deep')
  const action = report.actions.find(item => item.messageIndices.includes(1))
  assert.ok(action?.archiveId)
  j.apply(messages, report)
  assert.equal(j.recall(action.archiveId)?.[0]?.content, original)
})

test('дедуп: без мутаций между — свёрнуто; с run_command между — не «идентичен»', () => {
  const bigSearch = (q) => `[search_code: 30 matches in 2 files]\n${Array.from({ length: 40 }, (_, i) => `● src/f${i}.ts\n  > ${i}: ${q} ${'y'.repeat(50)}`).join('\n')}`
  const args = { pattern: 'janitorTest' }

  const clean = [
    msg('m1', [callStep(1, 'search_code', args), resultStep(1, bigSearch('a'))]),
    msg('m2', [callStep(2, 'search_code', args), resultStep(2, bigSearch('a'))]),
  ]
  const plansClean = projectStored(clean, { minSavingsTokens: 0, tailKeep: 1 })
  assert.ok(isCollapsed(plansClean, 'call1'))
  assert.ok(toolResult(plansClean, 'call1').content.includes('тот же результат сохранён ниже'), 'дедуп без мутаций работает')

  const dirty = [
    msg('m1', [callStep(1, 'search_code', args), resultStep(1, bigSearch('a'))]),
    msg('m2', [callStep(2, 'run_command', { command: 'echo hi' }), resultStep(2, 'hi\n' + 'z'.repeat(1300))]),
    msg('m3', [callStep(3, 'search_code', args), resultStep(3, bigSearch('c'))]),
  ]
  const plansDirty = projectStored(dirty, { minSavingsTokens: 0, tailKeep: 1 })
  assert.equal(isCollapsed(plansDirty, 'call1'), false, 'уникальный вывод нельзя безвозвратно удалять из БД')
})

test('protected: diff, ошибка, изображения, уже сжатое — не трогаются', () => {
  const messages = [
    msg('m1', [callStep(1, 'edit_file', { path: 'C:/__janitor_test__/d.ts' }), resultStep(1, `[DRY RUN] Edit for: d.ts\n${'a'.repeat(1500)}`, { diff: '+ big diff ' + 'a'.repeat(1400) })]),
    msg('m2', [callStep(2, 'read_file', { path: 'C:/x.ts' }), resultStep(2, readResult('C:/x.ts', 1, 400, 400), { success: false })]),
    msg('m3', [callStep(3, 'analyze_image', { path: 'C:/i.png' }), resultStep(3, 'image', { imagePaths: ['C:/i.png'] })]),
    msg('m4', [callStep(4, 'read_file', { path: 'C:/y.ts' }), resultStep(4, '[Контекст оптимизирован локальным помощником] уже сжато ' + 'b'.repeat(1300))]),
  ]
  const plans = projectStored(messages, { minSavingsTokens: 0, tailKeep: 1 })
  assert.equal(plans.some(message => message.janitorCollapsed), false)
})

test('request projection is idempotent and a rewind still exposes original saved output', () => {
  const p = 'C:/__janitor_test__/idem.ts'
  const original = readResult(p, 1, 400, 400)
  const saved = [
    msg('m1', [callStep(1, 'read_file', { path: p }), resultStep(1, original)]),
    msg('m2', [callStep(2, 'read_file', { path: p }), resultStep(2, original)]),
  ]
  const before = JSON.stringify(saved)
  const settings = { ...SETTINGS, janitorTailSteps: 1 }
  const projected = projectStored(saved)
  assert.ok(isCollapsed(projected, 'call1'))
  assert.equal(projectRequestHistory(projected, settings), projected)
  assert.equal(JSON.stringify(saved), before)
  assert.equal(toolResult(projectStored(saved.slice(0, 1)), 'call1').content, original)
})

test('minSavingsTokens: мелкая экономия оставляет исходную историю', () => {
  const p = 'C:/__janitor_test__/tiny.ts'
  const messages = [
    msg('m1', [callStep(1, 'read_file', { path: p }), resultStep(1, readResult(p, 1, 50, 50, 20))]),
    msg('m2', [callStep(2, 'read_file', { path: p }), resultStep(2, readResult(p, 1, 50, 50, 20))]),
  ]
  const plans = projectStored(messages, { minSavingsTokens: 10_000, tailKeep: 1 })
  assert.equal(plans.some(message => message.janitorCollapsed), false)
})

test('анализ учитывает хвост: покрытие чтением из хвоста сворачивает старое чтение', () => {
  const p = 'C:/__janitor_test__/tailcov.ts'
  const messages = [
    msg('m1', [callStep(1, 'read_file', { path: p }), resultStep(1, readResult(p, 1, 400, 400))]),
    msg('m2', [callStep(2, 'read_file', { path: p }), resultStep(2, readResult(p, 1, 400, 400))]),
    msg('m3', [callStep(3, 'read_file', { path: p }), resultStep(3, readResult(p, 1, 400, 400))]),
  ]
  const plans = projectStored(messages, { minSavingsTokens: 0, tailKeep: 2 })
  assert.ok(isCollapsed(plans, 'call1'), 'покрытие хвостовым чтением m2/m3 должно сворачивать m1')
  assert.equal(isCollapsed(plans, 'call2'), false)
  assert.equal(isCollapsed(plans, 'call3'), false)
})

// ── Джанитор рана (in-run) ───────────────────────────────────────────────────

function runMsg(i, name, args, resultContent, extra = {}) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id: `call${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: `call${i}`, name, content: resultContent, ...extra },
  ]
}

function flatten(...turns) {
  return turns.flat()
}

test('in-run: хвост по ходам — при 10 активных ходах сворачивается только старше', () => {
  const turns = []
  for (let i = 1; i <= 12; i++) {
    const p = `C:/__janitor_test__/run${i}.ts`
    turns.push(...runMsg(i, 'read_file', { path: p }, readResult(p, 1, 400, 400)))
  }
  const j = new Janitor(SETTINGS)
  const report = j.scan(flatten(...turns), 8, 'deep')
  for (const action of report.actions) {
    for (const idx of action.messageIndices) {
      assert.ok(idx < 4, `замена в хвосте (индекс ${idx}) запрещена`)
    }
  }
  // ходы 11-12 (последние 10) не тронуты — их результаты без маркера
  const messages = flatten(...turns)
  const applied = j.apply(messages, report)
  const tailResults = applied.filter(m => m.role === 'tool').slice(-10)
  for (const t of tailResults) assert.ok(!t.content.includes('[Контекст оптимизирован'), 'хвост должен остаться сырым')
})

test('in-run: перечитывание перекрыто позже → свёрнуто, call+result структура цела', () => {
  const p = 'C:/__janitor_test__/runReread.ts'
  const messages = flatten(
    runMsg(1, 'read_file', { path: p }, readResult(p, 1, 400, 400)),
    runMsg(2, 'read_file', { path: p }, readResult(p, 1, 400, 400)),
  )
  const j = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  const report = j.scan(messages, 8, 'deep')
  assert.equal(report.actions.length, 1)
  assert.equal(report.actions[0].kind, 'collapse_reread')
  const applied = j.apply(messages, report)
  // assistant-сообщения с tool_calls не удалены, tool-сообщения на месте
  assert.equal(applied.filter(m => m.role === 'assistant').length, 2)
  assert.equal(applied.filter(m => m.role === 'tool').length, 2)
  assert.equal(applied[1].janitorCollapsed, true)
  assert.equal(applied[3].content, readResult(p, 1, 400, 400), 'свежее чтение (хвост) не тронуто')
})

test('in-run: ходов меньше хвоста → ничего не сворачивается', () => {
  const p = 'C:/__janitor_test__/small.ts'
  const messages = flatten(
    runMsg(1, 'read_file', { path: p }, readResult(p, 1, 400, 400)),
    runMsg(2, 'read_file', { path: p }, readResult(p, 1, 400, 400)),
  )
  const j = new Janitor(SETTINGS) // tailSteps=10
  const report = j.scan(messages, 8, 'deep')
  assert.equal(report.actions.length, 0)
})

test('in-run: свежее уникальное чтение вне хвоста не сжимается (не emergency)', () => {
  const p = 'C:/__janitor_test__/fresh.ts'
  const messages = flatten(
    runMsg(1, 'read_file', { path: p }, readResult(p, 1, 400, 900)),
    runMsg(2, 'read_file', { path: p }, readResult(p, 500, 900, 900)), // диапазоны врозь
  )
  const j = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  const report = j.scan(messages, 8, 'deep')
  // A: файл не правился и не перекрыт → контент актуален, old_str агент берёт
  // из него. Экономия тут дороже потери точности.
  assert.equal(report.actions.filter(a => a.kind === 'summarize_stale').length, 0)
})

test('in-run: summarize_stale архивирует оригинал и recall возвращает его', () => {
  const p = 'C:/__janitor_test__/unique.ts'
  const original = readResult(p, 1, 400, 900)
  const messages = flatten(
    runMsg(1, 'read_file', { path: p }, original),
    runMsg(2, 'read_file', { path: p }, readResult(p, 500, 900, 900)), // не перекрывает 1-400
  )
  const j = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  // Свежее уникальное чтение сжимается только в emergency-скане (economist
  // stage 2: tailStepsOverride — активный хвост вдвое короче, давление на окно).
  const report = j.scan(messages, 8, 'deep', 1)
  const stale = report.actions.find(a => a.kind === 'summarize_stale')
  assert.ok(stale, 'уникальное чтение должно уйти в резюме')
  assert.ok(stale.tokensSaved > 0, 'экономия хранится числом для маркировки как оценки в UI')
  assert.match(stale.description, /точный снимок чтения/)
  assert.ok(stale.archiveId, 'архивный id для recall')
  const applied = j.apply(messages, report)
  assert.ok(applied[1].content.includes('[recall:'))
  assert.ok(applied[1].content.includes('строки 1-400 из 900'), 'атрибуция диапазона в резюме')
  const recalled = j.recall(stale.archiveId)
  assert.equal(recalled[0].content, original, 'оригинал восстановим из архива')
})

test('in-run: недетерминированные тулы не дедуплицируются', () => {
  const cmdOut = (t) => `${t}\n${'w'.repeat(1400)}`
  const messages = flatten(
    runMsg(1, 'run_command', { command: 'git status' }, cmdOut('on branch a')),
    runMsg(2, 'run_command', { command: 'git status' }, cmdOut('on branch b')),
  )
  const j = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  const report = j.scan(messages, 8, 'deep')
  assert.equal(report.actions.filter(a => a.kind === 'dedup_tool_call').length, 0, 'run_command с одинаковыми аргументами может дать разный вывод')
})

test('in-run: результаты правок (diff в контенте) не сжимаются', () => {
  const messages = flatten(
    runMsg(1, 'edit_file', { path: 'C:/__janitor_test__/e.ts' }, `[DRY RUN] Edit for: e.ts\n${'q'.repeat(1500)}`),
    runMsg(2, 'run_command', { command: 'echo ok' }, 'ok\n' + 's'.repeat(1400)),
  )
  const j = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  const report = j.scan(messages, 8, 'deep')
  for (const a of report.actions) {
    const content = messages[a.messageIndices[0]].content
    assert.ok(!content.startsWith('[DRY RUN]'), 'diff-подобные результаты правок защищены')
  }
})

test('computeTailBoundary: граница по ходам, не по сырым сообщениям', () => {
  const p = 'C:/x.ts'
  // ход = assistant с 3 параллельными тулами + 3 tool-результата = 4 сообщения
  const messages = []
  for (let i = 1; i <= 4; i++) {
    messages.push({ role: 'assistant', content: '', tool_calls: [1, 2, 3].map(n => ({ id: `c${i}_${n}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"C:/x.ts"}' } })) })
    for (const n of [1, 2, 3]) messages.push({ role: 'tool', tool_call_id: `c${i}_${n}`, name: 'read_file', content: readResult(p, 1, 50, 50) })
  }
  // 4 хода по 4 сообщения; хвост 2 хода → граница = индекс 2-го хода с конца
  const boundary = computeTailBoundary(messages, 2)
  assert.equal(boundary, 8, 'ходы по 4 сообщения: граница на 3-м ходе (индекс 8)')
})

test('discarded scans do not allocate archives; accepted scans reuse the original', () => {
  const messages = flatten(runMsg(1, 'mcp__rea__analysis', {}, 'unique output '.repeat(500)), runMsg(2, 'update_todo', {}, 'ok'))
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  for (let round = 1; round <= 20; round++) janitor.scan(messages, round)
  assert.equal(janitor.getArchiveSize(), 0, 'scan must not commit unaccepted plans')
  const report = janitor.scan(messages, 21)
  janitor.apply(messages, report)
  assert.equal(janitor.getArchiveSize(), 1)
  janitor.apply(messages, janitor.scan(messages, 22))
  assert.equal(janitor.getArchiveSize(), 1, 'same call and original must not duplicate')
})

test('archive capacity preserves existing recalls and leaves new unique results intact', () => {
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  const entries = Array.from({ length: janitorMod.MAX_JANITOR_ARCHIVE_ENTRIES }, (_, i) => ({
    id: `jan-${i + 1}-1`, summary: 'kept', ts: 1,
    originalMessages: [{ role: 'tool', tool_call_id: `old-${i}`, content: `original-${i}` }],
  }))
  janitor.hydrateArchive(entries)
  const messages = flatten(runMsg(1, 'mcp__rea__analysis', {}, 'new unique output '.repeat(500)), runMsg(2, 'update_todo', {}, 'ok'))
  messages.push({ role: 'tool', tool_call_id: 'refs', name: 'recall_context', content: entries.map(e => `[recall:${e.id}]`).join(' ') })
  const applied = janitor.apply(messages, janitor.scan(messages, 8))
  assert.equal(applied[1].content, messages[1].content)
  assert.equal(janitor.recall(entries[0].id)[0].content, 'original-0')
  const oversized = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  const large = flatten(runMsg(1, 'mcp__rea__analysis', {}, 'x'.repeat(janitorMod.MAX_JANITOR_ARCHIVE_CHARS + 1)), runMsg(2, 'update_todo', {}, 'ok'))
  assert.equal(oversized.scan(large, 8).actions.length, 0)
})

test('committed summary and paginated original survive a state-file round trip', () => {
  const { saveAssistantState, loadAssistantState } = loadModule('src/core/context/assistantState.ts')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-janitor-test-'))
  try {
    const original = 'first line\n' + 'unique middle '.repeat(600) + '\nLAST ERROR: preserve me'
    const messages = flatten(runMsg(1, 'mcp__rea__analysis', {}, original), runMsg(2, 'update_todo', {}, 'ok'))
    const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
    const report = janitor.scan(messages, 8)
    const compressed = janitor.apply(messages, report)
    const id = report.actions[0].archiveId
    saveAssistantState(temp, 'restart-test', { janitorArchive: janitor.getArchiveEntries() })
    const restarted = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
    restarted.hydrateArchive(loadAssistantState(temp, 'restart-test').janitorArchive)
    const rawHistory = JSON.parse(JSON.stringify(messages))
    restarted.restoreSummaries(rawHistory)
    assert.equal(rawHistory[1].content, compressed[1].content, 'next worker must not expand the raw DB output')
    let recalled = ''
    for (let offset = 0; offset < original.length; offset += 700) recalled += restarted.recallPage(id, offset, 700).split('\n').slice(1).join('\n')
    assert.equal(recalled, original, 'all original bytes remain accessible via pagination')
    const reusedId = JSON.parse(JSON.stringify(messages))
    reusedId[1].content = 'different original'
    restarted.restoreSummaries(reusedId)
    assert.equal(reusedId[1].content, 'different original', 'a reused call id alone must not replace different data')
  } finally {
    fs.unlinkSync(path.join(temp, 'assistants-state', 'restart-test.json'))
    fs.rmdirSync(path.join(temp, 'assistants-state'))
    fs.rmdirSync(temp)
  }
})

test('multifile sections never borrow line counts or truncation from the next file; POSIX case is distinct', () => {
  const sections = parseReadSections('read_files', '=== /src/A.ts | 1 lines ===\n1|all A\n=== /src/b.ts | 1000 lines ===\n1|b\n...[shown 250 of 1000 lines]')
  assert.equal(sections[0].range.to, 1)
  assert.equal(sections[1].range.to, 250)
  assert.notEqual(janitorMod.normalizePath('/src/A.ts'), janitorMod.normalizePath('/src/a.ts'))
})

test('one stale file in a read_files batch cannot delete another unique file', () => {
  const batch = `=== C:/test/a.ts | 20 lines ===\n${'1|a\n'.repeat(20)}=== C:/test/b.ts | 300 lines ===\n${'1|unique b content\n'.repeat(250)}...[shown 250 of 300 lines]`
  const rounds = [runMsg(1, 'read_files', { paths: ['C:/test/a.ts', 'C:/test/b.ts'] }, batch), runMsg(2, 'edit_file', { path: 'C:/test/a.ts' }, 'edited'), runMsg(3, 'update_todo', {}, 'ok')]
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  assert.equal(janitor.scan(flatten(...rounds), 8).actions.length, 0)
  const rows = rounds.map((round, i) => msg(`m${i}`, [callStep(i + 1, round[0].tool_calls[0].function.name, JSON.parse(round[0].tool_calls[0].function.arguments)), resultStep(i + 1, round[1].content)]))
  assert.equal(isCollapsed(projectStored(rows), 'call1'), false)
})

test('changed MCP responses with identical arguments are never deduplicated', () => {
  const first = 'analysis state 1 '.repeat(300), second = 'analysis state 2 '.repeat(300)
  const rounds = [runMsg(1, 'mcp__rea__status', {}, first), runMsg(2, 'mcp__rea__status', {}, second), runMsg(3, 'update_todo', {}, 'ok')]
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  assert.equal(janitor.scan(flatten(...rounds), 8, 'light').actions.length, 0)
  const rows = [msg('a', [callStep(1, 'mcp__rea__status', {}), resultStep(1, first)]), msg('b', [callStep(2, 'mcp__rea__status', {}), resultStep(2, second)])]
  assert.equal(isCollapsed(projectStored(rows), 'call1'), false)
})

test('persistent tail counts tool rounds within one assistant message and preserves call arguments', () => {
  const steps = [], iterations = []
  for (let i = 1; i <= 12; i++) {
    const round = [callStep(i, 'search_code', { pattern: 'same' }), resultStep(i, 'same result '.repeat(300))]
    steps.push(...round)
    iterations.push({ textBefore: '', steps: round })
  }
  const row = { ...msg('long-run', steps), iterations }
  const projected = projectStored([row], { tailKeep: 2 })
  assert.ok(isCollapsed(projected, 'call1'), 'one long assistant row still contains twelve tool rounds')
  assert.equal(toolResult(projected, 'call11').content, steps[21].content)
  assert.equal(toolResult(projected, 'call12').content, steps[23].content)
  assert.equal(projected[0].tool_calls[0].function.arguments, '{"pattern":"same"}')
  assert.equal(row.iterations[0].steps[1].content, steps[1].content, 'persisted iteration retains the original result')
})

test('disabled Janitor ignores even emergency scans, and committed summaries persist across workers', () => {
  const messages = flatten(runMsg(1, 'mcp__rea__analysis', {}, 'unique output '.repeat(500)), runMsg(2, 'update_todo', {}, 'ok'))
  const disabled = new Janitor({ ...SETTINGS, janitorEnabled: false, janitorTailSteps: 1 })
  assert.equal(disabled.scan(messages, 8, 'deep', 1).actions.length, 0)
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  const report = janitor.scan(messages, 8)
  const applied = janitor.apply(messages, report)
  const summary = applied[1].content
  const restarted = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  restarted.hydrateArchive(JSON.parse(JSON.stringify(janitor.getArchiveEntries())))
  const history = JSON.parse(JSON.stringify(messages))
  restarted.restoreSummaries(history)
  assert.equal(history[1].content, summary)
})

test('repeated searches shrink the next request by over 80%, using raw tail anchors without archive allocation', t => {
  const output = '[search_code: 80 matches]\n' + 'src/example.ts:42 useful match and context\n'.repeat(160)
  const messages = flatten(...Array.from({ length: 24 }, (_, i) => runMsg(i + 1, 'search_code', { pattern: 'same' }, output)))
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 2 })
  const before = messages.reduce((n, message) => n + Math.ceil((message.content ?? '').length / 4), 0)
  const report = janitor.scan(messages, 24, 'light')
  const applied = janitor.apply(messages, report)
  const after = applied.reduce((n, message) => n + Math.ceil((message.content ?? '').length / 4), 0)
  assert.equal(report.actions.length, 22, 'the first tail result anchors the last eligible duplicate')
  assert.equal(janitor.getArchiveSize(), 0, 'exact duplicates do not consume recall capacity')
  assert.ok(after < before * 0.2, `${before} -> ${after}`)
  assert.equal(report.totalTokensSaved, before - after, 'reported reduction matches the changed tool contents')
  for (let index = messages.length - 4; index < messages.length; index++) assert.equal(applied[index], messages[index], 'two recent rounds remain exact')
  for (let index = 0; index < messages.length; index += 2) assert.equal(applied[index], messages[index], 'calls and arguments remain intact')
  t.diagnostic(`request tool text: ${before} -> ${after} estimated tokens (${Math.round((1 - after / before) * 100)}% smaller); recall entries: 0`)
})

test('one eligible duplicate can use an otherwise protected tail, while unique outputs still retain recall', () => {
  const output = 'unique result facts '.repeat(300)
  const messages = flatten(runMsg(1, 'search_code', { pattern: 'same' }, output), runMsg(2, 'search_code', { pattern: 'same' }, output))
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  const report = janitor.scan(messages, 8, 'light')
  assert.equal(report.actions.length, 1)
  assert.equal(report.actions[0].kind, 'dedup_tool_call')
  assert.equal(janitor.apply(messages, report)[3].content, output)
  assert.equal(janitor.getArchiveSize(), 0)

  const unique = flatten(runMsg(3, 'mcp__example__inspect', {}, output), runMsg(4, 'update_todo', {}, 'ok'))
  const saved = janitor.scan(unique, 16)
  janitor.apply(unique, saved)
  assert.equal(saved.actions[0].kind, 'summarize_stale')
  assert.equal(janitor.recall(saved.actions[0].archiveId)[0].content, output)
})

test('failed/diff/visual results are never candidates or coverage anchors, including emergency mode', () => {
  for (const name of ['read_file', 'search_code', 'run_command', 'mcp__example__inspect']) {
    const output = name === 'read_file' ? readResult('C:/test/protected.ts', 1, 30, 30) : 'important failure details '.repeat(300)
    const messages = flatten(runMsg(1, name, { path: 'C:/test/protected.ts' }, output), runMsg(2, name, { path: 'C:/test/protected.ts' }, output), runMsg(3, 'update_todo', {}, 'ok'))
    messages[1].janitorProtected = true
    messages[3].janitorProtected = true
    const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
    assert.equal(janitor.scan(messages, 8, 'deep', 1).actions.length, 0, name)
  }
  const output = readResult('C:/test/protected.ts', 1, 30, 30)
  const messages = flatten(runMsg(1, 'read_file', {}, output), runMsg(2, 'read_file', {}, output))
  messages[3].janitorProtected = true
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  assert.equal(janitor.scan(messages, 8).actions.length, 0, 'a failed later read cannot prove coverage')
})

test('scheduling skips unchanged unproductive state but retries on new evidence, policy, settings and contents', () => {
  const messages = flatten(runMsg(1, 'read_file', {}, readResult('C:/test/fresh.ts', 1, 30, 30)), runMsg(2, 'update_todo', {}, 'ok'))
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  assert.equal(janitor.shouldScan(8, messages), true)
  assert.equal(janitor.scan(messages, 8).actions.length, 0)
  assert.equal(janitor.shouldScan(16, messages), false)
  messages.push({ role: 'user', content: 'new hint with no new tool information' })
  assert.equal(janitor.shouldScan(24, messages), false, 'hints alone cannot change tool eligibility')
  assert.equal(janitor.shouldScan(24, messages, 'deep', 1, true), true, 'emergency policy can recover fresh reads')
  const emergency = janitor.scan(messages, 24, 'deep', 1)
  const applied = janitor.apply(messages, emergency)
  assert.ok(emergency.actions.length > 0)
  assert.equal(janitor.shouldScan(32, applied, 'deep', 1), false, 'applied summaries are the remembered state')
  applied.push(...runMsg(3, 'read_file', {}, readResult('C:/test/fresh.ts', 1, 30, 30)))
  assert.equal(janitor.shouldScan(32, applied, 'deep', 1), true, 'new results change eligibility')
  janitor.scan(applied, 32, 'deep', 1)
  applied[applied.length - 1].content += '\nchanged'
  assert.equal(janitor.shouldScan(40, applied, 'deep', 1), true, 'in-place result updates are detected')
  janitor.scan(applied, 40, 'deep', 1)
  janitor.updateSettings({ ...SETTINGS, janitorTailSteps: 1, janitorMinSavingsTokens: 1 })
  assert.equal(janitor.shouldScan(48, applied, 'deep', 1), true, 'settings can make a rejected plan useful')
})


test('inconsistent pages and diagnostics cannot replace an exact earlier snapshot', () => {
  const p = 'C:/test/versions.ts'
  const original = readResult(p, 1, 60, 60)
  const tail = runMsg(4, 'update_todo', {}, 'ok')
  const compare = (rounds) => {
    const messages = flatten(runMsg(1, 'read_file', { path: p }, original), ...rounds, tail)
    const j = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
    assert.equal(j.scan(messages, 8, 'light').actions.some(action => action.messageIndices.includes(1)), false)
  }
  compare([
    runMsg(2, 'read_file', { path: p }, readResult(p, 1, 35, 60).replace('35|', '35|CHANGED ')),
    runMsg(3, 'read_file', { path: p }, readResult(p, 25, 60, 60).replace('25|', '25|CHANGED ')),
  ])
  compare([runMsg(2, 'read_file', { path: p }, original.replace('of 60]', 'of 61]'))])
  compare([runMsg(2, 'read_file', { path: p }, original + '\n[Permission changed while reading]')])
})

test('anchors survive deep scans, including the next scan after the tail moves', () => {
  const p = 'C:/test/anchor.ts'
  const check = (name, args, original) => {
    const messages = flatten(runMsg(1, name, args, original), runMsg(2, name, args, original), runMsg(3, 'update_todo', {}, 'ok'))
    const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
    const first = janitor.scan(messages, 8, 'deep', 1)
    const projected = janitor.apply(messages, first)
    assert.equal(first.actions.length, 1)
    assert.equal(projected[3].content, original)
    projected.push(...runMsg(4, 'update_todo', {}, 'ok'))
    const second = janitor.scan(projected, 16, 'deep', 1)
    assert.equal(janitor.apply(projected, second)[3].content, original)
  }
  check('read_file', { path: p }, readResult(p, 1, 60, 60))
  check('search_code', { pattern: 'same' }, 'exact search output '.repeat(500))
})

test('a stale plan cannot collapse a duplicate after the proof changes', () => {
  const output = 'exact result '.repeat(600)
  const messages = flatten(runMsg(1, 'search_code', {}, output), runMsg(2, 'search_code', {}, output))
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  const plan = janitor.scan(messages, 8, 'light')
  assert.equal(plan.actions.length, 1)
  messages[3].content = 'changed after scan'
  assert.equal(janitor.apply(messages, plan)[1].content, output)
})

test('disabled Janitor and a newly protected tail preserve exact saved results', () => {
  const output = 'unique original '.repeat(400)
  const messages = flatten(runMsg(1, 'mcp__example__inspect', {}, output), runMsg(2, 'update_todo', {}, 'ok'))
  const settings = { ...SETTINGS, janitorTailSteps: 1 }
  const janitor = new Janitor(settings)
  const plan = janitor.scan(messages, 8)
  const applied = janitor.apply(messages, plan)
  const archive = janitor.getArchiveEntries()
  assert.equal(archive.length, 1)
  const originalJson = JSON.stringify(messages)
  const estimated = projectRequestHistory(messages, settings, undefined, archive)
  assert.equal(estimated[1].content, applied[1].content)
  assert.equal(JSON.stringify(messages), originalJson)
  assert.equal(projectRequestHistory(messages, SETTINGS, undefined, archive)[1].content, output)
  const protectedHistory = messages.map(message => message.tool_call_id === 'call1' ? { ...message, janitorProtected: true } : message)
  assert.equal(projectRequestHistory(protectedHistory, settings, undefined, archive)[1].content, output)
  janitor.updateSettings({ ...settings, janitorEnabled: false })
  assert.equal(janitor.restoreSummaries(messages), 0)
  assert.equal(janitor.scan(messages, 16, 'deep', 1).actions.length, 0)
  assert.equal(messages[1].content, output)
})


test('MCP pagination references remain visible through deep compression', () => {
  const preview = JSON.stringify({ result_id: 'page-1', read_with: 'read_mcp_result', preview: 'retained text '.repeat(130) })
  const messages = flatten(runMsg(1, 'mcp__example__inspect', {}, preview), runMsg(2, 'update_todo', {}, 'ok'))
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  assert.equal(janitor.scan(messages, 8, 'deep', 1).actions.length, 0)
})

test('recall offset pagination does not split supplementary characters', () => {
  const janitor = new Janitor(SETTINGS)
  const original = 'a\u{1F9EA}b'
  janitor.hydrateArchive([{ id: 'unicode-test', summary: '', ts: 1, originalMessages: [{ role: 'tool', content: original }] }])
  assert.equal(janitor.recallPage('unicode-test', 0, 2), '[recall:unicode-test | chars 0-1 of 4 | next offset=1]\na')
  assert.equal(janitor.recallPage('unicode-test', 1, 1), '[recall:unicode-test | chars 1-3 of 4 | next offset=3]\n\u{1F9EA}')
  assert.equal(janitor.recallPage('unicode-test', 3, 1), '[recall:unicode-test | chars 3-4 of 4]\nb')
})


test('context pins keep their complete saved tool output', () => {
  const output = 'a pinned finding '.repeat(350)
  const args = { pattern: 'pinned' }
  const rows = [
    { ...msg('pinned', [callStep(1, 'search_code', args), resultStep(1, output)]), isPinned: 1 },
    msg('new', [callStep(2, 'search_code', args), resultStep(2, output)]),
  ]
  const projected = projectStored(rows)
  assert.equal(toolResult(projected, 'call1').content, output)
  assert.equal(toolResult(projected, 'call1').janitorProtected, true)
})
