/**
 * project_map — неоднозначная цель не выбирается молча.
 *
 * Раньше resolveNode брал findNodes(...)[0]: при двух одноимённых символах
 * (частый случай — `init`, `run`, `load` в разных файлах) агент получал
 * случайный узел и строил на нём callers/affected, не зная об этом.
 *
 * Проверяем: кандидаты с path:line и nodeId; приоритет точного nodeId и
 * точного пути файла; уникальное точное имя важнее partial-совпадений;
 * рабочие пути с '\' и './'; search отдаёт nodeId и не приклеивает связи
 * однофамильца.
 *
 * tool транспилируется на лету, mapStore/mapAnalytics подменяются шимами
 * (паттерн tests/map-semantic.test.mjs) — БД не нужна.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)

function transpile(relPath, requireShim = {}) {
  const source = fs.readFileSync(path.join(root, relPath), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  const requireShimFn = (spec) => (requireShim[spec] ? requireShim[spec] : nodeRequire(spec))
  new Function('exports', 'require', 'module', js)(module.exports, requireShimFn, module)
  return module.exports
}

const P = 'p1'

const mk = (id, name, kind, opts = {}) => ({
  id, projectId: P, filePath: opts.filePath ?? 'src/a.ts', name, kind,
  parentName: opts.parentName ?? null, lineStart: opts.line ?? 1, lineEnd: (opts.line ?? 1) + 3,
  signature: opts.signature ?? '', exported: opts.exported ?? false, doc: opts.doc ?? null,
})

// Два одноимённых `init` в разных файлах + частичный `initCache`.
const INIT_A = mk('src/a.ts#init', 'init', 'function', { filePath: 'src/a.ts', line: 10 })
const INIT_B = mk('src/b.ts#init', 'init', 'function', { filePath: 'src/b.ts', line: 42 })
const INIT_CACHE = mk('src/c.ts#initCache', 'initCache', 'function', { filePath: 'src/c.ts', line: 7 })
// Уникальный exact + его «сосед» по частичному совпадению.
const SAVE = mk('src/a.ts#saveProfile', 'saveProfile', 'function', { filePath: 'src/a.ts', line: 30 })
const SAVE_DRAFT = mk('src/d.ts#saveProfileDraft', 'saveProfileDraft', 'function', { filePath: 'src/d.ts', line: 5 })
// Уникальный partial.
const ONLY_PARTIAL = mk('src/e.ts#refreshToken', 'refreshToken', 'function', { filePath: 'src/e.ts', line: 12 })
// Частичная неоднозначность без единого точного имени: "refresh" → 2 partial.
const REFRESH_SESSION = mk('src/e.ts#refreshSession', 'refreshSession', 'function', { filePath: 'src/e.ts', line: 20 })
// Файловые узлы: id === путь.
const FILE_A = mk('src/a.ts', 'a.ts', 'file', { filePath: 'src/a.ts', line: 0 })
const FILE_B = mk('src/b.ts', 'b.ts', 'file', { filePath: 'src/b.ts', line: 0 })
// Одинаковый basename в двух каталогах — путь без каталога неоднозначен.
const FILE_IDX_1 = mk('src/api/index.ts', 'index.ts', 'file', { filePath: 'src/api/index.ts', line: 0 })
const FILE_IDX_2 = mk('src/ui/index.ts', 'index.ts', 'file', { filePath: 'src/ui/index.ts', line: 0 })
// Файл без одноимённых символов — запрос по имени файла без расширения.
const FILE_ZETA = mk('src/zeta.ts', 'zeta.ts', 'file', { filePath: 'src/zeta.ts', line: 0 })

const NODES = [INIT_A, INIT_B, INIT_CACHE, SAVE, SAVE_DRAFT, ONLY_PARTIAL, REFRESH_SESSION, FILE_A, FILE_B, FILE_IDX_1, FILE_IDX_2, FILE_ZETA]

const CALLER = mk('src/main.ts#boot', 'boot', 'function', { filePath: 'src/main.ts', line: 3 })
const EDGES = [
  {
    id: 'src/main.ts#boot|calls|src/a.ts#init|4', projectId: P,
    fromNode: 'src/main.ts#boot', toNode: 'src/a.ts#init',
    type: 'calls', precision: 'resolved', filePath: 'src/main.ts', line: 4,
  },
]

const NODES_ALL = [...NODES, CALLER]

/** mapStore-шим: LIKE-поиск и порядок как в SQL findNodes (exact → prefix → rest). */
function makeStore() {
  const store = {
    getStatus: () => ({ projectId: P, state: 'ready', totalFiles: 2, indexedFiles: 2, totalNodes: NODES_ALL.length, totalEdges: EDGES.length, startedAt: null, updatedAt: 0, error: null }),
    getNode: (_pid, id) => NODES_ALL.find(n => n.id === id) ?? null,
    findNodes: (_pid, q, limit = 30) => {
      const lower = q.toLowerCase()
      const rank = (n) => (n.name === q ? 0 : n.name.toLowerCase().startsWith(lower) ? 1 : 2)
      return NODES_ALL
        .filter(n => n.kind !== 'package' && n.name.toLowerCase().includes(lower))
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
        .slice(0, limit)
    },
    listFiles: () => [FILE_A, FILE_B, FILE_IDX_1, FILE_IDX_2, FILE_ZETA].map(n => ({ projectId: P, path: n.filePath })),
    getCallers: (_pid, id, limit) => EDGES.filter(e => e.toNode === id && (e.type === 'calls' || e.type === 'references')).slice(0, limit),
    getCallees: (_pid, id, limit) => EDGES.filter(e => e.fromNode === id && (e.type === 'calls' || e.type === 'references')).slice(0, limit),
    countNodeEdges: (pid, id, direction) => (direction === 'in' ? store.getCallers(pid, id) : store.getCallees(pid, id)).length,
    getImportHubs: () => [],
    getFileSymbols: (_pid, p, limit) => {
      const nodes = NODES_ALL.filter(n => n.filePath === p && n.kind !== 'file' && n.kind !== 'package')
      return { total: nodes.length, nodes: nodes.slice(0, limit) }
    },
    getFileEdges: () => [],
  }
  return store
}

