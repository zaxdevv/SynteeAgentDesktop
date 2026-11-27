/**
 * mapBuilder — оркестрация карты проекта: частичные проходы, сверка после
 * досканирования инвентаря, двухфазный резолвинг, кэш символов и приоритет
 * живых правок над фоновой сборкой.
 *
 * Покрывается:
 *  - неполный (не authoritative) инвентарь НЕ удаляет файлы из графа, ставит
 *    состояние `partial` и планирует сверку через onInventoryComplete;
 *  - replay: завершение скана запускает финальный проход, и только там
 *    исчезнувшие файлы реально удаляются, а состояние становится `ready`;
 *  - force-пересборка не чистит документы/векторы (clearProjectDocs не зовётся),
 *    не пишет schemaVersion при частичном проходе и пишет — при авторитетном;
 *  - same-batch linkage: импорт на файл, разобранный позже в той же пачке,
 *    разрешается (узлы всех файлов попадают в индекс до резолвинга);
 *  - инкрементал: hash-совпадение = no-op (файл не переписывается), временный
 *    сбой парсера не удаляет узлы файла;
 *  - импортёр перерезолвивается из кэша importDetails/callSites: файл не
 *    перечитывается и не переразбирается;
 *  - foreground: живые правки активного проекта дренируются раньше фоновой
 *    сборки другого проекта.
 *
 * mapBuilder транспилируется на лету (паттерн map-semantic.test.mjs), все
 * зависимости подменяются in-memory шимами.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)

function transpile(relPath, requireShim) {
  const source = fs.readFileSync(path.join(root, relPath), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  const requireShimFn = (spec) => {
    if (requireShim[spec]) return requireShim[spec]
    return nodeRequire(spec)
  }
  new Function('exports', 'require', 'module', js)(module.exports, requireShimFn, module)
  return module.exports
}

const sleep = (ms) => new Promise(r => globalThis.setTimeout(r, ms))

async function waitFor(fn, timeoutMs = 4000, stepMs = 10) {
  const started = Date.now()
  for (;;) {
    if (fn()) return true
    if (Date.now() - started > timeoutMs) return false
    await sleep(stepMs)
  }
}

// ─── Шимы зависимостей ───────────────────────────────────────────────────────

/** In-memory store: ровно те функции, что использует mapBuilder. */
function createStore() {
  const files = new Map() // path -> CodeMapFile
  const nodes = new Map() // id -> node
  const edges = new Map() // id -> edge
  const unresolved = new Map() // `${filePath}|${kind}|${key}|${line}` -> ref
  const meta = new Map()
  const status = new Map()
  /** filePath -> Map(nodeId -> {textHash, tier}) — эмуляция code_map_docs. */
  const docsByFile = new Map()
  const calls = {
    replaceFile: [], replaceFileEdges: [], removeFile: [], clearProject: 0,
    setMeta: [], setStatus: [], pruneDanglingEdges: 0, updateFileStat: [],
    replaceUnresolved: [],
  }
  const edgeId = (e) => `${e.fromNode}->${e.toNode}:${e.type}:${e.id ?? ''}`
  const putEdges = (list) => { for (const e of list) edges.set(edgeId(e), e) }

  return {
    calls, files, nodes, edges, unresolved, docsByFile,
    fileNodeId: (p) => p,
    replaceFile(projectId, file, fileNodes, fileEdges) {
      calls.replaceFile.push(file.path)
      for (const [id, n] of nodes) if (n.filePath === file.path) nodes.delete(id)
      for (const [id, e] of edges) if (e.filePath === file.path) edges.delete(id)
      files.set(file.path, file)
      for (const n of fileNodes) nodes.set(n.id, n)
      putEdges(fileEdges)
    },
    replaceFileEdges(projectId, filePath, newEdges) {
      calls.replaceFileEdges.push(filePath)
      for (const [id, e] of edges) if (e.filePath === filePath) edges.delete(id)
      putEdges(newEdges)
    },
    removeFile(projectId, p) {
      calls.removeFile.push(p)
      files.delete(p)
      docsByFile.delete(p)
      for (const k of [...unresolved.keys()]) if (k.startsWith(p + '|')) unresolved.delete(k)
      for (const [id, n] of nodes) if (n.filePath === p) nodes.delete(id)
      for (const [id, e] of edges) if (e.filePath === p) edges.delete(id)
    },
    clearProject() { calls.clearProject++ ; files.clear(); nodes.clear(); edges.clear(); docsByFile.clear(); unresolved.clear() },
    listFiles() { return [...files.values()] },
    getFile(projectId, p) { return files.get(p) ?? null },
    listNodes(projectId, limit, offset) {
      const all = [...nodes.values()].filter(n => n.kind !== 'package')
      return all.slice(offset, offset + limit)
    },
    getNode(projectId, id) { return nodes.get(id) ?? null },
    getFileEdges(projectId, p, direction) {
      return [...edges.values()].filter(e => (direction === 'in' ? e.toNode === p : e.fromNode === p))
    },
    getDependentFilePaths(projectId, p) {
      const out = new Set()
      for (const e of edges.values()) {
        const targetFile = nodes.get(e.toNode)?.filePath ?? e.toNode
        if (targetFile !== p) continue
        const fromFile = nodes.get(e.fromNode)?.filePath ?? e.fromNode
        if (fromFile && fromFile !== p) out.add(fromFile)
      }
      return [...out]
    },
    updateFileStat(projectId, p, mtime, size) {
      calls.updateFileStat.push(p)
      const f = files.get(p)
      if (f) files.set(p, { ...f, mtime, size })
    },
    getMeta(projectId, key) { return meta.get(`${projectId}:${key}`) ?? null },
    setMeta(projectId, key, value) {
      calls.setMeta.push(`${key}=${value}`)
      meta.set(`${projectId}:${key}`, value)
    },
    setStatus(projectId, patch) {
      calls.setStatus.push({ ...patch })
      status.set(projectId, { ...(status.get(projectId) ?? defaultStatus(projectId)), ...patch })
    },
    getStatus(projectId) { return status.get(projectId) ?? defaultStatus(projectId) },
    refreshCounts(projectId) {
      const s = status.get(projectId) ?? defaultStatus(projectId)
      s.totalFiles = files.size
      s.totalNodes = nodes.size
      s.totalEdges = edges.size
      s.indexedFiles = files.size
      status.set(projectId, s)
    },
    pruneDanglingEdges() {
      calls.pruneDanglingEdges++
      for (const k of [...unresolved.keys()]) {
        const filePath = k.slice(0, k.indexOf('|'))
        if (!files.has(filePath)) unresolved.delete(k)
      }
      return 0
    },
    /** Durable-след неразрешённых ссылок (эмуляция code_map_unresolved). */
    replaceUnresolved(projectId, filePath, refs) {
      calls.replaceUnresolved.push(filePath)
      for (const k of [...unresolved.keys()]) if (k.startsWith(filePath + '|')) unresolved.delete(k)
      for (const r of refs) unresolved.set(`${filePath}|${r.kind}|${r.key}|${r.line}`, r)
    },
    findUnresolvedByKeys(projectId, kind, keys, limit = 200) {
      const wanted = new Set(keys)
      const out = []
      for (const [k, r] of unresolved) {
        const [filePath, refKind] = k.split('|')
        if (refKind !== kind || !wanted.has(r.key)) continue
        out.push({ filePath, ref: r.ref, line: r.line })
      }
      return out.slice(0, limit)
    },
    // ── Документы семантики (эмуляция code_map_docs) ──
    markDocs(projectId, filePath) {
      docsByFile.set(filePath, new Map([[`${filePath}#doc`, { textHash: 'h', tier: 0 }]]))
    },
    removeDocsFor(filePath) { docsByFile.delete(filePath) },
    listDocMetaByFile(projectId, filePath) { return docsByFile.get(filePath) ?? new Map() },
    countDocs() {
      let total = 0
      let lexicalOnly = 0
      for (const m of docsByFile.values()) {
        for (const d of m.values()) {
          if (d.tier > 0) total++
          else lexicalOnly++
        }
      }
      return { total, indexed: 0, lexicalOnly }
    },
  }
}

