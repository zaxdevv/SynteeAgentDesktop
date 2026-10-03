import { existsSync } from 'fs'
import { join, extname } from 'path'
import Database from 'better-sqlite3'
import type { Database as DBType } from 'better-sqlite3'

// ─── Worker-local SQLite connection ──────────────────────────────────────────
// Открывается lazy при первом обращении к индексу. WAL mode → безопасен
// concurrent доступ с main-процессом (который пишет через watcher).
// ВАЖНО: этот модуль исполняется в worker_threads (вызывается тулзой из Agent).
// Worker не имеет доступа к main-процессной БД (database.ts `getDB()` вернёт
// undefined) и к `electron` `app`. Поэтому здесь открывается собственное
// SQLite connection к тому же файлу.

let _db: DBType | null = null
let _dbPath: string | null = null

/** Инициализация пути к БД. Вызывается из ai-worker.ts при старте worker'а. */
export function initFastContextDb(dbPath: string): void {
  _dbPath = dbPath
}

export function getDb(): DBType {
  if (_db && _db.open) return _db
  if (!_dbPath) {
    throw new Error('fastContext: dbPath not initialized. Call initFastContextDb(dbPath) from worker startup.')
  }
  _db = new Database(_dbPath, { readonly: false, timeout: 10_000 })
  _db.pragma('journal_mode = WAL')
  _db.pragma('busy_timeout = 5000')
  // Memory-mapped I/O — ускоряет reads из fast_context_index на больших индексах.
  // 256MB mmap: OS кэширует страницы файла в RAM, reads не идут через read().
  _db.pragma('mmap_size = 268435456')
  // Page cache — 64MB (negative value = KB). Ускоряет repeated queries.
  _db.pragma('cache_size = -65536')
  // Synchronous=NORMAL — безопасно в WAL режиме (fsync только на checkpoint).
  // Снижает latency на writes без потери данных (WAL гарантирует durability).
  _db.pragma('synchronous = NORMAL')
  return _db
}

// ─── Локальные CRUD (не зависят от main-процессной database.ts) ──────────────

export interface LocalFastContextEntry {
  projectId: string
  filePath: string
  lang: string | null
  symbolsJson: string | null
  mtime: number
  size: number
  contentHash: number
  rankedScore: number
  relevanceBoost: number
  embedding: Buffer | null
  updatedAt: number
}

export function localGetEntries(projectId: string): LocalFastContextEntry[] {
  return getDb().prepare(`
    SELECT project_id as projectId, file_path as filePath, lang, symbols_json as symbolsJson,
           mtime, size, content_hash as contentHash, ranked_score as rankedScore,
           relevance_boost as relevanceBoost, embedding, updated_at as updatedAt
    FROM fast_context_index
    WHERE project_id = ?
    ORDER BY ranked_score DESC
  `).all(projectId) as LocalFastContextEntry[]
}

export function localGetEntry(projectId: string, filePath: string): LocalFastContextEntry | null {
  return getDb().prepare(`
    SELECT project_id as projectId, file_path as filePath, lang, symbols_json as symbolsJson,
           mtime, size, content_hash as contentHash, ranked_score as rankedScore,
           relevance_boost as relevanceBoost, embedding, updated_at as updatedAt
    FROM fast_context_index
    WHERE project_id = ? AND file_path = ?
  `).get(projectId, filePath) as LocalFastContextEntry | null
}

export function localUpsert(
  projectId: string, filePath: string, lang: string | null,
  symbolsJson: string | null, mtime: number, size: number, rankedScore = 0,
  embedding?: Buffer | null, contentHash?: number,
): void {
  getDb().prepare(`
    INSERT INTO fast_context_index (project_id, file_path, lang, symbols_json, mtime, size, content_hash, ranked_score, embedding, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, file_path) DO UPDATE SET
      lang = excluded.lang,
      symbols_json = excluded.symbols_json,
      mtime = excluded.mtime,
      size = excluded.size,
      content_hash = excluded.content_hash,
      ranked_score = excluded.ranked_score,
      embedding = CASE
        -- Контент изменился → старый embedding невалиден, сбрасываем
        -- (пересчитается лениво при следующем get_fast_context).
        -- Иначе поиск по «изменившемуся» файлу матчился по устаревшему вектору.
        WHEN excluded.content_hash != fast_context_index.content_hash THEN NULL
        ELSE COALESCE(excluded.embedding, fast_context_index.embedding)
      END,
      updated_at = excluded.updated_at
  `).run(projectId, filePath, lang, symbolsJson, mtime, size, contentHash ?? 0, rankedScore, embedding ?? null, Date.now())
}

