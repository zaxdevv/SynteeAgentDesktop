/**
 * Embeddings — semantic search через MiniLM (384-dim) с TF-IDF fallback.
 *
 * @huggingface/transformers загружается лениво. Модель all-MiniLM-L6-v2 (~22MB)
 * скачивается при первом использовании и кэшируется в HuggingFace cache.
 * Если загрузка не удалась — fallback на TF-IDF (чистый JS, без ML).
 *
 * Работает в main process и worker_threads (onnxruntime-node).
 *
 * Дополнительно: отдельный lazy E5-embedder (getE5Embedder) — multilingual
 * модель для фоновой semantic-индексации recall_memory (см. memory/semanticIndex.ts).
 * Полностью изолирован от getEmbedder/fast-context: свой pipeline, свои флаги,
 * свой dispose. Недоступность E5 НЕ влияет на TF-IDF/MiniLM поиск.
 */

// Embedding helpers are platform-independent; paths are normalized as strings below.
// ─── Типы ────────────────────────────────────────────────────────────────────

export type Embedding = Float32Array

export interface Embedder {
  embed(text: string): Promise<Embedding>
  stableEmbed?: (text: string) => Promise<Embedding>
  stableDim?: number
  dim: number
  mode: 'neural' | 'tfidf'
}

// ─── Neural embeddings (MiniLM) ──────────────────────────────────────────────
// ОТКЛЮЧЕНО по умолчанию: onnxruntime-node грузит native threads которые
// не убиваются полностью через dispose() — жрут CPU в простое.
// Для desktop app TF-IDF достаточно (мгновенно, 0 CPU overhead).
// Включить: setUseNeuralEmbeddings(true) из настроек.

let _pipeline: any = null
let _neuralInitAttempted = false
let _neuralInitFailed = false
let _useNeural = false

/** Включить/выключить neural embeddings (ONNX). По умолчанию выключено. */
export function setUseNeuralEmbeddings(enabled: boolean): void {
  _useNeural = enabled
  if (!enabled) disposeEmbedder()
}

async function initNeural(): Promise<void> {
  if (_neuralInitAttempted || !_useNeural) return
  _neuralInitAttempted = true

  try {
    // require вместо await import: нативный import() не работает в V8-байткоде
    // (пакет имеет CJS-сборку dist/transformers.node.cjs для require-экспорта)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { pipeline, env } = require('@huggingface/transformers')
    // ⚠️ @huggingface/transformers v4 НЕ читает TRANSFORMERS_CACHE из process.env.
    // Явно перенаправляем в userData/transformers-cache (writable в production).
    if (process.env.TRANSFORMERS_CACHE) {
      env.cacheDir = process.env.TRANSFORMERS_CACHE
    }
    try {
      env.backends.onnx.wasm.numThreads = 1
    } catch { /* onnx may not be configured */ }
    _pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
      cache_dir: process.env.TRANSFORMERS_CACHE || undefined,
    })
  } catch (e) {
    _neuralInitFailed = true
    console.warn('[embeddings] neural init failed, using TF-IDF fallback:', e instanceof Error ? e.message : e)
  }
}

/** Освобождает ONNX pipeline. */
export function disposeEmbedder(): void {
  if (_pipeline) {
    try {
      const p = _pipeline as any
      if (typeof p.dispose === 'function') p.dispose()
      else if (p.model?.dispose) p.model.dispose()
    } catch { /* ignore */ }
    _pipeline = null
    _neuralInitAttempted = false
  }
}

const NEURAL_DIM = 384
// Memory TF-IDF layout stays stable. Fast-context uses a separate dimension so
// old vectors are invalidated without changing persisted memory embeddings.
const TFIDF_DIM = 1024
const FAST_TFIDF_DIM = 2048

// ─── E5 multilingual embeddings (semantic index recall_memory) ──────────────
// Отдельный lazy-пайплайн от MiniLM. Официальная модель Xenova/multilingual-e5-small
// (модели "small2" не существует — это small). 384-dim, обучена на 100+ языках
// (русский ок). Требует префиксы "query: " / "passage: " — асимметричный формат E5.
//
// Назначение: фоновая индексация всех 5 источников recall_memory
// (memory/messages/summaries/agent_logs/pinned) в таблицу semantic_embeddings.
// НЕ используется getEmbedder'ом — fast-context и memory TF-IDF работают как раньше.
//
// Fallback-политика: getE5Embedder() возвращает null при недоступности модели
// (нет сети / ONNX упал) и НЕ ретраит до перезапуска приложения — вызывающий
// код (semanticIndex) просто пропускает индексацию, lexical/TF-IDF поиск
// продолжает работать без изменений.

