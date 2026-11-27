/**
 * mapStore — новые выборки/записи для инкрементального mapBuilder на РЕАЛЬНОМ
 * SQLite (better-sqlite3 in-memory + настоящая схема code_map_*).
 *
 * Покрывается:
 *  - getDependentFilePaths: входящие imports/calls/references на файловый узел
 *    и на символы файла, distinct, без самого файла, без чужих типов рёбер;
 *  - replaceFileEdges: атомарная замена ТОЛЬКО рёбер файла (узлы и рёбра
 *    других файлов не трогаются), откат при ошибке вставки;
 *  - getFile: одна строка по PK (project_id, path), индекс в плане запроса;
 *  - план запроса getDependentFilePaths не содержит full scan'а по edges/nodes.
 *
 * mapStore и схема транспилируются на лету (паттерн map-builder.test.mjs),
 * зависимость `../db/handle` подменяется на in-memory БД.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
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

/** Свежая in-memory БД со схемой карты + загруженный mapStore поверх неё. */
function setup() {
  const Database = nodeRequire('better-sqlite3')
  const db = new Database(':memory:')
  transpile('src/core/db/migrations/codeMap.ts').runCodeMapSchema(db)
  const store = transpile('src/core/projectMap/mapStore.ts', { '../db/handle': { getDB: () => db } })
  return { db, store }
}

function insertNode(db, id, filePath, name, kind = 'function') {
  db.prepare(
    `INSERT OR REPLACE INTO code_map_nodes (id, project_id, file_path, name, kind, parent_name, line_start, line_end, signature, exported)
     VALUES (?, ?, ?, ?, ?, NULL, 1, 2, '', 0)`
  ).run(id, P, filePath, name, kind)
}