/** mapAnalytics-шим: фиксируем, КАКОЙ узел доехал до аналитики. */
function makeAnalytics(calls, coverage) {
  return {
    getSnapshot: () => ({ nodes: { size: 20_000 }, edges: 120_000, coverage }),
    godNodes: () => [],
    computeCommunities: () => ({ communities: [], assignment: new Map() }),
    findPath: (_pid, from, to) => {
      calls.path.push({ from, to })
      return { found: false, hops: [], confidence: 0, weakest: null }
    },
    affectedNodes: (_pid, id) => {
      calls.affected.push(id)
      return { root: null, results: [], byFile: [] }
    },
  }
}

function loadTool(coverage = { nodesTruncated: false, edgesTruncated: false }) {
  const calls = { path: [], affected: [] }
  const tool = transpile('src/core/tools/projectMap.ts', {
    '../projectMap/mapStore': makeStore(),
    '../projectMap/mapSemantic': { searchSemantic: async () => ({ mode: 'none', indexedDocs: 0, totalDocs: 0, hits: [] }) },
    '../projectMap/mapAnalytics': makeAnalytics(calls, coverage),
    '../logger': { log: () => {} },
  })
  return { tool, calls }
}

const run = (tool, args) => tool.projectMapQuery(args, P)

test('truncated analytics warns before negative path and impact results, not on callers', async () => {
  const { tool } = loadTool({ nodesTruncated: true, edgesTruncated: false })
  const pathResult = await run(tool, { action: 'path', query: INIT_A.id, to: SAVE.id })
  const impactResult = await run(tool, { action: 'affected', nodeId: INIT_A.id })
  for (const result of [pathResult, impactResult]) {
    assert.equal(result.success, true)
    assert.match(result.output, /^NOTE: analytics snapshot truncated \(cap: 20,000 nodes\)/)
    assert.match(result.output, /not proof of absence/)
  }
  assert.doesNotMatch((await run(tool, { action: 'callers', nodeId: INIT_A.id })).output, /snapshot truncated/)
})

// ─── callers / callees / explain ─────────────────────────────────────────────