export const E5_MODEL = 'Xenova/multilingual-e5-small'
export const E5_DIM = 384

export interface E5Embedder {
  /** Embed поискового запроса (префикс "query: "). */
  embedQuery(text: string): Promise<Embedding>
  /** Embed индексируемого текста (префикс "passage: "). */
  embedPassage(text: string): Promise<Embedding>
  /** Размерность вектора (384). */
  readonly dim: number
  /** Имя модели — для инвалидации при смене (col semantic_embeddings.model). */
  readonly model: string
}

let _e5Pipeline: any = null
let _e5InitAttempted = false
let _e5InitFailed = false
let _e5LastFailureAt = 0
const E5_RETRY_INTERVAL_MS = 5 * 60 * 1000

async function initE5(): Promise<void> {
  if (_e5InitAttempted) return
  _e5InitAttempted = true
  try {
    // require вместо await import: нативный import() не работает в V8-байткоде
    // (тот же паттерн, что initNeural выше).
// eslint-disable-next-line @typescript-eslint/no-require-imports
    const { pipeline, env } = require('@huggingface/transformers')
    if (process.env.TRANSFORMERS_CACHE) {
      env.cacheDir = process.env.TRANSFORMERS_CACHE
    }
    try {
      env.backends.onnx.wasm.numThreads = 1
    } catch { /* onnx may not be configured */ }
    _e5Pipeline = await pipeline('feature-extraction', E5_MODEL, {
      quantized: true,
      cache_dir: process.env.TRANSFORMERS_CACHE || undefined,
    })
    console.log('[embeddings] E5 pipeline ready:', E5_MODEL)
  } catch (e) {
    _e5InitFailed = true
    _e5LastFailureAt = Date.now()
    console.warn('[embeddings] E5 init failed; lexical search remains active:', e instanceof Error ? e.message : e)
  }
}

async function embedE5(text: string, prefix: 'query' | 'passage'): Promise<Embedding> {
  if (!_e5Pipeline) await initE5()
  if (!_e5Pipeline) throw new Error('E5 pipeline not available')
  // E5 требует префикс "query: "/"passage: " перед текстом — без него качество
  // проседает (модель обучена с этими префиксами).
  const output = await _e5Pipeline([`${prefix}: ${text}`], { pooling: 'mean', normalize: true })
  return output.data as Float32Array
}

/**
 * Lazy E5-embedder или null, если модель недоступна. Никогда не бросает —
 * semanticIndex при null просто пропускает цикл индексации, текущий
 * TF-IDF/FTS поиск не затронут.
 */
function createE5Embedder(): E5Embedder | null {
  if (!_e5Pipeline) return null
  return {
    embedQuery: (text: string) => embedE5(text, 'query'),
    embedPassage: (text: string) => embedE5(text, 'passage'),
    dim: E5_DIM,
    model: E5_MODEL,
  }
}

/**
 * Загружает E5 для ФОНОВОГО индексатора. Повторяет временную неудачу не чаще
 * раза в пять минут, чтобы не крутить downloader при офлайн-режиме.
 */
export async function getE5Embedder(): Promise<E5Embedder | null> {
  if (_e5InitFailed) {
    if (Date.now() - _e5LastFailureAt < E5_RETRY_INTERVAL_MS) return null
    _e5InitFailed = false
    _e5InitAttempted = false
  }
  await initE5()
  return createE5Embedder()
}

/**
 * Возвращает только уже прогретую E5-модель. Поиск никогда не запускает
 * скачивание/инициализацию ONNX сам, поэтому первый recall не подвисает.
 */
export function getReadyE5Embedder(): E5Embedder | null {
  return createE5Embedder()
}

/** E5 pipeline доступен (инициализирован и не упал)? Для статус-репортов. */
export function isE5Available(): boolean {
  return !_e5InitFailed && _e5Pipeline !== null
}

/** Освобождает E5 pipeline (before-quit / stopSemanticIndexer). */
export function disposeE5Embedder(): void {
  if (_e5Pipeline) {
    try {
      const p = _e5Pipeline as any
      if (typeof p.dispose === 'function') p.dispose()
      else if (p.model?.dispose) p.model.dispose()
    } catch { /* ignore */ }
    _e5Pipeline = null
    _e5InitAttempted = false
  }
  _e5InitFailed = false
  _e5LastFailureAt = 0
}

async function embedNeural(text: string): Promise<Embedding> {
  if (!_pipeline) await initNeural()
  if (!_pipeline) throw new Error('neural pipeline not available')

  const output = await _pipeline([text], { pooling: 'mean', normalize: true })
  return output.data as Float32Array
}

