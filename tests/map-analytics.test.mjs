/**
 * mapAnalytics + гигиена сканирования (git-file-list, gitignore `**`/`!`,
 * markdown-секции, exported по исходнику, trimToBudget).
 *
 * Analytics проверяется на синтетическом графе через шим mapStore — без БД.
 * Файлы транспилируются на лету (тот же паттерн, что в map-semantic.test.mjs).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
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

// Шим mapStore для mapResolver: id-функции детерминированы, БД не нужна.
const RESOLVER_SHIM = {
  './mapStore': {
    fileNodeId: (p) => p,
    symbolNodeId: (file, name, parent) => (parent ? `${file}#${parent}.${name}` : `${file}#${name}`),
    packageNodeId: (name) => `pkg:${name}`,
    edgeId: (from, type, to, line) => `${from}|${type}|${to}|${line}`,
    ensurePackageNode: () => {},
  },
}

// ─── Синтетический граф ──────────────────────────────────────────────────────

const P = 'p1'
const mk = (id, name, kind, opts = {}) => ({
  id, projectId: P, filePath: opts.filePath ?? 'src/a.ts', name, kind,
  parentName: null, lineStart: opts.line ?? 1, lineEnd: (opts.line ?? 1) + 5,
  signature: opts.signature ?? '', exported: opts.exported ?? false, doc: opts.doc ?? null,
})
const mkEdge = (from, to, type = 'calls', precision = 'resolved', line = 1) => ({
  id: `${from}|${type}|${to}|${line}`, projectId: P, fromNode: from, toNode: to,
  type, precision, filePath: 'src/a.ts', line,
})

function loadAnalytics(edges, nodes) {
  const store = {
    listNodes: (_pid, limit) => nodes.slice(0, limit),
    listAnalysisEdges: (_pid, limit) => edges.slice(0, limit),
    getNode: (_pid, id) => nodes.find(n => n.id === id) ?? null,
    findNodes: (_pid, q) => nodes.filter(n => n.name.includes(q)),
  }
  return transpile('src/core/projectMap/mapAnalytics.ts', { './mapStore': store })
}

const A = mk('src/a.ts#loadUserProfile', 'loadUserProfile', 'function')
const B = mk('src/a.ts#normalizeProfile', 'normalizeProfile', 'function')
const C = mk('src/a.ts#saveProfile', 'saveProfile', 'function')
const X = mk('src/x.ts#fetchProfileList', 'fetchProfileList', 'function', { filePath: 'src/x.ts' })
const Y = mk('src/y.ts#orphanHelper', 'orphanHelper', 'function', { filePath: 'src/y.ts' })
// Generic-имя: в реальном графе такие узлы набирают сотни heuristic-рёбер.
const PUSH = mk('tests/mock.ts#push', 'push', 'function', { filePath: 'tests/mock.ts' })
const FILE = mk('src/a.ts', 'a.ts', 'file')
const PKG = mk('pkg:react', 'react', 'package', { filePath: '' })

const EDGES = [
  mkEdge(A.id, B.id, 'calls', 'resolved', 3),
  mkEdge(B.id, C.id, 'calls', 'heuristic', 4),
  mkEdge(X.id, A.id, 'calls', 'resolved', 5),
  mkEdge(X.id, B.id, 'calls', 'resolved', 6),
  mkEdge(C.id, PUSH.id, 'calls', 'heuristic', 7),
  mkEdge(A.id, PUSH.id, 'calls', 'heuristic', 8),
  mkEdge(B.id, PUSH.id, 'calls', 'heuristic', 9),
  mkEdge(FILE.id, PKG.id, 'imports', 'external', 1),
]

test('analytics coverage distinguishes exact caps from truncated rows', () => {
  const nodes = Array(20_000).fill(A)
  const edges = Array(120_000).fill(EDGES[7])
  const exact = loadAnalytics(edges, nodes).getSnapshot(P)
  assert.deepEqual(exact.coverage, { nodesTruncated: false, edgesTruncated: false })
  const truncated = loadAnalytics([...edges, EDGES[0]], [...nodes, B]).getSnapshot(P)
  assert.deepEqual(truncated.coverage, { nodesTruncated: true, edgesTruncated: true })
  assert.equal(truncated.edges, 120_000)
  assert.equal(truncated.nodes.has(B.id), false)
})

test('godNodes — взвешенный degree, без файлов/пакетов и generic-имён', () => {
  const api = loadAnalytics(EDGES, [A, B, C, X, Y, PUSH, FILE, PKG])
  const gods = api.godNodes(P, 10)
  const names = gods.map(g => g.node.name)
  assert.ok(names.includes('normalizeProfile'), 'у него 2 входящих + 1 исходящее')
  assert.ok(!names.includes('push'), 'generic-имя отфильтровано')
  assert.ok(!names.includes('react'), 'внешний пакет исключён')
  assert.ok(!names.includes('a.ts'), 'файлы не god nodes')
  assert.ok(!names.includes('orphanHelper'), 'узел без рёбер не попадает')
  const b = gods.find(g => g.node.name === 'normalizeProfile')
  assert.deepEqual([b.fanIn, b.fanOut], [2, 2])
})

test('findPath — путь через цепочку и уверенность по слабейшему ребру', () => {
  const api = loadAnalytics(EDGES, [A, B, C, X, Y, PUSH, FILE, PKG])
  const res = api.findPath(P, A.id, C.id)
  assert.equal(res.found, true)
  assert.equal(res.hops.length, 3, 'loadUserProfile → normalizeProfile → saveProfile')
  assert.deepEqual(res.hops.map(h => h.node.name), ['loadUserProfile', 'normalizeProfile', 'saveProfile'])
  assert.equal(res.weakest, 'heuristic', 'слабое звено — эвристическое ребро')
  assert.equal(res.confidence, 0.6)
})

test('findPath — нет пути при ограничении по типам рёбер', () => {
  const api = loadAnalytics(EDGES, [A, B, C, X, Y, PUSH, FILE, PKG])
  const res = api.findPath(P, A.id, C.id, { relations: ['references'] })
  assert.equal(res.found, false)
  assert.equal(res.hops.length, 0)
})

test('affectedNodes — обратная достижимость: что заденет правка saveProfile', () => {
  const api = loadAnalytics(EDGES, [A, B, C, X, Y, PUSH, FILE, PKG])
  const res = api.affectedNodes(P, C.id, { depth: 3 })
  const names = res.results.map(r => r.node.name)
  assert.ok(names.includes('normalizeProfile'), 'прямой вызывающий')
  assert.ok(names.includes('loadUserProfile'), 'транзитивно через normalizeProfile')
  assert.ok(names.includes('fetchProfileList'), 'транзитивно через normalizeProfile')
  assert.equal(names[0], 'normalizeProfile', 'первым идёт depth 1')
  assert.ok(res.byFile.some(f => f.filePath === 'src/a.ts'))
})

test('affectedNodes — для файла стартует со всех его символов', () => {
  const api = loadAnalytics(EDGES, [A, B, C, X, Y, PUSH, FILE, PKG])
  const res = api.affectedNodes(P, FILE.id, { depth: 2 })
  assert.ok(res.results.every(r => r.node.kind !== 'file'))
  assert.ok(res.results.length >= 1)
})

test('computeCommunities — компонента слипается в кластеры, изолированный узел отдельно', () => {
  // Файл-узел + приватные поля без связей: метка не должна строиться из них.
  const PRIV = mk('src/p.ts#_cache', '_cache', 'field', { filePath: 'src/p.ts' })
  const KEEP = mk('src/p.ts#_buffer', '_buffer', 'field', { filePath: 'src/p.ts' })
  const api = loadAnalytics(
    [...EDGES, mkEdge(FILE.id, PRIV.id, 'contains', 'resolved', 1), mkEdge(FILE.id, KEEP.id, 'contains', 'resolved', 2)],
    [A, B, C, X, Y, PUSH, FILE, PKG, PRIV, KEEP],
  )
  const { communities, assignment } = api.computeCommunities(P)
  const sizes = communities.map(c => c.size).sort((a, b) => b - a)
  assert.ok(sizes[0] >= 2, `есть слипшиеся кластеры (крупнейший ${sizes[0]})`)
  assert.ok(communities.every(c => c.label.length > 0), 'метка непуста')
  assert.ok(communities.every(c => !/^push\b/.test(c.label)), 'generic-имена не в метке')
  assert.ok(communities.every(c => !/_cache|_buffer/.test(c.label)), 'приватные поля без fan-in не в метке')
})

// ─── exported по исходнику ───────────────────────────────────────────────────

test('markExported — export/pub/public по тексту, Go по заглавной, Python по «_»', () => {
  const api = transpile('src/core/projectMap/mapResolver.ts', RESOLVER_SHIM)
  const tsContent = [
    'export function validateAccess(u) {',
    '  return true',
    '}',
    'function helper() {}',
    'export default class Store {}',
    'export interface ModelPrice {',
    '}',
  ].join('\n')
  const nodes = [
    mk('f1', 'validateAccess', 'function', { line: 1 }),
    mk('f2', 'helper', 'function', { line: 4 }),
    mk('f3', 'Store', 'class', { line: 5 }),
    mk('f4', 'ModelPrice', 'interface', { line: 6 }),
  ]
  api.markExported(nodes, tsContent, 'typescript')
  assert.equal(nodes[0].exported, true, 'export function → exported')
  assert.equal(nodes[1].exported, false, 'приватная функция → не exported')
  assert.equal(nodes[2].exported, true, 'export default class → exported')
  assert.equal(nodes[3].exported, true, 'export interface → exported')

  const go = [mk('g1', 'Public', 'function', { line: 1 }), mk('g2', 'private', 'function', { line: 4 })]
  api.markExported(go, 'func Public() {\n}\nfunc private() {\n}', 'go')
  assert.equal(go[0].exported, true, 'Go: заглавная буква = публичный')
  assert.equal(go[1].exported, false)

  const py = [mk('p1', 'login', 'function', { line: 1 }), mk('p2', '_helper', 'function', { line: 4 })]
  api.markExported(py, 'def login():\n    pass\n\ndef _helper():\n    pass', 'python')
  assert.equal(py[0].exported, true)
  assert.equal(py[1].exported, false, 'Python: подчёркивание = приватный')

  // Kotlin/Dart/Swift: публичность по умолчанию, приватность — модификатором.
  const kt = [
    mk('k1', 'loadUsers', 'function', { line: 1 }),
    mk('k2', 'secret', 'function', { line: 2 }),
    mk('k3', 'internalThing', 'function', { line: 3 }),
  ]
  api.markExported(kt, [
    'fun loadUsers(): List<User> {',
    'private fun secret() {}',
    'internal fun internalThing() {}',
  ].join('\n'), 'kotlin')
  assert.equal(kt[0].exported, true, 'Kotlin: fun без модификатора = public')
  assert.equal(kt[1].exported, false, 'Kotlin: private → не exported')
  assert.equal(kt[2].exported, false, 'Kotlin: internal → не exported')

  const dart = [mk('d1', 'build', 'function', { line: 1 }), mk('d2', '_internal', 'function', { line: 3 })]
  api.markExported(dart, 'Widget build() {}\nWidget _internal() {}', 'dart')
  assert.equal(dart[0].exported, true, 'Dart: без «_» = публичный')
  assert.equal(dart[1].exported, false, 'Dart: «_» = приватный')
})

// ─── Markdown-секции ─────────────────────────────────────────────────────────

test('parseMarkdownSections/markdownNodes — секции по заголовкам, id уникальны', () => {
  const api = transpile('src/core/projectMap/mapResolver.ts', RESOLVER_SHIM)
  const md = ['# Проект', 'Описание.', '', '## Установка', 'npm i', '', '## Установка', 'второй раз'].join('\n')
  const sections = api.parseMarkdownSections(md)
  assert.equal(sections.length, 3)
  assert.deepEqual(sections.map(s => s.title), ['Проект', 'Установка', 'Установка'])
  assert.equal(sections[0].lineStart, 1)
  assert.equal(sections[1].lineStart, 4)

  const nodes = api.markdownNodes(P, 'README.md', md)
  assert.equal(nodes[0].kind, 'file')
  const secs = nodes.filter(n => n.kind === 'section')
  assert.equal(secs.length, 3)
  assert.equal(new Set(secs.map(s => s.id)).size, 3, 'одинаковые заголовки → разные id (по строке)')
  assert.ok(secs[1].doc.includes('npm i'), 'текст секции попадает в doc')
})

// ─── gitignore: ** и ! ───────────────────────────────────────────────────────

test('gitignore — `**` и отрицание `!` работают (сгенерированные .d.ts не индексируются)', () => {
  const api = transpile('src/core/mentions/fileIndexer.ts', {
    '../../shared/mentions': {
      filterMentions: (i) => i,
      mimeFromExt: () => 'text/plain',
      mentionTypeFromFilename: () => 'file',
    },
  })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-gi2-'))
  fs.writeFileSync(path.join(tmp, '.gitignore'), [
    'node_modules',
    'src/**/*.d.ts',
    '!src/preload/index.d.ts',
  ].join('\n'))
  try {
    const gi = api.parseGitignore(tmp)
    const ign = (rel) => api.isIgnored(rel, rel.split('/').pop(), gi)
    assert.equal(ign('src/core/db/store.d.ts'), true, '** матчит вложенный .d.ts')
    assert.equal(ign('src/a.d.ts'), true, '** матчит .d.ts в корне src')
    assert.equal(ign('src/preload/index.d.ts'), false, 'отрицание возвращает файл')
    assert.equal(ign('src/core/db/store.ts'), false, 'обычный .ts не тронут')
    assert.equal(ign('node_modules/ms/index.js'), true, 'node_modules из IGNORED_DIRS')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('isIgnored с git-списком — файла нет в git → он не часть проекта', () => {
  const api = transpile('src/core/mentions/fileIndexer.ts', {
    '../../shared/mentions': {
      filterMentions: (i) => i,
      mimeFromExt: () => 'text/plain',
      mentionTypeFromFilename: () => 'file',
    },
  })
  const gi = api.parseGitignore(path.join(root, 'no-such-dir'))
  const gitFiles = new Set(['src/kept.ts'])
  assert.equal(api.isIgnored('src/kept.ts', 'kept.ts', gi, gitFiles), false)
  assert.equal(api.isIgnored('src/generated.d.ts', 'generated.d.ts', gi, gitFiles), true)
})

// ─── Прокидывание аргументов тула (ловушка «белый список забыл поле») ──────

test('project_map args прокидываются целиком во ВСЕХ трёх точках RPC', () => {
  // Живой баг: toolDispatcher/AgentManager/chatSendEngine собирали аргументы
  // ручным списком, и `to`/`depth`/`relations`/`budget` молча терялись —
  // action=path всегда отвечал «requires query and to». Сторож фиксирует,
  // что каждое поле доезжает до projectMapQuery.
  const files = [
    'src/core/agent/toolDispatcher.ts',
    'src/main/managers/AgentManager.ts',
    'src/main/ipc/chatSendEngine.ts',
  ]
  const required = ['to', 'depth', 'relations', 'budget']
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    for (const field of required) {
      const re = new RegExp(`\\b${field}:\\s*(msg|resolvedArgs)\\.${field}\\b`)
      assert.match(src, re, `${rel}: аргумент "${field}" должен прокидываться в projectMapQuery`)
    }
  }
})