test('callers: два одноимённых символа — отказ с кандидатами (path:line + nodeId)', async () => {
  const { tool } = loadTool()
  const res = await run(tool, { action: 'callers', query: 'init' })

  assert.equal(res.success, false, 'молча выбрать одного из двух нельзя')
  assert.match(res.error, /Ambiguous/)
  assert.match(res.error, /src\/a\.ts:10/, 'кандидат 1: файл и строка')
  assert.match(res.error, /src\/b\.ts:42/, 'кандидат 2: файл и строка')
  assert.match(res.error, /nodeId: src\/a\.ts#init/, 'кандидат 1: точный id')
  assert.match(res.error, /nodeId: src\/b\.ts#init/, 'кандидат 2: точный id')
})

test('explain/callees: неоднозначность тоже возвращает кандидатов, а не первый узел', async () => {
  const { tool } = loadTool()
  for (const action of ['explain', 'callees']) {
    const res = await run(tool, { action, query: 'init' })
    assert.equal(res.success, false, `${action}: должен отказать`)
    assert.match(res.error, /Ambiguous/)
    assert.match(res.error, /src\/b\.ts:42/)
  }
})

test('точный nodeId имеет приоритет над неоднозначным query', async () => {
  const { tool } = loadTool()
  const res = await run(tool, { action: 'callers', query: 'init', nodeId: 'src/a.ts#init' })
  assert.equal(res.success, true)
  assert.match(res.output, /Callers of init \[function\] — src\/a\.ts:10/)
  assert.match(res.output, /boot/, 'связи взяты у выбранного узла')
})

test('устаревший nodeId — честная ошибка, а не подмена однофамильцем', async () => {
  const { tool } = loadTool()
  const res = await run(tool, { action: 'callers', query: 'init', nodeId: 'src/gone.ts#init' })
  assert.equal(res.success, false)
  assert.match(res.error, /No map node with id "src\/gone\.ts#init"/)
  assert.doesNotMatch(res.error, /src\/a\.ts:10/, 'другой символ не подставляется')
})

// ─── приоритет точного имени над partial ─────────────────────────────────────

test('уникальное точное имя важнее partial-совпадения (saveProfile vs saveProfileDraft)', async () => {
  const { tool } = loadTool()
  const res = await run(tool, { action: 'explain', query: 'saveProfile' })
  assert.equal(res.success, true, 'exact-имя однозначно — уточнение не нужно')
  assert.match(res.output, /saveProfile \[function\] — src\/a\.ts:30/)
})

test('уникальный partial разрешается без отказа', async () => {
  const { tool } = loadTool()
  const res = await run(tool, { action: 'explain', query: 'refreshTok' })
  assert.equal(res.success, true)
  assert.match(res.output, /refreshToken \[function\] — src\/e\.ts:12/)
})

test('несколько partial-совпадений — тоже кандидаты, а не первый', async () => {
  const { tool } = loadTool()
  const res = await run(tool, { action: 'callers', query: 'refresh' })
  assert.equal(res.success, false)
  assert.match(res.error, /Ambiguous target "refresh" — 2 nodes match/)
  assert.match(res.error, /src\/e\.ts:12/, 'partial-кандидат 1')
  assert.match(res.error, /src\/e\.ts:20/, 'partial-кандидат 2')
})

test('уточнение "файл#имя" снимает неоднозначность (в т.ч. по basename)', async () => {
  const { tool } = loadTool()

  const full = await run(tool, { action: 'explain', query: 'src/b.ts#ini' })
  assert.equal(full.success, true, 'файл ограничивает поиск, partial внутри файла однозначен')
  assert.match(full.output, /init \[function\] — src\/b\.ts:42/)

  const base = await run(tool, { action: 'callers', query: 'b.ts#ini' })
  assert.equal(base.success, true)
  assert.match(base.output, /Callers of init \[function\] — src\/b\.ts:42/)

  const outside = await run(tool, { action: 'explain', query: 'src/b.ts#saveProfile' })
  assert.equal(outside.success, false, 'имя вне указанного файла не подставляется')
  assert.match(outside.error, /No map node matches/)
})

test('запрос по имени файла без расширения разрешается в файловый узел', async () => {
  const { tool, calls } = loadTool()
  const res = await run(tool, { action: 'affected', query: 'zeta' })
  assert.equal(res.success, true)
  assert.deepEqual(calls.affected, ['src/zeta.ts'], 'доехал id файлового узла')
})

// ─── path: обе точки маршрута ────────────────────────────────────────────────

test('path: неоднозначный старт и неоднозначный конец различимы в тексте ошибки', async () => {
  const { tool, calls } = loadTool()

  const start = await run(tool, { action: 'path', query: 'init', to: 'src/a.ts#saveProfile' })
  assert.equal(start.success, false)
  assert.match(start.error, /Ambiguous path start "init"/)
  assert.match(start.error, /src\/b\.ts:42/)
  assert.deepEqual(calls.path, [], 'аналитика не вызывается при неоднозначности')

  const end = await run(tool, { action: 'path', query: 'src/a.ts#saveProfile', to: 'init' })
  assert.equal(end.success, false)
  assert.match(end.error, /Ambiguous path end "init"/)
  assert.deepEqual(calls.path, [])
})

test('path: точный путь файла как endpoint работает (id === путь)', async () => {
  const { tool, calls } = loadTool()
  const res = await run(tool, { action: 'path', query: 'src/a.ts', to: 'saveProfile' })
  assert.equal(res.success, true)
  assert.deepEqual(calls.path, [{ from: 'src/a.ts', to: 'src/a.ts#saveProfile' }])
  assert.match(res.output, /No path found from a\.ts to saveProfile/)
})

test('path: путь с обратными слэшами и ./ нормализуется, а не ищется как имя', async () => {
  const { tool, calls } = loadTool()
  const res = await run(tool, { action: 'path', query: '.\\src\\b.ts', to: 'saveProfile' })
  assert.equal(res.success, true)
  assert.deepEqual(calls.path, [{ from: 'src/b.ts', to: 'src/a.ts#saveProfile' }])
})

test('path: одинаковый basename в разных каталогах — кандидаты с полными путями', async () => {
  const { tool, calls } = loadTool()
  const res = await run(tool, { action: 'path', query: 'index.ts', to: 'saveProfile' })
  assert.equal(res.success, false)
  assert.match(res.error, /Ambiguous path start "index\.ts"/)
  assert.match(res.error, /src\/api\/index\.ts/)
  assert.match(res.error, /src\/ui\/index\.ts/)
  assert.deepEqual(calls.path, [])
})

// ─── affected ────────────────────────────────────────────────────────────────

test('affected: неоднозначная цель и неоднозначный путь — кандидаты, аналитика не зовётся', async () => {
  const { tool, calls } = loadTool()

  const byName = await run(tool, { action: 'affected', query: 'init' })
  assert.equal(byName.success, false)
  assert.match(byName.error, /Ambiguous target "init"/)

  const byPath = await run(tool, { action: 'affected', path: 'index.ts' })
  assert.equal(byPath.success, false)
  assert.match(byPath.error, /Ambiguous file path "index\.ts"/)
  assert.match(byPath.error, /src\/api\/index\.ts/)

  assert.deepEqual(calls.affected, [])
})

test('affected: точный путь файла и уникальное имя доезжают до аналитики как id', async () => {
  const { tool, calls } = loadTool()

  const byPath = await run(tool, { action: 'affected', path: './src/a.ts' })
  assert.equal(byPath.success, true)
  assert.deepEqual(calls.affected, ['src/a.ts'])

  const byName = await run(tool, { action: 'affected', query: 'saveProfile' })
  assert.equal(byName.success, true)
  assert.deepEqual(calls.affected, ['src/a.ts', 'src/a.ts#saveProfile'])
})

test('affected: устаревший nodeId не подменяется одноимённым символом', async () => {
  const { tool, calls } = loadTool()
  const res = await run(tool, { action: 'affected', nodeId: 'src/gone.ts#init' })
  assert.equal(res.success, false)
  assert.match(res.error, /No map node with id/)
  assert.deepEqual(calls.affected, [])
})

// ─── search: результаты можно различить ──────────────────────────────────────

test('search: каждый результат содержит nodeId, а неоднозначное имя не приклеивает связи', async () => {
  const { tool } = loadTool()
  const res = await run(tool, { action: 'search', query: 'init' })
  assert.equal(res.success, true)
  assert.match(res.output, /\[nodeId: src\/a\.ts#init\]/)
  assert.match(res.output, /\[nodeId: src\/b\.ts#init\]/)
  assert.doesNotMatch(res.output, /Callers of/, 'связи одного из однофамильцев не выдаются за связи всех')
  assert.match(res.output, /pass "nodeId" to pick one/)
})

test('search: единственное точное имя различимо среди partial-совпадений', async () => {
  const { tool } = loadTool()
  const many = await run(tool, { action: 'search', query: 'init', limit: 100 })
  assert.match(many.output, /2 symbols named "init" — pass "nodeId" to pick one/)
  assert.doesNotMatch(many.output, /Callers of/)

  const one = await run(tool, { action: 'search', query: 'saveProfile', limit: 100 })
  assert.match(one.output, /\[nodeId: src\/a\.ts#saveProfile\]/)
  assert.match(one.output, /\[nodeId: src\/d\.ts#saveProfileDraft\]/, 'partial-совпадение тоже видно с id')
  assert.match(one.output, /partial match\(es\) listed above/, 'агент знает, что связи — от exact-узла')
})