// ─── TF-IDF fallback ─────────────────────────────────────────────────────────
// Простой но эффективный: веса термам по IDF (редкие термины важнее).
// Не знает синонимы, но лучше чистого lexical — учитывает важность слов.

// Per-project IDF cache — avoids cross-project contamination
interface ProjectIdf {
  idf: Map<string, number>
  docCount: number
}
const IDF_BY_PROJECT = new Map<string, ProjectIdf>()
let _activeProjectId: string | null = null

export function setActiveProjectId(projectId: string): void {
  _activeProjectId = projectId
}

export function updateTfidfIdf(projectId: string, documents: string[]): void {
  const df = new Map<string, number>() // document frequency
  for (const doc of documents) {
    const tokens = new Set(tokenize(doc))
    for (const t of tokens) {
      df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  // IDF = ln(N / df)
  const idf = new Map<string, number>()
  for (const [term, freq] of df) {
    idf.set(term, Math.log(documents.length / freq))
  }
  IDF_BY_PROJECT.set(projectId, { idf, docCount: documents.length })
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .split(/[^a-zа-я0-9_]+/i)
    .filter(t => t.length >= 2)
}

function embedHashed(text: string, dim: number, idf?: Map<string, number>, docCount = 1): Embedding {
  const tf = new Map<string, number>()
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1)
  const vec = new Float32Array(dim)
  for (const [term, freq] of tf) {
    const weight = idf
      ? freq * (idf.get(term) ?? Math.log(docCount || 1))
      : 1 + Math.log(freq)
    let hash = 0
    for (let i = 0; i < term.length; i++) hash = ((hash << 5) - hash + term.charCodeAt(i)) | 0
    vec[Math.abs(hash) % dim] += weight
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i++) vec[i] /= norm
  return vec
}

function embedTfidf(text: string): Embedding {
  const project = _activeProjectId ? IDF_BY_PROJECT.get(_activeProjectId) : null
  return embedHashed(text, TFIDF_DIM, project?.idf, project?.docCount)
}

function embedFastContextTfidf(text: string): Embedding {
  return embedHashed(text, FAST_TFIDF_DIM)
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getEmbedder(): Promise<Embedder> {
  // Neural embeddings по умолчанию выключены (ONNX runtime жрёт CPU в простое).
  // TF-IDF — мгновенно, без native threads, достаточно для semantic search.
  if (_useNeural && !_neuralInitFailed) {
    await initNeural()
    if (_pipeline) {
      return { embed: embedNeural, stableEmbed: embedNeural, dim: NEURAL_DIM, stableDim: NEURAL_DIM, mode: 'neural' }
    }
  }
  return {
    embed: async (text: string) => embedTfidf(text),
    stableEmbed: async (text: string) => embedFastContextTfidf(text),
    stableDim: FAST_TFIDF_DIM,
    dim: TFIDF_DIM,
    mode: 'tfidf',
  }
}

/** Косинусное сходство двух векторов (оба L2-normalized → dot product). */
export function cosineSimilarity(a: Embedding, b: Embedding): number {
  let dot = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
  }
  return dot
}

/** Сериализация embedding в Buffer для хранения в SQLite BLOB. */
export function embeddingToBuffer(emb: Embedding): Buffer {
  return Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength)
}

/** Десериализация embedding из Buffer. */
export function bufferToEmbedding(buf: Buffer): Embedding {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

/**
 * Текст для embedding файла: путь + имена символов + kinds + сигнатуры + imports.
 * Компактное представление содержимого файла для semantic поиска.
 * ВАЖНО: путь файла включён — иначе auth.ts без символа "auth" не матчится.
 */
export function fileToEmbeddingText(
  defs: Array<{ name: string; kind: string; signature: string; parentName?: string }>,
  imports: string[],
  filePath?: string,
): string {
  const parts: string[] = []
  // Путь файла — basename + директория (даёт сигнал для semantic match)
  if (filePath) {
    const normalized = filePath.replace(/\\/g, '/')
    const segments = normalized.split('/')
    const baseName = segments[segments.length - 1].replace(/\.[^.]+$/, '')
    parts.push(baseName)
    // Последние 2 директории — контекст (e.g. "auth/login" для src/auth/login.ts)
    if (segments.length >= 3) {
      parts.push(segments[segments.length - 2])
    }
  }
  for (const d of defs.slice(0, 50)) {
    if (d.parentName) parts.push(`${d.parentName}.${d.name} ${d.kind}`)
    else parts.push(`${d.name} ${d.kind}`)
    if (d.signature) parts.push(d.signature.slice(0, 80))
  }
  for (const imp of imports.slice(0, 20)) {
    parts.push(imp)
  }
  return parts.join(' ')
}
