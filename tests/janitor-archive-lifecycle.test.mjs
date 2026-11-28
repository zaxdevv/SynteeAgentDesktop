/**
 * Джанитор: жизненный цикл recall-архива.
 *
 *  - Бюджет места (записи/символы) учитывается за O(1) на кандидата;
 *    невыгодные кандидаты по-прежнему не вытесняют живые ссылки.
 *  - Место освобождается только безопасно: нет ссылки [recall:id] в живой
 *    истории И оригинала в ней же (вспоминать нечего) И запись не свежая.
 *  - pruneArchive больше не удаляет записи по возрасту вслепую — битых
 *    recall-ссылок в контексте не остаётся.
 *  - Персист: удаление записи не ломает восстановление — сырые tool-результаты
 *    остаются в БД, restoreSummaries восстанавливает только живые записи.
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
    if (resolved.endsWith('tokens/usageTracker')) return {
      estimateTokens: t => Math.ceil((t ?? '').length / 4),
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
const { Janitor, MAX_JANITOR_ARCHIVE_ENTRIES, MAX_JANITOR_ARCHIVE_CHARS } = janitorMod

const SETTINGS = {
  enabled: true, janitorEnabled: true, janitorScanInterval: 8,
  janitorTailSteps: 10, janitorMinSavingsTokens: 0,
}

/** Ход: assistant с вызовом + tool-результат. */
function turn(i, name, args, content) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id: `call${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: `call${i}`, name, content },
  ]
}

function flatten(...turns) {
  return turns.flat()
}

function entry(id, toolCallId, content, ts = 1) {
  return { id, summary: `summary ${id}`, ts, originalMessages: [{ role: 'tool', tool_call_id: toolCallId, content }] }
}

/** Одно сообщение со ссылками на все переданные id — «живой» recall. */
function refs(ids) {
  return { role: 'tool', tool_call_id: 'refs', name: 'recall_context', content: ids.map(id => `[recall:${id}]`).join(' ') }
}

test('scan keeps existing recalls untouched when nothing is reclaimable', () => {
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  const kept = Array.from({ length: MAX_JANITOR_ARCHIVE_ENTRIES }, (_, i) => entry(`jan-${i + 1}-1`, `old-${i}`, `original-${i}`))
  janitor.hydrateArchive(kept)
  const messages = flatten(turn(1, 'mcp__rea__analysis', {}, 'new unique output '.repeat(500)), turn(2, 'update_todo', {}, 'ok'))
  messages.push(refs(kept.map(e => e.id)))
  const applied = janitor.apply(messages, janitor.scan(messages, 8))
  assert.equal(applied[1].content, messages[1].content, 'нет места — новый кандидат остался сырым')
  assert.equal(janitor.getArchiveSize(), MAX_JANITOR_ARCHIVE_ENTRIES)
  assert.equal(janitor.recall(kept[0].id)[0].content, 'original-0')
})

test('dead archive entries are reclaimed so a new candidate still fits; live refs survive', () => {
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  const kept = Array.from({ length: MAX_JANITOR_ARCHIVE_ENTRIES - 1 }, (_, i) => entry(`jan-${i + 1}-1`, `old-${i}`, `original-${i}`))
  janitor.hydrateArchive([...kept, entry('jan-dead-1', 'dead-call', 'forgotten original')])
  const messages = flatten(turn(1, 'mcp__rea__analysis', {}, 'new unique output '.repeat(500)), turn(2, 'update_todo', {}, 'ok'))
  messages.push(refs(kept.map(e => e.id)))
  const report = janitor.scan(messages, 8)
  const applied = janitor.apply(messages, report)
  assert.equal(report.actions.length, 1, 'место освобождено — кандидат сжат')
  assert.equal(report.actions[0].kind, 'summarize_stale')
  assert.ok(applied[1].content.includes(`[recall:${report.actions[0].archiveId}]`))
  assert.equal(janitor.recall('jan-dead-1'), null, 'недостижимая запись освобождена')
  for (const e of kept) assert.ok(janitor.recall(e.id), `живая ссылка ${e.id} сохранилась`)
  assert.equal(janitor.getArchiveSize(), MAX_JANITOR_ARCHIVE_ENTRIES)
})

test('archive char budget is tracked by counter: reclaim frees chars for the next candidate', () => {
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  const huge = 'H'.repeat(MAX_JANITOR_ARCHIVE_CHARS - 1000)
  janitor.hydrateArchive([entry('jan-huge-1', 'huge-call', huge), entry('jan-keep-1', 'keep-call', 'kept original')])
  assert.equal(janitor.getArchiveChars(), huge.length + 'kept original'.length)
  const messages = flatten(turn(1, 'mcp__rea__analysis', {}, 'unique output '.repeat(500)), turn(2, 'update_todo', {}, 'ok'))
  messages.push(refs(['jan-keep-1']))
  const report = janitor.scan(messages, 8)
  janitor.apply(messages, report)
  assert.equal(report.actions.length, 1, 'символьный бюджет освобождён под кандидата')
  const original = 'unique output '.repeat(500)
  assert.equal(janitor.recall(report.actions[0].archiveId)[0].content, original)
  assert.equal(janitor.recall('jan-huge-1'), null)
  assert.equal(janitor.getArchiveChars(), 'kept original'.length + original.length, 'счётчик объёма не разъехался')
})

test('reclaim keeps entries whose original is still in live messages or referenced', () => {
  const janitor = new Janitor(SETTINGS)
  janitor.hydrateArchive([
    entry('jan-live-1', 'call1', 'STILL IN CONTEXT'),
    entry('jan-ref-1', 'call2', 'REFERENCED ORIGINAL'),
    entry('jan-dead-1', 'call3', 'DEAD ORIGINAL'),
  ])
  const messages = flatten(turn(1, 'mcp__rea__analysis', {}, 'STILL IN CONTEXT'))
  messages.push(refs(['jan-ref-1']))
  const report = janitor.reclaimArchive(messages)
  assert.equal(report.reclaimedIds.length, 1)
  assert.equal(report.reclaimedIds[0], 'jan-dead-1')
  assert.equal(report.keptLive, 1)
  assert.equal(report.keptReferenced, 1)
  assert.equal(janitor.getArchiveSize(), 2)
  assert.equal(janitor.getArchiveChars(), 'STILL IN CONTEXT'.length + 'REFERENCED ORIGINAL'.length)
  assert.equal(janitor.recall('jan-dead-1'), null)
})

test('pruneArchive never deletes a record that live history still references', () => {
  const janitor = new Janitor(SETTINGS)
  janitor.hydrateArchive([
    entry('jan-old-ref-1', 'call1', 'old but referenced', 1),
    entry('jan-old-dead-1', 'call2', 'old and forgotten', 1),
    entry('jan-fresh-dead-1', 'call3', 'fresh', Date.now()),
  ])
  const messages = [refs(['jan-old-ref-1'])]
  const report = janitor.pruneArchive(1000, messages)
  assert.equal(report.reclaimedIds.length, 1)
  assert.equal(report.reclaimedIds[0], 'jan-old-dead-1', 'свежая запись защищена keepRecentMs')
  assert.equal(report.keptReferenced, 1)
  assert.equal(report.keptRecent, 1)
  assert.ok(janitor.recall('jan-old-ref-1'), 'никаких битых recall-ссылок')
  assert.ok(janitor.recall('jan-fresh-dead-1'))
})

test('scan with spare room does not reclaim; reclaim is lazy and explicit', () => {
  const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
  janitor.hydrateArchive([entry('jan-dead-1', 'dead-call', 'forgotten original')])
  const messages = flatten(turn(1, 'mcp__rea__analysis', {}, 'new unique output '.repeat(500)), turn(2, 'update_todo', {}, 'ok'))
  janitor.apply(messages, janitor.scan(messages, 8))
  assert.equal(janitor.getArchiveSize(), 2, 'место есть — старые записи не трогаются')
  assert.equal(janitor.reclaimArchive(messages).reclaimedIds.length, 1, 'явный вызов освобождает')
  assert.equal(janitor.getArchiveSize(), 1)
})

test('after reclaim, persisted history still recovers: raw DB rows stay raw and live summaries reapply', () => {
  const { saveAssistantState, loadAssistantState } = loadModule('src/core/context/assistantState.ts')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-janitor-reclaim-'))
  try {
    const janitor = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
    const deadOriginal = 'dead original '.repeat(300)
    const liveOriginal = 'live original '.repeat(300)
    janitor.hydrateArchive([entry('jan-dead-1', 'dead-call', deadOriginal), entry('jan-live-1', 'call2', liveOriginal)])
    const history = [
      ...turn(2, 'mcp__rea__analysis', {}, liveOriginal),
      ...turn(3, 'update_todo', {}, 'ok'),
    ]
    // Свёрнутая ранее (живая) запись уже применена к контексту — ссылка жива.
    history[1].content = `[janitor] live summary [recall:jan-live-1]`
    janitor.reclaimArchive(history)
    assert.equal(janitor.recall('jan-dead-1'), null, 'запись без ссылки и без оригинала освобождена')

    saveAssistantState(temp, 'reclaim-test', { janitorArchive: janitor.getArchiveEntries() })
    const restarted = new Janitor({ ...SETTINGS, janitorTailSteps: 1 })
    restarted.hydrateArchive(loadAssistantState(temp, 'reclaim-test').janitorArchive)
    assert.equal(restarted.getArchiveSize(), 1)
    assert.equal(restarted.getArchiveChars(), liveOriginal.length)

    const rawDb = [
      { role: 'tool', tool_call_id: 'dead-call', content: deadOriginal },
      { role: 'tool', tool_call_id: 'call2', content: liveOriginal },
      ...turn(3, 'update_todo', {}, 'ok'),
    ]
    restarted.restoreSummaries(rawDb)
    assert.equal(rawDb[0].content, deadOriginal, 'сырой оригинал в БД остаётся доступным')
    assert.ok(!rawDb[0].content.includes('[recall:'), 'в персист не попадает битая recall-ссылка')
    assert.ok(rawDb[1].content.includes('[recall:jan-live-1]'), 'живая свёртка восстанавливается')
    assert.ok(restarted.recall('jan-live-1'), 'recall живой записи работает после рестарта')
  } finally {
    fs.unlinkSync(path.join(temp, 'assistants-state', 'reclaim-test.json'))
    fs.rmdirSync(path.join(temp, 'assistants-state'))
    fs.rmdirSync(temp)
  }
})