function defaultStatus(projectId) {
  return {
    projectId, state: 'idle', totalFiles: 0, indexedFiles: 0, totalNodes: 0,
    totalEdges: 0, startedAt: null, updatedAt: 0, error: null,
  }
}

/** Инвентарь файлов: управляемый статус + ожидающие/колбэки. */
function createIndexer(workdir, initial) {
  const state = {
    files: initial.files ?? [],
    status: initial.status ?? null,
    waiters: [],
    completions: [],
  }
  const fileEntry = (relPath) => {
    const abs = path.join(workdir, relPath)
    const st = fs.statSync(abs)
    return {
      path: abs, relPath, name: path.basename(relPath), mime: 'text/plain',
      size: st.size, mtime: st.mtimeMs, type: 'file',
    }
  }
  const mod = {
    state,
    startIndexing: async () => {},
    getAllFiles: () => state.files.map(fileEntry),
    subscribeFileChanges: () => () => {},
    isPathIgnored: () => false,
    getInventoryStatus: () => state.status,
    whenInventoryReady: (wd, timeoutMs) => {
      if (state.status?.ready) return Promise.resolve(state.status)
      return new Promise(resolve => {
        // Таймаут обязателен: иначе частичный проход ждал бы скан вечно.
        const timer = globalThis.setTimeout(() => resolve(null), Math.max(1, timeoutMs ?? 30_000))
        state.waiters.push((status) => { globalThis.clearTimeout(timer); resolve(status) })
      })
    },
    onInventoryComplete: (wd, cb) => {
      const entry = { cb, cancelled: false }
      state.completions.push(entry)
      return () => { entry.cancelled = true }
    },
    /** Скан дошёл до конца: будим ждущих и колбэки сверки. */
    complete(next) {
      state.status = next
      for (const resolve of state.waiters.splice(0)) resolve(next)
      for (const entry of state.completions.splice(0)) if (!entry.cancelled) entry.cb(next)
    },
  }
  return mod
}

function createSidecar() {
  const calls = []
  const failFor = new Set()
  return {
    calls, failFor,
    async sidecarSymbols(absPath, content) {
      const rel = absPath.replace(/\\/g, '/')
      calls.push(rel)
      if (failFor.has(path.basename(absPath))) throw new Error('sidecar timeout')
      const definitions = []
      const importDetails = []
      for (const line of content.split('\n')) {
        const imp = line.match(/^\s*import\s+.*from\s+'([^']+)'/)
        if (imp) importDetails.push({ source: imp[1], names: [] })
        const def = line.match(/^\s*(?:export\s+)?function\s+([A-Za-z0-9_$]+)/)
        if (def) definitions.push({ name: def[1], line: 1 })
      }
      return {
        definitions, imports: importDetails.map(d => d.source), references: [],
        importDetails, callSites: [], language: 'typescript', parser: 'ts',
        supported: true, truncated: false,
      }
    },
  }
}