export function localDelete(projectId: string, filePath: string): void {
  getDb().prepare(`DELETE FROM fast_context_index WHERE project_id = ? AND file_path = ?`).run(projectId, filePath)
}

/** Общее число файлов в индексе проекта — COUNT(*), без чтения записей.
 *  Используется там, где нужно только число (orchestrator: «Поиск по N файлам»),
 *  вместо чтения всех entries. */
export function localGetIndexCount(projectId: string): number {
  const r = getDb().prepare(`SELECT COUNT(*) as n FROM fast_context_index WHERE project_id = ?`).get(projectId) as { n: number }
  return r.n
}

export function localGetIndexFingerprint(projectId: string): { count: number; updatedAt: number } {
  return getDb().prepare(`
    SELECT COUNT(*) as count, COALESCE(MAX(updated_at), 0) as updatedAt
    FROM fast_context_index WHERE project_id = ?
  `).get(projectId) as { count: number; updatedAt: number }
}

export function localUpdateScores(projectId: string, scores: Array<{ filePath: string; rankedScore: number }>): void {
  const db = getDb()
  const stmt = db.prepare(`UPDATE fast_context_index SET ranked_score = ? WHERE project_id = ? AND file_path = ?`)
  const tx = db.transaction((rows: Array<{ filePath: string; rankedScore: number }>) => {
    for (const r of rows) stmt.run(r.rankedScore, projectId, r.filePath)
  })
  tx(scores)
}

/** Decay relevance_boost для всех файлов проекта (затухание старых сигналов). */
export function localDecayRelevance(projectId: string, factor = 0.9): void {
  getDb().prepare(`UPDATE fast_context_index SET relevance_boost = relevance_boost * ? WHERE project_id = ?`).run(factor, projectId)
}

/** Boost relevance для файла (вызывается когда AI читает файл после get_fast_context). */
export function bumpRelevanceBoost(projectId: string, filePath: string, amount = 1): void {
  try {
    getDb().prepare(`UPDATE fast_context_index SET relevance_boost = relevance_boost + ? WHERE project_id = ? AND file_path = ?`)
      .run(amount, projectId, filePath)
  } catch { /* skip — БД может быть не инициализирована */ }
}

// Используется внутри модуля (не экспортируется) — alias для совместимости с существующим кодом
export type FastContextEntry = LocalFastContextEntry

// ─── web-tree-sitter lazy init ──────────────────────────────────────────────
// Загружаем .wasm через require('web-tree-sitter/.cjs') — CommonJS-совместимо.
// Парсер + грамматики кэшируются по языку (singleton per language).

export type TSParser = { parse: (src: string, oldTree?: unknown) => TSNode; setLanguage: (lang: unknown) => void; delete(): void }
export type TSLanguage = unknown
export type TSNode = {
  type: string
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  text: string
  childCount: number
  child: (i: number) => TSNode
  children: TSNode[]
  namedChildren: TSNode[]
  parent: TSNode | null
  nextSibling: TSNode | null
  prevSibling: TSNode | null
  childForFieldName?: (field: string) => TSNode | null
}

let _parserLib: { Parser: { init: (opts?: unknown) => Promise<void>; new (): TSParser }; Language: { load: (path: string) => Promise<TSLanguage> } } | null = null
let _parserInstance: TSParser | null = null
const _langCache = new Map<string, TSLanguage>()
let _wasmDir: string | null = null

/** Инициализация пути к .wasm файлам. Вызывается из ai-worker.ts (workerData.wasmDir). */
export function initFastContextWasmDir(dir: string): void {
  _wasmDir = dir
}

/** Директория с .wasm файлами. В worker — задаётся через initFastContextWasmDir,
 *  в main (watcher) — авто-детект через process.resourcesPath / app.getAppPath. */
