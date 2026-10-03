import { readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, extname, sep } from 'path'
import type Store from 'electron-store'
import { getEmbedder, embeddingToBuffer, fileToEmbeddingText } from '../embeddings'
import { DEFAULT_INDEXING_SETTINGS, getIndexSettingsFromRecord, type IndexingSettings } from '../fastContextSettings'
import {
  getDb, localGetEntries, localGetEntry, localUpsert, localDelete, localUpdateScores,
  localDecayRelevance, getLangForFile, type FastContextEntry,
} from './state'
import { extractSymbols, type SymbolDef } from './symbols'
import { getParsedSymbols } from './symbolsCache'
import { clearInvertedIndex } from './invertedIndex'
import { quickHash } from './fileHash'
import { extractArtifactSymbols, getArtifactLang, isIndexableArtifact } from './artifacts'

// ─── Project file walking ────────────────────────────────────────────────────

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build',
  '.next', 'coverage', '.cache', '.turbo', '.parcel-cache', 'target',
  '.gradle', '.idea', '.vscode', '.hermes', '.mimocode', '.playwright-mcp',
  '.planning', 'logs', 'tmp', 'tmp_out', '.opencode',
])

/** Читает IndexingSettings из electron-store с мерджем дефолтов. Main-only (Store). */
export function getIndexSettings(store?: Store): IndexingSettings {
  const defaults = DEFAULT_INDEXING_SETTINGS
  if (!store) return defaults
  try {
    const all = (store as unknown as { store: Record<string, unknown> }).store
    return getIndexSettingsFromRecord(all)
  } catch {
    return defaults
  }
}

const MAX_FILES_PER_WALK = 5000  // safety limit
const IGNORED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
  '.zip', '.gz', '.tar', '.rar', '.7z', '.bz2',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.lib',
  '.obj', '.bin', '.dat', '.db', '.sqlite', '.db-shm', '.db-wal',
  '.o', '.a', '.class', '.jar', '.war',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.psd', '.ai', '.sketch',
  '.lock', '.log',
])

/** Результат walk'а проекта. hitCap=true — обход прерван по лимиту maxFiles:
 *  записи индекса, не попавшие в выборку, НЕЛЬЗЯ считать удалёнными. */
export interface WalkResult {
  files: Array<{ path: string; mtime: number; size: number; lang: string }>
  hitCap: boolean
}

/** Walk проекта и возвращает список файлов с поддерживаемыми расширениями.
 *  Параллельный обход директорий для скорости. Записи сортируются — обход
 *  ДЕТЕРМИНИРОВАН: при обрезе по maxFiles выбирается одно и то же подмножество
 *  (иначе каждый walk возвращал разный набор → вечный цикл reindex).
 *  ignoreDirs/maxFiles необязательные — по умолчанию глобальные константы. */