/** Резолвер-шим: минимум, нужный mapBuilder (реальные правила не проверяем). */
/** Lookup-ключ импорта (зеркало mapResolver.importLookupKey для шима). */
function fileLookupKey(source) {
  const clean = source.trim().replace(/[\\/]+$/, '')
  const parts = clean.split('/').filter(Boolean)
  let last = parts[parts.length - 1] ?? ''
  last = last.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py)$/, '')
  return last ? last.toLowerCase() : null
}

const resolverShim = {
  ProjectIndex: class ProjectIndex {
    constructor(projectId, workdir) {
      this.projectId = projectId
      this.workdir = workdir
      this.files = new Set()
      this.defsByName = new Map()
      this.defsByFile = new Map()
      this.aliases = new Map()
    }
    addFileNodes(filePath, nodes) {
      this.files.add(filePath)
      this.defsByFile.set(filePath, nodes)
      for (const n of nodes) {
        if (n.kind === 'file' || n.kind === 'package') continue
        const list = this.defsByName.get(n.name) ?? []
        list.push(n)
        this.defsByName.set(n.name, list)
      }
    }
    removeFile(filePath) {
      this.files.delete(filePath)
      this.defsByFile.delete(filePath)
    }
  },
  definitionsToNodes(projectId, filePath, defs) {
    return defs.map((d, i) => ({
      id: `${filePath}#${d.name}#${i}`, projectId, filePath, name: d.name, kind: 'function',
      parentName: null, lineStart: d.line ?? 1, lineEnd: d.line ?? 1, signature: '', exported: false,
    }))
  },
  markExported() {},
  containsEdges(projectId, filePath, nodes) {
    return nodes.filter(n => n.kind !== 'file').map(n => ({
      id: `${filePath}=>${n.id}`, projectId, fromNode: filePath, toNode: n.id,
      type: 'contains', precision: 'resolved', filePath, line: 0,
    }))
  },
  resolveFileImports(index, fromFile, importDetails, _language) {
    const edges = []
    const packages = []
    const unresolved = []
    const posix = path.posix
    for (const imp of importDetails) {
      if (!imp.source.startsWith('.')) { packages.push(imp.source); continue }
      const base = posix.join(posix.dirname(fromFile), imp.source)
      const candidates = [base, base + '.ts', base + '.tsx', base + '/index.ts']
      const found = candidates.find(c => index.files.has(posix.normalize(c)))
      if (!found) {
        // Как и настоящий резолвер: цель не найдена → durable-след для восстановления.
        const key = fileLookupKey(imp.source)
        if (key) unresolved.push({ kind: 'import', key, ref: imp.source, line: imp.line })
        continue
      }
      const to = posix.normalize(found)
      edges.push({
        id: `${fromFile}=>${to}`, projectId: index.projectId, fromNode: fromFile, toNode: to,
        type: 'imports', precision: 'resolved', filePath: fromFile, line: 1,
      })
    }
    return { edges, packages, unresolved }
  },
  resolveFileCalls() { return { edges: [], unresolved: [] } },
  /** Ключи файла-цели (зеркало настоящего резолвера). */
  fileLookupKeys(filePath) {
    const parts = String(filePath).split(/[\\/]/).filter(Boolean)
    const last = parts[parts.length - 1] ?? ''
    const stem = last.replace(/\.[^.]+$/, '')
    return stem ? [stem.toLowerCase()] : []
  },
  ensurePackages() {},
  loadTsconfigAliases() { return new Map() },
  markdownNodes(projectId, relPath) {
    return [{
      id: relPath, projectId, filePath: relPath, name: path.basename(relPath), kind: 'file',
      parentName: null, lineStart: 0, lineEnd: 0, signature: '', exported: false,
    }]
  },
  docReferenceEdges() { return [] },
}

function createSemantic() {
  const calls = { clearProjectDocs: 0, pruneProjectDocs: 0, syncFileDocs: 0, removeFileDocs: [] }
  const self = {
    calls,
    /** Ставится из loadMapBuilder: нужен, чтобы эмулировать code_map_docs. */
    __store: null,
    syncFileDocs(projectId, filePath) {
      calls.syncFileDocs++
      self.__store?.markDocs?.(projectId, filePath)
    },
    removeFileDocs(projectId, filePath) {
      calls.removeFileDocs.push(filePath)
      self.__store?.removeDocsFor?.(filePath)
    },
    clearProjectDocs() { calls.clearProjectDocs++ },
    pruneProjectDocs() { calls.pruneProjectDocs++; return 0 },
    semanticWorker: { nudge() {}, start() {}, stop() {}, setForegroundPredicate() {}, setActiveProject() {}, setMapBuildingPredicate() {} },
  }
  return self
}

const DEFAULT_SPEED = { mode: 'auto', level: 50 }

