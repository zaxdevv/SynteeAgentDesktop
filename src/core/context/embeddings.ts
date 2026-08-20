/**
 * Embeddings — semantic search через MiniLM (384-dim) с TF-IDF fallback.
 *
 * @huggingface/transformers загружается лениво. Модель all-MiniLM-L6-v2 (~22MB)
 * скачивается при первом использовании и кэшируется в HuggingFace cache.
 * Если загрузка не удалась — fallback на TF-IDF (чистый JS, без ML).
 *
 * Работает в main process и worker_threads (onnxruntime-node).
 */

import { sep } from 'path'

// ─── Типы ────────────────────────────────────────────────────────────────────

export type Embedding = Float32Array

export interface Embedder {
  embed(text: string): Promise<Embedding>
  dim: number
  mode: 'neural' | 'tfidf'
}

// ─── Neural embeddings (MiniLM) ──────────────────────────────────────────────
// ОТКЛЮЧЕНО по умолчанию: onnxruntime-node грузит native threads которые
// не убиваются полностью через dispose() — жрут CPU в простое.
// Для desktop app TF-IDF достаточно (мгновенно, 0 CPU overhead).
// Включить: setUseNeuralEmbeddings(true) из настроек.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = _pipeline as any
      if (typeof p.dispose === 'function') p.dispose()
      else if (p.model?.dispose) p.model.dispose()
    } catch { /* ignore */ }
    _pipeline = null
    _neuralInitAttempted = false
  }
}

const NEURAL_DIM = 384
// TF-IDF использует 1024 измерений вместо 384 — меньше хэш-коллизий
// (384 buckets / 20K terms ≈ 52 terms/bucket → 1024 / 20K ≈ 20 terms/bucket).
// Память: 5K файлов × 1024 × 4 bytes = 20MB — приемлемо.
// Neural embeddings остаются 384-dim (MiniLM output) — не пересекаются с TF-IDF.
const TFIDF_DIM = 1024

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

function embedTfidf(text: string): Embedding {
  const project = _activeProjectId ? IDF_BY_PROJECT.get(_activeProjectId) : null
  const tokens = tokenize(text)
  const tf = new Map<string, number>()
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1)
  }
  // Векторизуем: хэш в TFIDF_DIM измерений (1024 — меньше коллизий чем 384)
  const vec = new Float32Array(TFIDF_DIM)
  for (const [term, freq] of tf) {
    const idf = project?.idf.get(term) ?? Math.log(project?.docCount || 1)
    const weight = freq * idf
    // Simple hashing trick: hash term → bucket
    let hash = 0
    for (let i = 0; i < term.length; i++) {
      hash = ((hash << 5) - hash + term.charCodeAt(i)) | 0
    }
    const bucket = Math.abs(hash) % TFIDF_DIM
    vec[bucket] += weight
  }
  // L2 normalize
  let norm = 0
  for (let i = 0; i < TFIDF_DIM; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < TFIDF_DIM; i++) vec[i] /= norm
  return vec
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getEmbedder(): Promise<Embedder> {
  // Neural embeddings по умолчанию выключены (ONNX runtime жрёт CPU в простое).
  // TF-IDF — мгновенно, без native threads, достаточно для semantic search.
  if (_useNeural && !_neuralInitFailed) {
    await initNeural()
    if (_pipeline) {
      return { embed: embedNeural, dim: NEURAL_DIM, mode: 'neural' }
    }
  }
  return {
    embed: async (text: string) => embedTfidf(text),
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