export async function walkProjectFiles(
  workdir: string,
  opts: { ignoreDirs?: Set<string>; maxFiles?: number } = {},
): Promise<WalkResult> {
  const ignoreDirs = opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS
  const maxFiles = opts.maxFiles ?? MAX_FILES_PER_WALK
  const result: Array<{ path: string; mtime: number; size: number; lang: string }> = []
  const seen = new Set<string>()
  let hitCap = false

  async function walk(dir: string, depth: number): Promise<void> {
    if (result.length >= maxFiles || depth > 12) return
    let entries: string[]
    try {
      // sort() — детерминизм: одинаковый порядок на каждом walk → при обрезе
      // по cap выбирается стабильное подмножество, а не случайное.
      entries = (await readdir(dir)).sort()
    } catch {
      return
    }
    // Фильтруем игнорируемые — сразу
    const filtered = entries.filter(name => !ignoreDirs.has(name) && !name.startsWith('.git'))
    // Ограниченная параллельность stat-вызовов: на Windows libuv thread pool
    // по умолчанию всего 4 потока, а на 5K+ файлов Promise.allSettled со всеми
    // entries сразу насыщает пул и всё сериализуется. Обрабатываем чанками по
    // MAX_CONCURRENT_STATS — держит пул занятым, но не переполняет его.
    const MAX_CONCURRENT_STATS = 32
    const subdirs: Promise<void>[] = []
    for (let i = 0; i < filtered.length; i += MAX_CONCURRENT_STATS) {
      const chunk = filtered.slice(i, i + MAX_CONCURRENT_STATS)
      const stats = await Promise.allSettled(
        chunk.map(name => {
          const full = join(dir, name)
          return stat(full).then(s => ({ name, full, s }))
        }),
      )
      // Рекурсивно обходим поддиректории параллельно
      for (const r of stats) {
        if (r.status !== 'fulfilled') continue
        const { name, full, s } = r.value
        if (result.length >= maxFiles) { hitCap = true; break }
        if (seen.has(full)) continue
        seen.add(full)
        if (s.isDirectory()) {
          subdirs.push(walk(full, depth + 1))
        } else if (s.isFile()) {
          const ext = extname(name).toLowerCase()
          if (IGNORED_EXTS.has(ext)) continue
          const lang = getLangForFile(name) ?? (isIndexableArtifact(name, s.size) ? getArtifactLang(name) : null)
          if (!lang) continue
          result.push({ path: full, mtime: s.mtimeMs, size: s.size, lang })
        }
      }
    }
    await Promise.all(subdirs)
  }

  await walk(workdir, 0)
  return { files: result, hitCap }
}

// ─── Indexing (incremental) ─────────────────────────────────────────────────

export interface IndexProgress {
  stage: 'indexing' | 'retrieving' | 'summarizing' | 'done' | 'error'
  detail?: string
  filesProcessed?: number
  filesTotal?: number
  filesFound?: Array<{ path: string; score: number; why: string }>
}

export type ProgressCallback = (p: IndexProgress) => void

/**
 * Строит/обновляет индекс символов проекта. Incremental: для каждого файла
 * проверяет content hash, пере-парсит только изменившиеся.
 * Возвращает количество РЕАЛЬНО переиндексированных (изменённых) файлов —
 * не общее число в индексе (общее считает localGetIndexCount / COUNT(*)).
 */