// ─── Бюджет ответа тула ──────────────────────────────────────────────────────

test('refreshCounts — в ready totalFiles = фактическим файлам (колонка «Файлы» больше не врёт)', () => {
  const Database = nodeRequire('better-sqlite3')
  const db = new Database(':memory:')
  transpile('src/core/db/migrations/codeMap.ts', {}).runCodeMapSchema(db)
  const store = transpile('src/core/projectMap/mapStore.ts', { '../db/handle': { getDB: () => db } })
  const meta = (p) => ({ projectId: P, path: p, language: 'typescript', hash: 'h', mtime: 1, size: 1, parser: 'ts', truncated: false, indexedAt: 1 })
  store.replaceFile(P, meta('a.ts'), [mk('a.ts', 'a.ts', 'file', { filePath: 'a.ts' })], [])
  store.setStatus(P, { state: 'building', totalFiles: 10 })
  store.refreshCounts(P)
  assert.equal(store.getStatus(P).totalFiles, 10, 'во время сборки totalFiles — план скана')
  store.setStatus(P, { state: 'ready' })
  store.refreshCounts(P)
  assert.equal(store.getStatus(P).totalFiles, 1, 'в готовой карте — фактическое число файлов')
  assert.equal(store.getStatus(P).indexedFiles, 1)
})

test('trimToBudget — режет по токенам и честно пишет, сколько ушло', () => {  const api = transpile('src/core/tools/projectMap.ts', {
    '../projectMap/mapStore': {},
    '../projectMap/mapSemantic': {},
    '../projectMap/mapAnalytics': {},
    '../logger': { log: () => {} },
  })
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(60)}`)
  const out = api.trimToBudget(lines, 100)
  assert.ok(out.length <= 300, 'подвал входит в бюджет')
  assert.match(out, /trimmed \d+ lines by budget/, 'подвал говорит, сколько строк ушло')

  const small = api.trimToBudget(['a', 'b'], 2000)
  assert.equal(small, 'a\nb', 'маленький ответ не трогаем')
  assert.ok(api.trimToBudget(lines, Number.MAX_VALUE).length <= 12_000, 'параметр не снимает защитный предел')
  assert.equal(api.trimToBudget(lines, undefined), api.trimToBudget(lines, 900), 'некорректный бюджет получает дефолт')
})