function loadMapBuilder({ store, indexer, sidecar, semantic, projects }) {
  const db = {
    getAllProjects: () => Object.values(projects),
    getProjectById: (id) => projects[id] ?? null,
    getProjectByWorkdir: (wd) => Object.values(projects).find(p => p.workdir === wd) ?? null,
  }
  // Семантика эмулирует code_map_docs через store.
  if (semantic) semantic.__store = store
  const shim = {
    '../logger': { log: () => {} },
    '../db': db,
    '../sidecar/sidecarClient': sidecar,
    '../mentions/fileIndexer': indexer,
    '../../shared/projectMap': { DEFAULT_PROJECT_MAP_SPEED: DEFAULT_SPEED },
    './mapStore': store,
    './mapResolver': resolverShim,
    './mapSemantic': semantic,
    './mapAnalytics': { invalidateAnalytics: () => {} },
  }
  return transpile('src/core/projectMap/mapBuilder.ts', shim)
}

function makeWorkdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapbuilder-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
  return dir
}

function inventoryStatus(overrides = {}) {
  return {
    workdir: '', ready: true, complete: true, authoritative: true, truncated: false,
    scanErrors: 0, files: 0, watcherActive: true, startedAt: 0, updatedAt: 0, durationMs: 0,
    ...overrides,
  }
}

/** Менеджер в «запущенном» состоянии, без 3-секундного автостарта. */
function bootManager(mod) {
  const manager = mod.projectMapManager
  manager.running = true
  manager.enabled = true
  manager.speed = DEFAULT_SPEED
  return manager
}

// ─── Тесты ───────────────────────────────────────────────────────────────────

test('partial: неполный инвентарь не удаляет файлы и планирует сверку', async () => {
  const workdir = makeWorkdir({ 'a.ts': 'export function a() {}\n', 'b.ts': 'export function b() {}\n' })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  // Граф уже содержит gone.ts (файла на диске нет) и a.ts.
  store.files.set('gone.ts', { projectId, path: 'gone.ts', language: 'typescript', hash: 'x', mtime: 1, size: 1, parser: 'ts', truncated: false, indexedAt: 1 })
  const indexer = createIndexer(workdir, {
    files: ['a.ts'],
    // Скан ещё идёт: список частичный.
    status: inventoryStatus({ ready: false, complete: false, authoritative: false, files: 1 }),
  })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  await manager.buildProject(projectId, false)

  assert.equal(store.getStatus(projectId).state, 'partial', 'частичная карта помечена partial')
  assert.ok(store.files.has('gone.ts'), 'файл, отсутствующий в неполном списке, НЕ удалён')
  assert.ok(store.files.has('a.ts'), 'просканированный файл попал в граф')
  assert.ok(!store.files.has('b.ts'), 'ещё не просканированный файл не появился (ожидаемо)')
  assert.equal(store.calls.removeFile.length, 0, 'никаких удалений на частичном инвентаре')
  assert.equal(semantic.calls.pruneProjectDocs, 0, 'prune документов не запускается на частичной карте')
  assert.equal(store.getMeta(projectId, 'schemaVersion'), null, 'schemaVersion не «застолблена» частичным проходом')
  assert.equal(indexer.state.completions.length, 1, 'запланирована сверка после завершения скана')
})

test('replay: завершение скана запускает финальный проход и только там удаляет', async () => {
  const workdir = makeWorkdir({ 'a.ts': 'export function a() {}\n', 'b.ts': 'export function b() {}\n' })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  store.files.set('gone.ts', { projectId, path: 'gone.ts', language: 'typescript', hash: 'x', mtime: 1, size: 1, parser: 'ts', truncated: false, indexedAt: 1 })
  const indexer = createIndexer(workdir, {
    files: ['a.ts'],
    status: inventoryStatus({ ready: false, complete: false, authoritative: false, files: 1 }),
  })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  await manager.buildProject(projectId, false)
  assert.equal(store.getStatus(projectId).state, 'partial')

  // Скан завершился: инвентарь полон и актуален.
  indexer.state.files = ['a.ts', 'b.ts']
  indexer.complete(inventoryStatus({ files: 2, workdir }))

  const ok = await waitFor(() => store.getStatus(projectId).state === 'ready')
  assert.ok(ok, 'сверка довела карту до ready')
  assert.ok(!store.files.has('gone.ts'), 'исчезнувший файл удалён только после авторитетного прохода')
  assert.ok(store.files.has('b.ts'), 'досканированный файл добавлен')
  assert.equal(store.getMeta(projectId, 'schemaVersion'), '5', 'schemaVersion фиксируется успешным авторитетным проходом')
  assert.equal(semantic.calls.pruneProjectDocs, 1, 'документы чистит prune (не clear) после успеха')
})