export async function buildOrUpdateIndex(
  projectId: string,
  workdir: string,
  changedPaths?: string[],
  onProgress?: ProgressCallback,
  opts: {
    skipEmbeddings?: boolean
    /** Skip the full filesystem reconcile when a live watcher recently checked this project. */
    skipFileWalk?: boolean
    settings?: IndexingSettings
    /** Параллельность при full-scan (default 8). Мягкий режим watcher'а = 1-2. */
    batchSize?: number
    /** Пауза между батчами в ms (default 0 = setImmediate). Мягкий режим = 80-150. */
    batchDelayMs?: number
    /** Пропустить regex-scan references для файлов крупнее этого размера (bytes). */
    skipReferencesAboveBytes?: number
    /** Пропустить computeGraphRank если файлов в индексе больше этого числа. */
    skipGraphRankAboveN?: number
  } = {},
): Promise<number> {
  if (!existsSync(workdir)) return 0

  let filesReIndexed = 0
  const skipEmb = opts.skipEmbeddings ?? false
  // Настройки индексации (с fallback на дефолты). Передаются из runFastContext
  // (через store) и из watcher (через IPC). Module-level константы — fallback.
  const s = opts.settings ?? DEFAULT_INDEXING_SETTINGS
  const maxBytes = s.maxFileSizeKb * 1024
  const ignoreDirs = new Set(s.ignoreDirs)
  const batchSize = opts.batchSize ?? 8
  const batchDelayMs = opts.batchDelayMs ?? 0
  const skipRefsAbove = opts.skipReferencesAboveBytes ?? Infinity
  const skipGraphRankAboveN = opts.skipGraphRankAboveN ?? Infinity

  // Если передали конкретные изменившиеся файлы — обрабатываем только их
  // (вызывается из watcher). Иначе — full scan.
  if (changedPaths && changedPaths.length > 0) {
    for (const p of changedPaths) {
      try {
        const sFile = await stat(p)
        if (!sFile.isFile()) continue
        const existing = localGetEntry(projectId, p)
        // Content hash — точнее чем mtime+size: touch не вызывает ложный reindex,
        // а git checkout (content changed, same size) детектится. ~0.01ms/файл.
        const hash = quickHash(p, sFile.size)
        if (existing && existing.contentHash === hash && existing.size === sFile.size && existing.mtime === sFile.mtimeMs) continue
        const lang = getLangForFile(p) ?? (isIndexableArtifact(p, sFile.size) ? getArtifactLang(p) : null)
        if (!lang) {
          // файл больше не поддерживается — удаляем из индекса
          localDelete(projectId, p)
          continue
        }
        const symbols = lang === 'markdown' || lang === 'config'
          ? { definitions: await extractArtifactSymbols(p) ?? [], imports: [], references: [] }
          : await extractSymbols(p, { maxFileSizeBytes: maxBytes, skipReferencesAboveBytes: skipRefsAbove })
        if (!symbols || symbols.definitions.length === 0) {
          // файл пропал или нет определений — удаляем
          localDelete(projectId, p)
          continue
        }
        localUpsert(
          projectId, p, lang,
          JSON.stringify({ d: symbols.definitions.slice(0, 200), i: symbols.imports.slice(0, 50), r: symbols.references.slice(0, 200) }),
          sFile.mtimeMs, sFile.size, 0, undefined, hash,
        )
        filesReIndexed++
      } catch (e) {
        // Удаляем запись ТОЛЬКО если файл реально исчез (ENOENT).
        // Транзиентные ошибки (EBUSY — файл залочен IDE/антивирусом, EPERM,
        // EACCES) не должны стирать запись — safety net вернёт её, но получим
        // churn: delete → reindex → delete... на каждый лоченый файл.
        const code = (e as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT') localDelete(projectId, p)
      }
    }
  } else if (!opts.skipFileWalk) {
    // Full scan
    const { files, hitCap } = await walkProjectFiles(workdir, { ignoreDirs, maxFiles: s.maxFilesPerProject })
    const existingEntries = new Map(localGetEntries(projectId).map(e => [e.filePath, e]))
    const seenPaths = new Set<string>()

    // Guard: walk вернул 0 файлов при непустом индексе — workdir недоступен
    // (диск отвалился, права, антивирус). НЕ считаем файлы удалёнными, иначе
    // один транзиентный сбой FS стирал весь индекс в ноль.
    if (files.length === 0 && existingEntries.size > 0) {
      console.warn(`[fastContext] walk returned 0 files but index has ${existingEntries.size} — skipping (workdir unavailable?)`)
      return 0 // ничего не изменилось
    }
    if (files.length === 0) {
      console.warn(`[fastContext] walkProjectFiles returned 0 files for workdir=${workdir}`)
    }

    // Фильтруем только изменившиеся файлы — неизменные пропускаем сразу.
    // Content hash точнее mtime+size: touch без content change → skip.
    const toIndex: Array<typeof files[0]> = []
    for (const f of files) {
      seenPaths.add(f.path)
      const existing = existingEntries.get(f.path)
      if (existing && existing.size === f.size && existing.contentHash === quickHash(f.path, f.size)) continue
      toIndex.push(f)
    }

    let processed = files.length - toIndex.length
    onProgress?.({
      stage: 'indexing',
      filesProcessed: processed,
      filesTotal: files.length,
      detail: toIndex.length === 0 ? 'Индекс актуален' : `Обновление ${toIndex.length} файлов`,
    })

    // Параллельный batch processing — по BATCH_SIZE файлов одновременно.
    // Между батчами — уступка event loop (setImmediate или setTimeout если
    // задан batchDelayMs) чтобы не блокировать поток на больших репо.
    const BATCH_SIZE = batchSize
    for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
      const batch = toIndex.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(
        batch.map(f => (f.lang === 'markdown' || f.lang === 'config'
          ? extractArtifactSymbols(f.path).then(definitions => definitions ? { definitions, imports: [], references: [] } : null)
          : extractSymbols(f.path, { maxFileSizeBytes: maxBytes, skipReferencesAboveBytes: skipRefsAbove })
        ).then(symbols => ({ f, symbols }))),
      )
      for (let bi = 0; bi < results.length; bi++) {
        const r = results[bi]
        processed++
        if (r.status !== 'fulfilled') continue
        const { f, symbols } = r.value
        if (!symbols || symbols.definitions.length === 0) continue
        try {
          localUpsert(
            projectId, f.path, f.lang,
            JSON.stringify({ d: symbols.definitions.slice(0, 200), i: symbols.imports.slice(0, 50), r: symbols.references.slice(0, 200) }),
            f.mtime, f.size, 0, undefined, quickHash(f.path, f.size),
          )
          filesReIndexed++
        } catch { /* skip */ }
      }
      onProgress?.({
        stage: 'indexing',
        filesProcessed: processed,
        filesTotal: files.length,
        detail: `${processed}/${files.length}`,
      })
      // Уступаем event loop между батчами — снижает CPU load на больших репо.
      // batchDelayMs>0 (мягкий режим watcher'а) — setTimeout даёт потоку отдохнуть;
      // 0 — setImmediate (быстрый режим orchestrator'а в ai-worker).
      if (batchDelayMs > 0) {
        await new Promise<void>(r => setTimeout(r, batchDelayMs))
      } else {
        await new Promise<void>(r => setImmediate(r))
      }
    }

    // Удаляем записи для файлов, которых больше нет в проекте.
    // hitCap: обход прерван по maxFiles — записи за пределами cap могли просто
    // не попасть в выборку; удалять их нельзя (детерминизм walk'а держит
    // стабильное подмножество, но состав «за cap» неизвестен).
    if (!hitCap) {
      for (const [path] of existingEntries) {
        if (!seenPaths.has(path)) localDelete(projectId, path)
      }
    }
    // Инвалидируем инвертированный индекс — состав файлов изменился
    clearInvertedIndex(projectId)
  }

  // ── Embeddings: генерируем только при full scan (не incremental watcher ticks).
  // Cap: max 200 файлов за раз — avoids CPU spike на больших репо.
  // Neural mode: ~50ms/file. TF-IDF: мгновенно.
  // skipEmb=true: pre-warm watcher не трогает ONNX (грузит CPU в простое).
  // Embeddings генерируются только при первом get_fast_context (когда нужно).
  const isFullScan = !changedPaths
  if (isFullScan && !skipEmb) {
    try {
      const allEntries = localGetEntries(projectId)
      const embedder = await getEmbedder()
      const fastDim = embedder.stableDim ?? embedder.dim
      const embedFast = embedder.stableEmbed ?? embedder.embed
      const needEmbedding = allEntries.filter(e => !e.embedding || e.embedding.byteLength !== fastDim * 4).slice(0, 100)
      if (needEmbedding.length > 0) {
        const EMBED_BATCH = 32
        for (let i = 0; i < needEmbedding.length; i += EMBED_BATCH) {
          const batch = needEmbedding.slice(i, i + EMBED_BATCH)
          await Promise.allSettled(batch.map(async e => {
            try {
              const parsed = getParsedSymbols(e.filePath, e.symbolsJson, e.mtime)
              const text = fileToEmbeddingText(parsed.d, parsed.i, e.filePath)
              const emb = await embedFast(text)
              const db = getDb()
              db.prepare(`UPDATE fast_context_index SET embedding = ? WHERE project_id = ? AND file_path = ?`)
                .run(embeddingToBuffer(emb), projectId, e.filePath)
            } catch { /* skip */ }
          }))
        }
      }
    } catch { /* embeddings optional */ }
  }

  if (changedPaths && changedPaths.length > 0) clearInvertedIndex(projectId)

  // Пересчёт graph ranking scores.
  // Пропускаем для incremental watcher-обновлений с малым числом изменений —
  // структурная важность файлов меняется редко, а PageRank — O(N) операция.
  // Полный пересчёт делаем на full scan или если изменилось > 5 файлов.
  // Также применяем decay к relevance_boost — старые сигналы затухают.
  const entries = localGetEntries(projectId)
  const hasZeroScores = entries.length > 0 && entries.every(e => e.rankedScore === 0)
  const shouldRecomputeRank = filesReIndexed > 5 || hasZeroScores || !changedPaths
  // Мягкий режим watcher'а: пропускаем PageRank для огромных репо — O(N) на
  // десятках тысяч файлов блокирует воркер. Оставляем старые scores.
  if (shouldRecomputeRank && entries.length > 0 && entries.length <= skipGraphRankAboveN) {
    localDecayRelevance(projectId, 0.9)
    const scores = computeGraphRank(entries)
    localUpdateScores(projectId, scores)
  }

  return filesReIndexed
}