export function getWasmDir(): string {
  if (_wasmDir) return _wasmDir
  // В main-процессе (watcher) — авто-детект. Worker получает путь через initFastContextWasmDir.
  // Порядок кандидатов важен: в dev режиме app.getAppPath() = out/main (не проект root),
  // поэтому process.cwd() проверяем ПЕРВЫМ. В prod (packaged) — process.resourcesPath.
  const candidates: string[] = [
    join(process.cwd(), 'resources', 'tree-sitter'),
  ]
  try {
    // electron app доступен только в main — пробуем через require чтобы не падать в worker
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron')
    if (electron?.app?.getAppPath) {
      // В dev app.getAppPath() = out/main — НЕ подходит. Но в некоторых pack-сценариях
      // может указывать на проект root — оставляем как fallback.
      const appPath = electron.app.getAppPath()
      // Если appPath заканчивается на out/main или out\main — поднимаемся на 2 уровня
      if (typeof appPath === 'string' && /[\\/]out[\\/]main$/.test(appPath)) {
        candidates.push(join(appPath, '..', '..', 'resources', 'tree-sitter'))
      } else {
        candidates.push(join(appPath, 'resources', 'tree-sitter'))
      }
    }
  } catch { /* worker — нет electron */ }
  // Prod (packaged): resources распакованы в process.resourcesPath
  candidates.push(join(process.resourcesPath ?? '', 'tree-sitter'))
  candidates.push(join(process.resourcesPath ?? '', 'resources', 'tree-sitter'))

  for (const c of candidates) {
    // 0.25.x: tree-sitter.wasm; 0.26.x: web-tree-sitter.wasm — проверяем оба
    if (existsSync(join(c, 'tree-sitter.wasm')) || existsSync(join(c, 'web-tree-sitter.wasm'))) {
      _wasmDir = c
      return c
    }
  }
  // Fallback — первый кандидат, даже если не существует (будет понятная ошибка)
  _wasmDir = candidates[0]
  return _wasmDir
}

export async function getParserLib(): Promise<NonNullable<typeof _parserLib>> {
  if (_parserLib) return _parserLib
  // web-tree-sitter — Emscripten module. В Electron worker_threads require()
  // может вернуть Emscripten runtime object вместо Parser функции.
  // Решение: загружаем файл напрямую через vm.runInThisContext с ручным
  // созданием module/exports, чтобы обойти проблему module resolution.
  let Parser: unknown = null
  try {
    // Способ 1: обычный require (работает в main process и plain Node.js)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('web-tree-sitter')
    Parser = mod.Parser ?? (typeof mod === 'function' ? mod : mod.default)
  } catch { /* fallback ниже */ }
  if (!Parser || typeof Parser !== 'function') {
    // Способ 2: прямая загрузка файла через vm (обходит module resolution)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pathMod = require('path')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vm = require('vm')
      const candidates = [
        pathMod.join(process.cwd(), 'node_modules', 'web-tree-sitter', 'tree-sitter.js'),
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        pathMod.join(require.resolve('web-tree-sitter').replace(/[\\/][^\\/]+$/, ''), 'tree-sitter.js'),
      ]
      let code = ''
      for (const p of candidates) {
        try { code = fs.readFileSync(p, 'utf-8'); break } catch { /* try next */ }
      }
      if (!code) throw new Error('tree-sitter.js not found')
      const moduleObj = { exports: {} as unknown }
      const sandbox = { module: moduleObj, exports: moduleObj.exports, require, process, console, globalThis }
      vm.runInNewContext(code, sandbox)
      Parser = moduleObj.exports
    } catch (e) {
      throw new Error(`web-tree-sitter: both require and vm fallback failed: ${e}`)
    }
  }
  if (!Parser || typeof Parser !== 'function') {
    throw new Error('web-tree-sitter: Parser not found after all strategies')
  }
  const wasmDir = getWasmDir()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (Parser as any).init({ locateFile: (name: string) => join(wasmDir, name) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Language = (Parser as any).Language
  if (!Language) throw new Error('web-tree-sitter: Language not found after init')
  _parserLib = { Parser: Parser as { init: (opts?: unknown) => Promise<void>; new (): TSParser }, Language: Language as { load: (path: string) => Promise<TSLanguage> } }
  return _parserLib
}

export async function getParser(): Promise<TSParser> {
  if (_parserInstance) return _parserInstance
  const lib = await getParserLib()
  if (!lib) throw new Error('web-tree-sitter library not initialized')
  _parserInstance = new lib.Parser()
  return _parserInstance
}

export async function loadLanguage(langId: string): Promise<TSLanguage | null> {
  if (_langCache.has(langId)) return _langCache.get(langId)!
  const lib = await getParserLib()
  if (!lib) return null
  // Имена файлов в tree-sitter-wasms/out: tree-sitter-javascript.wasm, tree-sitter-c_sharp.wasm, tree-sitter-tsx.wasm
  const wasmPath = join(getWasmDir(), `tree-sitter-${langId}.wasm`)
  if (!existsSync(wasmPath)) {
    console.warn(`[fastContext] WASM not found: ${wasmPath} (lang=${langId}, wasmDir=${getWasmDir()})`)
    return null
  }
  try {
    const lang = await lib.Language.load(wasmPath)
    _langCache.set(langId, lang)
    return lang
  } catch (e) {
    console.warn(`[fastContext] failed to load language ${langId}:`, e)
    return null
  }
}

// ─── Extension → tree-sitter language id mapping ───────────────────────────
// Только языки с определениями (functions/classes/interfaces). Config-форматы
// (json/toml/css/html) убраны — они парсятся, но дают 0 definitions и удаляются
// из индекса, создавая бесполезную нагрузку.
const EXT_TO_LANG: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'tsx',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.java': 'java',
  '.cs': 'c_sharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.lua': 'lua',
  '.bash': 'bash', '.sh': 'bash',
  '.dart': 'dart',
  '.elixir': 'elixir',
}