test('force: старый граф и векторы сохраняются, schemaVersion только после успеха', async () => {
  const workdir = makeWorkdir({ 'a.ts': 'export function a() {}\n' })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  store.files.set('a.ts', { projectId, path: 'a.ts', language: 'typescript', hash: 'old', mtime: 1, size: 1, parser: 'ts', truncated: false, indexedAt: 1 })
  const indexer = createIndexer(workdir, { files: ['a.ts'], status: inventoryStatus({ files: 1, workdir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  manager.rebuildProject(projectId)
  assert.equal(semantic.calls.clearProjectDocs, 0, 'rebuild не стирает документы (векторы переживают пересборку)')
  assert.equal(store.calls.clearProject, 0, 'rebuild не стирает граф')

  const ok = await waitFor(() => store.getStatus(projectId).state === 'ready')
  assert.ok(ok, 'force-сборка завершилась')
  assert.equal(store.calls.clearProject, 0, 'старый граф не очищался и во время сборки')
  assert.equal(semantic.calls.clearProjectDocs, 0, 'документы не чистились')
  assert.equal(store.getMeta(projectId, 'schemaVersion'), '5', 'schemaVersion записан успешным проходом')
})

test('same-batch linkage: импорт на файл, разобранный позже, разрешается', async () => {
  const workdir = makeWorkdir({
    'a.ts': "import { b } from './b'\nexport function a() {}\n",
    'b.ts': 'export function b() {}\n',
  })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  const indexer = createIndexer(workdir, { files: ['a.ts', 'b.ts'], status: inventoryStatus({ files: 2, workdir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  await manager.buildProject(projectId, true)

  const edges = [...store.edges.values()]
  const linkage = edges.find(e => e.fromNode === 'a.ts' && e.toNode === 'b.ts' && e.type === 'imports')
  assert.ok(linkage, 'импорт a → b разрешён, хотя b разобран после a')
})

test('incremental: hash-совпадение — no-op, временный сбой парсера не удаляет узлы', async () => {
  const workdir = makeWorkdir({
    'a.ts': 'export function a() {}\n',
    'b.ts': 'export function b() {}\n',
  })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  const indexer = createIndexer(workdir, { files: ['a.ts', 'b.ts'], status: inventoryStatus({ files: 2, workdir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  await manager.buildProject(projectId, true)
  const rewritesBefore = store.calls.replaceFile.length

  // touch без изменения содержимого → hash тот же, файл не переписывается.
  manager.pendingChanges.set(workdir, new Set(['a.ts']))
  await manager.flushChanges(workdir)
  assert.equal(store.calls.replaceFile.length, rewritesBefore, 'неизменённый файл не переписан')

  // Правка b.ts, но парсер падает → узлы b.ts остаются в графе.
  fs.writeFileSync(path.join(workdir, 'b.ts'), 'export function b() {}\nexport function b2() {}\n', 'utf8')
  sidecar.failFor.add('b.ts')
  manager.pendingChanges.set(workdir, new Set(['b.ts']))
  await manager.flushChanges(workdir)

  assert.ok(store.files.has('b.ts'), 'временный сбой парсера не удалил файл из графа')
  assert.ok([...store.nodes.values()].some(n => n.filePath === 'b.ts'), 'узлы файла сохранены')
  assert.ok(!store.calls.removeFile.includes('b.ts'), 'removeFile не вызывался')
})

test('incremental: импортёр перерезолвивается из кэша без повторного чтения', async () => {
  const workdir = makeWorkdir({
    'a.ts': "import { b } from './b'\nexport function a() {}\n",
    'b.ts': 'export function b() {}\n',
  })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  const indexer = createIndexer(workdir, { files: ['a.ts', 'b.ts'], status: inventoryStatus({ files: 2, workdir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  await manager.buildProject(projectId, true)
  const sidecarCallsBefore = sidecar.calls.filter(c => c.endsWith('/a.ts') || c.endsWith('\\a.ts')).length
  const edgeRewritesBefore = store.calls.replaceFileEdges.length

  fs.writeFileSync(path.join(workdir, 'b.ts'), 'export function b() {}\nexport function b2() {}\n', 'utf8')
  manager.pendingChanges.set(workdir, new Set(['b.ts']))
  await manager.flushChanges(workdir)

  const sidecarCallsAfter = sidecar.calls.filter(c => c.endsWith('/a.ts') || c.endsWith('\\a.ts')).length
  assert.equal(sidecarCallsAfter, sidecarCallsBefore, 'импортёр не перечитывался и не переразбирался')
  assert.ok(store.calls.replaceFileEdges.length > edgeRewritesBefore, 'рёбра импортёра пересчитаны через replaceFileEdges')
  assert.ok([...store.edges.values()].some(e => e.fromNode === 'a.ts' && e.toNode === 'b.ts'))
})

test('foreground: живые правки активного проекта дренируются раньше фоновой сборки', async () => {
  const activeDir = makeWorkdir({ 'a.ts': 'export function a() {}\n' })
  const backgroundDir = makeWorkdir({ 'z.ts': 'export function z() {}\n' })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projects = {
    p1: { id: 'p1', name: 'Active', workdir: activeDir },
    p2: { id: 'p2', name: 'Background', workdir: backgroundDir },
  }
  const indexer = createIndexer(activeDir, { files: ['a.ts'], status: inventoryStatus({ files: 1, workdir: activeDir }) })
  indexer.state.statusByWorkdir = { [activeDir]: inventoryStatus({ files: 1, workdir: activeDir }) }
  indexer.getInventoryStatus = (wd) => (wd === activeDir ? indexer.state.statusByWorkdir[activeDir] : inventoryStatus({ files: 1, workdir: wd }))
  indexer.getAllFiles = (wd) => {
    const list = wd === activeDir ? ['a.ts'] : ['z.ts']
    return list.map(relPath => {
      const abs = path.join(wd, relPath)
      const st = fs.statSync(abs)
      return { path: abs, relPath, name: relPath, mime: 'text/plain', size: st.size, mtime: st.mtimeMs, type: 'file' }
    })
  }
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects })
  const manager = bootManager(mod)

  const order = []
  manager.setProgressCallback((p) => order.push({ projectId: p.projectId, phase: p.phase, incremental: !!p.incremental }))

  // Активный проект тёплый, но у него есть неслитые правки; в очереди — чужой проект.
  await manager.buildProject('p1', true)
  order.length = 0
  manager.activeProjectId = 'p1'
  manager.pendingChanges.set(activeDir, new Set(['a.ts']))
  manager.queue = ['p2']
  manager.kick()

  const ok = await waitFor(() => order.some(e => e.projectId === 'p2' && e.phase === 'ready'))
  assert.ok(ok, 'фоновая сборка доехала до конца')

  const firstIncremental = order.findIndex(e => e.projectId === 'p1' && e.incremental)
  const firstBackground = order.findIndex(e => e.projectId === 'p2')
  assert.ok(firstIncremental >= 0, 'правки активного проекта обработаны')
  assert.ok(firstBackground > firstIncremental, 'сначала живые правки активного проекта, потом фоновая сборка')
})

test('backfill: документы не пересинхронизируются на каждом проходе', async () => {
  const workdir = makeWorkdir({ 'a.ts': 'export function a() {}\n', 'b.ts': 'export function b() {}\n' })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  const indexer = createIndexer(workdir, { files: ['a.ts', 'b.ts'], status: inventoryStatus({ files: 2, workdir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  await manager.buildProject(projectId, true)
  const afterFirst = semantic.calls.syncFileDocs
  assert.ok(afterFirst >= 2, 'первый проход синхронизировал документы файлов')

  // Второй проход: файлы не менялись, документы уже есть (tier-0 тоже считается).
  await manager.buildProject(projectId, false)
  assert.equal(semantic.calls.syncFileDocs, afterFirst, 'повторный проход не бэкфиллит документы заново')
})

test('incremental: промах кэша символов всё равно пересчитывает рёбра зависимого', async () => {
  const workdir = makeWorkdir({
    'a.ts': "import { b } from './b'\nexport function a() {}\n",
    'b.ts': 'export function b() {}\n',
  })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  const indexer = createIndexer(workdir, { files: ['a.ts', 'b.ts'], status: inventoryStatus({ files: 2, workdir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  await manager.buildProject(projectId, true)
  // Рестарт/вытеснение: кэш importDetails пуст, сам граф — на месте.
  manager.symbolCache.clear()
  const aParsesBefore = sidecar.calls.filter(c => c.endsWith('/a.ts') || c.endsWith('\\a.ts')).length
  const edgeRewritesBefore = store.calls.replaceFileEdges.length

  fs.writeFileSync(path.join(workdir, 'b.ts'), 'export function b() {}\nexport function b2() {}\n', 'utf8')
  manager.pendingChanges.set(workdir, new Set(['b.ts']))
  await manager.flushChanges(workdir)

  const aParsesAfter = sidecar.calls.filter(c => c.endsWith('/a.ts') || c.endsWith('\\a.ts')).length
  assert.equal(aParsesAfter, aParsesBefore + 1, 'импортёр разобран ровно один раз (кэш промахнулся)')
  assert.ok(store.calls.replaceFileEdges.length > edgeRewritesBefore, 'рёбра импортёра пересчитаны, а не потеряны как «unchanged»')
  assert.ok([...store.edges.values()].some(e => e.fromNode === 'a.ts' && e.toNode === 'b.ts'), 'связь a → b на месте')
})

test('incremental: watcher-путь с тем же mtime сравнивается по hash', async () => {
  const workdir = makeWorkdir({ 'a.ts': 'export function a() {}\n' })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  const indexer = createIndexer(workdir, { files: ['a.ts'], status: inventoryStatus({ files: 1, workdir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  await manager.buildProject(projectId, true)
  const abs = path.join(workdir, 'a.ts')
  const before = fs.statSync(abs)

  // Известный целый mtime: utimesSync не умеет доли миллисекунды.
  const stamp = 1_600_000_000_000
  store.files.set('a.ts', { ...store.files.get('a.ts'), mtime: stamp, size: before.size })

  // Та же длина, тот же mtime — «атомарное сохранение»/git checkout.
  fs.writeFileSync(abs, 'export function z() {}\n', 'utf8')
  fs.utimesSync(abs, new Date(stamp), new Date(stamp))
  const after = fs.statSync(abs)
  assert.equal(after.mtimeMs, stamp, 'mtime не изменился — stat-гейт пропустил бы правку')
  assert.equal(after.size, before.size, 'размер тот же')

  manager.pendingChanges.set(workdir, new Set(['a.ts']))
  await manager.flushChanges(workdir)

  const names = [...store.nodes.values()].filter(n => n.filePath === 'a.ts').map(n => n.name)
  assert.ok(names.includes('z'), 'правка подхвачена по hash, несмотря на тот же mtime')
  assert.ok(!names.includes('a'), 'старый узел заменён')
})

test('full: каталог и гигантский файл отбрасываются до чтения и парсинга', async () => {
  const workdir = makeWorkdir({ 'a.ts': 'export function a() {}\n' })
  // Каталог с «код-расширением» и файл больше лимита.
  fs.mkdirSync(path.join(workdir, 'lib.ts'))
  fs.writeFileSync(path.join(workdir, 'big.ts'), 'x'.repeat(1_100_000), 'utf8')
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  const indexer = createIndexer(workdir, { files: ['a.ts', 'lib.ts', 'big.ts'], status: inventoryStatus({ files: 3, workdir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  await manager.buildProject(projectId, true)

  assert.ok(store.files.has('a.ts'), 'обычный файл проиндексирован')
  assert.ok(!store.files.has('lib.ts'), 'каталог не попал в граф')
  assert.ok(!store.files.has('big.ts'), 'гигантский файл не попал в граф')
  const parsed = sidecar.calls.map(c => path.basename(c))
  assert.ok(!parsed.includes('lib.ts'), 'каталог не отправлялся в парсер')
  assert.ok(!parsed.includes('big.ts'), 'гигантский файл не отправлялся в парсер')
})

test('full: markdown не отбрасывается эвристикой минификации', async () => {
  // Длинная однострочная таблица/абзац: >10k символов, почти без переносов.
  const longLine = '| col | value | '.repeat(1200)
  const workdir = makeWorkdir({ 'README.md': longLine + '\n' })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  const indexer = createIndexer(workdir, { files: ['README.md'], status: inventoryStatus({ files: 1, workdir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  await manager.buildProject(projectId, true)

  assert.ok(store.files.has('README.md'), 'markdown проиндексирован, хотя строк мало и они длинные')
  assert.equal(sidecar.calls.length, 0, 'markdown не отправляется в code-парсер')
})

test('queue: запрос на проект, который сейчас строится, не теряется', async () => {
  const workdir = makeWorkdir({ 'a.ts': 'export function a() {}\n' })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  const indexer = createIndexer(workdir, { files: ['a.ts'], status: inventoryStatus({ files: 1, workdir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  // Сборка идёт (как при сверке инвентаря посреди прохода) — enqueue обязан
  // поставить ещё один проход, а не молча отказать.
  manager.building = projectId
  manager.enqueue(projectId)
  manager.enqueue(projectId)
  assert.deepEqual(manager.queue, [projectId], 'проект в очереди ровно один раз')
  manager.building = null
})

test('opening a watched map reuses it while explicit rebuild and inventory replacement still work', async t => {
  const workdir = makeWorkdir({ 'a.ts': 'export function a() {}\n' })
  const projectId = 'p1'
  const store = createStore()
  const sidecar = createSidecar()
  const indexer = createIndexer(workdir, { files: ['a.ts'], status: inventoryStatus({ files: 1, workdir }) })
  const manager = bootManager(loadMapBuilder({
    store, indexer, sidecar, semantic: createSemantic(),
    projects: { [projectId]: { id: projectId, name: 'P1', workdir } },
  }))
  t.after(() => { manager.stop(); fs.rmSync(workdir, { recursive: true, force: true }) })
  const buildCount = () => store.calls.setStatus.filter(patch => patch.state === 'building').length
  const ready = count => waitFor(() => buildCount() === count && !manager.loopActive)

  manager.setActiveProject(projectId)
  manager.ensureProject(projectId)
  assert.ok(await ready(1), 'opening during startup only builds once')

  manager.setActiveProject(null)
  manager.setActiveProject(projectId)
  manager.ensureProject(projectId)
  assert.ok(await ready(1), 'switching back and reopening reuses the live map')

  fs.writeFileSync(path.join(workdir, 'a.ts'), 'export function changed() {}\n')
  manager.onFileChanges(workdir, ['a.ts'])
  manager.setActiveProject(projectId)
  assert.ok(await waitFor(() => [...store.nodes.values()].some(n => n.name === 'changed')), 'watcher changes are still applied')
  assert.equal(buildCount(), 1)

  manager.rebuildProject(projectId)
  assert.ok(await ready(2), 'rebuild remains available')

  indexer.state.status = inventoryStatus({ files: 1, workdir, startedAt: 1 })
  manager.ensureProject(projectId)
  assert.ok(await ready(3), 'replaced inventory needs reconciliation')
})

test('preempt: фоновая сборка уступает активному проекту и возвращается в очередь', async () => {
  const backgroundFiles = {}
  for (let i = 0; i < 60; i++) backgroundFiles[`f${i}.ts`] = `export function f${i}() {}\n`
  const activeDir = makeWorkdir({ 'a.ts': 'export function a() {}\n' })
  const backgroundDir = makeWorkdir(backgroundFiles)
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projects = {
    p1: { id: 'p1', name: 'Active', workdir: activeDir },
    p2: { id: 'p2', name: 'Background', workdir: backgroundDir },
  }
  const indexer = createIndexer(backgroundDir, { files: Object.keys(backgroundFiles), status: inventoryStatus({ files: 60, workdir: backgroundDir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects })
  const manager = bootManager(mod)

  // Активный проект — чужой для сборки, у него есть неслитые правки.
  manager.activeProjectId = 'p1'
  manager.pendingChanges.set(activeDir, new Set(['a.ts']))

  const build = manager.buildProject('p2', true)
  // Даём фоновой сборке начать паузы между файлами.
  await sleep(60)
  await build

  assert.ok(store.files.size < 60, 'фоновая сборка прервалась, не дойдя до конца')
  assert.notEqual(store.getStatus('p2').state, 'ready', 'статус не остался «building» и не соврал про ready')
  assert.ok(manager.queue.includes('p2'), 'прерванный проект вернулся в очередь')
})

test('loop: проект с идущим инкременталом не берётся в полную сборку', async () => {
  const workdir = makeWorkdir({ 'a.ts': 'export function a() {}\n' })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  const indexer = createIndexer(workdir, { files: ['a.ts'], status: inventoryStatus({ files: 1, workdir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  try {
    manager.incrementalBusy.add(projectId)
    manager.queue = [projectId]
    manager.kick()
    await sleep(150)
    assert.equal(store.files.size, 0, 'полная сборка не началась, пока идёт инкрементал')
    assert.deepEqual(manager.queue, [projectId], 'проект остался в очереди')

    manager.incrementalBusy.delete(projectId)
    const ok = await waitFor(() => store.files.has('a.ts'))
    assert.ok(ok, 'после освобождения проекта сборка продолжилась')
  } finally {
    manager.stop()
  }
})

// ─── Восстановление ранее неразрешённых ссылок ───────────────────────────────

test('recovery: цель, появившаяся после первичного индекса, восстанавливает импорт', async () => {
  const workdir = makeWorkdir({
    'a.ts': "import { m } from './missing'\nexport function a() {}\n",
    'unrelated.ts': "import { n } from './alsoMissing'\nexport function u() {}\n",
  })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  const indexer = createIndexer(workdir, { files: ['a.ts', 'unrelated.ts'], status: inventoryStatus({ files: 2, workdir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  await manager.buildProject(projectId, true)
  assert.ok(![...store.edges.values()].some(e => e.fromNode === 'a.ts' && e.type === 'imports'),
    'импорт на отсутствующий файл ребра не даёт')
  assert.ok([...store.unresolved.keys()].some(k => k.startsWith('a.ts|import|missing|')),
    'неразрешённый импорт оставил durable-след')

  const aSidecarCalls = sidecar.calls.filter(c => /[\\/]a\.ts$/.test(c)).length
  const rewritesBefore = store.calls.replaceFileEdges.length

  // Цель появляется позже: карта должна закрыть «висящий» импорт.
  fs.writeFileSync(path.join(workdir, 'missing.ts'), 'export function m() {}\n', 'utf8')
  manager.pendingChanges.set(workdir, new Set(['missing.ts']))
  await manager.flushChanges(workdir)

  const restored = [...store.edges.values()].find(e => e.fromNode === 'a.ts' && e.toNode === 'missing.ts' && e.type === 'imports')
  assert.ok(restored, 'ребро a.ts → missing.ts восстановлено без пересборки карты')
  assert.equal(restored.precision, 'resolved')
  assert.ok(![...store.unresolved.keys()].some(k => k.startsWith('a.ts|import|missing|')),
    'след снят: ссылка разрешилась')
  assert.equal(sidecar.calls.filter(c => /[\\/]a\.ts$/.test(c)).length, aSidecarCalls,
    'импортёр не перечитывался и не переразбирался (кэш importDetails)')
  assert.ok(store.calls.replaceFileEdges.length > rewritesBefore)

  // Несвязанный файл с другой неразрешённой ссылкой не тронут.
  assert.ok(!store.calls.replaceFileEdges.slice(rewritesBefore).includes('unrelated.ts'),
    'файл с другим неразрешённым импортом не перерезолвливался')
  assert.ok([...store.unresolved.keys()].some(k => k.startsWith('unrelated.ts|import|alsomissing|')),
    'его след сохранён — цель так и не появилась')
  assert.ok(![...store.edges.values()].some(e => e.fromNode === 'unrelated.ts' && e.type === 'imports'),
    'ложного ребра у несвязанного файла нет')
})

test('recovery: удаление цели пересоздаёт след, повторное появление — ребро', async () => {
  const workdir = makeWorkdir({
    'a.ts': "import { b } from './b'\nexport function a() {}\n",
    'b.ts': 'export function b() {}\n',
  })
  const store = createStore()
  const semantic = createSemantic()
  const sidecar = createSidecar()
  const projectId = 'p1'
  const indexer = createIndexer(workdir, { files: ['a.ts', 'b.ts'], status: inventoryStatus({ files: 2, workdir }) })
  const mod = loadMapBuilder({ store, indexer, sidecar, semantic, projects: { [projectId]: { id: projectId, name: 'P1', workdir } } })
  const manager = bootManager(mod)

  await manager.buildProject(projectId, true)
  assert.ok([...store.edges.values()].some(e => e.fromNode === 'a.ts' && e.toNode === 'b.ts'))

  // Удаление цели: импортёр перерезолвливается, ребро уходит, след появляется.
  fs.rmSync(path.join(workdir, 'b.ts'))
  manager.pendingChanges.set(workdir, new Set(['b.ts']))
  await manager.flushChanges(workdir)

  assert.ok(!store.files.has('b.ts'), 'удалённый файл убран из графа')
  assert.ok(![...store.edges.values()].some(e => e.fromNode === 'a.ts' && e.toNode === 'b.ts'),
    'ребро на удалённый файл снято')
  assert.ok([...store.unresolved.keys()].some(k => k.startsWith('a.ts|import|b|')),
    'след восстановлен: цель снова неразрешена')

  // Цель вернулась (git checkout) — ребро восстанавливается точечно.
  fs.writeFileSync(path.join(workdir, 'b.ts'), 'export function b() {}\n', 'utf8')
  manager.pendingChanges.set(workdir, new Set(['b.ts']))
  await manager.flushChanges(workdir)

  assert.ok([...store.edges.values()].some(e => e.fromNode === 'a.ts' && e.toNode === 'b.ts'),
    'ребро a.ts → b.ts вернулось после повторного появления файла')
  assert.ok(![...store.unresolved.keys()].some(k => k.startsWith('a.ts|import|b|')))
})