// ─── Graph ranking (PageRank-style как в Aider) ─────────────────────────────

/**
 * Строит граф файлов (edges из imports + call-site references) и считает
 * PageRank-style importance. Файлы которые импортируются/используются многими
 * другими — получают больший score.
 *
 * Два типа edges:
 *   1. Import edges: file A imports from file B → edge A→B
 *      Резолвинг: path alias (@/x → src/x), relative (./x), basename fallback
 *   2. Reference edges: file A использует имя функции/типа определённое в B → edge A→B
 *      Резолвинг: точное match имени символа
 */
export function computeGraphRank(entries: FastContextEntry[]): Array<{ filePath: string; rankedScore: number }> {
  if (entries.length === 0) return []

  const N = entries.length

  // Build name → [defining file indices] map (для reference edges)
  const nameToDefIdx = new Map<string, number[]>()
  // Build path-suffix → [indices] map (для alias resolution)
  const pathSuffixToIdx = new Map<string, number[]>()
  // Build basename → [indices] map (fallback)
  const basenameToIdx = new Map<string, number[]>()

  // Распарсиваем symbolsJson один раз для каждого entry.
  // Через symbolsCache вместо прямого JSON.parse — кэш по mtime экономит
  // парсинг на повторных full scan'ах (5K+ файлов → 5K JSON.parse → 0).
  const parsedSymbols: Array<{ d: SymbolDef[]; i: string[]; r: string[] }> = []
  for (let i = 0; i < N; i++) {
    const e = entries[i]
    const parsed = getParsedSymbols(e.filePath, e.symbolsJson, e.mtime)
    const d = parsed.d
    const imps = parsed.i
    const refs = parsed.r
    parsedSymbols.push({ d, i: imps, r: refs })

    // name → defining file index
    for (const def of d) {
      const lower = def.name.toLowerCase()
      const arr = nameToDefIdx.get(lower) ?? []
      arr.push(i)
      nameToDefIdx.set(lower, arr)
    }

    // basename → index
    const base = e.filePath.split(sep).pop()!.replace(/\.[^.]+$/, '')
    if (base) {
      const arr = basenameToIdx.get(base) ?? []
      arr.push(i)
      basenameToIdx.set(base, arr)
    }

    // path-suffix → index (для alias resolution: 'lib/utils' → file 'src/lib/utils.ts')
    // Сохраняем 2-3 последних компонента пути без расширения
    const parts = e.filePath.replace(/\\/g, '/').split('/')
    for (let depth = 2; depth <= 3 && depth <= parts.length; depth++) {
      const suffix = parts.slice(-depth, -1).join('/') + '/' + parts[parts.length - 1].replace(/\.[^.]+$/, '')
      const arr = pathSuffixToIdx.get(suffix) ?? []
      arr.push(i)
      pathSuffixToIdx.set(suffix, arr)
    }
  }

  // 5. Build adjacency lists
  const outLinks: number[][] = entries.map(() => [])
  const outLinksCount: number[] = entries.map(() => 0)

  const addEdge = (src: number, dst: number) => {
    if (src === dst) return
    outLinks[src].push(dst)
    outLinksCount[src]++
  }

  for (let i = 0; i < N; i++) {
    const { i: imps, r: refs } = parsedSymbols[i]

    // ── Import edges с path alias resolution ──
    for (const imp of imps) {
      const match = imp.match(/['"]([^'"]+)['"]/)
      if (!match) continue
      const importPath = match[1]

      // Стратегия 1: path alias resolution (@/x → src/x, ~/x → x)
      // Берём ВСЕ candidates, не только [0] — иначе теряются edges при коллизии basename
      const aliasMatch = importPath.replace(/^[@~]/, '').replace(/^\//, '')
      const resolvedAll = new Set<number>()
      if (aliasMatch && aliasMatch !== importPath) {
        const candidates = pathSuffixToIdx.get(aliasMatch)
        if (candidates) for (const c of candidates) resolvedAll.add(c)
      }

      // Стратегия 2: basename match (fallback) — все candidates
      const base = importPath.split('/').pop()!.replace(/\.[^.]+$/, '')
      if (base && base !== '.' && base !== '..') {
        const candidates = basenameToIdx.get(base)
        if (candidates) for (const c of candidates) resolvedAll.add(c)
      }

      for (const resolved of resolvedAll) {
        if (resolved !== i) addEdge(i, resolved)
      }
    }

    // ── Reference edges (call-site → definition) ──
    // Для каждого reference name проверяем, определён ли он в другом файле
    for (const ref of refs) {
      const lower = ref.toLowerCase()
      const defIndices = nameToDefIdx.get(lower)
      if (!defIndices) continue
      for (const defIdx of defIndices) {
        if (defIdx !== i) addEdge(i, defIdx)
      }
    }
  }

  // 6. PageRank итерации
  // Прогрессивная сходимость: останавливаемся раньше, если max delta между
  // итерациями < CONVERGENCE_THRESHOLD (scores стабилизировались). На малых
  // и средних репо экономит 10-20 итераций из 30.
  const DAMPING = 0.85
  const MAX_ITERATIONS = 30
  const CONVERGENCE_THRESHOLD = 1e-6
  let scores = new Array(N).fill(1 / N)
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const newScores = new Array(N).fill((1 - DAMPING) / N)
    let danglingMass = 0
    for (let i = 0; i < N; i++) {
      if (outLinksCount[i] === 0) {
        danglingMass += scores[i]
        continue
      }
      const share = DAMPING * scores[i] / outLinksCount[i]
      for (const dst of outLinks[i]) {
        newScores[dst] += share
      }
    }
    if (danglingMass > 0) {
      const danglingShare = DAMPING * danglingMass / N
      for (let j = 0; j < N; j++) newScores[j] += danglingShare
    }
    // Проверка сходимости: максимальный delta между итерациями
    let maxDelta = 0
    for (let i = 0; i < N; i++) {
      const delta = Math.abs(newScores[i] - scores[i])
      if (delta > maxDelta) maxDelta = delta
    }
    scores = newScores
    if (maxDelta < CONVERGENCE_THRESHOLD) break
  }

  // 7. Нормализуем в 0..1
  const maxScore = Math.max(...scores, 1e-9)
  return entries.map((e, i) => ({
    filePath: e.filePath,
    rankedScore: scores[i] / maxScore,
  }))
}

/** Принудительно очищает индекс проекта (для /reindex или удаления проекта). */
export function resetFastContextIndex(projectId: string): void {
  getDb().prepare(`DELETE FROM fast_context_index WHERE project_id = ?`).run(projectId)
  // Очищаем инвертированный индекс и кэш символов — они устарели
  clearInvertedIndex(projectId)
}

/** Возвращает статистику индекса (для UI badge). */
export function getFastContextStats(projectId: string): { fileCount: number; lastUpdated: number | null } {
  const entries = localGetEntries(projectId)
  const lastUpdated = entries.reduce((max, e) => Math.max(max, e.updatedAt), 0)
  return { fileCount: entries.length, lastUpdated: lastUpdated || null }
}