export function getLangForFile(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase()
  return EXT_TO_LANG[ext] ?? null
}

// ─── Smart lexical match helpers ────────────────────────────────────────────
// Используются retriever'ом (buildRepoMapSlice) и annotator'ом (buildContentSnippets).

/** Разбивает camelCase / snake_case / kebab-case имя на компоненты.
 *  getUserById → ['get', 'user', 'by', 'id']
 *  parse_http_request → ['parse', 'http', 'request'] */
export function splitNameParts(name: string): string[] {
  // camelCase: вставляем пробел перед заглавными В ОРИГИНАЛЬНОЙ строке
  // (не lowercased — иначе [A-Z] никогда не match!)
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(p => p.length >= 2)
  return parts
}

/** Lightweight stemmer: plural + common suffixes.
 *  users → user, authentication → auth, configuration → config
 *  Расширен: authorization → auth, middleware → middle, initialization → init,
 *  validation → valid, generation → gener, implementation → implement. */
const STEMMED_CACHE = new Map<string, string>()
export function stem(word: string): string {
  const cached = STEMMED_CACHE.get(word)
  if (cached !== undefined) return cached
  let s = word
  // Plurals
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y'
  else if (s.length > 3 && s.endsWith('es')) s = s.slice(0, -2)
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1)
  // Common suffixes → abbreviation
  if (s.length > 6 && s.endsWith('tion')) s = s.slice(0, -4)
  else if (s.length > 5 && s.endsWith('ment')) s = s.slice(0, -4)
  else if (s.length > 4 && s.endsWith('ing')) s = s.slice(0, -3)
  else if (s.length > 4 && s.endsWith('er') && !s.endsWith('eer')) s = s.slice(0, -2)
  else if (s.length > 4 && s.endsWith('ed') && !s.endsWith('eed')) s = s.slice(0, -2)
  // Расширенные суффиксы для лучшего matching
  // -ization → - (authorization → author), -izations → author
  else if (s.length > 8 && s.endsWith('ization')) s = s.slice(0, -7)
  else if (s.length > 9 && s.endsWith('izations')) s = s.slice(0, -8)
  // -ware → - (middleware → middle, software → soft)
  else if (s.length > 6 && s.endsWith('ware')) s = s.slice(0, -4)
  // -ation → - (validation → valid, creation → creat)
  else if (s.length > 7 && s.endsWith('ation')) s = s.slice(0, -5)
  // -al → - (functional → function, logical → logic) — только для длинных слов
  else if (s.length > 6 && s.endsWith('al') && !s.endsWith('ial')) s = s.slice(0, -2)
  // -ity → - (security → secur, complexity → complex)
  else if (s.length > 6 && s.endsWith('ity')) s = s.slice(0, -3)
  // -ness → - (darkness → dark, completeness → complet)
  else if (s.length > 6 && s.endsWith('ness')) s = s.slice(0, -4)
  // -ance/-ence → - (performance → perform, existence → exist)
  else if (s.length > 7 && (s.endsWith('ance') || s.endsWith('ence'))) s = s.slice(0, -4)
  // -ize/-ise → - (optimize → optim, serialize → serial)
  else if (s.length > 5 && (s.endsWith('ize') || s.endsWith('ise'))) s = s.slice(0, -3)
  STEMMED_CACHE.set(word, s)
  return s
}

/** Levenshtein distance (для fuzzy match). Оптимизирована для коротких строк. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const m = a.length, n = b.length
  let prev = new Array(n + 1)
  let curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

/** Fuzzy match: token vs name с допуском 1 опечатки (для токенов ≥4 символов). */
export function fuzzyMatch(token: string, name: string): boolean {
  if (token.length < 4) return false
  if (Math.abs(token.length - name.length) > 2) return false
  return levenshtein(token, name) <= 1
}