function insertEdge(db, { from, to, type = 'imports', filePath, line = 1, precision = 'resolved' }) {
  const id = `${from}|${type}|${to}|${line}`
  db.prepare(
    `INSERT OR REPLACE INTO code_map_edges (id, project_id, from_node, to_node, type, precision, file_path, line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, P, from, to, type, precision, filePath, line)
  return id
}

function mkEdge({ from, to, type = 'calls', filePath, line = 1, precision = 'resolved' }) {
  return {
    id: `${from}|${type}|${to}|${line}`,
    projectId: P,
    fromNode: from,
    toNode: to,
    type,
    precision,
    filePath,
    line,
  }
}

const edgeRows = (db) => db.prepare(
  `SELECT id, from_node, to_node, type, file_path FROM code_map_edges WHERE project_id = ? ORDER BY id`
).all(P)

test('legacy graph migration keeps surviving rows and schedules one reconciliation', () => {
  const { db, store } = setup()
  const { runCodeMapSchema } = transpile('src/core/db/migrations/codeMap.ts')
  try {
    // Use the previous key layout and simulate a database from before doc was added.
    for (const table of ['code_map_nodes', 'code_map_edges']) {
      const { sql } = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table)
      db.exec(`DROP TABLE ${table}`)
      db.exec(sql.replace(/id\s+TEXT NOT NULL,/, 'id TEXT PRIMARY KEY,')
        .replace(/,\s*PRIMARY KEY \(project_id, id\)/, '')
        .replace(/,\s*doc\s+TEXT/, ''))
    }
    insertNode(db, 'src/index.ts', 'src/index.ts', 'index.ts', 'file')
    insertNode(db, 'src/index.ts#parse', 'src/index.ts', 'parse')
    insertEdge(db, { from: 'src/index.ts', to: 'src/index.ts#parse', type: 'contains', filePath: 'src/index.ts' })
    store.setMeta(P, 'schemaVersion', '5')
    store.setMeta(P, 'other', 'keep')
    store.setStatus(P, { state: 'ready' })

    runCodeMapSchema(db)
    assert.equal(store.getFileGraph(P, 'src/index.ts').nodes.length, 2)
    assert.equal(store.getFileGraph(P, 'src/index.ts').edges.length, 1)
    assert.equal(store.getNode(P, 'src/index.ts#parse').doc, null)
    assert.equal(store.getMeta(P, 'schemaVersion'), null)
    assert.equal(store.getMeta(P, 'other'), 'keep')
    assert.equal(store.getStatus(P).state, 'partial')
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_cmn_project_file'").get())
    store.setMeta(P, 'schemaVersion', '5')
    runCodeMapSchema(db)
    assert.equal(store.getMeta(P, 'schemaVersion'), '5')
  } finally { db.close() }
})

test('file rewrite and neighbor queries remain isolated across projects with identical paths', () => {
  const { db, store } = setup()
  try {
    const path = 'src/index.ts'
    const target = store.symbolNodeId(path, 'parse')
    const file = { path, language: 'typescript', hash: 'fixture', mtime: 1, size: 1, parser: null, truncated: false, indexedAt: 1 }
    db.transaction(() => {
      for (const projectId of [P, 'p2']) {
        const nodes = [{ id: target, projectId, filePath: path, name: 'parse', kind: 'function',
          parentName: null, lineStart: 1, lineEnd: 2, signature: '', exported: true }]
        const edges = []
        const callers = projectId === P ? 24 : 1
        for (let i = 0; i < callers; i++) {
          const id = store.symbolNodeId(path, `caller${i}`)
          nodes.push({ ...nodes[0], id, name: `caller${i}` })
          edges.push(mkEdge({ from: id, to: target, filePath: path }))
          edges.push(mkEdge({ from: id, to: target, type: 'references', filePath: path }))
        }
        edges.push(mkEdge({ from: 'missing', to: target, filePath: path }))
        const pkg = store.ensurePackageNode(projectId, 'example')
        edges.push(mkEdge({ from: target, to: pkg, filePath: path, type: 'imports' }))
        store.replaceFile(projectId, file, nodes, edges)
      }
    })()
    assert.equal(store.getNode(P, target).projectId, P)
    assert.equal(store.getNode('p2', target).projectId, 'p2')
    assert.equal(store.getCallers(P, target, 12).length, 12)
    assert.equal(store.countNodeEdges(P, target, 'in'), 49)
    assert.equal(store.getFileSymbols(P, path, 12).total, 25)
    assert.equal(store.getFileSymbols(P, path, 12).nodes.length, 12)
    const neighbors = store.getNeighbors(P, target)
    assert.equal(neighbors.callerCount, 24)
    assert.equal(neighbors.callers.length, 20)
    assert.equal(new Set(neighbors.callers.map(n => n.id)).size, 20)
    assert.equal(store.getNeighbors('p2', target).callerCount, 1)
    assert.deepEqual(store.getImportHubs(P), [{ label: 'example (external package)', count: 1 }])
    store.removeFile('p2', path)
    assert.equal(store.getNeighbors(P, target).callerCount, 24)
  } finally { db.close() }
})

// ─── getDependentFilePaths ───────────────────────────────────────────────────

test('getDependentFilePaths: imports/calls/references на файл и его символы, distinct, без себя', () => {
  const { db, store } = setup()
  // файловые узлы + один символ b.ts
  for (const p of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) insertNode(db, p, p, p, 'file')
  insertNode(db, 'b.ts#foo', 'b.ts', 'foo')

  insertEdge(db, { from: 'a.ts', to: 'b.ts', type: 'imports', filePath: 'a.ts' })
  insertEdge(db, { from: 'c.ts', to: 'b.ts#foo', type: 'calls', filePath: 'c.ts' })
  insertEdge(db, { from: 'd.ts', to: 'b.ts#foo', type: 'references', filePath: 'd.ts' })
  // второй источник на тот же файл — не должен задвоить a.ts
  insertEdge(db, { from: 'a.ts', to: 'b.ts#foo', type: 'calls', filePath: 'a.ts', line: 7 })
  // «contains» — не зависимость
  insertEdge(db, { from: 'e.ts', to: 'e.ts#bar', type: 'contains', filePath: 'e.ts' })
  // self-импорт исключается
  insertEdge(db, { from: 'b.ts', to: 'b.ts', type: 'imports', filePath: 'b.ts' })
  // внешний пакет — не файл
  insertEdge(db, { from: 'e.ts', to: 'pkg:react', type: 'imports', filePath: 'e.ts', precision: 'external' })

  assert.deepEqual(store.getDependentFilePaths(P, 'b.ts').sort(), ['a.ts', 'c.ts', 'd.ts'])
  assert.deepEqual(store.getDependentFilePaths(P, 'zzz.ts'), [])
})

test('getDependentFilePaths: файловый узел находится даже без строки в code_map_nodes', () => {
  const { db, store } = setup()
  insertNode(db, 'a.ts', 'a.ts', 'a.ts', 'file')
  insertEdge(db, { from: 'a.ts', to: 'ghost.ts', type: 'imports', filePath: 'a.ts' })
  assert.deepEqual(store.getDependentFilePaths(P, 'ghost.ts'), ['a.ts'])
})

test('getDependentFilePaths: изоляция проектов и пустых file_path', () => {
  const { db, store } = setup()
  insertNode(db, 'a.ts', 'a.ts', 'a.ts', 'file')
  insertNode(db, 'b.ts', 'b.ts', 'b.ts', 'file')
  insertEdge(db, { from: 'a.ts', to: 'b.ts', type: 'imports', filePath: 'a.ts' })
  db.prepare(
    `INSERT INTO code_map_edges (id, project_id, from_node, to_node, type, precision, file_path, line)
     VALUES ('x', 'other', 'z.ts', 'b.ts', 'imports', 'resolved', 'z.ts', 1)`
  ).run()
  // ребро без файла-источника (пакетные/служебные) не превращается в ''
  db.prepare(
    `INSERT INTO code_map_edges (id, project_id, from_node, to_node, type, precision, file_path, line)
     VALUES ('y', ?, 'pkg:react', 'b.ts', 'imports', 'external', '', 1)`
  ).run(P)

  assert.deepEqual(store.getDependentFilePaths(P, 'b.ts'), ['a.ts'])
})

// ─── replaceFileEdges ───────────────────────────────────────────────────────

test('replaceFileEdges: меняет только рёбра указанного файла, узлы не трогает', () => {
  const { db, store } = setup()
  insertNode(db, 'a.ts', 'a.ts', 'a.ts', 'file')
  insertNode(db, 'b.ts', 'b.ts', 'b.ts', 'file')
  insertEdge(db, { from: 'a.ts', to: 'b.ts', type: 'imports', filePath: 'a.ts' })
  insertEdge(db, { from: 'b.ts', to: 'a.ts', type: 'imports', filePath: 'b.ts' })
  const keptB = edgeRows(db).find(r => r.file_path === 'b.ts')

  store.replaceFileEdges(P, 'a.ts', [
    mkEdge({ from: 'a.ts', to: 'b.ts#bar', type: 'calls', filePath: 'a.ts', line: 5 }),
  ])

  const rows = edgeRows(db)
  assert.deepEqual(rows.map(r => r.file_path), ['a.ts', 'b.ts'])
  assert.equal(rows.filter(r => r.file_path === 'a.ts').length, 1)
  assert.equal(rows.find(r => r.file_path === 'a.ts').to_node, 'b.ts#bar')
  assert.deepEqual(rows.find(r => r.file_path === 'b.ts'), keptB)
  assert.equal(
    db.prepare(`SELECT COUNT(*) c FROM code_map_nodes WHERE project_id = ?`).get(P).c,
    2,
  )
})

test('replaceFileEdges: ошибка вставки откатывает замену целиком', () => {
  const { db, store } = setup()
  insertNode(db, 'a.ts', 'a.ts', 'a.ts', 'file')
  insertEdge(db, { from: 'a.ts', to: 'b.ts', type: 'imports', filePath: 'a.ts', line: 1 })
  const before = edgeRows(db)

  const bad = mkEdge({ from: 'a.ts', to: 'c.ts', type: 'calls', filePath: 'a.ts', line: 2 })
  bad.type = null // NOT NULL constraint → бросает внутри транзакции

  assert.throws(() => store.replaceFileEdges(P, 'a.ts', [
    mkEdge({ from: 'a.ts', to: 'd.ts', type: 'calls', filePath: 'a.ts', line: 3 }),
    bad,
  ]))
  assert.deepEqual(edgeRows(db), before, 'старые рёбра должны остаться после отката')
})

// ─── getFile ────────────────────────────────────────────────────────────────

test('getFile: одна строка по PK, отсутствующий файл — null', () => {
  const { store } = setup()
  const file = {
    projectId: P, path: 'src/a.ts', language: 'typescript', hash: 'h1',
    mtime: 111, size: 222, parser: 'treesitter', truncated: false, indexedAt: 333,
  }
  store.replaceFile(P, file, [], [])

  assert.deepEqual(store.getFile(P, 'src/a.ts'), file)
  assert.equal(store.getFile(P, 'src/none.ts'), null)
  assert.equal(store.getFile('other', 'src/a.ts'), null)
})

// ─── Тег модели / backfill ──────────────────────────────────────────────────

test('upsertDocs: вектор с NULL-тегом не переносится — строка возвращается в очередь', () => {
  const { db, store } = setup()
  const doc = { nodeId: 'src/a.ts#f', filePath: 'src/a.ts', kind: 'function', tier: 1, text: 'v1', textHash: 'h1' }
  store.upsertDocs(P, [doc])
  // Легаси-строка: вектор есть, тег модели не проставлен.
  db.prepare(
    `UPDATE code_map_docs SET embedding = ?, embed_hash = text_hash, model = NULL, embedded_at = 1
     WHERE project_id = ? AND node_id = ?`
  ).run(Buffer.from([1, 2, 3]), P, doc.nodeId)

  // Переразбор без изменения текста: вектор с чужим/пустым тегом не переносим.
  store.upsertDocs(P, [doc])
  const row = db.prepare(
    `SELECT embedding, embed_hash, model FROM code_map_docs WHERE project_id = ? AND node_id = ?`
  ).get(P, doc.nodeId)
  assert.equal(row.embedding, null)
  assert.equal(row.embed_hash, null)
  assert.equal(row.model, null)

  // И строка снова в очереди worker'а (иначе вектор был бы невидим навсегда).
  assert.deepEqual(store.listPendingDocs(P, 10).map(d => d.nodeId), [doc.nodeId])
  assert.equal(store.countDocs(P).indexed, 0)

  // С актуальным тегом вектор переносится как раньше.
  store.saveDocEmbeddings(P, [{ nodeId: doc.nodeId, textHash: 'h1', embedding: Buffer.from([9]), model: 'e5', embeddedAt: 2 }])
  store.upsertDocs(P, [doc])
  const kept = db.prepare(
    `SELECT embed_hash, model FROM code_map_docs WHERE project_id = ? AND node_id = ?`
  ).get(P, doc.nodeId)
  assert.equal(kept.embed_hash, 'h1')
  assert.equal(kept.model, 'e5')
  assert.equal(store.countDocs(P).indexed, 1)
})

// ─── Неразрешённые ссылки (durable-след для точечного восстановления) ────────

test('replaceUnresolved/findUnresolvedByKeys: обратный lookup по kind+key, изоляция проектов', () => {
  const { store } = setup()
  store.replaceUnresolved(P, 'src/a.ts', [
    { kind: 'import', key: 'missing', ref: './missing', line: 1 },
    { kind: 'call', key: 'parseconfig', ref: 'parseConfig', line: 5 },
  ])
  store.replaceUnresolved(P, 'src/b.ts', [
    { kind: 'import', key: 'missing', ref: '../missing', line: 3 },
  ])

  assert.deepEqual(
    store.findUnresolvedByKeys(P, 'import', ['missing']).map(r => r.filePath).sort(),
    ['src/a.ts', 'src/b.ts'],
  )
  assert.deepEqual(
    store.findUnresolvedByKeys(P, 'call', ['parseconfig']).map(r => r.ref),
    ['parseConfig'],
    'kind разделяет каналы: вызов не находится по импортному запросу',
  )
  assert.deepEqual(store.findUnresolvedByKeys(P, 'import', ['other']), [])
  assert.deepEqual(store.findUnresolvedByKeys('other-project', 'import', ['missing']), [])
  assert.equal(store.countUnresolved(P), 3)

  // Замена следа файла не трогает чужие строки.
  store.replaceUnresolved(P, 'src/a.ts', [])
  assert.equal(store.countUnresolved(P), 1)
  assert.deepEqual(store.findUnresolvedByKeys(P, 'import', ['missing']).map(r => r.filePath), ['src/b.ts'])
})

test('removeFile/pruneDanglingEdges: след неразрешённых ссылок удалённого файла снимается', () => {
  const { store } = setup()
  store.replaceFile(P, {
    projectId: P, path: 'src/a.ts', language: 'typescript', hash: 'h1',
    mtime: 1, size: 1, parser: 'ts', truncated: false, indexedAt: 1,
  }, [], [])
  store.replaceUnresolved(P, 'src/a.ts', [{ kind: 'import', key: 'x', ref: './x', line: 1 }])
  store.replaceUnresolved(P, 'src/ghost.ts', [{ kind: 'import', key: 'y', ref: './y', line: 1 }])

  // Файла нет в code_map_files (удалён мимо removeFile) — чистит prune.
  store.pruneDanglingEdges(P)
  assert.deepEqual(store.findUnresolvedByKeys(P, 'import', ['y']), [], 'след удалённого файла не должен воскрешать его')

  store.removeFile(P, 'src/a.ts')
  assert.equal(store.countUnresolved(P), 0, 'removeFile снимает и след неразрешённых ссылок')
})

test('clearProject: стирает и неразрешённые ссылки', () => {
  const { store } = setup()
  store.replaceUnresolved(P, 'src/a.ts', [{ kind: 'import', key: 'x', ref: './x', line: 1 }])
  store.clearProject(P)
  assert.equal(store.countUnresolved(P), 0)
})

// ─── Планы запросов (никаких full scan на горячем пути) ─────────────────────
test('query plans: findUnresolvedByKeys идёт по индексу (project_id, kind, key)', () => {
  const { db } = setup()
  const plan = db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT file_path, ref, line FROM code_map_unresolved
     WHERE project_id = ? AND kind = ? AND key IN (?, ?) LIMIT ?`
  ).all(P, 'import', 'a', 'b', 200).map(r => r.detail).join(' | ')
  assert.match(plan, /idx_cmu_project_key/)
  assert.doesNotMatch(plan, /SCAN code_map_unresolved/)
})

test('query plans: getDependentFilePaths и getFile используют индексы', () => {
  const { db } = setup()
  const depPlan = db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT DISTINCT e.file_path AS path
     FROM code_map_edges e
     WHERE e.project_id = ?
       AND e.type IN ('imports','calls','references')
       AND e.file_path != ?
       AND e.file_path != ''
       AND (e.to_node = ? OR e.to_node IN (
         SELECT n.id FROM code_map_nodes n WHERE n.project_id = ? AND n.file_path = ?
       ))`
  ).all(P, 'b.ts', 'b.ts', P, 'b.ts').map(r => r.detail).join(' | ')
  assert.match(depPlan, /USING (COVERING )?INDEX idx_cme_project_(to|from|type|file)/)
  assert.doesNotMatch(depPlan, /SCAN code_map_edges/)
  assert.doesNotMatch(depPlan, /SCAN code_map_nodes/)

  const filePlan = db.prepare(
    `EXPLAIN QUERY PLAN SELECT * FROM code_map_files WHERE project_id = ? AND path = ?`
  ).all(P, 'src/a.ts').map(r => r.detail).join(' | ')
  assert.match(filePlan, /USING (COVERING )?INDEX/)
  assert.doesNotMatch(filePlan, /SCAN code_map_files/)
})
